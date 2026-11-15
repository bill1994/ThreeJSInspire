"""Task 5 云底带三方对照：基线（旧尾段）| GREEN（球高归一）| 平坦 mid（无 paint 地板）。

用法: python strip3.py <out.png> <dir1> <dir2> <dir3> [y0 y1]
每条面板上方写目录尾名，裁 y0..y1 整幅宽、4 倍最近邻放大。
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

out = Path(sys.argv[1])
dirs = [Path(p) for p in sys.argv[2:5]]
y0, y1 = (int(sys.argv[5]), int(sys.argv[6])) if len(sys.argv) >= 7 else (196, 290)

scale = 4
panels = []
for d in dirs:
    img = Image.open(d / "bg-on.png").convert("RGB")
    w = img.width
    crop = img.crop((0, max(y0, 0), w, min(y1, img.height)))
    panels.append((d.name, crop.resize((crop.width * scale, crop.height * scale), Image.NEAREST)))

gap = 14
head = 22
label_w = 260
height = panels[0][1].height + head
width = sum(p[1].width for p in panels) + gap * (len(panels) - 1)
canvas = Image.new("RGB", (width, height), (12, 12, 14))
draw = ImageDraw.Draw(canvas)
x = 0
info = {}
for name, panel in panels:
    canvas.paste(panel, (x, head))
    draw.text((x + 4, 5), name, fill=(230, 230, 230))
    m = json.loads((next(d for d in dirs if d.name == name) / "metrics.json").read_text(encoding="utf-8"))
    info[name] = {"coverageSky": round(m["coverageSky"], 4), "band4": round(m["bandEnergy"]["step4"], 2),
                 "band8": round(m["bandEnergy"]["step8"], 2), "noise": round(m["noiseFloor"]["sky"], 4)}
    x += panel.width + gap
canvas.save(out)
print(json.dumps({"strip": [y0, y1], "scale": scale, "info": info, "out": str(out)}, ensure_ascii=False, indent=2))
