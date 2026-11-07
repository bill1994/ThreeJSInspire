import { describe, expect, it } from 'vitest';

import {
  SUN_ROAD,
  fresnel01,
  roadBudget,
  roadSpecKnee,
  sparkleGlint,
  sunRoadGain,
} from './sun-road';

const DEG = Math.PI / 180;

describe('sun road', () => {
  it('concentrates gain under the sun and fades off-bearing', () => {
    // New semantics (plan v2 Task 2): the first argument is the per-pixel
    // specDot (dot(reflect(sun, N), V)), raised to GLOSS_POW inside.
    expect(sunRoadGain(1, 0, 1)).toBeGreaterThan(sunRoadGain(1, 60 * DEG, 1));
  });

  it('is zero without specular or without near fade', () => {
    expect(sunRoadGain(0, 0, 1)).toBe(0);
    expect(sunRoadGain(1, 0, 0)).toBe(0);
  });

  it('grazes brighter than head-on (Schlick)', () => {
    expect(fresnel01(1)).toBeLessThan(fresnel01(0));
  });

  it('keeps each tier one K4 margin under its own bloom threshold', () => {
    expect(roadBudget('high')).toBeCloseTo(0.82 - 0.063, 3);
    expect(roadBudget('low')).toBeCloseTo(0.85 - 0.063, 3);
    expect(roadBudget('low')).toBeGreaterThan(roadBudget('high'));
  });

  it('starts with the tiers aligned until measurement says otherwise', () => {
    // Step 6: a per-tier gain is only introduced when the two measured road
    // brightnesses diverge by more than 10%.
    expect(SUN_ROAD.lowTierGain).toBe(1.0);
  });
});

describe('roadSpecKnee', () => {
  it('is monotone, maps 0 to 0, and saturates inside (0.999, 1]', () => {
    expect(roadSpecKnee(0, 1)).toBe(0);
    expect(roadSpecKnee(2, 1)).toBeGreaterThan(roadSpecKnee(1, 1));
    // 1 - exp(-500) === 1 exactly in float64 (exp(-500) is ~7e-218, far below
    // the eps of 1.0) — asserting "< 1" there would demand a fake ceiling.
    const top = roadSpecKnee(500, 1);
    expect(top).toBeGreaterThan(0.999);
    expect(top).toBeLessThanOrEqual(1);
  });

  it('maps NaN to 0 — a degenerate value must not poison the colour', () => {
    expect(roadSpecKnee(Number.NaN, 1)).toBe(0);
  });
});

describe('budget and contrast (review 5.3)', () => {
  it('keeps the continuous road under ROAD_CEILING for any input', () => {
    expect(sunRoadGain(1, 0, 1)).toBeLessThanOrEqual(SUN_ROAD.ROAD_CEILING + 1e-9);
  });

  it('keeps the road a peak over its surround, ratio >= 2.5', () => {
    // KNEE_K = 0.8 lands this at 2.65. The pre-knee 5.7x WAS the budget
    // violation; 2.1x (k = 1.2) let the azimuth gate go flat — 2.5 is the
    // explicit decision point from the plan review.
    const road = sunRoadGain(1, 0, 1);
    const off = sunRoadGain(1, SUN_ROAD.WIDTH_DEG * 3 * DEG, 1);
    expect(road / off).toBeGreaterThanOrEqual(2.5);
  });

  it('lifts sparkle cores into (0.82, 1.05) — lerp form, only cores bloom', () => {
    const core = sparkleGlint(sunRoadGain(1, 0, 1), 1);
    expect(core).toBeGreaterThan(0.82); // over the bloom threshold on purpose
    expect(core).toBeLessThan(1.05); // but never through the channel
  });

  it('adds no sparkle below the cos threshold', () => {
    const cont = sunRoadGain(1, 0, 1);
    expect(sparkleGlint(cont, SUN_ROAD.GLINT_COS_THRESHOLD - 1e-6)).toBeCloseTo(cont, 9);
  });

  it('multiplies the core by the road gate (QA round 1: off-road glints unphysical)', () => {
    const cont = 0.5;
    expect(sparkleGlint(cont, 1, 0)).toBeCloseTo(cont, 9);
    expect(sparkleGlint(cont, 1, 1)).toBeCloseTo(cont * SUN_ROAD.SPARKLE_BOOST, 9);
  });

  it('exposes the shared constants the graph links', () => {
    expect(SUN_ROAD.ROAD_CEILING).toBeCloseTo(roadBudget('high'), 9);
    expect(SUN_ROAD.GLOSS_POW).toBe(96);
    expect(SUN_ROAD.SPARKLE_BOOST).toBe(1.3);
    expect(SUN_ROAD.GLINT_COS_THRESHOLD).toBeGreaterThan(0.99);
    expect(SUN_ROAD.GLINT_COS_BAND).toBeLessThan(0.01);
  });
});
