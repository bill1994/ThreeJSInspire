import { describe, it, expect } from 'vitest';
import { HORIZON, horizonHaze, horizonGlow } from './horizon';

describe('horizonHaze', () => {
  it('is cleanly attached at both ends', () => {
    expect(horizonHaze(0)).toBe(0);
    expect(horizonHaze(HORIZON.HAZE_NEAR)).toBe(0);
    expect(horizonHaze(HORIZON.HAZE_FAR)).toBe(1);
  });

  it('has saturated before the sea patch ends, at every reachable altitude', () => {
    const seaEdgeAtCeiling = Math.hypot(600, 240); // SEA_PATCH_SIZE/2, FLIGHT.ALT_MAX
    expect(seaEdgeAtCeiling).toBeGreaterThan(HORIZON.HAZE_FAR);
    expect(horizonHaze(seaEdgeAtCeiling)).toBe(1);
  });

  it('is NaN-safe so a bad camera frame cannot paint the sea sky-coloured', () => {
    expect(horizonHaze(Number.NaN)).toBe(0);
    let prev = -1;
    for (let d = 0; d <= 700; d += 10) {
      const v = horizonHaze(d);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('horizonGlow', () => {
  it('peaks at the sun and vanishes away from it', () => {
    expect(horizonGlow(1)).toBeCloseTo(HORIZON.GLOW_GAIN, 6);
    expect(horizonGlow(0)).toBe(0);
    expect(horizonGlow(Number.NaN)).toBe(0);
  });
});
