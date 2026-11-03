"""Classify every cloud pixel in the frame against the four band anchors.

A 90 px crop only proves what one lobe shows — it landed 98% inside band 0 and the
verdict said "FAIL" for a reason that had nothing to do with the cloud. This script
measures the whole silhouette: each canvas pixel is assigned to the nearest band
anchor (CIE76 dE <= 10) using anchors *derived from the shipped constants* after the
real tone map, so the classes are the bands the shader can actually produce.

Reported: per-band coverage, which bands are present, and the L* steps between the
present ones. Sky (b* +40, warm) and sea (L* ~20) sit outside dE 10 of every anchor,
so they do not vote.
"""

import sys

from PIL import Image

shot = sys.argv[1]
x0, y0, x1, y1 = (int(v) for v in sys.argv[2:6])
BANDS = [0x6F618F, 0x826DA8, 0xC16E95, 0xC08C93]   # = PUFF_BAND_COLORS


def srgb_to_linear(v):
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def linear_to_srgb(v):
    v = min(max(v, 0.0), 1.0)
    return v * 12.92 if v <= 0.0031308 else 1.055 * (v ** (1 / 2.4)) - 0.055


def to_lab(rgb):
    r, g, b = (srgb_to_linear(c) for c in rgb)
    x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b
    y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b
    z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b
    w = (0.95047, 1.0, 1.08883)

    def f(t):
        return t ** (1 / 3) if t > 216 / 24389 else (841 / 108) * t + 4 / 29

    fx, fy, fz = f(x / w[0]), f(y / w[1]), f(z / w[2])
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)


def rendered(hex_rgb):
    """What the screen shows for a material colour under NeutralToneMapping."""
    lin = [srgb_to_linear(((hex_rgb >> s) & 255) / 255) for s in (16, 8, 0)]
    x = min(lin)
    off = x - 6.25 * x * x if x < 0.08 else 0.04
    return tuple(linear_to_srgb(max(0.0, v - off)) for v in lin)


anchors = []
for h in BANDS:
    rgb = rendered(h)
    anchors.append((h, to_lab(rgb), rgb))

print("anchors (material hex -> rendered sRGB, L*):")
for h, lab, rgb in anchors:
    print(f"  #{h:06X} -> #{round(rgb[0]*255):02X}{round(rgb[1]*255):02X}{round(rgb[2]*255):02X}  L* {lab[0]:5.1f}")

img = Image.open(shot).convert("RGB")
px = img.load()
W, H = img.size
x1, y1 = min(x1, W), min(y1, H)

counts = [0] * len(anchors)
hits = 0
for y in range(y0, y1, 2):
    for x in range(x0, x1, 2):
        lab = to_lab(tuple(c / 255 for c in px[x, y]))
        best, best_d = None, 1e9
        for i, (_, alab, _) in enumerate(anchors):
            d = sum((lab[j] - alab[j]) ** 2 for j in range(3)) ** 0.5
            if d < best_d:
                best, best_d = i, d
        if best_d <= 10.0:
            counts[best] += 1
            hits += 1

print(f"\nclassified pixels: {hits}")
if hits == 0:
    print("VERDICT: INSUFFICIENT_EVIDENCE — no pixel within dE 10 of any band")
    raise SystemExit(2)

present = []
print("\nband  share   rendered L*")
for i, c in enumerate(counts):
    share = c / hits
    mark = ""
    if share >= 0.04:
        present.append(anchors[i][1][0])
        mark = "  <- present"
    print(f"  {i}  {share*100:5.1f}%   {anchors[i][1][0]:5.1f}{mark}")

ls = sorted(present)
steps = [round(ls[i + 1] - ls[i], 1) for i in range(len(ls) - 1)]
print(f"\nbands present (>=4%): {len(present)}")
print(f"L* of those         : {[round(v,1) for v in ls]}")
print(f"steps               : {steps}")
ok = len(present) >= 3 and sum(1 for s in steps if s >= 5.0) >= 2
print(f"\nVERDICT: {'PASS' if ok else 'FAIL'}  (need >=3 bands present, >=2 steps >=5 L*)")
raise SystemExit(0 if ok else 1)
