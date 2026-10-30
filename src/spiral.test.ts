import { describe, expect, it } from 'vitest';
import { SPIRAL, createSpiralState, stepSpiral } from './spiral';

/** Advance the gate for `seconds` at 60 Hz and collect the frames it fired on. */
function run(state: ReturnType<typeof createSpiralState>, bank: number, sink: number, seconds: number): number {
  const dt = 1 / 60;
  const frames = Math.round(seconds / dt);
  let fired = 0;
  for (let i = 0; i < frames; i += 1) if (stepSpiral(state, bank, sink, dt)) fired += 1;
  return fired;
}

describe('spiral dive gate', () => {
  it('stays silent on a level cruise', () => {
    const s = createSpiralState();
    expect(run(s, 0, 0, 10)).toBe(0);
  });

  it('needs both a hard bank and real sink', () => {
    const bankOnly = createSpiralState();
    expect(run(bankOnly, SPIRAL.BANK_MIN + 0.2, 2, 5)).toBe(0);

    const sinkOnly = createSpiralState();
    expect(run(sinkOnly, 0.1, SPIRAL.SINK_MIN + 10, 5)).toBe(0);
  });

  it('fires once the condition has been held for the full window', () => {
    const s = createSpiralState();
    // Just short of the window: nothing yet.
    expect(run(s, 1.0, 20, SPIRAL.HOLD - 0.1)).toBe(0);
    // Cross the window: exactly one fire, not one per frame.
    expect(run(s, 1.0, 20, 0.3)).toBe(1);
  });

  it('resets the hold when the condition is interrupted', () => {
    const s = createSpiralState();
    run(s, 1.0, 20, SPIRAL.HOLD - 0.2);
    // One level frame in the middle wipes the accumulated hold.
    stepSpiral(s, 0, 0, 1 / 60);
    expect(s.held).toBe(0);
    expect(run(s, 1.0, 20, SPIRAL.HOLD - 0.1)).toBe(0);
  });

  it('treats either bank direction as the same cue', () => {
    const left = createSpiralState();
    const right = createSpiralState();
    expect(run(left, -1.0, 20, SPIRAL.HOLD + 0.2)).toBe(1);
    expect(run(right, 1.0, 20, SPIRAL.HOLD + 0.2)).toBe(1);
  });

  it('cools down so the card cannot repeat inside a spiral', () => {
    const s = createSpiralState();
    expect(run(s, 1.0, 20, SPIRAL.HOLD + 0.2)).toBe(1);
    // Hold the same spiral for another 10 s: still inside the cooldown, so no second fire.
    expect(run(s, 1.0, 20, 10)).toBe(0);
    // Past the cooldown it may fire again.
    expect(run(s, 1.0, 20, SPIRAL.COOLDOWN)).toBe(1);
  });

  it('ignores non-finite input instead of poisoning the state', () => {
    const s = createSpiralState();
    expect(stepSpiral(s, Number.NaN, 20, 1 / 60)).toBe(false);
    expect(stepSpiral(s, 1, Number.NaN, 1 / 60)).toBe(false);
    expect(stepSpiral(s, 1, 20, Number.NaN)).toBe(false);
    expect(s.held).toBe(0);
  });

  it('uses thresholds that a real dive reaches and a normal turn does not', () => {
    // A 45 deg bank at cruise loses little height; the spiral gate must sit well above it.
    expect(SPIRAL.BANK_MIN).toBeGreaterThan(0.5);
    expect(SPIRAL.SINK_MIN).toBeGreaterThan(4);
    expect(SPIRAL.HOLD).toBeGreaterThan(1);
  });
});
