/**
 * src/flight-stallwarn.test.ts — P0-5 失速预告 beat（设计 §3.1）。
 *
 * hover/坠落前 0.6s 的三连预告之“判据”部分：sim 只负责把 stallWarn 立起来
 * （cruise + 仰角过门 + 速度进线），抖/台词/带闪/音效四路消费在 game.ts 帧循环。
 * 全部跑无头模拟（createFlightState/stepFlight）。
 */
import { describe, it, expect } from 'vitest';
import { createFlightState, stepFlight, FLIGHT, type FlightState } from './game';

const DT = 1 / 60;

type Steer = { x: number; y: number };

const NOSE_UP: Steer = { x: 0, y: -1 };

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

describe('P0-5 预告判据（设计 §3.1）', () => {
  it('pins the warning margin at 4 m/s above the stall line', () => {
    expect(FLIGHT.STALL_WARN_MARGIN).toBe(4);
  });

  it('raises stallWarn in the approach band, still cruising', () => {
    const s = cruiseAt(120);
    s.pitch = 0.3;
    s.speed = 24; // STALL_SPEED 22 + margin 4 → band [22, 26)
    stepFlight(s, DT, { x: 0, y: 0 });
    expect(s.stallWarn).toBe(true);
    expect(s.phase).toBe('cruise');
  });

  it('warns below the line too while the apex cooldown blocks the event', () => {
    const s = cruiseAt(120);
    s.pitch = 0.3;
    s.speed = 21.5;
    s.apexCooldown = 5;
    stepFlight(s, DT, { x: 0, y: 0 });
    expect(s.phase).toBe('cruise');
    expect(s.stallWarn).toBe(true);
  });

  it('stays quiet with energy to spare', () => {
    const s = cruiseAt(120);
    s.pitch = 0.3;
    s.speed = 30;
    stepFlight(s, DT, { x: 0, y: 0 });
    expect(s.stallWarn).toBe(false);
  });

  it('stays quiet when the nose is not in the stall attitude', () => {
    const s = cruiseAt(120);
    s.pitch = 0.1;
    s.speed = 23;
    stepFlight(s, DT, { x: 0, y: 0 });
    expect(s.stallWarn).toBe(false);
  });

  it('clears the flag on leaving cruise for the event', () => {
    const s = cruiseAt(120);
    s.pitch = 0.3;
    s.speed = 24;
    stepFlight(s, DT, { x: 0, y: 0 });
    expect(s.stallWarn).toBe(true);
    // Force the event: below the line, cooldown spent, no pushover history.
    // (Re-pin the attitude — one cruise step already eased the nose toward 0.)
    s.speed = 21;
    s.pitch = 0.3;
    s.apexCooldown = 0;
    stepFlight(s, DT, { x: 0, y: 0 });
    expect(s.phase).toBe('hover');
    expect(s.stallWarn).toBe(false);
  });

  it('fires the warning strictly before the event on a pinned climb', () => {
    const s = cruiseAt(200);
    s.speed = 44;
    s.pitch = 0;
    let warnStep = -1;
    let eventStep = -1;
    for (let i = 0; i < 3600; i += 1) {
      stepFlight(s, DT, NOSE_UP);
      if (warnStep < 0 && s.stallWarn) warnStep = i;
      if (s.phase !== 'cruise') {
        eventStep = i;
        break;
      }
    }
    expect(warnStep).toBeGreaterThanOrEqual(0);
    expect(eventStep).toBeGreaterThan(warnStep);
    // The beat must be readable: at least ~0.2 s between warn and event.
    expect(eventStep - warnStep).toBeGreaterThanOrEqual(12);
  });
});
