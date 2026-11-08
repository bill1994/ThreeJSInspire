"""Pixel measurements for the sea review. Read-only; prints a JSON table."""
import json
import os
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
FRAMES = [
    'H240-alt240', 'H120-alt120', 'H060-alt60', 'H060-post-on',
    'H020-alt20', 'H007-alt7', 'SKIM-dive7',
    'H020-debug', 'H020-sea-off', 'H007-grazing', 'H007-topdown',
    'MOTION-t3', 'MOTION-t5',
]


def load(name):
    return np.asarray(Image.open(os.path.join(HERE, name + '.png')).convert('RGB'), dtype=np.float32)


def luma(a):
    return a[..., 0] * 0.2126 + a[..., 1] * 0.7152 + a[..., 2] * 0.0722


def canvas_bounds(a):
    """Drop the dark side bars and return (x0, x1)."""
    col = luma(a).mean(axis=0)
    keep = np.where(col > 45)[0]
    return int(keep[0]), int(keep[-1] + 1)


def band_stats(y, x0, x1, lo, hi):
    h = y.shape[0]
    s = y[int(h * lo):int(h * hi), x0:x1]
    gx = np.abs(np.diff(s, axis=1)).mean()
    gy = np.abs(np.diff(s, axis=0)).mean()
    return dict(std=round(float(s.std()), 2), gx=round(float(gx), 3),
                gy=round(float(gy), 3), mean=round(float(s.mean()), 1))


def plane_span(a, x0, x1):
    """Wingtip-to-wingtip px from the sea-off frame (plane is the only dark object)."""
    sub = luma(a)[560:730, x0:x1]
    dark = sub < 105
    cols = np.where(dark.sum(axis=0) >= 2)[0]
    if len(cols) == 0:
        return None
    return int(cols[-1] - cols[0] + 1)


def run_lengths(row, tol=18):
    """Widths of constant-colour runs along a scanline (debug false-colour lobes)."""
    changes = np.where(np.abs(np.diff(row)) > tol)[0]
    edges = np.r_[0, changes + 1, len(row)]
    return [int(b - a) for a, b in zip(edges[:-1], edges[1:]) if b - a >= 8]


def row_stripes(y, x0, x1, lo, hi, threshold=3.0):
    """Count strong horizontal edges in a band (wave stripes near the horizon)."""
    band = y[int(y.shape[0] * lo):int(y.shape[0] * hi), x0:x1]
    prof = band.mean(axis=1)
    d = np.abs(np.diff(prof))
    return int((d > threshold).sum())


out = {}
for name in FRAMES:
    p = os.path.join(HERE, name + '.png')
    if not os.path.exists(p):
        continue
    a = load(name)
    y = luma(a)
    x0, x1 = canvas_bounds(a)
    entry = dict(size=[a.shape[1], a.shape[0]], canvas_x=[x0, x1], canvas_w=x1 - x0)
    for tag, lo, hi in [('far', 0.40, 0.50), ('mid', 0.50, 0.70), ('near', 0.70, 0.97)]:
        entry[tag] = band_stats(y, x0, x1, lo, hi)
    entry['stripes_far'] = row_stripes(y, x0, x1, 0.40, 0.52, 3.0)
    entry['stripes_near'] = row_stripes(y, x0, x1, 0.70, 0.97, 3.0)
    if name == 'H020-sea-off':
        entry['plane_span_px'] = plane_span(a, x0, x1)
    if name == 'H020-debug':
        scan = a[int(a.shape[0] * 0.62), x0:x1, 2]  # blue channel separates false-colour bands
        entry['debug_lobe_widths_px'] = run_lengths(scan)
    out[name] = entry

# Motion pair: how much of the frame actually changed between t=3 and t=5.
if 'MOTION-t3' in out and 'MOTION-t5' in out:
    a, b = load('MOTION-t3'), load('MOTION-t5')
    d = np.abs(luma(a) - luma(b))
    x0, x1 = canvas_bounds(a)
    sea = d[int(a.shape[0] * 0.5):, x0:x1]
    out['MOTION-diff'] = dict(
        mean_abs=round(float(sea.mean()), 2),
        p95=round(float(np.percentile(sea, 95)), 2),
        pct_gt_10=round(float((sea > 10).mean() * 100), 2),
        pct_gt_30=round(float((sea > 30).mean() * 100), 2),
    )

print(json.dumps(out, indent=2))
with open(os.path.join(HERE, 'measurements.json'), 'w', encoding='utf-8') as f:
    json.dump(out, f, indent=2)
