/**
 * The six sea-band meshes: square annuli, their hole-closing state, and their snap tow.
 *
 * Each band is still a `segments x segments` lattice over its full `[-outer, outer]` square —
 * every vertex stays exactly on the `cell` grid — and the cells that lie *wholly inside*
 * `inner` are simply omitted from the index buffer. That choice is the whole design here,
 * for two reasons:
 *
 * - **The quantum survives.** `2*outer/segments === cell` is still exact because the extents
 *   and the spacing were not touched, only the indices. Nothing is re-parameterised, and the
 *   vertices Task 4c will weld a skirt to — every band but `b5`, whose 96 m cell shares no
 *   lattice with b4's 36 m (see below) — are exactly where they already were. Re-spanning a
 *   band over `[inner, outer]` instead of omitting cells would have to change the cell size to
 *   fit `segments` into the narrower ring, putting every vertex off the table's lattice and
 *   leaving nothing to weld to.
 * - **Closing the hole costs one integer.** The omitted cells sit at the *tail* of the index
 *   buffer, so the full square is `drawRange.count = index.count` and the annulus is
 *   `drawRange.count = annulusIndexCount`. One geometry per band, two states, no second
 *   buffer to keep in sync and nothing allocated per frame.
 *
 * Why a band ever needs its hole closed: while `b0` is drawn, `b0` fills the centre and every
 * coarser band can stay an annulus. Hide `b0` and `b1`'s inner edge *is* the surface's inner
 * edge — an annulus there is a square hole in the ocean, and it would be a hole that appears
 * exactly when the camera climbs, i.e. when the viewer can see furthest. So the innermost
 * drawn band draws its full square. Closing only that one is enough because the mask is
 * monotone in altitude: a band can only be drawn if every finer band is drawn too (the
 * thresholds in `lod.ts` shrink with band index), so there is never a second exposed inner
 * edge. This is also why no fragment discard is used — there are no materials in this task,
 * and a discard would still pay for the hole's geometry.
 *
 * Where the hole lands: exactly on `inner`. The cut is `floor(inner / cell) * cell`, and every
 * row of the table has `inner` as a whole number of its own cells — 0, 10, 19, 14, 11 and 6 —
 * so that expression *equals* `inner` for all six bands: each annulus covers its own square
 * ring and not one cell of its predecessor's. That is the exact seam the design (M5) mandates,
 * and it is why this file needed no change for it. The floor is still written inwards on
 * purpose — should a future `inner` ever stop being a whole number of cells, rounding *in*
 * only wastes triangles, while rounding out leaves a gap and a gap is missing water.
 *
 * The abutment settles the overlap; it does not make the two rows one row. What remains at each
 * seam is a T-junction: the two rows carry different vertex spacing — 2:1 from b0/b1 through
 * b3/b4, 2.67:1 at b4/b5 — so every other fine vertex on the shared edge (every one of them, at
 * b4/b5) has no coarse partner. Welding those is Task 4c's job; nothing here pretends to, and a
 * weld is not the whole of it either (see the tow and height-step paragraph below).
 *
 * Why the tow snaps instead of following the camera continuously: the displaced bands share the
 * 2.25 m lattice (see `lod.ts`, M5) — `b5`, at 96 m, does not, which is the same fact that
 * leaves its seam a T-junction at every vertex — so an unsnapped origin slides every coarse
 * vertex off the fine band's vertices each frame, and the b3/b4 seam Task 4c is about to weld
 * would swim. Quantising the tow trades sub-cell camera tracking — invisible, a cell is a few
 * pixels wide at the distance its band starts — for a vertex lattice that never moves.
 *
 * The price of per-band quanta: two neighbouring squares are not concentric, because each is
 * towed on its own cell, so a seam's world position steps by up to one coarse quantum as the
 * camera moves — up to 2.25 m at b0/b1, 4.5 at b1/b2, 9 at b2/b3, 18 at b3/b4, and up to 96 m at
 * b4/b5, where b5's cell is also off the 2.25 m lattice entirely. That offset is real and is
 * *not* fixed by the table: the extents abut exactly in each band's own frame, and the world-space
 * residual is this tow quantum.
 *
 * Nor is the tow offset the last thing at a seam. There is also a **height step** at every one of
 * them, and it is independent of the offset and of any overlap: each seam drops exactly one train,
 * so the shared row is one row of vertices carrying two heights, differing by that train's
 * amplitude — 0.06 m at b0/b1, 0.10 at b1/b2, 0.15 at b2/b3, 0.24 at b3/b4 and 0.34 at b4/b5 (the
 * dropped train is `TRAINS[trains-1]` of the finer band's set; amplitudes in `waves.ts`). Exact
 * abutment does not touch this: the two surfaces are continuous up to the shared row and simply
 * do not agree across it. So the skirt has to span a **height step** as well as a spacing change
 * — and, where the tow quanta differ, the lateral offset above. The table removes the overlap and
 * nothing else; the rest is 4c's.
 *
 * The tow floors, including below zero: `-7.3` on a 4.5 m grid snaps to `-9`, not `-4.5`.
 * `Math.round` or `| 0` looks identical north/east of the origin and is half a cell out
 * south/west, which is the version that ships.
 *
 * No material is assigned: Task 5 owns the shader. Until then the meshes carry the default
 * material and exist to be measured, so nothing here touches lighting, shadows, or render
 * order.
 *
 * Visibility is the one piece of per-frame state this module owns: a `boolean[]` living
 * inside the closure, indexed exactly like `BANDS`. It has to be here rather than at module
 * scope because hysteresis is history — two band sets in one page (a debug pair, a reload
 * that has not disposed yet) must not inherit each other's "was visible last frame", or a
 * fresh set starts life with a stale mask and pops.
 */

