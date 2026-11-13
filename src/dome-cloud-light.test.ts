import { describe, expect, it } from 'vitest';

import {
  hgPhase,
  marchTransmittance,
  powder,
  shadeSunAndAmbient,
  transmittance,
} from './dome-cloud-light';
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

describe('marchTransmittance — P1.5 三采样 light march', () => {
  it('sums optical depth over taps', () => {
    expect(marchTransmittance([0.5, 0.5, 0.5], 40, 0.038)).toBeCloseTo(
      Math.exp(-3 * 0.5 * 40 * 0.038), 6,
    );
    expect(marchTransmittance([], 40, 0.038)).toBe(1); // 空区跳过即透过率 1
  });

  it('stays finite and positive for bad samples — no NaN black blocks', () => {
    // 非有限/负密度采样当「无遮挡」跳过（与 transmittance 的宁可过亮约定一致）。
    expect(marchTransmittance([Number.NaN, 0.5], 40, 0.038)).toBeCloseTo(
      Math.exp(-0.5 * 40 * 0.038), 6,
    );
    expect(marchTransmittance([0.5, 0.5], Number.NaN, 0.038)).toBe(1);
    expect(marchTransmittance([0.5], -40, 0.038)).toBe(1);
  });
});

// sunColorFor 的测试已随 2026-11-14 搬家迁入 src/sun-color.test.ts。