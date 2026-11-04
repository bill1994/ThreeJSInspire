import { describe, it, expect } from 'vitest';
import {
  TRAINS,
  SEA_PATCH_SIZE,
  SEGMENTS_HIGH,
  SEGMENTS_LOW,
  LOW_TIER_TRAINS,
  gerstnerField,
  finestWavelength,
  combinedRms,
} from './waves';

const TIME_SWEEP = [0, 0.25, 3.7, 60, 1e4];
const TWO_PI = Math.PI * 2;

describe('TRAINS constants', () => {
  it('has 5 trains with the pinned wavelengths', () => {
    expect(TRAINS).toHaveLength(5);
    expect(TRAINS.map((t) => t.lambda)).toEqual([180, 90, 45, 22, 11]);
  });

  it('has unit-length directions', () => {
    for (const t of TRAINS) {
      const len = Math.hypot(t.dir[0], t.dir[1]);
      expect(len).toBeCloseTo(1, 12);
    }
  });

  it('keeps sharpness within the no-loop budget', () => {
    for (const t of TRAINS) {
      expect(t.sharpnessQ).toBeGreaterThan(0);
      expect(t.sharpnessQ).toBeLessThanOrEqual(0.8);
    }
  });

  it('keeps total slope under 0.7', () => {
    const slope = TRAINS.reduce((s, t) => s + t.amp * (TWO_PI / t.lambda), 0);
    expect(slope).toBeLessThan(0.7);
  });
});

describe('combinedRms', () => {
  it('lands in the 0.30-0.36 continuity band for all 5 trains', () => {
    expect(combinedRms(5)).toBeGreaterThanOrEqual(0.3);
    expect(combinedRms(5)).toBeLessThanOrEqual(0.36);
  });
});

describe('finestWavelength', () => {
  it('is 11 m with all trains, 45 m on the low tier', () => {
    expect(finestWavelength(5)).toBe(11);
    expect(finestWavelength(LOW_TIER_TRAINS)).toBe(45);
  });

  it('satisfies the mesh rule quad <= finest / 4 on both tiers', () => {
    expect(SEA_PATCH_SIZE / SEGMENTS_HIGH).toBeLessThanOrEqual(finestWavelength(5) / 4);
    expect(SEA_PATCH_SIZE / SEGMENTS_LOW).toBeLessThanOrEqual(finestWavelength(LOW_TIER_TRAINS) / 4);
  });
});

describe('gerstnerField closed form (single train, t = 0)', () => {
  const t0 = TRAINS[0];
  const k = TWO_PI / t0.lambda;

  it('has zero height and unit Jacobian at phase origin', () => {
    const f = gerstnerField(0, 0, 0, 1);
    expect(f.y).toBeCloseTo(0, 9);
    expect(f.jac).toBeCloseTo(1, 9);
  });

  it('reaches full amplitude at the crest point', () => {
    // phase pi/2 along the train direction: p = (pi/2) / k
    const p = Math.PI / 2 / k;
    const f = gerstnerField(t0.dir[0] * p, t0.dir[1] * p, 0, 1);
    expect(f.y).toBeCloseTo(t0.amp, 6);
  });

  it('matches the analytic slope normal at phase origin', () => {
    const f = gerstnerField(0, 0, 0, 1);
    const slope = t0.amp * k;
    const len = Math.hypot(slope, 1);
    expect(f.nx).toBeCloseTo((-slope * t0.dir[0]) / len, 6);
    expect(f.nz).toBeCloseTo((-slope * t0.dir[1]) / len, 6);
  });
});

describe('gerstnerField robustness', () => {
  it('is deterministic for identical inputs', () => {
    const a = gerstnerField(37.2, -118.5, 4.25, 5);
    const b = gerstnerField(37.2, -118.5, 4.25, 5);
    expect(a).toEqual(b);
  });

  it('stays finite over the time sweep', () => {
    const pts: Array<[number, number]> = [
      [0, 0],
      [123.4, -56.7],
      [-800, 799.9],
      [41.13, 9.31],
    ];
    for (const t of TIME_SWEEP) {
      for (const [x, z] of pts) {
        const f = gerstnerField(x, z, t, 5);
        for (const v of [f.y, f.nx, f.nz, f.jac]) {
          expect(Number.isFinite(v), `x=${x} z=${z} t=${t}`).toBe(true);
        }
      }
    }
  });

  it('keeps the Jacobian near 1 across a wavelength cell and 4 times', () => {
    // Gerstner mapping compresses at crests (J < 1, the foam driver) and
    // spreads at troughs (J > 1). Both are bounded: |J - 1| <= ~0.15 for
    // these trains (sum of Q*A*k ~= 0.07). Fold-over would need J <= 0.
    const cell = 11;
    const times = [0, 1.3, 7.7, 42];
    for (const t of times) {
      for (let i = 0; i < 40; i++) {
        for (let j = 0; j < 40; j++) {
          const x = (i / 40) * cell;
          const z = (j / 40) * cell;
          const f = gerstnerField(x, z, t, 5);
          expect(f.jac).toBeGreaterThan(0.5);
          expect(f.jac).toBeLessThan(1.2);
        }
      }
    }
  });
});
