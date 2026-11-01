"""Sky-band probe: what is actually flat / washed in the dome, and where.

`scorecard_metrics.py` measures edgeDensity on the whole top 30% band, which on a
portrait capture includes the HUD panels (top-left speed card, top-right mixer).
This probe separates the two:

  full   = scorecard's definition, top 30% of the frame, whole width
  strip  = top 22% of the frame, x in [0.36, 0.56]  (no HUD text, no letterbox)
  band   = rows 0.20..0.30 (just above the horizon), same x strip

and adds the two things that separate "flat" from "gradient":

  value_swing_strip = value(strip top) - value(band, just above horizon)
  row_steps         = number of distinct row-means in the strip after quantising
                      to 1/255 sRGB, i.e. how many visible tonal steps the dome has

Usage: python artifacts/cloud-audit/sky_band_probe.py
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
    ("live cruise (ACES, pre-P1)", "artifacts/cloud-audit/live/live-cruise-alt60.png"),
    ("live cruise neutral (post-P1)", "artifacts/cloud-audit/live/live-cruise-neutral-alt60.png"),
    ("live cruise nohud", "artifacts/cloud-audit/live/live-cruise-nohud-alt60.png"),
    ("live dive alt200", "artifacts/cloud-audit/live/live-dive-alt200.png"),
    ("live bankdive alt220", "artifacts/cloud-audit/live/live-bankdive-alt220.png"),
    ("live skim alt7", "artifacts/cloud-audit/live/live-skim-alt7.png"),
]


def edges(g, thr=0.12):
    gx = np.zeros_like(g)
    gy = np.zeros_like(g)
    gx[:, 1:-1] = g[:, 2:] - g[:, :-2]
    gy[1:-1, :] = g[2:, :] - g[:-2, :]
    return float((np.hypot(gx, gy) > thr).mean())


def sky_report(a):
    h, w, _ = a.shape
    x0, x1 = int(w * 0.36), int(w * 0.56)
    strip = a[: int(h * 0.22), x0:x1]
    band = a[int(h * 0.20):int(h * 0.30), x0:x1]
    full = a[: int(h * 0.30)]
    v = a.mean(-1)
    row = a[: int(h * 0.30), x0:x1].mean(axis=(1, 2))
    steps = len(np.unique(np.round(row * 255).astype(int)))
    lab = m.srgb_to_lab(strip.reshape(-1, 3))
    L, C = lab[:, 0], np.hypot(lab[:, 1], lab[:, 2])
    return {
        "edge_full": round(edges(full.mean(-1)), 4),
        "edge_strip": round(edges(strip.mean(-1)), 4),
        "sat_strip": round(float(np.mean(m.hsv(strip)[1])), 3),
        "sat_max98": round(float(np.percentile(m.hsv(strip)[1], 98)), 3),
        "C_med_strip": round(float(np.median(C)), 1),
        "C_p95_strip": round(float(np.percentile(C, 95)), 1),
        "L_med_strip": round(float(np.median(L)), 1),
        "value_top": round(float(np.mean(v[: int(h * 0.06), x0:x1])), 3),
        "value_above_horizon": round(float(np.mean(v[int(h * 0.20):int(h * 0.30), x0:x1])), 3),
        "value_swing_strip": round(float(np.mean(v[: int(h * 0.06), x0:x1])
                                          - np.mean(v[int(h * 0.24):int(h * 0.30), x0:x1])), 3),
        "row_tonal_steps": steps,
    }


if __name__ == "__main__":
    keys = None
    for name, path in CASES:
        try:
            a = m.content_crop(path)
        except FileNotFoundError:
            print("%-30s MISSING" % name)
            continue
        r = sky_report(a)
        if keys is None:
            keys = list(r)
            print("%-30s %s" % ("case", " ".join("%16s" % k for k in keys)))
        print("%-30s %s" % (name, " ".join("%16s" % r[k] for k in keys)))
