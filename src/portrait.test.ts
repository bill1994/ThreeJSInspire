import { describe, it, expect } from 'vitest';
import { PORTRAIT, portraitAspect, lowerThirdY, hudSafeArea } from './portrait';

describe('portraitAspect', () => {
  it('keeps a phone in portrait exact', () => {
    expect(portraitAspect(1080, 1920)).toBeCloseTo(PORTRAIT.ASPECT, 6);
  });

  it('clamps a desktop window to story portrait instead of stretching', () => {
    expect(portraitAspect(2560, 1440)).toBe(PORTRAIT.ASPECT);
  });

  it('never produces NaN or a zero-width frustum', () => {
    expect(portraitAspect(0, 0)).toBe(PORTRAIT.ASPECT);
    expect(portraitAspect(Number.NaN, 1920)).toBe(PORTRAIT.ASPECT);
  });
});

describe('lowerThirdY', () => {
  it('puts the aircraft below the middle third line', () => {
    expect(lowerThirdY(1280)).toBeCloseTo(1280 * PORTRAIT.LOWER_THIRD, 6);
    expect(lowerThirdY(1280)).toBeGreaterThan(1280 / 2);
  });
});

describe('hudSafeArea', () => {
  it('reserves room for a notch and a bottom bar', () => {
    const area = hudSafeArea(PORTRAIT.ASPECT);
    expect(area.top).toBeGreaterThan(0);
    expect(area.bottom).toBeGreaterThan(area.top);
  });
});
