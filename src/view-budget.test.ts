import { describe, expect, it } from 'vitest';

import { CANONICAL_RAD_PER_PIXEL, perPixelRadians } from './view-budget';

describe('view budget', () => {
  it('derives the per-pixel angular budget from fov and buffer height', () => {
    expect(perPixelRadians(60, 1920)).toBeCloseTo(6.014065305516934e-4, 12);
    expect(perPixelRadians(69, 1920)).toBeGreaterThan(perPixelRadians(60, 1920));
    expect(perPixelRadians(60, 2880)).toBeLessThan(perPixelRadians(60, 1920));
  });

  it('is NaN on non-finite or non-positive inputs', () => {
    expect(Number.isNaN(perPixelRadians(Number.NaN, 1920))).toBe(true);
    expect(Number.isNaN(perPixelRadians(60, 0))).toBe(true);
    expect(Number.isNaN(perPixelRadians(60, -5))).toBe(true);
    expect(Number.isNaN(perPixelRadians(Infinity, 1920))).toBe(true);
    expect(Number.isNaN(perPixelRadians(0, 1920))).toBe(true);
  });

  it('pins the canonical portrait budget to 2tan(30°)/1920', () => {
    expect(CANONICAL_RAD_PER_PIXEL).toBe(perPixelRadians(60, 1920));
    expect(CANONICAL_RAD_PER_PIXEL).toBeGreaterThan(0);
  });
});
