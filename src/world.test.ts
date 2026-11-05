import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  FrameGovernor,
  MAX_DT,
  SLOW_FRAME_LIMIT,
  SLOW_FRAME_MS,
  initWorld,
  isMobileLike,
} from './world';
import { snapOrigin } from './sea/bands';

/** The canonical budget (fov 60 on a 1920 px buffer), from `lod.ts`. */
const RAD_PER_PIXEL = 5.797e-4;

describe('FrameGovernor', () => {
  it('clamps frame deltas and rejects garbage input', () => {
    const g = new FrameGovernor();
    expect(g.tick(0.016)).toBeCloseTo(0.016, 6);
    expect(g.tick(5)).toBe(MAX_DT);
    expect(g.tick(Number.NaN)).toBe(0);
    expect(g.tick(-1)).toBe(0);
    expect(g.tick(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('needs the full run of consecutive slow frames before degrading', () => {
    const g = new FrameGovernor();
    const slow = (SLOW_FRAME_MS + 1) / 1000;

    for (let i = 0; i < SLOW_FRAME_LIMIT - 1; i++) g.tick(slow);
    expect(g.degraded).toBe(false);
    expect(g.slowFrames).toBe(SLOW_FRAME_LIMIT - 1);

    g.tick(slow);
    expect(g.degraded).toBe(true);
  });

  it('resets the run on a fast frame', () => {
    const g = new FrameGovernor();
    const slow = (SLOW_FRAME_MS + 1) / 1000;

    for (let i = 0; i < SLOW_FRAME_LIMIT - 1; i++) g.tick(slow);
    g.tick(0.008); // one good frame
    expect(g.slowFrames).toBe(0);

    for (let i = 0; i < SLOW_FRAME_LIMIT - 1; i++) g.tick(slow);
    expect(g.degraded).toBe(false);
  });

  it('stays degraded once it has stepped down', () => {
    const g = new FrameGovernor();
    for (let i = 0; i < SLOW_FRAME_LIMIT; i++) g.tick(0.05);
    expect(g.degraded).toBe(true);

    for (let i = 0; i < 100; i++) g.tick(0.004);
    expect(g.degraded).toBe(true);
  });

  it('does not treat a zero delta as a slow frame', () => {
    const g = new FrameGovernor();
    for (let i = 0; i < 200; i++) g.tick(0);
    expect(g.degraded).toBe(false);
  });
});

describe('isMobileLike', () => {
  it('detects phones and tablets from the user agent', () => {
    expect(isMobileLike('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 5)).toBe(true);
    expect(isMobileLike('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36', 5)).toBe(true);
  });

  it('treats iPadOS desktop-mode UAs as mobile only when touch capable', () => {
    const ipadDesktopUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';
    expect(isMobileLike(ipadDesktopUa, 5)).toBe(true);
    expect(isMobileLike(ipadDesktopUa, 0)).toBe(false);
  });

  it('treats a desktop browser as desktop', () => {
    expect(
      isMobileLike('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0', 0),
    ).toBe(false);
  });
});

describe('initWorld sea mount (Task 6)', () => {
  it('mounts all six bands into the scene it was given', async () => {
    const scene = new THREE.Scene();
    const world = await initWorld(scene);
    expect(world.sea).not.toBeNull();
    const seaNames = scene.children
      .filter((obj) => /^sea-b\d$/.test(obj.name))
      .map((obj) => obj.name);
    expect(seaNames).toEqual(['sea-b0', 'sea-b1', 'sea-b2', 'sea-b3', 'sea-b4', 'sea-b5']);
  });

  it('tows the bands onto the live camera, not onto the aircraft origin', async () => {
    const scene = new THREE.Scene();
    const world = await initWorld(scene);
    const camera = new THREE.Vector3(101, 7, -37);
    world.update(0, 0.016, { camera, radPerPixel: RAD_PER_PIXEL });

    const b0 = scene.getObjectByName('sea-b0') as THREE.Mesh;
    const b5 = scene.getObjectByName('sea-b5') as THREE.Mesh;
    // Each band on its own quantum: 2.25 m for b0, 96 m for b5. A single shared
    // cell would pass a modulo check and still swim every coarse vertex.
    expect(b0.position.x).toBe(snapOrigin(camera.x, 2.25));
    expect(b5.position.x).toBe(snapOrigin(camera.x, 96));
    expect(b0.position.x).toBeLessThanOrEqual(camera.x);
  });

  it('pushes the live angular budget into every band material each frame', async () => {
    const scene = new THREE.Scene();
    const world = await initWorld(scene);
    world.update(3.5, 0.016, { camera: new THREE.Vector3(0, 40, 0), radPerPixel: RAD_PER_PIXEL });

    const bands = scene.children.filter((o) => /^sea-b\d$/.test(o.name));
    expect(bands).toHaveLength(6);
    for (const obj of bands) {
      const uniforms = (
        obj as THREE.Mesh
      ).material as unknown as {
        userData?: { seaUniforms?: { uTime: { value: number }; uRadPerPixel: { value: number } } };
      };
      expect(uniforms.userData?.seaUniforms?.uTime.value).toBe(3.5);
      expect(uniforms.userData?.seaUniforms?.uRadPerPixel.value).toBe(RAD_PER_PIXEL);
    }
  });

  it('reaches the sea when the governor steps quality down', async () => {
    const scene = new THREE.Scene();
    const world = await initWorld(scene);
    const trainCounts = (): number[] =>
      scene.children
        .filter((o) => /^sea-b\d$/.test(o.name))
        .map(
          (obj) =>
            (
              (obj as THREE.Mesh).material as unknown as {
                userData: { seaUniforms: { uTrains: { value: number } } };
              }
            ).userData.seaUniforms.uTrains.value,
        );

    // High tier keeps each band's own train count (M2: 5/4/3/2/1/0).
    expect(trainCounts()).toEqual([5, 4, 3, 2, 1, 0]);
    world.setQuality?.(false);
    // Low tier caps the fragment at LOW_TIER_TRAINS (M9) without changing topology.
    expect(trainCounts()).toEqual([3, 3, 3, 2, 1, 0]);
    world.setQuality?.(true);
    expect(trainCounts()).toEqual([5, 4, 3, 2, 1, 0]);
  });
});

describe('initWorld', () => {
  it('wires the puff field, steps quality down under load, and survives disposal', async () => {
    // reconstruct baseline: no sea, no dome clouds — the world is sky + puffs.
    // Puff construction needs the WebGPU build; where it cannot load (plain node),
    // initWorld still resolves with an empty blob list instead of throwing.
    const scene = new THREE.Scene();
    const world = await initWorld(scene);

    expect(Array.isArray(world.blobs)).toBe(true);

    for (const t of [0, 0.016, 1, 12.5, 120, 3600]) {
      expect(() => world.update(t, 0.016)).not.toThrow();
    }

    // 60 consecutive slow frames must trip the governor, not before.
    for (let i = 0; i < SLOW_FRAME_LIMIT - 1; i++) world.update(i * 0.05, 0.05);
    expect(world.quality).toBe('high');
    world.update(SLOW_FRAME_LIMIT * 0.05, 0.05);
    expect(world.quality).toBe('low');

    expect(() => world.update(1e6, 0.016)).not.toThrow();

    expect(() => world.dispose()).not.toThrow();
    // Idempotent: a second dispose must not throw.
    expect(() => world.dispose()).not.toThrow();
  });
});
