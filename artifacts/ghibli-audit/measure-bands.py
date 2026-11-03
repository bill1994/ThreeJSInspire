"""Measure how many *separable* toon plateaus a rendered puff cloud actually shows.

Claim: "the cluster cloud renders as four flat tones, evenly stepped".
Gate (fixed before looking): >=4 clusters, each >=4% of the crop, adjacent
clusters >=5 L* apart, and the set's span <= 30 L* (a wider span is the old
"dark blob + white rim" failure, not a ghibli ramp).

Every number is our own capture: sRGB8 pixels, L* computed with the D65 white
point. No reference image is compared here; the reference only supplied the rule
(even steps ~7.5 L*) that step 4 of the solve locked into the palette.
"""

import sys
from collections import Counter

from PIL import Image

shot, cx, cy, rad = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
inner = float(sys.argv[5]) if len(sys.argv) > 5 else 0.70


def srgb_to_linear(v):
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def lstar(r, g, b):
    y = (
        0.2126729 * srgb_to_linear(r / 255)
        + 0.7151522 * srgb_to_linear(g / 255)
        + 0.0721750 * srgb_to_linear(b / 255)
    )
    fy = y ** (1 / 3) if y > 216 / 24389 else (841 / 108) * y + 4 / 29
    return 116 * fy - 16


img = Image.open(shot).convert("RGB")
px = img.load()
W, H = img.size

r_in = rad * inner
crop = []
for y in range(max(0, int(cy - r_in)), min(H, int(cy + r_in))):
    for x in range(max(0, int(cx - r_in)), min(W, int(cx + r_in))):
        if (x - cx) ** 2 + (y - cy) ** 2 <= r_in * r_in:
            crop.append(px[x, y])

total = len(crop)
bins = Counter((r >> 4, g >> 4, b >> 4) for r, g, b in crop)


def near(a, b):
    return sum(abs(a[i] - b[i]) for i in range(3)) <= 1


clusters = []
for key, n in bins.most_common():
    for c in clusters:
        if near(c["bin"], key):
            c["n"] += n
            break
    else:
        clusters.append({"bin": key, "n": n})
clusters.sort(key=lambda c: -c["n"])

print(f"crop {total} px at ({cx},{cy}) r={r_in:.0f}")
print("\nclusters >=1%:")
rows = []
for c in clusters:
    share = c["n"] / total
    if share < 0.01:
        continue
    r, g, b = (v * 16 + 8 for v in c["bin"])
    l = lstar(r, g, b)
    rows.append((share, r, g, b, l))
    print(f"  {share*100:5.1f}%  #{r:02X}{g:02X}{b:02X}  L* {l:5.1f}")

plates = [r for r in rows if r[0] >= 0.04]
ls = sorted(r[4] for r in plates)
steps = [round(ls[i + 1] - ls[i], 1) for i in range(len(ls) - 1)]
separable = sum(1 for s in steps if s >= 5.0)
span = ls[-1] - ls[0] if ls else 0.0

print(f"\nplateaus >=4%      : {len(plates)}")
print(f"their L* sorted    : {[round(v,1) for v in ls]}")
print(f"adjacent steps     : {steps}")
print(f"steps >=5 L*       : {separable}")
print(f"span               : {span:.1f} L*")

ok = len(plates) >= 4 and separable >= 3 and span <= 30
print(f"\nVERDICT: {'PASS' if ok else 'FAIL'}  "
      f"(need >=4 plateaus, >=3 separable steps, span <=30)")
raise SystemExit(0 if ok else 1)
