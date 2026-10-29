/**
 * Single source of truth for every colour the sunset scene is built from.
 *
 * Two shapes live here on purpose:
 * - the sky palette stays CSS hex strings, because it feeds `THREE.Color` and the canvas
 *   gradient texture;
 * - the sea and cloud palettes stay numeric hex, because `glslColor(hex: number)` in
 *   `sea-fallback.ts` and `col(hex: number)` in `sea-fft.ts` build shader constants from
 *   numbers.
 *
 * Values are carried over verbatim from the modules they used to live in. The sea haze and
 * the sky horizon are the same colour by contract: the sea's far field dissolves into it,
 * so any drift shows up as a hard band across the horizon.
 */

/** Shared sun direction. The clouds, the sky dome and the sea glitter all read it. */
export const SUN_POSITION: readonly [number, number, number] = [60, 35, -280];

export const SKY_PALETTE = {
  top: '#6b4fa1',
  horizon: '#ff9a5a',
  sun: '#ffd9a0',
} as const;

export const SEA_PALETTE = {
  /** Shadow side of the swell — deep indigo, warm enough to sit under a sunset sky. */
  deep: 0x1a1a38,
  /** Mid tone: dusty violet, the colour most of the water reads as. */
  mid: 0x3a3358,
  /** Slope turned toward the low sun — warm rose, this is the sunset light in the water. */
  lit: 0xb1788a,
  /** Sun-facing crest. */
  crest: 0xffd6a8,
  glitter: 0xfff2d6,
  foam: 0xfff0e2,
  /** MUST equal `SKY_PALETTE.horizon`. */
  haze: 0xff9a5a,
} as const;

export const CLOUD_PALETTE = {
  shadow: 0x4a3370,
  base: 0x7a5ba8,
  pink: 0xffb3c1,
  gold: 0xffe6c8,
} as const;

/** Aircraft livery, carried verbatim out of `plane.ts` so the toon ramp and the
 *  livery tinting can never drift apart. CSS strings: these feed `THREE.Color`. */
export const PLANE_PALETTE = {
  liveryWhite: '#efeadb',
  liveryGreen: '#2f6b4e',
  liveryRed: '#b63629',
  darkTrim: '#3a3a3e',
  glassCanopy: '#22242c',
  metalProp: '#9aa0a8',
} as const;
