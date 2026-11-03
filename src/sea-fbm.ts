/**
 * Ridged, wind-anisotropic, domain-warped FBM band field for the sea
 * (plan 2026-11-03-sea-fbm-band-continuity, Task 1).
 *
 * Why this module exists: the FFT band driver (`ridge` in the cascade texture
 * alpha) is a Gaussian field, so every band edge is a closed contour — it can
 * only read as patches (measured baseline: coherence 0.711/0.733, plan §3.1).
 * A ridged noise field's edges are constructed lines, not thresholded blobs.
 *
 * Mirror discipline (Review Focus #5):
 * - The hash is the SAME PCG as `TSL.hash` (three.webgpu.js:37777), replicated
 *   with `Math.imul` + `>>> 0`; the final float conversion rounds to float32
 *   exactly like `result.toFloat()`.
 * - Every intermediate float goes through `Math.fround` so this TS evaluation
 *   and the GPU float32 evaluation see the same values; without that, float64
 *   coordinates drift ~1e-7 relative and `floor()` flips at lattice cell
 *   borders, which jumps the noise by O(1) at those samples.
 * - The 16 gradient directions are a constant table (no trig at evaluation
 *   time), exported for the Task 2 TSL implementation to import verbatim.
 *
 * Wrap discipline (Review Focus #4): ONLY the lattice index wraps
 * (`ix mod N`). The world coordinates are never wrapped — with a diagonal
 * wind and per-octave rotation there is no common world-axis period, and
 * wrapping world coordinates would cut real seams. Index wrap is seamless
 * because wrapped cells share hashes (C0 across the boundary) and it keeps
 * the packed hash seed bounded: seed = stream + ix + iy*N stays < 2^24
 * (asserted by tests via maxHashSeed), which is what `TSL.hash`'s
 * float->uint conversion needs to stay lossless.
 *
 * float32 envelope (in place of a coordinate wrap): q = p/L*2^i keeps the
 * lattice coordinates small — at |p| = 1e7 m and L ~ 500 m, q ~ 2e4 and the
 * float32 ulp of q is ~2e-3 q-units (~0.1% of a feature wavelength), so band
 * positions stay stable across the whole flight envelope; degradation only
 * becomes visible orders of magnitude beyond it.
 *
 * Time model (§0.1, decided): the band field is world-anchored quasi-static.
 * `fbmRidgeField` does not consume `t` at all; `t` only enters the threshold
 * breathing inside `fbmBandShape` as a slow drift. No wind advection.
 */

import { bandMetrics, type BandMetrics } from './sea-metrics';

const f32 = Math.fround;

export type FbmVariant = 'wavegrid' | 'ridged';

export interface FbmConfig {
  /** 'wavegrid' (default): sin wave trains phase-bent by noise — the plan's
   * §1.3 alternative, which won the §1.3 A/B (see fbmRidgeField doc). 'ridged':
   * the plan's original 1-|noise| construction, kept swappable. */
  variant: FbmVariant;
  seed: number;
  /** Along-wind feature length (m) — the main "how long is a stripe" knob. */
  alongLength: number;
  /** Across-wind feature length (m). along:across = 5:1 (decided, §0.1). */
  acrossLength: number;
  /** Compile-time constant, <= 4 (WebGL2 first-frame compile budget). */
  octaves: number;
  /** Non-integer lacunarity decorrelates the octaves. */
  lacunarity: number;
  /** Spectral gain per octave. 0.3–0.4: big colour blocks, not salt. */
  gain: number;
  /**
   * Per-octave pair rotation (rad). Octaves alternate ±rotationPerOctave/2 —
   * two ridge families at ±rotationPerOctave/2 off the wind. A compounding
   * i*rotationPerOctave would rotate the anisotropy AXIS with the domain and
   * shred directionality (measured coherence 0.283; see the fbmRidgeField doc).
   */
  rotationPerOctave: number;
  /** Domain-warp amplitude, in units of the octave's own wavelength. */
  warpStrength: number;
  /**
   * Lattice wrap width N in q-space cells (not metres). One q-unit is
   * `alongLength` x `acrossLength` metres, so cell borders land at
   * alongLength/N x acrossLength/N m. Only affects the hash repeat period.
   * Must be a power of two <= 2^11 to keep the packed seed < 2^24.
   */
  cells: number;
}

