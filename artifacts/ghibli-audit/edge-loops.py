"""Count how many separate hard-edge loops a cloud shows — the "balloon" test.

The artefact under test:每个瓣在轮廓处法线转向，把自己那一档推过阈值，于是每颗球
镶一圈硬边，整朵云读成一堆气球（650 m 实拍）。

Why not just "hard-edge pixel count": a correct four-band cloud legitimately contains
band boundaries, which are also hard edges. The difference is *topology* — a clean
cloud has a few long boundaries (large connected components), a balloon cloud has one
small closed loop per lobe (many small components).

Gate, fixed before looking: small loops (<200 px) must not exceed one per lobe on
screen, i.e. the count must fall well below the baseline, while the largest component
(an outer silhouette or a band boundary) must not collapse.
"""

import sys
from collections import deque

from PIL import Image

X0, Y0, X1, Y1 = 583, 0, 1086, 893
BANDS = [0x6F618F, 0x826DA8, 0xC16E95, 0xC08C93]
HARD = 6.0       # L* per pixel: most of a 7.5 L* band step
SMALL = 200      # px: a lobe loop, not a band boundary


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


def report(path):
    img = Image.open(path).convert("RGB")
    px = img.load()
    W, H = img.size
    x1, y1 = min(X1, W), min(Y1, H)

    lab = {}
    for y in range(Y0, y1):
        for x in range(X0, x1):
            lab[(x, y)] = to_lab(tuple(c / 255 for c in px[x, y]))

    def is_cloud(p):
        l = lab.get(p)
        if l is None:
            return False
        return min(sum((l[j] - a[j]) ** 2 for j in range(3)) ** 0.5 for a in ANCHORS) <= 10.0

    cloud = {p for p in lab if is_cloud(p)}
    if not cloud:
        print(f"{path}: no cloud px")
        return

    edge = set()
    for (x, y) in cloud:
        if (x - 1, y) not in lab or (x + 1, y) not in lab:
            continue
        if (x, y - 1) not in lab or (x, y + 1) not in lab:
            continue
        gx = abs(lab[(x + 1, y)][0] - lab[(x - 1, y)][0]) / 2
        gy = abs(lab[(x, y + 1)][0] - lab[(x, y - 1)][0]) / 2
        if max(gx, gy) >= HARD:
            edge.add((x, y))

    seen = set()
    comps = []
    for seed in edge:
        if seed in seen:
            continue
        q = deque([seed])
        seen.add(seed)
        n = 0
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
    small = [c for c in comps if c < SMALL]
    print(
        f"{path.split(chr(92))[-1]:22s} cloud={len(cloud):6d}  edge={len(edge):6d} "
        f"({len(edge)/len(cloud)*100:4.1f}%)  comps={len(comps):3d}  "
        f"small<{SMALL}={len(small):3d}  largest={comps[0] if comps else 0:5d}  "
        f"median={sorted(comps)[len(comps)//2] if comps else 0:4d}"
    )


for p in sys.argv[1:]:
    report(p)
