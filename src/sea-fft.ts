/**
 * FFT sea — deterministic Phillips spectrum + inverse FFT, rendered through TSL
 * node materials (WebGPU backend).
 *
 * Architecture note: the spectrum / time evolution / inverse FFT run on the CPU
 * into a preallocated RGBA16F texture; the GPU only samples it. That keeps the
 * whole wave model unit-testable in node (no GPU device needed) and keeps a hard
 * frame budget, which a TSL compute ping-pong FFT cannot guarantee here.
 */
import * as THREE from 'three';
import { SEA_PALETTE, SUN_DIRECTION } from './palettes';
import { HORIZON } from './horizon';
import { SUN_ROAD } from './sun-road';

export type Backend = 'webgpu' | 'webgl2';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SeaConfig {
  /** Power-of-two FFT / texture resolution. */
  fftSize: number;
  /** World size of the sea patch in metres. */
  patchSize: number;
  /** Wind speed in m/s; sets the dominant wavelength through L = v^2 / g. */
  windSpeed: number;
  /** Normalised wind direction (x, z). */
  windDirection: [number, number];
  /** Target RMS wave height in metres. */
  amplitude: number;
  /** Deterministic RNG seed. */
  seed: number;
  /** Gravity, m/s^2 (deep-water dispersion omega = sqrt(g|k|)). */
  gravity: number;
  /** Cut waves above this fraction of Nyquist to kill FFT aliasing shimmer. */
  nyquistGuard: number;
  /** Slope exaggeration baked into the stored normals (toon readability). */
  normalExaggeration: number;
}

export const DEFAULT_SEA: SeaConfig = {
  fftSize: 128,
  // Spectrum domain, NOT the mesh size: the geometry is SEA_PATCH_SIZE (1600 m) and the
  // shader samples the texture by world coordinates at the 400 m period, so one spectral
  // period is still 400 m and wave size stays exactly as authored.
  patchSize: 400,
  // Wind speed sets the spectral peak through L = v^2 / g. The Gerstner fallback, which the
  // A/B established as the art target, has its energy at 50/27/14 m; 6.4 m/s puts the FFT
  // peak in the same band (~28 m), so the two backends read as the same ocean.
  windSpeed: 6.4,
  windDirection: [0.82, -0.57],
  // Low: a low sun plus a toon palette punishes tall crests, because every crest that faces
  // the sun becomes a bright band.
  amplitude: 0.34,
  seed: 1337,
  gravity: 9.81,
  nyquistGuard: 0.85,
  // 3.4 pushed most of the surface into the top toon band, i.e. a white sheet. 1.4 keeps the
  // bands as bands; fine relief now comes from the noise bump in the shader instead.
  normalExaggeration: 1.4,
};

/**
 * 海水色带的三个硬切阈值，对应 deep → mid → lit → crest 的边界。
 *
 * 落在 z-score 之后的 `shape` 上（见 `SEA_SHAPE`），约等于 **p25 / p75 / p97**，
 * 也就是 deep 25% / mid 50% / lit 23% / crest 2%。上一版取旧 smoothstep 的中点
 * （0.35/0.52/0.72），但那是按**旧两域、旧权重**的分布定的；换成 ndl 主导后
 * `shape` 的均值从 0.357 掉到 0.266，第一个阈值落到了中位数下方 0.2σ，
 * 64% 海面在 deep/mid 之间翻档——「大斑块」的直接原因。**crest 需要 6σ，
 * 恒为 0**，四档硬切从来没真正发生过。
 *
 * **已知风险**：硬切会在远处放大纹理欠采样（128² 在 400 m 上 = 3.1 m/纹素，且纹理没有
 * mipmap）。若远处色带出现闪烁，正确做法是换成**距离相关的软化**
 * （`smoothstep(t - soft(dist), t + soft(dist), shape)`，近处 soft→0 保持硬边），
 * **不要**退回全局 smoothstep——那会把整片海重新糊成渐变。
 */
export const SEA_BAND_STOPS = [0.44, 0.56, 0.68] as const;

/**
 * 色带驱动字段的标定常数（实测，不是拍的）。
 *
 * `shape = 0.38·高度 + 0.62·NdotL` 这个写法看着像「光照主导」，但两个字段的量纲差太多。
 * 实测（两级联、t=0、128² 全像素）：
 *
 * | 字段 | mean | sd |
 * |---|---|---|
 * | hNorm | 0.500 | 0.209 |
 * | ndl | 0.122 | 0.071 |
 *
 * 方差占比因此是 **76 : 24**——高度仍然统治色带，等值线就是闭合斑块，这就是「大迷彩」
 * 的来源。**先 z-score 再加权**，权重才名副其实。
 *
 * `zScale` 把加权后的标准分数压回 sd≈0.09，使 `SEA_BAND_STOPS` 的阈值仍落在原来的
 * 量级上。**改任何级联配置都要重跑探针重标这四个数**，否则阈值会再次失效。
 */
export const SEA_SHAPE = {
  hMean: 0.5,
  weightHeight: 0.38,
  /** 脊线曲率（1/m）压到 shape 的 sd≈0.09 所需的倍率；改级联配置要重标。 */
  ridgeScale: 0.15,
} as const;

/**
 * 泡沫门限：脊线曲率超过 `ridgeStart` 起沫，到 `ridgeFull` 满。单位 1/m。
 * 与 `SEA_SHAPE.ridgeScale` 一起标定——泡沫长在浪真正翻卷的地方，而不是「比较高的水面」。
 */
export const SEA_FOAM = { ridgeStart: 0.08, ridgeFull: 0.25 } as const;

/**
 * 亮侧勾边强度。0 关掉；0.1~0.2 是「提一笔」的量级，再高就开始描边。
 * 只在 `ndl > 0` 的一侧出现——背光侧保持纯平涂，不然整圈描边会读成卡通贴纸。
 */
export const SEA_RIM = { gain: 0.18 } as const;

/**
 * 太阳路的笔触参数。格子沿风向拉长（`along` 小 = 格子长）、垂直风向压窄（`across` 大 = 格子短），
 * 每格用哈希决定长度与是否出现。这是「画出来的海」和「镜面反射」的区别：
 * 前者是沿浪脊的短横线，后者是逐像素的碎钻。
 */
export const SEA_STROKE = {
  along: 0.12,
  across: 0.55,
  halfWidth: 0.21,
  sparse: 0.38,
  /** 低频域扭曲强度：把规则网格打散成手绘笔触。0 会退化成整齐的虚线。 */
  warp: 0.55,
} as const;


// ---------------------------------------------------------------------------
// Deterministic RNG (mulberry32) + gaussian pairs
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Spectrum
// ---------------------------------------------------------------------------

