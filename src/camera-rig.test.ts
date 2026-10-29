import { describe, it, expect } from 'vitest';
import { smoothCamera, deadzoneFocus, expAlpha, type Vec3 } from './camera-rig';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

describe('expAlpha', () => {
  it('is 0 for dt=0 and never leaves [0,1]', () => {
    expect(expAlpha(0, 8)).toBe(0);
    expect(expAlpha(0.016, 8)).toBeGreaterThan(0);
    expect(expAlpha(0.016, 8)).toBeLessThan(1);
    expect(expAlpha(10, 8)).toBeLessThanOrEqual(1);
    expect(expAlpha(10, 8)).toBeGreaterThan(0.99);
  });

  it('sanitizes NaN / negative dt and non-positive lambda', () => {
    expect(expAlpha(Number.NaN, 8)).toBe(0);
    expect(expAlpha(-1, 8)).toBe(0);
    expect(expAlpha(0.016, 0)).toBe(0);
    expect(expAlpha(0.016, Number.NaN)).toBe(0);
  });
});

describe('smoothCamera', () => {
  it('holds position when dt is 0', () => {
    const cur = v(0, 0, 0);
    smoothCamera(cur, v(10, 5, -10), 0, 6);
    expect(cur).toEqual(v(0, 0, 0));
  });

  it('eases toward the target without overshooting', () => {
    const cur = v(0, 0, 0);
    const target = v(10, 4, -2);
    smoothCamera(cur, target, 1 / 60, 6);
    expect(cur.x).toBeGreaterThan(0);
    expect(cur.x).toBeLessThan(10);
    expect(cur.y).toBeGreaterThan(0);
    expect(cur.y).toBeLessThan(4);
  });

  it('is frame-rate independent (exponential, not a fixed per-frame lerp)', () => {
    const a = v(0, 0, 0);
    smoothCamera(a, v(10, 0, 0), 0.1, 5);
    const b = v(0, 0, 0);
    for (let i = 0; i < 10; i += 1) smoothCamera(b, v(10, 0, 0), 0.01, 5);
    expect(Math.abs(a.x - b.x)).toBeLessThan(1e-9);
  });

  it('stays finite when the target carries NaN or Infinity', () => {
    const cur = v(1, 2, 3);
    smoothCamera(cur, v(Number.NaN, 0, 0), 1 / 60, 6);
    expect(Number.isFinite(cur.x)).toBe(true);
    expect(Number.isFinite(cur.y)).toBe(true);
    expect(Number.isFinite(cur.z)).toBe(true);
    const cur2 = v(1, 2, 3);
    smoothCamera(cur2, v(Number.POSITIVE_INFINITY, -1, 0), 1 / 60, 6);
    expect([cur2.x, cur2.y, cur2.z].every((n) => Number.isFinite(n))).toBe(true);
  });

  it('clamps a pathological dt instead of teleporting or exploding', () => {
    const cur = v(0, 0, 0);
    smoothCamera(cur, v(100, 0, 0), 5, 6);
    expect(cur.x).toBeGreaterThan(0);
    expect(cur.x).toBeLessThanOrEqual(100);
    expect([cur.x, cur.y, cur.z].every((n) => Number.isFinite(n))).toBe(true);
  });
});

describe('deadzoneFocus', () => {
  it('ignores target movement inside the dead zone box', () => {
    const focus = v(0, 0, 0);
    deadzoneFocus(v(1.5, 0, -1.2), focus, 2, 2);
    expect(focus).toEqual(v(0, 0, 0));
  });

  it('follows only the overflow beyond the dead zone', () => {
    const focus = v(0, 0, 0);
    deadzoneFocus(v(5, 0, 0), focus, 2, 2);
    expect(focus.x).toBeCloseTo(3, 10);
  });

  it('keeps the focus fixed instead of NaN on a non-finite target', () => {
    const focus = v(1, 0, 1);
    deadzoneFocus(v(Number.NaN, 0, 0), focus, 2, 2);
    expect(focus).toEqual(v(1, 0, 1));
  });
});
