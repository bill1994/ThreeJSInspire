import { describe, it, expect } from 'vitest';
import { STALL, MAX_PITCH_PROXY, stall01 } from './stall';
import { FLIGHT } from './game';

describe('stall01', () => {
  it('only exists above the critical angle of attack', () => {
    expect(stall01(0, 1)).toBe(0);
    expect(stall01(0.2, 0.9)).toBe(0);
  });

  it('bites hard when the nose is up and the airspeed is gone', () => {
    expect(stall01(0.9, 0.1)).toBeGreaterThan(0.5);
  });

  it('stays recoverable: levelling off with speed clears it', () => {
    expect(stall01(0.05, 0.9)).toBe(0);
    expect(stall01(0.9, 0.9)).toBeLessThan(stall01(0.9, 0.1));
  });

  it('is monotonic in pitch and NaN-safe', () => {
    let prev = -1;
    for (let p = 0; p <= FLIGHT.MAX_PITCH; p += 0.05) {
      const v = stall01(p, 0.3);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(stall01(Number.NaN, 0.5)).toBe(0);
    expect(stall01(0.9, Number.NaN)).toBe(0);
  });

  it('mirrors FLIGHT.MAX_PITCH without importing it', () => {
    expect(MAX_PITCH_PROXY).toBe(FLIGHT.MAX_PITCH);
    expect(STALL.AOA_CRIT).toBeGreaterThan(0);
    expect(STALL.AOA_CRIT).toBeLessThan(1);
  });
});
