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

# Frames come from states.py. The live/ frames this list used to carry — including the
# ACES-vs-neutral and HUD-vs-nohud pairs — are not in the repo, so they cannot be
# re-measured; only the frozen protocol captures can.
CASES = ([(p["pair"], st.path(p["ref"])) for p in st.pairs()]
         + [(s["state"], st.path(s["capture"])) for s in st.states()])


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
