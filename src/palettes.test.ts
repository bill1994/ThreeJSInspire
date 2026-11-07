import { describe, it, expect } from 'vitest';
import {
  SEA_PALETTE,
  SUN_POSITION,
  SUN_DIRECTION,
  SKY_PALETTE,
  SKY_STOPS,
  HAZE_COLOR,
  WAKE_FOAM,
  PLANE_PALETTE,
} from './palettes';

/**
 * The sky palette keeps CSS strings because it feeds `THREE.Color` and the canvas
 * gradient; the livery and the wake foam keep numeric hex because the TSL graphs build
 * constants from numbers. Both forms must still round-trip to a 6-digit hex, which is the
 * property that actually matters: an 8-digit ARGB value or a typo'd short one silently
 * miscolors.
 */
function toCss(value: string | number): string {
  return typeof value === 'string' ? value : '#' + value.toString(16).padStart(6, '0');
}

const HEX = /^#[0-9a-f]{6}$/i;

/** CIE L* of a palette entry, so brightness relations can be asserted as numbers. */
function lstar(value: string | number): number {
  const css = toCss(value);
  const chan = (i: number): number => {
    const c = parseInt(css.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const y = 0.2126 * chan(0) + 0.7152 * chan(1) + 0.0722 * chan(2);
  return 116 * Math.cbrt(y) - 16;
}

describe('palettes', () => {
  it('keeps every colour expressible as a 6-digit hex, so THREE.Color and TSL agree', () => {
    const all = [
      ...Object.values(SKY_PALETTE),
      ...SKY_STOPS.map((s) => s.color),
      HAZE_COLOR,
      WAKE_FOAM,
      ...Object.values(PLANE_PALETTE),
    ];
    expect(all.length).toBe(15);
    for (const css of all) expect(toCss(css)).toMatch(HEX);
  });

  it('keeps the sun where the clouds and the sky dome expect it', () => {
    expect(SUN_POSITION).toEqual([60, 35, -280]);
    expect(SUN_POSITION[1]).toBeGreaterThan(0); // above the horizon, or the sunset reads as dusk
  });

  it('derives one unit sun direction for the sky and the clouds', () => {
    expect(Math.hypot(...SUN_DIRECTION)).toBeCloseTo(1, 6);
    // The sky carried this value rounded to four decimals; the clouds carried a different
    // bearing entirely. Pin the exact normalisation and let the rounding delta be visible
    // rather than silently baked in.
    expect(SUN_DIRECTION[0]).toBeCloseTo(0.20798, 4);
    expect(SUN_DIRECTION[1]).toBeCloseTo(0.12132, 4);
    expect(SUN_DIRECTION[2]).toBeCloseTo(-0.97061, 4);
    expect(SUN_DIRECTION[1]).toBeGreaterThan(0);
  });

  it('keeps the far haze colour equal to the sky horizon', () => {
    // The contract the horizon seam depends on: the far field converges on exactly the
    // colour the sky paints at its edge, so there is no seam.
    expect(SKY_PALETTE.horizon.toLowerCase()).toBe('#ff9a5a');
    expect(HAZE_COLOR.toLowerCase()).toBe(SKY_PALETTE.horizon.toLowerCase());
  });

  it('keeps the wake spray warm instead of paper-white', () => {
    // The sea's ablation found foam the single largest brightener in the frame; the wake
    // inherits that lesson. Cream is ~L* 76; anything above ~85 reads as paper on screen.
    const l = lstar(WAKE_FOAM);
    expect(l).toBeGreaterThan(65);
    expect(l).toBeLessThan(85);
    const r = (WAKE_FOAM >> 16) & 0xff;
    const b = WAKE_FOAM & 0xff;
    expect(r).toBeGreaterThan(b); // warm, not a blue-grey
  });
});

describe('SEA_PALETTE', () => {
  it('converges on the sky horizon — the hard haze contract', () => {
    expect('#' + SEA_PALETTE.haze.toString(16).padStart(6, '0')).toBe(
      SKY_PALETTE.horizon.toLowerCase(),
    );
  });

  it('runs body scatter monotonically brighter deep → grazing → shallow', () => {
    // The continuous body model lerps between deep and grazing by view angle and
    // tints toward shallow at the crest. If those three ever invert, the body
    // colour turns inside out as the camera pitches — the failure a screenshot
    // only shows as "the water looks wrong from above".
    const ls = (['deep', 'grazing', 'shallow'] as const).map((k) => lstar(SEA_PALETTE[k]));
    for (let i = 1; i < ls.length; i += 1) expect(ls[i]).toBeGreaterThan(ls[i - 1]);
    expect(ls[0]).toBeGreaterThanOrEqual(18); // navy floor: dark, not mud
    expect(ls[2]).toBeLessThan(65); // never brighter than the horizon glow
  });

  it('keeps the subsurface tint green-leaning, not a second sky', () => {
    // Crest's reference is (0.0885, 0.497, 0.456) linear: green-dominant. A blue
    // or violet SSS is the tell-tale of a water shader tuned for noon.
    const css = toCss(SEA_PALETTE.subsurface);
    const g = parseInt(css.slice(3, 5), 16);
    const b = parseInt(css.slice(5, 7), 16);
    expect(g).toBeGreaterThan(b * 0.9);
    expect(g).toBeGreaterThan(120);
  });
});
