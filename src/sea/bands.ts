/**
 * The six sea-band meshes and their snap tow.
 *
 * Geometry is a **full square per band** — a complete `[-outer, outer]` patch, not an
 * annulus. The holes and welded skirts are Task 4's problem; building them here would mean
 * debugging the tow and the stitch at the same time, and the tow is the half that has to
 * be provably right first (the skirt is welded to a lattice that only exists if the tow
 * keeps it).
 *
 * Why the tow snaps instead of following the camera continuously: the bands share the
 * 2.25 m lattice (see `lod.ts`, M5), so an unsnapped origin slides every coarse vertex off
 * the fine band's vertices each frame, and the seam Task 4 is about to weld would swim.
 * Quantising the tow trades sub-cell camera tracking — invisible, a cell is a few pixels
 * wide at the distance its band starts — for a vertex lattice that never moves.
 *
 * The tow floors, including below zero: `-7.3` on a 4.5 m grid snaps to `-9`, not `-4.5`.
 * `Math.round` or `| 0` looks identical north/east of the origin and is half a cell out
 * south/west, which is the version that ships.
 *
 * No material is assigned: Task 5 owns the shader. Until then the meshes carry the default
 * material and exist to be measured, so nothing here touches lighting, shadows, or render
 * order.
 */

import * as THREE from 'three';
import { BANDS, type Band } from './lod';

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
   * Tow every band onto the camera's snapped origin.
   *
   * `radPerPixel`, `t` and `high` belong to Task 3 (visibility mask) and Task 5
   * (displacement); this task accepts and ignores them, which is why they are prefixed.
   * Task 3 is the one that will start reading `radPerPixel`.
   */
  update(camera: THREE.Vector3, radPerPixel: number, t: number, high: boolean): void;
  /** Detach every band from `scene` and release its geometry. */
  dispose(): void;
}

interface BandMesh {
  band: Band;
  mesh: THREE.Mesh;
}

/**
 * Build one square mesh per row of `BANDS` and add them to `scene`.
 *
 * Async to match the shape Task 5 needs (it awaits shader compilation); nothing here
 * awaits anything yet.
 */
export async function initSeaBands(
  scene: THREE.Scene,
  _opts: SeaBandsOptions = {},
): Promise<SeaBands> {
  const entries: BandMesh[] = BANDS.map((band) => {
    const geometry = new THREE.PlaneGeometry(
      2 * band.outer,
      2 * band.outer,
      band.segments,
      band.segments,
    );
    const mesh = new THREE.Mesh(geometry);
    mesh.name = band.name;
    // PlaneGeometry is authored in XY; -90 deg about X lays it flat with +Y up, so local
    // x maps to world x and local y to world -z. Both stay multiples of `cell`, which is
    // what keeps the lattice invariant true in world space.
    mesh.rotation.x = -Math.PI / 2;
    scene.add(mesh);
    return { band, mesh };
  });

  const meshes = entries.map((entry) => entry.mesh);
  let disposed = false;

  return {
    meshes,

    update(camera: THREE.Vector3, _radPerPixel: number, _t: number, _high: boolean): void {
      // After disposal the meshes are detached; writing their transforms would be silent
      // work on garbage. A non-finite camera is skipped for the same reason `snapOrigin`
      // guards: keep the last good tow instead of teleporting the ocean to NaN.
      if (disposed) return;
      if (!Number.isFinite(camera.x) || !Number.isFinite(camera.z)) return;

      for (const { band, mesh } of entries) {
        mesh.position.x = snapOrigin(camera.x, band.cell);
        mesh.position.z = snapOrigin(camera.z, band.cell);
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const { mesh } of entries) {
        scene.remove(mesh);
        mesh.geometry.dispose();
      }
    },
  };
}
