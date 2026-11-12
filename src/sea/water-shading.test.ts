import { describe, expect, it } from 'vitest';

import {
  CREST_REFERENCE_METRES,
  HAZE_CONVERGE_END,
  HAZE_CONVERGE_START,
  WATER_OPTICS,
  columnTransmittance,
  crestGlow,
  seaHazeAmount,
} from './water-shading';

describe('water optics constants', () => {
  it('pins F0 to the IOR-derived water value, not the 0.04 dielectric guess', () => {
    // ((1 - 1.333) / (1 + 1.333))^2 = 0.02037. 0.04 is the generic-dielectric
    // value several water shaders carry; it doubles the head-on sky reflection
    // and is exactly the look of glossy plastic.
    const ior = 1.333;
    const expected = ((1 - ior) / (1 + ior)) ** 2;
    expect(WATER_OPTICS.F0).toBeCloseTo(expected, 3);
    expect(WATER_OPTICS.F0).toBeLessThan(0.03);
    expect(WATER_OPTICS.F0).toBeGreaterThan(0.015);
  });

  it('keeps every authored constant finite and non-negative', () => {
    for (const [key, value] of Object.entries(WATER_OPTICS)) {
      expect(Number.isFinite(value), key).toBe(true);
      expect(value, key).toBeGreaterThanOrEqual(0);
    }
    expect(CREST_REFERENCE_METRES).toBeGreaterThan(0);
  });
});

describe('seaHazeAmount — 远端强制收敛（地平线接缝）', () => {
  // 起因：指数雾在最远环只到 (1−exp(−1900×2.5e-4)) = 0.378，再乘 HAZE_MAX 0.55
  // 只剩 0.208——远海没 converge 到天空色，地平线就是一条硬线（那条橙色海天线）。
  it('reaches full haze at the outer ring so the horizon has no seam', () => {
    expect(seaHazeAmount(HAZE_CONVERGE_END)).toBeCloseTo(1, 3);
    expect(seaHazeAmount(1700)).toBeGreaterThan(0.85);
    expect(seaHazeAmount(1900)).toBeGreaterThan(seaHazeAmount(1200));
  });

  it('leaves the near water bit-identical to the old curve (below the converge start)', () => {
    for (const d of [0, 60, 128, 300, 512, HAZE_CONVERGE_START]) {
      const legacy = (1 - Math.exp(-d * WATER_OPTICS.HAZE_DENSITY_PER_METRE)) * WATER_OPTICS.HAZE_MAX;
      expect(seaHazeAmount(d), `d=${d}`).toBeCloseTo(legacy, 9);
    }
  });

  it('is monotone non-decreasing and finite everywhere, NaN reads as 0', () => {
    let prev = -1;
    for (let d = 0; d <= 2600; d += 25) {
      const v = seaHazeAmount(d);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(seaHazeAmount(Number.NaN)).toBe(0);
    expect(seaHazeAmount(-50)).toBe(0);
  });
});

describe('columnTransmittance', () => {
  const t = (h: number): number => columnTransmittance(h);

  it('is 1 at and above the crest reference', () => {
    expect(t(CREST_REFERENCE_METRES)).toBeCloseTo(1, 12);
    expect(t(CREST_REFERENCE_METRES + 5)).toBeCloseTo(1, 12);
  });

  it('falls monotonically with depth into the trough', () => {
    const heights = [0.3, 0.1, -0.1, -0.3, -0.45];
    for (let i = 1; i < heights.length; i += 1) {
      expect(t(heights[i])).toBeLessThan(t(heights[i - 1]));
    }
    // One swell spans most of the ramp: this is what replaced the flat bands.
    expect(t(0.45)).toBeCloseTo(1, 6);
    expect(t(-0.45)).toBeGreaterThan(0.1);
    expect(t(-0.45)).toBeLessThan(0.5);
  });

  it('stays inside (0, 1] so it can gate a colour without clipping', () => {
    for (let h = -3; h <= 3; h += 0.25) {
      const v = t(h);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('returns 0 for degenerate input instead of NaN', () => {
    expect(t(Number.NaN)).toBe(0);
    expect(columnTransmittance(0, Number.NaN)).toBe(0);
    expect(columnTransmittance(0, 0.45, Number.NaN)).toBe(0);
  });
});

describe('crestGlow', () => {
  it('is dark when the eye is on the far side of the wave', () => {
    expect(crestGlow(-0.5, 1)).toBe(0);
    expect(crestGlow(0, 1)).toBe(0);
  });

  it('grows with alignment toward the sun', () => {
    expect(crestGlow(0.9, 1)).toBeGreaterThan(crestGlow(0.4, 1));
    expect(crestGlow(1, 1)).toBeCloseTo(WATER_OPTICS.CREST_GAIN, 12);
  });

  it('is gated by the water column — no glow in a deep trough', () => {
    const crest = crestGlow(1, columnTransmittance(0.45));
    const trough = crestGlow(1, columnTransmittance(-0.45));
    expect(trough).toBeLessThan(crest * 0.5);
  });

  it('returns 0 for degenerate input', () => {
    expect(crestGlow(Number.NaN, 1)).toBe(0);
    expect(crestGlow(1, Number.NaN)).toBe(0);
  });
});
