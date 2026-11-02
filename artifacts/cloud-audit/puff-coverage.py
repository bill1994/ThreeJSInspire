"""近景 puff 的画面占比：同机位 puff=1 与 puff=0 两张帧做差，差值像素就是这场云。

比按颜色分割可靠——海面和天顶都是紫的，单靠色相分不开。用法：
    python artifacts/cloud-audit/puff-coverage.py <puff-on.jpg> <puff-off.jpg>
"""
import sys
from PIL import Image
import numpy as np

on = np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(np.int16)
off = np.asarray(Image.open(sys.argv[2]).convert('RGB')).astype(np.int16)
if on.shape != off.shape:
    raise SystemExit(f'size mismatch: {on.shape} vs {off.shape}')

diff = np.abs(on - off).max(axis=2)
changed = diff > 8            # JPEG 压缩噪声在 8 以内
h, w = changed.shape
# 竖屏那一条（去掉两侧黑边）
cols = np.where((on.sum(axis=(0, 2)) > 12))[0]
x0, x1 = int(cols[0]), int(cols[-1]) + 1
frac = changed[:, x0:x1].sum() / (h * (x1 - x0))
print(f'frame {x1 - x0}x{h}  puff_px={int(changed.sum())}  coverage={frac * 100:.2f}%')
