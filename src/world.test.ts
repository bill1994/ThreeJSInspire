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

// --- 背景云挂载契约（2026-11-09；layer-reduction Task 4 改名 setBgVisible，Task 5 摘除 dome 句柄）---
describe('initWorld — bg lever', () => {
  it('exposes the bg lever and tolerates a failed bg mount', async () => {
    // 与既有 `world.clouds` 同款口径：plain node 下云模块挂不上，
    // 这里只验 API 形状与「挂了也不拖垮世界」，不验真实挂载。
    const scene = new THREE.Scene();
    const world = await initWorld(scene);
    expect(typeof world.setBgVisible).toBe('function');
    world.setBgVisible(false);
    world.setBgVisible(true);
    world.dispose();
  });
});

// --- 背景积云烘焙层（bg-cumulus Task 5）---
describe('world bg-cumulus wiring', () => {
  it('setBgVisible cascades to the baked cumulus layer (?bg=0 kills it)', () => {
    const src = sources['./world.ts'];
    // 命名是 bgCumulus——新层自持，不再借用 domeHorizon 旧名。
    expect(src).toMatch(/bgCumulus\?\.setVisible\?/);
    // 可见性变化经回调链推到天空侧 uCloudOn（world 不摸 sky，main 注入回调）。
    expect(src).toMatch(/onBgVisibilityChange/);
  });

  it('update drives the baked layer with sun dir only (no view — cubemap is direction-fixed)', () => {
    const src = sources['./world.ts'];
    // C5（终审）：灯光仰角被 syncSun 钳 ≥2°（main.ts:408），灯方向喂月相翻转会让
    // dayW 恒 1——烘焙层必须吃未钳制的活太阳引用（sunDirLive 是 sun.direction 本体）。
    expect(src).toMatch(/bgCumulus\?\.update\?\.\(time, sunDirLive \?\? sunDir\)/);
  });

  it('palette passthrough reaches the baked layer too', () => {
    const src = sources['./world.ts'];
    expect(src).toMatch(/bgCumulus\?\.setCloudPalette\?\./);
  });

  it('mounts initBgCumulus with the renderer and seed 7', () => {
    const src = sources['./world.ts'];
    expect(src).toMatch(/mod\.initBgCumulus\(renderer,/);
    expect(src).toMatch(/seed: 7/);
  });

  it('?bg=0 skips the mount entirely (终审 Minor 4：关云路径不做全量首烘)', () => {
    const src = sources['./world.ts'];
    expect(src).toMatch(/if \(opts\?\.bgVisible !== false\) \{[\s\S]*?initBgCumulus/);
  });

  it('exposes cloudTexture for the main-thread sky handoff', () => {
    const src = sources['./world.ts'];
    expect(src).toMatch(/get cloudTexture\(\)/);
    expect(src).toMatch(/bgCumulus\?\.texture \?\? null/);
  });

  it('WorldView no longer carries headingRad (the patch heading window retired with the layer)', () => {
    const src = sources['./world.ts'];
    expect(src).not.toMatch(/headingRad/);
  });

  it('horizonCount returns the live cumulus count (semantics: patches → clouds)', () => {
    const src = sources['./world.ts'];
    expect(src).toMatch(/get horizonCount\(\): number/);
    expect(src).toMatch(/bgCumulus\?\.count \?\? 0/);
  });

  it('?bgq= parses to 512/1024/2048 (qa.ts), clamped and defaulted', async () => {
    const { parseBakeQuality } = await import('./qa');
    expect(parseBakeQuality(null)).toBe(1024);
    expect(parseBakeQuality('garbage')).toBe(1024);
    expect(parseBakeQuality('512')).toBe(512);
    expect(parseBakeQuality('1024')).toBe(1024);
    expect(parseBakeQuality('2048')).toBe(2048);
    expect(parseBakeQuality('4096')).toBe(2048);
    expect(parseBakeQuality('100')).toBe(512);
  });
});