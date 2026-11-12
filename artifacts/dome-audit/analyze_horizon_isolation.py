"""DOME-01 gate, isolation caliber — the only caliber that measures the patch.

WHY THIS REPLACES analyze_horizon.py FOR DOME-01
-----------------------------------------------
The committed gate compared `?dome=1` against `?dome=0&puff=0`. That pair turns
off the whole cloud deck together with the patch ring, and in the patch band the
two contributions have OPPOSITE signs:

    deck   +11.8  (on-frame is brighter)
    patch  -6.59  (on-frame is darker)
    net    +5.21  <- what the old gate actually measured

So the old criterion (`|on - off| > 20`) can never isolate the patch: making the
patch darker pushes the net *toward* zero. The probe band (rows 150-300) also
sat above the patch (screen rows ~105-165) and underneath the HUD panel, whose
label differs between the two pages (`AUDIO: LIVE` vs `AUDIO: TAP TO ENABLE`).

This analyzer instead takes the isolation pair: SAME page, SAME pose, SAME
elapsed time, with only `dome-horizon.visible` toggled in memory. Deck, HUD and
sky are then bit-identical, so the difference IS the patch ring.

Horizon detection uses the row-variance minimum on a central column band: the
summated sky has near-zero horizontal variance, the sea explodes into texture.
The old `max |d luma/d row|` detector locked onto a *sea texture edge* at row
~393 (98 px below the real waterline) and dragged the probe band with it.

Usage:
  python -I analyze_horizon_isolation.py on.png hidden.png
      [--rect x,y,w,h]        canvas rect inside a full-page frame (default: whole image)
      [--band-deg 9.7,16.3]   patch band in degrees above the horizon (design values)
      [--gate 20]             row-mean threshold to judge
"""
import json
import sys

import numpy as np
from PIL import Image

FOV_Y_DEG = 60.0            # camera.projectionMatrix-derived, not assumed
DEFAULT_BAND = (9.7, 16.3)  # spec: patch sits 9.7-16.3 deg above the waterline
HARD_LIMIT_ROW = 3.0        # per-pixel "this cell changed" threshold


def load(path):
    return np.asarray(Image.open(path).convert('RGB')).astype(np.float64)


def luminance(rgb):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def canvas_slice(shape, rect):
    if rect is None:
        return (slice(0, shape[0]), slice(0, shape[1]))
    x, y, w, h = rect
    x0, y0 = int(round(x)), int(round(y))
    x1, y1 = int(round(x + w)), int(round(y + h))
    return (slice(max(0, y0), min(shape[0], y1)), slice(max(0, x0), min(shape[1], x1)))


def mean(values):
    return float(np.mean(values)) if len(values) else 0.0


def segments(flags):
    out, start = [], None
    for i, f in enumerate(flags):
        if f and start is None:
            start = i
        elif not f and start is not None:
            out.append((start, i - 1))
            start = None
    if start is not None:
        out.append((start, len(flags) - 1))
    return out


def detect_horizon(luma_img):
    """Row-variance minimum on the central 50% of columns.

    Summated sky is horizontally flat (variance ~10-30); the sea carries wave
    texture (variance 60-400). The minimum on the sky side is the waterline.
    The central band avoids the HUD panel (right) and the speed ring (left).
    """
    cols = luma_img.shape[1]
    core = luma_img[:, int(0.25 * cols):int(0.75 * cols)]
    var = np.convolve(core.var(axis=1), np.ones(5) / 5, mode='same')
    lo = max(0, int(0.26 * luma_img.shape[0]))
    hi = min(len(var), int(0.55 * luma_img.shape[0]))
    return lo + int(np.argmin(var[lo:hi]))


def hud_check(diff, rows):
    """Same-page isolation must leave the HUD bit-identical.

    If this is not ~0 the capture was not a true isolation pair and the whole
    measurement is void.
    """
    h, w = diff.shape
    panel = diff[max(0, int(0.09 * h)):min(h, int(0.30 * h)),
                 int(0.47 * w):w]
    band = diff[rows[0]:rows[1], int(0.47 * w):w]
    return {
        'panel_region': [int(0.09 * h), int(0.30 * h), int(0.47 * w), int(w)],
        'panel_mean_abs': round(float(np.abs(panel).mean()), 4) if panel.size else None,
        'band_over_panel_mean_abs': round(float(np.abs(band).mean()), 4) if band.size else None,
        'verdict': 'clean' if panel.size and float(np.abs(panel).mean()) < 0.5 else 'LEAKY — not a true isolation pair',
    }


