/**
 * src/sea/sun-road.ts — turns the sea's specular glint into a road toward the
 * sun. `sunRoadGain` / `fresnel01` / `roadMask` / `azimuthDiff` are carried over
 * verbatim from `a842657:src/sun-road.ts` (the deleted FFT sea's module); the
 * slope-graded `specExponent` constants died with their only consumer — the new
 * material pins one glint exponent instead.
 *
 * New here: `roadBudget(tier)` — the per-tier ceiling the road's 99th-percentile
 * brightness must stay under. `K4_MARGIN` comes from the surviving
 * `docs/superpowers/plans/2026-10-31-sky-technical-note.md` K4 calibration (the
 * bloom threshold sits on the cloud's golden face at 0.820); the thresholds
 * themselves are read from `post.ts`, the single source — never re-typed here.
 */
import { POST_HIGH, POST_LOW } from '../post';

export const SUN_ROAD = {
  /** Half-width of the road, in degrees off the sun's bearing. */
  WIDTH_DEG: 25,
  /**
   * Fraction of the bare glint that survives outside the road. The road narrows
   * the base instead of boosting it: the pre-rebuild glitter is what `post.ts`
   * tuned its bloom threshold against, so the off-road peak must not move.
   */
  ROAD_FLOOR: 0.35,
  /**
   * Gate value at the road's centre. A floor alone can only attenuate, so with
   * `ROAD_FLOOR` as the only free parameter the road is structurally incapable
   * of being a *peak*. Above 1 the road reaches `post.ts`'s bloom threshold —
   * once the road has a peak, blooming is the correct response.
   */
  ROAD_PEAK: 2.0,
  /** The sea's glint gain, carried over verbatim. */
  BASE: 1.5,
  /** Schlick F0 for water at normal incidence. */
  F0: 0.02,
  /**
   * How much of the grazing Fresnel term is allowed into the colour.
   *
   * Deliberately small. Fresnel is ~0.36 over most of the visible patch at cruise
   * altitude, so a large gain flattens the whole sea into one pale sheet — this is
   * a *warm-up* at grazing angles, not a second light.
   */
  FRESNEL_GAIN: 0.15,
  /** Near-field fade: the road must not glare right under the camera. */
  NEAR_FADE_START: 6,
  NEAR_FADE_END: 30,
  /**
   * Extra gain applied to the road on the low tier, so the same road reads the
   * same under the low tier's higher bloom threshold (0.85 vs 0.82). Stays 1.0
   * until the two tiers' measured road brightness diverge by more than 10%;
   * the measured value then lands here with a comment.
   */
  lowTierGain: 1.0,
} as const;

/** Headroom between a tier's road budget and its bloom threshold. */
export const K4_MARGIN = 0.063;

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0;
}

/**
 * Schlick Fresnel. At grazing angles water reflects almost everything, which is
 * why the sea warms toward the sky colour as it recedes.
 */
export function fresnel01(cosTheta: number): number {
  // NaN reads as head-on (F0) rather than as grazing (1): a degenerate view ray
  // must not flash the whole patch to full reflection.
  if (!Number.isFinite(cosTheta)) return SUN_ROAD.F0;
  const k = 1 - clamp01(cosTheta);
  return SUN_ROAD.F0 + (1 - SUN_ROAD.F0) * k * k * k * k * k;
}

/** 1 under the sun, 0 beyond WIDTH_DEG off its bearing, NaN → 0. */
export function roadMask(azimuthDiff: number): number {
  if (!Number.isFinite(azimuthDiff)) return 0;
  const cosEdge = Math.cos((SUN_ROAD.WIDTH_DEG * Math.PI) / 180);
  const x = Math.cos(azimuthDiff);
  const t = Math.min(Math.max((x - cosEdge) / (1 - cosEdge), 0), 1);
  return t * t * (3 - 2 * t);
}

/** Horizontal-plane angle (radians, 0..π) between two bearings given as (x, z). */
export function azimuthDiff(sunX: number, sunZ: number, viewX: number, viewZ: number): number {
  const dot = sunX * viewX + sunZ * viewZ;
  const la = Math.hypot(sunX, sunZ);
  const lb = Math.hypot(viewX, viewZ);
  if (la < 1e-9 || lb < 1e-9) return Number.NaN; // degenerate bearing reads as "no road"
  return Math.acos(Math.min(Math.max(dot / (la * lb), -1), 1));
}

/**
 * The sea's glint gain: the bare specular everywhere, gated by the azimuth mask
 * so the road concentrates it toward the sun. Inside the road the gate rises to
 * `ROAD_PEAK` (> 1) so the road reads as a peak; outside it falls back to
 * `ROAD_FLOOR`.
 */
export function sunRoadGain(spec: number, azimuthDiff: number, nearFade: number): number {
  if (!Number.isFinite(spec) || !Number.isFinite(nearFade)) return 0;
  const gate = SUN_ROAD.ROAD_FLOOR + (SUN_ROAD.ROAD_PEAK - SUN_ROAD.ROAD_FLOOR) * roadMask(azimuthDiff);
  return spec * SUN_ROAD.BASE * Math.max(nearFade, 0) * gate;
}

/**
 * Per-tier brightness ceiling for the road's 99th percentile, measured over the
 * water only (the sky disc deliberately exceeds its own threshold). Exceeding it
 * means lowering `SUN_ROAD.ROAD_PEAK`, never raising `bloomThreshold`.
 */
export function roadBudget(tier: 'high' | 'low'): number {
  const threshold = tier === 'high' ? POST_HIGH.bloomThreshold : POST_LOW.bloomThreshold;
  return threshold - K4_MARGIN;
}
