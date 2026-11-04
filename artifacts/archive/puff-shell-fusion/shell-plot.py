"""把 shell-probe.mjs --dump 的半径曲线画成对比图。

只依赖 numpy + Pillow（遵守 artifacts/cloud-audit/requirements.txt 的纪律）。
左列：极坐标轮廓（硬并集 vs 融合）。右列：半径随角度，折痕在硬并集上是尖角。

用法: python artifacts/archive/puff-shell-fusion/shell-plot.py
"""

import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
VARIANTS = ["bank", "tower", "scraps", "leviathan"]

PANEL_W, PANEL_H = 560, 320
COLS, ROWS = 2, len(VARIANTS)
PAD = 12
W = COLS * PANEL_W + PAD * (COLS + 1)
H = ROWS * PANEL_H + PAD * (ROWS + 1)

BG = (18, 18, 24)
HARD = (120, 120, 140)
SOFT = (255, 176, 120)
AXIS = (60, 60, 72)
TEXT = (200, 200, 210)


def draw_polar(d: ImageDraw.ImageDraw, box, curve, title):
    x0, y0, x1, y1 = box
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    span = min(x1 - x0, y1 - y0) / 2 - 18
    rmax = max(max(curve["hard"]), max(curve["soft"])) * 1.06
    scale = span / rmax

    d.rectangle(box, outline=AXIS)
    d.text((x0 + 6, y0 + 4), title, fill=TEXT)
    # 参考圆
    for frac in (0.5, 1.0):
        rr = rmax * frac * scale
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=AXIS)

    n = len(curve["hard"])
    for key, color, dash in (("hard", HARD, 3), ("soft", SOFT, 0)):
        pts = []
        for i in range(n):
            a = (i / n) * 2 * np.pi
            r = curve[key][i] * scale
            pts.append((cx + r * np.cos(a), cy + r * np.sin(a)))
        if dash:
            for i in range(0, n - 1, dash * 2):
                d.line([pts[i], pts[min(i + dash, n - 1)]], fill=color, width=1)
        else:
            d.line(pts + [pts[0]], fill=color, width=2)

    d.text((x0 + 6, y1 - 16), "dashed = hard union   solid = fused", fill=TEXT)


def draw_radius(d: ImageDraw.ImageDraw, box, curve, title):
    x0, y0, x1, y1 = box
    d.rectangle(box, outline=AXIS)
    d.text((x0 + 6, y0 + 4), title, fill=TEXT)
    n = len(curve["hard"])
    rmax = max(max(curve["hard"]), max(curve["soft"])) * 1.06
    rmin = min(min(curve["hard"]), min(curve["soft"])) * 0.94
    span = max(rmax - rmin, 1e-6)
    iw, ih = x1 - x0 - 2, y1 - y0 - 2

    for key, color in (("hard", HARD), ("soft", SOFT)):
        pts = []
        for i in range(n):
            px = x0 + 1 + (i / (n - 1)) * iw
            py = y1 - 1 - ((curve[key][i] - rmin) / span) * ih
            pts.append((px, py))
        d.line(pts, fill=color, width=1 if key == "hard" else 2)

    d.text((x0 + 6, y1 - 16), "radius vs angle (radians)", fill=TEXT)


def main():
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    for row, name in enumerate(VARIANTS):
        path = HERE / f"shell-curve-{name}.json"
        if not path.exists():
            continue
        data = json.loads(path.read_text())
        curve = data["curve"]
        k = data["k"]
        y = PAD + row * (PANEL_H + PAD)
        draw_polar(
            d,
            (PAD, y, PAD + PANEL_W, y + PANEL_H),
            curve,
            f"{name}  k={k}  silhouette",
        )
        draw_radius(
            d,
            (PAD * 2 + PANEL_W, y, PAD * 2 + PANEL_W + PANEL_W, y + PANEL_H),
            curve,
            f"{name}  radius vs angle",
        )

    out = HERE / "shell-fusion-probe.png"
    img.save(out)
    print(out)


if __name__ == "__main__":
    main()
