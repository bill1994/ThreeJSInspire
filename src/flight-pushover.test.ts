/**
 * src/flight-pushover.test.ts — P0-1 顶点 pushover（TDD RED 先行）。
 *
 * 覆盖设计 §Q1 改法：hover→pushover→fall 三段、入口 snap、硬上限、
 * 松杆门、门挡直进、天花板缓冲。全部跑无头模拟（createFlightState/stepFlight）。
 */
import { describe, it, expect } from 'vitest';
import { createFlightState, stepFlight, FLIGHT, type FlightState } from './game';

const DT = 1 / 60;

type Steer = { x: number; y: number };

const NOSE_UP: Steer = { x: 0, y: -1 };
const LOOSE: Steer = { x: 0, y: 0 };

function run(s: FlightState, seconds: number, steer: Steer): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i += 1) stepFlight(s, DT, steer);
}

/** 满杆爬升直到上报 hover；秒数或 -1。 */
function climbToHover(s: FlightState, maxSeconds = 30): number {
  const n = Math.round(maxSeconds / DT);
  for (let i = 0; i < n; i += 1) {
    stepFlight(s, DT, NOSE_UP);
    if (s.phase === 'hover') return i * DT;
  }
  return -1;
}

describe('P0-1 pushover 常量（设计 §5 速查）', () => {
  it('defines the pushover budget', () => {
    expect(FLIGHT.PUSHOVER_T).toBeCloseTo(1.0, 6);
    expect(FLIGHT.PUSHOVER_PITCH).toBeCloseTo(0.08, 6);
    expect(FLIGHT.PUSHOVER_EXTEND).toBeCloseTo(0.3, 6);
    expect(FLIGHT.PUSHOVER_EXTENSIONS).toBe(2);
  });

  it('defines the snap speed, the fall hard cap and the ceiling cushion', () => {
    expect(FLIGHT.RECOVERY_SPEED).toBeCloseTo(18, 6);
    expect(FLIGHT.FALL_HARD_CAP).toBeCloseTo(0.8, 6);
    expect(FLIGHT.CEILING_CUSHION).toBeCloseTo(30, 6);
  });
});

describe('P0-1 hover 之后进 pushover，不进 fall', () => {
  it('transitions hover -> pushover, never straight to fall', () => {
    const s = createFlightState();
    expect(climbToHover(s)).toBeGreaterThan(0);
    let guard = 0;
    while (s.phase === 'hover' && guard < 600) {
      stepFlight(s, DT, NOSE_UP);
      guard += 1;
    }
    expect(s.phase).toBe('pushover');
  });

  it('snaps airspeed to RECOVERY_SPEED with a small initial sink on entry', () => {
    const s = createFlightState();
    climbToHover(s);
    let guard = 0;
    while (s.phase === 'hover' && guard < 600) {
      stepFlight(s, DT, NOSE_UP);
      guard += 1;
    }
    expect(s.phase).toBe('pushover');
    expect(s.speed).toBeCloseTo(FLIGHT.RECOVERY_SPEED, 6);
    expect(s.vy).toBeLessThanOrEqual(-4);
    expect(s.vy).toBeGreaterThanOrEqual(-6);
  });

  it('exits to cruise near level pitch after PUSHOVER_T', () => {
    const s = createFlightState();
    climbToHover(s);
    let guard = 0;
    while (s.phase !== 'pushover' && guard < 600) {
      stepFlight(s, DT, NOSE_UP);
      guard += 1;
    }
    // 延长打满（满杆）：总时长 1.0 + 2×0.3
    let t = 0;
    guard = 0;
    while (s.phase === 'pushover' && guard < 600) {
      stepFlight(s, DT, NOSE_UP);
      t += DT;
      guard += 1;
    }
    expect(s.phase).toBe('cruise');
    expect(t).toBeGreaterThanOrEqual(1.5);
    expect(t).toBeLessThanOrEqual(1.75);
    expect(s.pitch).toBeGreaterThanOrEqual(-0.05 - 1e-6);
    expect(s.pitch).toBeLessThanOrEqual(0.08 + 0.1);
  });
});

