import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FBM,
  FBM_GRADIENTS,
  fbmBandMetrics,
  fbmBandShape,
  fbmCrest,
  fbmRidgeField,
  hash01,
  latticeNoise,
  maxHashSeed,
  SEA_WIND,
  seaBandSourceFromQuery,
  seaDebugFromQuery,
  fbmOctaveWeight,
  fbmWeightedRidge,
} from './sea-fbm';
import { SEA_BAND_STOPS_FBM } from './sea-fft';
import { bandMetrics } from './sea-metrics';

/**
 * Task 1 of the sea FBM band-continuity plan: the ridged, wind-anisotropic,
 * domain-warped band field, mirrored bit-for-bit between TS and (Task 2) TSL.
 *
 * The gates below are the plan's acceptance list for Task 1. The core gate is
 * fbmBandMetrics().edgeCoherence >= 0.85 — the whole reason this module exists.
 */

describe('sea-fbm — determinism & range', () => {
  it('is bit-identical for the same seed and coordinates', () => {
    const a = fbmRidgeField(123.4, -567.8, 0);
    const b = fbmRidgeField(123.4, -567.8, 0);
    expect(Object.is(a, b)).toBe(true);
  });

  it('changes with the seed', () => {
    const a = fbmRidgeField(123.4, -567.8, 0);
    const b = fbmRidgeField(123.4, -567.8, 0, { ...DEFAULT_FBM, seed: DEFAULT_FBM.seed + 1 });
    expect(Object.is(a, b)).toBe(false);
  });

  it('stays finite and in range over time and huge coordinates', () => {
    for (const t of [0, 0.001, 1, 60, 1e4]) {
      for (const [x, z] of [
        [0, 0],
        [1e3, -2e3],
        [1e6, 1e6],
        [-1e7, 5e6],
      ]) {
        const v = fbmRidgeField(x, z, t);
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(-0.01);
        expect(v).toBeLessThanOrEqual(1.01);
        const s = fbmBandShape(v, x, z, t);
        expect(Number.isFinite(s)).toBe(true);
      }
    }
  });

  it('keeps the band breathing within ±0.03 of the ridge field', () => {
    for (const [x, z] of [
      [17.3, -42.7],
      [-1e4, 2.5e3],
    ]) {
      const r = fbmRidgeField(x, z, 0);
      const s = fbmBandShape(r, x, z, 0);
      expect(Math.abs(s - r)).toBeLessThanOrEqual(0.030001);
    }
  });
});

describe('sea-fbm — float32 mirror integrity', () => {
  it('hash01 matches an independent BigInt PCG reference bit-for-bit', () => {
    // BigInt path shares no arithmetic with the Math.imul implementation.
    const ref = (seed: number): number => {
      let state = (BigInt(seed >>> 0) * 747796405n + 2891336453n) & 0xffffffffn;
      const shift = Number(state >> 28n) + 4;
      let word = ((state >> BigInt(shift)) ^ state) & 0xffffffffn;
      word = (word * 277803737n) & 0xffffffffn;
      const result = ((word >> 22n) ^ word) & 0xffffffffn;
      // TSL.hash does result.toFloat().mul(1/2^32): the uint is rounded to f32 first.
      return Math.fround(Number(result)) * 2 ** -32;
    };
    for (const seed of [0, 1, 2, 1337, 65535, 8388607, 8716289]) {
      expect(Object.is(hash01(seed), ref(seed))).toBe(true);
    }
  });

  it('gradient table values are exactly representable in float32', () => {
    expect(FBM_GRADIENTS.length).toBe(32);
    for (let i = 0; i < 32; i++) {
      expect(Object.is(FBM_GRADIENTS[i], Math.fround(FBM_GRADIENTS[i]))).toBe(true);
    }
  });

  it('keeps the packed hash seed below 2^24 for the default config', () => {
    expect(DEFAULT_FBM.cells).toBeLessThanOrEqual(2048); // N <= 2^11
    expect(maxHashSeed(DEFAULT_FBM)).toBeLessThan(2 ** 24);
  });

  it('lattice noise keeps the wrap identity for f32-exact coordinates', () => {
    const N = DEFAULT_FBM.cells;
    // dyadic coordinates stay f32-exact at both magnitudes, so the fractional
    // parts match bit-for-bit and only the wrapped cell index differs — this
    // pins the mechanism (wrap(N) ≡ wrap(0) hash identity).
    for (const [qx, qy] of [
      [3.25, -8.75],
      [100.5, 0.25],
    ]) {
      const base = latticeNoise(qx, qy, 0, N);
      expect(Object.is(latticeNoise(qx + N, qy, 0, N), base)).toBe(true);
      expect(Object.is(latticeNoise(qx, qy + N, 0, N), base)).toBe(true);
    }
  });

  it('lattice noise is C0 across the wrap boundary (no seam step)', () => {
    const N = DEFAULT_FBM.cells;
    // plan Task 1 acceptance: the sampling difference across a cell border is
    // bounded by the local gradient step — no staircase at the wrap line.
    for (const qy of [3.27, -8.91, 100.5]) {
      for (const eps of [1e-3, 1e-2]) {
        const inside = latticeNoise(N - eps, qy, 0, N);
        const outside = latticeNoise(-eps, qy, 0, N);
        // same wrapped cell, same gradients; only the f32 coordinate rounding
        // differs, so the values must agree to well within a gradient step
        expect(Math.abs(inside - outside)).toBeLessThan(0.01);
      }
    }
  });
});

