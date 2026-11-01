/**
 * src/in-cloud.ts — how deep the camera sits inside the cloud slab, as a pure
 * function of altitude. Drives the HUD whiteout and (Task 14) the wind-gain mix.
 *
 * D2 merged the two slabs into one tower band, so there is a single ramp now. It
 * lives INSIDE the band edges: density leaves 0 exactly at CLOUD_BAND.bottom and
 * CLOUD_BAND.top, so hovering on a boundary fades smoothly instead of strobing,
 * and a spawn at START_Y (below the band) reads zero on frame 0.
 *
 * The fade widths are fixed metres, not a fraction of the band: 40 m at each end of a
 * 95..480 band is 10% of the height (it was 24% of the old 170 m two-slab arrangement),
 * so the tower is entered more sharply than before. That is deliberate — the puff field
 * and the whiteout ramp below carry the transit; widening the fade instead would fog the
 * view at altitudes that are supposed to be clear.
 */
import { CLOUD_BAND } from './clouds-compute';

export const IN_CLOUD = { FADE_IN: 40, FADE_OUT: 40 } as const;

/** Ramp depth inside the band; 0 outside it, 1 well inside it. */
function bandDensity(y: number, bottom: number, top: number): number {
  const up = Math.min(Math.max((y - bottom) / IN_CLOUD.FADE_IN, 0), 1);
  const down = Math.min(Math.max((top - y) / IN_CLOUD.FADE_OUT, 0), 1);
  return Math.min(up, down);
}

/**
 * Linear 0..1 density from altitude; every non-finite input reads 0.
 *
 * The cruise altitude (60 m) sits below CLOUD_BAND.bottom, so the deck only fogs the
 * view once the player actually climbs into the tower — the near-field scraps the old
 * wisp deck provided are the puff sprites' job now.
 */
export function cloudDensityAt(y: number): number {
  if (!Number.isFinite(y)) return 0;
  return bandDensity(y, CLOUD_BAND.bottom, CLOUD_BAND.top);
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
