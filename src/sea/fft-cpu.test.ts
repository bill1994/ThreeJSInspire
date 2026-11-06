import { describe, expect, it } from 'vitest';

import { ifft2Cpu } from './fft-cpu';

describe('fft-cpu oracle', () => {
  it('inverts a single mode with the +i phase sign', () => {
    const n = 8;
    const re = new Float32Array(n * n);
    const im = new Float32Array(n * n);
    // Single mode at (nx, nz) = (1, 2), amplitude 1.
    re[2 * n + 1] = 1;
    const f = ifft2Cpu(re, im, n);
    for (let jz = 0; jz < n; jz += 1) {
      for (let jx = 0; jx < n; jx += 1) {
        const ang = (2 * Math.PI * (jx + 2 * jz)) / n;
        const idx = jz * n + jx;
        expect(f.re[idx]).toBeCloseTo(Math.cos(ang), 5);
        // +i sign: the inverse carries exp(+i2π n·j/N), so the imaginary part is +sin.
        expect(f.im[idx]).toBeCloseTo(Math.sin(ang), 5);
      }
    }
  });

  it('satisfies Parseval for the unnormalized inverse', () => {
    const n = 8;
    // Deterministic LCG fill — complex but deliberately NOT Hermitian.
    let s = 12345;
    const rnd = (): number => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const re = new Float32Array(n * n);
    const im = new Float32Array(n * n);
    for (let i = 0; i < n * n; i += 1) {
      re[i] = rnd() * 2 - 1;
      im[i] = rnd() * 2 - 1;
    }
    const f = ifft2Cpu(re, im, n);
    let sumF = 0;
    for (let i = 0; i < n * n; i += 1) sumF += re[i] * re[i] + im[i] * im[i];
    let sumf = 0;
    for (let i = 0; i < n * n; i += 1) sumf += f.re[i] * f.re[i] + f.im[i] * f.im[i];
    const expectant = n * n * sumF;
    expect(Math.abs(sumf - expectant) / expectant).toBeLessThan(1e-6);
  });

  it('returns a real field for Hermitian input', () => {
    const n = 8;
    const re = new Float32Array(n * n);
    const im = new Float32Array(n * n);
    let s = 777;
    const rnd = (): number => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    // Hermitian pair: F[−k] = conj(F[k]); skip DC and both Nyquist lines (self-conjugate).
    for (let nz = 0; nz < n; nz += 1) {
      for (let nx = 0; nx < n; nx += 1) {
        if (nx === 0 && nz === 0) continue;
        if (nx === n / 2 || nz === n / 2) continue;
        const px = (n - nx) % n;
        const pz = (n - nz) % n;
        if (nz * n + nx > pz * n + px) continue;
        const a = rnd() * 2 - 1;
        const b = rnd() * 2 - 1;
        re[nz * n + nx] = a;
        im[nz * n + nx] = b;
        re[pz * n + px] = a;
        im[pz * n + px] = -b;
      }
    }
    const f = ifft2Cpu(re, im, n);
    let maxIm = 0;
    for (let i = 0; i < n * n; i += 1) maxIm = Math.max(maxIm, Math.abs(f.im[i]));
    expect(maxIm).toBeLessThan(1e-6);
  });

  it('rejects sizes outside the oracle range', () => {
    expect(() => ifft2Cpu(new Float32Array(4), new Float32Array(4), 64)).toThrow();
    expect(() => ifft2Cpu(new Float32Array(4), new Float32Array(4), 0)).toThrow();
  });
});
