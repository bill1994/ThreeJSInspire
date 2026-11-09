import { describe, expect, it } from 'vitest';

import {
  generateDetailVolume,
  generateShapeVolume,
  generateWeatherMap,
  mulberry32,
  volumeStats,
  worley3,
} from './dome-cloud-noise';

describe('mulberry32', () => {
  it('is deterministic for a seed', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('stays inside [0, 1)', () => {
    const r = mulberry32(1);
    for (let i = 0; i < 1000; i += 1) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('generateShapeVolume', () => {
  it('fills size cubed bytes', () => {
    expect(generateShapeVolume(8, 1)).toHaveLength(512);
  });

  it('is deterministic', () => {
    expect(Array.from(generateShapeVolume(8, 3))).toEqual(Array.from(generateShapeVolume(8, 3)));
  });

  it('uses the full byte range without collapsing', () => {
    const s = volumeStats(generateShapeVolume(16, 5));
    expect(s.max).toBeGreaterThan(200);
    expect(s.min).toBeLessThan(60);
    expect(s.mean).toBeGreaterThan(20);
    expect(s.mean).toBeLessThan(235);
  });

  it('thins out toward the top of the slab so the deck has a ceiling', () => {
    const size = 16;
    const data = generateShapeVolume(size, 5);
    const rowMean = (y: number) => {
      let sum = 0;
      for (let z = 0; z < size; z += 1) {
        for (let x = 0; x < size; x += 1) sum += data[y * size * size + z * size + x];
      }
      return sum / (size * size);
    };
    expect(rowMean(0)).toBeGreaterThan(rowMean(size - 1));
  });

  it('rejects a size that cannot tile', () => {
    expect(() => generateShapeVolume(10, 1)).toThrow();
  });
});

describe('generateDetailVolume', () => {
  it('fills size cubed bytes and is deterministic', () => {
    expect(generateDetailVolume(8, 2)).toHaveLength(512);
    expect(Array.from(generateDetailVolume(8, 2))).toEqual(
      Array.from(generateDetailVolume(8, 2)),
    );
  });

  it('is not flat', () => {
    const s = volumeStats(generateDetailVolume(8, 2));
    expect(s.max - s.min).toBeGreaterThan(100);
  });
});

describe('generateWeatherMap', () => {
  it('fills size squared bytes, not cubed', () => {
    // weather 是 2D；按体积尺寸分配会多出 size 倍内存。
    expect(generateWeatherMap(16, 4)).toHaveLength(256);
  });

  it('is deterministic and not flat', () => {
    expect(Array.from(generateWeatherMap(16, 4))).toEqual(Array.from(generateWeatherMap(16, 4)));
    const s = volumeStats(generateWeatherMap(16, 4));
    expect(s.max - s.min).toBeGreaterThan(100);
  });
});

describe('worley3 seam — I5', () => {
  it('is continuous across the x wrap seam', () => {
    // 格号回绕后特征点也必须按反向展开，否则跨缝距离被算成 ≈cells。
    const a = worley3(0.001, 0.37, 0.42, 4, 123);
    const b = worley3(0.999, 0.37, 0.42, 4, 123);
    expect(Math.abs(a - b)).toBeLessThan(0.05);
  });

  it('is continuous across the y and z seams too', () => {
    expect(Math.abs(worley3(0.37, 0.001, 0.42, 4, 123) - worley3(0.37, 0.999, 0.42, 4, 123))).toBeLessThan(0.05);
    expect(Math.abs(worley3(0.37, 0.42, 0.001, 4, 123) - worley3(0.37, 0.42, 0.999, 4, 123))).toBeLessThan(0.05);
  });
});