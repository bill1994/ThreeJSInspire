/**
 * Band table and per-frame angular budget (pure math, no three.js import).
 *
 * Two different clocks live here, and mixing them up is the bug this file exists to
 * prevent:
 *
 * - **Geometry is sized once**, at the most demanding configuration the renderer can
 *   reach (fov 60, largest drawing buffer). Cells never change at runtime, so the mesh
 *   never under-provides. `BANDS` is that frozen table.
 * - **Fades are sized every frame.** `1 px` at the optical axis subtends
 *   `2*tan(fov/2)/H`, not `fov/H` — the naive average is 9.3% small at fov 60, and the
 *   camera fov is animated 60 -> 69 while the buffer height tracks `pixelRatio`. Across
 *   that spread the budget moves ~2.4x, which is why `perPixelRadians` is called per
 *   frame and pushed as a uniform rather than baked into a table.
 *
 * The cos^2 theta falloff across the frame is ignored on purpose: honouring it would
 * make the criterion view-direction dependent. The table is therefore up to 25%
 * conservative at the frame edges — the safe direction, costing triangles, not fidelity.
 *
 * Sampling rule is direction-aware. The trains run along WIND `(0.82, -0.57)` against an
 * axis-aligned grid, so spacing *along the direction of travel* is `c / 0.82` and four
 * samples per wavelength requires `c <= 0.205 * lambda`, not `lambda / 4` (22% looser).
 *
 * Design authority: docs/superpowers/specs/2026-11-04-infinite-ocean-lod-design.md
 * (rev 3), sections 5.1-5.3 and call M2. Do not re-derive those numbers here.
 */

import { TRAINS } from './waves';

/** How many of the longest trains the low tier evaluates (M9). Re-exported, not redeclared. */
export { LOW_TIER_TRAINS } from './waves';

/**
 * Low tier halves the segments per side but keeps the same band topology (M9).
 *
 * Cutting *bands* instead would either leave literal holes or force a coarse band over
 * the near field — the moire anti-goal. Only the fragment path and the vertex density
 * drop.
 */
export const SEGMENT_LOW_SCALE = 0.5;

/**
 * Angular budget for the most demanding configuration: fov 60 on a 1920 px buffer.
 *
 * Returned when the caller passes a degenerate fov or buffer height. Sizing the mesh for
 * a nonsense budget would let the near field under-provide, so the fallback is the
 * *hardest* case, never zero.
 */
const CANONICAL_RAD_PER_PIXEL = 6.014e-4;

/**
 * Radians subtended by one drawing-buffer pixel at the optical axis.
 *
 * Rectilinear: `2*tan(fov/2) / bufferHeight`. A degenerate fov or height returns
 * `CANONICAL_RAD_PER_PIXEL` rather than propagating `0` or `NaN` into the frame.
 */
export function perPixelRadians(fovDeg: number, bufferHeight: number): number {
  if (!Number.isFinite(fovDeg) || !Number.isFinite(bufferHeight)) return CANONICAL_RAD_PER_PIXEL;
  if (fovDeg <= 0 || bufferHeight <= 0) return CANONICAL_RAD_PER_PIXEL;
  return (2 * Math.tan((fovDeg * Math.PI) / 360)) / bufferHeight;
}

/** One square annulus of the sea surface. */
export interface Band {
  name: string;
  /** Inner half-extent, in metres. Equals the previous band's `outer`. */
  inner: number;
  /** Outer half-extent, in metres: the band covers `[-outer, outer]` on both axes. */
  outer: number;
  /** Grid cell size, in metres. A multiple of B0's cell for every displaced band (M5). */
  cell: number;
  /** Segments per side. `2*outer / segments === cell` exactly. */
  segments: number;
  /** How many of `TRAINS` this band displaces geometry for. 0 = flat. */
  trains: number;
}

/**
 * The six bands, outermost-first-and-last nested as annuli (M2, M3).
 *
 * Extents are cut at the *visibility* distances, not at powers of two, because train 5
 * (11 m, 0.06 m) stays geometrically visible out to 104 m and a doubling scheme would
 * put 4-6 m cells there. B0 ends at 45 m rather than 104 m because the water closer than
 * that is substantially covered by the aircraft (D7): train 5 is geometric only inside
 * B0 and normal-only beyond it, which is a deliberate consequence, not an oversight.
 *
 * Every displaced extent sits on the 2.25 m lattice, so each coarse band's inner row
 * snaps to the next finer band's outer vertices as an exact skirt — zero discard, zero
 * stipple, zero overlap (M5). A 1-bit dither on this hard-banded palette would draw a
 * dashed band edge, i.e. the anti-goal manufactured by the mechanism meant to prevent it.
 *
 * B5 is flat: `trains: 0`, a 128 m cell that is *not* a lattice multiple, and no
 * displacement, so it needs no skirt lattice and is exempt from the lattice assertion.
 */
