import { describe, expect, it } from 'vitest';
import { PAINTED_SEA, paintedCrest, paintedHazeWeight, paintedMarks, paintedLightWeights, paintedRippleWeights, parseSeaLook, parseSeaDiagnostic, seaLookSettings } from './look';
import { paintedSunRoadGain, roadBudget } from './sun-road';

describe('painted sea acceptance contracts', () => {
  it('keeps ripple strokes on shoulders and suppresses distant subpixel detail', () => {
    expect(paintedRippleWeights(0, 0, 100)).toEqual({ light: 0, dark: 0 });
    expect(paintedRippleWeights(0.04, 0, 100)).toEqual({ light: 1, dark: 0 });
    expect(paintedRippleWeights(-0.04, 0, 100)).toEqual({ light: 0, dark: PAINTED_SEA.rippleShadow });
    expect(paintedRippleWeights(0.04, 0.02, 100).light).toBe(0);
    expect(paintedRippleWeights(0.04, 0, 1100).light).toBe(0);
    expect(paintedRippleWeights(0.04, 0, 100, 0.1).light).toBeLessThan(0.2);
    expect(paintedRippleWeights(NaN, 0, 100)).toEqual({ light: 0, dark: 0 });
    for (const edge of PAINTED_SEA.rippleFade) {
      expect(Math.abs(paintedRippleWeights(0.04, 0, edge - 0.001).light -
        paintedRippleWeights(0.04, 0, edge + 0.001).light)).toBeLessThan(1e-7);
    }
  });
  it('places whitecaps on curved crests and fades their distant coverage', () => {
    expect(paintedMarks(0.2, 0.005, 0, 100)).toBe(1);
    expect(paintedMarks(-0.2, 0.005, 0, 100)).toBe(0);
    expect(paintedMarks(0.2, -0.005, 0, 100)).toBe(0);
    expect(paintedMarks(0.2, 0.005, 0.02, 100)).toBe(0);
    expect(paintedMarks(0.2, 0.005, 0, 850)).toBe(0);
    expect(paintedMarks(0, 0, 0, 100)).toBe(0);
    expect(paintedMarks(NaN, 0, 0, 100)).toBe(0);
    // A steep sample isolates the shoulder stroke from broadened crest caps.
    const shoulder = paintedMarks(PAINTED_SEA.accentHeight, 0.005, 0.02, 100);
    expect(shoulder).toBeGreaterThan(0);
    expect(shoulder).toBeLessThan(0.3);
    expect(paintedMarks(PAINTED_SEA.accentHeight, 0.005, 0.02, 100, 0.1)).toBeLessThan(shoulder);
  });
  it('keeps cloud-style lighting and anti-aliased marks finite and bounded', () => {
    for (const aa of [0, 0.001, 0.1, 2]) for (const h of [-1, 0, 0.1, 1]) {
      for (const dot of [-1, 0, 1]) {
        const weights = paintedLightWeights(dot, h, aa);
        for (const weight of Object.values(weights)) {
          expect(weight).toBeGreaterThanOrEqual(0);
          expect(weight).toBeLessThanOrEqual(1);
        }
      }
      const mark = paintedMarks(h, 0.003, 0.001, 500, aa, aa, aa);
      expect(mark).toBeGreaterThanOrEqual(0);
      expect(mark).toBeLessThanOrEqual(1);
    }
  });
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