describe('sea-fbm — the continuity gate', () => {
  it(
    'edgeCoherence >= 0.85 on the default config (the core gate)',
    () => {
      const m = fbmBandMetrics();
      const sum = m.occupancy.reduce((a, b) => a + b, 0);
      expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
      expect(m.edgeCoherence).toBeGreaterThanOrEqual(0.85);
    },
    30_000,
  );

  it(
    'does not collapse into layer cake as octaves grow 2 -> 4',
    () => {
      const m2 = fbmBandMetrics({ ...DEFAULT_FBM, octaves: 2 });
      const m4 = fbmBandMetrics();
      expect(m2.edgeCoherence).toBeGreaterThanOrEqual(0.8);
      expect(m4.edgeCoherence).toBeGreaterThanOrEqual(m2.edgeCoherence - 0.1);
    },
    30_000,
  );
});

describe('sea-fbm — crest & wind', () => {
  it('crest strength is 0 below the start and ramps monotonically to 1', () => {
    let prev = -1;
    for (let r = 0; r <= 1.0001; r += 0.01) {
      const c = fbmCrest(r);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
      expect(c).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = c;
      if (r < 0.8) expect(c).toBe(0);
    }
    expect(fbmCrest(1)).toBe(1);
  });

  it('exports the shared wind basis used by SEA_STROKE', () => {
    const len = Math.hypot(SEA_WIND[0], SEA_WIND[1]);
    expect(Math.abs(len - 1)).toBeLessThan(1e-6);
    expect(SEA_WIND[0]).toBeCloseTo(0.8211, 3);
  });
});

describe('sea-fbm — performance', () => {
  it(
    'evaluates a 1024x1024 grid in under 2 s (<2 us per point)',
    () => {
      const n = 1024;
      const step = 400 / n;
      const t0 = performance.now();
      let acc = 0;
      for (let j = 0; j < n; j++) {
        const z = j * step;
        for (let i = 0; i < n; i++) {
          acc += fbmRidgeField(i * step, z, 0);
        }
      }
      const dt = performance.now() - t0;
      expect(Number.isFinite(acc)).toBe(true);
      expect(dt).toBeLessThan(2000);
    },
    30_000,
  );
});

