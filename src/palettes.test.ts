import { describe, it, expect } from 'vitest';
import { SUN_POSITION, SUN_DIRECTION, SKY_PALETTE, SEA_PALETTE, CLOUD_PALETTE, PLANE_PALETTE } from './palettes';

/**
 * The sky palette keeps CSS strings because it feeds `THREE.Color` and the canvas
 * gradient; the sea and cloud palettes keep numeric hex because `glslColor(hex: number)`
 * and `col(hex: number)` take numbers. Both forms must still round-trip to a 6-digit hex,
 * which is the property that actually matters: an 8-digit ARGB value or a typo'd short
 * one silently miscolors.
 */
function toCss(value: string | number): string {
  return typeof value === 'string' ? value : '#' + value.toString(16).padStart(6, '0');
}

const HEX = /^#[0-9a-f]{6}$/i;

describe('palettes', () => {
  it('keeps every colour expressible as a 6-digit hex, so THREE.Color and TSL agree', () => {
    const all = [
      ...Object.values(SKY_PALETTE),
      ...Object.values(SEA_PALETTE),
      ...Object.values(CLOUD_PALETTE),
      ...Object.values(PLANE_PALETTE),
    ];
    expect(all.length).toBe(20);
    for (const css of all) expect(toCss(css)).toMatch(HEX);
  });

  it('has the sea keys the shader reads by name', () => {
    expect(Object.keys(SEA_PALETTE).sort()).toEqual([
      'crest',
      'deep',
      'foam',
      'glitter',
      'haze',
      'lit',
      'mid',
    ]);
  });

  it('keeps the sun where the sea glitter and the sky dome expect it', () => {
    expect(SUN_POSITION).toEqual([60, 35, -280]);
    expect(SUN_POSITION[1]).toBeGreaterThan(0); // above the horizon, or the sunset reads as dusk
  });

  it('derives one unit sun direction for the sea, the sky and the clouds', () => {
    expect(Math.hypot(...SUN_DIRECTION)).toBeCloseTo(1, 6);
    // The sea and the sky carried this value rounded to four decimals; the clouds carried a
    // different bearing entirely. Pin the exact normalisation and let the rounding delta be
    // visible rather than silently baked in.
    expect(SUN_DIRECTION[0]).toBeCloseTo(0.20798, 4);
    expect(SUN_DIRECTION[1]).toBeCloseTo(0.12132, 4);
    expect(SUN_DIRECTION[2]).toBeCloseTo(-0.97061, 4);
    expect(SUN_DIRECTION[1]).toBeGreaterThan(0);
  });
});
