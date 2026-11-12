"""DOME-01 fix predictor — is each candidate fix actually worth the gate?

The gate metric is a ROW-MEAN luma diff (analyze_horizon.py: rows_diff =
diff.mean(axis=1)), while the patch only covers ~13% of columns. That means the
row-mean hides the real per-pixel contrast, and a fix can look big per-pixel yet
still miss a 20-unit row-mean gate. This script separates the two.

Input: the committed isolation pair (on vs patch-hidden) so the diff IS the patch.
Output: per-pixel contrast distribution, the strongest patch pixel, the implied
patch colour, and a linear-space simulation of what haze_mix / alpha can buy.

Usage: python -I predict_horizon_fix.py on.png hidden.png --rect 474.875,0,434.25,772
"""
import json
import sys

import numpy as np
from PIL import Image

# Palette + constants, mirrored from src/dome-cloud.ts and src/dome-horizon.ts.
BAND0 = np.array([0.14, 0.16, 0.27])   # backlit silhouette bottom
BAND1 = np.array([0.17, 0.19, 0.33])   # backlit silhouette top
HAZE = np.array([0.15, 0.19, 0.31])
HAZE_MIX = 0.45
ALPHA_MIN, ALPHA_MAX = 0.5, 0.8


def load(path):
    return np.asarray(Image.open(path).convert('RGB')).astype(np.float64)


def lin2srgb(x):
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def luma(rgb):
    return 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]


def canvas_slice(shape, rect):
    x, y, w, h = rect
    x0, y0 = int(round(x)), int(round(y))
    x1, y1 = int(round(x + w)), int(round(y + h))
    return (slice(max(0, y0), min(shape[0], y1)), slice(max(0, x0), min(shape[1], x1)))


def predicted_patch_srgb(haze_mix=HAZE_MIX):
    """Peak (backlit, lit01=0) patch colour as 8-bit sRGB, after haze mix."""
    lin = (1.0 - haze_mix) * BAND0 + haze_mix * HAZE
    return lin2srgb(lin) * 255.0


def main(argv):
    on, hidden = load(argv[1]), load(argv[2])
    if on.shape != hidden.shape:
        raise SystemExit(f'size mismatch: {on.shape} vs {hidden.shape}')
    rect = (474.875, 0, 434.25, 772)
    args = argv[3:]
    if '--rect' in args:
        rect = tuple(float(v) for v in args[args.index('--rect') + 1].split(','))

    sl = canvas_slice(on.shape, rect)
    on_c, hid_c = on[sl], hidden[sl]

    lon, lhid = luma(on_c), luma(hid_c)
    d = lon - lhid                      # signed, 8-bit luma units
    absd = np.abs(d)

    # ---- per-pixel contrast in the patch probe band, row-mean vs raw ----
    pb = slice(150, 300)
    band_absd = absd[pb]
    band_d = d[pb]
    band_on, band_hid = lon[pb], lhid[pb]

    flat_idx = int(np.argmax(band_absd))
    py, px = np.unravel_index(flat_idx, band_absd.shape)
    peak = {
        'row_in_band': int(py),
        'row_abs': int(py + 150),
        'col': int(px),
        'on_luma': float(band_on[py, px]),
        'hidden_luma': float(band_hid[py, px]),
        'signed_diff': float(band_d[py, px]),
        'on_rgb': [round(float(v), 1) for v in on_c[py + 150, px]],
        'hidden_rgb': [round(float(v), 1) for v in hid_c[py + 150, px]],
    }

    # Row-mean (the actual gate metric) vs per-pixel truth.
    row_mean_abs = absd[pb].mean(axis=1)
    row_mean_peak = float(row_mean_abs.max())
    row_mean_peak_row = int(np.argmax(row_mean_abs)) + 150
    coverage = float((band_absd > 3).mean())

    # coverage on the peak row only — the gate number is diluted by empty columns
    pr = int(np.argmax(row_mean_abs))
    row_cov = float((band_absd[pr] > 3).mean())

    # ---- implied patch colour at the peak pixel, per plausible alpha ----
    # on = sky + alpha*(patch - sky)  ->  patch = sky + (on - sky)/alpha
    implied = {}
    for a in (ALPHA_MIN, 0.65, ALPHA_MAX):
        patch_rgb = np.array(hid_c[py + 150, px]) + (np.array(on_c[py + 150, px]) - np.array(hid_c[py + 150, px])) / a
        implied[f'alpha_{a:.2f}'] = {
            'patch_rgb': [round(float(v), 1) for v in patch_rgb],
            'patch_minus_sky_luma': round(float(luma(patch_rgb) - float(band_hid[py, px])), 2),
        }

    # ---- what each fix buys, in the gate's own units ----
    base_patch = predicted_patch_srgb(HAZE_MIX)
    base_luma = float(luma(base_patch))

    haze_table = {}
    for m in (0.45, 0.30, 0.15, 0.0):
        p = predicted_patch_srgb(m)
        dl = base_luma - float(luma(p))          # darker patch -> positive gain
        haze_table[f'haze_mix_{m:.2f}'] = {
            'patch_luma': round(float(luma(p)), 1),
            'darker_than_current': round(dl, 1),
            'per_pixel_gain_at_alpha_065': round(dl * 0.65, 1),
            'row_mean_gain_at_row_cov': round(dl * 0.65 * row_cov, 2),
        }

    alpha_table = {}
    for a in (0.65, 0.8, 0.95, 1.0):
        # raising alpha scales the whole (patch - sky) term
        scale = a / 0.65
        filled = abs(float(band_d[py, px])) * scale
        alpha_table[f'alpha_{a:.2f}'] = {
            'peak_per_pixel': round(filled, 1),
            'row_mean_if_same_coverage': round(filled * row_cov, 2),
        }

    report = {
        'patch_probe_band': {
            'rows': [150, 300],
            'gate_row_mean_max_abs': round(row_mean_peak, 3),
            'gate_row_mean_peak_row': row_mean_peak_row,
            'raw_per_pixel_max_abs': round(float(band_absd.max()), 2),
            'raw_per_pixel_p99_abs': round(float(np.percentile(band_absd, 99)), 2),
            'frac_over_3_all_rows': round(coverage, 4),
            'frac_over_3_peak_row': round(row_cov, 4),
            'dilution_factor': round(float(band_absd.max()) / row_mean_peak, 2) if row_mean_peak else None,
        },
        'peak_pixel': peak,
        'implied_patch_colour': implied,
        'predicted_peak_patch_srgb_at_current_mix': [round(float(v), 1) for v in base_patch],
        'haze_mix_table': haze_table,
        'alpha_table': alpha_table,
        'verdict': 'haze_mix is the wrong lever' if max(v['row_mean_gain_at_row_cov'] for v in haze_table.values()) < 20 else 'haze_mix can reach the gate',
    }
    print(json.dumps(report, indent=1))


if __name__ == '__main__':
    main(sys.argv)
