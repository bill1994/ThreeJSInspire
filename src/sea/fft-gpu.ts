/**
 * GPU IFFT for the stylized FFT ocean — TSL compute, WebGPU only.
 *
 * Frame chain per cascade (all dispatches issued by `compute(t)`):
 *   1. pack      — reads the uploaded h̃₀ texture, evolves phases
 *                  (h̃(k,t) = h̃₀(k)e^{iωt} + h̃₀*(−k)e^{−iωt}, the ONLY time
 *                  entry in the whole sea), applies the 4 packed-field
 *                  multipliers, writes the pair-A textures in bit-reversed-x
 *                  order (folds the x permutation for free).
 *   2. 8 x-stages — radix-2 DIT butterflies along x, natural order, ping-pong.
 *   3. permY     — bit-reverses y (the y axis needs its own permutation).
 *   4. 8 y-stages — butterflies along y.
 *   5. pack-out  — redistributes the packed textures into the four output
 *                  contracts (height/chop/slope/jacobian).
 *   6. mip blit  — copies each output into a sampled texture with a full mip
 *                  chain (a StorageTexture cannot be filtered directly), so the
 *                  material can sample per-ring `mipLod`.
 *
 * The two packed textures each carry TWO complex streams (RGBA32: xy, zw):
 *   pack01.xy = spec(h) + i·spec(Dx)   → after IFFT: (h, Dx)
 *   pack01.zw = spec(Dz) + i·spec(dHx) → (Dz, dHx)
 *   pack23.xy = spec(dHz) + i·spec(dxx) → (dHz, dxx)
 *   pack23.zw = spec(dzz) + i·spec(dxz) → (dzz, dxz)
 * The butterfly treats xy and zw as independent complex streams.
 *
 * Conventions shared with fft-cpu.ts / spectrum.ts: inverse carries
 * `exp(+i2π n·j/N)`, UNNORMALIZED; layout is standard FFT order with DC at
 * (0,0); CHOPPINESS is baked into Dx/Dz and their derivatives here so the
 * material consumes displacement and Jacobian consistently.
 *
 * The butterfly math is mirrored by `simulateIfftCpu` (pure JS) and pinned
 * against the CPU oracle in tests; the TSL kernels implement the same index
 * and twiddle formulas. `selfCheck` closes the loop on real hardware.
 */
import type { StorageTexture } from 'three/webgpu';

import type { ComplexField } from './fft-cpu';
import { ifft2Cpu } from './fft-cpu';

/** Tessendorf choppiness χ, baked into Dx/Dz and the Jacobian derivatives. */
export const CHOPPINESS = 0.8;

function requirePowerOfTwo(n: number): void {
  if (!Number.isInteger(n) || n < 2 || (n & (n - 1)) !== 0) {
    throw new Error(`FFT size must be a power of two ≥ 2, got ${n}`);
  }
}

/** Total butterfly passes per frame: log2(N) stages on each of the two axes. */
export function fftPasses(n: number): number {
  requirePowerOfTwo(n);
  return 2 * Math.log2(n);
}

/** Byte size of one complex N×N buffer (N² texels × 2 floats × 4 bytes). */
export function fftBufferBytes(n: number): number {
  return n * n * 2 * 4;
}

function bitReverse(value: number, bits: number): number {
  let x = value;
  let r = 0;
  for (let b = 0; b < bits; b += 1) {
    r = (r << 1) | (x & 1);
    x >>= 1;
  }
  return r;
}

/**
 * JS mirror of the GPU stage schedule — per axis: bit-reversal permutation,
 * then log2(N) ping-pong DIT stages with `exp(+i2π r/len)` twiddles,
 * unnormalized. x runs first (its permutation is folded into the GPU pack
 * pass), then y gets its own permutation and stages. Tests pin this against
 * the CPU oracle; the TSL kernels implement the same formulas. Lives beside
 * the kernel code so the two cannot drift silently.
 */
