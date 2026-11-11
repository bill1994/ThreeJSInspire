import { describe, it, expect } from 'vitest';

import {
  POST_HIGH,
  POST_LOW,
  usePost,
  focusDistanceFor,
  clampFx,
  presetUsesDof,
  smaaTexturesReady,
} from './post';

describe('post presets', () => {
  it('drops depth of field and keeps bloom in the low preset', () => {
    expect(POST_HIGH.dof).toBe(true);
    expect(POST_LOW.dof).toBe(false);
    expect(POST_LOW.bloom).toBe(true);
  });

  it('blooms only the sun disc, never the flat sky', () => {
    // The horizon (#ff9a5a) has a linear Rec709 luminance near 0.45 and the sun disc is ~2.4x.
    // The threshold has to fall between them or the whole sky glows.
    expect(POST_HIGH.bloomThreshold).toBeGreaterThan(0.5);
    expect(POST_HIGH.bloomThreshold).toBeLessThan(1.5);
  });
});

describe('presetUsesDof', () => {
  it('skips the whole depth-of-field chain on the low preset', () => {
    // bokehScale 0 collapses every tap onto one texel: the blur disappears while the CoC pass,
    // both half-res blur passes and the composite are still paid for every frame. The low tier
    // has to leave the node out of the graph, not merely zero its scale.
    expect(presetUsesDof(POST_HIGH)).toBe(true);
    expect(presetUsesDof(POST_LOW)).toBe(false);
    expect(presetUsesDof({ ...POST_HIGH, bokehScale: 0 })).toBe(false);
  });
});

describe('usePost', () => {
  it('is on by default and off for ?post=0', () => {
    expect(usePost('')).toBe(true);
    expect(usePost('?backend=webgl2')).toBe(true);
    expect(usePost('?post=0')).toBe(false);
  });
});

describe('focusDistanceFor', () => {
  it('focuses on the aircraft, not on the sea', () => {
    expect(focusDistanceFor({ x: 0, y: 40, z: 0 }, { x: 0, y: 40, z: -30 })).toBeCloseTo(30, 5);
  });

  it('clamps a nose-dive camera that would focus past the plane', () => {
    expect(focusDistanceFor({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -900 })).toBe(60);
  });

  it('clamps a camera sitting on top of the aircraft', () => {
    expect(focusDistanceFor({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 })).toBe(12);
  });
});

describe('clampFx', () => {
  it('keeps tuning in range and survives NaN', () => {
    const fx = clampFx({ ...POST_HIGH, bloomStrength: Number.NaN, bokehScale: 99 });
    expect(fx.bloomStrength).toBe(POST_HIGH.bloomStrength);
    expect(fx.bokehScale).toBe(3);
  });

  it('clamps every numeric field into its documented range', () => {
    const fx = clampFx({
      ...POST_HIGH,
      bloomRadius: -4,
      bloomThreshold: 9,
      focalLength: 1,
      focusDistance: 5000,
    });
    expect(fx.bloomRadius).toBe(0);
    expect(fx.bloomThreshold).toBe(1);
    expect(fx.focalLength).toBe(50);
    expect(fx.focusDistance).toBe(60);
  });
});


describe('dof far clamp (Task 8: keep DOF from blurring the cloud deck)', () => {
  // 与 dome-cloud.test.ts 同款：用 vite 的 ?raw glob 读源码（项目未装 @types/node，不能 import node:fs）。
  const sources = import.meta.glob('./*.ts', {
    query: '?raw',
    eager: true,
    import: 'default',
  }) as Record<string, string>;
  const postSrc = sources['./post.ts'] as string;

  it('clamps far viewZ before dof() instead of passing raw depth through', () => {
    const src = postSrc;
    // Constant pins the far cutoff so future tuning is explicit, not a magic number inline.
    expect(src).toMatch(/DOF_FAR_VIEW_Z\s*=\s*-\d+/);
    // Clamp direction: viewZ is negative, far is more negative -> max(), never min(positive).
    expect(src).toMatch(/viewZ\.max\(/);
    expect(src).not.toMatch(/\.min\(\s*positiveClamp/i);
    // Raw viewZ must no longer reach dof() directly.
    expect(src).not.toMatch(/dof\(\s*lit\s*,\s*viewZ\s*,/);
  });
});

describe('smaaTexturesReady', () => {
  /** A stand-in for the `new Image()` an SMAANode decodes its lookup textures into. */
  function fakeImage(startReady: boolean) {
    const listeners = new Map<string, (() => void)[]>();
    const image = {
      complete: startReady,
      addEventListener(type: string, listener: () => void) {
        const list = listeners.get(type) ?? [];
        list.push(listener);
        listeners.set(type, list);
      },
      fire(type: string) {
        image.complete = true;
        for (const listener of listeners.get(type) ?? []) listener();
      },
    };
    return image;
  }

  it('waits for the decode of both lookup textures', async () => {
    const focusArea = fakeImage(false);
    const focusSearch = fakeImage(false);
    const node = { _areaTexture: { image: focusArea }, _searchTexture: { image: focusSearch } };

    let settled = false;
    const pending = smaaTexturesReady([node]).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    focusSearch.fire('load');
    await Promise.resolve();
    expect(settled).toBe(false);

    focusArea.fire('load');
    await pending;
    expect(settled).toBe(true);
  });

  it('resolves immediately when the images already have pixels', async () => {
    const node = { _areaTexture: { image: fakeImage(true) }, _searchTexture: undefined };
    await expect(smaaTexturesReady([node])).resolves.toBeUndefined();
  });

  it('never rejects on a failed decode', async () => {
    const image = {
      complete: false,
      addEventListener(type: string, listener: () => void) {
        if (type === 'error') setTimeout(listener, 0);
      },
      decode: () => Promise.reject(new Error('decode failed')),
    };
    await expect(smaaTexturesReady([{ _areaTexture: { image } }])).resolves.toBeUndefined();
  });

  it('tolerates nodes without lookup textures', async () => {
    await expect(smaaTexturesReady([{}, null, undefined])).resolves.toBeUndefined();
  });
});
