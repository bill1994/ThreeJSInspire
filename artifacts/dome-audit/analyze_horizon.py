"""Dome-horizon Task 7 gate — per-row ON/OFF luma diff on the low-altitude pose.

Outputs:
  1. horizon row of the OFF frame (max |d luma/d row| in a search window) — the
     camera rig rides above the plane, so the horizon is measured, not assumed.
  2. per-row ON-OFF luma diff segments (|diff| > 3) over the whole canvas —
     deck band vs patch band vs near-horizon band.
  3. R7 verdict numbers for the near-horizon band (horizon ±5°): max |diff| and
     the widest contiguous run of rows that is >90% "masked" (diff > 3 full width).

Usage: python -I analyze_horizon.py on.png off.png --rect 474.875,0,434.25,772
"""
import json
import sys

import numpy as np
from PIL import Image

PX_PER_DEG = 772 / 60.0  # fov 60° vertical over 772 px


def load(path):
    return np.asarray(Image.open(path).convert('RGB')).astype(np.int16)


def luminance(rgb):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def canvas_slice(shape, rect):
    x, y, w, h = rect
    x0, y0 = int(round(x)), int(round(y))
    x1, y1 = int(round(x + w)), int(round(y + h))
    return (slice(max(0, y0), min(shape[0], y1)), slice(max(0, x0), min(shape[1], x1)))


def segments(rows_flag):
    """Contiguous True runs -> [(start, end_inclusive)]"""
    out = []
    start = None
    for i, f in enumerate(rows_flag):
        if f and start is None:
            start = i
        elif not f and start is not None:
            out.append((start, i - 1))
            start = None
    if start is not None:
        out.append((start, len(rows_flag) - 1))
    return out


def main(argv):
    on, off = load(argv[1]), load(argv[2])
    if on.shape != off.shape:
        raise SystemExit(f'size mismatch: {on.shape} vs {off.shape}')
    rect = None
    args = argv[3:]
    if '--rect' in args:
        rect = tuple(float(v) for v in args[args.index('--rect') + 1].split(','))

    sl = canvas_slice(on.shape, rect)
    lon = luminance(on[sl])
    loff = luminance(off[sl])
    diff = lon - loff  # per-row arrays of column-wise luma
    rows_mean_on = lon.mean(axis=1)
    rows_mean_off = loff.mean(axis=1)
    rows_diff = diff.mean(axis=1)
    rows_absmax = np.abs(diff).max(axis=1)
    n_cols = lon.shape[1]
    frac_masked = (np.abs(diff) > 3).mean(axis=1)  # share of columns over threshold

    # --- horizon row from the OFF frame (sea darker than sky at dusk) ---
    search = slice(220, 460)
    grad = np.abs(np.diff(rows_mean_off[search]))
    horizon_row = 220 + int(np.argmax(grad)) + 1

    # --- bands ---
    r7_lo, r7_hi = horizon_row - int(round(5 * PX_PER_DEG)), horizon_row + int(round(5 * PX_PER_DEG))
    r7 = slice(max(0, r7_lo), min(len(rows_diff), r7_hi))

    report = {
        'canvas_rows': int(lon.shape[0]),
        'canvas_cols': int(n_cols),
        'horizon_row': horizon_row,
        'horizon_row_luma_jump': float(grad.max()),
        'r7_band_rows': [int(r7_lo), int(r7_hi)],
        'r7_max_abs_diff': float(np.abs(rows_diff[r7]).max()),
        'r7_max_abs_diff_row': int(r7_lo + int(np.argmax(np.abs(rows_diff[r7])))),
        'r7_widest_90pct_run_px': max(
            (b - a + 1) for a, b in segments(frac_masked[r7] > 0.9)
        ) if any(frac_masked[r7] > 0.9) else 0,
    }

    # --- diff segments across the whole canvas (dome layer footprint) ---
    seg = [(int(a), int(b)) for a, b in segments((np.abs(rows_diff) > 3))]
    report['diff_segments_abs_gt3'] = seg
    seg90 = [(int(a), int(b)) for a, b in segments(frac_masked > 0.9)]
    report['diff_segments_90pct_width'] = seg90

    # per-segment detail
    detail = []
    for a, b in seg:
        detail.append({
            'rows': [a, b],
            'max_abs_diff': float(np.abs(rows_diff[a:b + 1]).max()),
            'mean_abs_diff': float(np.abs(rows_diff[a:b + 1]).mean()),
            'on_minus_off_sign': '+' if rows_diff[a:b + 1].mean() > 0 else '-',
            'frac_masked_peak': float(frac_masked[a:b + 1].max()),
        })
    report['segment_detail'] = detail

    # patch-band probe: rows 180..264 (predicted 9.5-16° band from y=66.8, pitch unknown)
    pb = slice(150, 300)
    report['patch_probe_rows_150_300'] = {
        'max_abs_diff': float(np.abs(rows_diff[pb]).max()),
        'rows_over_3': int((np.abs(rows_diff[pb]) > 3).sum()),
        'frac_masked_peak': float(frac_masked[pb].max()),
    }

    print(json.dumps(report, indent=1))


if __name__ == '__main__':
    main(sys.argv)
