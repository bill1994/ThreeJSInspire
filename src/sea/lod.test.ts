import { describe, it, expect } from 'vitest';
import { BANDS, LOW_TIER_TRAINS, SEGMENT_LOW_SCALE, bandVisible, perPixelRadians, trainDistance } from './lod';

describe('perPixelRadians', () => {
  it('uses the rectilinear projection, not the linear approximation', () => {
    // 2*tan(30 deg)/1920 = 1.154700/1920
    expect(perPixelRadians(60, 1920)).toBeCloseTo(6.014e-4, 6);
    expect(perPixelRadians(69, 1920)).toBeGreaterThan(perPixelRadians(60, 1920));
    expect(perPixelRadians(60, 996)).toBeCloseTo(1.1594e-3, 6);
  });

  it('falls back to the canonical budget for a degenerate buffer', () => {
    // A missing size must size the mesh for the most demanding case, never for zero.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(perPixelRadians(60, bad)).toBeCloseTo(6.014e-4, 6);
    }
  });
});

describe('BANDS', () => {
  it('every band cell satisfies the direction-aware rule for its finest train', () => {
    // 0.205 * lambda, wave travels along WIND (0.82, -0.57)
    const LAMBDA = [180, 90, 45, 22, 11];
    for (const b of BANDS) {
      if (b.trains === 0) continue;
      const finest = LAMBDA[b.trains - 1];
      expect(b.cell).toBeLessThanOrEqual(0.205 * finest + 1e-9);
    }
  });

  it('bands tile without gaps or overlaps', () => {
    expect(BANDS[0].inner).toBe(0);
    for (let i = 1; i < BANDS.length; i++) expect(BANDS[i].inner).toBe(BANDS[i - 1].outer);
  });

  it('band cells are multiples of the innermost cell (shared lattice)', () => {
    // B5 is flat and exempt: it carries no displacement, so it needs no skirt lattice.
    for (const b of BANDS.slice(0, 5)) {
      expect(b.cell / BANDS[0].cell).toBeCloseTo(Math.round(b.cell / BANDS[0].cell), 9);
    }
  });

  it('divides each side exactly into its cell', () => {
    for (const b of BANDS) {
      expect((2 * b.outer) / b.segments).toBeCloseTo(b.cell, 9);
    }
  });
});

describe('trainDistance', () => {
  it('trainDistance scales inversely with the pixel angle', () => {
    expect(trainDistance(0.34, 5.797e-4)).toBeCloseTo(586.5, 1);
    expect(trainDistance(0.06, 5.797e-4)).toBeCloseTo(103.5, 1);
  });
});

describe('bandVisible', () => {
  it('a band is invisible when its finest train is sub-pixel everywhere in it', () => {
    const rp = 5.797e-4;
    // B0's finest train (11 m, 0.06) is sub-pixel beyond 103.5 m, so at 240 m altitude B0 is skippable
    expect(bandVisible(BANDS[0], rp, 240)).toBe(false);
    expect(bandVisible(BANDS[0], rp, 7)).toBe(true);
    expect(bandVisible(BANDS[5], rp, 240)).toBe(true); // the flat band is always drawn
  });

  it('keeps the band when the budget is unusable, rather than opening a hole', () => {
    for (const bad of [0, Number.NaN]) {
      expect(bandVisible(BANDS[0], bad, 240)).toBe(true);
    }
  });
});

describe('tier constants', () => {
  it('pins the low tier to half the segments and the three longest trains', () => {
    expect(SEGMENT_LOW_SCALE).toBe(0.5);
    expect(LOW_TIER_TRAINS).toBe(3);
  });
});
