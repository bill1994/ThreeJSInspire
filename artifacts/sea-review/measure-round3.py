"""Round-3 pixel measurements (fine-octave plan Task 4 Step 2).

Same band definitions and thresholds as measure.py (round-1/round-2 geometry:
far 0.40-0.50, mid 0.50-0.70, near 0.70-0.97 of canvas height; row_stripes =
count of rows whose mean-gradient exceeds 3). Reads the round3- prefixed
frames, writes measurements-round3.json — does NOT touch the round-1 file.

Usage: python artifacts/sea-review/measure-round3.py
"""
import json
import os
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
FRAMES = [
    'round3-H240-alt240', 'round3-H120-alt120', 'round3-H060-alt60',
    'round3-H020-alt20', 'round3-H007-alt7', 'round3-SKIM-dive7',
    'round3-H007-grazing', 'round3-H007-nochop', 'round3-H020-nochop',
    'round3-H007-lowtier',
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
    band = y[int(h * lo):int(h * hi), x0:x1]
    gy, gx = np.gradient(band)
    return {
        'std': round(float(band.std()), 2),
        'gx': round(float(np.abs(gx).mean()), 3),
        'gy': round(float(np.abs(gy).mean()), 3),
        'mean': round(float(band.mean()), 1),
    }


def row_stripes(y, x0, x1, lo, hi, threshold=3.0):
    h = y.shape[0]
    band = y[int(h * lo):int(h * hi), x0:x1]
    prof = band.mean(axis=1)
    d = np.abs(np.diff(prof))
    return int((d > threshold).sum())


out = {}
for name in FRAMES:
    p = os.path.join(HERE, name + '.png')
    if not os.path.exists(p):
        out[name] = {'missing': True}
        continue
    a = load(name)
    y = luma(a)
    x0, x1 = canvas_bounds(a)
    entry = dict(size=[a.shape[1], a.shape[0]], canvas_x=[x0, x1], canvas_w=x1 - x0)
    for tag, lo, hi in [('far', 0.40, 0.50), ('mid', 0.50, 0.70), ('near', 0.70, 0.97)]:
        entry[tag] = band_stats(y, x0, x1, lo, hi)
    entry['stripes_far'] = row_stripes(y, x0, x1, 0.40, 0.52, 3.0)
    entry['stripes_near'] = row_stripes(y, x0, x1, 0.70, 0.97, 3.0)
    out[name] = entry

print(json.dumps(out, indent=2))
with open(os.path.join(HERE, 'measurements-round3.json'), 'w', encoding='utf-8') as f:
    json.dump(out, f, indent=2)