export const DEFAULT_FBM: FbmConfig = {
  variant: 'wavegrid',
  seed: 1337,
  alongLength: 500,
  acrossLength: 100,
  octaves: 4,
  lacunarity: 1.9,
  gain: 0.3,
  rotationPerOctave: 0.3,
  warpStrength: 0.3,
  cells: 512,
};

/** Wind basis shared with SEA_STROKE (sea-fft.ts:920); normalised on export. */
export const SEA_WIND: [number, number] = (() => {
  const len = Math.hypot(0.82, -0.57) || 1;
  return [0.82 / len, -0.57 / len];
})();

/**
 * 16 gradient directions as an interleaved Float32Array (x0, y0, x1, y1, ...).
 * Table lookup instead of trig so TS and TSL share bit-identical constants.
 */
export const FBM_GRADIENTS: Float32Array = (() => {
  const table = new Float32Array(32);
  for (let k = 0; k < 16; k++) {
    const ang = (Math.PI * 2 * k) / 16;
    table[k * 2] = f32(Math.cos(ang));
    table[k * 2 + 1] = f32(Math.sin(ang));
  }
  return table;
})();

// Seed stream layout: stream(i, salt) = seed + i*SEED_STRIDE + salt.
// i <= 3 octaves, salt <= 3 -> no collision; corner offset adds < N^2 <= 2^22.
// Exported so the TSL graph (sea-fft.ts) builds from the SAME constants —
// the readback probe then verifies the actual GPU values against this module.
export const SEED_STRIDE = 2 ** 21;
export const SALT_MAIN = 0;
export const SALT_WARP1 = 1;
export const SALT_WARP2 = 2;
export const SALT_BREATH = 3;

export function fbmStream(seed: number, octave: number, salt: number): number {
  return seed + octave * SEED_STRIDE + salt;
}

/** Upper bound of any packed hash seed this module can feed to TSL.hash. */
export function maxHashSeed(cfg: FbmConfig): number {
  const n = cfg.cells;
  return cfg.seed + 3 * SEED_STRIDE + SALT_BREATH + (n - 1) + (n - 1) * n;
}

/** PCG mirror of `TSL.hash` — integer-exact via imul, uint result. */
export function pcgUint(seed: number): number {
  const state = (Math.imul(seed, 747796405) + 2891336453) >>> 0;
  const word = Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}

/** PCG hash mirror of `TSL.hash` — integer-exact, float32-rounded output. */
export function hash01(seed: number): number {
  return f32(pcgUint(seed)) * 2 ** -32;
}

/**
 * Gradient-table index from the hash. Both sides (this module and the TSL
 * graph in sea-fft.ts) derive it through the SAME float pipeline —
 * h01 = float32(result) * 2^-32, then min(15, floor(h01*16)) — so no uint
 * bit ops are needed in the shader and the mapping is bit-identical.
 */
function gradIndex(seed: number): number {
  const h01 = f32(pcgUint(seed)) * 2 ** -32;
  return Math.min(15, Math.floor(h01 * 16));
}

function quintic(t: number): number {
  // f32-rounded steps: t^3(t(6t-15)+10)
  const t6 = f32(t * 6 - 15);
  const t1 = f32(t * t6 + 10);
  const t2 = f32(t * t1);
  return f32(t2 * f32(t * t));
}

function lerp(a: number, b: number, t: number): number {
  // x*(1-t) + y*t, f32 per step (WGSL mix() form)
  return f32(f32(a * f32(1 - t)) + f32(f32(b * t)));
}

function wrapIndex(i: number, n: number): number {
  return ((i % n) + n) % n;
}

/**
 * Wrapped gradient noise on the unit lattice, in [-1, 1]-ish. Both coordinates
 * and the seed stream must satisfy the float32 packing bound (see module doc).
 */
