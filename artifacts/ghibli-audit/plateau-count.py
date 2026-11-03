"""Count flat colour plateaus inside one puff cloud in a real capture.

Claim: "the puff material renders as a small set of flat toon plateaus".
Falsifier: the crop shows a continuum (hundreds of distinct colours) instead of
a handful of dominant clusters.

Native domain: sRGB8 pixels from the browser capture. No renderer claim is made
here beyond what the frame itself shows. The screenshot is CSS pixels; the crop
rect came from the live camera projection in the same (pinned) frame.
"""

import sys
from collections import Counter

from PIL import Image

path = sys.argv[1]
cx, cy, rad = int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
inner = 0.70  # keep inside the silhouette; the rim bleeds into sky at 1.0

img = Image.open(path).convert("RGB")
px = img.load()
w, h = img.size

r_in = rad * inner
crop = []
for y in range(max(0, int(cy - r_in)), min(h, int(cy + r_in))):
    for x in range(max(0, int(cx - r_in)), min(w, int(cx + r_in))):
        if (x - cx) ** 2 + (y - cy) ** 2 <= r_in * r_in:
            crop.append(px[x, y])

total = len(crop)
if total == 0:
    print("empty crop")
    raise SystemExit(1)

# Quantise to 16 levels per channel: a flat toon plateau collapses to one bin,
# a gradient keeps spreading across many.
bins = Counter((r >> 4, g >> 4, b >> 4) for r, g, b in crop)

# Merge neighbour bins so anti-aliased edges and the quantiser do not invent clusters.
def near(a, b):
    return sum(abs(a[i] - b[i]) for i in range(3)) <= 1

clusters = []
for b, n in bins.most_common():
    for c in clusters:
        if near(c["bin"], b):
            c["n"] += n
            break
    else:
        clusters.append({"bin": b, "n": n})

clusters.sort(key=lambda c: -c["n"])
print(f"crop pixels        : {total}")
print(f"distinct 16-bit RGB bins : {len(bins)}")
print(f"merged clusters          : {len(clusters)}")
print("\ntop clusters (>=2% of crop):")
shown = 0
for c in clusters:
    share = c["n"] / total
    if share < 0.02:
        break
    shown += 1
    r, g, b = (v * 16 + 8 for v in c["bin"])
    print(f"  {share*100:5.1f}%  #{r:02X}{g:02X}{b:02X}")
print(f"\nplateaus >=2%            : {shown}")
print(f"plateaus >=5%            : {sum(1 for c in clusters if c['n']/total >= 0.05)}")
cover = sum(c["n"] for c in clusters[:shown]) / total
print(f"coverage of those plateaus: {cover*100:.1f}%")
