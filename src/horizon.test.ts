import { describe, it, expect } from 'vitest';
import {
  HORIZON,
  antiSolarCool,
  awayHorizonLinear,
  clampSunElevation,
  fwhmDegOfGlow,
  horizonGlow,
  seaHazeTargetLinear,
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

/**
 * The anti-solar horizon tint. The stop ramp is one colour per elevation in every
 * direction, which left the sea's reflection a flat gold sheet and turned its
 * Fresnel falloff into a drawn line; this term is what makes the sky warm only
 * toward the sun. `sky-webgpu.ts` links the same expression in TSL.
 */
/**
 * The anti-solar horizon colour, DERIVED in linear space rather than frozen as
 * bytes: the sea's haze has to converge on exactly what the sky paints at its
 * own away-side edge, so both sides must compute the same mix. Pinning the
 * derivation (not a hex) is what keeps the sea-sky seam honest when AWAY_*
 * changes. Target: the away edge sits darker than the pre-2026-11-07 value
 * (linear luminance 0.210) — "背阳沉得深" without touching the sea's
 * reflection coefficients (review M5).
 */
describe('awayHorizonLinear', () => {
  it('derives mix(horizon, AWAY_COLOR, AWAY_GAIN) in linear space', () => {
    const [r, g, b] = awayHorizonLinear();
    // 0.25*lin(0xff) + 0.75*lin(0x5a) = 0.25*1.000 + 0.75*0.102 = 0.327
    expect(r).toBeCloseTo(0.327, 2);
    // 0.25*lin(0x9a) + 0.75*lin(0x3f) = 0.25*0.323 + 0.75*0.050 = 0.118
    expect(g).toBeCloseTo(0.118, 2);
    // 0.25*lin(0x5a) + 0.75*lin(0x60) = 0.25*0.103 + 0.75*0.117 = 0.114
    expect(b).toBeCloseTo(0.114, 2);
  });

  it('lands darker than the old away edge (linear luminance <= 0.17, was 0.210)', () => {
    const [r, g, b] = awayHorizonLinear();
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    expect(lum).toBeLessThanOrEqual(0.17);
  });
});

describe('antiSolarCool', () => {
  it('is zero toward the sun and strongest straight away from it', () => {
    expect(antiSolarCool(1, 0)).toBeCloseTo(0, 9);
    expect(antiSolarCool(-1, 0)).toBeCloseTo(HORIZON.AWAY_GAIN, 6);
  });

  it('falls off going up, and is gone by AWAY_HEIGHT', () => {
    const atHorizon = antiSolarCool(-1, 0);
    const halfway = antiSolarCool(-1, HORIZON.AWAY_HEIGHT * 0.5);
    expect(halfway).toBeLessThan(atHorizon);
    expect(halfway).toBeGreaterThan(0);
    expect(antiSolarCool(-1, HORIZON.AWAY_HEIGHT)).toBe(0);
    expect(antiSolarCool(-1, 0.9)).toBe(0);
  });

  it('stays inside its gain and refuses non-finite input', () => {
    for (const cosAz of [-1, -0.5, 0, 0.5, 1]) {
      for (const y of [-0.1, 0, 0.2, 0.6]) {
        const v = antiSolarCool(cosAz, y);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(HORIZON.AWAY_GAIN + 1e-9);
      }
    }
    expect(antiSolarCool(Number.NaN, 0)).toBe(0);
    expect(antiSolarCool(-1, Number.NaN)).toBe(0);
  });
});

/**
 * The sea's haze colour must converge on EXACTLY what the sky paints at its
 * edge for the same bearing — one application of AWAY_GAIN, not two (final
 * review, Important 1: mixing toward the pre-mixed `awayHorizonLinear()` with
 * a weight that already carries AWAY_GAIN lands at g² and cracks the seam the
 * moment HAZE_MAX or AWAY_GAIN is retuned).
 */
describe('seaHazeTargetLinear', () => {
  it('equals mix(HAZE, AWAY_lin, antiSolarCool(cosAz, 0)) at every bearing', () => {
    const decode = (hex: number): [number, number, number] => [
      ((hex >> 16) & 0xff) / 255,
      ((hex >> 8) & 0xff) / 255,
      (hex & 0xff) / 255,
    ].map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))) as [number, number, number];
    const haze = decode(0xff9a5a);
    const away = decode(0x5a3f60);
    for (const cosAz of [-1, -0.6, 0, 0.4, 1]) {
      const k = antiSolarCool(cosAz, 0);
      const [r, g, b] = seaHazeTargetLinear(cosAz);
      expect(r).toBeCloseTo((1 - k) * haze[0] + k * away[0], 9);
      expect(g).toBeCloseTo((1 - k) * haze[1] + k * away[1], 9);
      expect(b).toBeCloseTo((1 - k) * haze[2] + k * away[2], 9);
    }
  });

  it('at the away horizon it IS awayHorizonLinear (weight saturates to 1)', () => {
    const [r, g, b] = seaHazeTargetLinear(-1);
    const [er, eg, eb] = awayHorizonLinear();
    expect(r).toBeCloseTo(er, 9);
    expect(g).toBeCloseTo(eg, 9);
    expect(b).toBeCloseTo(eb, 9);
  });

  it('NaN bearing falls back to HAZE', () => {
    const [r, g, b] = seaHazeTargetLinear(Number.NaN);
    const [hr, hg, hb] = seaHazeTargetLinear(1);
    expect(r).toBeCloseTo(hr, 9);
    expect(g).toBeCloseTo(hg, 9);
    expect(b).toBeCloseTo(hb, 9);
  });
});
