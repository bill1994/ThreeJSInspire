import { describe, expect, it } from 'vitest';

import { hgPhase, powder, shadeSunAndAmbient, sunColorFor, transmittance } from './dome-cloud-light';
import { srgbToLinear } from './sky-track';

describe('transmittance', () => {
  it('is 1 with no extinction', () => {
    expect(transmittance(0, 100)).toBe(1);
  });

  it('decays with distance', () => {
    expect(transmittance(0.1, 10)).toBeCloseTo(Math.exp(-1), 6);
    expect(transmittance(0.1, 20)).toBeLessThan(transmittance(0.1, 10));
  });
});

describe('hgPhase', () => {
  it('is isotropic 1/4 pi at g = 0', () => {
    expect(hgPhase(0.3, 0)).toBeCloseTo(1 / (4 * Math.PI), 6);
  });

  it('peaks in the forward lobe', () => {
    expect(hgPhase(1, 0.6)).toBeGreaterThan(hgPhase(0, 0.6));
  });

  it('is finite for every valid cosine', () => {
    for (const c of [-1, -0.5, 0, 0.5, 1]) {
      expect(Number.isFinite(hgPhase(c, 0.6))).toBe(true);
    }
  });
});

describe('powder', () => {
  it('is zero at zero density and approaches one when dense', () => {
    expect(powder(0, 1)).toBeCloseTo(0, 6);
    expect(powder(50, 1)).toBeGreaterThan(0.99);
  });
});

describe('shadeSunAndAmbient', () => {
  it('leaves ambient alone when the sun is fully occluded', () => {
    const out = shadeSunAndAmbient({
      sunColor: [1, 1, 1],
      ambient: [0.2, 0.3, 0.5],
      sigmaT: 100,
      lightDistance: 100,
      cosTheta: 1,
      density: 1,
    });
    expect(out[0]).toBeCloseTo(0.2, 3);
    expect(out[1]).toBeCloseTo(0.3, 3);
    expect(out[2]).toBeCloseTo(0.5, 3);
  });

  it('stays finite under the real night palette', () => {
    // 直接取 sky-track 的真值，别手算近似。
    const night = srgbToLinear('#26304f');
    const out = shadeSunAndAmbient({
      sunColor: [0, 0, 0],
      ambient: night,
      sigmaT: 0.4,
      lightDistance: 30,
      cosTheta: -0.2,
      density: 0.05,
    });
    for (const c of out) {
      expect(Number.isFinite(c)).toBe(true);
      expect(c).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('sunColorFor — I1', () => {
  it('is warm near the horizon and neutral high up', () => {
    const low = sunColorFor(2);
    const high = sunColorFor(60);
    expect(low[0]).toBeGreaterThan(low[2]);
    expect(high[2]).toBeGreaterThan(low[2]);
  });

  it('stays finite and non-negative everywhere, including below the horizon', () => {
    for (const e of [-30, 0, 15, 45, 90, Number.NaN]) {
      for (const c of sunColorFor(e)) {
        expect(Number.isFinite(c)).toBe(true);
        expect(c).toBeGreaterThanOrEqual(0);
      }
    }
  });
});