export function latticeNoise(qx: number, qy: number, stream: number, cells: number): number {
  qx = f32(qx);
  qy = f32(qy);
  const ix = Math.floor(qx);
  const iy = Math.floor(qy);
  const fx = f32(qx - ix);
  const fy = f32(qy - iy);
  const ux = quintic(fx);
  const uy = quintic(fy);

  const x0 = wrapIndex(ix, cells);
  const x1 = wrapIndex(ix + 1, cells);
  const y0 = wrapIndex(iy, cells);
  const y1 = wrapIndex(iy + 1, cells);

  const s00 = stream + x0 + y0 * cells;
  const s10 = stream + x1 + y0 * cells;
  const s01 = stream + x0 + y1 * cells;
  const s11 = stream + x1 + y1 * cells;

  const r00 = gradIndex(s00);
  const r10 = gradIndex(s10);
  const r01 = gradIndex(s01);
  const r11 = gradIndex(s11);

  const n00 = f32(FBM_GRADIENTS[r00 * 2] * fx + FBM_GRADIENTS[r00 * 2 + 1] * fy);
  const n10 = f32(FBM_GRADIENTS[r10 * 2] * f32(fx - 1) + FBM_GRADIENTS[r10 * 2 + 1] * fy);
  const n01 = f32(FBM_GRADIENTS[r01 * 2] * fx + FBM_GRADIENTS[r01 * 2 + 1] * f32(fy - 1));
  const n11 = f32(
    FBM_GRADIENTS[r11 * 2] * f32(fx - 1) + FBM_GRADIENTS[r11 * 2 + 1] * f32(fy - 1),
  );

  return f32(lerp(lerp(n00, n10, ux), lerp(n01, n11, ux), uy));
}

// Warp sample offsets (q-units). Any fixed values; they only pick where the
// warp field is read, so the warp does not align with the main lattice.
export const WARP_S1: [number, number] = [13.7, 71.3];
export const WARP_S2: [number, number] = [-51.9, 29.4];

/**
 * The ridge field: 0..1, 1 = ridge centre. World coordinates in metres.
 *
 * A/B result that picked the default variant (plan §1.3 called for exactly
 * this test): the 'ridged' 1-|noise| construction tops out at coherence
 * 0.73 on the decided 5:1 anisotropy — a gradient-noise zero-set is a CLOSED
 * LOOP, so its bands are elongated ovals whose end caps contribute
 * perpendicular edge pixels no matter the parameters (measured across the
 * whole gain/warp/octave ladder). The 'wavegrid' variant — sin wave trains
 * whose phase is bent by noise — has structurally endless ridge lines and
 * measures 0.884 at the same 5:1, gain 0.3 (plan Task 1 gate: >= 0.85).
 *
 * Per octave, both variants: rotate the domain by ±rotationPerOctave/2
 * (alternating — see the config doc), project onto the wind basis, scale by
 * lacunarity^i / (alongLength, acrossLength), then:
 * - 'wavegrid': phase = PI*(v + warpStrength*noise(u/2, v/2)) — the warp is a
 *   PHASE bend, so ridge lines stay continuous while meandering like hand
 *   strokes; r = 1 - |sin(phase)|.
 * - 'ridged': r = 1 - |lattice noise| with the warp displacing the domain.
 *
 * NOTE (ridged variant): do not "re-ridge" the weighted sum with another
 * 1-|.| — the maximum of the sum still sits where the octaves' ridges
 * coincide (plan Task 1 point 5 pins this on purpose).
 */
