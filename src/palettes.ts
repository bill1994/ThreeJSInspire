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

/**
 * The sunset ramp, shared by both sky renderers.
 *
 * Each stop carries **two** positions, because the two renderers measure different things:
 *
 * - `at` is the dome's elevation parameter: 0 at the waterline, 1 at `h = 0.55`, which is
 *   about 33 deg of elevation.
 * - `canvasY` is the row in the fallback gradient (0 = top of the texture).
 *
 * They are not the same number and must not be forced to be. The layout that shipped used the
 * canvas rows as if they were elevations, which put the rose band 6 deg above the water
 * line — inside the band the horizon glow owns — and left the whole visible sky (a 55 deg
 * vertical FOV with the horizon at roughly 18 deg) crossing a straight orange-to-violet line.
 * That straight line is the "grey-red crossover" the audit flagged, and it is why the dome had
 * no rose band while the canvas fallback did.
 */
export const SKY_STOPS = [
  { at: 0, canvasY: 0.78, color: SKY_PALETTE.horizon },
  { at: 0.42, canvasY: 0.62, color: '#c96a8f' },
  { at: 0.72, canvasY: 0.34, color: SKY_PALETTE.top },
  { at: 1, canvasY: 0, color: '#4a2f74' },
] as const;

/**
 * What the world converges on at distance.
 *
 * Sky horizon, the sea's far water and the clouds' air perspective are the same atmospheric
 * fact seen in three directions; keeping three copies of it is how the horizon seam starts
 * showing. `SEA_PALETTE.haze` is this value.
 */
export const HAZE_COLOR = SKY_PALETTE.horizon;

/**
 * Below the waterline. **Canvas fallback only, on purpose.**
 *
 * The dome has to stay exactly `SKY_PALETTE.horizon` under y=0 so it still meets
 * `SEA_PALETTE.haze` at the seam; darkening it there would paint a visible grey band across
 * the horizon, which is the one thing that pair is not allowed to do.
 */
export const SKY_BELOW_HORIZON = '#8c4a5e';

export const SEA_PALETTE = {
  /**
   * Shadow side of the swell — deep indigo, warm enough to sit under a sunset sky.
   *
   * Was 0x1a1a38 (L* 10.9), i.e. near-black water. The frozen-protocol baseline measured
   * 19.6% of the cruise frame below L* 12 against 0.6% in ref-01, and the sea at 0.198 mean
   * value against 0.397. Lifted to L* 20.8 with `mid` lifted alongside it so the band step
   * stays ~10 L* wide and the shadow side is still clearly the dark end of the ramp.
   */
  deep: 0x322c58,
  /** Mid tone: dusty violet, the colour most of the water reads as. */
  mid: 0x4a4272,
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
