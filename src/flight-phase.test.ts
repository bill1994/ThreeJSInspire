/**
 * src/flight-phase.test.ts — Batch A (feel).
 *
 * The design doc retires "airspeed never drops below MIN_SPEED, altitude is
 * hard-clamped". In its place: an energy model that can actually run out. Hold the
 * nose up and the plane bleeds airspeed to zero, hangs at the apex, then gravity
 * takes over — the nose drops, the fall accelerates, and only a rebuilt dive
 * airspeed hands control back. Fly level and low and it skims the deck instead.
 */
import { describe, it, expect } from 'vitest';
import { createFlightState, stepFlight, FLIGHT, type FlightState } from './game';
import { STALL } from './stall';
import { SKIM, skim01, waterHit01 } from './skim';

const DT = 1 / 60;

type Steer = { x: number; y: number };

const LEVEL: Steer = { x: 0, y: 0 };
const NOSE_UP: Steer = { x: 0, y: -1 };

function run(s: FlightState, seconds: number, steer: Steer): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i += 1) stepFlight(s, DT, steer);
}

/** Pinned back-stick until the model reports the apex hover; seconds elapsed, or -1. */
function climbToHover(s: FlightState, maxSeconds = 30): number {
  const n = Math.round(maxSeconds / DT);
  for (let i = 0; i < n; i += 1) {
    stepFlight(s, DT, NOSE_UP);
    if (s.phase === 'hover') return i * DT;
  }
  return -1;
}

/** Let the hang run out so the plane is in free fall. */
function settleIntoFall(s: FlightState, steer: Steer = NOSE_UP): void {
  let guard = 0;
  while (s.phase === 'hover' && guard < 600) {
    stepFlight(s, DT, steer);
    guard += 1;
  }
}

describe('energy: the climb can run out of airspeed', () => {
  it('runs out of energy and hangs at the apex on a pinned nose-up stick', () => {
    const s = createFlightState();
    expect(climbToHover(s)).toBeGreaterThan(0);
  });

  it('holds the apex attitude and position for about HOVER_HOLD', () => {
    const s = createFlightState();
    climbToHover(s);
    const y0 = s.pos.y;
    const x0 = s.pos.x;

    let held = 0;
    while (s.phase === 'hover' && held < 600) {
      stepFlight(s, DT, NOSE_UP);
      held += 1;
    }

    expect(held * DT).toBeGreaterThanOrEqual(FLIGHT.HOVER_HOLD - 2 * DT);
    expect(Math.abs(s.pos.y - y0)).toBeLessThan(0.5);
    expect(Math.abs(s.pos.x - x0)).toBeLessThan(0.5);
  });

  it('freezes the airframe briefly on hover entry (hit-stop)', () => {
    const s = createFlightState();
    climbToHover(s);
    expect(s.freeze).toBeGreaterThan(0);

    const before = s.freeze;
    stepFlight(s, DT, NOSE_UP);
    expect(s.freeze).toBeLessThan(before);
    expect(s.phase).toBe('hover');
  });

  it('drops the nose and accelerates the sink after the hang', () => {
    const s = createFlightState();
    climbToHover(s);
    settleIntoFall(s);
    expect(s.phase).toBe('fall');

    run(s, 1, NOSE_UP);
    expect(s.pitch).toBeLessThan(0);
    expect(s.vy).toBeLessThan(0);
    expect(s.vy).toBeGreaterThanOrEqual(-FLIGHT.FALL_MAX_SINK - 1e-6);
  });

  it('hands control back once the dive rebuilds STALL_SPEED of airspeed', () => {
    const s = createFlightState();
    climbToHover(s);
    settleIntoFall(s);

    let guard = 0;
    while (s.phase === 'fall' && guard < 1800) {
      stepFlight(s, DT, NOSE_UP);
      guard += 1;
    }

    expect(s.phase).toBe('cruise');
    expect(s.speed).toBeGreaterThanOrEqual(FLIGHT.STALL_SPEED);
  });

  it('keeps airspeed inside 0..MAX_SPEED and stays in the altitude band for a minute', () => {
    const s = createFlightState();
    for (let i = 0; i < 3600; i += 1) {
      stepFlight(s, DT, NOSE_UP);
      expect(Number.isFinite(s.speed)).toBe(true);
      expect(Number.isFinite(s.pos.y)).toBe(true);
      expect(s.speed).toBeGreaterThanOrEqual(0);
      expect(s.speed).toBeLessThanOrEqual(FLIGHT.MAX_SPEED + 1e-6);
      expect(s.pos.y).toBeGreaterThanOrEqual(FLIGHT.ALT_MIN - 1e-6);
      expect(s.pos.y).toBeLessThanOrEqual(FLIGHT.ALT_MAX + 1e-6);
    }
  });

  it('balances thrust against drag exactly at cruise speed', () => {
    // DRAG_K is a literal (it cannot reference THRUST/CRUISE_SPEED in the same object),
    // so pin the relationship: level cruise must neither speed up nor bleed.
    expect(FLIGHT.DRAG_K).toBeCloseTo(FLIGHT.THRUST / (FLIGHT.CRUISE_SPEED * FLIGHT.CRUISE_SPEED), 12);
  });

  it('does not hover while flying level at cruise speed', () => {
    const s = createFlightState();
    for (let i = 0; i < 600; i += 1) {
      stepFlight(s, DT, LEVEL);
      expect(s.phase).toBe('cruise');
    }
  });

  it('treats ALT_MAX as a soft ceiling instead of a clip that eats the climb', () => {
    const s = createFlightState();
    s.pos.y = FLIGHT.ALT_MAX - 10;
    s.speed = FLIGHT.MAX_SPEED;

    let peak = s.pos.y;
    for (let i = 0; i < Math.round(8 / DT); i += 1) {
      stepFlight(s, DT, NOSE_UP);
      peak = Math.max(peak, s.pos.y);
      expect(s.pos.y).toBeLessThanOrEqual(FLIGHT.ALT_MAX + 1e-6);
    }

    // Reached the ceiling, then came back off it — a sticky clamp would hold y there.
    expect(peak).toBeCloseTo(FLIGHT.ALT_MAX, 6);
    expect(s.pos.y).toBeLessThan(FLIGHT.ALT_MAX);
  });
});

