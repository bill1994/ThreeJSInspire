/**
 * The two FFT cascades and their validity rules.
 *
 * Bands are disjoint and split at ONE shared boundary wave number
 * (2π / BAND_SPLIT_METRES): the swell cascade holds the long waves the
 * geometry can actually resolve, the chop cascade holds 32–128 m waves that
 * only the near ring samples. Both lattices avoid the boundary exactly
 * (192·(2π/128) needs mode 1.5), so no mode is double-counted.
 */

export interface Cascade {
  name: string;
  tileMetres: number;
  n: number;
  amplitudePeak: number;
  /** Wavelength window [lo, hi] in metres. */
  bandMetres: readonly [number, number];
}

export const BAND_SPLIT_METRES = 128;

export const CASCADES: readonly Cascade[] = [
  { name: 'swell', tileMetres: 1024, n: 256, amplitudePeak: 0.45, bandMetres: [128, 1024] },
  { name: 'chop', tileMetres: 192, n: 256, amplitudePeak: 0.1, bandMetres: [32, 128] },
];

/**
 * Vertical aliasing guard: a cascade whose peak amplitude could climb more
 * than one pixel per tile width would shimmer. `tileMetres` must exceed
 * `amplitudePeak / radPerPixel` under the CURRENT view budget.
 */
export function cascadeIsValid(c: Cascade, radPerPixel: number): boolean {
  return c.tileMetres > c.amplitudePeak / radPerPixel;
}

/** lcm(1024, 192): the period after which the summed surface repeats. */
export const LCM_METERS = 3072;

/**
 * World-rebase quantum for long flights. fp32 at 10⁶ m has ulp = 0.0625 m, so
 * the camera origin is rebased in steps that are exact multiples of the LCM —
 * any other step would make the whole surface jump.
 */
export const REBASE_QUANTUM = 3072;
