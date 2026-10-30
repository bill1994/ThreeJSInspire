/**
 * src/sun-road.ts — turns the sea's existing specular glitter into a road toward
 * the sun. No second highlight term: the sea already has `spec = pow(dot(reflect(
 * -sunDir, n), viewDir), 96)` (96 is tuned — 170 shattered into speckle) and the
 * near fade; this module only multiplies an azimuth gate on top so the glitter
 * concentrates inside ±WIDTH_DEG of the sun's bearing and fades to plain sparkle
 * outside it.
 */

export const SUN_ROAD = {
  /** Half-width of the road, in degrees off the sun's bearing. */
  WIDTH_DEG: 25,
  /**
   * Fraction of the bare glint that survives outside the road. The road narrows the base
   * instead of boosting it: the pre-T12 glitter (spec * BASE) is what `post.ts` tuned its
   * bloom threshold against, so the peak must not move.
   */
  ROAD_FLOOR: 0.35,
  /** The sea's existing glint gain, moved here verbatim. */
  BASE: 1.5,
  /** The sea's existing specular exponent, documented here and kept in sea-fft. */
  NARROW: 96,
  /**
   * Specular exponent at a *steep* facet. Real water is not a mirror everywhere: a flat patch
   * reflects a narrow image of the sun, a steep one smears it into a broad wash. Holding one
   * exponent across the whole patch was what made the glitter read as a uniform speckle field
   * rather than a road with texture.
   */
  BROAD: 26,
  /** Slope (1 - normal.y) at which the facet counts as fully steep. */
  SLOPE_FULL: 0.3,
  /** Schlick F0 for water at normal incidence. */
  F0: 0.02,
  /**
   * How much of the grazing Fresnel term is allowed into the colour.
   *
   * Deliberately small. Fresnel is ~0.36 over most of the visible patch at cruise altitude, so
   * at 0.55 the additive term overwhelmed the deep/mid bands and flattened the whole sea into
   * one pale salmon sheet — the violet water disappeared. This is a *warm-up* at grazing
   * angles, not a second light: it must stay well under the band colours it sits on.
   */
  FRESNEL_GAIN: 0.15,
} as const;

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0;
}

/** 0 on flat water, 1 at `SLOPE_FULL`, NaN → 0. */
export function slope01(normalY: number): number {
  if (!Number.isFinite(normalY)) return 0;
  return clamp01((1 - normalY) / SUN_ROAD.SLOPE_FULL);
}

/**
 * Specular exponent for a facet of the given slope: `NARROW` on flat water, `BROAD` once the
 * facet is fully tilted. NaN → `NARROW` (a flat, mirror-like facet, i.e. the safe default).
 */
export function specExponent(slope: number): number {
  const s = clamp01(slope);
  return SUN_ROAD.NARROW + (SUN_ROAD.BROAD - SUN_ROAD.NARROW) * s;
}

/**
 * Schlick Fresnel. At grazing angles water reflects almost everything, which is why the sea
 * warms toward the sky colour as it recedes — this term is what carries that, and it is the
 * source of the near-field "broken diamond" shimmer once the normals are choppy.
 */
export function fresnel01(cosTheta: number): number {
  // NaN reads as head-on (F0) rather than as grazing (1): a degenerate view ray must not
  // flash the whole patch to full reflection.
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
 * The sea's glint gain: the bare specular everywhere, gated by the azimuth mask so the road
 * concentrates it toward the sun. The peak equals the bare glint — the road narrows the base,
 * it never multiplies it, which is what keeps `post.ts`'s bloom threshold valid.
 */
export function sunRoadGain(spec: number, azimuthDiff: number, nearFade: number): number {
  if (!Number.isFinite(spec) || !Number.isFinite(nearFade)) return 0;
  const gate = SUN_ROAD.ROAD_FLOOR + (1 - SUN_ROAD.ROAD_FLOOR) * roadMask(azimuthDiff);
  return spec * SUN_ROAD.BASE * Math.max(nearFade, 0) * gate;
}
