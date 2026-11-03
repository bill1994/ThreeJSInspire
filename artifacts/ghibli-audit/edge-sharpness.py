"""How much edge sharpness does the post chain actually take from the clouds?

Compares a post-off capture with a post-on capture of the same pinned camera.
Only cloud pixels vote: each pixel must be within dE 10 of a band anchor derived
from `PUFF_BAND_COLORS` after the real tone map (sky and sea are far from those).

Reported per frame: the L* gradient magnitude on cloud pixels (1-pixel central
difference), and how many pixels carry a "hard" step (>= 6 L* per pixel, which is
most of a band edge — bands are ~7.5 L* apart).

A toon plateau should be flat inside and steep at the border: high p99, low
median. A blurred version loses both ends of that shape.
"""

import sys

from PIL import Image

X0, Y0, X1, Y1 = 583, 0, 1086, 893
BANDS = [0x6F618F, 0x826DA8, 0xC16E95, 0xC08C93]


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


def report(path: str) -> None:
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

    grads = []
    for y in range(Y0 + 1, y1 - 1):
        for x in range(X0 + 1, x1 - 1):
            if not is_cloud((x, y)):
                continue
            # central difference on L*, both axes, taking the stronger one
            gx = abs(lab[(x + 1, y)][0] - lab[(x - 1, y)][0]) / 2
            gy = abs(lab[(x, y + 1)][0] - lab[(x, y - 1)][0]) / 2
            grads.append(max(gx, gy))

    grads.sort()
    n = len(grads)
    if n == 0:
        print(f"{path}: no cloud pixels — INSUFFICIENT_EVIDENCE")
        return
    p = lambda q: grads[min(n - 1, int(q * n))]
    hard = sum(1 for g in grads if g >= 6.0) / n
    flat = sum(1 for g in grads if g <= 0.5) / n
    print(
        f"{path.split(chr(92))[-1]:22s} n={n:6d}  p50={p(0.5):5.2f}  p90={p(0.9):5.2f}  "
        f"p99={p(0.99):5.2f}  max={grads[-1]:5.2f}  flat<=0.5 {flat*100:4.1f}%  hard>=6 {hard*100:4.1f}%"
    )


for path in sys.argv[1:]:
    report(path)
