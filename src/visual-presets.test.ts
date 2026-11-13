import { describe, it, expect } from 'vitest';
import { PALETTE_PRESETS, SUN_POSITION, sunDirectionFor } from './palettes';
import { POST_PRESETS, clampFx } from './post';
import { TUNING_RANGES, CAMERA_TUNING, clampTuning } from './camera-rig';
import { camPreset, paletteToTrackPatch, postPreset } from './visual-presets';
import { parseBloomThreshold, parseCamRaw, parseDofEnabled, parseFov, parsePaletteName, parsePostFxName } from './qa';
import { srgbToLinear } from './sky-track';

function lstar(css: string): number {
  const chan = (i: number): number => {
    const c = parseInt(css.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const y = 0.2126 * chan(0) + 0.7152 * chan(1) + 0.0722 * chan(2);
  return 116 * Math.cbrt(y) - 16;
}

describe('free-play palette presets', () => {
  it('keeps sunset bit-for-bit the shipped frame', () => {
    expect(PALETTE_PRESETS.sunset.horizon).toBe('#ff9a5a');
    expect(PALETTE_PRESETS.sunset.top).toBe('#4a2f74');
    expect(PALETTE_PRESETS.sunset.sun).toBe('#ffd9a0');
    expect(PALETTE_PRESETS.sunset.seaHaze).toBe(0xff9a5a);
  });

  it('keeps every preset haze-locked: seaHaze equals horizon', () => {
    for (const p of Object.values(PALETTE_PRESETS)) {
      const hex = `#${p.seaHaze.toString(16).padStart(6, '0')}`;
      expect(hex.toLowerCase()).toBe(p.horizon.toLowerCase());
    }
  });

  it('keeps the zenith darker than the horizon glow', () => {
    for (const p of Object.values(PALETTE_PRESETS)) {
      expect(lstar(p.top)).toBeLessThan(lstar(p.horizon));
    }
  });

  it('resolves palettes into track patches on the day ramp', () => {
    const patch = paletteToTrackPatch('tealNoon');
    expect(patch.dayStops).toHaveLength(4);
    expect(patch.dayStops?.[0]).toEqual(srgbToLinear('#cfe8dd'));
  });
});

describe('free-play sun helper', () => {
  it('derives the shipped SUN_DIRECTION from SUN_POSITION', () => {
    expect(sunDirectionFor(SUN_POSITION)).toEqual([
      expect.closeTo(0.20798, 4),
      expect.closeTo(0.12132, 4),
      expect.closeTo(-0.97061, 4),
    ]);
  });
});

describe('free-play post presets', () => {
  it('keeps sunset equal to POST_HIGH', () => {
    expect(POST_PRESETS.sunset).toEqual(
      expect.objectContaining({ bloomThreshold: 0.82, dof: true }),
    );
  });

  it('keeps every preset threshold above the sky non-disc budget', () => {
    for (const fx of Object.values(POST_PRESETS)) {
      expect(clampFx({ ...fx }).bloomThreshold).toBeGreaterThanOrEqual(0.82);
    }
    expect(postPreset('unknown-name' as never).bloomThreshold).toBe(0.82);
  });
});

describe('free-play camera ranges', () => {
  it('keeps shipped defaults while widening the ranges', () => {
    expect(CAMERA_TUNING).toEqual({ fovKick: 9, bankFollow: 0.28, distance: 30, height: 6.8 });
    expect(TUNING_RANGES.fovKick).toEqual([0, 15]);
    expect(TUNING_RANGES.bankFollow).toEqual([0, 1]);
    expect(TUNING_RANGES.distance).toEqual([6, 120]);
    expect(TUNING_RANGES.height).toEqual([1, 40]);
  });

  it('clamps the widened tuning without NaN poisoning', () => {
    expect(clampTuning({ distance: 500 }).distance).toBe(120);
    expect(clampTuning({ height: -5 }).height).toBe(1);
    expect(clampTuning({ bankFollow: 0.9 }).bankFollow).toBe(0.9);
  });

  it('resolves ?cam= presets and dist,height pairs', () => {
    expect(camPreset('lowChase')).toMatchObject({ distance: 18, height: 3.5 });
    expect(camPreset('18,3.5')).toMatchObject({ distance: 18, height: 3.5 });
    expect(camPreset('nonsense')).toBeNull();
  });
});

describe('free-play URL parsers', () => {
  it('accepts only known palette/postfx names', () => {
    expect(parsePaletteName('tealNoon')).toBe('tealNoon');
    expect(parsePaletteName('nope')).toBeNull();
    expect(parsePostFxName('crisp')).toBe('crisp');
    expect(parsePostFxName('nope')).toBeNull();
  });

  it('validates bloom/dof/cam/fov without throwing', () => {
    expect(parseBloomThreshold('0.9')).toBe(0.9);
    expect(parseBloomThreshold('9')).toBeNull();
    expect(parseDofEnabled('0')).toBe(false);
    expect(parseDofEnabled('1')).toBe(true);
    expect(parseDofEnabled('yes')).toBeNull();
    expect(parseCamRaw('lowChase')).toBe('lowChase');
    expect(parseCamRaw('')).toBeNull();
    expect(parseFov('70')).toBe(70);
    expect(parseFov('500')).toBeNull();
  });
});
