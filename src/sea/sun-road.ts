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
import { WATER_OPTICS } from './water-shading';
import { PAINTED_SEA } from './look';

/** Headroom between a tier's road budget and its bloom threshold. */
export const K4_MARGIN = 0.063;

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
   * of being a *peak*. Kept despite the knee: the gate still drives the shape,
   * while `roadSpecKnee × ROAD_CEILING` enforces the brightness budget the old
   * 3.0-amplitude chain broke (plan v2, review E4/M4).
   */
  ROAD_PEAK: 2.0,
  /** The sea's glint gain, carried over verbatim. */
  BASE: 1.5,
  /**
   * Specular exponent, migrated from the hardcoded `pow(96.0)` in
   * `material.ts` so the JS mirror and the graph cannot drift. 96 is the
   * exponent the deleted FFT sea tuned — 170 shattered into speckle.
   */
  GLOSS_POW: 96,
  /**
   * Continuous-road ceiling: the knee's output is scaled to the tier's road
   * budget (bloom threshold minus the K4 margin), which is what the old chain
   * exceeded 4x. Derived, never re-typed.
   */
  ROAD_CEILING: roadBudget('high'),
  /**
   * Knee softness. Derived from two red lines (plan v2 Task 2 tests): the
   * boosted core must clear the bloom threshold (ceiling × BOOST > 0.82) while
   * the road keeps at least 2.5x its surround. 1.2 flattened the azimuth gate
   * to 2.1x; 0.8 lands 2.65x with cores at ~0.895.
   */
  KNEE_K: 0.8,
  /**
   * Sparkle threshold on the per-pixel `dot(reflect(sun, N), V)`: only facets
   * whose normal lands inside this half-angle cone of the exact mirror
   * direction lift the glint. This is the Cox-Munk move — density comes from
   * the real slope field, so it self-LODs (mip-averaged far slopes smooth the
   * dot field) and needs no noise texture (review M1/M2: a 1.17 cm texture is
   * salt-and-pepper at the A camera). Lower the threshold for denser glitter.
   */
  GLINT_COS_THRESHOLD: 0.9995,
  /** Soft-edge width of that threshold, in cosine units. */
  GLINT_COS_BAND: 0.0005,
  /**
   * How much a sparkle core lifts the continuous road, as a lerp multiplier:
   * `cont × (1 + (BOOST − 1) × core)`. At the road centre this lands
   * ceiling × 1.3 ≈ 0.895 — just over the bloom threshold, never through the
   * channel (review M3: the additive form stacked to 1.74).
   */
  SPARKLE_BOOST: 1.3,
  /**
   * P2-3 近场流速暗示·其二（spec Q2-2）：太阳 road 的 sparkle core 增益
   * 随速度 +15%。只乘 core 项——连续 road 仍被 ROAD_CEILING 钉住，
   * 满速上限 = ceiling × (1 + 0.3 × 1.15) = ceiling × 1.345。
   * TSL 侧（material.ts sparkleGlintTsl）在 speedU uniform 里镜像同一系数。
   */
  ROAD_SPEED_LIFT: 0.15,
  /**
   * Schlick F0 for water at normal incidence.
   *
   * Single source: `water-shading.ts` derives 0.0204 from the air/water IOR
   * pair. It is NOT 0.04 — that generic-dielectric value doubles the head-on
   * sky reflection and is what makes water read as glossy plastic.
   */
  F0: WATER_OPTICS.F0,
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

function smoothstep01(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

/**
 * Soft saturation `1 − exp(−x·k)`: monotone, `0 → 0`, asymptote 1. The knee is
 * what turns the old 3.0-amplitude road into a budget-respecting one — the
 * shape survives, the top is compressed. NaN reads as 0.
 */
export function roadSpecKnee(x: number, k: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(k) || k <= 0) return 0;
  return 1 - Math.exp(-Math.max(x, 0) * k);
}

/**
 * The sea's continuous road gain, under the tier's brightness budget.
 *
 * `specDot` is the per-pixel `max(0, dot(reflect(sun, N), V))` — the real facet
 * orientation, not a pre-exponentiated value. The gate concentrates what
 * survives toward the sun's bearing; the knee then caps the whole chain at
 * `ROAD_CEILING`, which the old `spec × BASE × gate` chain exceeded 4x.
 */
