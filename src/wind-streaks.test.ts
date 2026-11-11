/**
 * src/wind-streaks.test.ts — P0-4 3D 风絮粒子 (Q3-1) 契约。
 * 全部 headless：seeded PRNG 保证确定性，静态相机下可精确断言。
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
const sources = import.meta.glob('./game.ts', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;import {
  STREAK_DEPTH,
  STREAK_INNER,
  STREAK_NEAR,
  STREAK_OPACITY,
  STREAK_SLIP,
  WIND_STREAKS,
  WIND_STREAKS_LOW,
  initStreaks,
  streakBasis,
  streakEdge,
} from './wind-streaks';

const FWD = { x: 0, y: 0, z: -1 };
const ORIGIN = { x: 0, y: 10, z: 0 };

function pointsOf(scene: THREE.Scene): THREE.Points {
  const p = scene.getObjectByName('porco_streaks');
  if (!(p instanceof THREE.Points)) throw new Error('porco_streaks missing');
  return p;
}

function positionsOf(scene: THREE.Scene): Float32Array {
  const pts = pointsOf(scene);
  const attr = pts.geometry.getAttribute('position') as THREE.BufferAttribute;
  return attr.array as Float32Array;
}

describe('wind-streaks consts (P0-4 Q3-1)', () => {
  it('pins the spec anchors', () => {
    expect(WIND_STREAKS).toBe(200);
    expect(STREAK_DEPTH).toBe(40);
    expect(STREAK_SLIP).toBe(0.6);
    expect(STREAK_INNER).toBe(0.7);
  });
});

describe('wind-streaks streaming', () => {
  it('drags particles backward at 0.6x airspeed in world space', () => {
    const scene = new THREE.Scene();
    const streaks = initStreaks(scene);
    streaks.update(0, { origin: ORIGIN, forward: FWD, speed: 0, speed01: 0.3 });
    const before = positionsOf(scene).slice();
    // 46 m/s * 0.6 * 0.5 s = 13.8 m, delivered as five 0.1 s frames (the update
    // clamps dt to 0.1 against tab-switch jumps — pinned below). Depth band is
    // 30..40 on recycle so deep particles never recycle inside this window.
    for (let s = 0; s < 5; s += 1) {
      streaks.update(0.1, { origin: ORIGIN, forward: FWD, speed: 46, speed01: 0.5 });
    }
    const after = positionsOf(scene);
    let checked = 0;
    for (let i = 0; i < WIND_STREAKS; i += 1) {
      const z0 = ORIGIN.z - before[i * 3 + 2]; // depth ahead (fwd = -z)
      if (z0 > 20) {
        // World-space backward = +z when looking down -z.
        expect(after[i * 3 + 2] - before[i * 3 + 2]).toBeCloseTo(13.8, 4);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(50);
    streaks.dispose();
  });

  it('clamps dt to 0.1 s against tab-switch jumps', () => {
    const scene = new THREE.Scene();
    const streaks = initStreaks(scene);
    streaks.update(0, { origin: ORIGIN, forward: FWD, speed: 0, speed01: 0.3 });
    const before = positionsOf(scene).slice();
    streaks.update(5, { origin: ORIGIN, forward: FWD, speed: 46, speed01: 0.5 });
    const after = positionsOf(scene);
    // 46 * 0.6 * 0.1 = 2.76, not 46 * 0.6 * 5. Assert on a deep particle so no
    // recycle pollutes the delta.
    let deep = -1;
    for (let i = 0; i < WIND_STREAKS; i += 1) {
      if (ORIGIN.z - before[i * 3 + 2] > 20) {
        deep = i;
        break;
      }
    }
    expect(deep).toBeGreaterThanOrEqual(0);
    expect(after[deep * 3 + 2] - before[deep * 3 + 2]).toBeCloseTo(2.76, 4);
    streaks.dispose();
  });

  it('recycles particles that fall behind the camera back to 30..40 m ahead', () => {
    const scene = new THREE.Scene();
    const streaks = initStreaks(scene);
    const input = { origin: ORIGIN, forward: FWD, speed: 46, speed01: 1 };
    for (let s = 0; s < 20; s += 1) streaks.update(0.5, input); // 10 s of streaming
    const pos = positionsOf(scene);
    const basis = streakBasis(FWD);
    for (let i = 0; i < WIND_STREAKS; i += 1) {
      const rel = {
        x: pos[i * 3] - ORIGIN.x,
        y: pos[i * 3 + 1] - ORIGIN.y,
        z: pos[i * 3 + 2] - ORIGIN.z,
      };
      const zc = -(rel.z); // depth ahead for fwd = -z
      expect(zc).toBeGreaterThanOrEqual(STREAK_NEAR - 0.01);
      // Centre 70% stays hollow, forever (lateral never changes in flight).
      expect(streakEdge(rel, FWD, basis)).toBeGreaterThanOrEqual(STREAK_INNER - 0.05);
    }
    streaks.dispose();
  });

  it('scales global opacity with speed01', () => {
    const scene = new THREE.Scene();
    const streaks = initStreaks(scene);
    streaks.update(0, { origin: ORIGIN, forward: FWD, speed: 20, speed01: 0.5 });
    const hi = (pointsOf(scene).material as THREE.PointsMaterial).opacity;
    streaks.update(0, { origin: ORIGIN, forward: FWD, speed: 20, speed01: 0.25 });
    const lo = (pointsOf(scene).material as THREE.PointsMaterial).opacity;
    expect(hi).toBeCloseTo(STREAK_OPACITY * 0.5, 6);
    expect(lo).toBeCloseTo(STREAK_OPACITY * 0.25, 6);
    expect(hi / lo).toBeCloseTo(2, 6);
    streaks.dispose();
  });

  it('dispose removes the points from the scene', () => {
    const scene = new THREE.Scene();
    const streaks = initStreaks(scene);
    expect(pointsOf(scene)).toBeInstanceOf(THREE.Points);
    streaks.dispose();
    expect(scene.getObjectByName('porco_streaks')).toBeUndefined();
  });
});

describe('wind-streaks low-tier cut (P2-4)', () => {
  it('pins the low-tier draw count: half the pool', () => {
    expect(WIND_STREAKS_LOW).toBe(100);
  });

  it('high draws all 200, low draws 100 via drawRange', () => {
    const scene = new THREE.Scene();
    const streaks = initStreaks(scene);
    const pts = pointsOf(scene);
    streaks.setQuality(true);
    expect(pts.geometry.drawRange.count).toBe(WIND_STREAKS);
    streaks.setQuality(false);
    expect(pts.geometry.drawRange.count).toBe(WIND_STREAKS_LOW);
    // 切回 high 恢复（降档/回升对称）。
    streaks.setQuality(true);
    expect(pts.geometry.drawRange.count).toBe(WIND_STREAKS);
    streaks.dispose();
  });

  it('game.setQuality fans out to the streaks (feel 之外第二路)', () => {
    const src = sources['./game.ts'];
    expect(src).toMatch(/streaks\?\.setQuality\(high\)/);
  });
});
