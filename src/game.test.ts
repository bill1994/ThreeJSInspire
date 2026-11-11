import { describe, it, expect } from 'vitest';
import { stepFlight, createFlightState, FLIGHT, type FlightState } from './game';

const sources = import.meta.glob('./game.ts', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

const finite = (s: FlightState): boolean =>
  [s.pos.x, s.pos.y, s.pos.z, s.yaw, s.pitch, s.bank, s.speed].every((n) => Number.isFinite(n));

describe('in-cloud wiring (game → hud / 兜底瓣)', () => {
  const src = sources['./game.ts'];

  it('每帧用视线-太阳夹角喂纱色，白雾与纱色一起交给 hud', () => {
    expect(src).toMatch(/veilTintCss\(/);
    expect(src).toMatch(/hud\?\.setWhiteout\(whiteout01\(camCloud01\), veilTintCss\(fwdDotSun\)\)/);
  });

  it('opts 收活太阳，并把进云度与相机位经 onInCloud 送出去（world 接兜底瓣）', () => {
    expect(src).toMatch(/sunDir\?: \{ x: number; y: number; z: number \}/);
    expect(src).toMatch(/onInCloud\?\.\(/);
  });
});

describe('stepFlight', () => {
  it('starts level, inside the altitude band, at cruise speed', () => {
    const s = createFlightState();
    expect(s.bank).toBe(0);
    expect(s.pitch).toBe(0);
    expect(s.pos.y).toBeGreaterThanOrEqual(FLIGHT.ALT_MIN);
    expect(s.pos.y).toBeLessThanOrEqual(FLIGHT.ALT_MAX);
    expect(s.speed).toBeGreaterThanOrEqual(FLIGHT.MIN_SPEED);
    expect(s.speed).toBeLessThanOrEqual(FLIGHT.MAX_SPEED);
  });

  it('does nothing at dt=0 and stays finite', () => {
    const s = createFlightState();
    const before = { x: s.pos.x, y: s.pos.y, z: s.pos.z, yaw: s.yaw, speed: s.speed };
    stepFlight(s, 0, { x: 1, y: -1 });
    expect(s.pos.x).toBe(before.x);
    expect(s.pos.y).toBe(before.y);
    expect(s.pos.z).toBe(before.z);
    expect(s.yaw).toBe(before.yaw);
    expect(s.speed).toBe(before.speed);
    expect(finite(s)).toBe(true);
  });

  it('clamps a pathological dt so a tab-switch hitch cannot teleport the plane', () => {
    const s = createFlightState();
    const x0 = s.pos.x;
    const y0 = s.pos.y;
    const z0 = s.pos.z;
    stepFlight(s, 5, { x: 0, y: 0 });
    const travelled = Math.hypot(s.pos.x - x0, s.pos.y - y0, s.pos.z - z0);
    expect(travelled).toBeLessThanOrEqual(FLIGHT.MAX_SPEED * FLIGHT.DT_CLAMP + 1e-9);
    expect(finite(s)).toBe(true);
  });

  it('sanitizes NaN steer and NaN dt instead of leaking NaN into the pose', () => {
    const a = createFlightState();
    stepFlight(a, 1 / 60, { x: Number.NaN, y: Number.NaN });
    expect(finite(a)).toBe(true);
    const b = createFlightState();
    stepFlight(b, Number.NaN, { x: 0.5, y: 0.5 });
    expect(finite(b)).toBe(true);
  });

  it('banks right and turns right for a positive horizontal steer', () => {
    const s = createFlightState();
    const yaw0 = s.yaw;
    for (let i = 0; i < 60; i += 1) stepFlight(s, 1 / 60, { x: 1, y: 0 });
    expect(s.bank).toBeGreaterThan(0); // +bank = right wing down
    expect(s.bank).toBeLessThanOrEqual(FLIGHT.MAX_BANK + 1e-9);
    expect(s.yaw).toBeLessThan(yaw0); // yaw decreases when turning right
    expect(finite(s)).toBe(true);
  });

  it('climbs for a negative forward drag and dives for a positive one', () => {
    const up = createFlightState();
    const y0 = up.pos.y;
    for (let i = 0; i < 45; i += 1) stepFlight(up, 1 / 60, { x: 0, y: -1 });
    expect(up.pitch).toBeGreaterThan(0);
    expect(up.pos.y).toBeGreaterThan(y0);

    const down = createFlightState();
    for (let i = 0; i < 45; i += 1) stepFlight(down, 1 / 60, { x: 0, y: 1 });
    expect(down.pitch).toBeLessThan(0);
    expect(finite(down)).toBe(true);
  });

  it('always advances along its own nose at roughly the current speed', () => {
    const s = createFlightState();
    const x0 = s.pos.x;
    const y0 = s.pos.y;
    const z0 = s.pos.z;
    stepFlight(s, 1 / 60, { x: 0, y: 0 });
    const step = Math.hypot(s.pos.x - x0, s.pos.y - y0, s.pos.z - z0);
    expect(step).toBeGreaterThan(0);
    expect(step).toBeLessThanOrEqual(s.speed * (1 / 60) + 1e-6);
  });

  it('never leaves the altitude band, even when held in a climb for 20 s', () => {
    const s = createFlightState();
    for (let i = 0; i < 1200; i += 1) {
      stepFlight(s, 1 / 60, { x: 0, y: -1 });
      expect(s.pos.y).toBeLessThanOrEqual(FLIGHT.ALT_MAX + 1e-6);
      expect(s.pos.y).toBeGreaterThanOrEqual(FLIGHT.ALT_MIN - 1e-6);
    }
    expect(finite(s)).toBe(true);
    // The band is a boundary, not a resting place: a pinned zoom climb now
    // porpoises gently at the ceiling (hover → pushover → climb again) instead
    // of pinning dead still — and the old free-fall drop is gone.
    expect(s.pos.y).toBeGreaterThan(FLIGHT.ALT_MAX - 15);
  });

  it('answers a pinned full nose-up stick with a climb, not a dive', () => {
    // A stall may lower the nose and bleed speed, but the primary control must never
    // reverse: full back-stick still gains altitude.
    const s = createFlightState();
    const y0 = s.pos.y;
    for (let i = 0; i < 120; i += 1) stepFlight(s, 1 / 60, { x: 0, y: -1 });
    expect(s.pos.y).toBeGreaterThan(y0 + 10);
    expect(s.stall).toBeGreaterThan(0.3); // the stall is real, it just does not dive
  });

  it('can climb from the spawn into the cloud band on a pinned stick', () => {
    // 近景云最高顶到 ALT_MAX（240 m），爬升必须明显高过出生带才谈得上「在云里」。
    // Tracked as a peak because the zoom climb now tops out and falls back.
    const s = createFlightState();
    let peak = s.pos.y;
    for (let i = 0; i < 60 * 15; i += 1) {
      stepFlight(s, 1 / 60, { x: 0, y: -1 });
      peak = Math.max(peak, s.pos.y);
    }
    expect(peak).toBeGreaterThan(120);
  });

  it('stays finite and bounded over a long wiggling flight', () => {
    const s = createFlightState();
    for (let i = 0; i < 3600; i += 1) {
      const t = i / 60;
      stepFlight(s, 1 / 60, { x: Math.sin(t * 1.7), y: Math.cos(t * 0.9) });
      const len = Math.hypot(s.pos.x, s.pos.y, s.pos.z);
      expect(Number.isFinite(len)).toBe(true);
      expect(len).toBeLessThan(FLIGHT.MAX_SPEED * 3600);
    }
    expect(finite(s)).toBe(true);
  });
});
