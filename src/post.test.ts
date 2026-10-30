import { describe, it, expect } from 'vitest';

import {
  SPEED_LINES,
  speedLine01,
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

describe('speed lines', () => {
  it('stays off unless the aircraft is genuinely diving', () => {
    // A shallow descent must not smear the frame.
    for (const dive of [0, 0.1, SPEED_LINES.DIVE_MIN]) {
      expect(speedLine01(0.8, 0.4, dive)).toBe(0);
    }
  });

  it('keeps the frame centre clear', () => {
    // The aircraft sits in the middle; a line through it would read as a glitch.
    expect(speedLine01(0, 0.4, 1)).toBe(0);
    expect(speedLine01(SPEED_LINES.INNER - 0.01, 0.4, 1)).toBe(0);
    expect(speedLine01(SPEED_LINES.OUTER, 0.4, 1)).toBeGreaterThan(0);
  });

  it('peaks on a streak and drops between streaks', () => {
    const period = (Math.PI * 2) / SPEED_LINES.COUNT;
    // The triangle wave is `abs(fract(phase)*2 - 1)`, so it peaks at the cell origin and
    // bottoms out half a cell later.
    const onStreak = speedLine01(0.8, 0, 1);
    const between = speedLine01(0.8, period / 2, 1);
    expect(onStreak).toBeGreaterThan(between);
    expect(between).toBeLessThan(0.02);
  });

  it('grows with dive but never exceeds its gain', () => {
    const half = speedLine01(0.9, 0.05, 0.6);
    const full = speedLine01(0.9, 0.05, 1);
    expect(full).toBeGreaterThan(half);
    expect(full).toBeLessThanOrEqual(SPEED_LINES.GAIN);
  });

  it('returns 0 on non-finite input instead of emitting NaN into the shader', () => {
    expect(speedLine01(Number.NaN, 0.4, 1)).toBe(0);
    expect(speedLine01(0.8, Number.NaN, 1)).toBe(0);
    expect(speedLine01(0.8, 0.4, Number.NaN)).toBe(0);
  });
});