describe('the deck: skim instead of crash', () => {
  it('catches a fall on the deck and puts the plane back in cruise', () => {
    const s = createFlightState();
    s.pos.y = 20;
    s.phase = 'fall';
    s.vy = -20;
    s.pitch = -0.8;
    s.speed = 10;

    run(s, 10, LEVEL);

    expect(s.pos.y).toBeGreaterThanOrEqual(FLIGHT.ALT_MIN - 1e-6);
    expect(s.phase).toBe('cruise');
  });

  it('locks the deck altitude while skimming level and low', () => {
    const s = createFlightState();
    s.pos.y = 16;
    run(s, 8, { x: 0, y: 0.1 });

    expect(s.skim).toBeGreaterThan(0.6);
    expect(s.pos.y).toBeGreaterThanOrEqual(FLIGHT.ALT_MIN);
    expect(s.pos.y).toBeLessThanOrEqual(FLIGHT.ALT_MIN + 1.3);
    expect(s.phase).toBe('cruise');
  });

  it('judges a steep dive into the water a hit and pulls up gently', () => {
    const s = createFlightState();
    s.pos.y = FLIGHT.ALT_MIN + 3;
    s.pitch = -0.9;
    s.speed = 60;

    let hit = 0;
    for (let i = 0; i < 180; i += 1) {
      stepFlight(s, DT, { x: 0, y: 1 });
      hit = Math.max(hit, s.waterHit);
    }

    expect(hit).toBeGreaterThan(0);
    expect(s.pos.y).toBeGreaterThanOrEqual(FLIGHT.ALT_MIN - 1e-6);
  });

  it('does not report a hit for a level skim', () => {
    const s = createFlightState();
    s.pos.y = 16;
    let hit = 0;
    for (let i = 0; i < 480; i += 1) {
      stepFlight(s, DT, { x: 0, y: 0.1 });
      hit = Math.max(hit, s.waterHit);
    }
    expect(hit).toBe(0);
  });
});

describe('skim gate (pure)', () => {
  it('mirrors FLIGHT.ALT_MIN + 1 at the deck', () => {
    expect(SKIM.DECK_Y).toBeCloseTo(FLIGHT.ALT_MIN + 1, 6);
  });

  it('reads 1 level at the deck and 0 high above it', () => {
    expect(skim01(SKIM.DECK_Y, 0)).toBeCloseTo(1, 5);
    expect(skim01(SKIM.FADE_Y + 20, 0)).toBe(0);
    expect(skim01(FLIGHT.ALT_MAX, 0)).toBe(0);
  });

  it('closes as the attitude leaves level flight', () => {
    const level = skim01(SKIM.DECK_Y, 0);
    const banked = skim01(SKIM.DECK_Y, -SKIM.LEVEL_OUT - 0.2);
    expect(banked).toBeLessThan(level);
    expect(banked).toBe(0);
  });

  it('rises monotonically as the plane nears the deck', () => {
    let prev = 0;
    for (let y = SKIM.FADE_Y + 5; y >= SKIM.DECK_Y; y -= 0.5) {
      const v = skim01(y, 0);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
    expect(prev).toBeCloseTo(1, 5);
  });

  it('only reports a water hit when the contact is steep or fast', () => {
    expect(waterHit01(SKIM.DECK_Y, 0, 2)).toBe(0);
    expect(waterHit01(SKIM.DECK_Y, -1.0, 4)).toBeGreaterThan(0.5);
    expect(waterHit01(SKIM.DECK_Y, 0, 30)).toBeGreaterThan(0.5);
    expect(waterHit01(SKIM.FADE_Y + 40, -1.0, 40)).toBe(0);
  });
});

describe('stall constants after the energy change', () => {
  it('adds a gravity constant to STALL', () => {
    expect(STALL.G_SINK).toBeGreaterThan(0);
  });

  it('keeps stall biting at zero airspeed', () => {
    expect(STALL.DRAG).toBeLessThan(12);
  });
});
