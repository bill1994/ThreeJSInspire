/**
 * The two FFT cascades and their validity rules.
 *
 * Bands are disjoint and split at ONE shared boundary wave number
 * (2π / BAND_SPLIT_METRES): the swell cascade holds the long waves the
 * geometry can actually resolve, the chop cascade holds 32–128 m waves plus
 * the merged 4–27.5 m fine octave. All rings sample C1 in the fragment; only
 * the near ring samples its low-passed displacement. Both lattices avoid the boundary exactly
 * (192·(2π/128) needs mode 1.5), so no mode is double-counted.
 */

export interface Cascade {
  name: string;
  tileMetres: number;
  n: number;
  amplitudePeak: number;
  /** Wavelength window [lo, hi] in metres. */
  bandMetres: readonly [number, number];
  /**
   * Fine octave merged INTO the same lattice (fine-octave plan Task 2):
   * window [lo, hi] in metres, own crest target, own seed. The seed is a
   * CONTRACT pinned on the config — `material.ts`'s SPECTRUM_SEED is module-
   * private and untestable, so the fine stream must be readable.
   */
  fineBandMetres?: readonly [number, number];
  fineCrestMetres?: number;
  fineSeed?: number;
}

export const BAND_SPLIT_METRES = 128;

export const CASCADES: readonly Cascade[] = [
  { name: 'swell', tileMetres: 1024, n: 256, amplitudePeak: 0.45, bandMetres: [128, 1024] },
  {
    name: 'chop',
    tileMetres: 192,
    n: 256,
    amplitudePeak: 0.1,
    bandMetres: [32, 128],
    // Fine 4–27.5 m octave, merged into the SAME 192 m lattice (plan 2026-11-08-
    // sea-nearfield-octave Task 2). The 32–128 m sub-band coefficients stay
    // BIT-IDENTICAL (same seed, same window, same scale path; the fine stream is
    // a second spectrum added per cell AFTER both are scaled — pinned cell-by-
    // cell plus a golden pin in `fine-band.test.ts`).
    //
    // Upper bound 27.5 m: 2π/27.5 falls between lattice radius 7 (λ=27.43 m,
    // included) and radius 6 (λ=32 m — the shared C0/C1 boundary mode, excluded),
    // so the fine band and the sub-band never share a cell and λ=32 is never
    // double-counted. <8 m carries ~0.50% of the fine band's energy under the
    // Phillips ℓ=tile/100 damping — the fine band effectively spans 8–27.4 m.
    //
    // `amplitudePeak` stays 0.1 ON PURPOSE: the guard exists for VERTEX
    // displacement vertical aliasing and the fine band does not enter the
    // geometry (Task 3 low-passes the vertex C1 sample at the 32 m floor). The
    // 69° fov / 1920 px ceiling is 0.13746 — setting the field to 0.14 would
    // trip `cascadeIsValid`; the merged crest expectation is 2σ ≈ 0.1077 (not
    // the worst-case 0.1 + 0.04 sum). `water-shading.ts` SLOPE_GAIN's comment
    // quotes the C0+C1 total slope (raw 0.0117, ×14 → 0.1640); with the fine
    // band the all-field slope lands ≈0.1901 at crest 0.04.
    fineBandMetres: [4, 27.5],
    fineCrestMetres: 0.04,
    fineSeed: 20261107,
  },
];

/**
 * Vertical aliasing guard: a cascade whose peak amplitude could climb more
 * than one pixel per tile width would shimmer. `tileMetres` must exceed
 * `amplitudePeak / radPerPixel` under the CURRENT view budget.
 */
export function cascadeIsValid(c: Cascade, radPerPixel: number): boolean {
  return c.tileMetres > c.amplitudePeak / radPerPixel;
}

/**
 * ~4.9 samples per wavelength rule (`rings.ts:10-14`): the mip level at which a
 * texture texel spans ~4.9 samples of the shortest wave the vertex path should
 * still carry. Numerator = `CASCADES[1].bandMetres[0]` = 32 — the shortest wave
 * the vertex path KEEPS (NOT `BAND_SPLIT_METRES` = 128, the C0/C1 boundary;
 * feeding 128 in gives 5.1287 and contradicts the pinned 3.1287). Denominator
 * 192/256 = C1's metres-per-texel.
 *
 * This HONOURS the `rings.ts` contract: its docblock says `mipLod` should low-
 * pass everything below the ring's `floorMetres` (R0 floor = 32 m), while the
 * C1 vertex sample ran at `.level(0)` — the fine octave (Task 2) would have
 * leaked into the geometry that cannot resolve it. Fixed single LOD, no ring
 * seam: only R0 samples C1 per vertex (`material.ts` `vertexChop: i === 0`);
 * the fragment path keeps its per-pixel automatic mips.
 *
 * **If C1's window ever moves, re-derive this** — a lower window would loosen
 * the vertex low-pass and leak the fine band into the geometry.
 */
export const SAMPLES_PER_WAVE = 4.878;

export const C1_VERTEX_MIP_LOD = Math.log2(
  (CASCADES[1].bandMetres[0] / SAMPLES_PER_WAVE) / (CASCADES[1].tileMetres / CASCADES[1].n),
);

/** lcm(1024, 192): the period after which the summed surface repeats. */
export const LCM_METERS = 3072;

/**
 * World-rebase quantum for long flights. fp32 at 10⁶ m has ulp = 0.0625 m, so
 * the camera origin is rebased in steps that are exact multiples of the LCM —
 * any other step would make the whole surface jump.
 */
export const REBASE_QUANTUM = 3072;
