/**
 * src/horizon.ts — the sea/sky haze maths as testable pure functions.
 *
 * These are the REFERENCE implementations; the sea shader inlines the same constants
 * into its TSL graph (`sea-fft.ts`). The far edge of the ocean patch dissolves into
 * exactly the sky dome's colour through this ramp — the horizon is not geometry, it
 * is this saturation, so any change here has to keep saturating before the patch
 * ends (checked against the 240 m ceiling in horizon.test.ts).
 */

export const HORIZON = {
  /** Distance (m) the haze ramp starts lifting off 0. */
  HAZE_NEAR: 150,
  /**
   * Distance (m) the haze reaches 1. Constrained by the sea's *snapped* forward edge, not by
   * the ideal patch corner: `far-field` snaps the sea to whole `SEA_FOLLOW_STEP` (400 m)
   * periods, so the edge can sit only `SEA_PATCH_SIZE/2 - SEA_FOLLOW_STEP/2` = 600 m ahead.
   * A larger value leaves residual sea colour across the horizon seam at the worst phase.
   *
   * 380 was the value under the old 1200 m patch, where 400 m was the worst edge. Widening
   * the ramp to 520 m (over a 370 m span instead of 270 m) is what stops the far water from
   * collapsing into a flat haze-coloured wall at cruise altitude.
   */
  HAZE_FAR: 520,
  /** Sun-glow exponent copied from the sky dome's own term. */
  GLOW_POW: 9,
  /**
   * Sun-glow gain copied from the sky dome's own term.
   *
   * Left at 0.42 after the tone-mapping fix: ACES now rolls the >1.0 sum off instead
   * of clipping it (measured mid-band clipping 51.6% -> 4.4%), so shrinking this would
   * dim the sunset glow to fix a problem that no longer exists.
   */
  GLOW_GAIN: 0.42,
  /**
   * Outer radius of the sun disc, in degrees. A real sun is 0.53 deg across, i.e. 0.265
   * half-angle.
   *
   * The old `pow(cos, 220)` was a 9.09 deg diameter -- 17x too big. Reaching 0.53 deg by
   * exponent would need `pow ~= 64000`, which underflows to 0 in the HalfFloat render
   * target, so the disc is an angle threshold now.
   */
  DISK_HALF_ANGLE_DEG: 0.265,
  /**
   * Disc gain. 0 = no hard disc at all.
   *
   * `ref-01` has no disc: the sun reads as glow on the sky plus a glitter road on the
   * water. Decision D4 (2026-10-30) cut it rather than shrinking it. Raise this above 0
   * to bring a physical disc back; `sunDisc` is already sized correctly for one.
   */
  DISK_GAIN: 0,
} as const;

/** smoothstep(NEAR, FAR, dist), NaN → 0. */
export function horizonHaze(dist: number): number {
  if (!Number.isFinite(dist)) return 0;
  const t = Math.min(Math.max((dist - HORIZON.HAZE_NEAR) / (HORIZON.HAZE_FAR - HORIZON.HAZE_NEAR), 0), 1);
  return t * t * (3 - 2 * t);
}

/** pow(max(sunDot, 0), GLOW_POW) * GLOW_GAIN, NaN → 0. */
export function horizonGlow(sunDot: number): number {
  if (!Number.isFinite(sunDot)) return 0;
  return Math.pow(Math.max(sunDot, 0), HORIZON.GLOW_POW) * HORIZON.GLOW_GAIN;
}

/**
 * Sun disc as an angle threshold, 0..1, NaN → 0.
 *
 * `cosHalf` is `cos(DISK_HALF_ANGLE_DEG)`; the value ramps from 1 on-axis to 0 exactly
 * at that angle. `sky-webgpu.ts` links the same expression in TSL — keep the two in
 * step the way `horizonHaze` / `horizonGlow` are kept in step with `sea-fft.ts`.
 */
export function sunDisc(sunDot: number, cosHalf: number): number {
  if (!Number.isFinite(sunDot) || !Number.isFinite(cosHalf)) return 0;
  const span = 1 - cosHalf;
  if (!(span > 1e-9)) return sunDot >= cosHalf ? 1 : 0;
  const t = Math.min(Math.max((sunDot - cosHalf) / span, 0), 1);
  return t * t * (3 - 2 * t);
}
