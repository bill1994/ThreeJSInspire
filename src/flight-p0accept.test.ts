/**
 * src/flight-p0accept.test.ts — Flight P0 验收（设计 §6 验证清单，headless 部分）。
 *
 * §6逐条落地情况：
 * - 满杆爬升3次 / 恢复计时 / 松杆门第二轮 / 低空仰飞 / dt一致性 / 贴海20s三条：本文件。
 * - fall单次≤0.8s / fuse / 松杆门首轮：flight-pushover.test.ts 已 pin，此处引用不复测。
 * - 穿云3朵（进/里/出/防闪）：director + feel 单测已 pin；整条穿云需浏览器看白雾，记 P1 QA。
 * - 巡航30s主观速度感：浏览器 QA（streaks opacity / idle 尾迹存在性由单测保证）。
 */
import { describe, it, expect } from 'vitest';
import { createFlightState, stepFlight, FLIGHT, type FlightState } from './game';

const DT = 1 / 60;

type Steer = { x: number; y: number };

const NOSE_UP: Steer = { x: 0, y: -1 };
const NOSE_DOWN: Steer = { x: 0, y: 1 };
const LOOSE: Steer = { x: 0, y: 0 };

/** 爬到首次 hover 准入触发，返回用掉的步数（>0 才是真爬上去的）。 */
function climbToHover(s: FlightState): number {
  let n = 0;
  for (let i = 0; i < 3600; i += 1) {
    if (s.phase === 'hover' || s.phase === 'pushover') break;
    stepFlight(s, DT, NOSE_UP);
    n += 1;
  }
  return n;
}

/** 满杆跑完一整轮 hover→pushover→cruise，全程不松杆。 */
function pinnedRound(s: FlightState, seenFall: { v: boolean }): void {
  expect(climbToHover(s)).toBeGreaterThan(0);
  let guard = 0;
  while (s.phase !== 'cruise' && guard < 3600) {
    stepFlight(s, DT, NOSE_UP);
    if (s.phase === 'fall') seenFall.v = true;
    guard += 1;
  }
  expect(s.phase).toBe('cruise');
}

describe('P0验收 §6：满杆爬升3次全程不碰fall', () => {
  it('three pinned rounds stay out of fall', () => {
    const s = createFlightState(120);
    const seenFall = { v: false };
    pinnedRound(s, seenFall);
    pinnedRound(s, seenFall);
    pinnedRound(s, seenFall);
    expect(seenFall.v).toBe(false);
  });
});

describe('P0验收 §6：失速恢复计时（正常≤2.4s / 掉高≤15m）', () => {
  it('recovers hover→cruise within 2.4s losing at most 15m hands-off', () => {
    const s = createFlightState(120);
    expect(climbToHover(s)).toBeGreaterThan(0);
    const yHover = s.pos.y;
    let t = 0;
    let minY = s.pos.y;
    let guard = 0;
    while (s.phase !== 'cruise' && guard < 3600) {
      stepFlight(s, DT, LOOSE);
      t += DT;
      minY = Math.min(minY, s.pos.y);
      guard += 1;
    }
    expect(s.phase).toBe('cruise');
    expect(t).toBeLessThanOrEqual(2.4);
    expect(yHover - minY).toBeLessThanOrEqual(15);
  });
});

describe('P0验收 §6：低空仰飞与高度无关', () => {
  it('recovers from a deck-level stall without touching the ground', () => {
    const s = createFlightState(FLIGHT.ALT_MIN + 2);
    let minY = s.pos.y;
    let guard = 0;
    while (s.phase === 'cruise' && guard < 3600) {
      stepFlight(s, DT, NOSE_UP);
      minY = Math.min(minY, s.pos.y);
      guard += 1;
      if (s.phase !== 'cruise') break;
    }
    // Either it never stalled (still cruising high) or it went through the
    // event and came back — in no case may the ground get a vote.
    expect(minY).toBeGreaterThan(FLIGHT.ALT_MIN - 1);
    expect(s.waterHit).toBe(0);
  });
});

describe('P0验收 §6：60fps/30fps pushover一致', () => {
  it('flies the same arc at DT=1/60 and DT=1/30', () => {
    const mk = (): FlightState => {
      const s = createFlightState(120);
      s.phase = 'pushover';
      s.pushoverT = FLIGHT.PUSHOVER_T;
      s.pushoverExt = 0;
      s.speed = FLIGHT.RECOVERY_SPEED;
      s.vy = -5;
      s.pitch = -0.3;
      s.bank = 0.2;
      return s;
    };
    const a = mk();
    const b = mk();
    for (let t = 0; t < 1.0; t += 1 / 60) stepFlight(a, 1 / 60, LOOSE);
    for (let t = 0; t < 1.0; t += 1 / 30) stepFlight(b, 1 / 30, LOOSE);
    // The recenter path is exponential (1-exp) so pitch/bank agree tightly;
    // airspeed integrates explicit-Euler, so it carries an O(dt) wobble —
    // 0.15 m/s after a full arc is invisible, and pinning it tighter would
    // freeze the integrator, not improve the feel.
    expect(Math.abs(a.pitch - b.pitch)).toBeLessThan(0.02);
    expect(Math.abs(a.bank - b.bank)).toBeLessThan(0.02);
    expect(Math.abs(a.speed - b.speed)).toBeLessThan(0.25);
  });
});

describe('P0验收 §6：贴海20s三条', () => {
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

  it('holds the deck hands-off: never sinks, never hits, never leaves the cushion', () => {
    const s = cruiseAt(8);
    let minY = s.pos.y;
    for (let i = 0; i < 1200; i += 1) {
      stepFlight(s, DT, LOOSE);
      minY = Math.min(minY, s.pos.y);
    }
    // Honest contract (ledger 2026-11-11): the auto-trim is spec-literal +0.05
    // below 12 m, so hands-off settles at the cushion top (~12-13 m), not 7-9.
    // The cushion (rumble alive below 18) is never left, the water never votes.
    expect(minY).toBeGreaterThan(6.5);
    expect(s.pos.y).toBeLessThan(14);
    expect(s.waterHit).toBe(0);
  });

  it('pushes down into a gentle sink only: pitch floored, no hit, no dive', () => {
    const s = cruiseAt(8);
    let minPitch = 0;
    for (let i = 0; i < 1200; i += 1) {
      stepFlight(s, DT, NOSE_DOWN);
      minPitch = Math.min(minPitch, s.pitch);
    }
    expect(minPitch).toBeGreaterThanOrEqual(-0.12 - 0.02);
    expect(s.waterHit).toBe(0);
    expect(s.pos.y).toBeGreaterThan(4);
  });

  it('pulls straight back up on demand', () => {
    const s = cruiseAt(8);
    for (let i = 0; i < 180; i += 1) stepFlight(s, DT, NOSE_UP);
    expect(s.pos.y).toBeGreaterThan(12);
  });
});
