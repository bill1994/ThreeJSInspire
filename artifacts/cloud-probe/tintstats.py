"""云体紫/粉配比：在 bbox 内统计 (B−R) 分布，判断「云底深调到底有没有生效」。
uUnder 是暗紫，col 是粉/橙：tint 一撤，均值 (B−R) 应显著上升（更粉）。
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

for d in map(Path, sys.argv[1:]):
    m = json.loads((d / "metrics.json").read_text(encoding="utf-8"))
    bb = m["bbox"]
    a = np.asarray(Image.open(d / "bg-on.png").convert("RGB")).astype(np.int16)
    crop = a[bb["y0"]:bb["y1"], bb["x0"]:bb["x1"]]
    diff = crop[..., 2] - crop[..., 0]  # B − R
    print(json.dumps({
        "dir": d.name,
        "band4": round(m["bandEnergy"]["step4"], 2),
        "coverageSky": round(m["coverageSky"], 4),
        "meanB-R": round(float(diff.mean()), 2),
        "p90B-R": round(float(np.percentile(diff, 90)), 2),
        "p10B-R": round(float(np.percentile(diff, 10)), 2),
        "frac_B-R_gt_30": round(float((diff > 30).mean()), 3),
    }, ensure_ascii=False))
