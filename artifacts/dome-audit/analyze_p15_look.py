"""穹顶云 Task 6 — P2 flat 四档阈值标定。

思路（src/dome-cloud.ts FLAT_BAND_THRESHOLDS 注释的实现）：目标是 flat 帧云掩码内
四档代表色各占 ~25%（soft 帧云掩码亮度四分位的目标档位占比）。屏幕读不到 trans，
但 flat 帧每个云像素的颜色就是四档代表色之一（经 alpha 与天空混合），于是：

1. 掩码 = flat-on / flat-off 同机位差（与 measure.py 同口径，rect 同）。
2. 深核像素（diff 权重前 25%）按亮度 1D k-means 聚成 4 类 → 四档代表色的实测中心。
3. 全部掩码像素按最近中心分档，diff 大小作权重（alpha 混合的边缘权重低）→ 实测占比
   o0..o3。
4. 占比给出 trans 经验 CDF 的三个点：F(t0)=o0, F(t1)=o0+o1, F(t2)=o0+o1+o2
   （当前阈值 t 下的实测）。分片线性插值反解 F=0.25/0.50/0.75 的新阈值，迭代收敛。

用法：
    python analyze_p15_look.py p15-look-flat-on.png p15-look-flat-off.png \
        p15-look-flat-nopost.png --thresholds 0.2,0.4,0.68 [--rect 474.9,0,434.3,772]

输出一行 JSON：实测四档占比、聚类中心亮度、CDF 点、以及建议的新阈值。
"""
import json
import sys

import numpy as np
from PIL import Image


def load(path):
    return np.asarray(Image.open(path).convert('RGB')).astype(np.float64)


def luminance(rgb):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def canvas_slice(shape, rect):
    x, y, w, h = rect
    x0, y0 = int(round(x)), int(round(y))
    x1, y1 = int(round(x + w)), int(round(y + h))
    return (slice(max(0, y0), min(shape[0], y1)), slice(max(0, x0), min(shape[1], x1)))


def kmeans_1d(values, weights, init, iters=50):
    """1D k-means，返回排序的中心。init 为初始中心（升序）。"""
    centers = np.array(init, dtype=np.float64)
    for _ in range(iters):
        idx = np.argmin(np.abs(values[:, None] - centers[None, :]), axis=1)
        new = centers.copy()
        for k in range(len(centers)):
            sel = weights[idx == k]
            if sel.sum() > 0:
                new[k] = np.average(values[idx == k], weights=sel)
        if np.allclose(new, centers, atol=1e-6):
            break
        centers = new
    return np.sort(centers)


def main(argv):
    on, off, nopost = load(argv[1]), load(argv[2]), load(argv[3])
    thresholds = [float(v) for v in argv[argv.index('--thresholds') + 1].split(',')]
    rect = [474.9, 0, 434.3, 772]
    if '--rect' in argv:
        rect = [float(v) for v in argv[argv.index('--rect') + 1].split(',')]

    sy, sx = canvas_slice(on.shape, rect)
    diff = np.abs(on - off).max(axis=2)[sy, sx]
    mask = diff > 8.0
    lum = luminance(nopost)[sy, sx]

    if mask.sum() == 0:
        print(json.dumps({'error': 'empty mask'}))
        return

    w = np.clip(diff, 0.0, 255.0)  # alpha 混合权重：边缘淡像素权重低
    wm = w[mask]
    lm = lum[mask]

    # 深核像素（diff 权重前 25%）聚出四档代表色中心——深核 alpha≈1，颜色≈纯档色。
    core_cut = np.percentile(wm, 75)
    core = wm >= core_cut
    centers = kmeans_1d(lm[core], wm[core], init=np.percentile(lm[core], [15, 40, 65, 90]))

    # 全部掩码像素按最近中心分档，权重 = diff。
    idx = np.argmin(np.abs(lm[:, None] - centers[None, :]), axis=1)
    total = wm.sum()
    occupancy = [float(wm[idx == k].sum() / total * 100.0) for k in range(4)]
    pixels = [int((idx == k).sum()) for k in range(4)]

    # trans 经验 CDF 的实测点（当前阈值下）。
    cdf_t = list(thresholds)
    cdf_f = [occupancy[0] / 100.0,
             (occupancy[0] + occupancy[1]) / 100.0,
             (occupancy[0] + occupancy[1] + occupancy[2]) / 100.0]

    # 分片线性反解 F=0.25/0.50/0.75 的新阈值（单调插值，两端线性外推）。
    targets = [0.25, 0.50, 0.75]
    xs = [0.0] + cdf_t + [1.0]
    ys = [0.0] + cdf_f + [1.0]
    # ys 必须单调不减；数值噪声时钳住。
    for i in range(1, len(ys)):
        ys[i] = max(ys[i], ys[i - 1])
    suggested = [float(np.interp(t, ys, xs)) for t in targets]

    print(json.dumps({
        'thresholds_used': thresholds,
        'band_centers_lum': [round(float(c), 2) for c in centers],
        'occupancy_pct_weighted': [round(o, 2) for o in occupancy],
        'occupancy_px_unweighted': pixels,
        'mask_px': int(mask.sum()),
        'empirical_cdf': {'t': cdf_t, 'F': [round(f, 4) for f in cdf_f]},
        'suggested_thresholds_for_25_quartiles': [round(s, 3) for s in suggested],
    }, ensure_ascii=False))


if __name__ == '__main__':
    main(sys.argv)
