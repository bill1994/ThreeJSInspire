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

/**
 * `SUN_POSITION` as a unit vector — the shader-side form of the same single source.
 *
 * The sea glitter, the sky dome's glow and the cloud lighting each used to carry their own
 * literal. The sea and the sky happened to agree; the clouds did not (they lit from
 * `normalize(0.28, 0.14, -1)`, about 4 degrees of azimuth and 0.7 degrees of elevation away),
 * so the cloud shadows fell slightly off the water's sun road. Deriving the direction once
 * here means a change to `SUN_POSITION` moves all three together, which is what the plan's
 * "turn the sun, all three follow" acceptance actually needs.
 */
export const SUN_DIRECTION: readonly [number, number, number] = (() => {
  const [x, y, z] = SUN_POSITION;
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len] as const;
})();

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
  // Deep violet body, ~16 L* under SKY_PALETTE.top (B5: the old 0x7a5ba8 sat within 5 L*
  // of the sky above 30 deg elevation and the tower melted into it; ref-01 anchors on
  // deep-violet cloud against a dusk sky).
  shadow: 0x2b1e4e,
  base: 0x402d68,
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
