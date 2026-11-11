"""穹顶云 P1.5/P2 验收量测（Task 9 Step 1 升级版）。

ROI 定义（钉死，见计划 Task 9）：**云带区域 = `?dome=1` 与 `?dome=0` 两张同机位帧的
差异掩码**（逐像素 max|ΔRGB| > 8），再与 canvas 矩形取交。门 2/3/4 的所有统计都只在
这个掩码内做，**不按行分带**（海面那套 0.40–0.52 / 0.70–0.97 是海专用的）。

用法：
    python measure.py on.png off.png --rect 474.9,0,434.3,772
    python measure.py on.png off.png --t0 t0.png --t30 t30.png   # 门 3 需要两帧
    python measure.py on.png off.png --sun sunoff.png           # 门 4 sun-diff
    组合使用均可。输出一行 JSON。

旧四项口径不变（P1 基线可比）：coverage / tone_span / banding_flips / drift。
新增四项（设计 §5.5/§8）：
    blob_count    云带掩码内连通块数（4-邻接），只计面积 > 0.2% canvas 的块，目标 3–8
    edge_grad_p95 云带内亮度梯度幅值 p95，目标同比 P1 上升（只记录，不设硬阈）
    row_peaks     行亮度剖面局部极大值个数（prominence > 1.0），目标 >= 2
    sun_diff_*    on vs sunoff 在掩码内的平均|Δ|与超阈比例，门 4 要求非零
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


def count_blobs(mask, min_frac=0.002):
    """4-邻接连通块计数，只计面积 > min_frac * canvas 的块。

    mask 已是 canvas 切片后的云带掩码。min_frac=0.002 即设计“> 0.2% 面积”
    的噪声过滤（相对 canvas，不是相对掩码——掩码大小随云量变，用掩码
    作分母会让阈值跟着云跑）。返回 (count, min_area_px)。
    纯 numpy+python 实现（项目量具不引 scipy），33万像素约 1-2s，可接受。
    """
    h, w = mask.shape
    total = h * w
    min_area = max(4, int(total * min_frac))
    visited = np.zeros_like(mask, dtype=bool)
    count = 0
    for y in range(h):
        row = mask[y]
        if not row.any():
            continue
        for x in range(w):
            if row[x] and not visited[y, x]:
                area = 0
                stack = [(y, x)]
                visited[y, x] = True
                while stack:
                    cy, cx = stack.pop()
                    area += 1
                    if cy > 0 and mask[cy - 1, cx] and not visited[cy - 1, cx]:
                        visited[cy - 1, cx] = True
                        stack.append((cy - 1, cx))
                    if cy + 1 < h and mask[cy + 1, cx] and not visited[cy + 1, cx]:
                        visited[cy + 1, cx] = True
                        stack.append((cy + 1, cx))
                    if cx > 0 and mask[cy, cx - 1] and not visited[cy, cx - 1]:
                        visited[cy, cx - 1] = True
                        stack.append((cy, cx - 1))
                    if cx + 1 < w and mask[cy, cx + 1] and not visited[cy, cx + 1]:
                        visited[cy, cx + 1] = True
                        stack.append((cy, cx + 1))
                if area >= min_area:
                    count += 1
    return count, min_area


def count_row_peaks(rows, prominence=1.0):
    """行亮度剖面严格局部极大值个数，要求峰值比两侧低点高出 prominence。

    prominence=1.0 过滤量噪小抖动；设计门 3 要求 >= 2（分层至少两层亮带）。
    """
    peaks = 0
    for i in range(1, len(rows) - 1):
        if rows[i] > rows[i - 1] and rows[i] > rows[i + 1]:
            if rows[i] - min(rows[i - 1], rows[i + 1]) > prominence:
                peaks += 1
    return peaks


def main(argv):
    if len(argv) < 3:
        raise SystemExit(__doc__)
    on, off = load(argv[1]), load(argv[2])
    if on.shape != off.shape:
        raise SystemExit(f'size mismatch: {on.shape} vs {off.shape}')

    rect = None
    t0 = t30 = None
    sun = None
    sun_path = None
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
        elif argv[i] == '--sun':
            sun_path = argv[i + 1]
            sun = load(sun_path)
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

    # Task 9 新增：blob_count / edge_grad_p95 / row_peaks（旧口径不动，追加输出）。
    blobs, blob_min_area = count_blobs(mfull)
    result['blob_count'] = blobs
    result['blob_min_area_px'] = blob_min_area
    gy, gx = np.gradient(lfull.astype(np.float32))
    grad = np.sqrt(gx * gx + gy * gy)[mfull]
    result['edge_grad_p95'] = round(float(np.percentile(grad, 95)), 4) if grad.size else 0.0
    result['row_peaks'] = count_row_peaks(rows)

    if t0 is not None and t30 is not None:
        if t0.shape != on.shape or t30.shape != on.shape:
            result['drift_error'] = 'time frames size mismatch'
        else:
            pair = np.abs(t0 - t30).max(axis=2)[sy, sx][mask]
            result['drift_mean_abs'] = round(float(pair.mean()), 3)
            result['drift_max_abs'] = int(pair.max())

    if sun is not None:
        # 门 4 sun-diff：同机位 on vs sunoff 在云带掩码内的差异。
        # 开关为假时差值 ~0；为真时差值即太阳项贡献，要求非零且集中在云带。
        if sun.shape != on.shape:
            result['sun_diff_error'] = 'sun frame size mismatch'
        else:
            sdiff = np.abs(on.astype(np.int16) - sun.astype(np.int16)).max(axis=2)[sy, sx][mask]
            result['sun_diff_mean'] = round(float(sdiff.mean()), 3)
            result['sun_diff_max'] = int(sdiff.max())
            result['sun_diff_frac'] = round(float((sdiff > THRESHOLD).mean()), 4)

    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main(sys.argv)
