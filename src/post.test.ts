import { describe, it, expect } from 'vitest';

import {
  POST_HIGH,
  POST_LOW,
  usePost,
  focusDistanceFor,
  clampFx,
  presetUsesDof,
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
