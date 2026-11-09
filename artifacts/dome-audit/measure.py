"""穹顶云 P1 验收量测。

ROI 定义（钉死，见计划 Task 9）：**云带区域 = `?dome=1` 与 `?dome=0` 两张同机位帧的
差异掩码**（逐像素 max|ΔRGB| > 8），再与 canvas 矩形取交。门 2/3/4 的所有统计都只在
这个掩码内做，**不按行分带**（海面那套 0.40–0.52 / 0.70–0.97 是海专用的）。

用法：
    python measure.py on.png off.png --rect 474.9,0,434.3,772
    python measure.py on.png off.png --t0 t0.png --t30 t30.png   # 门 3 需要两帧

输出一行 JSON。
"""
import json
import sys

import numpy as np
from PIL import Image

THRESHOLD = 8          # JPEG/PNG 噪声在 8 以内
STRIPE_GRAD = 3.0      # 行均值梯度阈值（沿用海面量具口径）


def load(path):
    return np.asarray(Image.open(path).convert('RGB')).astype(np.int16)


def luminance(rgb):
    # Rec.709 线性近似；只用于分位数比较，不需要色彩管理精度。
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def canvas_slice(shape, rect):
    if not rect:
        return (slice(0, shape[0]), slice(0, shape[1]))
    x, y, w, h = rect
    x0, y0 = int(round(x)), int(round(y))
    x1, y1 = int(round(x + w)), int(round(y + h))
    return (slice(max(0, y0), min(shape[0], y1)), slice(max(0, x0), min(shape[1], x1)))


def main(argv):
    if len(argv) < 3:
        raise SystemExit(__doc__)
    on, off = load(argv[1]), load(argv[2])
    if on.shape != off.shape:
        raise SystemExit(f'size mismatch: {on.shape} vs {off.shape}')

    rect = None
    t0 = t30 = None
    i = 3
    while i < len(argv):
        if argv[i] == '--rect':
            rect = [float(v) for v in argv[i + 1].split(',')]
            i += 2
        elif argv[i] == '--t0':
            t0 = load(argv[i + 1])
            i += 2
        elif argv[i] == '--t30':
            t30 = load(argv[i + 1])
            i += 2
        else:
            raise SystemExit(f'unknown arg: {argv[i]}')

    sy, sx = canvas_slice(on.shape, rect)

    diff = np.abs(on - off).max(axis=2)[sy, sx]
    mask = diff > THRESHOLD

    total = mask.size
    covered = int(mask.sum())
    coverage = covered / total if total else 0.0

    result = {
        'canvas': [int(sx.stop - sx.start), int(sy.stop - sy.start)],
        'coverage_pct': round(100.0 * coverage, 3),
        'mask_px': covered,
    }

    if covered == 0:
        result['note'] = 'dome contributes no pixels — nothing else can be measured'
        print(json.dumps(result, ensure_ascii=False))
        return

    lum = luminance(on.astype(np.float32))[sy, sx][mask]
    p8, p92 = np.percentile(lum, [8, 92])
    result['tone_span'] = round(float(p92 - p8), 4)

    # 行均值梯度：只在掩码非空的行上算，避免把空行当成「0 梯度」稀释。
    rows = []
    lfull = luminance(on.astype(np.float32))[sy, sx]
    mfull = mask
    for r in range(lfull.shape[0]):
        sel = mfull[r]
        if sel.sum() < 8:
            continue
        rows.append(float(lfull[r][sel].mean()))
    deltas = [b - a for a, b in zip(rows, rows[1:])]
    result['row_stripes'] = sum(1 for d in deltas if abs(d) > STRIPE_GRAD)
    # 真正的「带状伪影」是相邻行均值的**振荡**（梯度反复变号），
    # 而不是单调的垂直亮度梯度——后者是天空/云的正常明暗过渡。
    flips = 0
    for a, b in zip(deltas, deltas[1:]):
        if abs(a) > STRIPE_GRAD and abs(b) > STRIPE_GRAD and (a > 0) != (b > 0):
            flips += 1
    result['banding_flips'] = flips

    if t0 is not None and t30 is not None:
        if t0.shape != on.shape or t30.shape != on.shape:
            result['drift_error'] = 'time frames size mismatch'
        else:
            pair = np.abs(t0 - t30).max(axis=2)[sy, sx][mask]
            result['drift_mean_abs'] = round(float(pair.mean()), 3)
            result['drift_max_abs'] = int(pair.max())

    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main(sys.argv)
