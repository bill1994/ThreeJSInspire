/**
 * src/flight-seacushion.test.ts — P0-2 海垫 + 海碎抖（设计 §Q2）。
 *
 * 海面不是墙，是垫子：18m 进垫层姿态先被托住（pitchTarget 下限 −0.25，
 * bank 回正 ×1.5），12m 进底层直接钳 playerPitch（下限 −0.12，bank 回正
 * ×2.0），松杆自动配平到 +0.05。垫层内阻力 −10%，压杆贴海只能缓降。
 */
import { describe, it, expect } from 'vitest';
import { createFlightState, stepFlight, FLIGHT, type FlightState } from './game';
import { SKIM } from './skim';

const DT = 1 / 60;

type Steer = { x: number; y: number };

const LEVEL: Steer = { x: 0, y: 0 };
const PUSH_DOWN: Steer = { x: 0, y: 1 };

function run(s: FlightState, seconds: number, steer: Steer): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i += 1) stepFlight(s, DT, steer);
}

/** Cruise setup at a given altitude, wings level, flying speed. */
function cruiseAt(y: number): FlightState {
  const s = createFlightState(y);
  s.phase = 'cruise';
  s.pos.y = y;
  s.speed = 40;
  s.pitch = 0;
  s.bank = 0;
  s.vy = 0;
  s.stall = 0;
  s.apexCooldown = 0;
  s.hadPushover = false;
  s.stickLoose = true;
  return s;
}

describe('P0-2 垫层常量（设计 §Q2）', () => {
  it('exposes the cushion / rumble heights and the two pitch floors', () => {
    expect(SKIM.SEA_CUSHION_Y).toBe(18);
    expect(SKIM.SEA_RUMBLE_Y).toBe(12);
    expect(SKIM.PITCH_FLOOR_DEEP).toBe(-0.25);
    expect(SKIM.PITCH_FLOOR_FLOOR).toBe(-0.12);
  });
});

describe('P0-2 中层姿态托（12m < y < 18m）', () => {
  it('floors the pitch target at -0.25 on a pinned push-down', () => {
    const s = cruiseAt(15);
    run(s, 2, PUSH_DOWN);
    expect(s.pitch).toBeGreaterThanOrEqual(SKIM.PITCH_FLOOR_DEEP - 0.02);
  });

  it('lets the same push-down through at altitude (the test can discriminate)', () => {
    // 1 s only: a longer push would dive into the cushion and prove nothing.
    const s = cruiseAt(60);
    run(s, 1, PUSH_DOWN);
    expect(s.pos.y).toBeGreaterThan(SKIM.SEA_CUSHION_Y);
    expect(s.pitch).toBeLessThan(-0.4);
  });
});

describe('P0-2 底层硬钳（y < 12m）', () => {
  it('floors the stick command at -0.12, not just the target', () => {
    // cruise holds no separate command state: the spec's "playerPitch" IS the
    // stick command feeding the attack blend, so flooring it is observable as
    // the pitch never dropping below the floor even transiently.
    const s = cruiseAt(8);
    let minPitch = 0;
    for (let i = 0; i < Math.round(1 / DT); i += 1) {
      stepFlight(s, DT, PUSH_DOWN);
      minPitch = Math.min(minPitch, s.pitch);
    }
    expect(s.pitch).toBeGreaterThanOrEqual(SKIM.PITCH_FLOOR_FLOOR - 0.03);
    expect(minPitch).toBeGreaterThanOrEqual(SKIM.PITCH_FLOOR_FLOOR - 0.03);
  });

  it('auto-trims toward +0.05 on a loose stick', () => {
    // 1 s window: the trim works so well the plane climbs out of the deck layer
    // on its own — assert the nose-up AND the climb it produces.
    const s = cruiseAt(8);
    run(s, 1, LEVEL);
    expect(s.pitch).toBeGreaterThanOrEqual(0.04);
    expect(s.pos.y).toBeGreaterThan(8);
  });
});

describe('P0-2 bank 回正加速', () => {
  it('recenters bank faster inside the cushion than outside', () => {
    const deep = cruiseAt(15);
    deep.bank = 0.5;
    const floor = cruiseAt(8);
    floor.bank = 0.5;
    const free = cruiseAt(30);
    free.bank = 0.5;
    run(deep, 0.5, LEVEL);
    run(floor, 0.5, LEVEL);
    run(free, 0.5, LEVEL);
    expect(deep.bank).toBeLessThan(free.bank);
    expect(floor.bank).toBeLessThan(deep.bank);
  });
});

describe('P0-2 压杆贴海只能缓降', () => {
  it('sinks far slower than the same push-down at altitude', () => {
    const low = cruiseAt(15);
    const high = cruiseAt(40);
    run(low, 1, PUSH_DOWN);
    run(high, 1, PUSH_DOWN);
    const sinkLow = -(Math.sin(low.pitch) * low.speed + low.vy);
    const sinkHigh = -(Math.sin(high.pitch) * high.speed + high.vy);
    expect(sinkHigh).toBeGreaterThan(10);
    expect(sinkLow).toBeLessThan(sinkHigh * 0.7);
  });

  it('kisses the deck on a pinned push without ever scoring a crash', () => {
    const s = cruiseAt(15);
    let minY = s.pos.y;
    for (let i = 0; i < Math.round(6 / DT); i += 1) {
      stepFlight(s, DT, PUSH_DOWN);
      minY = Math.min(minY, s.pos.y);
    }
    // The hard floor (ALT_MIN + skim) still catches the plane, but the cushion
    // arrives so gently the water-hit gate never fires: no crash beat, no trauma.
    expect(minY).toBeGreaterThanOrEqual(FLIGHT.ALT_MIN - 1e-6);
    expect(s.waterHit).toBe(0);
    expect(s.pos.y).toBeLessThanOrEqual(SKIM.SEA_RUMBLE_Y);
  });
});

describe('P0-2 垫层阻力注脚（-10%，更好维持平飞）', () => {
  it('bleeds less speed inside the cushion than above it', () => {
    const low = cruiseAt(15);
    const high = cruiseAt(30);
    run(low, 1, LEVEL);
    run(high, 1, LEVEL);
    expect(low.speed).toBeGreaterThan(high.speed);
  });
});