export function simulateIfftCpu(re: Float32Array, im: Float32Array, n: number): ComplexField {
  requirePowerOfTwo(n);
  const bits = Math.log2(n);
  const aRe = Float32Array.from(re);
  const aIm = Float32Array.from(im);
  const bRe = new Float32Array(n * n);
  const bIm = new Float32Array(n * n);

  // axis 'x': `line` is the row, `i` moves along columns; axis 'y' mirrored.
  const at = (axis: 'x' | 'y', i: number, line: number): number =>
    axis === 'x' ? line * n + i : i * n + line;

  const permute = (
    axis: 'x' | 'y',
    srcRe: Float32Array,
    srcIm: Float32Array,
    dstRe: Float32Array,
    dstIm: Float32Array,
  ): void => {
    for (let line = 0; line < n; line += 1) {
      for (let i = 0; i < n; i += 1) {
        const s = at(axis, i, line);
        const d = at(axis, bitReverse(i, bits), line);
        dstRe[d] = srcRe[s];
        dstIm[d] = srcIm[s];
      }
    }
  };

  const stage = (
    axis: 'x' | 'y',
    len: number,
    srcRe: Float32Array,
    srcIm: Float32Array,
    dstRe: Float32Array,
    dstIm: Float32Array,
  ): void => {
    const half = len >> 1;
    for (let line = 0; line < n; line += 1) {
      for (let blk = 0; blk < n / len; blk += 1) {
        for (let r = 0; r < half; r += 1) {
          const i0 = blk * len + r;
          const i1 = i0 + half;
          const s0 = at(axis, i0, line);
          const s1 = at(axis, i1, line);
          const ang = (2 * Math.PI * r) / len;
          const wr = Math.cos(ang);
          const wi = Math.sin(ang);
          const ar = srcRe[s0];
          const ai = srcIm[s0];
          const br = srcRe[s1] * wr - srcIm[s1] * wi;
          const bi = srcRe[s1] * wi + srcIm[s1] * wr;
          dstRe[s0] = ar + br;
          dstIm[s0] = ai + bi;
          dstRe[s1] = ar - br;
          dstIm[s1] = ai - bi;
        }
      }
    }
  };

  permute('x', aRe, aIm, bRe, bIm);
  let srcRe = bRe;
  let srcIm = bIm;
  let dstRe = aRe;
  let dstIm = aIm;
  for (let len = 2; len <= n; len <<= 1) {
    stage('x', len, srcRe, srcIm, dstRe, dstIm);
    const tRe = srcRe;
    const tIm = srcIm;
    srcRe = dstRe;
    srcIm = dstIm;
    dstRe = tRe;
    dstIm = tIm;
  }
  permute('y', srcRe, srcIm, dstRe, dstIm);
  {
    const tRe = srcRe;
    const tIm = srcIm;
    srcRe = dstRe;
    srcIm = dstIm;
    dstRe = tRe;
    dstIm = tIm;
  }
  for (let len = 2; len <= n; len <<= 1) {
    stage('y', len, srcRe, srcIm, dstRe, dstIm);
    const tRe = srcRe;
    const tIm = srcIm;
    srcRe = dstRe;
    srcIm = dstIm;
    dstRe = tRe;
    dstIm = tIm;
  }
  // After the swap bookkeeping above, the newest data sits in `srcRe/srcIm`.
  return { re: Float32Array.from(srcRe), im: Float32Array.from(srcIm) };
}

export interface IfftHandle {
  upload(h0: { re: Float32Array; im: Float32Array }): Promise<void>;
  /** Evolve to time `t` (seconds) and refresh every output texture. */
  compute(t: number): Promise<void>;
  readonly height: StorageTexture;
  readonly chop: StorageTexture;
  readonly slope: StorageTexture;
  readonly jacobian: StorageTexture;
  /** Sampled copies with full mip chains — what the sea material samples. */
  readonly sampledHeight: unknown;
  readonly sampledChop: unknown;
  readonly sampledSlope: unknown;
  readonly sampledJacobian: unknown;
  dispose(): void;
}

export interface IfftOpts {
  n: number;
  tileMetres: number;
}

