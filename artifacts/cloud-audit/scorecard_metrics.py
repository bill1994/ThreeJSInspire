"""Scorecard metrics from threejs-aaa-graphics-builder/references/visual-scorecard.md.

Computes the four advisory signals the scorecard names, so the visual score is
backed by numbers instead of adjectives:
  colorEntropyBits      entropy of a quantised RGB histogram (16^3 bins)
  dominantColorShare    share of the single most common quantised colour
  edgeDensity           fraction of pixels above a Sobel threshold
  luminance.contrast    p95 - p5 of luminance, in 0..255 units

Thresholds the scorecard quotes: entropy < 3.0 or dominant share > 0.6 is a
sparse flat scene; edgeDensity < 0.04 is primitive-dominant; contrast < 60 is
compressed by fog or darkness.
"""
import importlib.util
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name, fname):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, fname))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


m = _load("m", "ref_gap_measure.py")
st = _load("st", "states.py")


def metrics(a):
    u8 = (np.clip(a, 0, 1) * 255).astype(np.uint8)
    q = (u8 >> 4).astype(np.int32)
    code = q[..., 0] * 256 + q[..., 1] * 16 + q[..., 2]
    counts = np.bincount(code.ravel(), minlength=4096).astype(np.float64)
    p = counts[counts > 0] / counts.sum()
    entropy = float(-(p * np.log2(p)).sum())
    dominant = float(counts.max() / counts.sum())

    g = a.mean(-1)
    gx = np.zeros_like(g)
    gy = np.zeros_like(g)
    gx[:, 1:-1] = g[:, 2:] - g[:, :-2]
    gy[1:-1, :] = g[2:, :] - g[:-2, :]
    mag = np.hypot(gx, gy)
    edge = float((mag > 0.12).mean())

    lum = g * 255
    contrast = float(np.percentile(lum, 95) - np.percentile(lum, 5))
    return {
        "colorEntropyBits": round(entropy, 2),
        "dominantColorShare": round(dominant, 3),
        "edgeDensity": round(edge, 4),
        "luminance_contrast": round(contrast, 1),
    }


# Frames come from states.py; the old artifacts/cloud-audit/live/ frames this table
# used to quote are not in the repo, so those numbers are no longer reproducible.
CASES = [
    ("ref-01 target", st.path(st.get("A-cruise")["ref"])),
    ("A-cruise", st.path(st.get("A-cruise")["capture"])),
    ("D-skim", st.path(st.get("D-skim")["capture"])),
]

if __name__ == "__main__":
    print("%-16s %10s %10s %10s %12s" % ("case", "entropy", "domShare", "edgeDens", "contrast"))
    for name, path in CASES:
        try:
            a = m.content_crop(path)
        except FileNotFoundError:
            print("%-16s MISSING" % name)
            continue
        r = metrics(a)
        print("%-16s %10.2f %10.3f %10.4f %12.1f" % (
            name, r["colorEntropyBits"], r["dominantColorShare"],
            r["edgeDensity"], r["luminance_contrast"]))

    print()
    print("bands (top30%% sky / mid cloud / bottom30%% sea), edgeDensity only:")
    for name, path in CASES:
        try:
            a = m.content_crop(path)
        except FileNotFoundError:
            continue
        h = a.shape[0]
        for label, sl in (("sky", slice(0, int(h * 0.30))),
                          ("cloud", slice(int(h * 0.30), int(h * 0.62))),
                          ("sea", slice(int(h * 0.72), h))):
            print("  %-14s %-6s edge %.4f" % (name, label, metrics(a[sl])["edgeDensity"]))
