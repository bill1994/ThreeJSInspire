/**
 * src/director.ts — the camera-as-director layer.
 *
 * It does NOT own camera constants: `camera-rig.ts` keeps them and accepts injected
 * tuning, and the director only contributes *deltas* on top. `FOV_BASE` (6) is
 * deliberately below `CAM_FOV_KICK` (9) so `FOV_BASE + FOV_DIVE` never exceeds the
 * rig's cap — the 3° headroom is what makes a dive read as a lurch forward.
 *
 * `directorCurve` is a pure per-frame shaping function; `createDirector` adds only
 * the *edges*: a trauma hit fires on the frame a state crosses its threshold, then
 * goes quiet until the state clears (or `reset()` re-arms it).
 */
import { CAM_BANK_FOLLOW } from './camera-rig';

export interface DirectorInput {
  speed01: number;
  bank: number;
  stall01: number;
  inCloud01: number;
  dive01: number;
}

export interface DirectorOutput {
  fovExtra: number;
  bankFollow: number;
  traumaHit: number;
}

export const DIRECTOR = {
  /** Base FOV the director's own budget starts from (CAM_FOV_KICK - FOV_DIVE). */
  FOV_BASE: 6,
  /** Extra FOV at a full dive; FOV_BASE + FOV_DIVE <= CAM_FOV_KICK by contract. */
  FOV_DIVE: 3,
  /** Bank follow at a full dive (the rig's calm value is CAM_BANK_FOLLOW 0.28). */
  ROLL_DIVE: 0.45,
  /** Trauma hit when the stall crosses its threshold. */
  HIT_STALL: 0.6,
  /** Trauma hit when the camera enters a cloud. Hard trigger: fires on touch (prox≈1), not on approach. */
  HIT_CLOUD: 0.9,
  /** Trauma hit when a dive crosses its threshold. */
  HIT_DIVE: 0.35,
} as const;

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0;
}

/** Pure per-frame shaping: NaN input reads as calm flight. */
export function directorCurve(input: DirectorInput): { fovExtra: number; bankFollow: number } {
  const dive = clamp01(input?.dive01);
  return {
    fovExtra: DIRECTOR.FOV_DIVE * dive,
    bankFollow: DIRECTOR.ROLL_DIVE * dive + CAM_BANK_FOLLOW * (1 - dive),
  };
}

/** Edge detector for the trauma hits. `dt` is accepted for signature stability; the
 *  edges are level-triggered, so no integration happens. */
export function createDirector(): {
  update(dt: number, input: DirectorInput): DirectorOutput;
  reset(): void;
} {
  const armed = { stall: true, cloud: true, dive: true };
  return {
    update(dt, input): DirectorOutput {
      void dt;
      const stall = clamp01(input?.stall01);
      const cloud = clamp01(input?.inCloud01);
      const dive = clamp01(input?.dive01);
      let traumaHit = 0;
      if (armed.stall && stall >= DIRECTOR.HIT_STALL) {
        traumaHit += DIRECTOR.HIT_STALL;
        armed.stall = false;
      } else if (stall < DIRECTOR.HIT_STALL) {
        armed.stall = true;
      }
      if (armed.cloud && cloud >= DIRECTOR.HIT_CLOUD) {
        traumaHit += DIRECTOR.HIT_CLOUD;
        armed.cloud = false;
      } else if (cloud < DIRECTOR.HIT_CLOUD) {
        armed.cloud = true;
      }
      if (armed.dive && dive >= DIRECTOR.HIT_DIVE) {
        traumaHit += DIRECTOR.HIT_DIVE;
        armed.dive = false;
      } else if (dive < DIRECTOR.HIT_DIVE) {
        armed.dive = true;
      }
      return { ...directorCurve(input), traumaHit };
    },
    reset(): void {
      armed.stall = true;
      armed.cloud = true;
      armed.dive = true;
    },
  };
}
