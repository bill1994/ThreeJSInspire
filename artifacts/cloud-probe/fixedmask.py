"""固定掩码口径的 A/B 复测仪（2026-11-15 终局复算引入）。

探针的 bandEnergyInMask 用**各自变体的掩码**当分母（样本数 ±8% 漂移，变体间
不可比——2026-11-15 复核指出的仪器缺陷）。本脚本把所有变体放到同一把尺子：
V0 的 bg-on/bg-off 三通道最大差 > 24 生成掩码，腐蚀 2px 后固定，输出
band4（全掩码 / 上半 y<290）与两个历史热窗的 band4。

用法：python fixedmask.py  # 读死 RUNS 表；改表即改对比组（V0 必须在首位）
"""
import os
import numpy as np
from PIL import Image

BASE = os.path.dirname(os.path.abspath(__file__))
RUNS = {
    'V0': '2026-11-15T13-57-18Z',
    'V3': '2026-11-15T14-07-12Z',
    'V9': '2026-11-15T14-30-17Z',
    'V10': '2026-11-15T14-31-36Z',
    'V11': '2026-11-15T14-32-24Z',
}
HOT_WINDOWS = {'upper': (340, 69, 440, 119), 'lower': (70, 170, 170, 220)}
Y_HORIZON = 290
THRESHOLD = 24  # 与探针缺省口径一致（--threshold 可覆盖探针侧；此处保持 24）

def load(d):
    on = np.asarray(Image.open(os.path.join(BASE, d, 'bg-on.png')).convert('RGB'), dtype=np.int16)
    off = np.asarray(Image.open(os.path.join(BASE, d, 'bg-off.png')).convert('RGB'), dtype=np.int16)
    return on, off

def erode(mask, n=2):
    m = mask.astype(np.uint8)
    for _ in range(n):
        mm = np.zeros_like(m)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                mm |= np.roll(np.roll(m, dy, 0), dx, 1)
        m = mm & mask
    return m.astype(bool)

def band4(img, step=4):
    a = np.asarray(img, dtype=np.int16)
    d1 = np.abs(a[:-step, :-step] - a[:-step, step:]).max(axis=2)
    d2 = np.abs(a[:-step, :-step] - a[step:, :-step]).max(axis=2)
    return float(np.maximum(d1, d2).mean())

def band4_masked(img, mask, step=4):
    a = np.asarray(img, dtype=np.int16)
    ok = mask[:-step, :-step] & mask[:-step, step:] & mask[step:, :-step]
    d1 = np.abs(a[:-step, :-step] - a[:-step, step:]).max(axis=2)
    d2 = np.abs(a[:-step, :-step] - a[step:, :-step]).max(axis=2)
    d = np.maximum(d1, d2)[ok]
    return float(d.mean()) if d.size else 0.0

if __name__ == '__main__':
    v0dir = next(iter(RUNS.values()))
    on0, off0 = load(v0dir)
    mask = erode(np.abs(on0 - off0).max(axis=2) > THRESHOLD)
    print(f"fixed mask px = {mask.sum()}")
    print(f"{'variant':6s} {'band4':>7s} {'upper':>7s} {'hotUp':>7s} {'hotLo':>7s}")
    for k, d in RUNS.items():
        on, _ = load(d)
        print(f"{k:6s} {band4_masked(on, mask):>7.2f} {band4_masked(on[:Y_HORIZON], mask[:Y_HORIZON]):>7.2f}"
              f" {band4(on[HOT_WINDOWS['upper'][1]:HOT_WINDOWS['upper'][3], HOT_WINDOWS['upper'][0]:HOT_WINDOWS['upper'][2]]):>7.2f}"
              f" {band4(on[HOT_WINDOWS['lower'][1]:HOT_WINDOWS['lower'][3], HOT_WINDOWS['lower'][0]:HOT_WINDOWS['lower'][2]]):>7.2f}")
