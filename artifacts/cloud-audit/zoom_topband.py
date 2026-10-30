"""Crop + upscale the top cloud band so it can be looked at, and emit a
equal-value contour map (bands of identical luminance) to separate
"authored flat lobes" from "multi-scale noise".
"""
import numpy as np
from PIL import Image, ImageDraw

SRC = "docs/qa/wisp-alt55-current.png"
OUT_CROP = "artifacts/cloud-audit/top-band-crop.png"
OUT_LEVELS = "artifacts/cloud-audit/top-band-levels.png"

img = Image.open(SRC).convert("RGB")
x0, x1 = 577, 1093
crop = img.crop((x0, 0, x1, 340))
w, h = crop.size
scale = 2
crop.resize((w * scale, h * scale), Image.NEAREST).save(OUT_CROP)

a = np.asarray(crop).astype(np.float32)
gray = a @ np.array([0.299, 0.587, 0.114], dtype=np.float32)

# Posterise luminance into 12 equal bands -> each band becomes one flat colour.
lo, hi = float(np.percentile(gray, 1)), float(np.percentile(gray, 99))
norm = np.clip((gray - lo) / max(hi - lo, 1e-6), 0, 0.999)
bands = (norm * 12).astype(np.int32)
palette = np.array(
    [
        [20, 16, 40],
        [46, 34, 78],
        [74, 50, 112],
        [104, 66, 140],
        [136, 84, 156],
        [168, 106, 160],
        [198, 132, 156],
        [222, 160, 150],
        [240, 190, 148],
        [250, 214, 160],
        [255, 234, 196],
        [255, 250, 235],
    ],
    dtype=np.uint8,
)
rgb = palette[bands]

# Overlay the 12 band boundaries as thin dark contour lines.
edge = np.zeros(bands.shape, dtype=bool)
edge[:, 1:] |= bands[:, 1:] != bands[:, :-1]
edge[1:, :] |= bands[1:, :] != bands[:-1, :]
rgb[edge] = [12, 10, 24]

out = Image.fromarray(rgb).resize((w * scale, h * scale), Image.NEAREST)
out.save(OUT_LEVELS)

# --- decisiveness metrics on the same crop ------------------------------
pad = np.pad(gray, 2, mode="edge")
win = np.lib.stride_tricks.sliding_window_view(pad, (5, 5))
lrange = win.max(axis=(2, 3)) - win.min(axis=(2, 3))

# spatial autocorrelation length along x and y (where structure stops being correlated)
g = gray - gray.mean()
spec = np.fft.fft2(g)
power = np.abs(spec) ** 2
fy = np.fft.fftfreq(g.shape[0])[:, None]
fx = np.fft.fftfreq(g.shape[1])[None, :]
radial = np.hypot(fy, fx)
total = power.sum()
hi_freq_energy = float(power[radial > 0.15].sum() / total)  # cycles/px > 0.15 == features < 6.7 px

print(
    {
        "crop_wh": [w, h],
        "gray_std": round(float(gray.std()), 2),
        "near_flat_5x5_frac": round(float((lrange < 6).mean()), 4),
        "high_freq_energy_frac_gt0.15cyc": round(hi_freq_energy, 4),
        "p_equal_value_band_frac": round(float(edge.mean()), 4),
        "distinct_12bit_bands_used": int(len(np.unique(bands))),
        "out_crop": OUT_CROP,
        "out_levels": OUT_LEVELS,
    }
)
