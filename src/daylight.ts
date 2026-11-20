import { SUN_DIRECTION } from './palettes';

/** Shared art transitions, expressed in sun-direction Y for the JS/TSL paths. */
export const DAYLIGHT = {
  palette: [SUN_DIRECTION[1], Math.sin(20 * Math.PI / 180)] as const,
  water: [Math.sin(-8 * Math.PI / 180), SUN_DIRECTION[1]] as const,
  direct: [Math.sin(-2 * Math.PI / 180), Math.sin(2 * Math.PI / 180)] as const,
  waterNight: [0.08, 0.14, 0.25] as const,
  foamNight: [0.035, 0.055, 0.09] as const,
  moonTint: [0.10, 0.16, 0.25] as const,
  moonGain: 0.12,
  twilightPalette: 0.85,
} as const;

export function daylightWeight(y: number, range: readonly [number, number]): number {
  if (!Number.isFinite(y)) return 0;
  const t = Math.min(1, Math.max(0, (y - range[0]) / (range[1] - range[0])));
  return t * t * (3 - 2 * t);
}

/** Keep an authored twilight sky even when the scattering ratio collapses at sunrise. */
export function skyPaletteWeight(y: number): number {
  const twilight = daylightWeight(y, [DAYLIGHT.water[0], 0])
    * (1 - daylightWeight(y, [0, DAYLIGHT.palette[0]])) * DAYLIGHT.twilightPalette;
  return Math.max(daylightWeight(y, DAYLIGHT.palette), twilight);
}

/** Sun by day, antipodal moon by night, lifting through dusk without a zero vector. */
export function dayNightLightDirection(sun: readonly [number, number, number]): [number, number, number] {
  const elevation = Math.asin(Math.min(1, Math.max(-1, sun[1]))) * 180 / Math.PI;
  const k = 2 * daylightWeight(elevation, [-8, 0]) - 1;
  const x = sun[0] * k, z = sun[2] * k;
  const y = Math.max(sun[1] * k, Math.sin(2 * Math.PI / 180)) + (1 - Math.abs(k)) * 0.5;
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}
