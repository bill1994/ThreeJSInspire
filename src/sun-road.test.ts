import { describe, it, expect } from 'vitest';
import { SUN_ROAD, roadMask, sunRoadGain, azimuthDiff } from './sun-road';

const DEG = Math.PI / 180;

describe('roadMask', () => {
  it('is 1 under the sun and 0 outside the road width', () => {
    expect(roadMask(0)).toBeCloseTo(1, 6);
    expect(roadMask((SUN_ROAD.WIDTH_DEG + 5) * DEG)).toBe(0);
  });

  it('falls off monotonically and is NaN-safe', () => {
    let prev = 1.0001;
    for (let d = 0; d <= 80 * DEG; d += 2 * DEG) {
      const v = roadMask(d);
      expect(v).toBeLessThanOrEqual(prev);
      expect(v).toBeGreaterThanOrEqual(0);
      prev = v;
    }
    expect(roadMask(Number.NaN)).toBe(0);
  });
});

describe('azimuthDiff', () => {
  it('is zero looking straight at the sun and pi looking away', () => {
    expect(azimuthDiff(0, -1, 0, -1)).toBeCloseTo(0, 6);
    expect(azimuthDiff(0, -1, 0, 1)).toBeCloseTo(Math.PI, 6);
  });
});

describe('sunRoadGain', () => {
  it('rewards looking at the sun and cancels a dead specular', () => {
    expect(sunRoadGain(0.5, 0, 1)).toBeGreaterThan(sunRoadGain(0.5, 60 * DEG, 1));
    expect(sunRoadGain(0, 0, 1)).toBe(0);
  });

  it('keeps the near fade, so the deck does not sparkle underfoot', () => {
    expect(sunRoadGain(0.5, 0, 0)).toBe(0);
  });

  it('never exceeds the bare glint it is parameterising', () => {
    // The bloom threshold was tuned against the pre-T12 glitter (spec * BASE). A road that
    // multiplies the peak by 2.6 turns the sea into one smeared highlight and invalidates
    // that tuning, so the gate narrows the base instead of boosting it.
    const bare = 0.5 * SUN_ROAD.BASE;
    expect(sunRoadGain(0.5, 0, 1)).toBeCloseTo(bare, 6);
    expect(sunRoadGain(0.5, 60 * DEG, 1)).toBeLessThan(bare);
    expect(sunRoadGain(0.5, 60 * DEG, 1)).toBeGreaterThan(0); // still sparkles off-road
  });
});
