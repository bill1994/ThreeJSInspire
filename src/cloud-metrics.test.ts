import { describe, expect, it } from 'vitest';
import {
  angularHeightDeg,
  angularWidthDeg,
  bandEnergyInMask,
  bbox,
  coverageFraction,
  diffMask,
  type RgbaImage,
} from './cloud-metrics';

const solid = (w: number, h: number, rgb: [number, number, number]): RgbaImage => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    data[i * 4] = rgb[0]; data[i * 4 + 1] = rgb[1]; data[i * 4 + 2] = rgb[2]; data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h };
};

describe('cloud-metrics', () => {
  it('diffMask 只标出超过阈值的像素', () => {
    const a = solid(4, 1, [10, 10, 10]);
    const b = solid(4, 1, [10, 10, 10]);
    b.data[0] = 40; // 第 0 像素差 30
    const m = diffMask(a, b, 24);
    expect(Array.from(m)).toEqual([1, 0, 0, 0]);
  });

  it('bbox 在给定区域内给出紧包围盒与像素数（半开区间：x1/y1 指向最后一个像素的下一个）', () => {
    const img = solid(10, 10, [0, 0, 0]);
    const mask = diffMask(solid(10, 10, [0, 0, 0]), img, 24);
    // 手工点亮 (2,3)-(5,6)
    for (let y = 3; y <= 6; y += 1) for (let x = 2; x <= 5; x += 1) mask[y * 10 + x] = 1;
    const b = bbox(mask, 10, 10, { x0: 0, y0: 0, x1: 10, y1: 10 });
    expect(b).toEqual({ x0: 2, y0: 3, x1: 6, y1: 7, count: 16 });
  });

  it('bbox 在空掩码上返回 null', () => {
    expect(bbox(new Uint8Array(100), 10, 10, { x0: 0, y0: 0, x1: 10, y1: 10 })).toBeNull();
  });

  it('角宽用精确 gnomonic 式：垂直 FOV 60°、448×797，整幅一半 224px → 18.43°（不是 18°）', () => {
    // 近轴近似会把 18.43 读成 18.03，2.4% 的误差会直接吃掉 Task 3 的 ±2° 判定余量
    expect(angularWidthDeg(224, 448, 797, 60)).toBeCloseTo(18.43, 1);
    const full = angularWidthDeg(448, 448, 797, 60);
    expect(full).toBeCloseTo(35.96, 1);
  });

  it('角高换算：797 像素整幅 = 60°', () => {
    expect(angularHeightDeg(797, 797, 60)).toBeCloseTo(60, 5);
  });

  it('coverageFraction 只统计区域内（半开区间，2×2 区域含 4 px）', () => {
    const mask = new Uint8Array(100).fill(0);
    mask[0] = 1; mask[1] = 1; // 区域 [0,2)×[0,2) 共 4 px 里 2 px
    expect(coverageFraction(mask, 10, { x0: 0, y0: 0, x1: 2, y1: 2 })).toBe(0.5);
  });

  it('bandEnergyInMask：平坦图能量恒 0', () => {
    const img = solid(8, 8, [120, 120, 120]);
    const mask = new Uint8Array(64).fill(1);
    expect(bandEnergyInMask(img, mask, 8, 8, 1)).toBe(0);
    expect(bandEnergyInMask(img, mask, 8, 8, 4)).toBe(0);
  });

  it('bandEnergyInMask：隔 step 采样的差分——奇偶列条纹 step=1 满是能量，step=2 归零', () => {
    const img = solid(8, 8, [0, 0, 0]);
    for (let y = 0; y < 8; y += 1) for (let x = 1; x < 8; x += 2) img.data[(y * 8 + x) * 4] = 200;
    const mask = new Uint8Array(64).fill(1);
    expect(bandEnergyInMask(img, mask, 8, 8, 1)).toBeCloseTo(200, 5);
    expect(bandEnergyInMask(img, mask, 8, 8, 2)).toBe(0);
    // 通道取最大绝对差：蓝通道写同样的条纹，结论不变
    const imgB = solid(8, 8, [0, 0, 0]);
    for (let y = 0; y < 8; y += 1) for (let x = 1; x < 8; x += 2) imgB.data[(y * 8 + x) * 4 + 2] = 200;
    expect(bandEnergyInMask(imgB, mask, 8, 8, 1)).toBeCloseTo(200, 5);
  });

  it('bandEnergyInMask：纵向条纹同样被量到（Δy 参与，取两向最大）', () => {
    const img = solid(8, 8, [0, 0, 0]);
    for (let y = 1; y < 8; y += 2) for (let x = 0; x < 8; x += 1) img.data[(y * 8 + x) * 4] = 150;
    const mask = new Uint8Array(64).fill(1);
    expect(bandEnergyInMask(img, mask, 8, 8, 1)).toBeCloseTo(150, 5);
  });

  it('bandEnergyInMask：只看掩码内像素（掩码外再花也不计），掩码值非 0 即命中', () => {
    const img = solid(8, 8, [0, 0, 0]);
    for (let y = 0; y < 8; y += 1) for (let x = 4; x < 8; x += 1) img.data[(y * 8 + x) * 4] = 200; // 右半 200
    const left = new Uint8Array(64);
    for (let y = 0; y < 8; y += 1) for (let x = 0; x < 4; x += 1) left[y * 8 + x] = 1;
    expect(bandEnergyInMask(img, left, 8, 8, 1)).toBe(0);
    const right = new Uint8Array(64);
    for (let y = 0; y < 8; y += 1) for (let x = 4; x < 8; x += 1) right[y * 8 + x] = 7; // 非 0 即命中
    expect(bandEnergyInMask(img, right, 8, 8, 1)).toBe(0); // 右半自身平坦：跨边界的那几列在掩码外
    // 掩码扩到全图后，左右交界的能量才出现：只有 x=3→4 那 7 个样本跨边界 → 均值 200/7
    expect(bandEnergyInMask(img, new Uint8Array(64).fill(1), 8, 8, 1)).toBeCloseTo(200 / 7, 5);
  });

  it('bandEnergyInMask：空掩码与超图 step 都安全返回 0（无 NaN）', () => {
    const img = solid(4, 4, [10, 10, 10]);
    expect(bandEnergyInMask(img, new Uint8Array(16), 4, 4, 2)).toBe(0);
    expect(bandEnergyInMask(img, new Uint8Array(16).fill(1), 4, 4, 9)).toBe(0);
  });

});
