import { describe, expect, it } from 'vitest';
import { DAYLIGHT, daylightWeight, dayNightLightDirection } from './daylight';
import { SUN_DIRECTION } from './palettes';

describe('daylight transitions', () => {
  it('preserves the accepted sunset and extinguishes direct sunlight at night', () => {
    expect(daylightWeight(SUN_DIRECTION[1], DAYLIGHT.palette)).toBe(0);
    expect(daylightWeight(SUN_DIRECTION[1], DAYLIGHT.water)).toBe(1);
    expect(daylightWeight(SUN_DIRECTION[1], DAYLIGHT.direct)).toBe(1);
    expect(daylightWeight(-.2, DAYLIGHT.water)).toBe(0);
    expect(daylightWeight(-.2, DAYLIGHT.direct)).toBe(0);
  });

  it('keeps the sun/moon light finite and above the horizon through dusk', () => {
    for (let angle = -90; angle <= 90; angle += .25) {
      const r = angle * Math.PI / 180;
      const dir = dayNightLightDirection([0, Math.sin(r), -Math.cos(r)]);
      expect(Math.hypot(...dir)).toBeCloseTo(1, 10);
      expect(dir[1]).toBeGreaterThan(0);
    }
    const day = dayNightLightDirection([0, .6, -.8]);
    const night = dayNightLightDirection([0, -.6, .8]);
    day.forEach((value, i) => expect(value).toBeCloseTo(night[i], 12));
  });
});
