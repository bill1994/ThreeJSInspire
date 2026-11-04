import { describe, it, expect } from 'vitest';
import { HORIZON, CLOUD_HAZE, cloudHaze, domeCloudHaze, horizonHaze, horizonGlow, sunDisc } from './horizon';
import { FLIGHT } from './game';
import { CAM_HEIGHT } from './camera-rig';

describe('horizonHaze', () => {
  it('is cleanly attached at both ends', () => {
    expect(horizonHaze(0)).toBe(0);
    expect(horizonHaze(HORIZON.HAZE_NEAR)).toBe(0);
    expect(horizonHaze(HORIZON.HAZE_FAR)).toBe(1);
  });

  it('has saturated before the far edge, worst snap lag included', () => {
    // Frozen from the deleted sea-fft.ts (PATCH 1600, FOLLOW_STEP 400): the forward
    // edge could sit (half patch - half step) = 600 m from the aircraft. The sea is
    // gone on reconstruct, but the haze-saturates-before-the-edge property still
    // stands — the rebuild reinstates the real constants.
    const worstEdge = Math.hypot(600, FLIGHT.ALT_MAX + CAM_HEIGHT);
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

describe('cloudHaze', () => {
  it('leaves the near field alone and saturates at the far end', () => {
    expect(cloudHaze(0)).toBe(0);
    expect(cloudHaze(CLOUD_HAZE.NEAR)).toBe(0);
    expect(cloudHaze(CLOUD_HAZE.FAR)).toBeCloseTo(CLOUD_HAZE.MAX, 10);
    expect(cloudHaze(5000)).toBeCloseTo(CLOUD_HAZE.MAX, 10);
  });

  it('reaches full haze before the puff field wraps, so the respawn cannot pop', () => {
    // far-field.ts rewraps a tower from planeZ+120 to planeZ-880: that is the furthest a
    // visible puff can be, and it must already be at the asymptote or the leagues of
    // contrast snap back in one frame.
    expect(CLOUD_HAZE.FAR).toBeLessThan(880);
    expect(cloudHaze(880)).toBeCloseTo(CLOUD_HAZE.MAX, 10);
  });

  it('is monotone and never overshoots its cap', () => {
    let prev = -1;
    for (let d = 0; d <= 1000; d += 5) {
      const v = cloudHaze(d);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(CLOUD_HAZE.MAX + 1e-9);
      prev = v;
    }
  });

  it('refuses non-finite input', () => {
    expect(cloudHaze(Number.NaN)).toBe(0);
    expect(cloudHaze(Number.POSITIVE_INFINITY)).toBe(0);
    expect(cloudHaze(500, Number.NaN)).toBe(0);
  });
});

describe('domeCloudHaze', () => {
  it('hazes the base and clears the crown at the same distance', () => {
    // The dome is one fixed sphere: 780 m both places. Only the angle tells them apart.
    const base = domeCloudHaze(0.02, 780);
    const crown = domeCloudHaze(0.8, 780);
    expect(base).toBeGreaterThan(0.4);
    expect(crown).toBe(0);
  });

  it('keeps the dome under its own smaller cap', () => {
    // The lit crowns are held to ΔL* 15 over the sky behind them; a dome-wide MAX would
    // spend most of that budget on the silhouette.
    expect(CLOUD_HAZE.DOME_MAX).toBeLessThan(CLOUD_HAZE.MAX);
    expect(domeCloudHaze(0, 780)).toBeLessThanOrEqual(CLOUD_HAZE.DOME_MAX + 1e-9);
  });

  it('falls off monotonically with elevation and is NaN-safe', () => {
    let prev = Number.POSITIVE_INFINITY;
    for (let y = -1; y <= 1.0001; y += 0.02) {
      const v = domeCloudHaze(y, 780);
      expect(v).toBeLessThanOrEqual(prev + 1e-9);
      prev = v;
    }
    expect(domeCloudHaze(Number.NaN, 780)).toBe(0);
    expect(domeCloudHaze(0.1, Number.NaN)).toBe(0);
  });
});
