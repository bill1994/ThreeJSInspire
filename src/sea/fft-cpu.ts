/**
 * Direct 2-D inverse DFT — the reference oracle for the GPU IFFT (Task 4).
 *
 * O(N⁴) and deliberately unoptimized: production never calls this, `selfCheck`
 * and the tests do. N ≤ 32 keeps a run under a few million multiply-adds.
 *
 * Convention (must match the GPU chain): the inverse carries `exp(+i2π n·j/N)`
 * and is UNNORMALIZED — `f[j] = Σ_n F[n]·e^{+i2π n·j/N}` — the same shape as
 * Tessendorf's `h(x,t) = Σ h̃(k,t)·e^{ik·x}`. Parseval for this pair reads
 * `Σ|f|² = N²·Σ|F|²`.
 */

export interface ComplexField {
  re: Float32Array;
  im: Float32Array;
}

export function ifft2Cpu(re: Float32Array, im: Float32Array, n: number): ComplexField {
  if (!Number.isInteger(n) || n < 1 || n > 32) {
    throw new RangeError(`ifft2Cpu is an oracle for 1 ≤ N ≤ 32, got ${n}`);
  }
  const outRe = new Float32Array(n * n);
  const outIm = new Float32Array(n * n);
  const TAU = 2 * Math.PI;
  for (let jz = 0; jz < n; jz += 1) {
    for (let jx = 0; jx < n; jx += 1) {
      let sumRe = 0;
      let sumIm = 0;
      for (let nz = 0; nz < n; nz += 1) {
        for (let nx = 0; nx < n; nx += 1) {
          const ang = (TAU * (nx * jx + nz * jz)) / n;
          const wr = Math.cos(ang);
          const wi = Math.sin(ang);
          const idx = nz * n + nx;
          const fr = re[idx];
          const fi = im[idx];
          sumRe += fr * wr - fi * wi;
          sumIm += fr * wi + fi * wr;
        }
      }
      const outIdx = jz * n + jx;
      outRe[outIdx] = sumRe;
      outIm[outIdx] = sumIm;
    }
  }
  return { re: outRe, im: outIm };
}