export function fbmRidgeField(x: number, z: number, t: number, cfg: FbmConfig = DEFAULT_FBM): number {
  // `t` intentionally unused (time model §0.1); kept for TSL interface parity.
  void t;
  const wx = SEA_WIND[0];
  const wz = SEA_WIND[1];
  let sum = 0;
  let norm = 0;
  let prevQx = 0;
  let prevQy = 0;
  for (let i = 0; i < cfg.octaves; i++) {
    const half = cfg.rotationPerOctave / 2;
    const ang = i % 2 === 0 ? half : -half;
    const c = f32(Math.cos(ang));
    const s = f32(Math.sin(ang)); // ang carries the ± sign — do NOT multiply twice
    // per-op fround: the GPU rounds after every float op, so the mirror must too
    const px = f32(f32(c * x) - f32(s * z));
    const pz = f32(f32(s * x) + f32(c * z));
    const along = f32(f32(px * wx) + f32(pz * wz));
    const across = f32(f32(px * -wz) + f32(pz * wx));
    const scale = cfg.lacunarity ** i;
    const u = f32(f32(along * scale) / cfg.alongLength);
    const v = f32(f32(across * scale) / cfg.acrossLength);
    let r: number;
    if (cfg.variant === 'wavegrid') {
      const w = latticeNoise(
        f32(u * 0.5 + WARP_S1[0]),
        f32(v * 0.5 + WARP_S1[1]),
        fbmStream(cfg.seed, i, SALT_WARP1),
        cfg.cells,
      );
      const phase = f32(Math.PI * f32(v + f32(cfg.warpStrength * w)));
      r = f32(1 - Math.abs(Math.sin(phase)));
    } else {
      let qx = u;
      let qy = v;
      if (cfg.warpStrength > 0) {
        const bx = i > 0 ? prevQx : f32(qx * 0.5);
        const by = i > 0 ? prevQy : f32(qy * 0.5);
        const w1 = latticeNoise(
          f32(bx + WARP_S1[0]),
          f32(by + WARP_S1[1]),
          fbmStream(cfg.seed, i, SALT_WARP1),
          cfg.cells,
        );
        const w2 = latticeNoise(
          f32(bx + WARP_S2[0]),
          f32(by + WARP_S2[1]),
          fbmStream(cfg.seed, i, SALT_WARP2),
          cfg.cells,
        );
        qx = f32(qx + f32(cfg.warpStrength * w1));
        qy = f32(qy + f32(cfg.warpStrength * w2));
      }
      const n = latticeNoise(qx, qy, fbmStream(cfg.seed, i, SALT_MAIN), cfg.cells);
      r = f32(1 - Math.abs(n));
    }
    const w = cfg.gain ** i;
    sum = f32(sum + f32(w * r));
    norm = f32(norm + w);
    prevQx = u;
    prevQy = v;
  }
  return f32(sum / norm);
}

// Threshold breathing (§1.5-7): a hand-drawn line's width varies.
export const BREATHING_WAVELENGTH = 200; // m
export const BREATHING_DRIFT = 0.15; // m/s along the wind (§0.1: <= 0.3)
export const BREATHING_AMPLITUDE = 0.03;

/**
 * Ridge field -> band-driver value with threshold breathing. Unclamped
 * (roughly [-0.03, 1.03]); the shader clamps the composite after adding the
 * height coupling.
 */
export function fbmBandShape(
  ridge: number,
  x: number,
  z: number,
  t: number,
  cfg: FbmConfig = DEFAULT_FBM,
): number {
  const qx = f32((x + t * BREATHING_DRIFT * SEA_WIND[0]) / BREATHING_WAVELENGTH + 7.7);
  const qy = f32((z + t * BREATHING_DRIFT * SEA_WIND[1]) / BREATHING_WAVELENGTH + 3.1);
  const nb = latticeNoise(qx, qy, fbmStream(cfg.seed, 0, SALT_BREATH), cfg.cells);
  // plan Task 1 point 6 literal: amplitude * n_low, n_low signed — peaks at
  // ~±0.7 keep the wobble inside ±0.021, i.e. within the ±0.03 budget.
  return f32(ridge + f32(BREATHING_AMPLITUDE * nb));
}

/** Fade window for per-octave footprint bandwidth limiting (plan §1.4-1). */
export const OCTAVE_FADE_START = 0.25;
export const OCTAVE_FADE_END = 0.6;

/**
 * Per-octave weight from the pixel footprint: 1 while the octave's spatial
 * frequency is well below the pixel's Nyquist, fading to 0 as the pixel's
 * footprint approaches the octave's wavelength (the analytic mip chain —
 * Houdini's anti-aliased flow-noise trick). `freq` = f_i (1/m), `footprint` =
 * metres per pixel. Fades over [OCTAVE_FADE_START, OCTAVE_FADE_END] of
 * freq*footprint.
 */
export function fbmOctaveWeight(freq: number, footprint: number): number {
  const t = Math.min(Math.max((freq * footprint - OCTAVE_FADE_START) / (OCTAVE_FADE_END - OCTAVE_FADE_START), 0), 1);
  return 1 - t * t * (3 - 2 * t);
}

