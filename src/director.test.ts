import { describe, it, expect } from 'vitest';
import { DIRECTOR, directorCurve, createDirector } from './director';
import { CAM_FOV_KICK } from './camera-rig';

const calm = { speed01: 0.3, bank: 0, stall01: 0, inCloud01: 0, dive01: 0 };

describe('directorCurve', () => {
  it('stays inside the caps no matter the input', () => {
    const wild = { speed01: 1, bank: 1.05, stall01: 1, inCloud01: 1, dive01: 1 };
    const out = directorCurve(wild);
    expect(out.fovExtra).toBeGreaterThanOrEqual(0);
    expect(out.fovExtra).toBeLessThanOrEqual(3); // 9 - 6 = 3 headroom under CAM_FOV_KICK
    expect(out.bankFollow).toBeGreaterThanOrEqual(0.28);
    expect(out.bankFollow).toBeLessThanOrEqual(0.5);
  });

  it('widens the follow on a dive and tightens it when calm', () => {
    expect(directorCurve({ ...calm, dive01: 1 }).bankFollow)
      .toBeGreaterThan(directorCurve(calm).bankFollow);
    expect(directorCurve(calm)).toEqual({ fovExtra: 0, bankFollow: 0.28 });
  });

  it('keeps the director inside the camera rig FOV cap', () => {
    expect(DIRECTOR.FOV_BASE + DIRECTOR.FOV_DIVE).toBeLessThanOrEqual(CAM_FOV_KICK);
  });

  it('survives NaN input without poisoning the camera', () => {
    expect(directorCurve({ speed01: Number.NaN, bank: 0, stall01: 0, inCloud01: 0, dive01: 0 }))
      .toEqual({ fovExtra: 0, bankFollow: 0.28 });
  });
});

describe('createDirector', () => {
  it('hits on the frame a stall starts, then goes quiet', () => {
    const d = createDirector();
    expect(d.update(1 / 60, calm).traumaHit).toBe(0);
    const hit = d.update(1 / 60, { ...calm, stall01: 0.8 }).traumaHit;
    expect(hit).toBeCloseTo(DIRECTOR.HIT_STALL, 6);
    expect(d.update(1 / 60, { ...calm, stall01: 0.8 }).traumaHit).toBe(0); // no per-frame retrigger
  });

  it('resets so a second stall hits again', () => {
    const d = createDirector();
    d.update(1 / 60, { ...calm, stall01: 0.8 });
    d.reset();
    expect(d.update(1 / 60, { ...calm, stall01: 0.8 }).traumaHit).toBe(DIRECTOR.HIT_STALL);
  });
});