describe('fbmWeightedRidge — the all-faded fallback', () => {
  it('falls back to the coarsest octave when every weight fades to zero', () => {
    // 全淡出时 norm=0 → 0/0=NaN。地平线附近可达（60 m/px @ alt 7 / 60 deg fov 约 512 m）。
    const ridge = fbmWeightedRidge([0.7, 0.2, 0.1], [0, 0, 0]);
    expect(Number.isNaN(ridge)).toBe(false);
    expect(ridge).toBeCloseTo(0.7, 6);
  });

  it('normalises normally when weights are present', () => {
    expect(fbmWeightedRidge([1, 0], [0.5, 0.5])).toBeCloseTo(0.5, 6);
  });

  it('survives empty input without NaN', () => {
    expect(Number.isNaN(fbmWeightedRidge([], []))).toBe(false);
  });
});

describe('fbmOctaveWeight — per-octave footprint fade (plan Task 3)', () => {
  it('passes low frequencies untouched and kills high ones', () => {
    expect(fbmOctaveWeight(0, 1)).toBe(1); // f_i * footprint = 0 -> full weight
    expect(fbmOctaveWeight(0.1, 1)).toBeCloseTo(1, 6);
    expect(fbmOctaveWeight(1, 1)).toBe(0); // far past the fade end
    expect(fbmOctaveWeight(10, 1)).toBe(0);
  });

  it('is the smoothstep window (0.25, 0.6)', () => {
    expect(fbmOctaveWeight(0.25, 1)).toBeCloseTo(1, 6);
    expect(fbmOctaveWeight(0.6, 1)).toBeCloseTo(0, 6);
    expect(fbmOctaveWeight(0.425, 1)).toBeCloseTo(0.5, 3); // midpoint of the ramp
  });

  it('is monotone non-increasing in frequency and in footprint', () => {
    let prev = 1;
    for (let i = 0; i <= 40; i++) {
      const w = fbmOctaveWeight(i / 20, 1);
      expect(w).toBeLessThanOrEqual(prev + 1e-12);
      prev = w;
    }
    let prevF = 1;
    for (let fp = 0.05; fp <= 3; fp += 0.05) {
      const w = fbmOctaveWeight(0.4, fp);
      expect(w).toBeLessThanOrEqual(prevF + 1e-12);
      prevF = w;
    }
  });

  it('fades the fast (across-wind) octave ladder: octave 3 dies before octave 0', () => {
    const acrossLength = DEFAULT_FBM.acrossLength;
    const lac = DEFAULT_FBM.lacunarity;
    const footprint = 8; // a pixel covers 8 m at mid distance
    const w0 = fbmOctaveWeight(lac ** 0 / acrossLength, footprint);
    const w3 = fbmOctaveWeight(lac ** 3 / acrossLength, footprint);
    // octave 0: freq 0.01/m x 8 m = 0.08 -> inside the passband
    expect(w0).toBe(1);
    // octave 3: freq 0.0686/m x 8 m = 0.549 -> inside the fade window
    expect(w3).toBeLessThan(0.5);
  });
});

