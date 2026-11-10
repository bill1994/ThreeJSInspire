"""穹顶云 P1.5 Task 4 — 门 4 的两项证据（设计 §5.2）。

1. **sun-diff（太阳项真实占比）**：`?dome=1` 与 `?dome=1&sunoff=1` 同机位差值。
   要求非零，且**集中在云带**（云带掩码 = dome=1 与 dome=0 的差异，阈值 8）。
   报告：掩码内/外的 mean/max、能量集中度（掩码内能量占比）、掩码内被 sun-diff
   触碰（>8）的像素占比。
2. **受光/背光直方图双峰**：云带掩码内 dome=1 帧的亮度直方图（32 bins，轻度
   平滑），统计局部极大值个数与峰位置。设计不规定极性，≥2 个局部极大值即过。

用法：
    python -I analyze_light.py on.png off.png sunoff.png --rect 474.875,0,434.25,772
"""
import json
import sys

import numpy as np
from PIL import Image

THRESHOLD = 8
BINS = 32
SMOOTH_K = 3  # 直方图平滑窗口（奇数），抑制 bin 噪声假峰


def load(path):
    return np.asarray(Image.open(path).convert('RGB')).astype(np.float32)


def luminance(rgb):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def canvas_slice(shape, rect):
    if not rect:
        return (slice(0, shape[0]), slice(0, shape[1]))
    x, y, w, h = rect
    x0, y0, x1, y1 = int(round(x)), int(round(y)), int(round(x + w)), int(round(y + h))
    return (slice(max(0, y0), min(shape[0], y1)), slice(max(0, x0), min(shape[1], x1)))


def local_maxima(hist):
    """平滑后直方图的局部极大值（端点按单侧邻居比较）。"""
    k = np.ones(SMOOTH_K) / SMOOTH_K
    sm = np.convolve(hist, k, mode='same')
    peaks = []
    for i in range(len(sm)):
        left = sm[i - 1] if i > 0 else -np.inf
        right = sm[i + 1] if i < len(sm) - 1 else -np.inf
        if sm[i] >= left and sm[i] >= right and sm[i] > 0:
            # 严格大于至少一侧，避免把平台整体算成峰
            if sm[i] > left or sm[i] > right:
                peaks.append((i, float(sm[i])))
    return peaks, sm


def main(argv):
    if len(argv) < 4:
        raise SystemExit(__doc__)
    on, off, sunoff = load(argv[1]), load(argv[2]), load(argv[3])
    rect = None
    i = 4
    while i < len(argv):
        if argv[i] == '--rect':
            rect = [float(v) for v in argv[i + 1].split(',')]
            i += 2
        else:
            raise SystemExit(f'unknown arg: {argv[i]}')
    if on.shape != off.shape or on.shape != sunoff.shape:
        raise SystemExit(f'size mismatch: {on.shape} vs {off.shape} vs {sunoff.shape}')

    sy, sx = canvas_slice(on.shape, rect)
    on_c, off_c, sunoff_c = on[sy, sx], off[sy, sx], sunoff[sy, sx]

    # 云带掩码：dome 有/无差异（量具 ROI 口径，measure.py 同款）
    dome_diff = np.abs(on_c - off_c).max(axis=2)
    band = dome_diff > THRESHOLD
    # 太阳项差值：dome=1 太阳开 vs 太阳关
    sun_diff = np.abs(on_c - sunoff_c).max(axis=2)
    sun_signed = on_c.mean(axis=2) - sunoff_c.mean(axis=2)

    n_band = int(band.sum())
    result = {
        'canvas': [int(sx.stop - sx.start), int(sy.stop - sy.start)],
        'band_px': n_band,
        'band_pct': round(100.0 * n_band / band.size, 3) if band.size else 0.0,
    }
    if n_band == 0:
        result['note'] = 'empty cloud band — nothing to gate'
        print(json.dumps(result, ensure_ascii=False))
        return

    s_in, s_out = sun_diff[band], sun_diff[~band]
    energy_in = float(s_in.sum())
    energy_total = float(sun_diff.sum())
    touched = int((s_in > THRESHOLD).sum())
    result['sun_diff'] = {
        'nonzero': bool(energy_total > 0),
        'mean_abs_in_band': round(float(s_in.mean()), 3),
        'max_abs_in_band': int(s_in.max()),
        'mean_abs_out_band': round(float(s_out.mean()), 3),
        'energy_frac_in_band': round(energy_in / energy_total, 4) if energy_total else 0.0,
        'touched_px_in_band': touched,
        'touched_pct_of_band': round(100.0 * touched / n_band, 3),
        'signed_mean_in_band': round(float(sun_signed[band].mean()), 3),  # 正 = 太阳项让云带变亮
    }

    # 受光/背光直方图（掩码内，dome=1 帧亮度）
    lum = luminance(on_c)[band]
    hist, edges = np.histogram(lum, bins=BINS, range=(0, 255))
    peaks, smooth = local_maxima(hist.astype(np.float64))
    # 峰强度门槛：至少 1% 的掩码像素，滤掉直方图尾巴的毛刺
    min_peak_px = max(1, int(0.01 * n_band))
    real_peaks = [(b, v) for b, v in peaks if hist[b] >= min_peak_px]
    result['histogram'] = {
        'bins': BINS,
        'peaks': [{'bin': b, 'lo': round(float(edges[b]), 1), 'hi': round(float(edges[b + 1]), 1),
                   'px': int(hist[b]), 'smooth': round(v, 1)} for b, v in real_peaks],
        'peak_count': len(real_peaks),
        'two_peak_separation': len(real_peaks) >= 2,
        'dark_pct': round(100.0 * float((lum < 64).sum()) / n_band, 2),
        'bright_pct': round(100.0 * float((lum >= 160).sum()) / n_band, 2),
    }
    result['hist'] = [int(v) for v in hist]
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main(sys.argv)
