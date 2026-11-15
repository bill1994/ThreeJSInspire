"""Task 5 诊断：同区域 8 倍裁切，看「蠕虫」到底是等高线（随 billow 走）还是逐像素砂糖噪声。

用法: python crop8.py <dirA> <dirB> <out.png> [x y w h]
不给窗口时取 bbox 内靠下 1/3、水平居中一块 120x90。
"""
import json
import sys
from pathlib import Path

from PIL import Image

a_dir, b_dir, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
m = json.loads((a_dir / "metrics.json").read_text(encoding="utf-8"))
bb = m["bbox"]
if len(sys.argv) >= 8:
    x, y, w, h = (int(v) for v in sys.argv[4:8])
else:
    x = max(bb["x0"] + 20, 0)
    w = min(120, bb["x1"] - x)
    y = max(bb["y1"] - 90, 0)
    h = 90

panels = []
for d in (a_dir, b_dir):
    img = Image.open(d / "bg-on.png").convert("RGB").crop((x, y, x + w, y + h))
    panels.append(img.resize((w * 8, h * 8), Image.NEAREST))

gap = 12
canvas = Image.new("RGB", (panels[0].width * 2 + gap, panels[0].height), (0, 0, 0))
canvas.paste(panels[0], (0, 0))
canvas.paste(panels[1], (panels[0].width + gap, 0))
canvas.save(out)
print(json.dumps({"crop": [x, y, w, h], "scale": 8, "out": str(out)}))