import * as THREE from 'three';
import { BANDS, nextVisibilityMask, type Band } from './lod';

/**
 * Snap `v` down to the nearest multiple of `cell`, so the result is always `<= v`.
 *
 * Floors rather than rounds or truncates: a band's vertices sit at multiples of `cell`
 * from its origin, and they only land on the shared world lattice when that origin is
 * itself a multiple. Flooring is also the only one of the three that behaves the same on
 * both sides of zero.
 *
 * A degenerate `cell` (zero, negative, NaN) returns `0` rather than `NaN`: an unusable
 * quantum must leave the band at the world origin, never poison `mesh.position` with NaN,
 * which would drop the whole band out of the frustum with no error anywhere.
 */
export function snapOrigin(v: number, cell: number): number {
  if (!Number.isFinite(v) || !Number.isFinite(cell) || cell <= 0) return 0;
  return Math.floor(v / cell) * cell;
}

/** Options for `initSeaBands`. */
export interface SeaBandsOptions {
  /**
   * Reserved for Task 5's debug material (wireframe / flat-tint views).
   *
   * Inert today because there is no material to switch: this task deliberately ships bare
   * geometry. Accepted now so the signature does not change under Task 5's feet.
   */
  debug?: boolean;
}

/** Handle to the live band set. `dispose` is idempotent; `update` is a no-op after it. */
export interface SeaBands {
  meshes: THREE.Mesh[];
  /**
   * Tow every band onto the camera's snapped origin, apply the visibility mask, and close
   * the inner hole of the innermost band that is still drawn.
   *
   * The mask is computed from the camera's altitude (`camera.y`), because that is what the
   * train-to-pixel comparison in `lod.ts` is about: height above the mean surface, not
   * distance along the ground. `t` and `high` belong to Task 5 (displacement) and are still
   * accepted-and-ignored here.
   */
  update(camera: THREE.Vector3, radPerPixel: number, t: number, high: boolean): void;
  /** Detach every band from `scene` and release its geometry and its material. */
  dispose(): void;
}

interface BandMesh {
  band: Band;
  mesh: THREE.Mesh;
  /** Index count that draws the annulus, with the inner-hole cells omitted. */
  annulusIndexCount: number;
  /** Index count that draws the whole square — the same buffer, undruncated. */
  closedIndexCount: number;
}

