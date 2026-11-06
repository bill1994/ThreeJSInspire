import { describe, expect, it } from 'vitest';

import { RINGS, ringHoleCells, ringTriangleCount, ringIsValid } from './rings';

describe('rings', () => {
  it('resolves its frequency floor at ~5 samples per wavelength', () => {
    for (const r of RINGS) expect(ringIsValid(r)).toBe(true);
  });

  it('derives segs from the half-width convention', () => {
    for (const r of RINGS) expect(r.segs).toBe(Math.round((2 * r.outer) / r.cell));
  });

  it('overlaps the previous ring by at least one cell', () => {
    // The hole is inset one cell before `inner`, so the overlap test is on the
    // inset, not the raw inner — inner === prev.outer is exactly tangent.
    for (let i = 1; i < RINGS.length; i += 1) {
      expect(RINGS[i].inner - RINGS[i].cell).toBeLessThan(RINGS[i - 1].outer);
    }
  });

  it('counts 7496 triangles after hole culling', () => {
    expect(ringTriangleCount()).toBe(7496);
  });

  it('culls the square hole', () => {
    expect(ringHoleCells(RINGS[0])).toBe(0);
    expect(ringHoleCells(RINGS[1])).toBe(100);
    expect(ringHoleCells(RINGS[2])).toBe(64);
    expect(ringHoleCells(RINGS[3])).toBe(225);
  });
});
