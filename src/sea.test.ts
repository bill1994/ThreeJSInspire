import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { SEA_PALETTE } from './palettes';
import { initSea as initSeaFft } from './sea-fft';
import {
  DEFAULT_SEA,
  SEA_LONG_PATCH,
  SEA_LONG_WIND,
  SEA_VARIANCE_SPLIT,
  SEA_FOLLOW_STEP,
  buildPhillipsSpectrum,
  evolveTo,
  fft2d,
  seaSurface,
  finiteSpectrumStats,
  floatToHalf,
  halfToFloat,
  measureRmsHeight,
  seaDomainAmplitudes,
  seaSurfaceToHalf,
  seaUv,
  type SeaConfig,
  type Spectrum,
} from './sea-fft';

const SMALL: SeaConfig = { ...DEFAULT_SEA, fftSize: 32 };

/** Sweep of times used to prove the time evolution never produces NaN/Inf. */
const TIME_SWEEP = [0, 0.001, 0.25, 1, 3.7, 17.5, 60, 600, 1e4, 1e6];

function complexArray(n: number): { re: Float32Array; im: Float32Array } {
  return { re: new Float32Array(n * n), im: new Float32Array(n * n) };
}

describe('floatToHalf / halfToFloat', () => {
  it('round-trips exactly representable values', () => {
    for (const v of [0, 1, -1, 0.5, -0.5, 2, 0.25, -2.5, 0.0625]) {
      const bits = floatToHalf(v);
      expect(Number.isFinite(bits), `bits for ${v}`).toBe(true);
      expect(halfToFloat(bits)).toBeCloseTo(v, 6);
    }
  });

  it('keeps |v| <= 1.5 within 1e-3 (sea texture channel range)', () => {
    for (let i = 0; i <= 200; i++) {
      const v = -1.5 + (3 * i) / 200;
      const back = halfToFloat(floatToHalf(v));
      expect(Math.abs(back - v)).toBeLessThan(1e-3);
    }
  });
});

describe('buildPhillipsSpectrum', () => {
  it('produces finite amplitudes with a zero DC term', () => {
    const spec = buildPhillipsSpectrum(SMALL);
    const n = spec.n;
    for (const a of [spec.re, spec.im, spec.omega]) {
      expect(finiteSpectrumStats(a).finite).toBe(true);
    }
    expect(spec.re[0]).toBe(0);
    expect(spec.im[0]).toBe(0);
    expect(spec.omega[0]).toBe(0);
  });

  it('has strictly non-negative deep-water dispersion omega', () => {
    const spec = buildPhillipsSpectrum(SMALL);
    for (let i = 0; i < spec.omega.length; i++) {
      expect(spec.omega[i]).toBeGreaterThanOrEqual(0);
    }
  });

  it('carries real energy and reports the true peak mode magnitude', () => {
    const spec = buildPhillipsSpectrum(SMALL);
    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < spec.re.length; i++) {
      const mag = Math.hypot(spec.re[i], spec.im[i]);
      sumSq += mag * mag;
      peak = Math.max(peak, mag);
    }
    // pattern: the spectrum must not be empty, and the advertised clamp must
    // actually equal the largest stored mode (guards a stale/mis-scaled bound).
    expect(sumSq).toBeGreaterThan(0);
    expect(peak).toBeCloseTo(spec.amplitudeClamp, 5);
    expect(spec.n).toBe(SMALL.fftSize);
  });

  it('is deterministic for a fixed seed', () => {
    const a = buildPhillipsSpectrum(SMALL);
    const b = buildPhillipsSpectrum(SMALL);
    expect(Array.from(a.re.slice(0, 64))).toEqual(Array.from(b.re.slice(0, 64)));
    expect(Array.from(a.im.slice(0, 64))).toEqual(Array.from(b.im.slice(0, 64)));
  });

  it('changes when the seed changes', () => {
    const a = buildPhillipsSpectrum(SMALL);
    const b = buildPhillipsSpectrum({ ...SMALL, seed: SMALL.seed + 1 });
    expect(Array.from(a.re.slice(0, 64))).not.toEqual(Array.from(b.re.slice(0, 64)));
  });
});

