import { describe, expect, it } from 'vitest';
import { bandMetrics } from './sea-metrics';

/**
 * Task 0 of the sea FBM band-continuity plan: the defect "band edges read as
 * broken patches" must become numbers before any FBM code exists.
 *
 * The fixtures are analytic fields whose edge geometry is known in closed form,
 * so every metric is pinned to a value we can derive on paper:
 * - parallel stripes  -> edges run along the wind  -> coherence ~1, curvature ~0
 * - concentric rings  -> edges are circles         -> coherence ~0, curvature = 1/r
 * - seeded blobs      -> isotropic patches         -> low coherence
 */

const EXTENT = 100;
const SIZE = 256;

/** Triangle wave in the across-wind coordinate, period `wavelength`, range 0..1. */
function stripes(wind: [number, number], wavelength: number): (x: number, z: number) => number {
  const len = Math.hypot(wind[0], wind[1]) || 1;
  const px = wind[0] / len;
  const pz = wind[1] / len;
  const qx = -pz;
  const qz = px;
  return (x: number, z: number) => {
    const c = x * qx + z * qz;
    const t = (((c / wavelength) % 1) + 1) % 1;
    return t < 0.5 ? t * 2 : 2 - t * 2;
  };
}

/** Concentric rings around the origin: f = r / (EXTENT/2). Stops at r/50. */
function rings(): (x: number, z: number) => number {
  return (x: number, z: number) => Math.hypot(x, z) / (EXTENT / 2);
}

/** Isotropic smooth blob field: seeded sum of random-direction cosine waves. */
function blobs(seed: number): (x: number, z: number) => number {
  let s = seed >>> 0;
  const rand = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const waves: { kx: number; kz: number; phase: number; amp: number }[] = [];
  let norm = 0;
  for (let i = 0; i < 24; i++) {
    const ang = rand() * Math.PI * 2;
    const periods = 1 + rand() * 5;
    const freq = (periods * Math.PI * 2) / EXTENT;
    const amp = 0.2 + rand();
    norm += amp;
    waves.push({
      kx: Math.cos(ang) * freq,
      kz: Math.sin(ang) * freq,
      phase: rand() * Math.PI * 2,
      amp,
    });
  }
  return (x: number, z: number) => {
    let v = 0;
    for (const w of waves) v += w.amp * Math.cos(w.kx * x + w.kz * z + w.phase);
    return v / (2 * norm) + 0.5;
  };
}

const STOPS = [0.25, 0.5, 0.75] as const;

describe('bandMetrics — parallel stripes (edges along the wind)', () => {
  it('reads near-perfect coherence and zero curvature for wind along +x', () => {
    const m = bandMetrics(stripes([1, 0], 20), {
      stops: STOPS,
      size: SIZE,
      extent: EXTENT,
      wind: [1, 0],
    });
    expect(m.edgeCoherence).toBeGreaterThan(0.9);
    expect(m.edgeCurvature).toBeLessThan(0.02);
    // triangle wave with 3 stops crosses 6 times per 20 m period -> median gap 2.5 m
    expect(Math.abs(m.edgeSpacing - 2.5)).toBeLessThan(0.5);
    // top band (above 0.75) is one 5 m-wide strip per period, running the full window
    expect(m.extentAlongWind).toBeGreaterThan(90);
    expect(m.componentsPer100m2).toBeGreaterThan(0.02);
    expect(m.componentsPer100m2).toBeLessThan(0.1);
  });

  it('is rotation invariant: diagonal wind gives the same coherence', () => {
    const a = bandMetrics(stripes([1, 0], 20), {
      stops: STOPS,
      size: SIZE,
      extent: EXTENT,
      wind: [1, 0],
    });
    const b = bandMetrics(stripes([0.82, -0.57], 20), {
      stops: STOPS,
      size: SIZE,
      extent: EXTENT,
      wind: [0.82, -0.57],
    });
    expect(b.edgeCoherence).toBeGreaterThan(0.9);
    expect(Math.abs(a.edgeCoherence - b.edgeCoherence)).toBeLessThan(0.1);
  });
});

describe('bandMetrics — concentric rings (edges are circles)', () => {
  it('reads near-zero coherence and curvature 1/r', () => {
    const m = bandMetrics(rings(), {
      stops: STOPS,
      size: SIZE,
      extent: EXTENT,
      wind: [1, 0],
    });
    expect(m.edgeCoherence).toBeLessThan(0.15);
    // rings at r = 12.5 / 25 / 37.5 m; circumference-weighted mean curvature is 3/75 = 0.04
    expect(m.edgeCurvature).toBeGreaterThan(0.03);
    expect(m.edgeCurvature).toBeLessThan(0.05);
  });
});

describe('bandMetrics — seeded blobs (isotropic patches)', () => {
  it('reads low coherence, well below the stripe fixture', () => {
    const m = bandMetrics(blobs(1337), {
      stops: STOPS,
      size: SIZE,
      extent: EXTENT,
      wind: [1, 0],
    });
    const stripesM = bandMetrics(stripes([1, 0], 20), {
      stops: STOPS,
      size: SIZE,
      extent: EXTENT,
      wind: [1, 0],
    });
    expect(m.edgeCoherence).toBeLessThan(0.5);
    expect(m.edgeCoherence).toBeLessThan(stripesM.edgeCoherence - 0.3);
  });
});

describe('bandMetrics — invariants', () => {
  it('occupancy sums to 1 on every fixture', () => {
    for (const sample of [stripes([1, 0], 20), rings(), blobs(1337)]) {
      const m = bandMetrics(sample, { stops: STOPS, size: SIZE, extent: EXTENT, wind: [1, 0] });
      const sum = m.occupancy.reduce((a, b) => a + b, 0);
      expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
    }
  });

  it('is deterministic for the same inputs', () => {
    const a = bandMetrics(blobs(1337), { stops: STOPS, size: SIZE, extent: EXTENT, wind: [1, 0] });
    const b = bandMetrics(blobs(1337), { stops: STOPS, size: SIZE, extent: EXTENT, wind: [1, 0] });
    expect(a).toEqual(b);
  });

  it('normalises a non-unit wind vector', () => {
    const a = bandMetrics(stripes([1, 0], 20), {
      stops: STOPS,
      size: SIZE,
      extent: EXTENT,
      wind: [0.3, 0],
    });
    expect(a.edgeCoherence).toBeGreaterThan(0.9);
  });

  it('rejects a stop table that is not exactly three ascending thresholds', () => {
    expect(() =>
      bandMetrics(stripes([1, 0], 20), {
        stops: [0.5],
        size: 64,
        extent: EXTENT,
        wind: [1, 0],
      }),
    ).toThrow();
    expect(() =>
      bandMetrics(stripes([1, 0], 20), {
        stops: [0.75, 0.5, 0.25],
        size: 64,
        extent: EXTENT,
        wind: [1, 0],
      }),
    ).toThrow();
  });
});
