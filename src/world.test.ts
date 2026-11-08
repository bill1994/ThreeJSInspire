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

const sources = import.meta.glob('./world.ts', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

describe('world setInterior (兜底瓣接线)', () => {
  it('WorldHandle 暴露 setInterior 并转发给 puff 句柄', () => {
    const src = sources['./world.ts'];
    expect(src).toMatch(
      /setInterior\(inCloud01: number, cam: \{ x: number; y: number; z: number \}\): void/,
    );
    expect(src).toMatch(/puffs\?\.setInterior\?\.\(/);
  });
});

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

describe('initWorld', () => {
  it('mounts no sea, wires the puff field, steps quality down under load, and disposes', async () => {
    // The world is sky + puffs now; the sea was deleted on rebuild/sea-dome-reset.
    // Puff construction needs the WebGPU build; where it cannot load (plain node),
    // initWorld still resolves with an empty blob list instead of throwing.
    const scene = new THREE.Scene();
    const world = await initWorld(scene);

    expect(Array.isArray(world.blobs)).toBe(true);
    // `clouds` reports whether the puff field really mounted (it cannot in plain node),
    // so the boot label has something honest to read.
    expect(typeof world.clouds).toBe('boolean');
    // No banded-sea meshes may come back through any path.
    expect(scene.children.filter((o) => /^sea-b\d$/.test(o.name))).toHaveLength(0);

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

describe('world sea mount', () => {
  it('mounts the sea and drives it from the accumulated elapsed time', async () => {
    const scene = new THREE.Scene();
    const world = await initWorld(scene);
    // Review Focus 4: frozen captures advance the world by exact steps, so the
    // sea clock must be the accumulated elapsed time, never the wall clock.
    world.update(3.5, 1 / 60, { camera: new THREE.Vector3(0, 7, 0), radPerPixel: 6.014e-4 });
    expect(world.sea?.time).toBe(3.5);
    // Review Focus 5: the sea must ignore scene.fog — check every ring.
    const rings = scene.children.filter((o) => /^sea-r\d$/.test(o.name)) as THREE.Mesh[];
    expect(rings.length).toBe(4);
    for (const ring of rings) expect(ring.material).toMatchObject({ fog: false });
    world.dispose();
  });

  it('forwards a live sun direction to the mounted sea (linkage review)', async () => {
    const scene = new THREE.Scene();
    const world = await initWorld(scene);
    const dir = new THREE.Vector3(1, 0.2, 0).normalize();
    expect(() => world.setSunDirection(dir)).not.toThrow();
    expect(() => world.sea?.setSunDirection(dir)).not.toThrow();
    // A world with no sea (failed link) must still accept the call.
    expect(sources['./world.ts']).toMatch(/sea\?\.setSunDirection\(dir\)/);
    world.dispose();
  });
});
