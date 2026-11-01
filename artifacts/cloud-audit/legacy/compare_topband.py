"""Compare the top-of-frame band across captures with the same metrics.

Usage: python compare_topband.py <image> [<image> ...]

Reports, over the top 30% of the game column:
  flat5      share of pixels whose 5x5 neighbourhood spans < 6 levels  (smoothness)
  edge_dens  share of pixels above a Sobel threshold                   (edge amount)
  levels     distinct 8-bit value levels carrying >1% of pixels        (flat-colour count)
  dE_cloud   max sRGB distance between the darkest and lightest 5%-percentile
             (how much tonal range the band actually uses)
"""
import json
import sys

import numpy as np
from PIL import Image


def game_column(a):
    col_mean = a.mean(axis=(0, 2))
    bg = float(np.median(np.concatenate([col_mean[:200], col_mean[-200:]])))
    cols = np.where(col_mean > bg + 6)[0]
    x0, x1 = int(cols.min()), int(cols.max()) + 1
    rows = np.where(a[:, x0:x1].mean(axis=(1, 2)) > 1e-3)[0]
    return x0, x1, int(rows.min()), int(rows.max()) + 1


def sobel(g):
    gx = np.zeros_like(g)
    gy = np.zeros_like(g)
    gx[:, 1:-1] = g[:, 2:] - g[:, :-2]
    gy[1:-1, :] = g[2:, :] - g[:-2, :]
    return np.hypot(gx, gy)


out = []
for path in sys.argv[1:]:
    a = np.asarray(Image.open(path).convert("RGB")).astype(np.float32)
    x0, x1, y0, y1 = game_column(a)
    col = a[y0:y1, x0:x1]
    ch = col.shape[0]
    band = col[: int(ch * 0.30)]
    g = band @ np.array([0.299, 0.587, 0.114], dtype=np.float32)

    pad = np.pad(g, 2, mode="edge")
    win = np.lib.stride_tricks.sliding_window_view(pad, (5, 5))
    lrange = win.max(axis=(2, 3)) - win.min(axis=(2, 3))

    mag = sobel(g)
    hist = np.histogram(g, bins=256, range=(0, 255))[0]
    levels = int((hist > 0.01 * g.size).sum())
    lo = float(np.percentile(g, 5))
    hi = float(np.percentile(g, 95))

    out.append(
        {
            "image": path,
            "game_column": [x0, x1, y0, y1],
            "band_h": band.shape[0],
            "flat5": round(float((lrange < 6).mean()), 4),
            "edge_dens": round(float((mag > 12).mean()), 4),
            "levels": levels,
            "p5_p95": [round(lo, 1), round(hi, 1)],
        }
    )

print(json.dumps(out, indent=2))
