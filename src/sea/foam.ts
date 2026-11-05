/**
 * Graphic foam (plan Task 4): a hard-edged layer over the crest tint, driven by how far the
 * horizontal Jacobian has collapsed — not by height, and not by a noise field alone.
 *
 * Why the Jacobian: on a Gerstner surface `J = det(d(x+ox, z+oz)/d(x,z))` falls below 1
 * exactly where the wave trains squeeze the surface, which is where a real crest piles up and
 * breaks. Height alone cannot separate "high water" from "water under strain", and a pure noise
 * mask reads as static rather than as water. The noise is only a *scroll*: it moves the
 * threshold so the edge dissolves instead of tracing the Jacobian contour line-for-line.
 *
 * Ordering (Uber-Anime, pinned by the plan): crest tint first, foam over it. Foam never
 * replaces the band colour — it is a graphic layer on top, which is why it is mixed in at the
 * end of the material rather than folded into the ramp.
 *
 * Dormancy: `shoreFoam` is wired to `depth-hooks.ts` and evaluates to exactly 0 on the
 * open-water fallback, so the whole shore side of this file is inert until terrain lands.
 *
 * The two scroll speeds are the Uber `UVPannerDistorted` pattern: a fast detail scroll and a
 * slow dissolve scroll in a different direction, ratio about 1 : 2.7. One scroll reads as a
 * sliding texture; two out of phase read as water.
 */

import { depthTerms } from './depth-hooks';

export const FOAM = {
  /**
   * Collapse gain `(1 - J)` at which foam is half-on.
   *
   * Was 0.277, lifted straight from Uber-Anime — where Q is 3-4x larger. Measured on THIS
   * field (5 trains, Q 0.5-0.7, wavelengths 11-180 m): J never falls below 0.932 across a
   * 192x192 m sweep, so the maximum collapse gain is 0.0676 and a 0.277 threshold puts the
   * mask at exactly 0 everywhere — dead code that looks like a feature. The threshold now
   * sits inside the range the field can actually reach.
   */
  edge: 0.028,
  /** Half-width of the mask ramp on the gain axis — the hard edge, scaled to `edge`. */
  smooth: 0.012,
  /** How strongly the scrolling noise is allowed to move that threshold, in gain units. */
  noiseShift: 0.5,
  /** Shore-intersection foam gain (dormant at the fallback depth). */
  shoreGain: 1,
  /** Fast detail scroll, metres of pattern per second, in world x/z. */
  scrollDetail: [0.045, -0.031],
  /** Slow dissolve scroll; direction differs so the two never move as one texture. */
  scrollDissolve: [-0.018, 0.049],
} as const;

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const span = edge1 - edge0;
  if (!(span > 0)) return x >= edge1 ? 1 : 0;
  const t = Math.min(Math.max((x - edge0) / span, 0), 1);
  return t * t * (3 - 2 * t);
}

/**
 * Collapse gain: 0 on unstrained water (`J = 1`), rising to 1 as the surface folds (`J -> 0`).
 *
 * Stretching (`J > 1`) also reads as 0: foam on stretched water is a smear, not a break.
 * A broken Jacobian reads as open water — a missing value must never look like a hole.
 */
export function collapseGain(jac: number): number {
  if (!Number.isFinite(jac)) return 0;
  return clamp01(1 - jac);
}

/**
 * The foam mask, 0..1.
 *
 * `noise` is a scrolling field in about `-1..1`; it shifts the threshold by up to
 * `+/- FOAM.smooth * noiseShift`, so the edge breaks up and dissolves without the noise ever
 * being able to put foam on unstrained water.
 */
export function foamMask(jac: number, noise: number): number {
  const gain = collapseGain(jac);
  if (gain <= 0) return 0;
  const n = Number.isFinite(noise) ? Math.min(Math.max(noise, -1), 1) : 0;
  const threshold = FOAM.edge + FOAM.smooth * n;
  return smoothstep(threshold - FOAM.smooth, threshold + FOAM.smooth, gain);
}

/**
 * Foam where terrain cuts the surface. Dormant (exactly 0) on the open-water fallback, which
 * is the only state the sea can be in before a depth texture exists.
 */
export function shoreFoam(depth01: number): number {
  return depthTerms(depth01).intersection * FOAM.shoreGain;
}

/**
 * TSL mirror of `foamMask`, for the surface material.
 *
 * `TSL` is the `three/tsl` namespace, injected so this module keeps its "no static three
 * import" guarantee. `jac` is the per-fragment Jacobian from the same Gerstner sum that
 * produced the height — not a second evaluation.
 */
export function foamMaskNode(TSL: any, jac: any, bx: any, bz: any, uTime: any): any {
  // The two scrolls evaluate at different spatial frequencies so the dissolve is not a
  // shifted copy of the detail.
  const detail = TSL.mx_noise_float(
    TSL.vec3(
      bx.mul(1.8).add(uTime.mul(FOAM.scrollDetail[0])),
      bz.mul(1.8).add(uTime.mul(FOAM.scrollDetail[1])),
      TSL.float(0),
    ),
  );
  const dissolve = TSL.mx_noise_float(
    TSL.vec3(
      bx.mul(0.45).add(uTime.mul(FOAM.scrollDissolve[0])),
      bz.mul(0.45).add(uTime.mul(FOAM.scrollDissolve[1])),
      TSL.float(4.7),
    ),
  );
  const noise = TSL.clamp(
    detail.mul(0.6).add(dissolve.mul(0.4)).mul(2).sub(1),
    TSL.float(-1),
    TSL.float(1),
  );
  const gain = TSL.clamp(TSL.float(1).sub(jac), TSL.float(0), TSL.float(1));
  const threshold = TSL.float(FOAM.edge).add(noise.mul(TSL.float(FOAM.smooth * FOAM.noiseShift)));
  const mask = TSL.smoothstep(
    threshold.sub(TSL.float(FOAM.smooth)),
    threshold.add(TSL.float(FOAM.smooth)),
    gain,
  );
  // `gain <= 0` is the dominant case over open water; the ramp already yields 0 there, but
  // the explicit step keeps the noise from clipping a faint film onto unstrained water.
  return mask.mul(TSL.step(TSL.float(0), gain));
}
