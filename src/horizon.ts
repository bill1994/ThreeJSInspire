/**
 * src/horizon.ts — the sky's horizon-glow maths as testable pure functions.
 *
 * These are the REFERENCE implementations; `sky-webgpu.ts` links the same constants
 * into its TSL graph. There is one caller contract here: whatever the sky dome paints
 * at its edge, the JS mirror below has to agree with it, so a glow/disk change can be
 * checked without a browser.
 *
 * The sea haze ramp (`horizonHaze`) and the cloud/dome haze ramps (`CLOUD_HAZE`,
 * `cloudHaze`, `domeCloudHaze`) lived here until 2026-11-06, when the sea and the dome
 * cloud were deleted on `rebuild/sea-dome-reset`. The puff field now owns its own
 * `PUFF_HAZE` constants in `puff-cloud.ts` — nothing in this file is shared with it.
 */

export const HORIZON = {
  /**
   * Sun-glow exponent copied from the sky dome's own term.
   *
   * 9 was tuned for a wide landscape frame. In the portrait column the horizontal FOV is
   * only 36 deg, so `cos^9` never drops below ~0.28 anywhere on screen and the warm tint
   * washed the whole upper sky: measured across the top 30% of A-cruise, chroma fell
   * monotonically from C* 25.5 on the far side to 16.1 nearest the sun, with the zenith
   * reading pale pink instead of the reference's deep violet. 24 puts the falloff back at
   * roughly +-20 deg around the sun while leaving the horizon band itself untouched.
   */
  GLOW_POW: 48,
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
   * `ref-01` has no disc: the sun reads as glow on the sky. Decision D4 (2026-10-30) cut
   * it rather than shrinking it. Raise this above 0 to bring a physical disc back;
   * `sunDisc` is already sized correctly for one.
   */
  DISK_GAIN: 0,
} as const;

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
 * step, the way `horizonGlow` is kept in step with the dome's glow term.
 */
export function sunDisc(sunDot: number, cosHalf: number): number {
  if (!Number.isFinite(sunDot) || !Number.isFinite(cosHalf)) return 0;
  const span = 1 - cosHalf;
  if (!(span > 1e-9)) return sunDot >= cosHalf ? 1 : 0;
  const t = Math.min(Math.max((sunDot - cosHalf) / span, 0), 1);
  return t * t * (3 - 2 * t);
}
