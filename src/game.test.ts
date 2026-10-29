import { describe, it, expect } from 'vitest';
import { stepFlight, createFlightState, FLIGHT, type FlightState } from './game';

const finite = (s: FlightState): boolean =>
  [s.pos.x, s.pos.y, s.pos.z, s.yaw, s.pitch, s.bank, s.speed].every((n) => Number.isFinite(n));

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
    // Moderate pull: a FULL nose-up hold now stalls by design (see the stall test
    // below and Review Focus #3 — the ceiling must answer a pinned stick), so the
    // plain climb case is a stick that stays below the critical AoA.
    const up = createFlightState();
    const y0 = up.pos.y;
    for (let i = 0; i < 45; i += 1) stepFlight(up, 1 / 60, { x: 0, y: -0.45 });
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
  });

  it('drops altitude when the stick is held full up at high pitch', () => {
    const s = createFlightState();
    s.pos.y = 200; // room to fall (Task 10 raises the ceiling to 240)
    s.speed = FLIGHT.MIN_SPEED; // slow: no energy to trade
    // steer y = -1 is drag UP in this repo (pitchTarget = -MAX_PITCH * y): full nose-up.
    // The plan drafted y:+1, which dives here and could never stall.
    for (let i = 0; i < 240; i += 1) stepFlight(s, 1 / 60, { x: 0, y: -1 });
    expect(s.stall).toBeGreaterThan(0.3);
    expect(s.pos.y).toBeLessThan(200);
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