def main(argv):
    on, hidden = load(argv[1]), load(argv[2])
    if on.shape != hidden.shape:
        raise SystemExit(f'size mismatch: {on.shape} vs {hidden.shape}')

    rect = None
    band_deg = DEFAULT_BAND
    gate = 20.0
    args = argv[3:]
    if '--rect' in args:
        rect = tuple(float(v) for v in args[args.index('--rect') + 1].split(','))
    if '--band-deg' in args:
        band_deg = tuple(float(v) for v in args[args.index('--band-deg') + 1].split(','))
    if '--gate' in args:
        gate = float(args[args.index('--gate') + 1])

    sl = canvas_slice(on.shape, rect)
    on_c, hid_c = on[sl], hidden[sl]
    lon, lhid = luminance(on_c), luminance(hid_c)
    diff = lon - lhid                      # signed luma, 8-bit units

    h_px, w_px = lon.shape
    ppd = h_px / FOV_Y_DEG                 # px per degree, derived from canvas height
    horizon = detect_horizon(lon)

    band_lo = max(0, horizon - int(round(band_deg[1] * ppd)))
    band_hi = min(h_px, horizon - int(round(band_deg[0] * ppd)))
    if band_hi <= band_lo:
        raise SystemExit(f'empty band: rows {band_lo}..{band_hi} (horizon {horizon})')

    rows = (band_lo, band_hi)
    band = diff[band_lo:band_hi]
    absd = np.abs(band)

    row_mean_abs = np.abs(band.mean(axis=1))
    row_mean_peak = float(row_mean_abs.max())
    row_mean_peak_row = band_lo + int(np.argmax(row_mean_abs))

    # Where the patch actually lands on screen (per-pixel footprint).
    rows_changed = np.where((absd > HARD_LIMIT_ROW).any(axis=1))[0]
    cols_changed = np.where((absd > HARD_LIMIT_ROW).any(axis=0))[0]
    footprint = {
        'rows': [int(rows_changed.min()) + band_lo, int(rows_changed.max()) + band_lo] if len(rows_changed) else None,
        'cols': [int(cols_changed.min()), int(cols_changed.max())] if len(cols_changed) else None,
        'pixels_over_3': int((absd > HARD_LIMIT_ROW).sum()),
        'pixels_total': int(absd.size),
        'area_pct_of_band': round(float((absd > HARD_LIMIT_ROW).mean()) * 100, 3),
    }

    report = {
        'caliber': 'isolation — same page/pose/elapsed, only dome-horizon.visible toggled in memory',
        'canvas': [int(w_px), int(h_px)],
        'fov_y_deg': FOV_Y_DEG,
        'px_per_deg': round(ppd, 3),
        'horizon_row': int(horizon),
        'horizon_detector': 'row-variance minimum on central 50% columns',
        'patch_band_deg': [band_deg[0], band_deg[1]],
        'patch_band_rows': [int(band_lo), int(band_hi)],
        'row_mean': {
            'max_abs_diff': round(row_mean_peak, 3),
            'at_row': int(row_mean_peak_row),
            'rows_over_3': int((row_mean_abs > 3).sum()),
            'rows_over_gate': int((row_mean_abs > gate).sum()),
            'gate': gate,
        },
        'per_pixel': {
            'max_abs_diff': round(float(absd.max()), 3),
            'p99_abs_diff': round(float(np.percentile(absd, 99)), 3),
            'mean_abs_diff': round(float(absd.mean()), 3),
            'sign': '+' if float(band.mean()) > 0 else '-',
            'band_mean': round(float(band.mean()), 3),
        },
        'footprint': footprint,
        'hud_isolation': hud_check(diff, rows),
        'verdict': 'PASS' if row_mean_peak > gate else 'FAIL',
    }
    print(json.dumps(report, indent=1))


if __name__ == '__main__':
    main(sys.argv)
