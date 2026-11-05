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
import { TIER_EASE_PER_FRAME, snapOrigin } from './sea/bands';

/** The design's most demanding budget (§5.3: fov 60 on a 1080p-class buffer). */
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

  it('eases the sea down a tier instead of cutting the finest train in one frame', async () => {
    const scene = new THREE.Scene();
    const world = await initWorld(scene);
    const camera = new THREE.Vector3(0, 40, 0);
    const frame = (t: number): void => {
      world.update(t, 0.016, { camera, radPerPixel: RAD_PER_PIXEL });
    };
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

    // The tier is a target, not a write: asking for the low tier must not move
    // the ocean until a frame runs, or the governor would change it inside the
    // frame it decided to.
    world.setQuality?.(false);
    expect(trainCounts()).toEqual([5, 4, 3, 2, 1, 0]);

    // Exactly one ease step, not the whole tier: 5 - 1/12 at b0. A hard cut
    // here would delete a 0.15 m train between two frames, which is the whole
    // point of the ramp.
    frame(0);
    expect(trainCounts()[0]).toBeCloseTo(5 - TIER_EASE_PER_FRAME, 10);
    expect(trainCounts()[1]).toBeCloseTo(4 - TIER_EASE_PER_FRAME, 10);
    expect(trainCounts()[2]).toBe(3);

    // It settles on the cap (M9's LOW_TIER_TRAINS) and stops there.
    for (let i = 1; i < 64; i++) frame(i * 0.016);
    expect(trainCounts()).toEqual([3, 3, 3, 2, 1, 0]);

    // And back up again, on the same ramp.
    world.setQuality?.(true);
    for (let i = 0; i < 64; i++) frame(i * 0.016);
    expect(trainCounts()).toEqual([5, 4, 3, 2, 1, 0]);
  });
});

describe('initWorld', () => {
  it('wires the puff field, steps quality down under load, and survives disposal', async () => {
    // The world is sky + sea + puffs; a `update` without a view is legal (the sea simply is
    // not towed that frame), so the governor path is exercisable without a camera.
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