export interface Spectrum {
  n: number;
  patchSize: number;
  /** Re/Im of the initial amplitude h0(k). */
  re: Float32Array;
  im: Float32Array;
  /** Deep-water angular frequency per mode, rad/s. */
  omega: Float32Array;
  /** Upper bound of |h0(k)| actually stored (used by tests + safety docs). */
  amplitudeClamp: number;
  /** Global scale applied to h0 during RMS normalisation. */
  scale: number;
  /** Crest height at which foam starts / the width of the foam ramp. */
  foamStart: number;
  foamRange: number;
  normalExaggeration: number;
  /** 风向（单位化 x, z）：脊线指示沿它取二阶差分。 */
  windDirection: [number, number];
}

/** Physics/robustness snapshot of a float array. */
export interface FiniteStats {
  count: number;
  finite: boolean;
  min: number;
  max: number;
  maxAbs: number;
  meanAbs: number;
}

export function finiteSpectrumStats(values: ArrayLike<number>): FiniteStats {
  let min = Infinity;
  let max = -Infinity;
  let maxAbs = 0;
  let sumAbs = 0;
  let finite = true;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) {
      finite = false;
      continue;
    }
    if (v < min) min = v;
    if (v > max) max = v;
    const a = Math.abs(v);
    if (a > maxAbs) maxAbs = a;
    sumAbs += a;
  }
  const count = values.length;
  return {
    count,
    finite,
    min: finite && count > 0 ? min : 0,
    max: finite && count > 0 ? max : 0,
    maxAbs,
    meanAbs: count > 0 ? sumAbs / count : 0,
  };
}

/** Signed frequency index for FFT bin xi (0..n-1). */
function binIndex(xi: number, n: number): number {
  return xi <= n / 2 ? xi : xi - n;
}

/**
 * Phillips spectrum with a switched-on wind direction and a Nyquist guard.
 * Amplitudes are RMS-normalised to `cfg.amplitude`, so the returned field never
 * needs a per-frame normalisation step.
 */
export function buildPhillipsSpectrum(cfg: SeaConfig): Spectrum {
  const n = cfg.fftSize;
  if (!Number.isInteger(n) || n < 8 || (n & (n - 1)) !== 0) {
    throw new Error(`fftSize must be a power of two >= 8 (got ${n})`);
  }
  const cells = n * n;
  const re = new Float32Array(cells);
  const im = new Float32Array(cells);
  const omega = new Float32Array(cells);

  const g = cfg.gravity;
  const L = (cfg.windSpeed * cfg.windSpeed) / g; // largest wave from wind speed
  const kScale = (Math.PI * 2) / cfg.patchSize;
  const wl = Math.hypot(cfg.windDirection[0], cfg.windDirection[1]) || 1;
  const wx = cfg.windDirection[0] / wl;
  const wz = cfg.windDirection[1] / wl;
  const smallWaveCutoff = 0.06 * L;
  const nyquist = (n / 2) * cfg.nyquistGuard;

  const rng = mulberry32(cfg.seed);
  let spare: number | null = null;
  const gauss = (): number => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = rng() * 2 - 1;
      v = rng() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const f = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * f;
    return u * f;
  };

  for (let zi = 0; zi < n; zi++) {
    const mz = binIndex(zi, n);
    for (let xi = 0; xi < n; xi++) {
      const mx = binIndex(xi, n);
      const i = zi * n + xi;
      const kx = mx * kScale;
      const kz = mz * kScale;
      const k = Math.hypot(kx, kz);
      if (k < 1e-6) continue; // DC: no vertical displacement
      if (Math.abs(mx) > nyquist || Math.abs(mz) > nyquist) continue;

      omega[i] = Math.sqrt(g * k);

      const kdl = k * L;
      let p = Math.exp(-1 / (kdl * kdl)) / (k * k * k * k);
      const kl = k * smallWaveCutoff;
      p *= Math.exp(-kl * kl);
      const dirDot = (kx / k) * wx + (kz / k) * wz;
      if (dirDot <= 0) continue; // directional swell: nothing travels upwind
      // cos^12, not cos^2. cos^2 spreads energy over ±90°, so the surface reads as an
      // isotropic lump field and every band threshold cuts a random blob out of it. cos^12
      // concentrates the energy into roughly ±19° (half power) around the wind, which is what
      // makes the crests line up in rows the way a painted sea does. The reversed lobe that an
      // even power would normally keep is already removed by the `dirDot <= 0` guard above.
      // Total energy is restored by the RMS normalisation below, but the *distribution*
      // changes — `SEA_SHAPE` must be re-measured whenever this exponent changes.
      p *= Math.pow(dirDot, 12);

      const mag = Math.sqrt(p) * Math.SQRT1_2;
      if (!(mag > 0) || !Number.isFinite(mag)) continue;
      re[i] = mag * gauss();
      im[i] = mag * gauss();
    }
  }

  const spec: Spectrum = {
    n,
    patchSize: cfg.patchSize,
    re,
    im,
    omega,
    amplitudeClamp: 0,
    scale: 1,
    // Foam marks breaking crests only: ~2.2 sigma of the height distribution, and a narrow
    // ramp, so the white stays on the tips instead of flooding the swell.
    foamStart: cfg.amplitude * 2.2,
    foamRange: cfg.amplitude * 0.6,
    normalExaggeration: cfg.normalExaggeration,
    windDirection: (() => {
      const wl = Math.hypot(cfg.windDirection[0], cfg.windDirection[1]) || 1;
      return [cfg.windDirection[0] / wl, cfg.windDirection[1] / wl] as [number, number];
    })(),
  };

  // Outlier guard: no single mode may exceed 8x the RMS mode magnitude.
  // (k^-4 spectra are heavy tailed; an unclamped tail is what turns into a
  // spike artefact once the field is RMS-normalised and multiplied by the
  // steepness. This is a real clamp, not a no-op.)
  const CLAMP_SIGMAS = 8;
  let meanSq = 0;
  for (let i = 0; i < cells; i++) meanSq += re[i] * re[i] + im[i] * im[i];
  meanSq /= cells;
  const rmsMag = Math.sqrt(meanSq);
  if (rmsMag > 0) {
    const clampMag = rmsMag * CLAMP_SIGMAS;
    for (let i = 0; i < cells; i++) {
      const mag = Math.hypot(re[i], im[i]);
      if (mag > clampMag) {
        const s = clampMag / mag;
        re[i] *= s;
        im[i] *= s;
      }
    }
  }

  const rms = measureRmsHeight(spec);
  const scale = rms > 1e-6 ? cfg.amplitude / rms : 1;
  for (let i = 0; i < cells; i++) {
    re[i] *= scale;
    im[i] *= scale;
  }
  spec.scale = scale;
  let peak = 0;
  for (let i = 0; i < cells; i++) {
    const mag = Math.hypot(re[i], im[i]);
    if (mag > peak) peak = mag;
  }
  spec.amplitudeClamp = peak;
  return spec;
}