export const BANDS: readonly Band[] = [
  { name: 'sea-b0', inner: 0, outer: 45, cell: 2.25, segments: 40, trains: 5 },
  { name: 'sea-b1', inner: 45, outer: 171, cell: 4.5, segments: 76, trains: 4 },
  { name: 'sea-b2', inner: 171, outer: 261, cell: 9, segments: 58, trains: 3 },
  { name: 'sea-b3', inner: 261, outer: 414, cell: 18, segments: 46, trains: 2 },
  { name: 'sea-b4', inner: 414, outer: 576, cell: 36, segments: 32, trains: 1 },
  { name: 'sea-b5', inner: 576, outer: 2048, cell: 128, segments: 32, trains: 0 },
];

/**
 * Distance at which a vertical displacement `amplitude` drops under one pixel: `A / rad`.
 *
 * At the most demanding budget (5.797e-4) the trains vanish at 587/414/259/173/104 m.
 * Beyond 587 m the surface is *geometrically flat* — not cheap, flat: no triangle count
 * improves it, and what remains is slope, which lives in the normal.
 *
 * Not guarded: a non-positive `radPerPixel` yields `Infinity`, which `bandVisible` reads
 * as "visible forever" — the safe direction. Guard the budget at its source instead.
 */
export function trainDistance(amplitude: number, radPerPixel: number): number {
  return amplitude / radPerPixel;
}

/**
 * Whether `band` still contributes visible displacement at `altitude`.
 *
 * True when the band's finest train subtends at least a pixel at that height. Stateless
 * on purpose: this is the raw threshold, and the 10 m dead band that keeps a dive from
 * flickering belongs to the caller that owns previous-frame state (M7, Task 3's
 * `nextVisibilityMask`). Putting hysteresis in here would make the predicate
 * order-dependent and untestable in isolation.
 *
 * The flat band is always drawn: it carries no displacement to drop, and it is what keeps
 * the far surface from becoming a hole.
 *
 * An unusable budget returns `true` for the same reason — a bad uniform must degrade to
 * extra triangles, never to missing water.
 */
export function bandVisible(band: Band, radPerPixel: number, altitude: number): boolean {
  if (band.trains === 0) return true;
  if (!Number.isFinite(radPerPixel) || radPerPixel <= 0) return true;
  if (!Number.isFinite(altitude)) return true;
  const finest = TRAINS[Math.min(band.trains, TRAINS.length) - 1];
  return altitude < trainDistance(finest.amp, radPerPixel);
}

/**
 * Half-width of the dead band, in metres of camera altitude (M7).
 *
 * A dive that crosses a threshold exactly once is fine; a dive that *hovers* on it is the
 * failure. At the crossing distance a band's finest train is one pixel tall, so a camera
 * descending at a walking pace would toggle the band on alternate frames — visible as a
 * hard edge strobing across the water, which is worse than either state. 10 m of altitude
 * is roughly 17% of the tightest band's crossing distance and costs at most a few extra
 * coarse squares while inside it.
 */
export const SEA_HYSTERESIS_M = 10;

/**
 * Visibility for the next frame, given the last one: the stateful half of `bandVisible`.
 *
 * Two thresholds per band, `trainDistance -/+ SEA_HYSTERESIS_M`, and `prev[i]` picks which
 * one applies: a band that is on stays on until the camera climbs past `d + H`; a band
 * that is off stays off until the camera drops below `d - H`. The gap between them is the
 * dead band, and it is why a dive through a threshold cannot flicker.
 *
 * Pure and non-mutating: `prev` is read, never written, and the result is a fresh array.
 * That keeps the flicker guarantee testable as a fold over a sequence of altitudes, and it
 * means two band sets cannot corrupt each other's history through a shared buffer.
 *
 * Same length and order as `BANDS`, so callers can index it straight against `BANDS` or
 * their mesh array. `prev` is expected to be that shape too; a short `prev` reads as
 * "off", which errs toward dropping triangles for one frame. That is safe only because the
 * band layer closes the inner hole of the innermost band it still draws (see `bands.ts`):
 * the bands are annuli, so a stale "off" on the innermost drawn band would otherwise be a
 * square hole rather than a coarser surface.
 *
 * An unusable budget or altitude returns every band on, matching `bandVisible`: a broken
 * uniform must degrade to extra triangles, never to missing water. This guard is what keeps
 * the mask *open*; it is not by itself a guarantee against a hole, because an annulus with
 * its centre band hidden has no water in the middle. The hole-closing in `bands.ts` is the
 * other half — together they mean no reachable mask leaves a gap.
 */
export function nextVisibilityMask(
  prev: boolean[],
  radPerPixel: number,
  altitude: number,
): boolean[] {
  if (!Number.isFinite(radPerPixel) || radPerPixel <= 0 || !Number.isFinite(altitude)) {
    return BANDS.map(() => true);
  }

  return BANDS.map((band, i) => {
    if (band.trains === 0) return true;
    const finest = TRAINS[Math.min(band.trains, TRAINS.length) - 1];
    const distance = trainDistance(finest.amp, radPerPixel);
    const wasVisible = prev[i] === true;
    return altitude < (wasVisible ? distance + SEA_HYSTERESIS_M : distance - SEA_HYSTERESIS_M);
  });
}
