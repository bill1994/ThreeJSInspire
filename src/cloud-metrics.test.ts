import { describe, expect, it } from 'vitest';
import { angularHeightDeg, angularWidthDeg, bbox, coverageFraction, diffMask, type RgbaImage } from './cloud-metrics';

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
});