describe('evolveTo', () => {
  it('stays finite across a swept time range', () => {
    const spec: Spectrum = buildPhillipsSpectrum(SMALL);
    const out = complexArray(spec.n);
    for (const t of TIME_SWEEP) {
      evolveTo(spec, t, out.re, out.im);
      expect(finiteSpectrumStats(out.re).finite, `re @ t=${t}`).toBe(true);
      expect(finiteSpectrumStats(out.im).finite, `im @ t=${t}`).toBe(true);
    }
  });

  it('is well defined and non-trivial at t=0', () => {
    const spec = buildPhillipsSpectrum(SMALL);
    const out = complexArray(spec.n);
    evolveTo(spec, 0, out.re, out.im);
    expect(finiteSpectrumStats(out.re).finite).toBe(true);
    expect(finiteSpectrumStats(out.re).maxAbs).toBeGreaterThan(0);
  });
});

describe('fft2d', () => {
  it('inverts a forward transform (round-trip identity)', () => {
    const n = 16;
    const { re, im } = complexArray(n);
    const origRe = new Float32Array(re.length);
    const origIm = new Float32Array(im.length);
    for (let i = 0; i < re.length; i++) {
      origRe[i] = Math.sin(i * 0.37) + Math.cos(i * 0.11);
      origIm[i] = Math.sin(i * 0.05) - 0.3;
      re[i] = origRe[i];
      im[i] = origIm[i];
    }
    fft2d(re, im, n, false);
    fft2d(re, im, n, true);
    for (let i = 0; i < re.length; i++) {
      expect(re[i]).toBeCloseTo(origRe[i], 4);
      expect(im[i]).toBeCloseTo(origIm[i], 4);
    }
  });

  it('transforms a pure single-mode signal to a single spectral spike', () => {
    const n = 8;
    const { re, im } = complexArray(n);
    // re(x) = cos(2*pi*(x0*1)/n) -> energy must land on k index 1 only
    for (let z = 0; z < n; z++) {
      for (let x = 0; x < n; x++) {
        re[z * n + x] = Math.cos((2 * Math.PI * x) / n);
      }
    }
    fft2d(re, im, n, false);
    expect(Math.hypot(re[1], im[1])).toBeGreaterThan(1e-3);
    expect(Math.hypot(re[0], im[0])).toBeLessThan(1e-4);
    expect(Math.hypot(re[3], im[3])).toBeLessThan(1e-4);
  });
});

