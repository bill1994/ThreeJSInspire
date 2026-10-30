import { describe, it, expect } from 'vitest';
import { SUN_ROAD, roadMask, sunRoadGain, azimuthDiff, slope01, specExponent, fresnel01 } from './sun-road';

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

describe('slope01 / specExponent', () => {
  it('reads flat water as zero slope and saturates at SLOPE_FULL', () => {
    expect(slope01(1)).toBe(0);
    expect(slope01(1 - SUN_ROAD.SLOPE_FULL)).toBeCloseTo(1, 6);
    expect(slope01(0)).toBe(1); // steeper than SLOPE_FULL clamps, never overshoots
    expect(slope01(Number.NaN)).toBe(0);
  });

  it('moves the exponent from mirror-narrow to broad as the facet tilts', () => {
    // One exponent for the whole patch made the glitter a uniform speckle field. Flat facets
    // keep the tuned 96; steep ones broaden toward 26 so the road gains a gradient.
    expect(specExponent(0)).toBe(SUN_ROAD.NARROW);
    expect(specExponent(1)).toBe(SUN_ROAD.BROAD);
    expect(specExponent(0.5)).toBeCloseTo((SUN_ROAD.NARROW + SUN_ROAD.BROAD) / 2, 6);
    expect(specExponent(Number.NaN)).toBe(SUN_ROAD.NARROW);
    expect(SUN_ROAD.BROAD).toBeLessThan(SUN_ROAD.NARROW);
  });

  it('broadens monotonically, so a steeper facet never gets a tighter highlight', () => {
    let prev = Infinity;
    for (let s = 0; s <= 1; s += 0.05) {
      const e = specExponent(s);
      expect(e).toBeLessThanOrEqual(prev);
      prev = e;
    }
  });
});

describe('fresnel01', () => {
  it('is F0 head-on and approaches 1 at grazing incidence', () => {
    expect(fresnel01(1)).toBeCloseTo(SUN_ROAD.F0, 6);
    expect(fresnel01(0)).toBeCloseTo(1, 6);
  });

  it('rises monotonically as the view angle shallows', () => {
    let prev = 0;
    for (let c = 1; c >= 0; c -= 0.02) {
      const f = fresnel01(c);
      expect(f).toBeGreaterThanOrEqual(prev);
      expect(f).toBeLessThanOrEqual(1);
      prev = f;
    }
    expect(fresnel01(Number.NaN)).toBeCloseTo(SUN_ROAD.F0, 6);
  });
});