// ---------------------------------------------------------------------------
// Time evolution
// ---------------------------------------------------------------------------

/**
 * h(k, t) = h0(k) e^{i w t} + conj(h0(-k)) e^{-i w t}
 * Fully overwritten every call, so callers may pass recycled buffers.
 */
export function evolveTo(spec: Spectrum, t: number, outRe: Float32Array, outIm: Float32Array): void {
  const n = spec.n;
  const mask = n - 1;
  const sr = spec.re;
  const si = spec.im;
  const w = spec.omega;
  const time = Number.isFinite(t) ? t : 0;
  for (let zi = 0; zi < n; zi++) {
    const invRow = ((n - zi) & mask) * n;
    const row = zi * n;
    for (let xi = 0; xi < n; xi++) {
      const i = row + xi;
      const j = invRow + ((n - xi) & mask);
      const ar = sr[i];
      const ai = si[i];
      const br = sr[j];
      const bi = si[j];
      if (ar === 0 && ai === 0 && br === 0 && bi === 0) {
        outRe[i] = 0;
        outIm[i] = 0;
        continue;
      }
      const ang = w[i] * time;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      // h0(k) * e^{i w t}
      const t1r = ar * c - ai * s;
      const t1i = ar * s + ai * c;
      // conj(h0(-k)) * e^{-i w t}
      const t2r = br * c - bi * s;
      const t2i = -br * s - bi * c;
      outRe[i] = t1r + t2r;
      outIm[i] = t1i + t2i;
    }
  }
}

// ---------------------------------------------------------------------------
// FFT
// ---------------------------------------------------------------------------

interface FftTables {
  cos: Float64Array;
  sin: Float64Array;
  rev: Uint32Array;
}

const tableCache = new Map<number, FftTables>();

function getTables(n: number): FftTables {
  const cached = tableCache.get(n);
  if (cached) return cached;
  const half = n >> 1;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let i = 0; i < half; i++) {
    const a = (Math.PI * 2 * i) / n;
    cos[i] = Math.cos(a);
    sin[i] = Math.sin(a);
  }
  const bits = Math.round(Math.log2(n));
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >>> b) & 1) << (bits - 1 - b);
    rev[i] = r >>> 0;
  }
  const tables: FftTables = { cos, sin, rev };
  tableCache.set(n, tables);
  return tables;
}

/** In-place 1D radix-2 FFT over a strided slice. sign -1 = forward, +1 = inverse. */
function fft1d(
  re: Float32Array,
  im: Float32Array,
  n: number,
  offset: number,
  stride: number,
  sign: number,
  tables: FftTables,
): void {
  const { cos, sin, rev } = tables;
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      const a = offset + i * stride;
      const b = offset + j * stride;
      const tr = re[a];
      re[a] = re[b];
      re[b] = tr;
      const ti = im[a];
      im[a] = im[b];
      im[b] = ti;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const halfSize = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < halfSize; j++, k += step) {
        const c = cos[k];
        const s = sign * sin[k];
        const i0 = offset + (i + j) * stride;
        const i1 = offset + (i + j + halfSize) * stride;
        const tr = re[i1] * c - im[i1] * s;
        const ti = re[i1] * s + im[i1] * c;
        re[i1] = re[i0] - tr;
        im[i1] = im[i0] - ti;
        re[i0] += tr;
        im[i0] += ti;
      }
    }
  }
}

/** In-place 2D FFT. `inverse` also applies the 1/n^2 normalisation. */
export function fft2d(re: Float32Array, im: Float32Array, n: number, inverse: boolean): void {
  const tables = getTables(n);
  const sign = inverse ? 1 : -1;
  for (let z = 0; z < n; z++) fft1d(re, im, n, z * n, 1, sign, tables);
  for (let x = 0; x < n; x++) fft1d(re, im, n, x, n, sign, tables);
  if (inverse) {
    const inv = 1 / (n * n);
    for (let i = 0; i < re.length; i++) {
      re[i] *= inv;
      im[i] *= inv;
    }
  }
}

// ---------------------------------------------------------------------------
// Spatial surface (height + normal + foam)
// ---------------------------------------------------------------------------

interface Scratch {
  re: Float32Array;
  im: Float32Array;
}

const scratchCache = new Map<number, Scratch>();

function getScratch(n: number): Scratch {
  let s = scratchCache.get(n);
  if (!s) {
    s = { re: new Float32Array(n * n), im: new Float32Array(n * n) };
    scratchCache.set(n, s);
  }
  return s;
}

/** 单域高度场（t=0）。调用方拿到的是拷贝，scratch 可以立刻被下一次演化复用。 */
function heightField(spec: Spectrum): Float32Array {
  const n = spec.n;
  const s = getScratch(n);
  evolveTo(spec, 0, s.re, s.im);
  fft2d(s.re, s.im, n, true);
  return s.re.slice(0, n * n);
}

/** 单域 RMS：先演化到 t=0 再逆变换。 */
export function measureRmsHeight(spec: Spectrum): number {
  const h = heightField(spec);
  let sum = 0;
  for (let i = 0; i < h.length; i++) sum += h[i] * h[i];
  return Math.sqrt(sum / h.length);
}

/**
 * 两域**逐点相加之后**的 RMS —— 着色器真正跑的那个场。
 *
 * `hypot(rms(short), rms(long))` 只在两域相位独立时才等于它；同 seed 时两域逐点相关，
 * 真实的合成 RMS 会到 √2 倍。这个函数存在的理由就是让那条假设变成被测的东西。
 */
export function measureCombinedRms(a: Spectrum, b: Spectrum): number {
  if (a.n !== b.n) throw new Error('both domains must share fftSize');
  const ha = heightField(a);
  const hb = heightField(b);
  let sum = 0;
  for (let i = 0; i < ha.length; i++) {
    const v = ha[i] + hb[i];
    sum += v * v;
  }
  return Math.sqrt(sum / ha.length);
}