/** Create the whole kernel graph and texture set for one cascade. */
export async function createIfft(renderer: any, opts: IfftOpts): Promise<IfftHandle> {
  const n = opts.n;
  requirePowerOfTwo(n);
  const bits = Math.log2(n);
  const halfCount = n >> 1;
  const dk = (2 * Math.PI) / opts.tileMetres;

  const THREE = await import('three/webgpu');
  const tsl: any = await import('three/tsl');
  const { Fn, instanceIndex, storageTexture, textureLoad, textureStore, uniform, float, uint, uvec2, vec2, vec4 } = tsl;

  const makePacked = (): StorageTexture => {
    const tex = new THREE.StorageTexture(n, n);
    tex.type = THREE.FloatType;
    tex.format = THREE.RGBAFormat;
    tex.colorSpace = THREE.NoColorSpace;
    return tex;
  };

  // h̃₀ arrives as CPU data in a regular texture (x = re, y = im per texel).
  const h0Data = new Float32Array(n * n * 4);
  const h0Tex = new THREE.DataTexture(h0Data, n, n, THREE.RGBAFormat, THREE.FloatType);
  h0Tex.colorSpace = THREE.NoColorSpace;

  // Two ping-pong pairs, each pair = (stream01, stream23); two complex streams
  // per texel so one butterfly pass advances all four packed spectra.
  const packA01 = makePacked();
  const packA23 = makePacked();
  const packB01 = makePacked();
  const packB23 = makePacked();
  const outHeight = makePacked();
  const outChop = makePacked();
  const outSlope = makePacked();
  const outJac = makePacked();

  const makeSampled = (): unknown => {
    const tex = new THREE.DataTexture(new Float32Array(n * n * 4), n, n, THREE.RGBAFormat, THREE.FloatType);
    tex.colorSpace = THREE.NoColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    return tex;
  };
  const sampledHeight = makeSampled();
  const sampledChop = makeSampled();
  const sampledSlope = makeSampled();
  const sampledJacobian = makeSampled();

  const timeU = uniform(0);

  // Pure-expression bit reversal: rev = Σ_b ((x >> b) & 1) << (bits-1-b).
  const tslBitrev = (x: any): any => {
    let expr = uint(0);
    for (let b = 0; b < bits; b += 1) {
      expr = expr.shiftLeft(1).bitOr(x.shiftRight(uint(b)).bitAnd(uint(1)));
    }
    return expr;
  };

  /** Complex multiply of (ar + i·ai) against (br + i·bi) — primitive args only. */
  const cmul = (ar: any, ai: any, br: any, bi: any): { re: any; im: any } => {
    return { re: ar.mul(br).sub(ai.mul(bi)), im: ar.mul(bi).add(ai.mul(br)) };
  };

  // 1. pack: evolve phases, apply multipliers, store bit-reversed in x.
  const packKernel = Fn(() => {
    const j = instanceIndex;
    const x = j.mod(uint(n));
    const y = j.div(uint(n));
    // Signed mode index: x ≥ n/2 ⇔ bit (bits-1) set. Computed in FLOAT —
    // the u32 form underflows (15 − 16 wraps to 2³²−1) and poisons every
    // negative-kx mode with an astronomical k.
    const sx = x.toFloat().sub(
      float(n).mul(x.shiftRight(uint(bits - 1)).bitAnd(uint(1)).toFloat()),
    );
    const sz = y.toFloat().sub(
      float(n).mul(y.shiftRight(uint(bits - 1)).bitAnd(uint(1)).toFloat()),
    );
    const kx = sx.mul(dk);
    const kz = sz.mul(dk);
    // DC would make the /|k| multipliers NaN; the h̃₀ data is zero there, so a
    // clamped length turns every product into zero without a branch.
    const kLenSafe = vec2(kx, kz).length().max(1e-9);

    const px = uint(n).sub(x).mod(uint(n));
    const pz = uint(n).sub(y).mod(uint(n));
    const h0k = textureLoad(h0Tex, uvec2(x, y)).xy;
    const h0p = textureLoad(h0Tex, uvec2(px, pz)).xy;

    const phi = kLenSafe.sqrt().mul(Math.sqrt(9.81)).mul(timeU);
    const c = phi.cos();
    const s = phi.sin();
    // h̃(k,t) = h̃₀(k)e^{iωt} + conj(h̃₀(−k))e^{−iωt}
    const t1 = cmul(h0k.x, h0k.y, c, s);
    const t2 = {
      re: h0p.x.mul(c).sub(h0p.y.mul(s)),
      im: h0p.x.mul(s).negate().sub(h0p.y.mul(c)),
    };
    const ev = { re: t1.re.add(t2.re), im: t1.im.add(t2.im) };

    const chiOverK = kLenSafe.reciprocal().mul(CHOPPINESS);
    // Packed multipliers MC = mA + i·mB (see module comment for the algebra).
    const mc0r = kx.mul(chiOverK).add(1.0); // P0 = h + i·Dx → (1 + kxχ/k, 0)
    const mc1r = kx.negate(); // P1 = Dz + i·dHx → (−kx, −kzχ/k)
    const mc1i = kz.mul(chiOverK).negate();
    const mc2i = kz.add(kx.mul(kx).mul(chiOverK)); // P2 = dHz + i·dxx → (0, kz + kx²χ/k)
    const mc3r = kz.mul(kz).mul(chiOverK); // P3 = dzz + i·dxz → (kz²χ/k, kxkzχ/k)
    const mc3i = kx.mul(kz).mul(chiOverK);
    const p0 = { re: ev.re.mul(mc0r), im: ev.im.mul(mc0r) };
    const p1 = cmul(ev.re, ev.im, mc1r, mc1i);
    const p2 = cmul(ev.re, ev.im, 0, mc2i);
    const p3 = cmul(ev.re, ev.im, mc3r, mc3i);

    const bx = tslBitrev(x);
    const d01 = storageTexture(packA01);
    const d23 = storageTexture(packA23);
    textureStore(d01, uvec2(bx, y), vec4(p0.re, p0.im, p1.re, p1.im));
    textureStore(d23, uvec2(bx, y), vec4(p2.re, p2.im, p3.re, p3.im));
  })().compute(n * n);

  // 2/4. butterfly stage: len and axis fixed at build time; reads one pair,
  // writes the other. Each invocation owns one butterfly on both textures.
  const stageKernel = (len: number, axis: 'x' | 'y', srcPair: 'A' | 'B'): any => {
    const half = len >> 1;
    const s01 = storageTexture(srcPair === 'A' ? packA01 : packB01).toReadOnly();
    const s23 = storageTexture(srcPair === 'A' ? packA23 : packB23).toReadOnly();
    const d01 = storageTexture(srcPair === 'A' ? packB01 : packA01);
    const d23 = storageTexture(srcPair === 'A' ? packB23 : packA23);
    return Fn(() => {
      const j = instanceIndex;
      const line = j.div(uint(halfCount));
      const bIdx = j.mod(uint(halfCount));
      const blk = bIdx.div(uint(half));
      const r = bIdx.mod(uint(half));
      const i0 = blk.mul(uint(len)).add(r);
      const i1 = i0.add(uint(half));
      const ang = r.toFloat().mul((2 * Math.PI) / len);
      const wr = ang.cos();
      const wi = ang.sin();
      const u0 = axis === 'x' ? uvec2(i0, line) : uvec2(line, i0);
      const u1 = axis === 'x' ? uvec2(i1, line) : uvec2(line, i1);
      const s0a = textureLoad(s01, u0);
      const s1a = textureLoad(s01, u1);
      const s0b = textureLoad(s23, u0);
      const s1b = textureLoad(s23, u1);
      const butterfly = (a0: any, a1: any): any => {
        const twRx = a1.x.mul(wr).sub(a1.y.mul(wi));
        const twIx = a1.x.mul(wi).add(a1.y.mul(wr));
        const twRy = a1.z.mul(wr).sub(a1.w.mul(wi));
        const twIy = a1.z.mul(wi).add(a1.w.mul(wr));
        return [
          vec4(a0.x.add(twRx), a0.y.add(twIx), a0.z.add(twRy), a0.w.add(twIy)),
          vec4(a0.x.sub(twRx), a0.y.sub(twIx), a0.z.sub(twRy), a0.w.sub(twIy)),
        ];
      };
      const [loA, hiA] = butterfly(s0a, s1a);
      const [loB, hiB] = butterfly(s0b, s1b);
      textureStore(d01, u0, loA);
      textureStore(d01, u1, hiA);
      textureStore(d23, u0, loB);
      textureStore(d23, u1, hiB);
    })().compute(n * halfCount);
  };

  // 3. permY: bit-reverse y across the pair (reads `src`, writes the other).
  const permYKernel = (srcPair: 'A' | 'B'): any => {
    const s01 = storageTexture(srcPair === 'A' ? packA01 : packB01).toReadOnly();
    const s23 = storageTexture(srcPair === 'A' ? packA23 : packB23).toReadOnly();
    const d01 = storageTexture(srcPair === 'A' ? packB01 : packA01);
    const d23 = storageTexture(srcPair === 'A' ? packB23 : packA23);
    return Fn(() => {
      const j = instanceIndex;
      const x = j.mod(uint(n));
      const y = j.div(uint(n));
      const uSrc = uvec2(x, y);
      const uDst = uvec2(x, tslBitrev(y));
      textureStore(d01, uDst, textureLoad(s01, uSrc));
      textureStore(d23, uDst, textureLoad(s23, uSrc));
    })().compute(n * n);
  };

  // 5. pack-out: redistribute the two complex streams into the four output
  // contracts — TWO kernels, because a single one would bind 6 storage
  // textures (2 read + 4 write) and exceed the per-stage adapter limit of 4.
  const packOutKernel = (
    srcPair: 'A' | 'B',
    which: 'hc' | 'sj',
  ): any => {
    const s01 = storageTexture(srcPair === 'A' ? packA01 : packB01).toReadOnly();
    const s23 = storageTexture(srcPair === 'A' ? packA23 : packB23).toReadOnly();
    return Fn(() => {
      const j = instanceIndex;
      const x = j.mod(uint(n));
      const y = j.div(uint(n));
      const uv = uvec2(x, y);
      const v01 = textureLoad(s01, uv); // xy = (h, Dx), zw = (Dz, dHx)
      const v23 = textureLoad(s23, uv); // xy = (dHz, dxx), zw = (dzz, dxz)
      if (which === 'hc') {
        textureStore(storageTexture(outHeight), uv, vec4(v01.x, 0, 0, 0));
        textureStore(storageTexture(outChop), uv, vec4(v01.y, v01.z, 0, 0));
      } else {
        textureStore(storageTexture(outSlope), uv, vec4(v01.w, v23.x, 0, 0));
        textureStore(storageTexture(outJac), uv, vec4(v23.y, v23.z, v23.w, 0));
      }
    })().compute(n * n);
  };

  const dispatches: any[] = [packKernel];
  // pack wrote pair A; stages alternate A/B. After `bits` x-stages the data
  // sits in A when `bits` is even (both production sizes), else B. permY and
  // the y stages keep alternating; pack-out reads wherever the data landed.
  {
    let src: 'A' | 'B' = 'A';
    for (let len = 2; len <= n; len <<= 1) {
      dispatches.push(stageKernel(len, 'x', src));
      src = src === 'A' ? 'B' : 'A';
    }
    dispatches.push(permYKernel(src));
    src = src === 'A' ? 'B' : 'A';
    for (let len = 2; len <= n; len <<= 1) {
      dispatches.push(stageKernel(len, 'y', src));
      src = src === 'A' ? 'B' : 'A';
    }
    dispatches.push(packOutKernel(src, 'hc'));
    dispatches.push(packOutKernel(src, 'sj'));
  }

  const blit = (): void => {
    // A StorageTexture cannot be filtered; copy each output into the sampled
    // twin and let the renderer grow its mip chain (dst.generateMipmaps).
    renderer.copyTextureToTexture(outHeight, sampledHeight);
    renderer.copyTextureToTexture(outChop, sampledChop);
    renderer.copyTextureToTexture(outSlope, sampledSlope);
    renderer.copyTextureToTexture(outJac, sampledJacobian);
  };

  return {
    async upload(h0: { re: Float32Array; im: Float32Array }): Promise<void> {
      for (let i = 0; i < n * n; i += 1) {
        h0Data[i * 4] = h0.re[i];
        h0Data[i * 4 + 1] = h0.im[i];
      }
      h0Tex.needsUpdate = true;
    },
    async compute(t: number): Promise<void> {
      timeU.value = t;
      for (const kernel of dispatches) renderer.compute(kernel);
      blit();
    },
    height: outHeight,
    chop: outChop,
    slope: outSlope,
    jacobian: outJac,
    sampledHeight,
    sampledChop,
    sampledSlope,
    sampledJacobian,
    dispose(): void {
      for (const tex of [h0Tex, packA01, packA23, packB01, packB23, outHeight, outChop, outSlope, outJac]) {
        tex.dispose();
      }
      for (const tex of [sampledHeight, sampledChop, sampledSlope, sampledJacobian]) {
        (tex as any).dispose();
      }
    },
  };
}

