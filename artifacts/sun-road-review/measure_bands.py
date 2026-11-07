"""Re-measure the archived sun-road frames. Usage: python measure_bands.py"""
import json, os, sys
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
BANDS = {"sky": (0.00, 0.35), "mid": (0.35, 0.62), "sea-mid": (0.45, 0.62),
         "near": (0.62, 0.90), "bottom": (0.90, 1.00)}
LUMA = np.array([0.2126, 0.7152, 0.0722])

def bands(path):
    a = np.asarray(Image.open(path).convert("RGB")).astype(float)
    h = a.shape[0]; l = a @ LUMA
    out = {}
    for name, (t, b) in BANDS.items():
        sl = slice(int(t * h), int(b * h))
        out[name] = {"p5": round(float(np.percentile(l[sl], 5)), 1),
                     "p50": round(float(np.percentile(l[sl], 50)), 1),
                     "p95": round(float(np.percentile(l[sl], 95)), 1),
                     "blown%": round(float((a[sl] > 240).any(axis=2).mean() * 100), 1)}
    return out

if __name__ == "__main__" and len(sys.argv) == 1:
    res = {f: bands(os.path.join(HERE, f)) for f in sorted(os.listdir(HERE)) if f.endswith(".png")}
    print(json.dumps(res, indent=1))

# ---- Round-2 acceptance metrics (plan v2 Task 4 / final review Important 2) ----
# Seam-row exclusion (V4: the 1px R0/R1 ring boundary), the clean-sea band
# below the horizon mirror fade, and the road window. Frames: A3-r2/B3-r2.

def _lum(a):
    return a @ np.array([0.2126, 0.7152, 0.0722])

def seam_rows(l, lo, hi, jump=20.0):
    """Rows whose row-median jumps vs the previous row (ring boundary lines)."""
    med = np.median(l[lo:hi], axis=1)
    d = np.abs(np.diff(med))
    return [int(lo + i) for i in np.where(d > jump)[0]]

def road_window(l, h, w, rows=(0.60, 0.85), k=60):
    """Brightest k-px column window in the near-sea rows: the road."""
    r0, r1 = int(rows[0] * h), int(rows[1] * h)
    sea = l[r0:r1]
    best = max(range(0, w - k), key=lambda x: sea[:, x:x + k].sum())
    off = sea[:, 0:60]
    road = sea[:, best:best + k]
    return {
        "road_cols": [int(best), int(best + k)],
        "road_mean": round(float(road.mean()), 1),
        "road_p90": round(float(np.percentile(road, 90)), 1),
        "off_mean": round(float(off.mean()), 1),
        "display_ratio": round(float(road.mean() / off.mean()), 2),
        "gt200_pct": round(float((road > 200).mean() * 100), 1),
    }

def glints(l, h, w, rows=(0.45, 0.80), thresh=25.0, floor=120.0):
    """Discrete local maxima in the sea, seam rows and their +-2 excluded (V4)."""
    r0, r1 = int(rows[0] * h), int(rows[1] * h)
    m = l[r0:r1]
    peaks = (m[1:-1] > m[:-2] + thresh) & (m[1:-1] > m[2:] + thresh) & (m[1:-1] > floor)
    bad = seam_rows(l, r0, r1)
    keep = np.ones(m.shape[0] - 2, bool)
    for y in bad:
        lo = max(0, y - r0 - 2)
        keep[max(0, lo - 2): lo + 5] = False
    peaks[~keep] = False
    return int(peaks.sum())

def round2(path):
    a = np.asarray(Image.open(path).convert("RGB")).astype(float)
    h, w, _ = a.shape
    l = _lum(a)
    out = {"bands": bands(path)}
    lo0, lo1 = int(0.57 * h), int(0.75 * h)  # clean sea below the mirror fade
    band = a[lo0:lo1]
    out["clean_sea"] = {
        "blown%": round(float((band > 240).any(axis=2).mean() * 100), 1),
        "p95": round(float(np.percentile(l[lo0:lo1], 95)), 1),
    }
    out["road"] = road_window(l, h, w)
    out["glints_seam_excluded"] = glints(l, h, w)
    return out

if __name__ == "__main__" and len(sys.argv) > 1:
    print(json.dumps({f: round2(f) for f in sys.argv[1:]}, indent=1))