describe('Task 4 — band stops hit 25/50/23/2 on the composite field', () => {
  // The composite the shader actually cuts: clamp(bandShape + 0.15*(hNorm-0.5)).
  // hNorm rides the FFT height field, so this test rebuilds both cascade
  // surfaces exactly like applyTexture does (exported, deterministic) and
  // bilinear-samples them on a world grid.
  const EXTENT = 1200;
  const GRID = 220;

  function sampleComposite(x: number, z: number, surfaces: { hs: any; rs: any; hz: any; rz: any }): number {
    const sampleWrap = (field: Float32Array, n: number, patch: number): number => {
      const u = (((x / patch) % 1) + 1) % 1;
      const v = (((z / patch) % 1) + 1) % 1;
      const fx = u * n;
      const fz = v * n;
      const i0 = Math.floor(fx);
      const j0 = Math.floor(fz);
      const fu = fx - i0;
      const fv = fz - j0;
      const i1 = (i0 + 1) % n;
      const j1 = (j0 + 1) % n;
      const a = field[j0 * n + i0] * (1 - fu) * (1 - fv) + field[j0 * n + i1] * fu * (1 - fv);
      const b = field[j1 * n + i0] * (1 - fu) * fv + field[j1 * n + i1] * fu * fv;
      return a + b;
    };
    const h = sampleWrap(surfaces.hs, 128, 400) + sampleWrap(surfaces.hz, 128, 2048);
    const hNorm = Math.min(Math.max(h * 0.62 + 0.5, 0), 1);
    const band = fbmBandShape(fbmRidgeField(x, z, 0), x, z, 0);
    return Math.min(Math.max(band + (hNorm - 0.5) * 0.15, 0), 1);
  }

  it(
    'SEA_BAND_STOPS sit at the composite p25/p75/p98 (crest ~2%)',
    async () => {
      // rebuild the two cascade fields the way sea-fft's applyTexture does
      const { buildPhillipsSpectrum, seaSurface, SEA_CASCADES, SEA_VARIANCE_SPLIT, DEFAULT_SEA, SEA_LONG_SEED_SALT } =
        await import('./sea-fft');
      const surfaces: any = {};
      for (const c of SEA_CASCADES) {
        const amp = DEFAULT_SEA.amplitude * Math.sqrt(c.weight / 1.0);
        const spec = buildPhillipsSpectrum({
          ...DEFAULT_SEA,
          patchSize: c.patch,
          windSpeed: c.wind,
          amplitude: DEFAULT_SEA.amplitude * Math.sqrt(c.weight / (SEA_VARIANCE_SPLIT * 1.0 + (1 - SEA_VARIANCE_SPLIT))),
          seed: (DEFAULT_SEA.seed ^ c.salt) >>> 0,
        });
        const out = new Float32Array(spec.n * spec.n * 4);
        seaSurface(spec, 0, out);
        const h = new Float32Array(spec.n * spec.n);
        for (let i = 0; i < h.length; i++) h[i] = out[i * 4];
        if (c.patch === 400) {
          surfaces.hs = h;
        } else {
          surfaces.hz = h;
        }
      }
      void SEA_LONG_SEED_SALT;

      const values = new Float64Array(GRID * GRID);
      for (let j = 0; j < GRID; j++) {
        for (let i = 0; i < GRID; i++) {
          values[j * GRID + i] = sampleComposite(
            -EXTENT / 2 + (i / (GRID - 1)) * EXTENT,
            -EXTENT / 2 + (j / (GRID - 1)) * EXTENT,
            surfaces,
          );
        }
      }
      const sorted = Float64Array.from(values).sort();
      const q = (p: number): number => sorted[Math.round((p / 100) * (sorted.length - 1))];
      const [s0, s1, s2] = SEA_BAND_STOPS_FBM;
      // occupancy at the shipped stops
      let deep = 0, mid = 0, lit = 0, crest = 0;
      for (let k = 0; k < values.length; k++) {
        const v = values[k];
        if (v < s0) deep++;
        else if (v < s1) mid++;
        else if (v < s2) lit++;
        else crest++;
      }
      const occ = [deep, mid, lit, crest].map((c) => c / values.length);
      const target = [0.25, 0.5, 0.23, 0.02];
      const measured = {
        quantiles: [q(25), q(75), q(98)].map((v) => +v.toFixed(4)),
        stops: [s0, s1, s2],
        occupancy: occ.map((v) => +v.toFixed(4)),
      };
      console.log('Task 4 calibration:', JSON.stringify(measured));
      for (let b = 0; b < 4; b++) {
        expect(Math.abs(occ[b] - target[b])).toBeLessThan(0.05);
      }
      // crest must actually exist (the old field's 6-sigma ghost)
      expect(crest).toBeGreaterThan(0);
    },
    120_000,
  );
});

describe('ridged variant warp input (review I4)', () => {
  it('stays finite and in range with the post-warp lattice feed', () => {
    // TS 之前把 pre-warp 的 u,v 喂给下一层，TSL 喂的是 post-warp 的 qx,qy，
    // 所以 variant='ridged' 从第 2 层起两边描述的是不同的场。修完这条至少钉住
    // TS 侧不崩、值域不变（TSL 侧由 readback 探针覆盖）。
    const cfg = { ...DEFAULT_FBM, variant: 'ridged' as const };
    const points: [number, number][] = [[0, 0], [37, -82], [203.5, 148.25], [-64.75, -201.5]];
    for (const [x, z] of points) {
      const v = fbmRidgeField(x, z, 0, cfg);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(-1e-6);
      expect(v).toBeLessThanOrEqual(1 + 1e-6);
    }
  });
});

