import { describe, it, expect } from 'vitest';
import {
  BANDS,
  LOW_TIER_TRAINS,
  SEA_HYSTERESIS_M,
  SEGMENT_LOW_SCALE,
  bandVisible,
  nextVisibilityMask,
  perPixelRadians,
  trainDistance,
} from './lod';

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

  it('band boundaries are contiguous: each inner edge equals the previous outer edge', () => {
    // Extents only: each band's extent begins exactly where the previous one ends. The annuli
    // also abut in each band's own frame (every `inner` is a whole number of its own cells), but
    // their world-space placement is a tow question this test does not see — see `bands.ts`.
    expect(BANDS[0].inner).toBe(0);
    for (let i = 1; i < BANDS.length; i++) expect(BANDS[i].inner).toBe(BANDS[i - 1].outer);
  });

  it('lands every annulus hole exactly on `inner`, so no seam overlaps', () => {
    // `bands.ts` cuts at `floor(inner / cell) * cell`. That equals `inner` for every row here,
    // which is the claim that let Task 4b change the table and no geometry code. Asserted
    // literally — the arithmetic, exercised the way the builder exercises it: the quotient must
    // be an integer, and floor-then-multiply must return `inner` for that same row.
    for (const b of BANDS) {
      expect(Number.isInteger(b.inner / b.cell)).toBe(true);
      expect(Math.floor(b.inner / b.cell) * b.cell).toBe(b.inner);
    }
    // ...and pinned, because 576 / 96 = 6 is what makes b5's hole exact despite its cell
    // not nesting in b4's.
    expect(BANDS.map((b) => b.inner / b.cell)).toEqual([0, 10, 19, 14, 11, 6]);
  });

  it('band cells are multiples of the innermost cell (shared lattice)', () => {
    // B5 is exempt from *this* assertion, not from stitching: it is flat, so it displaces
    // nothing and has no finest train to sample, which is why the loop stops at 5. Its 96 m
    // cell is not a multiple of b4's 36 m (96 / 36 = 2.67), so that seam is a T-junction at
    // every vertex rather than a weld — Task 4c's problem, not this table's.
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

describe('nextVisibilityMask', () => {
  it('applies 10 m of hysteresis so a dive cannot flicker a band', () => {
    const rp = 5.797e-4; // B0's finest train (11 m, 0.06) is sub-pixel past 103.5 m
    const all = [true, true, true, true, true, true];
    // still on: 100 < 103.5 + 10
    expect(nextVisibilityMask(all, rp, 100)[0]).toBe(true);
    // turns off above 103.5 + 10 = 113.5
    const off = nextVisibilityMask(all, rp, 120);
    expect(off[0]).toBe(false);
    // stays off coming back down until below 103.5 - 10 = 93.5
    expect(nextVisibilityMask(off, rp, 100)[0]).toBe(false);
    expect(nextVisibilityMask(off, rp, 90)[0]).toBe(true);
  });

  it('keeps the flat band always drawn', () => {
    expect(nextVisibilityMask(BANDS.map(() => true), 5.797e-4, 240)[5]).toBe(true);
    // ...even when its previous state claims otherwise, which it never should.
    expect(nextVisibilityMask(BANDS.map(() => false), 5.797e-4, 240)[5]).toBe(true);
  });

  it('is pure: same prev and inputs give the same mask, and prev is untouched', () => {
    const prev = BANDS.map(() => true);
    const snapshot = [...prev];
    const a = nextVisibilityMask(prev, 5.797e-4, 120);
    const b = nextVisibilityMask(prev, 5.797e-4, 120);
    expect(a).toEqual(b);
    expect(a).not.toBe(prev);
    expect(a.length).toBe(BANDS.length);
    expect(prev).toEqual(snapshot);
  });

  it('splits the raw threshold through the middle of the dead band', () => {
    const rp = 5.797e-4;
    const d = trainDistance(0.06, rp); // 103.5 m: B0's finest train
    const on = BANDS.map(() => true);
    const off = BANDS.map(() => false);
    // Past the raw threshold, an already-on band survives: that is the whole point.
    expect(nextVisibilityMask(on, rp, d + 1)[0]).toBe(true);
    // An already-off band does not re-enter until it is a full 10 m inside.
    expect(nextVisibilityMask(off, rp, d - 1)[0]).toBe(false);
    expect(nextVisibilityMask(off, rp, d - 11)[0]).toBe(true);
  });

  it('drops the near bands and keeps the far ones at altitude', () => {
    const rp = 5.797e-4;
    // At 240 m: B0 (103.5) and B1 (172.5) are sub-pixel, B2 (258.8) is not.
    expect(nextVisibilityMask(BANDS.map(() => true), rp, 240)).toEqual([
      false,
      false,
      true,
      true,
      true,
      true,
    ]);
  });

  it('keeps every band when the budget or altitude is unusable', () => {
    const off = BANDS.map(() => false);
    const all = BANDS.map(() => true);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(nextVisibilityMask(off, bad, 240)).toEqual(all);
    }
    expect(nextVisibilityMask(off, 5.797e-4, Number.NaN)).toEqual(all);
  });

  it('pins the dead band at 10 m', () => {
    expect(SEA_HYSTERESIS_M).toBe(10);
  });

  it('reads an absent prev entry as off, never as on', () => {
    const rp = 5.797e-4;
    // Inside the dead band the two readings differ, and an absent entry must take the
    // conservative side: a stale "on" is the flicker, a stale "off" is a triangle saved.
    expect(nextVisibilityMask([], rp, 100)[0]).toBe(false);
    expect(nextVisibilityMask([true], rp, 100)[0]).toBe(true);
  });
});

describe('tier constants', () => {
  it('pins the low tier to half the segments and the three longest trains', () => {
    expect(SEGMENT_LOW_SCALE).toBe(0.5);
    expect(LOW_TIER_TRAINS).toBe(3);
  });
});
