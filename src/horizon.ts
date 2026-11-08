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
 *
 * `HAZE_COLOR` arrives from `palettes.ts` (no cycle: palettes imports nothing), so
 * the away-edge derivation and the sky's edge colour cannot drift apart.
 */
import { HAZE_COLOR } from './palettes';

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
   * toward the sun; the anti-solar horizon is a muted grey-rose.
   *
   * 2026-11-07 re-calibration (plan v2 / review M5): the away sea is a mirror of
   * THIS colour — darkening the sea's reflection coefficient instead would crack
   * the sea-sky seam, so "背阳沉得深" is done here, at the source. The old
   * (#8f5a90, 0.8) pair measured linear luminance 0.210 at the edge; this pair
   * derives 0.162. (The review's example pair 0.55/#7f4f7e computes BRIGHTER than
   * status quo — more horizon leaks through at low gain — and was rejected on
   * arithmetic before capture.)
   */
  AWAY_COLOR: '#5a3f60',
  /**
   * How far the anti-solar horizon moves toward `AWAY_COLOR`, 0..1.
   *
   * 0.75 keeps enough of the ramp's warmth that both sides still read as one sky;
   * 1.0 looks like two pictures stitched together at the sun. Tuning bounds for
   * QA: the derived edge must keep linear luminance <= 0.17 (`awayHorizonLinear`
   * test pins this).
   */
  AWAY_GAIN: 0.75,
  /** sin(elevation) over which the cool tint fades out going up. */
  AWAY_HEIGHT: 0.42,
} as const;

/**
 * pow(max(sunDot, 0), pow) * gain, NaN → 0.
 *
 * `opts` (day-night track, 2026-11-08): the track's glowPow/glowGain vary per
 * keyframe; omitting it keeps the module constants, so every existing caller and
 * test is untouched. The TSL graph passes the SAME per-keyframe values from its
 * uniforms — keep the two in step.
 */
export function horizonGlow(sunDot: number, opts?: { pow: number; gain: number }): number {
  if (!Number.isFinite(sunDot)) return 0;
  const pow = opts?.pow ?? HORIZON.GLOW_POW;
  const gain = opts?.gain ?? HORIZON.GLOW_GAIN;
  return Math.pow(Math.max(sunDot, 0), pow) * gain;
}

/**
 * The away-side horizon colour as LINEAR RGB — the exact colour `skyColorTsl`
 * paints at the away edge (dirY ≈ 0, away = 1), derived here so the sea's haze
 * can target the same value without freezing a second copy of the bytes.
 *
 * Pure sRGB decode: `c <= 0.04045 ? c/12.92 : ((c+0.055)/1.055)^2.4`. Deliberately
 * dependency-free (no THREE) — horizon.ts stays importable from the spectrum tests.
 */
export function awayHorizonLinear(): [number, number, number] {
  const decode = (css: string): [number, number, number] => [
    parseInt(css.slice(1, 3), 16),
    parseInt(css.slice(3, 5), 16),
    parseInt(css.slice(5, 7), 16),
  ].map((byte) => {
    const c = byte / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  const horizon = decode(HAZE_COLOR); // single source: the same colour the sky paints at its edge
  const away = decode(HORIZON.AWAY_COLOR);
  const k = HORIZON.AWAY_GAIN;
  return [
    (1 - k) * horizon[0] + k * away[0],
    (1 - k) * horizon[1] + k * away[1],
    (1 - k) * horizon[2] + k * away[2],
  ];
}

/**
 * The sea's haze colour target at a bearing — exactly what the sky paints at
 * its own horizon edge there: `mix(HAZE, AWAY_lin, antiSolarCool(cosAz, 0))`.
 *
 * Algebra note (final review, Important 1): this is `mix(HAZE, awayHorizonLinear(),
 * away^1.2)` — the AWAY_GAIN lives ONCE, inside `awayHorizonLinear()`. Weighting
 * the pre-mixed edge with `antiSolarCool` itself would apply the gain twice
 * (g²) and crack the sea-sky seam the moment HAZE_MAX or AWAY_GAIN is retuned.
 * The TSL graph (`material.ts` seaHazeTsl) mirrors this shape with the live
 * reflected-ray height as `lowSky`. NaN bearing falls back to HAZE.
 */
export function seaHazeTargetLinear(
  cosAz: number,
  endpoints?: { haze: import('./sky-track').Vec3; awayEdge: import('./sky-track').Vec3 },
): [number, number, number] {
  const decode = (css: string): [number, number, number] =>
    [parseInt(css.slice(1, 3), 16), parseInt(css.slice(3, 5), 16), parseInt(css.slice(5, 7), 16)].map(
      (byte) => {
        const c = byte / 255;
        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      },
    ) as [number, number, number];
  const haze = endpoints ? endpoints.haze : decode(HAZE_COLOR);
  if (!Number.isFinite(cosAz)) return [haze[0], haze[1], haze[2]];
  // track endpoints (day-night Task 5): the caller derives them from `skyColorJs`
  // (seaHazeEndpoints), so the energy field's azimuth variation is included and the
  // two sides cannot double-model the azimuth. Omitted → today's constants path.
  const edge = endpoints ? endpoints.awayEdge : awayHorizonLinear();
  const away = Math.min(Math.max((1 - cosAz) * 0.5, 0), 1);
  const w = Math.pow(away, 1.2); // horizon height: lowSky = 1; AWAY_GAIN lives inside `edge`
  return [
    (1 - w) * haze[0] + w * edge[0],
    (1 - w) * haze[1] + w * edge[1],
    (1 - w) * haze[2] + w * edge[2],
  ];
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
export function antiSolarCool(cosAz: number, dirY: number, opts?: { awayGain: number; awayHeight: number }): number {
  if (!Number.isFinite(cosAz) || !Number.isFinite(dirY)) return 0;
  const away = Math.min(Math.max((1 - cosAz) * 0.5, 0), 1);
  const height = opts?.awayHeight ?? HORIZON.AWAY_HEIGHT;
  const gain = opts?.awayGain ?? HORIZON.AWAY_GAIN;
  const t = Math.min(Math.max(dirY / height, 0), 1);
  const lowSky = 1 - t * t * (3 - 2 * t);
  return Math.pow(away, 1.2) * lowSky * gain;
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
