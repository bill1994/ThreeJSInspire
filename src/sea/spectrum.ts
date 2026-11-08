/**
 * Spectral coefficients for the stylized FFT ocean: a Phillips wind sea with a
 * fixed seed, band-limited per cascade. Mode cells are independent draws, so the
 * GPU phase-evolution pass reads h̃₀(k) and h̃₀(−k) from one texture and combines
 * them with the two-term rule — the storage itself carries no conjugate pairing.
 *
 * Conventions (pinned — the CPU oracle and the GPU chain must agree):
 * - metres, seconds, radians; deep water, ω = √(g·k).
 * - Layout: standard FFT order — DC at index (0, 0), Nyquist line at n/2.
 * - Mode k for index i: `k = (i ≤ n/2 ? i : i − n) · dk`, `dk = 2π/tileMetres`.
 * - Storage: `[re, im]` as two parallel planes, row-major with z rows.
 * - Wind direction: angle from −Z rotating toward +X, so 0° sends waves toward
 *   the sun's default bearing (the sun road reads best aligned with the wind).
 */

const G = 9.81;

/** Deep-water dispersion ω = √(g·k). */
export function dispersion(k: number, g = 9.81): number {
  return Math.sqrt(g * k);
}

/** Phillips amplitude constant (absolute variance is calibrated by `amplitudePeak`). */
export const PHILLIPS_A = 1.0;
/** Directional spreading exponent on the standard squared `|k̂·ŵ|²` term. */
export const SPREAD_EXP = 1;
/** Small-wave damping length as a fraction of the tile: ℓ = tile/100. */
export const PHILLIPS_ELL_DIVISOR = 100;

/** Phillips spectrum P(k), already damped at both ends of the k range. */
export function phillips(
  kx: number,
  kz: number,
  windSpeed: number,
  windDirRad: number,
  tileMetres: number,
): number {
  const kx2 = kx * kx;
  const kz2 = kz * kz;
  const k2 = kx2 + kz2;
  if (k2 === 0) return 0;
  const k = Math.sqrt(k2);
  // Largest possible wave from wind speed V: L = V²/g.
  const bigL = (windSpeed * windSpeed) / G;
  const ell = tileMetres / PHILLIPS_ELL_DIVISOR;
  const wx = Math.sin(windDirRad);
  const wz = -Math.cos(windDirRad);
  const dot = (kx * wx + kz * wz) / k;
  const dirFactor = Math.pow(dot * dot, SPREAD_EXP);
  return (
    (PHILLIPS_A * Math.exp(-1 / (k2 * bigL * bigL)) * dirFactor * Math.exp(-k2 * ell * ell)) /
    (k2 * k2)
  );
}

export interface SpectrumOpts {
  n: number;
  tileMetres: number;
  /** Wavelength window [lo, hi] in metres; C0 = [128, 1024], C1 = [32, 128]. */
  bandMetres: readonly [number, number];
  windSpeed: number;
  windDirRad: number;
  seed: number;
}

