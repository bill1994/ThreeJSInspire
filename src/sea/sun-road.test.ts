import { describe, expect, it } from 'vitest';

import { SUN_ROAD, fresnel01, roadBudget, sunRoadGain } from './sun-road';

const DEG = Math.PI / 180;

describe('sun road', () => {
  it('concentrates gain under the sun and fades off-bearing', () => {
    expect(sunRoadGain(0.5, 0, 1)).toBeGreaterThan(sunRoadGain(0.5, 60 * DEG, 1));
  });

  it('is zero without specular or without near fade', () => {
    expect(sunRoadGain(0, 0, 1)).toBe(0);
    expect(sunRoadGain(0.5, 0, 0)).toBe(0);
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
