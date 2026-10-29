import { describe, it, expect } from 'vitest';
import { dbFromSlider, SLIDER_FLOOR_DB } from './audio';

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
