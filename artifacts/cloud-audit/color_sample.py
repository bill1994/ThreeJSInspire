"""Median sRGB per band + the two things "washed sky" actually means.

Bands are the auditor's own (`ref_gap_measure.bands`): sky = top 30%, cloud =
25..62%, sea = 70..100%. Cloud uses the same violet mask as the blob counter.

On top of that, two sky-specific measurements:

  warm sky     pixels in the top 30% with hue 5..70 deg, s > 0.10, v > 0.45 —
               the sunset band itself, excluding the violet cloud mass. Reported
               as L*/C* medians, which is the pair an "is it washed" claim needs.
  profile      median sRGB of a horizontal slice at a series of frame heights,
               so the vertical ramp (and its absence) is a table, not an adjective.

Usage: python artifacts/cloud-audit/color_sample.py
"""
import importlib.util

import numpy as np

spec = importlib.util.spec_from_file_location("m", "artifacts/cloud-audit/ref_gap_measure.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

CASES = [
    ("ref-01", "docs/superpowers/specs/assets/ref-01-sunset-glide.png"),
    ("ref-02", "docs/superpowers/specs/assets/ref-02-speed-lines.png"),
    ("ref-03", "docs/superpowers/specs/assets/ref-03-spiral-dive.png"),
    ("live cruise ACES", "artifacts/cloud-audit/live/live-cruise-alt60.png"),
    ("live cruise neutral", "artifacts/cloud-audit/live/live-cruise-neutral-alt60.png"),
    ("live cruise nohud", "artifacts/cloud-audit/live/live-cruise-nohud-alt60.png"),
    ("live skim alt7", "artifacts/cloud-audit/live/live-skim-alt7.png"),
]

PROFILE_ROWS = (0.02, 0.10, 0.20, 0.26, 0.32, 0.40)


def med(a, mask=None):
    px = a.reshape(-1, 3) if mask is None else a.reshape(-1, 3)[mask.reshape(-1)]
    if px.size == 0:
        return None
    return tuple(int(round(c * 255)) for c in np.median(px, axis=0))


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


def main():
    print("%-22s %-18s %-18s %-18s" % ("case", "sky median rgb", "cloud median rgb", "sea median rgb"))
    for name, path in CASES:
        a = m.content_crop(path)
        b = m.bands(a)
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
