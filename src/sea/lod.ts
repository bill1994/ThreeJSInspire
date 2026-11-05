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
export const CANONICAL_RAD_PER_PIXEL = 6.014e-4;

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
  /**
   * Inner half-extent, in metres. Equals the previous band's `outer`, and is a whole number of
   * this band's own cells — the second half is what makes the annulus holes land exactly.
   */
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
 * The six bands, nested as square annuli (M2, M3).
 *
 * Extents are cut at the *visibility* distances, not at powers of two, because train 5
 * (11 m, 0.06 m) stays geometrically visible out to 104 m and a doubling scheme would
 * put 4-6 m cells there. B0 ends at 45 m rather than 104 m because the water closer than
 * that is substantially covered by the aircraft (D7): train 5 is geometric only inside
 * B0 and normal-only beyond it, which is a deliberate consequence, not an oversight.
 *
 * Every displaced extent sits on the 2.25 m lattice, and **every `inner` is a whole number of
 * its own band's cells** — 0, 10, 19, 14, 11 and 6. Two things follow, and they are the reason
 * this is the table the design's "zero overlap, exact skirt" mandate (M5) can actually be met
 * with:
 *
 * - **The seams abut exactly, in each band's own frame.** `bands.ts` keeps each band's full
 *   lattice and omits the cells wholly inside `inner`, snapping the hole to
 *   `floor(inner / cell) * cell`; with these numbers that expression *equals* `inner` for all
 *   six, so a hole lands on the boundary rather than a fraction of a cell inside it. bN+1's
 *   annulus begins exactly where bN's ends: no double-drawn water, no gap, nothing to hide with
 *   a discard or a 1-bit stipple. That is a statement about a table measured around its own
 *   origin; in world space the two squares are placed by different snaps, and the residual there
 *   is one tow quantum rather than zero — see the tow paragraph at the end of this block.
 * - **The coarse inner row sits on the finer band's *outer* row**, not one of its interior
 *   lattice lines. That is what makes the seam a boundary at all instead of an overlap.
 *
 * What is left there is a T-junction: exact abutment, mismatched spacing. The vertex ratio is
 * 2:1 at every seam from b0/b1 through b3/b4 (4.5/2.25, 9/4.5, 18/9, 36/18) and 2.67:1 at
 * b4/b5 (96/36), so at the 2:1 seams every other finer vertex on the shared edge has no coarse
 * partner, and at b4/b5 every one of them is unpartnered. Stitching those T-junctions is Task
 * 4c's job (skirts); this table only guarantees they are T-junctions and not overlaps.
 *
 * One thing this table deliberately does not fix, because it is a property of the tow and not
 * of the extents: each band is towed on *its own* cell, so two neighbouring squares are not
 * concentric and the world-space seam can sit up to one quantum of the coarser band off the
 * finer band's edge. That offset is the skirt's to absorb, alongside the T-junctions.
 *
 * b5's cell is the one that does not nest in its predecessor's. Not "shares no lattice", which is
 * too strong: 96 and 36 do share the 12 m lattice below both, and 576 is on b4's row (576 / 36 =
 * 16). The precise fact is that 96 is not a multiple of 36 (96 / 36 = 2.67), so its first row is a
 * T-junction at every vertex rather than a vertex weld. b5 is flat (`trains: 0`), so it displaces
 * nothing and is exempt from the shared-lattice assertion in `lod.test.ts` — that exemption is why
 * the missing shared lattice was easy to overlook, not a reason to forget the seam.
 */
export const BANDS: readonly Band[] = [
  { name: 'sea-b0', inner: 0, outer: 45, cell: 2.25, segments: 40, trains: 5 },
  { name: 'sea-b1', inner: 45, outer: 171, cell: 4.5, segments: 76, trains: 4 },
  { name: 'sea-b2', inner: 171, outer: 252, cell: 9, segments: 56, trains: 3 },
  { name: 'sea-b3', inner: 252, outer: 396, cell: 18, segments: 44, trains: 2 },
  { name: 'sea-b4', inner: 396, outer: 576, cell: 36, segments: 32, trains: 1 },
  { name: 'sea-b5', inner: 576, outer: 1536, cell: 96, segments: 32, trains: 0 },
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
