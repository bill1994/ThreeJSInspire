import { describe, expect, it } from 'vitest';
import { FloatContact } from './surface-interaction';

describe('independent float footprints', () => {
  it('weights the lower float more strongly and exchanges sides when banking the other way', () => {
    const sample = (height: number) => {
      const contact = new FloatContact(0, height, 0);
      contact.sampleWater(0, 1, () => -10);
      return contact.strength;
    };
    expect(sample(4.8)).toBeGreaterThan(sample(6.1));
    expect(sample(9)).toBe(0);
    expect(sample(4)).toBe(1);
  });
  it('clips a dry footprint independently at a sloping waterline', () => {
    const shore = (x: number) => x;
    const left = new FloatContact(-1.5, 5, 0);
    const right = new FloatContact(1.5, 5, 0);
    left.sampleWater(0, 1, shore);
    right.sampleWater(0, 1, shore);
    expect(left.strength).toBeGreaterThan(0);
    expect(right.strength).toBe(0);
  });
});