/**
 * 加权脊线（带全淡出兜底）。
 *
 * 远处一个像素跨过几十米时，每一层的 `fbmOctaveWeight` 都会到 0，`sum/norm` 变成
 * `0/0 = NaN`。评审实测这条在地平线附近可达（60 m/px 在 alt=7 / 60° fov 下约
 * d ≈ 512 m）。NaN 经 `clamp` 的处理因驱动而异：要么塌成一条纯 deep 带，要么
 * 穿到 `mix(shapeFft, shapeFbm, 0)` 变成黑带 + bloom 拖尾。
 *
 * 兜底用**最粗一级**：远处至少保留一层结构，而不是一条平带。
 */
export function fbmWeightedRidge(
  values: readonly number[],
  weights: readonly number[],
): number {
  let sum = 0;
  let norm = 0;
  const n = Math.min(values.length, weights.length);
  for (let i = 0; i < n; i += 1) {
    sum += values[i] * weights[i];
    norm += weights[i];
  }
  if (norm < 1e-6) return values[0] ?? 0;
  return sum / norm;
}

// Crest gate for foam (recalibrated against the field's p97 in Task 4).
export const CREST_START = 0.88;
export const CREST_FULL = 0.98;

/** Foam gate strength 0..1 from the ridge field. */
export function fbmCrest(ridge: number): number {
  const tRaw = (ridge - CREST_START) / (CREST_FULL - CREST_START);
  const t = Math.min(Math.max(tRaw, 0), 1);
  return t * t * (3 - 2 * t);
}

const METRICS_EXTENT = 1024;
const METRICS_SIZE = 512;

export type BandSource = 'fft' | 'fbm';

/**
 * QA switch for the band-field A/B: `?sea=fbm` / `?sea=fft`. Anything else
 * (including no parameter) resolves to 'fft' — the default path stays the
 * shipped behaviour, so the rollback is "do nothing" (plan Task 2).
 */
export function seaBandSourceFromQuery(search: string): BandSource {
  if (typeof search !== 'string' || search.length === 0) return 'fft';
  const value = new URLSearchParams(search).get('sea');
  return value === 'fbm' ? 'fbm' : 'fft';
}

/**
 * `?sea-debug=shape` renders the band field as flat SEA_PALETTE colours — no
 * lighting, haze, strokes, foam or Fresnel. The final frame's colours are a
 * per-pixel lighting composite, so palette classification on it cannot
 * discriminate band structure (measured 0.33 for BOTH band sources); this
 * contribution view is what the screenshot-side coherence gate measures.
 */
export function seaDebugFromQuery(search: string): boolean {
  if (typeof search !== 'string' || search.length === 0) return false;
  return new URLSearchParams(search).get('sea-debug') === 'shape';
}

/**
 * Band metrics of this module's own field, with the stops taken from the
 * field's own p25/p75/p97 (the same quantile intent as SEA_BAND_STOPS, but
 * self-consistent for any config). This is the coherence gate's measurement.
 */
export function fbmBandMetrics(cfg: FbmConfig = DEFAULT_FBM): BandMetrics {
  const sample = (x: number, z: number): number => {
    const r = fbmRidgeField(x, z, 0, cfg);
    return Math.min(Math.max(fbmBandShape(r, x, z, 0, cfg), 0), 1);
  };
  // Pre-scan for quantile stops (deterministic -> same values as the run below).
  const scan = new Float64Array(METRICS_SIZE * METRICS_SIZE);
  const step = METRICS_EXTENT / (METRICS_SIZE - 1);
  const half = METRICS_EXTENT / 2;
  for (let j = 0; j < METRICS_SIZE; j++) {
    for (let i = 0; i < METRICS_SIZE; i++) {
      scan[j * METRICS_SIZE + i] = sample(-half + i * step, -half + j * step);
    }
  }
  const sorted = scan.slice().sort();
  const q = (p: number): number => sorted[Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1)))];
  return bandMetrics(sample, {
    stops: [q(25), q(75), q(97)],
    size: METRICS_SIZE,
    extent: METRICS_EXTENT,
    wind: SEA_WIND,
  });
}