describe('seaSurface', () => {
  it('produces an all-finite RGBA field across a swept time range', () => {
    const spec = buildPhillipsSpectrum(SMALL);
    const out = new Float32Array(spec.n * spec.n * 4);
    for (const t of TIME_SWEEP) {
      seaSurface(spec, t, out);
      const stats = finiteSpectrumStats(out);
      expect(stats.finite, `t=${t}`).toBe(true);
      expect(stats.maxAbs).toBeLessThan(1e4);
    }
  });

  it('keeps heights bounded by the configured amplitude envelope', () => {
    const spec = buildPhillipsSpectrum(SMALL);
    const out = new Float32Array(spec.n * spec.n * 4);
    const bound = SMALL.amplitude * 6;
    for (const t of [0, 1, 5, 30]) {
      seaSurface(spec, t, out);
      for (let i = 0; i < spec.n * spec.n; i++) {
        const h = out[i * 4];
        expect(Math.abs(h)).toBeLessThanOrEqual(bound);
      }
    }
  });

  it('emits unit-length horizontal normals and clamped foam', () => {
    const spec = buildPhillipsSpectrum(SMALL);
    const out = new Float32Array(spec.n * spec.n * 4);
    seaSurface(spec, 2.5, out);
    for (let i = 0; i < spec.n * spec.n; i++) {
      const nx = out[i * 4 + 1];
      const nz = out[i * 4 + 2];
      const foam = out[i * 4 + 3];
      expect(Math.abs(nx)).toBeLessThanOrEqual(1.0001);
      expect(Math.abs(nz)).toBeLessThanOrEqual(1.0001);
      expect(foam).toBeGreaterThanOrEqual(0);
      expect(foam).toBeLessThanOrEqual(1);
    }
  });

  it('actually moves between two times', () => {
    const spec = buildPhillipsSpectrum(SMALL);
    const a = new Float32Array(spec.n * spec.n * 4);
    const b = new Float32Array(spec.n * spec.n * 4);
    seaSurface(spec, 0, a);
    seaSurface(spec, 1.7, b);
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
    expect(diff).toBeGreaterThan(1e-3);
  });

  it('seaSurfaceToHalf packs a finite half-float texture', () => {
    const spec = buildPhillipsSpectrum(SMALL);
    const f = new Float32Array(spec.n * spec.n * 4);
    const half = new Uint16Array(spec.n * spec.n * 4);
    seaSurface(spec, 3, f);
    seaSurfaceToHalf(f, half);
    expect(half.length).toBe(f.length);
    for (let i = 0; i < half.length; i += 97) {
      expect(Number.isFinite(halfToFloat(half[i]))).toBe(true);
    }
  });
});

describe('sea palette', () => {
  it('shares one palette with the TSL path', () => {
    // `sea-fft.ts` renders from exactly these constants, so the two backends
    // cannot drift apart into different sunsets.
    expect(Object.keys(SEA_PALETTE).sort()).toEqual([
      'crest',
      'deep',
      'foam',
      'glitter',
      'haze',
      'lit',
      'mid',
    ]);
    for (const hex of Object.values(SEA_PALETTE)) {
      expect(Number.isInteger(hex)).toBe(true);
      expect(hex).toBeGreaterThanOrEqual(0);
      expect(hex).toBeLessThanOrEqual(0xffffff);
    }
  });
});

