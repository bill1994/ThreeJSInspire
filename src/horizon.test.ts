import { describe, it, expect } from 'vitest';
import { HORIZON, horizonHaze, horizonGlow, sunDisc } from './horizon';
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

/**
 * The sun disc. `ref-01` has no hard disc at all, only glow, and the old
 * `pow(cos, 220)` gave a 9.09 deg diameter against a real sun's 0.53 (17x too big).
 * Getting to 0.53 deg needs `pow ~= 64000`, which underflows in the HalfFloat render
 * target, so the disc is expressed as an angle threshold instead of an exponent.
 */
describe('sunDisc', () => {
  const cosHalf = Math.cos((HORIZON.DISK_HALF_ANGLE_DEG * Math.PI) / 180);

  it('is full on-axis and gone outside the half angle', () => {
    expect(sunDisc(1, cosHalf)).toBe(1);
    expect(sunDisc(Math.cos((1.0 * Math.PI) / 180), cosHalf)).toBeLessThan(0.05);
    expect(sunDisc(0, cosHalf)).toBe(0);
  });

  it('fades to nothing exactly at the half angle, without dividing by zero', () => {
    // DISK_HALF_ANGLE_DEG is the OUTER edge of the disc: `1 - cosHalf` is the
    // denominator of the ramp, so the edge case is where a naive implementation
    // would produce a NaN or a step.
    const atEdge = sunDisc(cosHalf, cosHalf);
    expect(Number.isFinite(atEdge)).toBe(true);
    expect(atEdge).toBe(0);
  });

  it('refuses non-finite input', () => {
    expect(sunDisc(Number.NaN, cosHalf)).toBe(0);
    expect(sunDisc(1, Number.NaN)).toBe(0);
  });

  it('is sized like a real sun, not a 9 degree blob', () => {
    // 17x too big was the old bug; anything above ~1 deg diameter is a light source,
    // not a sun.
    expect(HORIZON.DISK_HALF_ANGLE_DEG).toBeGreaterThan(0.1);
    expect(HORIZON.DISK_HALF_ANGLE_DEG).toBeLessThan(0.6);
  });
});
