import { describe, expect, it } from 'vitest';
import { PAINTED_SEA, paintedCrest, paintedHazeWeight, parseSeaLook, parseSeaDiagnostic, seaLookSettings } from './look';
import { paintedSunRoadGain, roadBudget } from './sun-road';

describe('painted sea acceptance contracts', () => {
  it('converges the far haze to the view bearing independently of wave normals', () => {
    for (const cos of [-1, -0.5, 0, 0.5, 1]) for (const lowSky of [0, 0.3, 1]) {
      const away = ((1-cos)*0.5)**1.2;
      expect(paintedHazeWeight(cos,lowSky,1900)).toBeCloseTo(away,12);
      expect(paintedHazeWeight(cos,lowSky,900)).toBeCloseTo(away*lowSky,12);
      for(const edge of [900,1900]) expect(Math.abs(
        paintedHazeWeight(cos,lowSky,edge+0.001)-paintedHazeWeight(cos,lowSky,edge-0.001)
      )).toBeLessThan(1e-8);
    }
    expect(paintedHazeWeight(NaN,0,1900)).toBe(0);
  });
  it('keeps the candidate opt-in and diagnostic changes isolated', () => {
    for (const v of [null, '', 'unknown', 'PAINTED']) expect(parseSeaLook(v)).toBe('legacy');
    expect(parseSeaLook('painted')).toBe('painted');
    expect(parseSeaDiagnostic('bad')).toBe('none');
    const base = seaLookSettings('legacy');
    for (const d of ['detail', 'fine', 'slope', 'reflection', 'road', 'foam'] as const) {
      const settings = seaLookSettings('legacy', d);
      expect(Object.keys(base).filter(k => base[k as keyof typeof base] !== settings[k as keyof typeof base])).toHaveLength(1);
    }
  });
  it('has a bounded, monotonic and continuous crest transition at all footprints', () => {
    for (const aa of [0, 0.01, 0.2, 2]) {
      let previous = 0;
      for (let h = -3; h <= 3; h += 0.001) {
        const value = paintedCrest(h, aa);
        expect(value).toBeGreaterThanOrEqual(previous);
        expect(value).toBeLessThanOrEqual(1);
        expect(value - previous).toBeLessThan(0.004);
        previous = value;
      }
      for (const edge of [PAINTED_SEA.crestLow-aa, PAINTED_SEA.crestHigh+aa]) {
        expect(Math.abs(paintedCrest(edge+1e-6, aa)-paintedCrest(edge-1e-6, aa))).toBeLessThan(1e-5);
      }
    }
    expect(paintedCrest(NaN, 0)).toBe(0);
    expect(paintedCrest(0, Infinity)).toBe(0);
  });
  it('keeps the whole road below both tier budgets even at full speed and mirror alignment', () => {
    for (const tier of ['high', 'low'] as const) for (const speed of [0, 0.5, 1])
      for (const aa of [0, 0.001, 0.1]) for (const az of [0, 0.2, 1, Math.PI]) {
        let previous = 0;
        for (let i = 0; i <= 1000; i++) {
          const v = paintedSunRoadGain(i/1000, az, 1, tier, speed, aa);
          expect(v).toBeGreaterThanOrEqual(previous);
          expect(v).toBeLessThan(roadBudget(tier));
          previous = v;
        }
      }
    expect(paintedSunRoadGain(1, 0, 0)).toBe(0);
    expect(paintedSunRoadGain(NaN, 0, 1)).toBe(0);
    expect(paintedSunRoadGain(1, NaN, 1)).toBe(0);
    expect(paintedSunRoadGain(1, 0, 1)).toBeGreaterThan(2 * paintedSunRoadGain(1, Math.PI, 1));
  });
});
