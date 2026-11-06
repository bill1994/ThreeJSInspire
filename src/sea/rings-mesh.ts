/**
 * Concentric square-ring geometry builder.
 *
 * Each ring is a dense `(segs+1)²` vertex grid spanning [−outer, outer]² on the
 * XZ plane (y = 0); the square hole is culled from the INDEX buffer only —
 * unused vertices are skipped by the GPU and keep the builder trivial. No
 * snap, no skirt: the mesh is towed with the camera and the material samples
 * displacement by world position, so cell borders need no special stitching.
 *
 * Winding is CCW seen from +Y so the top face is the front face.
 */
import * as THREE from 'three';

import type { Ring } from './rings';

/** Where the next ring's hole starts: one cell of overlap with `inner`. */
export function holeInset(ring: Ring): number {
  return ring.inner - ring.cell;
}

export function buildRingGeometry(ring: Ring): THREE.BufferGeometry {
  const { cell, inner, outer, segs } = ring;
  const side = 2 * outer;
  const step = side / segs;

  const verticesPerSide = segs + 1;
  const positions = new Float32Array(verticesPerSide * verticesPerSide * 3);
  let v = 0;
  for (let jz = 0; jz <= segs; jz += 1) {
    for (let jx = 0; jx <= segs; jx += 1) {
      positions[v * 3] = -outer + jx * step;
      positions[v * 3 + 1] = 0;
      positions[v * 3 + 2] = -outer + jz * step;
      v += 1;
    }
  }

  const indices: number[] = [];
  for (let cz = 0; cz < segs; cz += 1) {
    for (let cx = 0; cx < segs; cx += 1) {
      const x0 = -outer + cx * step;
      const z0 = -outer + cz * step;
      // Culled iff the whole cell lies inside the square hole. The 1e-6 slack
      // keeps binary-float cell corners (25.6 is not exact) from leaking edge
      // cells that the hole-count table says are inside.
      if (x0 >= -inner - 1e-6 && x0 + cell <= inner + 1e-6 && z0 >= -inner - 1e-6 && z0 + cell <= inner + 1e-6) {
        continue;
      }
      const v00 = cz * verticesPerSide + cx;
      const v10 = v00 + 1;
      const v01 = v00 + verticesPerSide;
      const v11 = v01 + 1;
      indices.push(v00, v11, v10, v00, v01, v11);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}
