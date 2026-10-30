/**
 * src/in-cloud.ts — how deep the camera sits inside the cloud slab, as a pure
 * function of altitude. Drives the HUD whiteout and (Task 14) the wind-gain mix.
 *
 * The ramp lives INSIDE the slab edges: density leaves 0 exactly at CLOUD_BOTTOM
 * and CLOUD_TOP, so hovering on a boundary fades smoothly instead of strobing,
 * and a spawn at START_Y (below the slab) reads zero on frame 0.
 */
import { CLOUD_BOTTOM, CLOUD_TOP, CLOUD_WISP_BOTTOM, CLOUD_WISP_TOP, WISP_DENSITY } from './clouds-compute';

export const IN_CLOUD = { FADE_IN: 40, FADE_OUT: 40 } as const;

/** Ramp depth inside one slab band; 0 outside it, 1 well inside it. */
function bandDensity(y: number, bottom: number, top: number): number {
  const up = Math.min(Math.max((y - bottom) / IN_CLOUD.FADE_IN, 0), 1);
  const down = Math.min(Math.max((top - y) / IN_CLOUD.FADE_OUT, 0), 1);
  return Math.min(up, down);
}

/**
 * Linear 0..1 density from altitude; every non-finite input reads 0.
 *
 * Two bands now contribute: the cumulus bank (full weight) and the wisp deck under it
 * (`WISP_DENSITY`). A wisp crossing must fog the screen a little — it is a real volume and
 * the player sees it close up — but never as hard as the bank, or a 30..82 m band would put
 * a beige veil across the default cruise altitude. Max, not sum: the bands overlap in
 * altitude, and summing would double-count a crossing that is really one layer thick.
 */
export function cloudDensityAt(y: number): number {
  if (!Number.isFinite(y)) return 0;
  const bank = bandDensity(y, CLOUD_BOTTOM, CLOUD_TOP);
  const wisp = bandDensity(y, CLOUD_WISP_BOTTOM, CLOUD_WISP_TOP) * WISP_DENSITY;
  return Math.max(bank, wisp);
}

/** Smoothstep version of the same ramp, for anything that ends up on screen. */
export function inCloud01(y: number): number {
  const d = cloudDensityAt(y);
  return d * d * (3 - 2 * d);
}

/**
 * The DOM fog never goes fully opaque. At 1.0 the layer is a flat beige card that hides the
 * very cloud the player just flew into — the transit reads as a white-screen bug rather than
 * as being inside a volume. Partial fog keeps the HUD readable through it.
 */
export const WHITEOUT_MAX = 0.6;

/** Whiteout opacity for a camera altitude: the immersion ramp, capped so the view survives. */
export function whiteout01(y: number): number {
  return inCloud01(y) * WHITEOUT_MAX;
}
