/**
 * src/horizon.ts — the sea/sky haze maths as testable pure functions.
 *
 * These are the REFERENCE implementations; the sea shader inlines the same constants
 * into its TSL graph. The far edge of the banded sea dissolves into
 * exactly the sky dome's colour through this ramp — the horizon is not geometry, it
 * is this saturation, so any change here has to keep saturating before the patch
 * ends (checked against the 1536 m `b5` corner in horizon.test.ts).
 *
 * The banded sea is mounted now (`src/world.ts`, Task 6), but its material still shades
 * itself by height alone — it does not yet read this ramp. `horizonHaze` / `horizonGlow`
 * therefore still have no scene-side caller besides `horizon.test.ts`; they are the
 * contract the sea's own haze terms have to match when the light/foam follow-ups land.
 */

export const HORIZON = {
  /** Distance (m) the haze ramp starts lifting off 0. */
  HAZE_NEAR: 150,
  /**
   * Distance (m) the haze reaches 1.
   *
   * Constrained by the banded sea's *worst* edge, not by its nearest one: the far corner of
   * `b5` is `hypot(1536, ALT_MAX + CAM_HEIGHT)` ≈ 1556 m from the camera, and the ramp has to
   * be saturated before that or residual sea colour shows along the horizon seam (M12).
   * The sea no longer snaps to a patch period — it is towed per band and clipped at 1536 m —
   * so the old 600 m forward-edge constraint (PATCH 1600 / FOLLOW_STEP 400) retired with it.
   *
   * 380 was the value under the old 1200 m patch, 520 under the 1600 m one. 900 keeps a
   * 750 m ramp: wide enough that the far water is water and not a flat haze wall, short
   * enough that it is fully saturating well inside the b5 corner.
   */
  HAZE_FAR: 900,
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

/**
 * Air-perspective haze for the clouds.
 *
 * The puff field re-wraps every 1000 m: a tower that leaves at `planeZ + 120` reappears at
 * `planeZ - 880` in a single frame, and because the puffs and the dome both set `fog = false`
 * the field holds full contrast right up to that pop. Distance haze is the only thing that
 * fixes the pop and the far wall's hard edge at the same time, so the ramp is authored here,
 * next to the sea's own haze, rather than as a per-material tweak in two files that would then
 * be free to disagree.
 *
 * The colour is `SEA_PALETTE.haze` (= `SKY_PALETTE.horizon`), on purpose: the sea's far water
 * already converges on it, so the cloud field converges on the same value instead of inventing
 * a second idea of "far away".
 */
export const CLOUD_HAZE = {
  /** Haze starts here; the near field stays crisp. */
  NEAR: 260,
  /** Saturates here — under the 880 m respawn distance, so a wrapped-in tower lands fully hazed. */
  FAR: 860,
  /** Asymptote for the puff field. Clouds still have to read as clouds. */
  MAX: 0.78,
  /**
   * Asymptote for the 780 m dome. Smaller on purpose: the dome is one constant distance, so
   * `MAX` would wash the whole silhouette evenly and take the lit crowns down with the base.
   * The crowns also carry a standing budget — at least ΔL* 15 above the sky behind them
   * (v2 task 4) — so the dome cap stays well clear of it.
   */
  DOME_MAX: 0.55,
  /**
   * Elevation window for the dome's vertical damping: no haze below `CROWN_LO`, full crown
   * clarity above `CROWN_HI` (both are `dir.y`, so they are sines of the view angle — roughly
   * 3 deg and 27 deg).
   */
  CROWN_LO: 0.05,
  CROWN_HI: 0.45,
} as const;

/** smoothstep(CLOUD_HAZE.NEAR, CLOUD_HAZE.FAR, dist) * max, NaN → 0. */
export function cloudHaze(dist: number, max: number = CLOUD_HAZE.MAX): number {
  if (!Number.isFinite(dist) || !Number.isFinite(max)) return 0;
  const span = CLOUD_HAZE.FAR - CLOUD_HAZE.NEAR;
  if (!(span > 0)) return 0;
  const t = Math.min(Math.max((dist - CLOUD_HAZE.NEAR) / span, 0), 1);
  return t * t * (3 - 2 * t) * max;
}

/**
 * Haze weight for the dome shell, damped toward the zenith. `dirY` is the view direction's
 * y-component (`sin(elevation)`), NaN → 0.
 *
 * Elevation stands in for "tower base or tower crown" because the shell is a fixed 780 m
 * sphere: a distant base and a distant crown are the same distance, so only the angle
 * separates them.
 */
export function domeCloudHaze(dirY: number, dist: number, max: number = CLOUD_HAZE.DOME_MAX): number {
  if (!Number.isFinite(dirY)) return 0;
  const span = CLOUD_HAZE.CROWN_HI - CLOUD_HAZE.CROWN_LO;
  if (!(span > 0)) return 0;
  const t = Math.min(Math.max((dirY - CLOUD_HAZE.CROWN_LO) / span, 0), 1);
  const crown = t * t * (3 - 2 * t);
  return cloudHaze(dist, max) * (1 - crown);
}

/** pow(max(sunDot, 0), GLOW_POW) * GLOW_GAIN, NaN → 0. */export function horizonGlow(sunDot: number): number {
  if (!Number.isFinite(sunDot)) return 0;
  return Math.pow(Math.max(sunDot, 0), HORIZON.GLOW_POW) * HORIZON.GLOW_GAIN;
}

/**
 * Sun disc as an angle threshold, 0..1, NaN → 0.
 *
 * `cosHalf` is `cos(DISK_HALF_ANGLE_DEG)`; the value ramps from 1 on-axis to 0 exactly
 * at that angle. `sky-webgpu.ts` links the same expression in TSL — keep the two in
 * step, the way `horizonHaze` / `horizonGlow` will have to be kept in step with the
 * rebuilt sea shader.
 */
export function sunDisc(sunDot: number, cosHalf: number): number {
  if (!Number.isFinite(sunDot) || !Number.isFinite(cosHalf)) return 0;
  const span = 1 - cosHalf;
  if (!(span > 1e-9)) return sunDot >= cosHalf ? 1 : 0;
  const t = Math.min(Math.max((sunDot - cosHalf) / span, 0), 1);
  return t * t * (3 - 2 * t);
}
