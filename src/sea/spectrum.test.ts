import { describe, expect, it } from 'vitest';

import { buildSpectrum, dispersion, phillips, spectrumScaleToPeak } from './spectrum';

const C0 = {
  n: 16,
  tileMetres: 1024,
  bandMetres: [128, 1024] as const,
  windSpeed: 9,
  windDirRad: 0.212,
  seed: 20261106,
};

const C1 = {
  n: 16,
  tileMetres: 192,
  bandMetres: [32, 128] as const,
  windSpeed: 9,
  windDirRad: 0.212,
  seed: 20261106,
};

describe('spectrum', () => {
  it('dispersion is the deep-water relation', () => {
    expect(dispersion(0.01)).toBe(Math.sqrt(9.81 * 0.01));
    expect(dispersion(4)).toBeCloseTo(Math.sqrt(9.81 * 4), 12);
  });

  it('phillips vanishes at k = 0', () => {
    expect(phillips(0, 0, 9, 0.212, 1024)).toBe(0);
  });

  it('same seed builds the same spectrum', () => {
    const a = buildSpectrum(C0);
    const b = buildSpectrum(C0);
    expect(Array.from(a.re)).toEqual(Array.from(b.re));
    expect(Array.from(a.im)).toEqual(Array.from(b.im));
  });

  it('zeroes DC and both Nyquist lines', () => {
    const n = C0.n;
    const spec = buildSpectrum(C0);
    expect(spec.re[0]).toBe(0);
    expect(spec.im[0]).toBe(0);
    for (let i = 0; i < n; i += 1) {
      // Line nx = N/2 (stride 1 through memory) and line nz = N/2 (row stride).
      expect(spec.re[i * n + n / 2]).toBe(0);
      expect(spec.im[i * n + n / 2]).toBe(0);
      expect(spec.re[(n / 2) * n + i]).toBe(0);
      expect(spec.im[(n / 2) * n + i]).toBe(0);
    }
  });

  it('keeps only modes inside the band window, disjoint at 128 m', () => {
    const n = C0.n;
    const c0 = buildSpectrum(C0);
    const c1 = buildSpectrum(C1);
    const dk0 = (2 * Math.PI) / C0.tileMetres;
    const dk1 = (2 * Math.PI) / C1.tileMetres;
    const kAt = (dk: number, idx: number): number => (idx <= n / 2 ? idx : idx - n) * dk;
    for (let nz = 0; nz < n; nz += 1) {
      for (let nx = 0; nx < n; nx += 1) {
        const idx = nz * n + nx;
        if (c0.re[idx] === 0 && c0.im[idx] === 0) continue;
        const k = Math.hypot(kAt(dk0, nx), kAt(dk0, nz));
        const lambda = (2 * Math.PI) / k;
        expect(lambda).toBeGreaterThanOrEqual(128 * (1 - 1e-6));
      }
    }
    let c1HasModes = false;
    for (let nz = 0; nz < n; nz += 1) {
      for (let nx = 0; nx < n; nx += 1) {
        const idx = nz * n + nx;
        if (c1.re[idx] === 0 && c1.im[idx] === 0) continue;
        c1HasModes = true;
        const k = Math.hypot(kAt(dk1, nx), kAt(dk1, nz));
        const lambda = (2 * Math.PI) / k;
        expect(lambda).toBeLessThanOrEqual(128 * (1 + 1e-6));
        expect(lambda).toBeGreaterThanOrEqual(32 * (1 - 1e-6));
      }
    }
    expect(c1HasModes).toBe(true);
  });

  it('draws independent conjugates: the two-term evolution is symmetric, not degenerate', () => {
    // Tessendorf: h̃(k,t) = h̃₀(k)·e^{iωt} + h̃₀*(−k)·e^{−iωt} with h̃₀(−k) an
    // INDEPENDENT draw — the conjugate symmetry of h̃ comes from the two-term
    // structure, not from the stored spectrum. A stored Hermitian pair would make
    // h̃(k,t) = 2h̃₀(k)cos(ωt) real at every t: standing waves, a dead sea.
    const n = C0.n;
    const spec = buildSpectrum(C0);
    const evRe = new Float32Array(n * n);
    const evIm = new Float32Array(n * n);
    for (let nz = 0; nz < n; nz += 1) {
      for (let nx = 0; nx < n; nx += 1) {
        const idx = nz * n + nx;
        const px = (n - nx) % n;
        const pz = (n - nz) % n;
        const pidx = pz * n + px;
        // h̃(k,0) = h̃₀(k) + conj(h̃₀(−k))
        evRe[idx] = spec.re[idx] + spec.re[pidx];
        evIm[idx] = spec.im[idx] - spec.im[pidx];
      }
    }
    for (let nz = 0; nz < n; nz += 1) {
      for (let nx = 0; nx < n; nx += 1) {
        const idx = nz * n + nx;
        const px = (n - nx) % n;
        const pz = (n - nz) % n;
        const pidx = pz * n + px;
        expect(evRe[pidx]).toBeCloseTo(evRe[idx], 5);
        expect(evIm[pidx]).toBeCloseTo(-evIm[idx], 5);
      }
    }
  });

  it('draws conjugates independently, not as a stored Hermitian pair', () => {
    // A stored Hermitian pair (h̃₀(−k) = conj(h̃₀(k))) collapses the two-term
    // evolution to 2h̃₀(k)cos(ωt): standing waves, a dead sea. The two draws must
    // be independent — no pair may coincide.
    const n = C0.n;
    const spec = buildSpectrum(C0);
    let matched = 0;
    let total = 0;
    for (let nz = 0; nz < n; nz += 1) {
      for (let nx = 0; nx < n; nx += 1) {
        if (nx === 0 && nz === 0) continue;
        if (nx === n / 2 || nz === n / 2) continue;
        const px = (n - nx) % n;
        const pz = (n - nz) % n;
        if (nz * n + nx > pz * n + px) continue;
        const idx = nz * n + nx;
        const pidx = pz * n + px;
        // Out-of-band cells are zero on BOTH sides of a pair (the window is
        // symmetric in |k|) and would match trivially — only count live modes.
        if (spec.re[idx] === 0 && spec.im[idx] === 0) continue;
        total += 1;
        if (spec.re[pidx] === spec.re[idx] && spec.im[pidx] === -spec.im[idx]) matched += 1;
      }
    }
    expect(total).toBeGreaterThan(0);
    expect(matched).toBe(0);
  });
});

describe('spectrumScaleToPeak', () => {
  it('targets amplitudePeak as 2·RMS of the t=0 evolved field (Hs = 4σ)', () => {
    const spec = buildSpectrum(C0);
    const n = C0.n;
    const scale = spectrumScaleToPeak(spec, 0.45);
    expect(scale).toBeGreaterThan(0);
    expect(scale).toBeLessThan(1); // the raw Phillips sea is wildly oversized
    // Verify: RMS of the evolved t=0 field, times the scale, times 2 == 0.45.
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
    // Surface RMS via Parseval: Σ_x|f|² = N²·Σ_k|F|² → RMS² = Σ_k|F|².
    const rms = Math.sqrt(sumSq);
    expect(scale * 2 * rms).toBeCloseTo(0.45, 9);
  });
});
