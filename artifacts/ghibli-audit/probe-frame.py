"""Validate a capture before any number is taken from it, then report the probes.

The previous run measured "sky L* 7.3" and the solver happily built a ramp from it —
that number was the page background (#1a1030), i.e. a frame whose canvas had not
rendered yet. A measurement is only an input if the frame it came from is proven to
contain the scene.

This script proves it: a probe grid with L*/a*/b*, plus the cloud crop's own stats,
and a hard FAIL when the frame looks like a flat background.
"""

import sys
from statistics import median

from PIL import Image

shot, cx, cy, rad = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])


def srgb_to_linear(v):
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def rgb_to_lab(rgb):
    r, g, b = (srgb_to_linear(c) for c in rgb)
    x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b
    y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b
    z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b
    w = (0.95047, 1.0, 1.08883)

    def f(t):
        return t ** (1 / 3) if t > 216 / 24389 else (841 / 108) * t + 4 / 29

    fx, fy, fz = f(x / w[0]), f(y / w[1]), f(z / w[2])
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)


img = Image.open(shot).convert("RGB")
px = img.load()
W, H = img.size
print(f"frame {W}x{H}")

print("\nprobe grid (L*, a*, b*):")
for gy in range(60, H - 40, 90):
    row = []
    for gx in range(600, 1080, 80):
        r, g, b = px[gx, gy]
        l, a, bb = rgb_to_lab((r / 255, g / 255, b / 255))
        row.append(f"({gx},{gy}) #{r:02X}{g:02X}{b:02X} L{l:5.1f} a{a:+5.1f} b{bb:+5.1f}")
    print("  " + " | ".join(row))

# --- cloud crop ---------------------------------------------------------------
inner = 0.7
crop = []
for y in range(max(0, int(cy - rad * inner)), min(H, int(cy + rad * inner))):
    for x in range(max(0, int(cx - rad * inner)), min(W, int(cx + rad * inner))):
        if (x - cx) ** 2 + (y - cy) ** 2 <= (rad * inner) ** 2:
            crop.append(px[x, y])

labs = [rgb_to_lab(tuple(c / 255 for c in s)) for s in crop]
ls = sorted(c[0] for c in labs)
print(f"\ncloud crop: {len(crop)} px at ({cx},{cy}) r={rad} (inner {inner})")
print(f"  L* min/med/max : {ls[0]:.1f} / {median(ls):.1f} / {ls[-1]:.1f}")
print(f"  L* spread      : {ls[-1] - ls[0]:.1f}")

# --- frame sanity -------------------------------------------------------------
span = ls[-1] - ls[0]
corner = rgb_to_lab(tuple(c / 255 for c in px[20, 20]))
if span < 3.0 and abs(corner[0] - median(ls)) < 3.0:
    print("\nVERDICT: FAIL — crop matches the page background; the canvas did not render.")
    raise SystemExit(2)
print("\nVERDICT: OK — the crop carries real rendered variance.")
