import { describe, it, expect } from 'vitest';
import {
  DETAIL_FEATURE_M,
  DETAIL_MAP_SIZE,
  DETAIL_SLOPE_BUDGET,
  buildDetailNormalMap,
  detailFade,
  normalAt,
} from './detail-grain';

const RP = 5.797e-4;

describe('detail normal map', () => {
  it('bakes an RGBA map of the requested size', () => {
    const n = 64;
    const data = buildDetailNormalMap(n);
    expect(data.length).toBe(n * n * 4);
    for (let i = 3; i < data.length; i += 4) expect(data[i]).toBe(255);
    expect(buildDetailNormalMap(DETAIL_MAP_SIZE).length).toBe(DETAIL_MAP_SIZE * DETAIL_MAP_SIZE * 4);
  });

  it('is deterministic', () => {
    const a = buildDetailNormalMap(32);
    const b = buildDetailNormalMap(32);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('decodes to slopes inside the unit range, and is not flat', () => {
    const n = 64;
    const data = buildDetailNormalMap(n);
    let sum = 0;
    let sumSq = 0;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const s = normalAt(data, n, x, y);
        expect(Math.abs(s.dx)).toBeLessThanOrEqual(1);
        expect(Math.abs(s.dz)).toBeLessThanOrEqual(1);
        sum += s.dx;
        sumSq += s.dx * s.dx;
      }
    }
    const count = n * n;
    const mean = sum / count;
    const variance = sumSq / count - mean * mean;
    // A flat map would put the variance at 0 and the grain would vanish silently.
    expect(variance).toBeGreaterThan(0.004);
    expect(Math.abs(mean)).toBeLessThan(0.15);
  });

  it('tiles: the seam is no rougher than any other column', () => {
    // This is what the sine version's rejection was about, one level down: a map that does not
    // tile shows a visible grid on the water. Compare the wrap discontinuity against the mean
    // neighbouring-texel difference -- a broken tile would be an order of magnitude worse.
    const n = 64;
    const data = buildDetailNormalMap(n);
    let seam = 0;
    let typical = 0;
    for (let y = 0; y < n; y++) {
      const left = normalAt(data, n, 0, y);
      const right = normalAt(data, n, n - 1, y);
      seam += Math.abs(left.dx - right.dx) + Math.abs(left.dz - right.dz);
      for (let x = 0; x < n - 1; x++) {
        const a = normalAt(data, n, x, y);
        const b = normalAt(data, n, x + 1, y);
        typical += Math.abs(a.dx - b.dx) + Math.abs(a.dz - b.dz);
      }
    }
    const seamMean = seam / n;
    const typicalMean = typical / (n * (n - 1));
    expect(seamMean).toBeLessThan(typicalMean * 2);
  });

  it('fades out on the same angular budget as the swell trains', () => {
    const d1 = DETAIL_FEATURE_M / (2 * RP);
    expect(detailFade(DETAIL_FEATURE_M, 0, RP)).toBe(1);
    expect(detailFade(DETAIL_FEATURE_M, d1 * 2, RP)).toBe(0);
    expect(detailFade(DETAIL_FEATURE_M, d1 * 0.25, RP)).toBe(1);
    // Half-way through the ramp it is genuinely partial, not a step.
    const mid = detailFade(DETAIL_FEATURE_M, (d1 + d1 * 0.5) / 2, RP);
    expect(mid).toBeGreaterThan(0.1);
    expect(mid).toBeLessThan(0.9);
  });

  it('degrades to no perturbation on broken input', () => {
    expect(detailFade(DETAIL_FEATURE_M, NaN, RP)).toBe(0);
    expect(detailFade(DETAIL_FEATURE_M, 10, 0)).toBe(0);
    expect(detailFade(NaN, 10, RP)).toBe(0);
  });

  it('keeps its slope budget below the flip threshold', () => {
    expect(DETAIL_SLOPE_BUDGET).toBeLessThan(0.4);
  });
});
