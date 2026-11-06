/**
 * Single source of truth for every colour the sunset scene is built from.
 *
 * Two shapes live here on purpose:
 * - the sky palette stays CSS hex strings, because it feeds `THREE.Color` and the canvas
 *   gradient texture;
 * - the aircraft livery and the wake foam stay numeric hex, because the TSL graphs build
 *   constants from numbers (`col(hex)`), and `feel.ts` unpacks the wake foam to floats.
 *
 * The sea palette and the dome-cloud palette that used to live here were deleted on
 * 2026-11-06 (`rebuild/sea-dome-reset`) together with their renderers. Two values were
 * load-bearing outside them and moved rather than died:
 * - the wake foam tint became `WAKE_FOAM` (it was `SEA_PALETTE.foam`, read by `feel.ts`
 *   for the deck-skim spray — spray, not water);
 * - the far-field haze colour stayed as `HAZE_COLOR`, which the puff field converges on.
 */

/**
 * DEFAULT sun position. `?sun=az,el` overrides the direction at runtime (Task 7);
 * this seeds the sky uniform, the light rig and the spectrum's wind bearing.
 * The clouds and the sky dome both read it.
 */
export const SUN_POSITION: readonly [number, number, number] = [60, 35, -280];

/**
 * `SUN_POSITION` as a unit vector — the shader-side form of the same single source.
 *
 * The sky's glow and the cloud lighting each used to carry their own literal. The two
 * happened to nearly agree (about 4 degrees of azimuth and 0.7 degrees of elevation
 * apart), which is exactly the kind of drift a shared constant exists to prevent.
 * Deriving the direction once here means a change to `SUN_POSITION` moves both together,
 * which is what the plan's "turn the sun, all three follow" acceptance actually needs.
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
 * - `at` is the position inside the dome's ramp parameter
 *   `t = smoothstep(-0.02, 0.55, positionWorld.y / radius)`. `t` is neither an angle nor a
 *   height, so the landing points are pinned here instead of being re-derived by hand each
 *   time (the numbers below are the only thing that has to be recomputed if the dome radius
 *   or the smoothstep edges move):
 *
 *       at 0     -> h -0.020 -> -1.1 deg
 *       at 0.42  -> h  0.235 -> 13.6 deg
 *       at 0.72  -> h  0.351 -> 20.6 deg
 *       at 1     -> h  0.550 -> 33.4 deg      (h = sin(elevation), dome radius 800 m)
 *
 * - `canvasY` is the row in the fallback gradient (0 = top of the texture).
 *
 * They are not the same number and must not be forced to be. The layout that shipped used the
 * canvas rows as if they were elevations, which put the rose band 6 deg above the water
 * line — inside the band the horizon glow owns — and left the whole visible sky (a 60 deg
 * vertical FOV, horizon below centre) crossing a straight orange-to-violet line.
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
 * Sky horizon and the clouds' air perspective are the same atmospheric fact seen in two
 * directions; keeping two copies of it is how the horizon seam starts showing.
 */
export const HAZE_COLOR = SKY_PALETTE.horizon;

/**
 * Below the waterline. **Canvas fallback only, on purpose.**
 *
 * The dome has to stay exactly `SKY_PALETTE.horizon` under y=0 so the sky's edge meets the
 * far haze colour at the seam; darkening it there would paint a visible grey band across
 * the horizon.
 */
export const SKY_BELOW_HORIZON = '#8c4a5e';

/**
 * Foam tint for the deck-skim spray (`feel.ts`), deliberately NOT near-white.
 *
 * Ablation on the alt-8 frozen pose: foam covered ~8.5% of the water but cost 22.7 L of the
 * frame's 139.6 — the single largest brightener, ahead of the glitter (8.2 L) and the
 * fresnel (0). 0xfff0e2 read as paper. This is the warm cream the sunset actually has.
 *
 * Carried over verbatim from `SEA_PALETTE.foam` when the sea was deleted; the wake is spray
 * thrown by the aircraft, so it outlives the surface it used to land on.
 */
export const WAKE_FOAM = 0xd8b896;

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
