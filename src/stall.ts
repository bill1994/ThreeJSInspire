/**
 * src/stall.ts — stylised stall, not aerodynamics.
 *
 * The flight model now carries energy (thrust, quadratic drag, gravity along the nose),
 * so a zoom climb can genuinely run out of airspeed and hang at the apex. This module
 * is still the stylised contract for the *unloaded* part of that: too much nose-up at
 * too little airspeed presses the nose down, bleeds speed and buffets the airframe —
 * and it holds until the pilot unloads the stick.
 *
 * `MAX_PITCH_PROXY` mirrors `FLIGHT.MAX_PITCH` by value (asserted in stall.test.ts)
 * because importing it from `game.ts` would make `game.ts → stall.ts` circular.
 */

export const STALL = {
  /** AoA (pitch/MAX_PITCH_PROXY) above which the stall can exist at all. */
  AOA_CRIT: 0.42,
  /** Downward nose press at full stall (fed straight into the forward vector). */
  NOSE_DROP: 0.55,
  /**
   * m/s² of extra speed bleed at full stall, on top of the energy model's own gravity
   * term. Was 12 when speed was a clamped input; at 12 it would double-count gravity
   * and make every zoom climb unrecoverable, so it is now a trim on top of the energy.
   */
  DRAG: 4,
  /** Peak buffet amplitude as a fraction of the camera shake budget. */
  BUFFET01: 0.35,
  /** Gravity (m/s²) pulling the aircraft down once it stops making lift. */
  G_SINK: 9.81,
} as const;

export const MAX_PITCH_PROXY = 1.2;

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0;
}

/** 3t² - 2t³, with the ends pinned so the curve leaves 0 and 1 horizontally. */
function smoothstep01(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/**
 * 0..1 stall intensity from the current pitch and normalised airspeed. Zero below
 * the critical AoA; bites as the airspeed bleeds; every non-finite input reads 0.
 */
export function stall01(pitch: number, speed01: number): number {
  const aoa = clamp01(pitch / MAX_PITCH_PROXY);
  const t = clamp01((aoa - STALL.AOA_CRIT) / (1 - STALL.AOA_CRIT)) * Math.sqrt(clamp01(1 - speed01));
  return smoothstep01(t);
}
