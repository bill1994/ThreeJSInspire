import { describe, expect, it } from 'vitest';

import { perPixelRadians } from '../view-budget';
import { BAND_SPLIT_METRES, C1_VERTEX_MIP_LOD, CASCADES, LCM_METERS, REBASE_QUANTUM, SAMPLES_PER_WAVE, cascadeIsValid } from './cascades';

describe('cascades', () => {
  it('stays valid under the harshest angular budget (69° fov)', () => {
    // Review Focus 3: a FOV kick changes the budget; the tables must survive it.
    const rad69 = perPixelRadians(69, 1920);
    for (const c of CASCADES) expect(cascadeIsValid(c, rad69)).toBe(true);
  });

  it('splits the spectrum at one shared boundary, disjoint with no gap', () => {
    expect(BAND_SPLIT_METRES).toBe(128);
    expect(CASCADES[0].bandMetres[0]).toBe(BAND_SPLIT_METRES);
    expect(CASCADES[1].bandMetres[1]).toBe(BAND_SPLIT_METRES);
    expect(CASCADES[1].bandMetres[0]).toBe(32);
  });

  it('rebases on multiples of the combined period', () => {
    // Review Focus 2: a rebase quantum that is not a multiple of the LCM would
    // jump the whole surface at 10⁶ m where fp32 ulp = 0.0625 m.
    expect(LCM_METERS).toBe(3072);
    expect(REBASE_QUANTUM % LCM_METERS).toBe(0);
  });
});

describe('C1_VERTEX_MIP_LOD（细八度计划 Task 3：顶点位移 32 m 低通）', () => {
  it('公式 = log2((bandMetres[0]/4.878)/(tile/n))，≈3.1287；分子必须是 bandMetres[0]=32（不是 BAND_SPLIT_METRES=128）', () => {
    const lod = C1_VERTEX_MIP_LOD;
    const expected = Math.log2(
      (CASCADES[1].bandMetres[0] / SAMPLES_PER_WAVE) / (CASCADES[1].tileMetres / CASCADES[1].n),
    );
    expect(Math.abs(lod - expected)).toBeLessThan(1e-9);
    expect(lod).toBeCloseTo(3.1287, 3);
    // 与 BAND_SPLIT_METRES=128 代进去的 5.1287 互斥——公式断言与数值断言不许打架
    expect(lod).not.toBeCloseTo(5.1287, 3);
  });
});
