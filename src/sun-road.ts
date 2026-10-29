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
  /** How much brighter the road is than the bare specular (gain = 1 + STRETCH under it). */
  STRETCH: 1.6,
  /** The sea's existing glint gain, moved here verbatim. */
  BASE: 1.5,
  /** The sea's existing specular exponent, documented here and kept in sea-fft. */
  NARROW: 96,
} as const;

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0;
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

/** The sea's glint gain: the bare specular, the road boost inside the azimuth gate. */
export function sunRoadGain(spec: number, azimuthDiff: number, nearFade: number): number {
  if (!Number.isFinite(spec) || !Number.isFinite(nearFade)) return 0;
  return spec * SUN_ROAD.BASE * Math.max(nearFade, 0) * (1 + SUN_ROAD.STRETCH * roadMask(azimuthDiff));
}
