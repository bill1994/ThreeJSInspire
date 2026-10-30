/**
 * src/spiral.ts — the SWALLOW SPIRAL DIVE cue gate.
 *
 * The reference short cuts to a title card mid-dive. Firing that card on every bank would
 * cheapen it, so it is gated on a *sustained* combination: a hard bank held while the
 * aircraft is genuinely losing altitude, for long enough that it is a deliberate spiral and
 * not one frame of turbulence. Pure state so it is unit-testable without a scene.
 */

export const SPIRAL = {
  /** Radians. Matches the reference's near-vertical spiral wing-over. */
  BANK_MIN: 0.6,
  /** m/s of downward velocity. Below this a bank is a turn, not a dive. */
  SINK_MIN: 8,
  /** Seconds the condition must hold continuously. */
  HOLD: 1.5,
  /** Seconds before the cue may fire again. A title card is a once-a-run beat. */
  COOLDOWN: 20,
} as const;

export interface SpiralState {
  /** Seconds the condition has been continuously true. */
  held: number;
  /** Seconds of cooldown remaining. */
  cooldown: number;
}

export function createSpiralState(): SpiralState {
  return { held: 0, cooldown: 0 };
}

/**
 * Advance the gate by `dt` and report whether the spiral dive is confirmed **this** frame.
 *
 * @param bank radians, sign ignored — a spiral either way is the same cue
 * @param sink m/s, positive downward
 * @returns true exactly once per confirmed dive
 */
export function stepSpiral(state: SpiralState, bank: number, sink: number, dt: number): boolean {
  if (!Number.isFinite(dt) || dt <= 0) return false;
  state.cooldown = Math.max(0, state.cooldown - dt);

  const bankOk = Number.isFinite(bank) && Math.abs(bank) >= SPIRAL.BANK_MIN;
  const sinkOk = Number.isFinite(sink) && sink >= SPIRAL.SINK_MIN;
  // Any interruption resets the hold: the whole point is that the condition was *sustained*,
  // so a single level frame in the middle must not count toward the total.
  state.held = bankOk && sinkOk ? state.held + dt : 0;

  if (state.held < SPIRAL.HOLD || state.cooldown > 0) return false;
  state.held = 0;
  state.cooldown = SPIRAL.COOLDOWN;
  return true;
}
