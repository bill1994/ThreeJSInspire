import { describe, it, expect } from 'vitest';
import {
  DETAIL_FEATURE_M,
  DETAIL_SLOPE_BUDGET,
  detailFade,
  detailNormal,
} from './detail-grain';

const RP = 5.797e-4;

describe('noise-gradient detail normals', () => {
  it('never perturbs the normal past its budget', () => {
    expect(DETAIL_SLOPE_BUDGET).toBeLessThan(0.4);
    for (let i = 0; i < 64; i++) {
      const n = detailNormal(i * 1.37, -i * 2.11, i * 0.09, 30, RP);
      expect(Math.hypot(n.dx, n.dz)).toBeLessThanOrEqual(DETAIL_SLOPE_BUDGET + 1e-9);
    }
  });

  it('is deterministic but not periodic', () => {
    expect(detailNormal(11.25, -4.5, 3.5, 25, RP)).toEqual(
      detailNormal(11.25, -4.5, 3.5, 25, RP),
    );
    // The whole reason this replaces the sine version: a sum of sines is periodic and reads
    // as wallpaper. Compare the field with itself one feature-length away — a periodic
    // function would correlate strongly, noise must not.
    const P = DETAIL_FEATURE_M;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < 400; i++) {
      const x = i * 0.37 - 40;
      const z = i * 0.13 - 20;
      const a = detailNormal(x, z, 0, 20, RP);
      const b = detailNormal(x + P, z, 0, 20, RP);
      dot += a.dx * b.dx + a.dz * b.dz;
      na += a.dx * a.dx + a.dz * a.dz;
      nb += b.dx * b.dx + b.dz * b.dz;
    }
    const corr = dot / Math.sqrt(na * nb || 1);
    expect(Math.abs(corr)).toBeLessThan(0.5);
  });

  it('moves with time instead of standing still', () => {
    const a = detailNormal(6, 6, 0, 20, RP);
    const b = detailNormal(6, 6, 1.5, 20, RP);
    expect(a.dx === b.dx && a.dz === b.dz).toBe(false);
  });

  it('fades out on the same angular budget as the swell trains', () => {
    const d1 = DETAIL_FEATURE_M / (2 * RP);
    expect(detailFade(DETAIL_FEATURE_M, 0, RP)).toBe(1);
    expect(detailFade(DETAIL_FEATURE_M, d1 * 2, RP)).toBe(0);
    const near = detailNormal(4, 4, 0, 1, RP);
    const far = detailNormal(4, 4, 0, d1 * 2.5, RP);
    expect(far.dx).toBe(0);
    expect(far.dz).toBe(0);
    expect(Math.hypot(near.dx, near.dz)).toBeGreaterThan(0);
  });

  it('degrades to no perturbation on broken input, never to NaN', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const n = detailNormal(bad, 0, 0, 10, RP);
      expect(n.dx).toBe(0);
      expect(n.dz).toBe(0);
    }
    expect(detailNormal(0, 0, 0, 10, NaN).dx).toBe(0);
    expect(detailFade(DETAIL_FEATURE_M, NaN, RP)).toBe(0);
  });
});