/**
 * Fills `out` (length n*n*4) with R = height, G = normal.x, B = normal.z,
 * A = **ridge curvature** (positive on a crest), for the given time.
 *
 * A used to be crest foam (`height > foamStart`), which is a weak proxy: a high patch of
 * water is not necessarily a crest, and a crest is not necessarily high. The ridge indicator
 * — the negative second derivative along the wind direction, in physical units (1/m) — peaks
 * exactly where the surface folds over into a crest, and it is the field whose isocontours
 * run *along* the wave ridges instead of around blobs. Foam is derived from it in the shader.
 *
 * Writes every element, allocates nothing.
 */
export function seaSurface(spec: Spectrum, t: number, out: Float32Array): void {
  const n = spec.n;
  const s = getScratch(n);
  evolveTo(spec, t, s.re, s.im);
  fft2d(s.re, s.im, n, true);

  const h = s.re;
  const texel = spec.patchSize / n;
  const dx = texel;
  const inv2dx = 1 / (2 * dx);
  const exagg = spec.normalExaggeration;
  const invTexel2 = 1 / (texel * texel);
  // 风向单位化：脊线沿风向取二阶差分，所以要按风向走纹素，不是沿 x/z 轴。
  const wlen = Math.hypot(spec.windDirection[0], spec.windDirection[1]) || 1;
  const wxn = spec.windDirection[0] / wlen;
  const wzn = spec.windDirection[1] / wlen;

  for (let z = 0; z < n; z++) {
    const row = z * n;
    const rowPrev = ((z - 1 + n) % n) * n;
    const rowNext = ((z + 1) % n) * n;
    for (let x = 0; x < n; x++) {
      const xPrev = x === 0 ? n - 1 : x - 1;
      const xNext = x === n - 1 ? 0 : x + 1;
      const height = h[row + x];
      const gx = (h[row + xNext] - h[row + xPrev]) * inv2dx * exagg;
      const gz = (h[rowNext + x] - h[rowPrev + x]) * inv2dx * exagg;
      const len = Math.sqrt(gx * gx + 1 + gz * gz) || 1;
      // 沿风向的邻居（最近邻，纹素为单位；环形回绕，谱域是周期的）。
      const sx = (((Math.round(x + wxn) % n) + n) % n);
      const sz = (((Math.round(z + wzn) % n) + n) % n);
      const px = (((Math.round(x - wxn) % n) + n) % n);
      const pz = (((Math.round(z - wzn) % n) + n) % n);
      const hPlus = h[sz * n + sx];
      const hMinus = h[pz * n + px];
      // 负二阶导：浪脊（局部极大）为正。
      // **不除纹素²**：物理曲率 ∝ 1/波长²，25 m 域的曲率比 400 m 域大 256 倍，直接相加
      // 会让高频级联淹没低频。用「纹素单位的二阶差分」后各级量级可比，才能加权叠加。
      const ridge = -(hPlus - 2 * height + hMinus);
      const o = (row + x) * 4;
      out[o] = height;
      out[o + 1] = -gx / len;
      out[o + 2] = -gz / len;
      out[o + 3] = ridge;
    }
  }
}

// ---------------------------------------------------------------------------
// float32 <-> float16
// ---------------------------------------------------------------------------

const halfF32 = new Float32Array(1);
const halfU32 = new Int32Array(halfF32.buffer);

/** Encode a JS number as an IEEE-754 binary16 bit pattern (stored in a uint16). */
export function floatToHalf(value: number): number {
  if (Number.isNaN(value)) return 0x7e00;
  if (!Number.isFinite(value)) return value > 0 ? 0x7c00 : 0xfc00;
  halfF32[0] = value;
  const x = halfU32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  const mant = x & 0x007fffff;
  const e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    const m = mant | 0x00800000;
    const shift = 14 - e;
    const half = m >>> shift;
    const rem = m & ((1 << shift) - 1);
    const halfWay = 1 << (shift - 1);
    const roundUp = rem > halfWay || (rem === halfWay && (half & 1) === 1);
    return sign | (half + (roundUp ? 1 : 0));
  }
  const half = (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  const roundUp = rem > 0x1000 || (rem === 0x1000 && (half & 1) === 1);
  return sign | (half + (roundUp ? 1 : 0));
}

/** Decode an IEEE-754 binary16 bit pattern back to a JS number. */
export function halfToFloat(bits: number): number {
  const sign = (bits & 0x8000) !== 0 ? -1 : 1;
  const exp = (bits >>> 10) & 0x1f;
  const mant = bits & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 31) return mant !== 0 ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

/** Packs a float RGBA buffer into half-float texels. */
export function seaSurfaceToHalf(src: Float32Array, dst: Uint16Array): void {
  const len = Math.min(src.length, dst.length);
  for (let i = 0; i < len; i++) dst[i] = floatToHalf(src[i]);
}

// ---------------------------------------------------------------------------
// TSL material (WebGPU backend)
// ---------------------------------------------------------------------------

interface SeaUniforms {
  uTime: { value: number };
  uSunDir: { value: THREE.Vector3 };
  uTex: { value: THREE.Texture | null };
}

/**
 * 网格分段。1600 m / 560 = **2.86 m/段**。
 *
 * 280（5.7 m/段）表现不了 25 m 以下的浪：一个波长只有 4.4 段，几何直接走样，
 * 浪脊被拉成随机起伏。加密到 560 后最短级联有 8.7 段，浪形才立得住。
 * 顶点数 280² → 560² 是 4 倍（约 31 万），海面本来就是单 draw call，可接受。
 */
const SEA_GEOMETRY_SEGMENTS = 560;
/**
 * Geometry extent. The mesh is a *tile* that the world-follow code re-centres under the
 * aircraft. It was 1200 m, which capped the horizon haze at 380 m (the ramp has to saturate
 * before the snapped edge, and the edge can sit only `SIZE/2 - FOLLOW_STEP/2` ahead). At
 * cruise altitude that put the fully-hazed water inside the visible frame, so the far half of
 * the sea read as a flat salmon wall. 1600 m moves the worst-case edge to 600 m, which lets
 * the ramp run to 520 m and keeps the violet water and its glitter out to the horizon.
 */
export const SEA_PATCH_SIZE = 1600;
/**
 * Short-domain tiling: SEA_PATCH_SIZE / TEX_REPEAT = the 400 m spectrum period. The
 * follow-code still snaps the mesh by whole periods (harmless now that the shader samples
 * by world coordinates — the snap just keeps the geometry's vertex grid from crawling).
 */
const TEX_REPEAT = 4;
/** World-space period of the tiled wave pattern, in metres (= DEFAULT_SEA.patchSize). */
export const SEA_FOLLOW_STEP = SEA_PATCH_SIZE / TEX_REPEAT;
export const SEA_MIN_UPDATE_INTERVAL = 1 / 30;

