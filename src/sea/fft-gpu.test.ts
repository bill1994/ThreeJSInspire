import { describe, expect, it } from 'vitest';

import { ifft2Cpu } from './fft-cpu';
import { fftBufferBytes, fftPasses, simulateIfftCpu } from './fft-gpu';

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomComplexField(n: number, seed: number): { re: Float32Array; im: Float32Array } {
  const rnd = lcg(seed);
  const re = new Float32Array(n * n);
  const im = new Float32Array(n * n);
  for (let i = 0; i < n * n; i += 1) {
    re[i] = rnd() * 2 - 1;
    im[i] = rnd() * 2 - 1;
  }
  return { re, im };
}

describe('fft-gpu schedule', () => {
  it('counts passes as two axes × log2(N) and rejects non-power-of-two', () => {
    expect(fftPasses(256)).toBe(16);
    expect(fftPasses(8)).toBe(6);
    expect(() => fftPasses(192)).toThrow();
    expect(() => fftPasses(100)).toThrow();
  });

  it('reports one complex buffer as N²·2·4 bytes', () => {
    expect(fftBufferBytes(256)).toBe(256 * 256 * 2 * 4);
  });

  it('the JS stage schedule reproduces the CPU oracle on random fields', () => {
    for (const n of [8, 16, 32]) {
      const field = randomComplexField(n, 1000 + n);
      const oracle = ifft2Cpu(field.re, field.im, n);
      const sim = simulateIfftCpu(field.re, field.im, n);
      let maxDiff = 0;
      for (let i = 0; i < n * n; i += 1) {
        maxDiff = Math.max(maxDiff, Math.abs(sim.re[i] - oracle.re[i]));
        maxDiff = Math.max(maxDiff, Math.abs(sim.im[i] - oracle.im[i]));
      }
      expect(maxDiff).toBeLessThan(1e-3);
    }
  });

  it('the JS stage schedule keeps a Hermitian input real', () => {
    const n = 16;
    const field = { re: new Float32Array(n * n), im: new Float32Array(n * n) };
    // Hermitize: F[−k] = conj(F[k]); DC and both Nyquist lines must be ZERO —
    // they are their own conjugate partners, so random leftovers there would
    // leak imaginary energy into the output.
    const rnd = lcg(7);
    for (let nz = 0; nz < n; nz += 1) {
      for (let nx = 0; nx < n; nx += 1) {
        if (nx === 0 && nz === 0) continue;
        if (nx === n / 2 || nz === n / 2) continue;
        const px = (n - nx) % n;
        const pz = (n - nz) % n;
        if (nz * n + nx > pz * n + px) continue;
        const a = rnd() * 2 - 1;
        const b = rnd() * 2 - 1;
        field.re[nz * n + nx] = a;
        field.im[nz * n + nx] = b;
        field.re[pz * n + px] = a;
        field.im[pz * n + px] = -b;
      }
    }
    const sim = simulateIfftCpu(field.re, field.im, n);
    let maxIm = 0;
    for (let i = 0; i < n * n; i += 1) maxIm = Math.max(maxIm, Math.abs(sim.im[i]));
    expect(maxIm).toBeLessThan(1e-3);
  });
});
