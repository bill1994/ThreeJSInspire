/**
 * src/in-cloud.ts — how deep the camera sits inside the cloud slab, as a pure
 * function of altitude. Drives the HUD whiteout and (Task 14) the wind-gain mix.
 *
 * The ramp lives INSIDE the slab edges: density leaves 0 exactly at CLOUD_BOTTOM
 * and CLOUD_TOP, so hovering on a boundary fades smoothly instead of strobing,
 * and a spawn at START_Y (below the slab) reads zero on frame 0.
 */
import { CLOUD_BOTTOM, CLOUD_TOP } from './clouds-compute';

export const IN_CLOUD = { FADE_IN: 40, FADE_OUT: 40 } as const;

/** Linear 0..1 density from altitude; every non-finite input reads 0. */
export function cloudDensityAt(y: number): number {
  if (!Number.isFinite(y)) return 0;
  const up = Math.min(Math.max((y - CLOUD_BOTTOM) / IN_CLOUD.FADE_IN, 0), 1);
  const down = Math.min(Math.max((CLOUD_TOP - y) / IN_CLOUD.FADE_OUT, 0), 1);
  return Math.min(up, down);
}

/** Smoothstep version of the same ramp, for anything that ends up on screen. */
export function inCloud01(y: number): number {
  const d = cloudDensityAt(y);
  return d * d * (3 - 2 * d);
}