/**
 * 方差拆分（评审 §2.2 B4-1）：短波域（400 m）分到的方差份额，长涌浪域拿
 * `1 - SEA_VARIANCE_SPLIT`。两个域若各自归一到同一个 amplitude，合成 RMS 会是
 * √2 倍（双计）；按方差拆分后 √(short² + long²) 恰等于总量。
 */
export const SEA_VARIANCE_SPLIT = 0.6;
/** 长涌浪谱域的世界周期。400 m 域装不下百米级的涌浪排。 */
export const SEA_LONG_PATCH = 2048;
/**
 * 长涌浪域的风速。Phillips 谱峰 λ ≈ 2πv²/g：v=17 → ~185 m 的涌浪排，在 2048 m
 * 域里约 11 个周期；400 m 域保持 6.4 m/s 的 ~26 m 短 chop。
 */
export const SEA_LONG_WIND = 17;
/**
 * 长涌浪域的随机种子盐（评审 §1.3 / 任务 S2）。
 *
 * 两域用同一个 `seed` 时，RNG 的抽样顺序完全一致（同一个 n×n 循环、同一串高斯数），
 * 于是两域的高度场**逐点相关**而不是独立——合成 RMS 变成 √2 倍（实测 0.4733 vs 0.34，
 * +39%，与"完全相关"的预测 0.4783 只差 1%）。异或一个盐让两域相位失相关，
 * 方差拆分才真的回到 √(short² + long²)。
 *
 * `artifacts/cloud-audit/recompute_sea_bands.py` 里必须用同一个盐，否则 CPU 复算和
 * GPU 谱对不上。
 */
export const SEA_LONG_SEED_SALT = 0x5bd1e995;

/**
 * 级联配置。**两级**，不是四级。
 *
 * 试过 4 级（2048/400/100/25 m），结论是：后两级对画面贡献为零，却每帧多付两次
 * IFFT + 两张 128² 纹理上传（实测 144 → 120 fps）。原因不在级联数量，在**没有 mip**：
 * `generateMipmaps = false` + `LinearFilter`，高频级联在远处直接欠采样成撒盐，近处又
 * 只有 2.86 m 的网格段表现不了 25 m 的浪。所以先把级联退回两级，把帧预算留给标定；
 * 要真正用上细碎级联，先给纹理生成 box mip 并按 footprint 选 LOD（参考实现的做法）。
 *
 * `weight` 是**方差份额**（和为 1），各级 amplitude 按 √w 分，合成 RMS 精确还原总量。
 */
export const SEA_CASCADES = [
  { patch: 2048, wind: 17.0, salt: 0x5bd1e995, weight: 0.4 }, // 长涌
  { patch: 400, wind: 6.4, salt: 0x00000000, weight: 0.6 }, // 主 chop
] as const;

/**
 * 高频级联的距离淡出区间（米）。
 *
 * 后两级（100 m / 25 m）只该在近处参与**色带**：它们的纹素是 0.78 m / 0.20 m，
 * 而 400 m 处一个屏幕像素覆盖好几米，硬切必然撒盐。但它们在近处是有用的——
 * 那正是「大块之间夹小块」里的小块。
 *
 * 所以不砍级联、不建 mip，只按距离压权重：近处满、远处 0。这比 mip 便宜一个数量级，
 * 解决的是同一个观感问题（远处干净、近处有细节）。`fwidth` 软化仍然兜住边界抗锯齿。
 */
export const SEA_HIGH_FADE = { near: 120, far: 420 } as const;

/**
 * 把目标 RMS 按方差拆到两域：短波 `total·√split`，长涌 `total·√(1-split)`。
 * 解析上合成 RMS 精确还原 `total`；非有限输入回 0，split 夹到 [0,1]。
 */
export function seaDomainAmplitudes(total: number, split: number): { short: number; long: number } {
  if (!Number.isFinite(total) || !Number.isFinite(split)) return { short: 0, long: 0 };
  const s = Math.min(Math.max(split, 0), 1);
  return { short: total * Math.sqrt(s), long: total * Math.sqrt(1 - s) };
}

/**
 * 世界坐标 UV 镜像：`uv = worldXZ / period`。网格只是把纹理从世界坐标里查出来，
 * mesh 平移多少都不改变采样——反射/高光钉在世界里，不跟飞机走。非有限或非正
 * 周期回 (0,0)，不往着色器里送垃圾。
 */
export function seaUv(worldX: number, worldZ: number, period: number): [number, number] {
  if (!Number.isFinite(worldX) || !Number.isFinite(worldZ) || !Number.isFinite(period) || period <= 0) {
    return [0, 0];
  }
  return [worldX / period, worldZ / period];
}

/** CSS hex -> THREE.Color in the renderer working space. */
function col(hex: number): THREE.Color {
  return new THREE.Color(hex);
}