/**
 * Where a band's annulus begins, in the band's own frame — the edge of its inner hole.
 *
 * A coarse band's origin snaps on a coarser quantum than the band inside it (`snapOrigin`,
 * floored). When this band's `cell` is a whole multiple of the finer one, the coarser origin
 * is itself a multiple of the finer cell and can never exceed the finer origin, so cutting at
 * `inner` already lands at or *inside* the finer band's outer edge: overlap is
 * `[0, cell - prevCell]` at every camera position and a gap is impossible. Four seams in the
 * shipped table are in that case and need nothing.
 *
 * When it is not a multiple — B5's 96 m against B4's 36 m — the residual takes both signs
 * (measured `[-84, +24] m` per axis), so exact abutment can leave a 24 m hole of missing water
 * at ~576 m. There the hole is pulled one cell inside `inner`: the smallest inset a
 * lattice-snapped cut can express, and enough to cover the worst case with room (overlap
 * 72–180 m). The condition is derived from the table rather than declared per row, so a retune
 * cannot leave a stale flag behind — nesting the quanta removes the inset by itself.
 */
export function holeEdgeFor(band: Band, prevCell: number | null): number {
  const { inner, cell } = band;
  if (!Number.isFinite(inner) || !Number.isFinite(cell) || cell <= 0) return 0;
  if (prevCell === null || !Number.isFinite(prevCell) || prevCell <= 0) {
    return Math.floor(inner / cell) * cell;
  }
  const multiple = cell / prevCell;
  const nested = Math.abs(multiple - Math.round(multiple)) < 1e-9;
  // Clamped at zero: an `inner` smaller than one cell has no room to inset, and a negative
  // hole edge would read as "nothing is a whole cell" and drop the entire band's faces.
  return nested ? Math.floor(inner / cell) * cell : Math.max(0, inner - cell);
}

/**
 * Build one band's lattice: the full `(segments+1)^2` vertex grid on the exact `cell` grid,
 * with the inner-hole cells appended to the *tail* of the index buffer so a single
 * `drawRange` integer switches the band between annulus and full square.
 *
 * Positions are authored in local XY with an outward +Z normal, exactly like the
 * `PlaneGeometry` this replaces. `mesh.rotation.x` is what lays it flat, so the convention
 * keeps local +Z reading as "up" for the vertex path Task 5 writes.
 */
function buildBandGeometry(
  band: Band,
  prevCell: number | null,
): {
  geometry: THREE.BufferGeometry;
  annulusIndexCount: number;
  closedIndexCount: number;
} {
  const { segments, cell, inner, outer } = band;
  const side = segments + 1;
  const positions = new Float32Array(side * side * 3);
  const normals = new Float32Array(side * side * 3);
  const uvs = new Float32Array(side * side * 2);

  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const v = j * side + i;
      // `-outer + i*cell`, not `(i/segments - 0.5) * 2*outer`: the lattice is the quantum.
      positions[v * 3] = -outer + i * cell;
      positions[v * 3 + 1] = -outer + j * cell;
      normals[v * 3 + 2] = 1;
      uvs[v * 2] = i / segments;
      uvs[v * 2 + 1] = j / segments;
    }
  }

  // The hole edge: every cell wholly inside it is omitted, so the annulus starts at a whole
  // number of cells. For the nested rows that is `inner` exactly, which is what lets the
  // coarse band abut its predecessor; for b5 it is one cell in, which is what stops the one
  // non-nesting seam from opening a hole. The floor is a direction, not a correction: a future
  // `inner` off the lattice rounds *in*, because an overlap only wastes triangles while a gap
  // is missing water. Integer arithmetic on purpose — `cell` divides `outer` in every row and
  // these quotients are exact, so no float drift can move the cut.
  const holeEdge = holeEdgeFor(band, prevCell);

  const annulus: number[] = [];
  const hole: number[] = [];

  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const x0 = -outer + i * cell;
      const z0 = -outer + j * cell;
      const wholeCellInside =
        x0 >= -holeEdge && x0 + cell <= holeEdge && z0 >= -holeEdge && z0 + cell <= holeEdge;

      const a = j * side + i;
      const b = a + 1;
      const c = a + side;
      const d = c + 1;
      // Counter-clockwise seen from local +Z, which the -90 deg X rotation turns into world
      // +Y: front faces up, and `MeshBasicMaterial`'s default `FrontSide` keeps them.
      (wholeCellInside ? hole : annulus).push(a, b, d, a, d, c);
    }
  }

  const indices = new Uint32Array(annulus.length + hole.length);
  indices.set(annulus, 0);
  indices.set(hole, annulus.length);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.setDrawRange(0, annulus.length);
  // Bounds come from the position attribute, not the draw range, so the box is the band's
  // full declared square in both states. That is the conservative box for culling: a band
  // that can close must be culled as if it were closed.
  geometry.computeBoundingSphere();

  return { geometry, annulusIndexCount: annulus.length, closedIndexCount: indices.length };
}

