/**
 * Concentric square-ring geometry table.
 *
 * Conventions: `inner`/`outer` are half-widths (the ring spans
 * [−outer, outer]² with a square hole inset from `inner`); `segs` is the grid
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

/** Inset the hole by one coarse cell to cover displaced grid boundaries. */
export function holeInset(ring: Ring): number {
  return Math.max(0, ring.inner - ring.cell);
}

/** Count culled cell centres using the same inset and grid as the builder. */
export function ringHoleCells(r: Ring): number {
  const step = 2 * r.outer / r.segs;
  const hole = holeInset(r);
  let culled = 0;
  for (let i = 0; i < r.segs; i += 1) {
    if (Math.abs(-r.outer + i * step + step / 2) < hole) culled += 1;
  }
  return culled ** 2;
}

/** Total triangle budget across all rings, hole cells excluded. */
export function ringTriangleCount(): number {
  return RINGS.reduce((sum, r) => sum + 2 * (r.segs * r.segs - ringHoleCells(r)), 0);
}
