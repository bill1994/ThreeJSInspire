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
  GLOW_POW: 120,
  /**
   * Sun-glow gain copied from the sky dome's own term.
   *
   * Left at 0.42 after the tone-mapping fix: ACES now rolls the >1.0 sum off instead
   * of clipping it (measured mid-band clipping 51.6% -> 4.4%), so shrinking this would
   * dim the sunset glow to fix a problem that no longer exists.
   */
  GLOW_GAIN: 0.42,
  /**
   * Outer radius of the sun disc, in degrees — a STYLIZED size, about 4x the real
   * 0.53 deg disc (plan Task 7). At 720x1280 a physical disc is a few pixels and
   * reads as a rendering glitch; 2 deg half-angle reads as a sun.
   */
  DISK_HALF_ANGLE_DEG: 2.0,
  /**
   * Disc gain. 0.3 puts the on-axis sum (glow 0.42 + disc 0.3 ≈ 0.97 after the
   * sunward boost) over the high-tier bloom threshold 0.82 — the sun blooms, on
   * purpose. Kept below 1 so the disc itself stays short of full white.
   */
  DISK_GAIN: 0.3,
  /**
   * Runtime sun elevation range (degrees). The bloom/brightness tables were
   * measured inside this band; `?sun=az,el` clamps into it so the sun can move
   * without the whole lighting budget silently invalidating itself.
   */
  DUSK_BAND: { minDeg: 3, maxDeg: 15 },
  /**
   * Colour the horizon cools toward on the side facing AWAY from the sun.
   *
   * The stop ramp alone paints `SKY_PALETTE.horizon` (#ff9a5a) at every azimuth,
   * so the sea's reflection was one flat gold sheet whichever way it looked and
   * the Fresnel falloff under it read as a drawn line. A real sunset is warm only
   * toward the sun; the anti-solar horizon is dusty rose.
   */
  AWAY_COLOR: '#8f5a90',
  /**
   * How far the anti-solar horizon moves toward `AWAY_COLOR`, 0..1.
   *
   * 0.8 keeps enough of the ramp's warmth that both sides still read as one sky;
   * 1.0 looks like two pictures stitched together at the sun.
   */
  AWAY_GAIN: 0.8,
  /** sin(elevation) over which the cool tint fades out going up. */
  AWAY_HEIGHT: 0.42,
} as const;

/** pow(max(sunDot, 0), GLOW_POW) * GLOW_GAIN, NaN → 0. */
export function horizonGlow(sunDot: number): number {
  if (!Number.isFinite(sunDot)) return 0;
  return Math.pow(Math.max(sunDot, 0), HORIZON.GLOW_POW) * HORIZON.GLOW_GAIN;
}

/**
 * Weight of the anti-solar horizon tint, 0..AWAY_GAIN.
 *
 * 0 toward the sun, AWAY_GAIN straight away from it, faded out by AWAY_HEIGHT
 * going up. `sky-webgpu.ts` links the same expression in TSL — keep the two in
 * step, the way `horizonGlow` is kept in step with the dome's glow term.
 *
 * `cosAz` is the horizontal alignment of view and sun (-1..1), `dirY` the
 * sin(elevation) of the direction being shaded.
 */
export function antiSolarCool(cosAz: number, dirY: number): number {
  if (!Number.isFinite(cosAz) || !Number.isFinite(dirY)) return 0;
  const away = Math.min(Math.max((1 - cosAz) * 0.5, 0), 1);
  const t = Math.min(Math.max(dirY / HORIZON.AWAY_HEIGHT, 0), 1);
  const lowSky = 1 - t * t * (3 - 2 * t);
  return Math.pow(away, 1.2) * lowSky * HORIZON.AWAY_GAIN;
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

/**
 * Full width at half maximum of the `cos^GLOW_POW` glow, in degrees — the
 * single number that says how wide the sunset halo reads on screen.
 */
export function fwhmDegOfGlow(): number {
  const halfAngleRad = Math.acos(Math.pow(0.5, 1 / HORIZON.GLOW_POW));
  return (2 * halfAngleRad * 180) / Math.PI;
}

/** Clamp a requested sun elevation into the measured dusk band. */
export function clampSunElevation(deg: number): number {
  return Math.min(Math.max(deg, HORIZON.DUSK_BAND.minDeg), HORIZON.DUSK_BAND.maxDeg);
}

/**
 * Azimuth/elevation (degrees) → unit sun direction. Azimuth 0 points down −Z
 * (the default sun's bearing) and rotates toward +X; elevation is measured
 * from the horizon. Same convention as the spectrum's wind direction, so the
 * wind sea and the sun road can be aligned by one angle.
 */
export function sunDirectionFromAzEl(azDeg: number, elDeg: number): readonly [number, number, number] {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  const cosEl = Math.cos(el);
  return [Math.sin(az) * cosEl, Math.sin(el), -Math.cos(az) * cosEl];
}
