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
import { SEA_PALETTE } from './sea-fallback';

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
  // Spectrum domain, NOT the mesh size: the geometry is SEA_PATCH_SIZE (1200 m) with the
  // texture repeated TEX_REPEAT times, so one spectral period is still 400 m.
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
      p *= dirDot * dirDot;

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

function measureRmsHeight(spec: Spectrum): number {
  const n = spec.n;
  const s = getScratch(n);
  evolveTo(spec, 0, s.re, s.im);
  fft2d(s.re, s.im, n, true);
  let sum = 0;
  for (let i = 0; i < n * n; i++) sum += s.re[i] * s.re[i];
  return Math.sqrt(sum / (n * n));
}

/**
 * Fills `out` (length n*n*4) with R = height, G = normal.x, B = normal.z,
 * A = crest foam, for the given time. Writes every element, allocates nothing.
 */
export function seaSurface(spec: Spectrum, t: number, out: Float32Array): void {
  const n = spec.n;
  const s = getScratch(n);
  evolveTo(spec, t, s.re, s.im);
  fft2d(s.re, s.im, n, true);

  const h = s.re;
  const dx = spec.patchSize / n;
  const inv2dx = 1 / (2 * dx);
  const exagg = spec.normalExaggeration;
  const foamStart = spec.foamStart;
  const foamRange = spec.foamRange > 1e-6 ? 1 / spec.foamRange : 0;

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
      let foam = (height - foamStart) * foamRange;
      if (foam < 0) foam = 0;
      else if (foam > 1) foam = 1;
      const o = (row + x) * 4;
      out[o] = height;
      out[o + 1] = -gx / len;
      out[o + 2] = -gz / len;
      out[o + 3] = foam;
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

const SEA_GEOMETRY_SEGMENTS = 150;
/**
 * Geometry extent. The mesh is a *tile* that the world-follow code re-centres under the
 * aircraft; 1200 m gives 600 m of ocean in every direction, well past the 340 m where the
 * horizon haze reaches full strength, so the patch edge can never be seen.
 */
const SEA_PATCH_SIZE = 1200;
/**
 * How many times the FFT texture repeats across the geometry. 1200 / 3 = the 400 m spectrum
 * domain, so wave *size* stays exactly as authored and the pattern period is 400 m — which is
 * why the follow-code can snap the mesh by whole periods with no visible jump.
 */
const TEX_REPEAT = 3;
/** World-space period of the tiled wave pattern, in metres (= DEFAULT_SEA.patchSize). */
export const SEA_FOLLOW_STEP = SEA_PATCH_SIZE / TEX_REPEAT;
export const SEA_MIN_UPDATE_INTERVAL = 1 / 30;

/** CSS hex -> THREE.Color in the renderer working space. */
function col(hex: number): THREE.Color {
  return new THREE.Color(hex);
}

async function createTslSeaMaterial(texture: THREE.Texture): Promise<{
  material: THREE.Material;
  uniforms: SeaUniforms;
}> {
  const TSL = await import('three/tsl');
  const { MeshBasicNodeMaterial } = await import('three/webgpu');

  const uTime = TSL.uniform(0);
  const uSunDir = TSL.uniform(new THREE.Vector3(0.28, 0.14, -1).normalize());

  const texNode = TSL.texture(texture, TSL.uv().mul(TEX_REPEAT));
  const heightNode = texNode.r;

  const material = new MeshBasicNodeMaterial();
  material.positionNode = TSL.vec3(TSL.positionLocal.x, heightNode, TSL.positionLocal.z);

  const nx = texNode.g;
  const nz = texNode.b;
  const foamMask = texNode.a;
  const ny = TSL.sqrt(TSL.max(TSL.sub(1, nx.mul(nx).add(nz.mul(nz))), 0.02));

  const worldPos = TSL.positionWorld;
  const viewDir = TSL.normalize(TSL.cameraPosition.sub(worldPos));
  const dist = TSL.length(worldPos.sub(TSL.cameraPosition));

  // Sub-swell relief. The spectrum domain is 400 m over 128 bins (~3 m texels) and the mesh
  // only has ~8 m segments, so the swell by itself reads as flat plates of one colour — the
  // "melted plastic" look. Two derivative taps of a cheap noise field put the metre-scale
  // texture back, faded with distance so it cannot alias into horizon shimmer.
  const detailScale = 0.19;
  const detailPos = TSL.vec3(worldPos.x.mul(detailScale), uTime.mul(0.22), worldPos.z.mul(detailScale));
  const d0 = TSL.mx_noise_float(detailPos);
  const dX = TSL.mx_noise_float(detailPos.add(TSL.vec3(0.37, 0, 0)));
  const dZ = TSL.mx_noise_float(detailPos.add(TSL.vec3(0, 0, 0.37)));
  const detailFade = TSL.float(1).div(dist.mul(0.014).add(1));
  const bumpAmp = detailFade.mul(1.7);
  const normal = TSL.normalize(
    TSL.vec3(
      nx.add(dX.sub(d0).mul(bumpAmp)),
      ny,
      nz.add(dZ.sub(d0).mul(bumpAmp)),
    ),
  );

  const ndl = TSL.clamp(TSL.dot(normal, uSunDir), 0, 1);

  // Toon bands. Thresholds are wide on purpose: narrow ones turn every swell into a flat
  // plateau of a single colour, which is what made the sea look like molten plastic.
  const band = TSL.clamp(ndl.mul(1.18), 0, 1);
  let color = TSL.mix(TSL.color(col(SEA_PALETTE.deep)), TSL.color(col(SEA_PALETTE.mid)), TSL.smoothstep(0.06, 0.34, band));
  color = TSL.mix(color, TSL.color(col(SEA_PALETTE.lit)), TSL.smoothstep(0.42, 0.74, band));
  color = TSL.mix(color, TSL.color(col(SEA_PALETTE.crest)), TSL.smoothstep(0.88, 1, band).mul(0.45));

  // Sun glitter: a narrow specular path toward the sun, broken up by noise so it reads as
  // scattered sparkle along that path instead of a white sheet over the whole patch.
  const reflected = TSL.reflect(uSunDir.mul(-1), normal);
  const spec = TSL.pow(TSL.max(TSL.dot(reflected, viewDir), 0), 170);
  const sparkle = TSL.mx_noise_float(
    TSL.vec3(worldPos.x.mul(1.7), worldPos.z.mul(1.7), uTime.mul(0.45)),
  );
  const glint = TSL.smoothstep(0.42, 0.78, sparkle.mul(0.5).add(0.5)).mul(spec).mul(1.5);
  color = color.add(TSL.color(col(SEA_PALETTE.glitter)).mul(glint));

  // Crest foam: only the tips, and broken up so it cannot spread into a white sheet.
  const foamNoise = TSL.mx_noise_float(
    TSL.vec3(worldPos.x.mul(0.33), worldPos.z.mul(0.33), uTime.mul(0.15)),
  ).mul(0.5).add(0.5);
  const foamBreak = TSL.smoothstep(0.3, 0.72, foamNoise);
  color = color.add(
    TSL.color(col(SEA_PALETTE.foam)).mul(foamMask).mul(foamBreak).mul(ndl.mul(0.6).add(0.2)),
  );

  // Horizon haze so the patch edge dissolves into the sunset sky.
  const haze = TSL.smoothstep(110, 260, dist);
  color = TSL.mix(color, TSL.color(col(SEA_PALETTE.haze)), haze);

  material.colorNode = color;
  material.fog = false;
  material.transparent = false;
  material.side = THREE.DoubleSide;

  return { material: material as unknown as THREE.Material, uniforms: { uTime, uSunDir, uTex: { value: texture } } };
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

interface SeaState {
  scene: THREE.Scene;
  mesh: THREE.Mesh | null;
  material: THREE.Material | null;
  texture: THREE.DataTexture | null;
  geometry: THREE.PlaneGeometry | null;
  spec: Spectrum;
  config: SeaConfig;
  surface: Float32Array;
  half: Uint16Array;
  uniforms: SeaUniforms | null;
  lastUpdate: number;
  highQuality: boolean;
  disposed: boolean;
}

function applyTexture(state: SeaState, size: number): void {
  const spec = buildPhillipsSpectrum({ ...state.config, fftSize: size });
  state.spec = spec;
  state.surface = new Float32Array(spec.n * spec.n * 4);
  state.half = new Uint16Array(spec.n * spec.n * 4);

  if (state.texture) state.texture.dispose();
  const tex = new THREE.DataTexture(state.half, spec.n, spec.n, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  // Repeat, not clamp: the patch is a tiled 400 m pattern the follow-code slides under the
  // aircraft, so every tile boundary has to wrap seamlessly.
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  state.texture = tex;
}

function refreshTexture(state: SeaState, t: number): void {
  seaSurface(state.spec, t, state.surface);
  seaSurfaceToHalf(state.surface, state.half);
  if (state.texture) state.texture.needsUpdate = true;
  state.lastUpdate = t;
}

export async function initSea(scene: THREE.Scene, _backend: Backend): Promise<SeaHandle> {
  const config: SeaConfig = { ...DEFAULT_SEA };
  const state: SeaState = {
    scene,
    mesh: null,
    material: null,
    texture: null,
    geometry: null,
    spec: buildPhillipsSpectrum(config),
    config,
    surface: new Float32Array(config.fftSize * config.fftSize * 4),
    half: new Uint16Array(config.fftSize * config.fftSize * 4),
    uniforms: null,
    lastUpdate: Number.NaN,
    highQuality: true,
    disposed: false,
  };
  applyTexture(state, config.fftSize);
  refreshTexture(state, 0);

  const texture = state.texture as THREE.DataTexture;
  const { material, uniforms } = await createTslSeaMaterial(texture);
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
        void createTslSeaMaterial(state.texture as THREE.DataTexture).then((built) => {
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
      state.texture?.dispose();
      state.geometry = null;
      state.material = null;
      state.texture = null;
    },
  };
}
