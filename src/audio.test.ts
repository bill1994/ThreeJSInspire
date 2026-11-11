import { describe, it, expect } from 'vitest';
import { dbFromSlider, SLIDER_FLOOR_DB, busGainDb, duckGain, cloudWind01, seaWindBoost, DUCK_DB, DUCK_RAMP_S } from './audio';

describe('dbFromSlider', () => {
  it('maps a slider of 1 to unity 0 dB (fully open bus)', () => {
    expect(dbFromSlider(1)).toBe(0);
  });

  it('uses a gain*gain curve, so half travel is far below -6 dB', () => {
    // 40*log10(0.5) = -12.04 dB, versus -6.02 dB for a plain gain mapping.
    expect(dbFromSlider(0.5)).toBeLessThan(-6);
    expect(dbFromSlider(0.5)).toBeCloseTo(40 * Math.log10(0.5), 6);
  });

  it('is monotonic non-decreasing across the whole slider', () => {
    let prev = Number.NEGATIVE_INFINITY;
    for (let i = 0; i <= 100; i += 1) {
      const db = dbFromSlider(i / 100);
      expect(Number.isFinite(db)).toBe(true);
      expect(db).toBeGreaterThanOrEqual(prev);
      expect(db).toBeLessThanOrEqual(0);
      prev = db;
    }
  });

  it('clamps a closed slider to a finite floor instead of -Infinity', () => {
    const db = dbFromSlider(0);
    expect(Number.isFinite(db)).toBe(true);
    expect(db).toBe(SLIDER_FLOOR_DB);
    expect(dbFromSlider(-0.4)).toBe(SLIDER_FLOOR_DB);
  });

  it('sanitizes NaN and over-range input', () => {
    expect(Number.isFinite(dbFromSlider(Number.NaN))).toBe(true);
    expect(dbFromSlider(Number.NaN)).toBe(SLIDER_FLOOR_DB);
    expect(dbFromSlider(4)).toBe(0);
  });
});

describe('busGainDb', () => {
  it('ducks under the slider without ever overwriting it', () => {
    const open = dbFromSlider(0.8);
    expect(busGainDb(0.8, DUCK_DB)).toBeCloseTo(open + DUCK_DB, 6);
    expect(busGainDb(0.8, 0)).toBeCloseTo(open, 6);
  });

  it('clamps at the floor instead of -Infinity', () => {
    expect(busGainDb(0, DUCK_DB)).toBe(SLIDER_FLOOR_DB);
    expect(busGainDb(1, 3)).toBe(0);
  });
});

describe('duckGain', () => {
  it('reaches the duck depth inside the ramp and recovers in time', () => {
    expect(duckGain(0, DUCK_RAMP_S)).toBe(0);
    expect(duckGain(DUCK_RAMP_S, DUCK_RAMP_S)).toBeCloseTo(DUCK_DB, 6);
    expect(duckGain(DUCK_RAMP_S * 3, DUCK_RAMP_S)).toBe(DUCK_DB); // held while on
    expect(duckGain(Number.NaN, DUCK_RAMP_S)).toBe(0);
  });
});

describe('cloudWind01', () => {
  it('only pushes the wind up, never mixes it away', () => {
    expect(cloudWind01(0)).toBeCloseTo(0.35, 6);
    expect(cloudWind01(1)).toBeCloseTo(1, 6);
    expect(cloudWind01(0.5)).toBeGreaterThan(0.35);
    expect(cloudWind01(Number.NaN)).toBeCloseTo(0.35, 6);
  });
});

describe('seaWindBoost (P0-2: the chop lifts the wind hiss)', () => {
  it('is silent on a calm deck and +0.05 at full rumble', () => {
    expect(seaWindBoost(0)).toBe(0);
    expect(seaWindBoost(1)).toBeCloseTo(0.05, 9);
    expect(seaWindBoost(0.5)).toBeCloseTo(0.025, 9);
    expect(seaWindBoost(Number.NaN)).toBe(0);
    expect(seaWindBoost(4)).toBeCloseTo(0.05, 9);
  });
});