export interface ComplexField {
  re: Float32Array;
  im: Float32Array;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  // Box–Muller; the log guard keeps a zero uniform from producing Infinity.
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Build the initial spectrum h̃₀(k) with INDEPENDENT draws at every mode.
 *
 * Tessendorf's h̃₀(k) and h̃₀(−k) are separate random values — the conjugate
 * symmetry that makes the surface real comes from the two-term evolution
 * `h̃(k,t) = h̃₀(k)e^{iωt} + h̃₀*(−k)e^{−iωt}`, not from the storage. Storing a
 * Hermitian pair instead collapses every mode to `2h̃₀(k)cos(ωt)`: standing
 * waves, a dead sea.
 *
 * DC and both Nyquist lines are zeroed — for even N the Nyquist modes are their
 * own conjugate partners and would leak imaginary energy into the surface. The
 * band window keeps `2π/bandMetres[1] ≤ |k| ≤ 2π/bandMetres[0]`; the C0/C1
 * boundary at 2π/128 m is shared, and neither production tile's mode lattice
 * lands on it exactly (192·(2π/128) needs mode 1.5), so the cascades are
 * disjoint by construction.
 */
export function buildSpectrum(opts: SpectrumOpts): ComplexField {
  const n = opts.n;
  const dk = (2 * Math.PI) / opts.tileMetres;
  const minK = (2 * Math.PI) / opts.bandMetres[1];
  const maxK = (2 * Math.PI) / opts.bandMetres[0];
  const rand = mulberry32(opts.seed);
  const re = new Float32Array(n * n);
  const im = new Float32Array(n * n);
  const kAt = (idx: number): number => (idx <= n / 2 ? idx : idx - n) * dk;

  for (let nz = 0; nz < n; nz += 1) {
    for (let nx = 0; nx < n; nx += 1) {
      if (nx === 0 && nz === 0) continue; // DC
      if (nx === n / 2 || nz === n / 2) continue; // Nyquist lines
      const kx = kAt(nx);
      const kz = kAt(nz);
      const k = Math.hypot(kx, kz);
      if (k < minK || k > maxK) continue;
      const p = phillips(kx, kz, opts.windSpeed, opts.windDirRad, opts.tileMetres);
      const amp = Math.sqrt(p / 2);
      re[nz * n + nx] = amp * gaussian(rand);
      im[nz * n + nx] = amp * gaussian(rand);
    }
  }
  return { re, im };
}

/**
 * Pure per-cell addition of `add` into `base` — BOTH already scaled by their own
 * crest targets, no rescale, no re-window afterwards. This is the merge contract
 * the fine-band test pins cell-by-cell (Float32 fround semantics): reopening the
 * window or renormalising after the add would break the sub-band's bit-identical
 * guarantee (fine-octave plan Task 2).
 */
export function accumulateSpectrum(base: ComplexField, add: ComplexField): void {
  if (base.re.length !== add.re.length || base.im.length !== add.im.length) {
    throw new Error('accumulateSpectrum: field size mismatch');
  }
  for (let i = 0; i < base.re.length; i += 1) {
    base.re[i] += add.re[i];
    base.im[i] += add.im[i];
  }
}

/**
 * Scale that brings the evolved field's crest to `amplitudePeak`.
 *
 * The raw Phillips spectrum with A = 1 delivers absurd amplitudes (tens to
 * hundreds of metres at wind 9 m/s) — `CASCADES.amplitudePeak` is the design
 * crest and must be applied to the coefficients before upload. Oceanographic
 * convention: significant height Hs = 4σ (σ = RMS of the surface), crest
 * ≈ Hs/2 = 2σ — so the scale targets `amplitudePeak = 2·RMS` of the t=0
 * evolved field. The variance is time-invariant to within the cross-term
 * oscillation, so one scale at load is enough for a stylized sea.
 */
export function spectrumScaleToPeak(spec: ComplexField, amplitudePeak: number, crestFactor = 2): number {
  const n = Math.sqrt(spec.re.length);
  let sumSq = 0;
  for (let nz = 0; nz < n; nz += 1) {
    for (let nx = 0; nx < n; nx += 1) {
      const idx = nz * n + nx;
      const pidx = ((n - nz) % n) * n + ((n - nx) % n);
      const re = spec.re[idx] + spec.re[pidx];
      const im = spec.im[idx] - spec.im[pidx];
      sumSq += re * re + im * im;
    }
  }
  // Parseval for the UNNORMALIZED inverse: Σ_x|f|² = N²·Σ_k|F|², so the
  // surface RMS² equals Σ_k|F(k)|² exactly — the N² cancels and must NOT be
  // divided out again (that overscaled the crest by N).
  const rms = Math.sqrt(sumSq);
  return amplitudePeak / Math.max(crestFactor * rms, 1e-9);
}
