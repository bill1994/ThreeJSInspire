import { describe, it, expect } from 'vitest';
import { cloudDensityAt, inCloud01, whiteout01, IN_CLOUD, WHITEOUT_MAX } from './in-cloud';
import { slabRayT } from './clouds-compute';
import { CLOUD_BOTTOM, CLOUD_TOP } from './clouds-compute';
import { FLIGHT } from './game';

describe('flight envelope reaches the cloud slab', () => {
  it('can actually climb into the clouds on device, not just in the pure function', () => {
    const camY = FLIGHT.ALT_MAX + 6.8; // CAM_HEIGHT
    expect(camY).toBeGreaterThan(CLOUD_BOTTOM);
    expect(FLIGHT.START_Y + 6.8).toBeLessThan(CLOUD_BOTTOM); // no white screen on frame 0
  });
});

describe('inCloud01', () => {
  it('is zero on the deck and one in the middle of the slab', () => {
    expect(inCloud01(30)).toBe(0);
    expect(inCloud01(CLOUD_BOTTOM)).toBe(0);
    expect(inCloud01(180)).toBeGreaterThan(0.5);
    expect(inCloud01(Number.NaN)).toBe(0);
  });

  it('has hysteresis so hovering on the boundary does not strobe', () => {
    const edge = CLOUD_BOTTOM + IN_CLOUD.FADE_IN * 0.5;
    expect(cloudDensityAt(edge)).toBeGreaterThan(0);
    expect(cloudDensityAt(CLOUD_BOTTOM - 1)).toBe(0);
    expect(cloudDensityAt(CLOUD_TOP + 1)).toBe(0);
  });
});

describe('slabRayT', () => {
  it('starts at the camera when the camera is already inside the slab', () => {
    expect(slabRayT(180, 0, 2000).tStart).toBe(0);
  });

  it('starts ahead of the camera when looking up from the deck', () => {
    const { tStart, tEnd } = slabRayT(30, 0.9, 2000);
    expect(tStart).toBeGreaterThan(0);
    expect(tEnd).toBeGreaterThan(tStart);
  });

  it('returns an empty span when the ray never reaches the slab', () => {
    const { tStart, tEnd } = slabRayT(0, -1, 2000);
    expect(tEnd).toBeLessThanOrEqual(tStart);
  });
});

describe('whiteout01', () => {
  it('fogs the view without ever turning the frame into an opaque card', () => {
    // A full-opacity DOM layer hides the very clouds the player flew into: at 1.0 the
    // "fly-through" reads as a beige white-screen bug, not as being inside a cloud.
    expect(whiteout01(CLOUD_BOTTOM)).toBe(0);
    expect(whiteout01(180)).toBeCloseTo(WHITEOUT_MAX, 6);
    expect(whiteout01(180)).toBeLessThan(0.7);
    expect(whiteout01(CLOUD_TOP)).toBe(0);
  });

  it('stays inside [0, WHITEOUT_MAX] for every altitude', () => {
    for (let y = -50; y <= 400; y += 5) {
      const v = whiteout01(y);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(WHITEOUT_MAX + 1e-9);
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});
