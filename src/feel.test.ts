import { describe, it, expect } from 'vitest';
import { updateTrauma, shakeSample, TRAUMA_DECAY, SHAKE_MAX } from './feel';

describe('updateTrauma', () => {
  it('decays a stretched trauma value toward rest and clamps at 0', () => {
    let t = 0.8;
    for (let i = 0; i < 600; i += 1) t = updateTrauma(t, 1 / 60);
    expect(t).toBe(0);
    expect(updateTrauma(0.5, 0)).toBe(0.5);
    expect(updateTrauma(0.5, 10)).toBe(0);
    expect(TRAUMA_DECAY).toBeGreaterThan(0);
  });

  it('clamps incoming trauma into 0..1 so stacked hits cannot exceed full shake', () => {
    expect(updateTrauma(4, 0)).toBe(1);
    expect(updateTrauma(-3, 0)).toBe(0);
  });

  it('sanitizes NaN trauma and NaN dt', () => {
    expect(updateTrauma(Number.NaN, 1 / 60)).toBe(0);
    expect(updateTrauma(0.6, Number.NaN)).toBe(0.6);
  });
});

describe('shakeSample', () => {
  it('is exactly zero at rest so the camera never drifts', () => {
    const out = { x: 1, y: 1, z: 1 };
    shakeSample(0, 12.3, out);
    expect(out).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('stays bounded by trauma^2 * SHAKE_MAX', () => {
    const out = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 400; i += 1) {
      shakeSample(1, i * 0.05, out);
      expect(Math.hypot(out.x, out.y, out.z)).toBeLessThanOrEqual(SHAKE_MAX * 1.001);
      expect([out.x, out.y, out.z].every((n) => Number.isFinite(n))).toBe(true);
    }
  });

  it('scales quadratically: a small hit barely moves the camera', () => {
    const small = { x: 0, y: 0, z: 0 };
    const big = { x: 0, y: 0, z: 0 };
    let smallPeak = 0;
    let bigPeak = 0;
    for (let i = 0; i < 400; i += 1) {
      shakeSample(0.2, i * 0.05, small);
      shakeSample(0.9, i * 0.05, big);
      smallPeak = Math.max(smallPeak, Math.hypot(small.x, small.y, small.z));
      bigPeak = Math.max(bigPeak, Math.hypot(big.x, big.y, big.z));
    }
    expect(bigPeak).toBeGreaterThan(smallPeak * 4);
  });
});
