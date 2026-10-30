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
  /** Sun-glow gain copied from the sky dome's own term. */
  GLOW_GAIN: 0.42,
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
