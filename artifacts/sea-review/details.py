"""Secondary measurements: hard boundaries, wake width, horizon stripe spacing."""
import json
import os
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))


def luma(name):
    a = np.asarray(Image.open(os.path.join(HERE, name + '.png')).convert('RGB'), dtype=np.float32)
    return a, a[..., 0] * 0.2126 + a[..., 1] * 0.7152 + a[..., 2] * 0.0722


def bounds(y):
    keep = np.where(y.mean(axis=0) > 45)[0]
    return int(keep[0]), int(keep[-1] + 1)


out = {}
for name in ['MOTION-t3', 'MOTION-t5', 'H007-topdown', 'H020-debug', 'H060-alt60', 'H007-alt7']:
    if not os.path.exists(os.path.join(HERE, name + '.png')):
        continue
    _, y = luma(name)
    x0, x1 = bounds(y)
    prof = y[:, x0:x1].mean(axis=1)
    d = np.abs(np.diff(prof))
    # strongest horizontal boundaries below the horizon
    below = d[int(y.shape[0] * 0.40):]
    top = np.argsort(below)[-6:][::-1] + int(y.shape[0] * 0.40)
    out[name] = {
        'canvas': [x0, x1, y.shape[0]],
        'strongest_rows': [int(t) for t in top[:6]],
        'strongest_edges': [round(float(d[t]), 2) for t in top[:6]],
        'edge_at_row': {str(int(t)): round(float(d[t]), 2) for t in top[:3]},
    }

# horizon stripe spacing: count sign changes of row profile in the far band
for name in ['H240-alt240', 'H060-alt60', 'H007-alt7', 'H007-grazing']:
    _, y = luma(name)
    x0, x1 = bounds(y)
    p = y[int(y.shape[0] * 0.40):int(y.shape[0] * 0.50), x0:x1].mean(axis=1)
    dp = np.diff(p)
    peaks = np.where(np.abs(dp) > 3.0)[0]
    out.setdefault(name, {})['far_stripe_edges'] = len(peaks)
    if len(peaks) > 1:
        out[name]['far_stripe_median_gap_px'] = round(float(np.median(np.diff(peaks))), 1)

# wake ribbon width at a few scanlines (H007-alt7)
a, y = luma('H007-alt7')
x0, x1 = bounds(y)
for row in [900, 1050, 1200]:
    line = a[row, x0:x1]
    # the wake is a desaturated grey column against blue water
    sat = line.max(axis=1) - line.min(axis=1)
    grey = (sat < 25) & (y[row, x0:x1] > 65) & (y[row, x0:x1] < 140)
    cols = np.where(grey)[0]
    out.setdefault('H007-alt7', {})['wake_width_px_row' + str(row)] = int(cols[-1] - cols[0] + 1) if len(cols) else None

print(json.dumps(out, indent=2))
with open(os.path.join(HERE, 'details.json'), 'w', encoding='utf-8') as f:
    json.dump(out, f, indent=2)