describe('sea (webgpu FFT path)', () => {
  it('tessellates the 1600 m patch finely enough for the near field', async () => {
    // 8 m quads (150 segments) sampled the displaced height field as visible bulges in the
    // 30-100 m band. The patch grew from 1200 m to 1600 m so the haze ramp could reach 520 m
    // without a seam; the segment count grew with it, keeping the near-field quad at 5.7 m
    // (was 5 m at 240 segments) instead of letting it drift out to 6.7 m.
    const scene = new THREE.Scene();
    const sea = await initSeaFft(scene, 'webgpu');
    expect(sea.kind).toBe('fft');

    const mesh = scene.children.find((child) => child.name === 'sea-fft') as THREE.Mesh;
    expect(mesh).toBeDefined();
    expect(mesh.position.y).toBe(0);

    const params = (mesh.geometry as THREE.PlaneGeometry).parameters;
    expect(params.width).toBe(1600);
    expect(params.height).toBe(1600);
    expect(params.widthSegments).toBe(280);
    expect(params.heightSegments).toBe(280);

    sea.dispose();
    expect(scene.children.length).toBe(0);
  });
});
describe('two-domain variance split (review §2.2 B4-1)', () => {
  it('splits the target RMS by variance so the two domains cannot double-count', () => {
    // 各域归一到同一个 amplitude 会合成 √2 倍；varianceSplit 按方差拆分后，
    // √(short² + long²) 必须精确等于总量（解析上），离散化误差另测。
    const amps = seaDomainAmplitudes(0.34, SEA_VARIANCE_SPLIT);
    expect(Math.hypot(amps.short, amps.long)).toBeCloseTo(0.34, 12);
    expect(amps.short).toBeGreaterThan(amps.long); // split > 0.5 时短波占大头
    expect(seaDomainAmplitudes(Number.NaN, 0.5)).toEqual({ short: 0, long: 0 });
    expect(seaDomainAmplitudes(0.34, Number.NaN)).toEqual({ short: 0, long: 0 });
    expect(seaDomainAmplitudes(0.34, 1.7).long).toBeCloseTo(0, 12); // 夹到 [0,1]
    expect(seaDomainAmplitudes(0.34, -0.2).short).toBeCloseTo(0, 12);
  });

  it('lands the combined field RMS within ±10% of the configured amplitude', () => {
    // 离散化的两个独立随机场按方差合成：这是「不许双计」的实测量。
    const amps = seaDomainAmplitudes(DEFAULT_SEA.amplitude, SEA_VARIANCE_SPLIT);
    const shortSpec = buildPhillipsSpectrum({ ...DEFAULT_SEA, patchSize: 400, amplitude: amps.short });
    const longSpec = buildPhillipsSpectrum({
      ...DEFAULT_SEA,
      patchSize: 2048,
      windSpeed: SEA_LONG_WIND,
      amplitude: amps.long,
    });
    const combined = Math.hypot(measureRmsHeight(shortSpec), measureRmsHeight(longSpec));
    expect(Math.abs(combined - DEFAULT_SEA.amplitude)).toBeLessThanOrEqual(DEFAULT_SEA.amplitude * 0.1);
  });

  it('carries a long-swell domain whose rows the 400 m field cannot make', () => {
    // 长涌浪排的谱峰要在百米级：2πv²/g ≈ 185 m @ v=17，落在 2048 m 域内约 11 个周期。
    expect(SEA_LONG_PATCH).toBeGreaterThan(1000);
    expect(SEA_LONG_WIND).toBeGreaterThan(10);
    const amps = seaDomainAmplitudes(DEFAULT_SEA.amplitude, SEA_VARIANCE_SPLIT);
    const longSpec = buildPhillipsSpectrum({
      ...DEFAULT_SEA,
      patchSize: SEA_LONG_PATCH,
      windSpeed: SEA_LONG_WIND,
      amplitude: amps.long,
    });
    expect(measureRmsHeight(longSpec)).toBeGreaterThan(0);
  });
});

describe('world-space UV (review §2.2 B4-2)', () => {
  it('samples from world coordinates only, so highlights never ride the mesh', () => {
    // UV 只吃世界坐标：mesh 平移任意量（不只是整周期 snap）都不改变采样。
    const [u, v] = seaUv(1234.5, -777.25, SEA_FOLLOW_STEP);
    expect(u).toBeCloseTo(1234.5 / SEA_FOLLOW_STEP, 12);
    expect(v).toBeCloseTo(-777.25 / SEA_FOLLOW_STEP, 12);
  });

  it('keeps the whole-period snap phase-aligned for the short domain', () => {
    // far-field 的 snapToPeriod 平移整周期后相位不变 —— 短域接缝依旧无缝。
    const a = seaUv(3100, -50, SEA_FOLLOW_STEP);
    const b = seaUv(3100 + SEA_FOLLOW_STEP, -50 - SEA_FOLLOW_STEP, SEA_FOLLOW_STEP);
    expect((b[0] - a[0]) % 1).toBeCloseTo(0, 12);
    expect((b[1] - a[1]) % 1).toBeCloseTo(0, 12);
  });

  it('refuses non-finite or non-positive periods instead of sampling garbage', () => {
    expect(seaUv(Number.NaN, 0, 400)).toEqual([0, 0]);
    expect(seaUv(0, Number.POSITIVE_INFINITY, 400)).toEqual([0, 0]);
    expect(seaUv(10, 10, 0)).toEqual([0, 0]);
    expect(seaUv(10, 10, -5)).toEqual([0, 0]);
  });
});
