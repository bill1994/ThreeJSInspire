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
    world.update(3.5, 1 / 60, { camera: new THREE.Vector3(0, 7, 0), radPerPixel: 6.014e-4, headingRad: 0 });
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

// ---- 轨道接线透传（day-night Task 7）--------------------------------------------------

describe('world handles — track passthroughs（day-night Task 7）', () => {
  it('setHazeTargets / setCloudPalette 在 sea 为 null、puffs 建成时都不抛', async () => {
    const scene = new THREE.Scene();
    const world = await initWorld(scene);
    // node 里 sea 模块能建出来（无 GPU 只停掉 dispatch），所以这里不断言 sea null；
    // 两个透传在「sea 建成」与「puffs 建成」两种现实下都必须 no-throw。
    expect(() =>
      world.setHazeTargets([1, 0.318, 0.103], [0.1, 0.05, 0.08]),
    ).not.toThrow();
    expect(() =>
      world.setCloudPalette(
        [
          [0.1, 0.1, 0.12],
          [0.2, 0.2, 0.24],
          [0.5, 0.3, 0.35],
          [0.55, 0.4, 0.4],
        ],
        [1, 0.318, 0.103],
      ),
    ).not.toThrow();
    world.dispose();
  });
});

// --- 穹顶云挂载契约（2026-11-09）---
describe('initWorld — dome cloud', () => {
  it('exposes the dome handles and tolerates a failed mount', async () => {
    // 与既有 `world.clouds` 同款口径：plain node 下云模块挂不上，
    // 这里只验 API 形状与「挂了也不拖垮世界」，不验真实挂载。
    const scene = new THREE.Scene();
    const world = await initWorld(scene);
    expect(typeof world.setDomeVisible).toBe('function');
    expect(typeof world.dome).toBe('boolean');
    world.setDomeVisible(false);
    world.setDomeVisible(true);
    world.dispose();
  });
});

// --- 地平线远云 patch 层（P1.5/horizon Task 7）---
describe('world dome-horizon wiring（Task 7）', () => {
  it('setDomeVisible cascades to the horizon ring (?dome=0 kills both)', () => {
    const src = sources['./world.ts'];
    // 命名是 domeHorizon（src/horizon.ts 已被天空地平线占用），别写成 horizon。
    expect(src).toMatch(/domeHorizon\?\.setVisible\?/);
  });

  it('update drives the heading window through domeHorizon?.update?.(t, sunDir, view)', () => {
    const src = sources['./world.ts'];
    expect(src).toMatch(/domeHorizon\?\.update\?\.\(/);
  });

  it('palette / sun color passthroughs reach the horizon ring too', () => {
    const src = sources['./world.ts'];
    expect(src).toMatch(/domeHorizon\?\.setCloudPalette\?\./);
    expect(src).toMatch(/domeHorizon\?\.setSunColor\?\./);
  });

  it('WorldView carries headingRad (the heading window reads it from lastView)', () => {
    const src = sources['./world.ts'];
    expect(src).toMatch(/headingRad: number/);
    expect(src).toMatch(/headingRad: 0/); // lastView 初始字面量
  });
});