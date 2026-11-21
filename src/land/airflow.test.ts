import { describe, expect, it } from 'vitest';
import { DistanceEmitter, FlightTrail } from './airflow';

describe('flight wake', () => {
  it.each([1 / 120, 1 / 30, 0.1])('keeps continuous, ordered segments at dt=%s', dt => {
    const trail = new FlightTrail();
    for (let i = 0; i <= Math.round(2 / dt); i++) {
      const time = i * dt;
      trail.advance({ x: 12, y: 14, z: -78 * time }, time);
    }
    expect(trail.points[0].z).toBeCloseTo(-156);
    expect(trail.points.at(-1)!.w).toBeLessThan(1.1);
    trail.points.slice(1).forEach((point, i) => {
      expect(point.w).toBeLessThanOrEqual(trail.points[i].w);
      expect(point.z).toBeCloseTo(-78 * point.w);
    });
    expect(trail.advance({ x: 900, y: 30, z: 0 }, 2.01)).toBe(0);
    expect(trail.points.every(p => p.x === 900)).toBe(true);
  });
  it('emits at the same travelled positions at different frame rates', () => {
    const sample = (frames: number) => {
      const emitter = new DistanceEmitter(), births: number[] = [];
      for (let i = 0; i < frames; i++) emitter.step(48 / frames, 2, 8, f => births.push((i + f) * 48 / frames));
      return births;
    };
    expect(sample(120).length).toBe(24);
    sample(30).forEach((x, i) => expect(x).toBeCloseTo(sample(120)[i], 7));
  });
  it('caps bursts and never repays dropped births on a later frame', () => {
    const emitter = new DistanceEmitter();
    let n = 0;
    emitter.step(90, 1, 4, () => n++);
    emitter.step(0.1, 1, 4, () => n++);
    expect(n).toBe(4);
  });
});
