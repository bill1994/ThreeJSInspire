import { describe, expect, it } from 'vitest';

import { perPixelRadians } from '../view-budget';
import { BAND_SPLIT_METRES, CASCADES, LCM_METERS, REBASE_QUANTUM, cascadeIsValid } from './cascades';

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
