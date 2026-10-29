/**
 * src/stall.ts — stylised stall, not aerodynamics.
 *
 * The flight model is pure input drive: no lift, no gravity, altitude hard-clamped.
 * A "real" stall has nothing to stall, so this is the stylised contract instead:
 * too much nose-up at too little airspeed presses the nose down, bleeds speed and
 * buffets the airframe — and it holds until the pilot unloads the stick.
 *
 * `MAX_PITCH_PROXY` mirrors `FLIGHT.MAX_PITCH` by value (asserted in stall.test.ts)
 * because importing it from `game.ts` would make `game.ts → stall.ts` circular.
 */

export const STALL = {
  /** AoA (pitch/MAX_PITCH_PROXY) above which the stall can exist at all. */
  AOA_CRIT: 0.42,
  /** Downward nose press at full stall (fed straight into the forward vector). */
  NOSE_DROP: 0.55,
  /** m/s² of speed bleed at full stall. */
  DRAG: 12,
  /** Peak buffet amplitude as a fraction of the camera shake budget. */
  BUFFET01: 0.35,
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
