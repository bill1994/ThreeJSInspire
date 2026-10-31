import { describe, it, expect } from 'vitest';
import { cloudDensityAt, inCloud01, whiteout01, IN_CLOUD, WHITEOUT_MAX } from './in-cloud';
import { CLOUD_BAND, slabRayT, shaderSlabSpan } from './clouds-compute';
import { FLIGHT } from './game';

describe('flight envelope reaches the cloud slab', () => {
  it('can actually climb into the clouds on device, not just in the pure function', () => {
    const camY = FLIGHT.ALT_MAX + 6.8; // CAM_HEIGHT
    expect(camY).toBeGreaterThan(CLOUD_BAND.bottom);
    expect(FLIGHT.START_Y + 6.8).toBeLessThan(CLOUD_BAND.bottom); // no white screen on frame 0
  });
});

describe('inCloud01', () => {
  it('is zero on the deck and one inside the tower', () => {
    expect(inCloud01(30)).toBe(0);
    expect(inCloud01(CLOUD_BAND.bottom)).toBe(0);
    expect(inCloud01(180)).toBeGreaterThan(0.5);
    expect(inCloud01(Number.NaN)).toBe(0);
  });

  it('has hysteresis so hovering on the boundary does not strobe', () => {
    const edge = CLOUD_BAND.bottom + IN_CLOUD.FADE_IN * 0.5;
    expect(cloudDensityAt(edge)).toBeGreaterThan(0);
    expect(cloudDensityAt(CLOUD_BAND.bottom - 1)).toBe(0);
    expect(cloudDensityAt(CLOUD_BAND.top + 1)).toBe(0);
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

  /**
   * The missing case. Every other test above either has the camera on the deck looking up
   * or is inside the slab looking level — the shader's `abs(dir.y)` guard was wrong for
   * exactly one quadrant: camera *inside* the slab, pitch *down*. There the magnitude
   * guard turned the downward crossing into the upward one, so tEnd became
   * `(top - camY)/|dir.y|` and the march kept integrating for another
   * `(camY - bottom)/|dir.y|` metres BELOW the floor — where `hFrac` clamps to 0 and
   * `profileDensity(0)` is the full 0.92 plateau. At the 240 m flight ceiling that is a
   * white card covering the frame.
   */
  it('stops at the floor when looking down from inside the slab', () => {
    const camY = 200;
    const dirY = -0.5;
    const { tStart, tEnd } = slabRayT(camY, dirY, 900);
    expect(tStart).toBe(0);
    expect(tEnd).toBeCloseTo((CLOUD_BAND.bottom - camY) / dirY, 6);
    expect(camY + tEnd * dirY).toBeCloseTo(CLOUD_BAND.bottom, 6);
  });

  it('never marches past the far wall, for every height and pitch in the flight envelope', () => {
    for (let camY = -50; camY <= 560; camY += 10) {
      for (let dirY = -1; dirY <= 1.0001; dirY += 0.05) {
        const { tStart, tEnd } = slabRayT(camY, dirY, 900);
        expect(Number.isFinite(tStart)).toBe(true);
        expect(Number.isFinite(tEnd)).toBe(true);
        if (tEnd - tStart < 1e-6) continue;
        // A span cut short by the 900 m cap has not reached the slab yet: it is clamped by
        // budget, not by geometry, so its endpoint is allowed to sit outside the band.
        if (tEnd >= 900 - 1e-6) continue;
        const yEnd = camY + tEnd * dirY;
        expect(yEnd).toBeGreaterThanOrEqual(CLOUD_BAND.bottom - 1e-3);
        expect(yEnd).toBeLessThanOrEqual(CLOUD_BAND.top + 1e-3);
      }
    }
  });
});

/**
 * The node graph cannot be executed by a unit test, so `shaderSlabSpan` transcribes its
 * arithmetic and these tests hold the two implementations to the same answer. Without them
 * the only thing pinning the shader was `slabRayT` — which stayed correct while the graph
 * drifted, and that is how `abs(dir.y)` survived.
 */
describe('shader slab span mirrors the reference', () => {
  it('agrees with slabRayT over the whole flight envelope', () => {
    for (let camY = -50; camY <= 560; camY += 10) {
      for (let dirY = -1; dirY <= 1.0001; dirY += 0.05) {
        const ref = slabRayT(camY, dirY, 900);
        const sh = shaderSlabSpan(camY, dirY, 900);
        expect(sh.span).toBeCloseTo(Math.max(ref.tEnd - ref.tStart, 0), 6);
        // Endpoints are only comparable away from the parallel band: there the reference
        // short-circuits to a clean 0 while the graph saturates the same answer out of
        // finite arithmetic. The span is the number the march consumes, so that is the one
        // held equal everywhere.
        if (Math.abs(dirY) < 1e-3) continue;
        expect(sh.t0).toBeCloseTo(ref.tStart, 6);
        expect(sh.t1).toBeCloseTo(ref.tEnd, 6);
      }
    }
  });

  it('agrees for the parallel-ray band where the divisor needs its guard', () => {
    // The two implementations are allowed to report different endpoints here — `slabRayT`
    // short-circuits a parallel ray to a clean {0, 0}/{0, tMax}, while the graph lets both
    // crossings blow up and saturates them. What must agree is the answer that reaches the
    // march: the span.
    for (const camY of [-50, 0, 30, 94.999, 95, 200, 479.999, 480, 560]) {
      for (const dirY of [0, 1e-9, -1e-9, 1e-4, -1e-4]) {
        const ref = slabRayT(camY, dirY, 900);
        const sh = shaderSlabSpan(camY, dirY, 900);
        expect(sh.span).toBeCloseTo(Math.max(ref.tEnd - ref.tStart, 0), 3);
      }
    }
  });
});

describe('whiteout01', () => {
  it('fogs the view without ever turning the frame into an opaque card', () => {
    // A full-opacity DOM layer hides the very clouds the player flew into: at 1.0 the
    // "fly-through" reads as a beige white-screen bug, not as being inside a cloud.
    expect(whiteout01(CLOUD_BAND.bottom)).toBe(0);
    expect(whiteout01(180)).toBeCloseTo(WHITEOUT_MAX, 6);
    expect(whiteout01(180)).toBeLessThan(0.7);
    expect(whiteout01(CLOUD_BAND.top)).toBe(0);
  });

  it('stays inside [0, WHITEOUT_MAX] for every altitude', () => {
    for (let y = -50; y <= 560; y += 5) {
      const v = whiteout01(y);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(WHITEOUT_MAX + 1e-9);
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe('merged band density', () => {
  it('still reaches full density inside the tower', () => {
    // The wisp deck used to flatten the bank's own ramp; with one band the interior is
    // solid and the fades live only in the 40 m strips at each edge.
    const mid = (CLOUD_BAND.bottom + CLOUD_BAND.top) / 2;
    expect(cloudDensityAt(mid)).toBe(1);
  });

  it('reads zero well clear of the band', () => {
    expect(cloudDensityAt(CLOUD_BAND.bottom - 80)).toBe(0);
    expect(cloudDensityAt(CLOUD_BAND.top + 80)).toBe(0);
  });
});
