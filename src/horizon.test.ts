import { describe, it, expect } from 'vitest';
import { HORIZON, horizonHaze, horizonGlow } from './horizon';
import { SEA_FOLLOW_STEP, SEA_PATCH_SIZE } from './sea-fft';
import { FLIGHT } from './game';
import { CAM_HEIGHT } from './camera-rig';

describe('horizonHaze', () => {
  it('is cleanly attached at both ends', () => {
    expect(horizonHaze(0)).toBe(0);
    expect(horizonHaze(HORIZON.HAZE_NEAR)).toBe(0);
    expect(horizonHaze(HORIZON.HAZE_FAR)).toBe(1);
  });

  it('has saturated before the sea patch edge, worst snap lag included', () => {
    // The sea is snapped to whole SEA_FOLLOW_STEP periods, so the forward edge can sit only
    // (half patch - half step) away from the aircraft — the ideal 600 m corner never happens,
    // and testing it proved nothing about the shipped shader.
    const worstEdge = Math.hypot(
      SEA_PATCH_SIZE / 2 - SEA_FOLLOW_STEP / 2,
      FLIGHT.ALT_MAX + CAM_HEIGHT,
    );
    expect(worstEdge).toBeGreaterThan(HORIZON.HAZE_FAR);
    expect(horizonHaze(worstEdge)).toBe(1);
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