export function sunRoadGain(specDot: number, azimuthDiff: number, nearFade: number): number {
  if (!Number.isFinite(specDot) || !Number.isFinite(nearFade)) return 0;
  const gate = SUN_ROAD.ROAD_FLOOR + (SUN_ROAD.ROAD_PEAK - SUN_ROAD.ROAD_FLOOR) * roadMask(azimuthDiff);
  const spec = Math.pow(Math.max(specDot, 0), SUN_ROAD.GLOSS_POW);
  const drive = spec * SUN_ROAD.BASE * Math.max(nearFade, 0) * gate;
  return roadSpecKnee(drive, SUN_ROAD.KNEE_K) * SUN_ROAD.ROAD_CEILING;
}

/**
 * The sparkle layer on top of the continuous road, LERP form (review M3): a
 * core lifts the road by `SPARKLE_BOOST`, it never stacks on top of it. Cores
 * are facets inside `GLINT_COS_THRESHOLD` of the mirror direction — density
 * rides the real slope field, so it thins with distance for free.
 *
 * `coreGate` (0..1) confines the lift to the road: with SLOPE_GAIN inflating
 * facet normals, off-road bearings could otherwise still align a core — real
 * seas show essentially no glints 180 deg off the sun (QA round 1 finding).
 *
 * `speed01` (0..1, default 0 = today's look): the P2-3 flow hint. The core
 * lift grows 15% with speed; garbage reads as 0 (no lift, never a flash).
 */
export function sparkleGlint(cont: number, specDot: number, coreGate: number = 1, speed01: number = 0): number {
  if (!Number.isFinite(cont) || !Number.isFinite(specDot)) return 0;
  const lift = Number.isFinite(speed01)
    ? 1 + SUN_ROAD.ROAD_SPEED_LIFT * Math.min(Math.max(speed01, 0), 1)
    : 1;
  const core =
    smoothstep01(
      SUN_ROAD.GLINT_COS_THRESHOLD,
      SUN_ROAD.GLINT_COS_THRESHOLD + SUN_ROAD.GLINT_COS_BAND,
      specDot,
    ) * Math.min(Math.max(coreGate, 0), 1);
  return cont * (1 + (SUN_ROAD.SPARKLE_BOOST - 1) * lift * core);
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

/** JS mirror of material.ts's painted road, including AA, quality and speed. */
export function paintedSunRoadGain(
  specDot: number, azimuth: number, nearFade: number,
  tier: 'high' | 'low' = 'high', speed01 = 0, footprint = 0, roadFootprint = 0,
): number {
  if (![specDot, azimuth, nearFade, speed01, footprint, roadFootprint].every(Number.isFinite)) return 0;
  const mask = roadMask(azimuth);
  const gate = SUN_ROAD.ROAD_FLOOR + (SUN_ROAD.ROAD_PEAK - SUN_ROAD.ROAD_FLOOR) * mask;
  const drive = clamp01(specDot) ** PAINTED_SEA.gloss * SUN_ROAD.BASE *
    (tier === 'high' ? 1 : SUN_ROAD.lowTierGain) * clamp01(nearFade) * gate;
  const knee = roadSpecKnee(drive, SUN_ROAD.KNEE_K);
  const roadAA = Math.max(0, roadFootprint);
  const patch = smoothstep01(PAINTED_SEA.roadEdge[0] - roadAA,
    PAINTED_SEA.roadEdge[1] + roadAA, knee) * PAINTED_SEA.roadPlateau *
    (SUN_ROAD.ROAD_FLOOR + (1 - SUN_ROAD.ROAD_FLOOR) * mask) * clamp01(nearFade);
  const cont = (knee * 0.25 + patch * 0.75) * SUN_ROAD.ROAD_CEILING;
  const aa = Math.max(0, footprint);
  const core = smoothstep01(SUN_ROAD.GLINT_COS_THRESHOLD - aa,
    SUN_ROAD.GLINT_COS_THRESHOLD + SUN_ROAD.GLINT_COS_BAND + aa, clamp01(specDot));
  return cont * (1 + PAINTED_SEA.sparkle * core * mask *
    (1 + clamp01(speed01) * SUN_ROAD.ROAD_SPEED_LIFT)) * PAINTED_SEA.road;
}
