import { describe, expect, it } from 'vitest';

import { RINGS, ringTriangleCount } from './rings';
import { buildRingGeometry, holeInset } from './rings-mesh';

describe('rings-mesh', () => {
  it('builds a dense (segs+1)² vertex grid for the holeless inner ring', () => {
    const g = buildRingGeometry(RINGS[0]);
    expect(g.getAttribute('position').count).toBe(41 * 41);
    // 40² cells × 2 triangles × 3 indices.
    expect(g.getIndex()!.count).toBe(40 * 40 * 2 * 3);
  });

  it('culls the square hole from the index buffer, not the vertex grid', () => {
    const g = buildRingGeometry(RINGS[1]);
    // The real one-cell inset leaves 8² hole cells, not a tangent 10² hole.
    expect(g.getIndex()!.count).toBe((1600 - 64) * 2 * 3);
  });

  it('keeps every vertex on the y=0 plane inside the ring span', () => {
    for (const ring of RINGS) {
      const g = buildRingGeometry(ring);
      const pos = g.getAttribute('position');
      for (let i = 0; i < pos.count; i += 1) {
        expect(pos.getY(i)).toBe(0);
        expect(Math.abs(pos.getX(i))).toBeLessThanOrEqual(ring.outer + 1e-6);
        expect(Math.abs(pos.getZ(i))).toBeLessThanOrEqual(ring.outer + 1e-6);
      }
    }
  });

  it('overlaps the previous ring by one cell via the hole inset', () => {
    for (let i = 1; i < RINGS.length; i += 1) {
      expect(holeInset(RINGS[i])).toBeLessThan(RINGS[i - 1].outer);
    }
  });

  it('renders cells that straddle the hole boundary (real overlap, not tangency)', () => {
    // A tangent ring starts EXACTLY at the previous ring's outer edge — the
    // crack the plan warned about. Culling against the inset hole must leave
    // actual indexed geometry reaching at least one cell inside `inner`.
    for (const ring of RINGS) {
      if (ring.inner === 0) continue;
      const g = buildRingGeometry(ring);
      const pos = g.getAttribute('position');
      const index = g.getIndex()!;
      let minAbs = Infinity;
      for (let i = 0; i < index.count; i += 1) {
        const v = index.getX(i);
        // Square radius, not min(|x|,|z|): an outer strip crosses x=0 even
        // when the actual hole is tangent, which hid the original regression.
        minAbs = Math.min(minAbs, Math.max(Math.abs(pos.getX(v)), Math.abs(pos.getZ(v))));
      }
      expect(ring.inner - minAbs).toBeGreaterThanOrEqual(ring.cell - 1e-4);
    }
  });

  it('accounts for the triangles actually indexed, including every overlap strip', () => {
    const count = RINGS.reduce((sum, r) => sum + buildRingGeometry(r).getIndex()!.count / 3, 0);
    expect(count).toBe(ringTriangleCount());
  });
});
