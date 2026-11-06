import { describe, expect, it } from 'vitest';

import { buildSpectrum, dispersion, phillips } from './spectrum';

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

  it('builds a Hermitian pair', () => {
    const n = C0.n;
    const spec = buildSpectrum(C0);
    for (let nz = 0; nz < n; nz += 1) {
      for (let nx = 0; nx < n; nx += 1) {
        if (nx === 0 && nz === 0) continue;
        if (nx === n / 2 || nz === n / 2) continue;
        const px = (n - nx) % n;
        const pz = (n - nz) % n;
        if (nz * n + nx > pz * n + px) continue;
        const idx = nz * n + nx;
        const pidx = pz * n + px;
        expect(spec.re[pidx]).toBeCloseTo(spec.re[idx], 5);
        expect(spec.im[pidx]).toBeCloseTo(-spec.im[idx], 5);
      }
    }
  });
});
