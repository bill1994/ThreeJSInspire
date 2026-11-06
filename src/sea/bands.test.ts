import { describe, expect, it } from 'vitest';

import { perPixelRadians } from '../view-budget';
import { SEA_BAND_THRESHOLDS, bandIndexFromHeight, detailWeight } from './bands';

const T = SEA_BAND_THRESHOLDS;

describe('bands', () => {
  it('maps height to four monotonic bands', () => {
    expect(bandIndexFromHeight(-1, T)).toBe(0);
    expect(bandIndexFromHeight(T[0] - 0.001, T)).toBe(0);
    expect(bandIndexFromHeight(T[0], T)).toBe(1);
    expect(bandIndexFromHeight(T[1], T)).toBe(2);
    expect(bandIndexFromHeight(T[2], T)).toBe(3);
    expect(bandIndexFromHeight(1, T)).toBe(3);
  });

  it('gates detail normals by screen-space footprint', () => {
    const rad = perPixelRadians(60, 1920);
    // Review Focus 1: sun-road specular point at 57 m — a 1.6 cm texel covers
    // 0.47 px there, so the detail normal must vanish or the road turns to noise.
    expect(detailWeight(0.016, 57, rad)).toBe(0);
    expect(detailWeight(0.016, 5, rad)).toBe(1);
    expect(detailWeight(0.016, 20, rad)).toBeGreaterThan(0);
    expect(detailWeight(0.016, 20, rad)).toBeLessThan(1);
  });

  it('refuses non-finite or degenerate inputs', () => {
    expect(detailWeight(0.016, 57, Number.NaN)).toBe(0);
    expect(detailWeight(0.016, 0, perPixelRadians(60, 1920))).toBe(0);
    expect(detailWeight(Number.NaN, 5, perPixelRadians(60, 1920))).toBe(0);
  });
});