async function createTslSeaMaterial(
  domains: readonly { texture: THREE.Texture; patchSize: number }[],
): Promise<{
  material: THREE.Material;
  uniforms: SeaUniforms;
}> {
  const TSL = await import('three/tsl');
  const { MeshBasicNodeMaterial } = await import('three/webgpu');

  const uTime = TSL.uniform(0);
  const uSunDir = TSL.uniform(new THREE.Vector3(...SUN_DIRECTION));

  const worldPos = TSL.positionWorld;
  // 世界坐标 UV（评审 §2.2 B4-2）：mesh 被 far-field snap 到整周期，但采样只吃
  // 世界坐标——mesh 平移任意量都不改变采样，浪场钉在世界里，不跟飞机走。
  // 每级用自己的周期，所以 UV 逐级不同；`seaUv` 是这条式子的 JS 镜像。
  const samples = domains.map((domain) => {
    const uv = TSL.vec2(worldPos.x.div(domain.patchSize), worldPos.z.div(domain.patchSize));
    return TSL.texture(domain.texture, uv);
  });
  // 逐级相加。**色带（heightNode）只吃低频两级**：`step` 是硬切，高频细节会让边界
  // 每个纹素翻一次档，海面变成「撒了盐」的噪点（实测：4 级全进 shape 就是这样）。
  // 细节留给法线和泡沫——那里高频是对的，它塑造的是明暗而不是色块边界。
  // 几何位移（positionNode）同样只吃低频：网格段长 5.7 m，表现不了 25 m 以下的浪。
  // 逐级相加：高度、坡度、脊线曲率。级数由 SEA_CASCADES 决定（当前四级）。
  // 后两级（100/25 m）的曲率单独攒起来，稍后按距离压权重——近处是小块细节，
  // 远处是撒盐的源头。高度与坡度只吃前两级（远处本来就看不到细浪的明暗）。
  const LOW_CASCADE_COUNT = 2;
  let heightNode = samples[0].r;
  let nxLow = samples[0].g;
  let nzLow = samples[0].b;
  let ridgeLow = samples[0].a;
  let ridgeHigh: any = TSL.float(0);
  for (let i = 1; i < samples.length; i += 1) {
    if (i < LOW_CASCADE_COUNT) {
      heightNode = heightNode.add(samples[i].r);
      nxLow = nxLow.add(samples[i].g);
      nzLow = nzLow.add(samples[i].b);
      ridgeLow = ridgeLow.add(samples[i].a);
    } else {
      ridgeHigh = ridgeHigh.add(samples[i].a);
    }
  }

  const material = new MeshBasicNodeMaterial();
  material.positionNode = TSL.vec3(TSL.positionLocal.x, heightNode, TSL.positionLocal.z);

  const viewDir = TSL.normalize(TSL.cameraPosition.sub(worldPos));
  const dist = TSL.length(worldPos.sub(TSL.cameraPosition));

  // **All shading uses the low-frequency normal.** Banding, Fresnel and the specular each
  // read `normalLow`, never the four-cascade sum: the high-frequency cascades move the normal
  // by a visible amount every texel, and every consumer of the normal amplifies that into a
  // visible artefact — `step()` tears the bands into pink confetti, `pow()` turns the road
  // into salt, Fresnel makes the water shimmer. The cascades still feed the *height* (band
  // position) and the sparkle gate; they are detail, not shading direction.
  const nyLow = TSL.sqrt(TSL.max(TSL.sub(1, nxLow.mul(nxLow).add(nzLow.mul(nzLow))), 0.02));
  const normalLow = TSL.normalize(TSL.vec3(nxLow, nyLow, nzLow));
  const ndl = TSL.clamp(TSL.dot(normalLow, uSunDir), 0, 1);

  // Toon bands, driven mostly by *wave height* rather than by the normal. A Phillips surface
  // is a lumpy Gaussian field: quantising the normal paints one flat colour per lump, which
  // is exactly the leopard-spot look at close range. Height bands follow the swell instead, so
  // the highlights come out as elongated crest lines the way the Gerstner baseline has them,
  // and the normal only breaks the bands up rather than defining them.
  const hNorm = TSL.clamp(heightNode.mul(0.62).add(0.5), 0, 1);
  // 高频级联按距离淡出：近处参与色带（小块细节），远处归零（否则 0.2 m 的纹素
  // 在 400 m 处被一个像素跨过几十次，硬切就是撒盐）。
  const highFade = TSL.float(1).sub(
    TSL.smoothstep(SEA_HIGH_FADE.near, SEA_HIGH_FADE.far, dist),
  );
  const ridge = ridgeLow.add(ridgeHigh.mul(highFade));
  // **色带驱动换成脊线曲率**。高度等值线是闭合斑块（IoU 0.61 对高度、0.28 对 NdotL，
  // 实测），无论怎么配权重都读成迷彩；脊线 `-∂²h/∂d²` 的等值线沿浪脊走（方向一致性
  // 0.61，四个候选里最高）。高度只留一点点，让色带边缘不至于太干净。
  // `ridgeScale` 把曲率（1/m 量级）压到 `shape` 的 sd≈0.09，改配置要重标。
  const ridgeZ = ridge.mul(SEA_SHAPE.ridgeScale);
  const shape = TSL.clamp(
    TSL.float(0.5)
      .add(ridgeZ)
      .add(hNorm.sub(SEA_SHAPE.hMean).mul(SEA_SHAPE.weightHeight * 0.1)),
    0,
    1,
  );
  // Flat bands, not gradients — but with a screen-space anti-aliased edge.
  //
  // The three `smoothstep` ramps that used to live here covered 0.42 / 0.24 / 0.12 of the
  // `shape` range, which made the whole surface one continuous blend: neither the hard
  // plateaus of the ghibli reference nor the detail of a realistic sea. Plain `step()` fixed
  // the plateau but aliased: the spectrum texture has no mip chain, so a distant pixel spans
  // several wavelengths and `step` turns that under-sampling into salt-and-pepper edges.
  //
  // `fwidth(shape)` is exactly the amount `shape` changes across one pixel: near the camera it
  // is far below the band width (edges stay hard), far away it widens on its own. That is a
  // mip chain's job done in one line, and it cannot turn the surface back into a gradient
  // because the softening is bounded by the pixel footprint.
  const soft = TSL.max(TSL.fwidth(shape).mul(1.5), TSL.float(0.001));
  const bandEdge = (stop: number): any =>
    TSL.smoothstep(TSL.float(stop).sub(soft), TSL.float(stop).add(soft), shape);

  let color: any = TSL.mix(
    TSL.color(col(SEA_PALETTE.deep)),
    TSL.color(col(SEA_PALETTE.mid)),
    bandEdge(SEA_BAND_STOPS[0]),
  );
  color = TSL.mix(color, TSL.color(col(SEA_PALETTE.lit)), bandEdge(SEA_BAND_STOPS[1]));
  color = TSL.mix(color, TSL.color(col(SEA_PALETTE.crest)), bandEdge(SEA_BAND_STOPS[2]).mul(0.45));

  // 亮侧勾边：沿色带边界提一条窄亮线，**只勾朝光那一侧**。
  // 平涂色块如果边缘全是纯硬切，会读成「贴图」；手绘会在受光的那条边上补一笔高光。
  // 用 `fwidth` 当宽度，所以近处是一条细线、远处自动变宽，不会在远处消失或糊开。
  const rimWidth = TSL.fwidth(shape).mul(1.5);
  const dNear = TSL.min(
    TSL.min(shape.sub(SEA_BAND_STOPS[0]).abs(), shape.sub(SEA_BAND_STOPS[1]).abs()),
    shape.sub(SEA_BAND_STOPS[2]).abs(),
  );
  const rimEdge = TSL.float(1).sub(TSL.smoothstep(TSL.float(0), rimWidth, dNear));
  color = color.add(TSL.color(col(SEA_PALETTE.glitter)).mul(rimEdge.mul(ndl).mul(SEA_RIM.gain)));

  // Grazing Fresnel. Water reflects almost everything at shallow view angles, which is what
  // warms the sea toward the sky as it recedes and gives the near field its broken-diamond
  // shimmer once the normals are choppy — without it the water stays equally matte at every
  // distance and the horizon has to be faked entirely by the haze ramp. Schlick, F0 for water;
  // `sun-road.ts fresnel01` is the reference implementation of the same curve.
  const cosView = TSL.clamp(TSL.dot(normalLow, viewDir), 0, 1);
  const fresK = TSL.sub(1, cosView);
  const fresnel = TSL.float(SUN_ROAD.F0).add(
    TSL.float(1 - SUN_ROAD.F0).mul(fresK.mul(fresK).mul(fresK).mul(fresK).mul(fresK)),
  );
  color = color.add(TSL.color(col(SEA_PALETTE.lit)).mul(fresnel).mul(SUN_ROAD.FRESNEL_GAIN));

  // Sun glitter — **brush strokes, not a specular field**.
  //
  // The old form was `smoothstep(noise) * pow(spec, 96)`: a per-pixel mirror image broken up by
  // noise. Next to the flat bands it read as the one piece of "real sea" left in a painted
  // frame — the reviewer called it the most jarring thing in the picture, and that matches the
  // screenshots.
  //
  // A painted sea does not draw sparkle; it draws short dashes along the crests, denser and
  // flatter toward the horizon. So the glitter is a grid of cells stretched along the wind
  // (long axis) and squeezed across it (short axis), each cell hashed for length and presence,
  // and the specular term only decides how bright the stroke is. `roadGate` still confines the
  // strokes to the sun's bearing.
  const reflected = TSL.reflect(uSunDir.mul(-1), normalLow);
  const spec = TSL.pow(TSL.max(TSL.dot(reflected, viewDir), 0), SUN_ROAD.NARROW);

  // 与 DEFAULT_SEA.windDirection 一致；笔触沿风向拉长。改风向要同步这里。
  const wind2 = TSL.vec2(0.82, -0.57).normalize();
  const perp2 = TSL.vec2(wind2.y.negate(), wind2.x);
  const groundPos = TSL.vec2(worldPos.x, worldPos.z);
  // 低频域扭曲：不加的话笔触会排成规则虚线网格，一眼看出是贴图而不是笔。
  const warp = TSL.mx_noise_float(
    TSL.vec3(worldPos.x.mul(0.045), worldPos.z.mul(0.045), uTime.mul(0.02)),
  ).mul(SEA_STROKE.warp);
  const strokeQ = TSL.vec2(
    TSL.dot(groundPos, wind2).mul(SEA_STROKE.along).add(warp),
    TSL.dot(groundPos, perp2).mul(SEA_STROKE.across).add(warp.mul(0.7)),
  );
  const strokeCell = TSL.floor(strokeQ);
  const strokeLocal = TSL.fract(strokeQ);
  // 每格一个稳定哈希（时间上缓慢漂移，像笔触随水面移动而不是随机闪）。
  const strokeHash = TSL.mx_noise_float(
    TSL.vec3(strokeCell.x.mul(0.37), strokeCell.y.mul(0.41), uTime.mul(0.08)),
  )
    .mul(0.5)
    .add(0.5);
  // 跨风向的细带 + 沿风向长度随哈希变化 + 稀疏门。
  const acrossMask = TSL.float(1).sub(
    TSL.smoothstep(SEA_STROKE.halfWidth * 0.6, SEA_STROKE.halfWidth, strokeLocal.y.sub(0.5).abs()),
  );
  const alongMask = TSL.float(1).sub(
    TSL.smoothstep(
      TSL.float(0.30).mul(strokeHash),
      TSL.float(0.42).mul(strokeHash),
      strokeLocal.x.sub(0.5).abs(),
    ),
  );
  const sparseMask = TSL.step(SEA_STROKE.sparse, strokeHash);
  const strokeMask = acrossMask.mul(alongMask).mul(sparseMask);

  // Glitter is faded out over the first ~50 m: a big specular lobe on a near-field facet reads
  // as a white smear rather than sparkle, and the road only belongs at the horizon anyway.
  const nearFade = TSL.clamp(dist.mul(0.02), 0, 1);
  const fragDir = TSL.normalize(worldPos.sub(TSL.cameraPosition));
  // Azimuth gate (sun-road.ts is the test-pinned reference): the bare specular survives
  // everywhere, but inside ±WIDTH_DEG of the sun's bearing it gains the road boost, so
  // the glitter reads as one road toward the sun instead of a field of sparkles.
  const sunRoadAzCos = TSL.clamp(
    TSL.dot(TSL.normalize(TSL.vec2(uSunDir.x, uSunDir.z)), TSL.normalize(TSL.vec2(fragDir.x, fragDir.z))),
    -1,
    1,
  );
  const sunRoadMask = TSL.smoothstep(Math.cos((SUN_ROAD.WIDTH_DEG * Math.PI) / 180), 1, sunRoadAzCos);
  // The road is a peak now, not merely a narrowed base: `ROAD_PEAK` > 1 lifts the centre while
  // `ROAD_FLOOR` still attenuates outside it. The old comment required the peak to stay at the
  // pre-T12 glint so `post.ts`'s bloom threshold would stay valid — that held only while the
  // road had no peak at all (measured `sunroad_ratio` 1.14 against a 2.4–3.0 gate).
  const roadGate = TSL.float(SUN_ROAD.ROAD_FLOOR).add(
    TSL.float(SUN_ROAD.ROAD_PEAK - SUN_ROAD.ROAD_FLOOR).mul(sunRoadMask),
  );
  const glint = strokeMask
    .mul(spec)
    .mul(SUN_ROAD.BASE)
    .mul(nearFade)
    .mul(roadGate);
  color = color.add(TSL.color(col(SEA_PALETTE.glitter)).mul(glint));

  // Crest foam: the ridge curvature *is* the crest detector now, so foam is gated on it
  // instead of on raw height. Only the sharpest folds get foam, and noise breaks the mask up
  // so it cannot spread into a white sheet.
  const foamNoise = TSL.mx_noise_float(
    TSL.vec3(worldPos.x.mul(0.33), worldPos.z.mul(0.33), uTime.mul(0.15)),
  ).mul(0.5).add(0.5);
  const foamBreak = TSL.smoothstep(0.3, 0.72, foamNoise);
  const foamMask = TSL.smoothstep(SEA_FOAM.ridgeStart, SEA_FOAM.ridgeFull, ridge);
  color = color.add(
    TSL.color(col(SEA_PALETTE.foam)).mul(foamMask).mul(foamBreak).mul(ndl.mul(0.6).add(0.2)),
  );

  // Horizon haze. The far field has to land on *exactly* the sky dome's own colour for this
  // direction, so the ramp reaches 1 well before the patch edge and the glow term is copied
  // from `sky-webgpu.ts` verbatim: tint (1.0, 0.78, 0.52), pow(cos,9) * 0.42, cos against the
  // true view ray. Flattening the ray to the horizontal (an earlier version did) lifted the
  // glow just *below* the waterline while the sky just above it had already lost it to the
  // elevation term — that asymmetry is what made the sea's far edge read as a straight band
  // brighter than the sky it meets.
  const haze = TSL.smoothstep(HORIZON.HAZE_NEAR, HORIZON.HAZE_FAR, dist);
  const horizonGlow = TSL.pow(TSL.max(TSL.dot(fragDir, uSunDir), 0), HORIZON.GLOW_POW).mul(HORIZON.GLOW_GAIN);
  const hazeCss = col(SEA_PALETTE.haze);
  const hazeColor = TSL.vec3(hazeCss.r, hazeCss.g, hazeCss.b).add(
    TSL.vec3(1, 0.78, 0.52).mul(horizonGlow),
  );
  color = TSL.mix(color, hazeColor, haze);

  material.colorNode = color;
  material.fog = false;
  material.transparent = false;
  material.side = THREE.DoubleSide;

  return {
    material: material as unknown as THREE.Material,
    uniforms: { uTime, uSunDir, uTex: { value: domains[0]?.texture ?? null } },
  };
}