describe('P0-1 硬保证（设计 §Q1：正常 ≤2.4s / 满杆延长 ≤3.0s / 掉高 ≤15m）', () => {
  it('recovers from hover entry to cruise within 2.98s losing at most 15m pinned full-up', () => {
    const s = createFlightState(60);
    expect(climbToHover(s)).toBeGreaterThan(0);
    const yHover = s.pos.y;
    let t = 0;
    let minY = s.pos.y;
    let guard = 0;
    while (s.phase !== 'cruise' && guard < 3600) {
      stepFlight(s, DT, NOSE_UP);
      t += DT;
      minY = Math.min(minY, s.pos.y);
      guard += 1;
    }
    expect(s.phase).toBe('cruise');
    expect(t).toBeLessThanOrEqual(2.98);
    expect(yHover - minY).toBeLessThanOrEqual(15);
  });

  it('falls from the ceiling but never from low altitude, nor onto the deck', () => {
    // A-1 修订了 P0-1 的硬保证：fall 不再是"永不触发"的兜底，而是**顶棚带内失速的
    // 正式表现**（顶部 pushover 的 +0.08 爬升意图会被 ALT_MAX 钳制吃掉，只剩静滞）。
    // 低空失速的手感不变——那里仍然只有 pushover，绝不进 fall。
    const s = createFlightState(60);
    let sawFall = false;
    let fellOutsideCeilingBand = false;
    let touched = false;
    for (let i = 0; i < 3600; i += 1) {
      stepFlight(s, DT, NOSE_UP);
      if (s.phase === 'fall') {
        sawFall = true;
        if (s.pos.y <= FLIGHT.ALT_MAX - FLIGHT.CEILING_CUSHION) fellOutsideCeilingBand = true;
      }
      if (s.waterHit > 0) touched = true;
    }
    expect(sawFall).toBe(true);
    expect(fellOutsideCeilingBand).toBe(false);
    expect(touched).toBe(false);
    expect(s.pos.y).toBeGreaterThan(FLIGHT.ALT_MIN + 1);
  });

  it('caps any single fall segment at FALL_HARD_CAP', () => {
    const s = createFlightState();
    s.pos.y = 120;
    s.phase = 'fall';
    s.vy = -20;
    s.pitch = -0.8;
    s.speed = 10;
    let t = 0;
    let guard = 0;
    while (s.phase === 'fall' && guard < 600) {
      stepFlight(s, DT, LOOSE);
      t += DT;
      guard += 1;
    }
    expect(t).toBeLessThanOrEqual(FLIGHT.FALL_HARD_CAP + 3 * DT);
  });

  it('falls back to legacy fall only on mechanism failure (extensions spent, speed < 13.2)', () => {
    const s = createFlightState();
    s.pos.y = 120;
    s.phase = 'pushover';
    s.pushoverT = 0.01;
    s.pushoverExt = 0;
    s.speed = 10;
    s.pitch = 0;
    s.vy = -2;
    stepFlight(s, DT, LOOSE);
    expect(s.phase).toBe('fall');
  });

  it('exits to cruise when extensions are spent but energy is healthy', () => {
    const s = createFlightState();
    s.pos.y = 120;
    s.phase = 'pushover';
    s.pushoverT = 0.01;
    s.pushoverExt = 0;
    s.speed = 16;
    s.pitch = 0.05;
    s.vy = -2;
    stepFlight(s, DT, LOOSE);
    expect(s.phase).toBe('cruise');
  });
});

describe('P0-1 松杆门与门挡直进（设计 §Q1 复审 R2/R3）', () => {
  /** 满杆爬完一整轮：hover → pushover（延长打满）→ cruise，全程不松杆。 */
  function pinnedRound(s: FlightState): void {
    expect(climbToHover(s)).toBeGreaterThan(0);
    let guard = 0;
    while (s.phase !== 'cruise' && guard < 3600) {
      stepFlight(s, DT, NOSE_UP);
      guard += 1;
    }
    expect(s.phase).toBe('cruise');
  }

  /** 制造一次失速准入（速度掉光、机头上仰、冷却清零）。 */
  function forceStallEntry(s: FlightState): void {
    s.speed = 10;
    s.pitch = 0.5;
    s.apexCooldown = 0;
  }

  it('blocks re-hover on a pinned stick and goes straight to pushover', () => {
    const s = createFlightState(120);
    pinnedRound(s);
    forceStallEntry(s);
    stepFlight(s, DT, NOSE_UP);
    expect(s.phase).toBe('pushover');
  });

  it('allows hover again after the stick has been seen loose', () => {
    const s = createFlightState(120);
    pinnedRound(s);
    run(s, 2, LOOSE);
    forceStallEntry(s);
    stepFlight(s, DT, LOOSE);
    expect(s.phase).toBe('hover');
  });
});

describe('P0-1 天花板缓冲（距顶 30m  pitch 增量打四折）', () => {
  it('damps the climb harder inside the cushion than below it', () => {
    const mk = (y: number): FlightState => {
      const s = createFlightState(y);
      s.phase = 'cruise';
      s.speed = FLIGHT.CRUISE_SPEED;
      s.pitch = 0.2;
      s.apexCooldown = 99;
      return s;
    };
    const free = mk(100);
    const cushioned = mk(FLIGHT.ALT_MAX - 10);
    run(free, 0.5, NOSE_UP);
    run(cushioned, 0.5, NOSE_UP);
    expect(cushioned.pitch).toBeLessThan(free.pitch);
    expect(cushioned.pos.y).toBeLessThanOrEqual(FLIGHT.ALT_MAX + 1e-6);
  });
});
