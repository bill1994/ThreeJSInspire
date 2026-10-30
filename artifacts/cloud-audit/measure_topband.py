"""Measure the top-of-frame cloud band in the real QA capture.

Question: does the top band read as *authored cloud* (few, large, flat colour
regions with hard edges) or as *noise texture* (many tiny uncorrelated blobs,
low local contrast, high edge density)?

Metrics, per horizontal band of the game column:
  flat_area_frac   share of pixels whose 3x3 neighbourhood is near-constant
  edge_density     fraction of pixels above a Sobel threshold
  blob_px          median connected-component area of a thresholded mask
  cmax             mean max-RGB (value channel) -> is there ANY highlight?
  sat              mean HSV saturation
  band_levels      how many distinct value levels survive 8-bit quantisation
"""
import json
import sys

import numpy as np
from PIL import Image

SRC = "docs/qa/wisp-alt55-current.png"

img = Image.open(SRC).convert("RGB")
a = np.asarray(img).astype(np.float32)
H, W, _ = a.shape

# The game renders into a 9:16 column; find it by looking for the non-background columns.
# The page background is a flat very dark plum; the game column is everything brighter.
col_mean = a.mean(axis=(0, 2))
bg = float(np.median(np.concatenate([col_mean[:300], col_mean[-300:]])))
game_cols = np.where(col_mean > bg + 6)[0]
x0, x1 = int(game_cols.min()), int(game_cols.max()) + 1
game_rows = np.where(a[:, x0:x1].mean(axis=(1, 2)) > 1e-3)[0]
y0, y1 = int(game_rows.min()), int(game_rows.max()) + 1
col = a[y0:y1, x0:x1]
ch, cw, _ = col.shape


def sobel_mag(gray):
    gx = np.zeros_like(gray)
    gy = np.zeros_like(gray)
    gx[:, 1:-1] = gray[:, 2:] - gray[:, :-2]
    gy[1:-1, :] = gray[2:, :] - gray[:-2, :]
    return np.hypot(gx, gy)


def components(mask):
    """4-connected component areas via a tiny iterative flood fill (no scipy)."""
    lab = np.zeros(mask.shape, dtype=np.int32)
    areas = []
    cur = 0
    ys, xs = np.nonzero(mask)
    for sy, sx in zip(ys, xs):
        if lab[sy, sx]:
            continue
        cur += 1
        stack = [(sy, sx)]
        lab[sy, sx] = cur
        area = 0
        while stack:
            cy, cx = stack.pop()
            area += 1
            for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                if 0 <= ny < mask.shape[0] and 0 <= nx < mask.shape[1]:
                    if mask[ny, nx] and not lab[ny, nx]:
                        lab[ny, nx] = cur
                        stack.append((ny, nx))
        areas.append(area)
    return areas


out = {
    "source": SRC,
    "image_wh": [W, H],
    "game_column": {"x0": x0, "x1": x1, "y0": y0, "y1": y1, "w": cw, "h": ch},
    "bands": [],
}

# Eight horizontal bands over the top 55% of the game column (where the cloud deck is).
NB = 8
top_frac = 0.55
for b in range(NB):
    yy0 = int(ch * top_frac * b / NB)
    yy1 = int(ch * top_frac * (b + 1) / NB)
    patch = col[yy0:yy1]
    gray = patch @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    value = patch.max(axis=2)
    mx = patch.max(axis=2)
    mn = patch.min(axis=2)
    sat = np.where(mx > 1, (mx - mn) / np.maximum(mx, 1), 0.0)

    # near-constant 3x3 -> flat area
    pad = np.pad(gray, 1, mode="edge")
    win = np.lib.stride_tricks.sliding_window_view(pad, (3, 3))
    local_range = win.max(axis=(2, 3)) - win.min(axis=(2, 3))
    flat_frac = float((local_range < 3.0).mean())

    mag = sobel_mag(gray)
    edge_density = float((mag > 12.0).mean())

    # blob structure: threshold the deviation from the band median
    dev = value - np.median(value)
    mask = dev > 4.0
    areas = components(mask) if mask.any() else []
    med_area = float(np.median(areas)) if areas else 0.0
    n_comp = len(areas)

    # how many value levels actually survive quantisation
    hist = np.histogram(value, bins=48, range=(0, 255))[0]
    levels = int((hist > 0.01 * value.size).sum())

    out["bands"].append(
        {
            "band": b,
            "y0": y0 + yy0,
            "y1": y0 + yy1,
            "mean_rgb": [round(float(v), 1) for v in patch.reshape(-1, 3).mean(axis=0)],
            "value_mean": round(float(value.mean()), 1),
            "value_std": round(float(value.std()), 2),
            "sat_mean": round(float(sat.mean()), 3),
            "flat_area_frac": round(flat_frac, 4),
            "edge_density": round(edge_density, 4),
            "blob_median_px": round(med_area, 1),
            "blob_count": n_comp,
            "value_levels": levels,
        }
    )

print(json.dumps(out, indent=2))