// ---------------------------------------------------------------------------
// Public handle
// ---------------------------------------------------------------------------

export interface SeaHandle {
  readonly kind: 'fft' | 'gerstner';
  update(t: number): void;
  /** false = degraded budget (64 FFT). Called by the world frame governor. */
  setQuality(high: boolean): void;
  dispose(): void;
}

function makeGeometry(segments: number): THREE.PlaneGeometry {
  const geo = new THREE.PlaneGeometry(SEA_PATCH_SIZE, SEA_PATCH_SIZE, segments, segments);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

/** 一个谱域的运行时资源：谱、CPU 场、半精度纹理、世界周期。 */
interface SeaDomain {
  spec: Spectrum;
  surface: Float32Array;
  half: Uint16Array;
  texture: THREE.DataTexture | null;
  patchSize: number;
}

interface SeaState {
  scene: THREE.Scene;
  mesh: THREE.Mesh | null;
  material: THREE.Material | null;
  geometry: THREE.PlaneGeometry | null;
  domains: SeaDomain[];
  config: SeaConfig;
  uniforms: SeaUniforms | null;
  lastUpdate: number;
  highQuality: boolean;
  disposed: boolean;
}

function makeDomainTexture(half: Uint16Array, n: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(half, n, n, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  // Repeat, not clamp: the patch is a tiled pattern the follow-code slides under the
  // aircraft, so every tile boundary has to wrap seamlessly.
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

function applyTexture(state: SeaState, size: number): void {
  // 方差按 SEA_CASCADES 的 weight 拆：各级 amplitude = total·√(w/Σw)，合成 RMS 精确还原。
  const wsum = SEA_CASCADES.reduce((sum, c) => sum + c.weight, 0);
  for (const old of state.domains) old.texture?.dispose();
  state.domains = SEA_CASCADES.map((cascade) => {
    const amplitude = state.config.amplitude * Math.sqrt(cascade.weight / wsum);
    const spec = buildPhillipsSpectrum({
      ...state.config,
      fftSize: size,
      patchSize: cascade.patch,
      windSpeed: cascade.wind,
      amplitude,
      // 每级异或自己的盐：同一个 seed 会让所有级联逐点相关，方差拆分就白做了。
      seed: (state.config.seed ^ cascade.salt) >>> 0,
    });
    const domain: SeaDomain = {
      spec,
      surface: new Float32Array(spec.n * spec.n * 4),
      half: new Uint16Array(spec.n * spec.n * 4),
      texture: null,
      patchSize: cascade.patch,
    };
    domain.texture = makeDomainTexture(domain.half, spec.n);
    return domain;
  });
}

function refreshTexture(state: SeaState, t: number): void {
  for (const domain of state.domains) {
    seaSurface(domain.spec, t, domain.surface);
    seaSurfaceToHalf(domain.surface, domain.half);
    if (domain.texture) domain.texture.needsUpdate = true;
  }
  state.lastUpdate = t;
}

export async function initSea(scene: THREE.Scene, _backend: Backend): Promise<SeaHandle> {
  const config: SeaConfig = { ...DEFAULT_SEA };
  const state: SeaState = {
    scene,
    mesh: null,
    material: null,
    geometry: null,
    domains: [],
    config,
    uniforms: null,
    lastUpdate: Number.NaN,
    highQuality: true,
    disposed: false,
  };
  applyTexture(state, config.fftSize);
  refreshTexture(state, 0);

  const domainRefs = (): { texture: THREE.Texture; patchSize: number }[] =>
    state.domains.map((domain) => ({
      texture: domain.texture as THREE.Texture,
      patchSize: domain.patchSize,
    }));

  const { material, uniforms } = await createTslSeaMaterial(domainRefs());
  state.material = material;
  state.uniforms = uniforms;

  const geometry = makeGeometry(SEA_GEOMETRY_SEGMENTS);
  state.geometry = geometry;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'sea-fft';
  mesh.position.y = 0;
  mesh.frustumCulled = false;
  mesh.renderOrder = 0;
  state.mesh = mesh;
  scene.add(mesh);

  return {
    kind: 'fft',
    update(t: number): void {
      if (state.disposed) return;
      const prev = state.lastUpdate;
      const advanced = !Number.isFinite(prev) || t < prev || t - prev >= SEA_MIN_UPDATE_INTERVAL;
      if (advanced) refreshTexture(state, t);
      if (state.uniforms) state.uniforms.uTime.value = t;
    },
    setQuality(high: boolean): void {
      if (state.disposed || state.highQuality === high) return;
      state.highQuality = high;
      const size = high ? config.fftSize : Math.min(64, config.fftSize);
      applyTexture(state, size);
      refreshTexture(state, Number.isFinite(state.lastUpdate) ? state.lastUpdate : 0);
      if (state.material) {
        // The node graph samples the texture handle, so a size change needs a
        // fresh bind. Rebuild the material once (guarded: at most a few times).
        state.uniforms = null;
        void createTslSeaMaterial(domainRefs()).then((built) => {
          if (state.disposed || !state.mesh) {
            built.material.dispose();
            return;
          }
          state.material?.dispose();
          state.material = built.material;
          state.uniforms = built.uniforms;
          state.mesh.material = built.material;
        });
      }
    },
    dispose(): void {
      if (state.disposed) return;
      state.disposed = true;
      if (state.mesh) {
        scene.remove(state.mesh);
        state.mesh = null;
      }
      state.geometry?.dispose();
      state.material?.dispose();
      for (const domain of state.domains) {
        domain.texture?.dispose();
        domain.texture = null;
      }
      state.domains = [];
      state.geometry = null;
      state.material = null;
    },
  };
}
