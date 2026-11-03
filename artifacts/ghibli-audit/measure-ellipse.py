"""Band coverage and edge-loop count measured *inside* the projected cloud blobs.

The whole-canvas classifier was contaminated: the sky's own rose band sits within
dE 10 of the cloud ramp (measured earlier: #c96a8f differs from band 2 by 0.0005 in
luminance), so 59% of the canvas was being counted as "cloud". Any coverage number
taken that way is worthless.

This version only samples inside ellipses built from the live camera projection of
each puff blob (0.85 of the projected radius, so the silhouette edge and the sky
behind it stay out). Circles come from the page as JSON: [{x,y,rx,ry}, ...].
"""

import json
import sys
from collections import deque

from PIL import Image

shot, circles_file = sys.argv[1], sys.argv[2]
circles = json.load(open(circles_file, encoding="utf-8"))
BANDS = [0x6F618F, 0x826DA8, 0xC16E95, 0xC08C93]
HARD = 6.0
SMALL = 200
INNER = 0.85


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
    lin = [srgb_to_linear(((hex_rgb >> s) & 255) / 255) for s in (16, 8, 0)]
    x = min(lin)
    off = x - 6.25 * x * x if x < 0.08 else 0.04
    return tuple(linear_to_srgb(max(0.0, v - off)) for v in lin)


ANCHORS = [to_lab(rendered(h)) for h in BANDS]

img = Image.open(shot).convert("RGB")
px = img.load()
W, H = img.size

inside = set()
for c in circles:
    for y in range(max(0, int(c["y"] - c["ry"] * INNER)), min(H, int(c["y"] + c["ry"] * INNER))):
        for x in range(max(0, int(c["x"] - c["rx"] * INNER)), min(W, int(c["x"] + c["rx"] * INNER))):
            if ((x - c["x"]) / (c["rx"] * INNER)) ** 2 + ((y - c["y"]) / (c["ry"] * INNER)) ** 2 <= 1.0:
                inside.add((x, y))

lab = {p: to_lab(tuple(v / 255 for v in px[p])) for p in inside}


def nearest(p):
    l = lab[p]
    best, bd = -1, 9e9
    for i, a in enumerate(ANCHORS):
        d = sum((l[j] - a[j]) ** 2 for j in range(3)) ** 0.5
        if d < bd:
            best, bd = i, d
    return best, bd


counts = [0] * 4
cloud = set()
for p in inside:
    i, d = nearest(p)
    if d <= 10.0:
        counts[i] += 1
        cloud.add(p)

print(f"sampled {len(inside)} px inside {len(circles)} blob ellipse(s)")
if not cloud:
    print("VERDICT: INSUFFICIENT_EVIDENCE")
    raise SystemExit(2)

total = len(cloud)
print(f"cloud-classified: {total} px ({total/len(inside)*100:.1f}% of the ellipses)")
present = []
print("\nband  share   L*")
for i, c in enumerate(counts):
    share = c / total
    mark = ""
    if share >= 0.04:
        present.append((i, ANCHORS[i][0]))
        mark = "  <- present"
    print(f"  {i}  {share*100:5.1f}%  {ANCHORS[i][0]:5.1f}{mark}")

edge = set()
for (x, y) in cloud:
    if (x - 1, y) in lab and (x + 1, y) in lab and (x, y - 1) in lab and (x, y + 1) in lab:
        gx = abs(lab[(x + 1, y)][0] - lab[(x - 1, y)][0]) / 2
        gy = abs(lab[(x, y + 1)][0] - lab[(x, y - 1)][0]) / 2
        if max(gx, gy) >= HARD:
            edge.add((x, y))

seen, comps = set(), []
for seed in edge:
    if seed in seen:
        continue
    q, n = deque([seed]), 0
    seen.add(seed)
    while q:
        cx, cy = q.popleft()
        n += 1
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            p = (cx + dx, cy + dy)
            if p in edge and p not in seen:
                seen.add(p)
                q.append(p)
    comps.append(n)

comps.sort(reverse=True)
print(f"\nhard-edge px: {len(edge)} ({len(edge)/total*100:.1f}% of cloud px)")
print(f"edge components: {len(comps)}  small<{SMALL}: {sum(1 for c in comps if c < SMALL)}  largest: {comps[0] if comps else 0}")
print(f"\nbands present: {len(present)}")
print("VERDICT:", "PASS" if len(present) >= 3 else "FAIL")
