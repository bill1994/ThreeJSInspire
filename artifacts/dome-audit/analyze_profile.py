"""穹顶云 P1.5 Task 5 — 垂直分层的行亮度剖面（row_peaks 代理量具）。

row_peaks 定义（计划 Task 9 才升级真量具，本脚本是 Task 5 的目测/代理判证据）：
  1. 云带掩码 = `?dome=1` 与 `?dome=0` 同机位差值（max|ΔRGB| > 8），与 canvas rect 取交。
  2. 只在掩码 ≥ 8 px 的行上取 dome=1 帧的平均亮度 → 行亮度剖面。
  3. 剖面轻度平滑（窗口 7）后数局部极大值；峰需 prominence ≥ PROM（滤行间噪声毛刺）。
  门：row_peaks ≥ 2（整层 2–3 个密度峰）。

另附调制足迹：与参照帧（Task 4 的 p15-light-on/off）的掩码差值统计——
调制只应改 dome 云带内的像素。

用法：
    python -I analyze_profile.py on.png off.png --rect 474.875,0,434.25,772 \
        [--ref reftask4-on.png reftask4-off.png]
"""
import json
import sys

import numpy as np
from PIL import Image

THRESHOLD = 8
SMOOTH_K = 7   # 行剖面平滑窗口（奇数）
PROM = 2.0     # 峰的 prominence 门槛（luma/255 尺度上的行均值噪声级）


def load(path):
    return np.asarray(Image.open(path).convert('RGB')).astype(np.float32)


def luminance(rgb):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def canvas_slice(shape, rect):
    if not rect:
        return (slice(0, shape[0]), slice(0, shape[1]))
    x, y, w, h = rect
    x0, y0 = int(round(x)), int(round(y))
    x1, y1 = int(round(x + w)), int(round(y + h))
    return (slice(max(0, y0), min(shape[0], y1)), slice(max(0, x0), min(shape[1], x1)))


def row_profile(on_c, mask):
    """掩码 ≥ 8 px 的行的平均亮度 → (rows, values)。"""
    lum = luminance(on_c)
    rows, vals = [], []
    for r in range(lum.shape[0]):
        sel = mask[r]
        if sel.sum() < 8:
            continue
        rows.append(r)
        vals.append(float(lum[r][sel].mean()))
    return np.array(rows), np.array(vals)


def smooth(v):
    k = np.ones(SMOOTH_K) / SMOOTH_K
    return np.convolve(v, k, mode='same')


def count_peaks(v, prom=PROM):
    """平滑剖面的局部极大值 + prominence 过滤。

    prominence：峰与其两侧最近「谷底」的高差（任一侧走到被更高处截断为止）。
    """
    peaks = []
    for i in range(len(v)):
        left = v[i - 1] if i > 0 else -np.inf
        right = v[i + 1] if i < len(v) - 1 else -np.inf
        if v[i] >= left and v[i] >= right and (v[i] > left or v[i] > right):
            # 左侧谷底
            lo_l = v[i]
            for j in range(i - 1, -1, -1):
                if v[j] > v[i]:
                    break
                lo_l = min(lo_l, v[j])
            # 右侧谷底
            lo_r = v[i]
            for j in range(i + 1, len(v)):
                if v[j] > v[i]:
                    break
                lo_r = min(lo_r, v[j])
            p = v[i] - max(lo_l, lo_r)
            if p >= prom:
                peaks.append((i, float(v[i]), round(float(p), 2)))
    return peaks


def main(argv):
    if len(argv) < 4:
        raise SystemExit(__doc__)
    on, off = load(argv[1]), load(argv[2])
    if on.shape != off.shape:
        raise SystemExit(f'size mismatch: {on.shape} vs {off.shape}')
    rect = None
    ref = None
    i = 3
    while i < len(argv):
        if argv[i] == '--rect':
            rect = [float(v) for v in argv[i + 1].split(',')]
            i += 2
        elif argv[i] == '--ref':
            ref = (load(argv[i + 1]), load(argv[i + 2]))
            i += 3
        else:
            raise SystemExit(f'unknown arg: {argv[i]}')

    sy, sx = canvas_slice(on.shape, rect)
    on_c, off_c = on[sy, sx], off[sy, sx]
    diff = np.abs(on_c - off_c).max(axis=2)
    mask = diff > THRESHOLD
    n_band = int(mask.sum())

    result = {
        'canvas': [int(sx.stop - sx.start), int(sy.stop - sy.start)],
        'band_px': n_band,
        'band_pct': round(100.0 * n_band / mask.size, 3),
    }
    if n_band == 0:
        result['note'] = 'empty cloud band'
        print(json.dumps(result, ensure_ascii=False))
        return

    rows, vals = row_profile(on_c, mask)
    sm = smooth(vals)
    peaks = count_peaks(sm)
    result['row_profile'] = {
        'rows_used': int(len(rows)),
        'row_range': [int(rows[0]), int(rows[-1])] if len(rows) else None,
        'smooth_k': SMOOTH_K,
        'prominence_gate': PROM,
        'peaks': [{'idx': int(rows[i]), 'luma': round(v, 2), 'prom': p} for i, v, p in peaks],
        'peak_count': len(peaks),
        'row_peaks_ge_2': len(peaks) >= 2,
        'profile_sampled': [round(float(x), 1) for x in sm[::16]],  # 每 16 行抽样留档
    }

    # 调制足迹：本任务帧 vs 参照帧（掩码口径改动的行分布）
    if ref is not None:
        ref_on, ref_off = ref
        ref_c = ref_on[sy, sx]
        ref_mask = (np.abs(ref_on[sy, sx] - ref_off[sy, sx]).max(axis=2) > THRESHOLD)
        task_diff = np.abs(on_c - ref_c).max(axis=2)
        result['modulation_footprint'] = {
            'changed_vs_task4_px': int((task_diff > THRESHOLD).sum()),
            'changed_inside_task4_band': int((task_diff[ref_mask] > THRESHOLD).sum()),
            'task4_band_px': int(ref_mask.sum()),
            'energy_frac_in_task4_band': round(
                float(task_diff[ref_mask].sum()) / max(float(task_diff.sum()), 1.0), 4),
        }

    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main(sys.argv)
