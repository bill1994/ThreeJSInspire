"""Median sRGB per band + the two things "washed sky" actually means.

Bands are the auditor's own fixed split (`ref_gap_measure.bands_fixed`): sky = top
30%, cloud = 25..62%, sea = 70..100%. Cloud uses the same violet mask as the blob
counter. This is a qualitative palette table, not a gated measurement — for anything
quoted in a document use content-anchored regions via audit.py instead.

The frames this table used to read (live/live-cruise-{alt60,neutral-alt60,nohud-alt60}.png,
live/live-skim-alt7.png) are not in the repo. It now reads the frozen protocol
captures from states.py, so a re-run measures something real.

On top of that, two sky-specific measurements:

  warm sky     pixels in the top 30% with hue 5..70 deg, s > 0.10, v > 0.45 —
               the sunset band itself, excluding the violet cloud mass. Reported
               as L*/C* medians, which is the pair an "is it washed" claim needs.
  profile      median sRGB of a horizontal slice at a series of frame heights,
               so the vertical ramp (and its absence) is a table, not an adjective.

Usage: python artifacts/cloud-audit/color_sample.py
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

CASES = ([(p["pair"], st.path(p["ref"])) for p in st.pairs()]
         + [(s["state"], st.path(s["capture"])) for s in st.states()])

PROFILE_ROWS = (0.02, 0.10, 0.20, 0.26, 0.32, 0.40)


def med(a, mask=None):
    px = a.reshape(-1, 3) if mask is None else a.reshape(-1, 3)[mask.reshape(-1)]
    if px.size == 0:
        return None
    return tuple(int(round(c * 255)) for c in np.median(px, axis=0))


def _lab_stats(px):
    if px.shape[0] < 100:
        return None
    lab = m.srgb_to_lab(px)
    return {
        "L_med": round(float(np.median(lab[:, 0])), 1),
        "C_med": round(float(np.median(np.hypot(lab[:, 1], lab[:, 2]))), 1),
    }


def warm_sky(top):
    hue, s, v = m.hsv(top)
    warm = (hue > 5) & (hue < 70) & (s > 0.10) & (v > 0.45)
    if warm.sum() < 100:
        return None
    lab = m.srgb_to_lab(top[warm])
    return {
        "share": round(float(warm.mean()), 3),
        "L_med": round(float(np.median(lab[:, 0])), 1),
        "C_med": round(float(np.median(np.hypot(lab[:, 1], lab[:, 2]))), 1),
    }


def cool_sky(top):
    """Cold/complement band of the top-30% strip — the warm mask is hue 5-70 and
    returns None on a navy night sky (2026-11-08 day-night Task 8: night keys have
    no warm band at all, so the cold complement + the whole strip are the metrics
    that actually read)."""
    hue, s, v = m.hsv(top)
    warm = (hue > 5) & (hue < 70) & (s > 0.10) & (v > 0.45)
    cool = top[~warm]
    stats = _lab_stats(cool)
    if stats is None:
        return None
    return {"share": round(float((~warm).mean()), 3), **stats}


def whole_sky(top):
    """Whole top-30% strip, no hue filter — always measurable, day or night."""
    stats = _lab_stats(top)
    if stats is None:
        return None
    return {"share": 1.0, **stats}


def main():
    print("%-22s %-18s %-18s %-18s" % ("case", "sky median rgb", "cloud median rgb", "sea median rgb"))
    for name, path in CASES:
        a = m.content_crop(path)
        b = m.bands_fixed(a)
        print("%-22s %-18s %-18s %-18s" % (
            name, med(b["sky"]), med(b["cloud"], m.cloud_mask(b["cloud"])), med(b["sea"])))

    print()
    print("%-22s %-7s %-7s %-7s" % ("case", "share", "L*med", "C*med"))
    for name, path in CASES:
        a = m.content_crop(path)
        w = warm_sky(a[: int(a.shape[0] * 0.30)])
        print("%-22s %-7s %-7s %-7s" % (
            name, w["share"], w["L_med"], w["C_med"]) if w else "%-22s (no warm band)" % name)

    print()
    print("%-22s %-7s %-7s %-7s   (cool complement of the warm mask, top 30%%)"
          % ("case", "share", "L*med", "C*med"))
    for name, path in CASES:
        a = m.content_crop(path)
        c = cool_sky(a[: int(a.shape[0] * 0.30)])
        print("%-22s %-7s %-7s %-7s" % (
            name, c["share"], c["L_med"], c["C_med"]) if c else "%-22s (too few pixels)" % name)

    print()
    print("%-22s %-7s %-7s %-7s   (whole top-30%% strip, no hue filter)"
          % ("case", "share", "L*med", "C*med"))
    for name, path in CASES:
        a = m.content_crop(path)
        c = whole_sky(a[: int(a.shape[0] * 0.30)])
        print("%-22s %-7s %-7s %-7s" % (
            name, c["share"], c["L_med"], c["C_med"]) if c else "%-22s (too few pixels)" % name)

    print()
    print("vertical profile, median rgb over the centre 40% width")
    for name, path in CASES:
        a = m.content_crop(path)
        h, w, _ = a.shape
        x0, x1 = int(w * 0.30), int(w * 0.70)
        cells = []
        for f in PROFILE_ROWS:
            seg = a[min(int(h * f), h - 1), x0:x1]
            cells.append("y=%.2f %s" % (f, med(seg)))
        print("  %-22s %s" % (name, " | ".join(cells)))


if __name__ == "__main__":
    main()
