"""Task 5 A/B 目视对照：把基线（旧尾段）与 GREEN（低频高度）的云底裁切放大 4 倍并排。

用法: python compare-task5.py <baselineDir> <greenDir> <out.png>
裁切区域按 metrics.json 的 bbox 自动取云底带：bbox 下沿往上 120px、左右各内缩 20px。
"""
import json
import sys
from pathlib import Path

from PIL import Image

base = Path(sys.argv[1])
green = Path(sys.argv[2])
out = Path(sys.argv[3])


def crop_band(d):
    m = json.loads((d / "metrics.json").read_text(encoding="utf-8"))
    bb = m["bbox"]
    img = Image.open(d / "bg-on.png").convert("RGB")
    x0 = max(bb["x0"] + 20, 0)
    x1 = min(bb["x1"] - 20, img.width)
    y1 = min(bb["y1"], img.height)
    y0 = max(y1 - 120, 0)
    return img.crop((x0, y0, x1, y1)), m


a, ma = crop_band(base)
b, mb = crop_band(green)
scale = 4
a = a.resize((a.width * scale, a.height * scale), Image.NEAREST)
b = b.resize((b.width * scale, b.height * scale), Image.NEAREST)
gap = 16
canvas = Image.new("RGB", (a.width + b.width + gap, max(a.height, b.height)), (20, 20, 24))
canvas.paste(a, (0, 0))
canvas.paste(b, (a.width + gap, 0))
canvas.save(out)
print(json.dumps({
    "baseline": {"coverageSky": ma["coverageSky"], "band4": ma["bandEnergy"]["step4"], "band8": ma["bandEnergy"]["step8"],
                 "noise": ma["noiseFloor"]["sky"], "crop": list(a.size)},
    "green": {"coverageSky": mb["coverageSky"], "band4": mb["bandEnergy"]["step4"], "band8": mb["bandEnergy"]["step8"],
              "noise": mb["noiseFloor"]["sky"], "crop": list(b.size)},
    "out": str(out),
}, ensure_ascii=False, indent=2))
