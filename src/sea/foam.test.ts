import { describe, expect, it } from 'vitest';

import { foamThresholdFromP95, jacobianSummed } from './foam';

describe('foam', () => {
  it('sums partials BEFORE taking the determinant', () => {
    // The classic FFT-ocean bug: per-cascade determinants multiplied together
    // are NOT the determinant of the summed displacement field.
    const a = { dxx: 0.3, dzz: 0.2, dxz: 0.1, dzx: 0.05 };
    const b = { dxx: -0.1, dzz: 0.4, dxz: -0.2, dzx: 0.15 };
    const summed = {
      dxx: a.dxx + b.dxx,
      dzz: a.dzz + b.dzz,
      dxz: a.dxz + b.dxz,
      dzx: a.dzx + b.dzx,
    };
    expect(jacobianSummed(summed)).not.toBeCloseTo(jacobianSummed(a) * jacobianSummed(b), 3);
  });

  it('is 1 on an undisturbed surface', () => {
    expect(jacobianSummed({ dxx: 0, dzz: 0, dxz: 0, dzx: 0 })).toBe(1);
  });

  it('drops below 1 where the surface compresses', () => {
    // dxx = dzz = −0.5 compresses both axes to 0.5·0.5.
    expect(jacobianSummed({ dxx: -0.5, dzz: -0.5, dxz: 0, dzx: 0 })).toBeCloseTo(0.25, 9);
  });

  it('derives the threshold from measured quantiles, not a literal', () => {
    const t = foamThresholdFromP95([0.01, 0.02, 0.05, 0.9]);
    expect(t).toBeGreaterThan(0.05);
    expect(t).toBeLessThan(0.9);
  });
});
