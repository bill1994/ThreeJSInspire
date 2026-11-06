import { describe, it, expect } from 'vitest';
import {
  HORIZON,
  clampSunElevation,
  fwhmDegOfGlow,
  horizonGlow,
  sunDirectionFromAzEl,
  sunDisc,
} from './horizon';

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
    // 3 deg off-axis: comfortably outside the stylized 2 deg half-angle disc.
    expect(sunDisc(Math.cos((3.0 * Math.PI) / 180), cosHalf)).toBeLessThan(0.05);
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

  it('is sized like a stylized sun, about 4x the real 0.53 deg disc', () => {
    // This is a DELIBERATE stylization (plan Task 7), not a physical value: at
    // 720x1280 a true 0.53 deg disc is a handful of pixels and reads as a glitch,
    // so the disc is drawn ~4x real angular size (2 deg half-angle = 4 deg across).
    expect(HORIZON.DISK_HALF_ANGLE_DEG).toBeGreaterThan(1.5);
    expect(HORIZON.DISK_HALF_ANGLE_DEG).toBeLessThan(3.0);
  });
});

describe('live sun', () => {
  it('narrows the glow FWHM from 19.4 deg to at most 13 deg', () => {
    expect(fwhmDegOfGlow()).toBeLessThanOrEqual(13);
  });

  it('adds a stylized disc on top of the glow', () => {
    expect(HORIZON.DISK_GAIN).toBeGreaterThan(0);
    expect(HORIZON.DISK_HALF_ANGLE_DEG).toBeCloseTo(2.0, 1);
  });

  it('clamps elevation into the dusk band', () => {
    expect(clampSunElevation(0)).toBe(3);
    expect(clampSunElevation(90)).toBe(15);
    expect(clampSunElevation(6.97)).toBeCloseTo(6.97, 6);
  });

  it('builds a unit vector with azimuth 0 pointing down -Z', () => {
    const d = sunDirectionFromAzEl(0, 6.97);
    expect(Math.hypot(...d)).toBeCloseTo(1, 9);
    const atHorizon = sunDirectionFromAzEl(0, 0);
    expect(atHorizon[2]).toBeCloseTo(-1, 6);
    const east = sunDirectionFromAzEl(90, 0);
    expect(east[0]).toBeCloseTo(1, 6);
    const up = sunDirectionFromAzEl(0, 90);
    expect(up[1]).toBeCloseTo(1, 6);
  });
});
