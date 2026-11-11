/**
 * src/skim.ts — the deck-skim gate (Batch A3).
 *
 * A plane flying low and level should look like it is *skimming* the water, not
 * narrowly avoiding a crash. This module is the pure predicate for that: how much
 * of a skim a given altitude and attitude represent, and whether the contact was
 * gentle (a skim) or violent (a water hit worth a pull-up).
 */

export const SKIM = {
  /** Altitude the skim rides at. Mirrors FLIGHT.ALT_MIN + 1 — asserted in tests. */
  DECK_Y: 7,
  /** Altitude at which the skim gate has faded out completely. */
  FADE_Y: 14,
  /** |pitch| below which the attitude still counts as level. */
  LEVEL_IN: 0.18,
  /** |pitch| above which the skim gate is fully closed. */
  LEVEL_OUT: 0.55,
  /** Pitch at or below which a water contact counts as a hit. */
  CRASH_PITCH: -0.35,
  /** Descent rate (m/s) above which a water contact counts as a hit. */
  CRASH_SINK: 12,
  /**
   * P0-2 sea cushion. The sea is a cushion, not a wall: below SEA_CUSHION_Y the
   * attitude is held (pitch target floored at PITCH_FLOOR_DEEP, bank recenter
   * x1.5); below SEA_RUMBLE_Y the stick command itself is floored at
   * PITCH_FLOOR_FLOOR, the bank recenter doubles, and a loose stick auto-trims
   * toward PITCH_TRIM_FLOOR. Drag reads -10% inside the cushion so level flight
   * holds together instead of sagging back toward the water.
   */
  SEA_CUSHION_Y: 18,
  SEA_RUMBLE_Y: 12,
  PITCH_FLOOR_DEEP: -0.25,
  PITCH_FLOOR_FLOOR: -0.12,
  PITCH_TRIM_FLOOR: 0.05,
} as const;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

const smoothstep01 = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

/**
 * How much of a deck skim this altitude + attitude represents, 0..1.
 * Fades in from FADE_Y down to DECK_Y, and only counts while the wings are level.
 */
export function skim01(y: number, pitch: number): number {
  const height = smoothstep01((SKIM.FADE_Y - y) / (SKIM.FADE_Y - SKIM.DECK_Y));
  const level = 1 - smoothstep01((Math.abs(pitch) - SKIM.LEVEL_IN) / (SKIM.LEVEL_OUT - SKIM.LEVEL_IN));
  return clamp01(height * level);
}

/**
 * Severity of a water contact, 0..1. Zero while the plane is clear of the deck, and
 * then the worse of "nose too far down" and "sinking too fast".
 */
export function waterHit01(y: number, pitch: number, sink: number): number {
  if (y > SKIM.DECK_Y + 0.5) return 0;
  const steep = clamp01((SKIM.CRASH_PITCH - pitch) / 0.6);
  const fast = clamp01((sink - SKIM.CRASH_SINK) / 18);
  return Math.max(steep, fast);
}
