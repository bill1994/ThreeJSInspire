import { describe, expect, it } from 'vitest';

import {
  DOME_DRIFT,
  DOME_SLAB,
  boxExit,
  driftOffset,
  fadeAt,
  slabSpan,
  stepSizes,
} from './dome-cloud-field';

describe('DOME_SLAB', () => {
  it('keeps the deck above the flight ceiling with a 140 m margin', () => {
    expect(DOME_SLAB.base).toBe(380);
    expect(DOME_SLAB.top).toBe(1150);
    expect(DOME_SLAB.base).toBeGreaterThan(240);
  });

  it('stays inside the camera far plane', () => {
    expect(DOME_SLAB.halfExtent).toBeLessThan(2000);
  });

  it('fades to nothing exactly at the box wall', () => {
    // 盒壁不可见的前提：到墙时 alpha 已经是 0。
    expect(DOME_SLAB.fadeEnd).toBe(DOME_SLAB.halfExtent);
  });
});

describe('slabSpan', () => {
  it('enters from below on an upward ray', () => {
    const span = slabSpan(60, 0.9);
    expect(span).not.toBeNull();
    expect(span!.t0).toBeGreaterThan(0);
    expect(span!.t1).toBeGreaterThan(span!.t0);
  });

  it('still hits when the camera is pinned at ALT_MAX and looking slightly up', () => {
    const span = slabSpan(240, 0.05);
    expect(span).not.toBeNull();
    expect(span!.t0).toBeGreaterThan(0);
    expect(span!.t1).toBeGreaterThan(span!.t0);
  });

  it('returns null for a horizontal ray below the deck', () => {
    expect(slabSpan(60, 0)).toBeNull();
  });

  it('returns null for a downward ray below the deck', () => {
    expect(slabSpan(60, -0.5)).toBeNull();
  });

  it('starts at zero when the camera is inside the slab', () => {
    expect(slabSpan(600, 1)!.t0).toBe(0);
  });

  it('exits at the slab floor when looking down from inside', () => {
    const span = slabSpan(600, -1);
    expect(span!.t0).toBe(0);
    expect(span!.t1).toBeCloseTo(600 - DOME_SLAB.base, 6);
  });
});

describe('boxExit', () => {
  it('scales with the horizontal component of the ray', () => {
    expect(boxExit(1, 1800)).toBeCloseTo(1800, 6);
    expect(boxExit(0.5, 1800)).toBeCloseTo(3600, 6);
  });

  it('is infinite for a perfectly vertical ray', () => {
    expect(boxExit(0, 1800)).toBe(Infinity);
  });

  it('is finite and non-negative for degenerate input', () => {
    for (const h of [Number.NaN, -1]) {
      const v = boxExit(h, 1800);
      expect(Number.isFinite(v) || v === Infinity).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('fadeAt', () => {
  it('is fully opaque at and inside fadeStart', () => {
    expect(fadeAt(0)).toBe(1);
    expect(fadeAt(DOME_SLAB.fadeStart)).toBe(1);
  });

  it('is fully gone at and beyond fadeEnd', () => {
    expect(fadeAt(DOME_SLAB.fadeEnd)).toBe(0);
    expect(fadeAt(5000)).toBe(0);
  });

  it('decreases monotonically across the band', () => {
    const samples = [1200, 1350, 1500, 1650, 1800].map(fadeAt);
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i]).toBeLessThan(samples[i - 1]);
    }
  });

  it('returns a finite value for non-finite input', () => {
    expect(Number.isFinite(fadeAt(Number.NaN))).toBe(true);
  });
});

describe('stepSizes', () => {
  it('covers exactly the span in 28 steps', () => {
    const widths = stepSizes(28, 1480);
    expect(widths).toHaveLength(28);
    const total = widths.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1480, 6);
  });

  it('keeps the first step under 20 m so the near field stays sharp', () => {
    expect(stepSizes(28, 1480)[0]).toBeLessThanOrEqual(20);
  });

  it('never shrinks a later step', () => {
    const widths = stepSizes(28, 1480);
    for (let i = 1; i < widths.length; i += 1) {
      expect(widths[i]).toBeGreaterThanOrEqual(widths[i - 1]);
    }
  });

  it('returns an empty array for a non-positive span or count', () => {
    expect(stepSizes(28, 0)).toHaveLength(0);
    expect(stepSizes(0, 100)).toHaveLength(0);
  });
});

describe('driftOffset', () => {
  it('is zero at t = 0 for both layers', () => {
    expect(driftOffset(0, 'detail')).toEqual({ x: 0, z: 0 });
    expect(driftOffset(0, 'weather')).toEqual({ x: 0, z: 0 });
  });

  it('moves the detail layer at 0.35 m/s — 30 s is about 10.5 m', () => {
    const o = driftOffset(30, 'detail');
    expect(Math.hypot(o.x, o.z)).toBeCloseTo(10.5, 1);
  });

  it('moves the weather layer at 0.40 m/s — 30 s is about 12 m', () => {
    // 两份速度不同，单偏移装不下。
    const o = driftOffset(30, 'weather');
    expect(Math.hypot(o.x, o.z)).toBeCloseTo(12, 1);
    expect(DOME_DRIFT.weatherMetresPerSecond).not.toBe(DOME_DRIFT.detailMetresPerSecond);
  });

  it('advances only with elapsed time', () => {
    expect(driftOffset(12.5, 'detail')).toEqual(driftOffset(12.5, 'detail'));
  });

  it('is finite for negative and non-finite input', () => {
    expect(Number.isFinite(driftOffset(-3, 'detail').x)).toBe(true);
    expect(Number.isFinite(driftOffset(Number.NaN, 'weather').x)).toBe(true);
  });
});