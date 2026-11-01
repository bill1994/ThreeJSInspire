"""Content-anchored bands: find the horizon instead of assuming 30/62/70% splits.

The fixed-percentage bands silently measured the wrong thing once framing changed:
on C-bankdive the "sea" band was sky (rgb 209,119,65) so every sea metric there was
garbage. This module finds the sky/sea boundary per column and reports confidence,
so a frame whose horizon is not visible refuses to produce sea metrics instead of
inventing them.

Method
  sea score per pixel = purple (B > G) and not blown out (V < 0.9)
  per column: walk up from the bottom row while the sea score stays above a
  threshold over a short run; the first row that fails is that column's horizon
  frame horizon = median of the column estimates (robust against clouds sitting on
  the horizon in a minority of columns)
  confidence = share of columns whose estimate is within 15% of the median

Usage: python artifacts/cloud-audit/content_bands.py
"""
import importlib.util
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("m", os.path.join(HERE, "ref_gap_measure.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

_spec = importlib.util.spec_from_file_location("st", os.path.join(HERE, "states.py"))
st = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(st)


def sea_score(a):
    """1 where the pixel looks like this scene's sea: violet, mid-tone, not glitter-white."""
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    v = a.max(-1)
    purple = (b - g) > 0.015
    return (purple & (v < 0.9) & (v > 0.06)).astype(np.float32)


def trim_margins(a):
    """Drop uniform white/black card borders the ref screenshots carry."""
    h, w, _ = a.shape
    rm, cm = a.mean(axis=(1, 2)), a.mean(axis=(0, 2))
    rows = (rm > 0.02) & (rm < 0.97)
    cols = (cm > 0.02) & (cm < 0.97)
    if 0.5 * h < rows.sum() < h:
        a = a[rows]
    if 0.5 * w < cols.sum() < w:
        a = a[:, cols]
    return a


def detect_horizon(a, run=6, min_share=0.30):
    """Returns (row, confidence) or (None, 0) when the horizon is not visible."""
    a = trim_margins(a)
    h, w, _ = a.shape
    s = sea_score(a)
    # column mean over a short vertical run, so single sparkle pixels cannot vote
    kernel = np.ones((run, 1), np.float32) / run
    s = np.apply_along_axis(lambda col: np.convolve(col, kernel.ravel(), mode="same"), 0, s)
    rows = []
    # A thin dead strip at the very bottom (letterbox residue, a shadowed water row) must not
    # end the walk before it starts; skip up to 4% of the height, then walk up from there.
    bottom = h - 1
    skipped = 0
    while bottom > 0 and s[bottom].mean() <= min_share and skipped < 0.04 * h:
        bottom -= 1
        skipped += 1
    for x in range(w):
        col = s[:, x]
        y = bottom
        while y >= 0 and col[y] > min_share:
            y -= 1
        rows.append(y + 1)          # first row that still looks like sea
    rows = np.asarray(rows)
    med = int(np.median(rows))
    if med <= 0 or med >= h - 1:
        return None, 0.0
    conf = float((np.abs(rows - med) < 0.15 * h).mean())
    return med, round(conf, 3)


def bands(a):
    """Content-anchored regions. `sea` is None when the split does not survive validation."""
    h = a.shape[0]
    row, conf = detect_horizon(a)
    out = {"horizon": row, "confidence": conf, "sky": None, "sea": None, "reason": None}
    if row is None or conf < 0.5:
        out["reason"] = "no horizon"
        out["sky"] = a[: int(h * 0.45)]   # diagnostic only; never a sea claim
        return out
    sky, sea = a[:row], a[row:]
    # Validation: the region below the line must actually look like this scene's water.
    # A hue walk can run away into clouds or orange haze, which is exactly how C-bankdive
    # once produced a "sea" of rgb(174,96,59) — bright sky.
    if sea.size == 0 or sky.size == 0:
        out["reason"] = "empty region"
        out["sky"] = a[: int(h * 0.45)]
        return out
    purple_share = float(((sea[..., 2] - sea[..., 1]) > 0.015).mean())
    v_sea, v_sky = float(sea.max(-1).mean()), float(sky.max(-1).mean())
    # A sliver of sea is not a sea measurement: B-dive once reported a 2-row "sea".
    min_rows = max(8, int(0.05 * h))
    if sea.shape[0] < min_rows:
        out["reason"] = "sea region too thin (%d rows < %d)" % (sea.shape[0], min_rows)
        out["sky"] = a[: int(h * 0.45)]
        return out
    if purple_share < 0.3 or v_sea >= v_sky:
        out["reason"] = "sea region failed validation (purple %.2f, V %.2f vs sky %.2f)" % (
            purple_share, v_sea, v_sky)
        out["sky"] = a[: int(h * 0.45)]
        return out
    out["sky"] = sky
    out["sea"] = sea
    out["reason"] = "ok"
    return out


def describe(a):
    b = bands(a)
    h = a.shape[0]
    res = {
        "horizon_row": b["horizon"],
        "horizon_frac": round(b["horizon"] / h, 3) if b["horizon"] is not None else None,
        "confidence": b["confidence"],
        "sea_usable": b["sea"] is not None,
    }
    for name in ("sky", "sea"):
        v = b[name]
        if v is None or v.size == 0:
            res[name] = None
            continue
        rgb = (v.reshape(-1, 3).mean(0) * 255).astype(int)
        res[name] = {"rows": int(v.shape[0]), "rgb": [int(x) for x in rgb]}
    return res


# Frames come from states.py: three references plus the four frozen protocol captures.
CASES = ([(p["state"] + " ref", st.path(p["ref"])) for p in st.pairs()]
         + [(s["state"], st.path(s["capture"])) for s in st.states()])

if __name__ == "__main__":
    for name, path in CASES:
        if not os.path.exists(path):
            print("%-12s MISSING" % name)
            continue
        a = m.content_crop(path)
        d = describe(a)
        sky = d["sky"]["rgb"] if d["sky"] else None
        sea = d["sea"]["rgb"] if d["sea"] else None
        print("%-12s horizon %-5s frac %-6s conf %-5s sea_usable %-5s  sky %s  sea %s" % (
            name, d["horizon_row"], d["horizon_frac"], d["confidence"],
            d["sea_usable"], sky, sea))
