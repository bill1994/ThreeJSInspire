import { describe, it, expect } from 'vitest';
import { deadzone } from './input';

describe('deadzone', () => {
  it('reads pointer jitter inside the 4px dead zone as exact zero', () => {
    expect(deadzone(0)).toBe(0);
    expect(deadzone(3)).toBe(0);
    expect(deadzone(-3)).toBe(0);
    expect(deadzone(4)).toBe(0);
    expect(deadzone(-4)).toBe(0);
  });

  it('produces a positive steer magnitude as soon as drag leaves the dead zone', () => {
    expect(deadzone(5)).toBeGreaterThan(0);
    expect(deadzone(-5)).toBeLessThan(0);
  });

  it('is sign symmetric', () => {
    expect(deadzone(-5)).toBe(-deadzone(5));
    expect(deadzone(-37)).toBe(-deadzone(37));
    expect(deadzone(-999)).toBe(-deadzone(999));
  });

  it('is monotonic in magnitude and saturates at 1', () => {
    let prev = 0;
    for (let px = 0; px <= 400; px += 1) {
      const v = deadzone(px);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
    expect(deadzone(400)).toBe(1);
    expect(deadzone(1e9)).toBe(1);
  });

  it('sanitizes non-finite input to zero instead of leaking NaN into the flight model', () => {
    expect(deadzone(Number.NaN)).toBe(0);
    expect(deadzone(Number.POSITIVE_INFINITY)).toBe(0);
    expect(deadzone(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});
