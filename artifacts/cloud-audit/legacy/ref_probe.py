"""Extract the cloud geometry/colour targets from the reference frame.

The question this answers is not "what colour are the clouds" (the palette file
already has that) but "what SHAPE language do they use": how many flat value
bands, how big are the lobes relative to the cloud, and what aspect ratio does a
reference cumulus actually have.
"""
import json

import numpy as np
from PIL import Image, ImageDraw

SRC = "docs/superpowers/specs/assets/ref-01-sunset-glide.png"
OUT_DIR = "artifacts/cloud-audit/ref"

img = Image.open(SRC).convert("RGB")
W, H = img.size
a = np.asarray(img).astype(np.float32)

# --- 1. isolate the two cumulus masses by hand-picked boxes ------------------
boxes = {
    # left bank: the big dark-violet mass that runs off the top-left corner
    "left_bank": (0, 0, 215, 215),
    # centre column: the tall one behind the subtitle
    "centre_column": (285, 10, 425, 190),
}
report = {"source": SRC, "size": [W, H], "regions": {}}

for name, (x0, y0, x1, y1) in boxes.items():
    crop = img.crop((x0, y0, x1, y1))
    crop.resize(((x1 - x0) * 3, (y1 - y0) * 3), Image.NEAREST).save(f"{OUT_DIR}/{name}.png")

    # A cloud pixel = clearly cooler/darker than the warm sky at the same height.
    # Sky near the horizon is orange (R >> B); cloud body is violet (B >= R).
    r, g, b = crop.split()
    ra, ga, ba = (np.asarray(c).astype(np.float32) for c in (r, g, b))
    cool = (ba > ra * 0.80) & (ba > 60)
    cloud_share = float(cool.mean())

    lum = ra * 0.299 + ga * 0.587 + ba * 0.114
    cloud_lum = lum[cool] if cool.any() else np.array([0.0])

    # Flat-band count inside the cloud mask: bins carrying >4% of cloud pixels.
    hist = np.histogram(cloud_lum, bins=32, range=(0, 256))[0]
    bands = int((hist > 0.04 * max(cloud_lum.size, 1)).sum())

    # Silhouette: per-column top and bottom edge of the cloud mask, in the crop.
    cols = []
    for cx in range(cool.shape[1]):
        ys = np.nonzero(cool[:, cx])[0]
        if ys.size:
            cols.append((cx, int(ys.min()), int(ys.max())))
    heights = [c[2] - c[1] for c in cols]
    widths_with_cloud = len(cols)

    report["regions"][name] = {
        "box": [x0, y0, x1, y1],
        "cloud_pixel_share": round(cloud_share, 3),
        "cloud_lum_p5_p95": [round(float(np.percentile(cloud_lum, 5)), 1),
                             round(float(np.percentile(cloud_lum, 95)), 1)],
        "cloud_lum_span": round(float(np.percentile(cloud_lum, 95) - np.percentile(cloud_lum, 5)), 1),
        "flat_bands_above_4pct": bands,
        "mean_rgb_in_cloud": [round(float(v), 0) for v in
                              np.asarray(crop).reshape(-1, 3)[cool.reshape(-1)].mean(axis=0)]
                             if cool.any() else None,
        "cloud_width_px": widths_with_cloud,
        "median_height_px": int(np.median(heights)) if heights else 0,
        "aspect_h_over_w": round(float(np.median(heights)) / max(widths_with_cloud, 1), 3) if heights else None,
    }

# --- 2. contrast between cloud body and the sky directly beside it ----------
print(json.dumps(report, indent=2))
