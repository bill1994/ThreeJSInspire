/**
 * Concentric square-ring geometry table.
 *
 * Conventions: `inner`/`outer` are half-widths (the ring spans
 * [−outer, outer]² minus the square hole |x|,|z| < inner); `segs` is the grid
 * resolution across the full span, `segs = 2·outer/cell`; a ring keeps one
 * cell of overlap with its neighbour (`holeInset = inner − cell < prev.outer`)
 * so adjacent rings can never crack apart.
 *
 * `floorMetres` is the shortest wavelength the ring must resolve
 * (≈ 4.878 × cell, the ~4.9-samples-per-wavelength rule, capped at the
 * spectrum's longest wave) and `mipLod` is the displacement-mip level that
 * low-passes everything below it — under-sampled short waves are filtered
 * away before they can shimmer, not rendered aliased.
 */

export interface Ring {
  index: number;
  inner: number;
  outer: number;
  cell: number;
  segs: number;
  floorMetres: number;
  mipLod: number;
}

export const RINGS: readonly Ring[] = [
  { index: 0, inner: 0, outer: 128, cell: 6.4, segs: 40, floorMetres: 32, mipLod: 0 },
  { index: 1, inner: 128, outer: 512, cell: 25.6, segs: 40, floorMetres: 128, mipLod: 3 },
  { index: 2, inner: 512, outer: 1536, cell: 128, segs: 24, floorMetres: 640, mipLod: 5 },
  { index: 3, inner: 1536, outer: 1900, cell: 200, segs: 19, floorMetres: 1024, mipLod: 5 },
];

/** `cell ≤ 0.205·floor` ⇔ ~4.9 vertex samples per shortest wavelength. */
export function ringIsValid(r: Ring): boolean {
  return r.cell <= 0.205 * r.floorMetres;
}

/** Cells culled by the square hole: ⌊2·inner/cell⌋². */
export function ringHoleCells(r: Ring): number {
  return Math.floor((2 * r.inner) / r.cell) ** 2;
}

/** Total triangle budget across all rings, hole cells excluded. */
export function ringTriangleCount(): number {
  return RINGS.reduce((sum, r) => sum + 2 * (r.segs * r.segs - ringHoleCells(r)), 0);
}