/**
 * Hardware self-check: `compute(0)` must reproduce `ifft2Cpu` of the t=0
 * evolved spectrum (the two-term rule at t=0 gives h̃₀(k) + h̃₀*(−k)), and
 * `compute(5)` must differ (the sea moves). Returns the t=0 max absolute
 * error; throws if the field is frozen. N should be a multiple of 16 so the
 * 256-byte readback row alignment is exact. Not a unit test — node has no GPU.
 */
export async function selfCheck(renderer: any, n = 16): Promise<number> {
  requirePowerOfTwo(n);
  const { buildSpectrum } = await import('./spectrum');
  const h0 = buildSpectrum({
    n,
    tileMetres: 1024,
    bandMetres: [128, 1024],
    windSpeed: 9,
    windDirRad: 0.212,
    seed: 7,
  });
  const handle = await createIfft(renderer, { n, tileMetres: 1024 });
  try {
    await handle.upload(h0);
    await handle.compute(0);
    const gpu0 = (await renderer.backend.copyTextureToBuffer(handle.height, 0, 0, n, n, 0)) as Float32Array;

    const evRe = new Float32Array(n * n);
    const evIm = new Float32Array(n * n);
    for (let nz = 0; nz < n; nz += 1) {
      for (let nx = 0; nx < n; nx += 1) {
        const idx = nz * n + nx;
        const px = (n - nx) % n;
        const pz = (n - nz) % n;
        const pidx = pz * n + px;
        evRe[idx] = h0.re[idx] + h0.re[pidx];
        evIm[idx] = h0.im[idx] - h0.im[pidx];
      }
    }
    const cpu = ifft2Cpu(evRe, evIm, n);
    let maxDiff = 0;
    for (let i = 0; i < n * n; i += 1) {
      maxDiff = Math.max(maxDiff, Math.abs(gpu0[i * 4] - cpu.re[i]));
    }

    await handle.compute(5);
    const gpu5 = (await renderer.backend.copyTextureToBuffer(handle.height, 0, 0, n, n, 0)) as Float32Array;
    let motion = 0;
    let nonzero0 = 0;
    let peak0 = 0;
    for (let i = 0; i < n * n; i += 1) {
      motion = Math.max(motion, Math.abs(gpu5[i * 4] - gpu0[i * 4]));
      if (Math.abs(gpu0[i * 4]) > 1e-6) nonzero0 += 1;
      peak0 = Math.max(peak0, Math.abs(gpu0[i * 4]));
    }
    if (motion < 1e-4) {
      throw new Error(
        `sea did not move between t=0 and t=5 — the time entry is dead ` +
          `[t0 maxDiff vs oracle=${maxDiff.toExponential(3)}, nonzero=${nonzero0}/${n * n}, peak=${peak0.toExponential(3)}]`,
      );
    }
    return maxDiff;
  } finally {
    handle.dispose();
  }
}