/**
 * Build one mesh per row of `BANDS` and add them to `scene`.
 *
 * Async to match the shape Task 5 needs (it awaits shader compilation); nothing here
 * awaits anything yet.
 */
export async function initSeaBands(
  scene: THREE.Scene,
  _opts: SeaBandsOptions = {},
): Promise<SeaBands> {
  const entries: BandMesh[] = BANDS.map((band, i) => {
    const prevCell = i === 0 ? null : BANDS[i - 1].cell;
    const { geometry, annulusIndexCount, closedIndexCount } = buildBandGeometry(band, prevCell);
    const mesh = new THREE.Mesh(geometry);
    mesh.name = band.name;
    // Authored in XY; -90 deg about X lays it flat with +Y up, so local x maps to world x
    // and local y to world -z. Both stay multiples of `cell`, which is what keeps the
    // lattice invariant true in world space.
    mesh.rotation.x = -Math.PI / 2;
    scene.add(mesh);
    return { band, mesh, annulusIndexCount, closedIndexCount };
  });

  const meshes = entries.map((entry) => entry.mesh);
  /**
   * Previous-frame visibility, one flag per band. Starts all-on so the first frame draws
   * the full surface: an uninitialised mask would have to guess, and guessing "off" on a
   * cold start is a hole in the ocean for one frame.
   */
  const visible: boolean[] = BANDS.map(() => true);
  let disposed = false;

  return {
    meshes,

    update(camera: THREE.Vector3, radPerPixel: number, _t: number, _high: boolean): void {
      // After disposal the meshes are detached; writing their transforms would be silent
      // work on garbage. A non-finite camera is skipped for the same reason `snapOrigin`
      // guards: keep the last good tow instead of teleporting the ocean to NaN.
      if (disposed) return;
      if (!Number.isFinite(camera.x) || !Number.isFinite(camera.z)) return;

      for (const { band, mesh } of entries) {
        mesh.position.x = snapOrigin(camera.x, band.cell);
        mesh.position.z = snapOrigin(camera.z, band.cell);
      }

      // Index-for-index against `BANDS`, which is the same order as `entries` and
      // `meshes`. Committing the new mask back into the closure is what makes the next
      // frame's threshold depend on this one's state — the hysteresis.
      const next = nextVisibilityMask(visible, radPerPixel, camera.y);

      // The first drawn band is the only one with an exposed inner edge: every coarser band
      // sits inside its cover, and the mask is monotone in altitude so no later band can be
      // drawn while this one is not. `-1` (nothing drawn, only reachable if `BANDS` ever lost
      // its always-on flat band) closes nothing, because there is no surface to protect.
      const innermostDrawn = next.indexOf(true);

      for (let i = 0; i < entries.length; i++) {
        const { mesh, annulusIndexCount, closedIndexCount } = entries[i];
        visible[i] = next[i];
        mesh.visible = next[i];
        // Closing the hole is truncating the draw range or not: no second geometry, no
        // material trick, nothing to allocate inside the frame.
        const count = i === innermostDrawn ? closedIndexCount : annulusIndexCount;
        if (mesh.geometry.drawRange.count !== count) mesh.geometry.setDrawRange(0, count);
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const { mesh } of entries) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        // `new THREE.Mesh(geometry)` auto-creates a `MeshBasicMaterial` per band, so freeing
        // only the geometry leaks one material per band, per band set — invisible in a
        // frame, permanent across a reload loop.
        const material = mesh.material;
        for (const one of Array.isArray(material) ? material : [material]) one.dispose();
      }
    },
  };
}