describe('far-field occupancy drift (review I2)', () => {
  it('the near-field calibration is not the far-field histogram', () => {
    // Task 4 的 stops 是在 footprint=0（未淡出）上标的。着色器永远带 footprint，
    // 所以几百米外只剩 octave 0，直方图会漂——这条把漂移量钉成数字，防止
    // 「占比精确 25/50/23/2」被当成全场景性质。
    const stops = [0.1726, 0.5458, 0.8327];
    const sampleAt = (footprint: number) => (x: number, z: number): number =>
      Math.min(Math.max(fbmBandShape(fbmRidgeField(x, z, 0, DEFAULT_FBM, footprint), x, z, 0), 0), 1);

    const near = bandMetrics(sampleAt(0), { stops, size: 256, extent: 1024, wind: SEA_WIND });
    const far = bandMetrics(sampleAt(80), { stops, size: 256, extent: 1024, wind: SEA_WIND });

    // 近场：标定口径，crest 在 2% 附近
    expect(near.occupancy[3]).toBeLessThan(0.05);
    // 远处：淡出到只剩最粗一级，crest 变多（评审估 ~10.7%）
    expect(far.occupancy[3]).toBeGreaterThan(near.occupancy[3]);
    // 但不该失控成一片白
    expect(far.occupancy[3]).toBeLessThan(0.25);
  });
});

describe('createFbmBandGraph — octave override (plan Task 5 quality drop)', () => {
  it('builds with a reduced octave count when overridden', async () => {
    const TSL = await import('three/tsl');
    const { createFbmBandGraph } = await import('./sea-fft');
    const g4 = createFbmBandGraph(TSL);
    const g2 = createFbmBandGraph(TSL, { octaves: 2 });
    expect(g4.octaves).toBe(DEFAULT_FBM.octaves);
    expect(g2.octaves).toBe(2);
  });

  it('exposes the octave count on the graph', async () => {
    const TSL = await import('three/tsl');
    const { createFbmBandGraph } = await import('./sea-fft');
    const g = createFbmBandGraph(TSL, { octaves: 3 });
    expect(g.octaves).toBe(3);
  });
});

describe('seaBandSourceFromQuery — QA switch (plan Task 2)', () => {
  it('selects fbm explicitly', () => {
    expect(seaBandSourceFromQuery('?sea=fbm')).toBe('fbm');
    expect(seaBandSourceFromQuery('?backend=webgl2&sea=fbm')).toBe('fbm');
  });

  it('selects fft explicitly', () => {
    expect(seaBandSourceFromQuery('?sea=fft')).toBe('fft');
  });

  it('defaults to fft when the parameter is absent (rollback = do nothing)', () => {
    expect(seaBandSourceFromQuery('')).toBe('fft');
    expect(seaBandSourceFromQuery('?alt=60')).toBe('fft');
  });

  it('falls back to fft on any other value', () => {
    expect(seaBandSourceFromQuery('?sea=nonsense')).toBe('fft');
    expect(seaBandSourceFromQuery('?sea=')).toBe('fft');
  });
});

describe('seaDebugFromQuery — flat band debug view (Task 2 screenshot gate)', () => {
  it('turns on only for ?sea-debug=shape', () => {
    expect(seaDebugFromQuery('?sea-debug=shape')).toBe(true);
    expect(seaDebugFromQuery('?sea=fbm&sea-debug=shape')).toBe(true);
  });

  it('defaults to off', () => {
    expect(seaDebugFromQuery('')).toBe(false);
    expect(seaDebugFromQuery('?sea=fbm')).toBe(false);
    expect(seaDebugFromQuery('?sea-debug=nonsense')).toBe(false);
  });
});
