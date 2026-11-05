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

  it('keeps the sea haze equal to the sky horizon', () => {
    // The one contract the whole horizon depends on: the far sea fades into exactly the colour
    // the sky paints at its edge, so there is no seam. Nothing else pins it -- both values are
    // plain literals in two different objects, and the batches since have edited around them.
    expect(SEA_PALETTE.haze).toBe(0xff9a5a);
    expect(SKY_PALETTE.horizon.toLowerCase()).toBe('#ff9a5a');
    // Compare the RGB as text rather than via bit math: OR-ing 0xff000000 into a 0xRRGGBB whose
    // red byte is also 0xff merges the two bytes instead of preserving them.
    expect('#' + SEA_PALETTE.haze.toString(16).padStart(6, '0')).toBe(SKY_PALETTE.horizon.toLowerCase());
  });

  it('separates the cloud body from the sky top by at least 15 L*', () => {
    // B5 (review §1.3): the old base 0x7a5ba8 sat 3.6-4.8 L* off the sky top above 30 deg
    // elevation, so the tower melted into the sky behind it. ref-01 anchors on deep-violet
    // cloud against a dusk sky -- the body must read clearly darker than the sky it cuts out.
    const delta = Math.abs(lstar(CLOUD_PALETTE.base) - lstar(SKY_PALETTE.top));
    expect(delta).toBeGreaterThanOrEqual(15);
  });

  it('keeps the sea shadow side out of near-black and keeps the two bands apart', () => {
    // Frozen-protocol baseline (2026-10-31): 19.6% of the A-cruise frame sat below L* 12
    // against 0.6% in ref-01, and the sea read 0.198 mean value against 0.397. The shadow
    // side was the cause: 0x1a1a38 is L* 10.9, i.e. near-black water. Raising it is only
    // safe while `mid` stays far enough above it to keep the band structure visible.
    //
    // CALIBRATION SPACE: these are the AUTHORED L* values, i.e. before NeutralToneMapping.
    // The tone map is not identity at the dark end, so authored != displayed: the old value
    // 0x322c58 was authored L* 20.8 -- inside the old 18..26 window -- but DISPLAYED at
    // L* 9.6, which is the near-black this test exists to prevent. The bands below are
    // therefore recalibrated against the display-target semantics adopted in
    // docs/superpowers/reviews/2026-11-02-tonemap-hull-resolution.md 8:
    //   authored 31.95 -> displays L* 21.5   (0x5e444e)
    //   authored 38.61 -> displays L* 30.5   (0x6c536b)
    //   authored step 6.66 -> displays step 9.0
    // See `artifacts/cloud-audit/tonemap_unfold.py` to convert between the two spaces.
    const deep = lstar(SEA_PALETTE.deep);
    const mid = lstar(SEA_PALETTE.mid);
    expect(deep).toBeGreaterThanOrEqual(26);
    expect(deep).toBeLessThanOrEqual(40);
    expect(mid - deep).toBeGreaterThanOrEqual(6);
  });
});
