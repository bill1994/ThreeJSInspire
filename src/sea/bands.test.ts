import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { BANDS } from './lod';
import { TIER_EASE_PER_FRAME, easeTrains, holeEdgeFor, initSeaBands, snapOrigin } from './bands';

/**
 * The load-bearing assertion here is the *quantum*. Each band must tow onto a multiple of
 * its own cell, because the seam's two rows only line up on that lattice: a tow that used one
 * shared cell, or the raw camera position, draws fine and breaks the join silently.
 *
 * The second is the *hole contract*: a band's cell grid is untouched by the move to
 * annuli — every vertex is still a multiple of `cell` and the square still reaches
 * `+-outer` — and the only thing that changed is which cells are indexed. That is asserted
 * geometrically (no annulus triangle lies wholly inside `inner`, and the closed draw covers
 * the centre) rather than by comparing index counts, so a hand-tuned count cannot pass a
 * broken cut.
 *
 * `snapOrigin` is tested separately from the tow because the failure it guards — flooring
 * below zero — only shows up south/west of the origin, which is exactly where the default
 * test camera is not.
 */

/** The design's most demanding budget (§5.3: fov 60 on a 1080p-class buffer). */
const RPP = 5.797e-4;

/** The doubled budget: one pixel covers twice the angle, so every threshold halves. */
const RPP_COARSE = 1.1594e-3;

/** Count the indexed triangles drawn from `start` for `count` indices that lie wholly
 *  inside the `|x| < half`, `|y| < half` square of the band's local XY frame. */
function trianglesFullyInside(
  geometry: THREE.BufferGeometry,
  start: number,
  count: number,
  half: number,
): number {
  const index = geometry.index!;
  const position = geometry.attributes.position as THREE.BufferAttribute;
  let inside = 0;
  for (let t = start; t < start + count; t += 3) {
    let whole = true;
    for (let k = 0; k < 3; k++) {
      const v = index.getX(t + k);
      if (Math.abs(position.getX(v)) >= half || Math.abs(position.getY(v)) >= half) whole = false;
    }
    if (whole) inside++;
  }
  return inside;
}

describe('easeTrains', () => {
  it('moves at most one ease step per frame, in the direction asked', () => {
    // A hard write here is the bug: the shader masks trains by smoothstep(i, i+1, uTrains),
    // so jumping 5 -> 3 deletes 0.15 m of swell in the frame the governor decided.
    expect(easeTrains(5, 3)).toBeCloseTo(5 - TIER_EASE_PER_FRAME, 12);
    expect(easeTrains(3, 5)).toBeCloseTo(3 + TIER_EASE_PER_FRAME, 12);
  });

  it('lands exactly on the target instead of creeping at it', () => {
    // Snap on arrival: a settled tier must be the integer the shader wants, not 2.9999999.
    expect(easeTrains(3 + TIER_EASE_PER_FRAME / 2, 3)).toBe(3);
    expect(easeTrains(3, 3)).toBe(3);
    // A full tier takes twelve frames — long enough to read as a fade, short enough that the
    // tier has landed before the governor can ask again.
    let v = 5;
    let frames = 0;
    while (v !== 3 && frames < 100) {
      v = easeTrains(v, 3);
      frames++;
    }
    expect(frames).toBe(24);
  });

  it('survives a broken current value instead of propagating NaN into the shader', () => {
    expect(easeTrains(Number.NaN, 4)).toBe(4);
    expect(easeTrains(4, Number.NaN)).toBe(4);
    expect(easeTrains(Number.POSITIVE_INFINITY, 2)).toBe(2);
  });
});

describe('holeEdgeFor', () => {
  /** The cut every band in the shipped table gets, in the band's own frame. */
  const edges = (): number[] =>
    BANDS.map((b, i) => holeEdgeFor(b, i === 0 ? null : BANDS[i - 1].cell));

  it('cuts one whole cell inside `inner` at every seam, nested quanta included', () => {
    // Nesting only guaranteed that the overlap is >= 0. Zero means the two meshes merely
    // touch, and touching rasterises to a crack: each band draws its own edge, the pixel
    // centre between them belongs to neither, and the background shows through as a one-pixel
    // line. Measured on b2/b3 at 252 m before this: a row of background at every sampled
    // column. A full cell of overlap is orders of magnitude wider than a pixel out there.
    expect(edges()).toEqual([0, 40.5, 162, 234, 360, 480]);
  });

  it('cuts one cell inside `inner` for b5, whose 96 m does not nest on 36 m', () => {
    // 96 % 36 = 24, so the residual at this one seam takes both signs ([−84, +24] m per
    // axis) and exact abutment would leave a 24 m hole in the sea at ~576 m. One b5 cell is
    // the smallest inset the lattice can express, and 96 ≥ 24 covers the worst case.
    expect(96 % 36).not.toBe(0);
    expect(edges()[5]).toBe(480);
    // The cut must stay on b5's own lattice, or `wholeCellInside` stops being a cell test.
    expect(edges()[5] % BANDS[5].cell).toBe(0);
  });

  it('never lets a coarse hole edge fall outward of the fine outer edge', () => {
    // The one claim the seam design rests on, swept rather than argued: for every band pair
    // and every camera position, the coarse band must start at or inside where the fine band
    // ends. A failure here is missing water, and no later task can recover it.
    for (let i = 1; i < BANDS.length; i++) {
      const fine = BANDS[i - 1];
      const coarse = BANDS[i];
      const hole = edges()[i];
      for (let v = -3 * coarse.cell; v <= 3 * coarse.cell; v += 0.25) {
        const coarseEdge = snapOrigin(v, coarse.cell) + hole;
        const fineEdge = snapOrigin(v, fine.cell) + fine.outer;
        expect(coarseEdge).toBeLessThanOrEqual(fineEdge + 1e-9);
      }
    }
  });

  it('pins the residual ranges, because it is their sign that decides', () => {
    // Magnitude alone would justify a blanket inset; the sign is what says four seams cannot
    // open. If a retune ever makes 96 a multiple of 36 the inset disappears on its own, and
    // if it makes some other pair non-nested, the sweep above fails before the render does.
    const ranges = BANDS.slice(1).map((coarse, i) => {
      const fine = BANDS[i];
      let lo = Infinity;
      let hi = -Infinity;
      for (let v = 0; v <= 3 * coarse.cell; v += 0.25) {
        const d = snapOrigin(v, coarse.cell) - snapOrigin(v, fine.cell);
        lo = Math.min(lo, d);
        hi = Math.max(hi, d);
      }
      return [lo, hi];
    });
    expect(ranges).toEqual([
      [-2.25, 0],
      [-4.5, 0],
      [-9, 0],
      [-18, 0],
      [-84, 24],
    ]);
  });
});

describe('snapOrigin', () => {
  it('snaps an origin down to its own cell grid', () => {
    expect(snapOrigin(7.3, 4.5)).toBeCloseTo(4.5, 9);
    expect(snapOrigin(-7.3, 4.5)).toBeCloseTo(-9, 9);
    expect(snapOrigin(0, 2.25)).toBe(0);
  });
});

describe('initSeaBands', () => {
  it('adds one mesh per band, named and ordered from the table', async () => {
    const scene = new THREE.Scene();
    const h = await initSeaBands(scene);
    // Against `BANDS`, not a second copy of the names: a rename must not need two edits.
    expect(h.meshes.map((m) => m.name)).toEqual(BANDS.map((b) => b.name));
    expect(scene.children).toHaveLength(BANDS.length);
    expect(scene.children).toHaveLength(6);
  });

  it('cuts one Task 5 material per band, unlit and fogless', async () => {
    const h = await initSeaBands(new THREE.Scene());
    expect(h.meshes).toHaveLength(6);
    for (const mesh of h.meshes) {
      const material = mesh.material as unknown as {
        fog: boolean;
        positionNode: unknown;
        colorNode: unknown;
      };
      // The default MeshBasicMaterial would also pass `fog`, but it carries
      // no sea graph: the nodes pin that Task 5 built the material.
      expect(material.positionNode).toBeDefined();
      expect(material.colorNode).toBeDefined();
      expect(material.fog).toBe(false);
    }
  });

  it('pushes the clock and the live budget into every band material', async () => {
    const h = await initSeaBands(new THREE.Scene());
    h.update(new THREE.Vector3(101, 7, -37), RPP_COARSE, 3.5);
    for (const mesh of h.meshes) {
      const uniforms = (
        mesh.material as unknown as {
          userData?: { seaUniforms?: { uTime: { value: number }; uRadPerPixel: { value: number } } };
        }
      ).userData?.seaUniforms;
      expect(uniforms).toBeDefined();
      expect(uniforms!.uTime.value).toBe(3.5);
      expect(uniforms!.uRadPerPixel.value).toBe(RPP_COARSE);
    }
  });

  it('tows every band to the camera, each on its own quantum', async () => {
    const h = await initSeaBands(new THREE.Scene());
    const camera = new THREE.Vector3(101, 7, -37);
    h.update(camera, RPP, 0);
    for (const mesh of h.meshes) {
      const band = BANDS.find((b) => b.name === mesh.name)!;
      // Exact, not modulo-snapped: a tow one float off its target still passes `% cell`.
      expect(mesh.position.x).toBe(snapOrigin(camera.x, band.cell));
      expect(mesh.position.z).toBe(snapOrigin(camera.z, band.cell));
      expect(mesh.position.x).toBeLessThanOrEqual(camera.x);
    }
  });

  it('snaps both axes, and floors a negative tow instead of rounding it', async () => {
    const h = await initSeaBands(new THREE.Scene());
    h.update(new THREE.Vector3(-101, 7, -37.4), RPP, 0);
    for (const mesh of h.meshes) {
      const band = BANDS.find((b) => b.name === mesh.name)!;
      // Anchorless modulo: -9 % 4.5 === -0, whose sign must not matter here.
      expect(Math.abs(mesh.position.x % band.cell)).toBeCloseTo(0, 9);
      expect(Math.abs(mesh.position.z % band.cell)).toBeCloseTo(0, 9);
      // Floored, not rounded: the tow sits at or behind the camera on both axes.
      expect(mesh.position.x).toBeLessThanOrEqual(-101);
      expect(mesh.position.z).toBeLessThanOrEqual(-37.4);
    }
  });

  it('keeps every vertex on the cell grid and the square at 2*outer', async () => {
    const scene = new THREE.Scene();
    const h = await initSeaBands(scene);
    scene.updateMatrixWorld(true);
    for (const mesh of h.meshes) {
      const band = BANDS.find((b) => b.name === mesh.name)!;
      const position = mesh.geometry.attributes.position as THREE.BufferAttribute;
      expect(position.count).toBe((band.segments + 1) ** 2);
      for (let v = 0; v < position.count; v++) {
        // The quantum is the invariant the seam relies on: a band`s vertices may only sit on its own cell grid.
        expect(Math.abs(position.getX(v) % band.cell)).toBeCloseTo(0, 6);
        expect(Math.abs(position.getY(v) % band.cell)).toBeCloseTo(0, 6);
      }

      // Both draw states span the full declared square: the annulus reaches out to `outer`,
      // the closed state reaches in to the centre. Bounds are attribute-wide, so this box is
      // the band's outer reach in either state — the conservative box for culling.
      const box = new THREE.Box3().setFromObject(mesh);
      expect(box.max.y - box.min.y).toBeCloseTo(0, 6);
      expect(box.max.x - box.min.x).toBeCloseTo(2 * band.outer, 6);
      expect(box.max.z - box.min.z).toBeCloseTo(2 * band.outer, 6);
    }
  });

  it('draws the annulus from the hole edge, and b5 starts one cell inside its inner', async () => {
    const h = await initSeaBands(new THREE.Scene());
    // 240 m hides b0 and b1, so b2 is the innermost drawn band and b3..b5 are plain annuli.
    h.update(new THREE.Vector3(0, 240, 0), RPP, 0);
    for (const mesh of h.meshes.slice(3)) {
      const index = BANDS.findIndex((b) => b.name === mesh.name);
      const band = BANDS[index];
      const holeEdge = holeEdgeFor(band, index === 0 ? null : BANDS[index - 1].cell);
      const geometry = mesh.geometry;
      const total = geometry.index!.count;
      expect(total).toBe(band.segments ** 2 * 6);
      expect(geometry.drawRange.start).toBe(0);
      // The cut is a whole number of cells and lands on a lattice line, so the annulus starts
      // on a vertex row instead of through a cell. `2*holeEdge/cell` is the hole's width in
      // cells, hence the doubled square.
      const holeCells = (2 * holeEdge) / band.cell;
      expect(Number.isInteger(holeCells)).toBe(true);
      expect(geometry.drawRange.count).toBe((band.segments ** 2 - holeCells ** 2) * 6);
      // The real assertion: nothing inside the hole edge survives the cut…
      expect(trianglesFullyInside(geometry, 0, geometry.drawRange.count, holeEdge)).toBe(0);
      // …and the omitted cells are still in the buffer, which is what makes closing free.
      expect(trianglesFullyInside(geometry, 0, total, holeEdge)).toBeGreaterThan(0);
    }

    // b5 is the only band that deliberately covers water lying inside its own `inner`. That
    // 96 m ring (480–576 m) is the overlap M5 buys, and it is what keeps the +24 m residual at
    // the b4/b5 seam from opening a hole in the sea at ~576 m. It is a ring of *cells* rather
    // than of triangles wholly inside 576 m, so it is counted that way.
    const b5 = h.meshes[5];
    const position = b5.geometry.attributes.position as THREE.BufferAttribute;
    const index = b5.geometry.index!;
    let inRing = 0;
    for (let t = 0; t < b5.geometry.drawRange.count; t += 3) {
      let inside = true;
      for (let k = 0; k < 3; k++) {
        const v = index.getX(t + k);
        if (
          Math.abs(position.getX(v)) > BANDS[5].inner ||
          Math.abs(position.getY(v)) > BANDS[5].inner
        ) {
          inside = false;
        }
      }
      if (inside) inRing++;
    }
    expect(inRing).toBeGreaterThan(0);
  });

  it('closes the innermost drawn band and reopens it when the finer band returns', async () => {
    const h = await initSeaBands(new THREE.Scene());
    const [, b1, b2] = h.meshes;

    // Cold start: b0 is drawn, so every other band is a plain annulus.
    expect(b1.geometry.drawRange.count).toBeLessThan(b1.geometry.index!.count);
    expect(b2.geometry.drawRange.count).toBeLessThan(b2.geometry.index!.count);

    // Climb until b0 and b1 are both hidden: b2's inner edge is now the surface's edge.
    h.update(new THREE.Vector3(0, 240, 0), RPP, 0);
    expect(h.meshes.map((m) => m.visible)).toEqual([false, false, true, true, true, true]);
    expect(b2.geometry.drawRange.count).toBe(b2.geometry.index!.count);
    // Indistinguishable from a full square from 0 to its outer edge.
    const band2 = BANDS.find((b) => b.name === b2.name)!;
    expect(b2.geometry.drawRange.count).toBe(band2.segments ** 2 * 6);
    expect(
      trianglesFullyInside(b2.geometry, 0, b2.geometry.drawRange.count, band2.inner),
    ).toBeGreaterThan(0);

    // Descend again: b0 returns, so b2 must go back to an annulus — no double cover.
    h.update(new THREE.Vector3(0, 70, 0), RPP, 0);
    expect(h.meshes.every((m) => m.visible)).toBe(true);
    expect(b2.geometry.drawRange.count).toBeLessThan(b2.geometry.index!.count);
    expect(b1.geometry.drawRange.count).toBeLessThan(b1.geometry.index!.count);
  });

  it('disposes idempotently, detaching every mesh and freeing geometry and material', async () => {
    const scene = new THREE.Scene();
    const h = await initSeaBands(scene);
    const geometry = vi.spyOn(h.meshes[0].geometry, 'dispose');
    const material = vi.spyOn(h.meshes[0].material as THREE.Material, 'dispose');

    h.dispose();
    expect(scene.children).toHaveLength(0);
    expect(geometry).toHaveBeenCalledTimes(1);
    // `new THREE.Mesh(geometry)` auto-creates one material per band; leaking them is silent.
    expect(material).toHaveBeenCalledTimes(1);
    expect(() => h.dispose()).not.toThrow();
    expect(geometry).toHaveBeenCalledTimes(1);

    // A tow after dispose must not resurrect a detached mesh — not its transform, and not
    // its visibility, which is the write path the hole-closing added.
    const visibleBefore = h.meshes.map((m) => m.visible);
    h.update(new THREE.Vector3(5, 5, 5), RPP, 0);
    expect(h.meshes[0].position.x).toBe(0);
    expect(h.meshes.map((m) => m.visible)).toEqual(visibleBefore);
  });
});

/**
 * The mask is driven by `camera.y`, the altitude — not by the towed `x`/`z`. These tests
 * therefore hold the camera at the origin and vary only the height, which is also the only
 * way to tell the two apart.
 */
describe('initSeaBands visibility', () => {
  it('writes mesh.visible index-for-index against BANDS', async () => {
    const h = await initSeaBands(new THREE.Scene());
    expect(h.meshes.map((m) => m.name)).toEqual(BANDS.map((b) => b.name));
    // Cold start is all-visible: no band is hidden before the first update.
    expect(h.meshes.every((m) => m.visible)).toBe(true);

    h.update(new THREE.Vector3(0, 240, 0), RPP, 0);
    // 240 m: B0 (103.5) and B1 (172.5) are sub-pixel, B2 (258.8) is not, B5 is flat.
    expect(h.meshes.map((m) => m.visible)).toEqual([false, false, true, true, true, true]);
  });

  it('reads the budget: the same altitude resolves differently at two budgets', async () => {
    // 70 m against a twice-coarser pixel: B0's threshold halves to 51.75, whose off-side is
    // 61.75, so B0 is hidden. The same 70 m at the canonical budget is on (113.5 - 10). A
    // constant, or a swapped argument, cannot satisfy both halves of this.
    const coarse = await initSeaBands(new THREE.Scene());
    coarse.update(new THREE.Vector3(0, 70, 0), RPP_COARSE, 0);
    const fine = await initSeaBands(new THREE.Scene());
    fine.update(new THREE.Vector3(0, 70, 0), RPP, 0);

    expect(coarse.meshes[0].visible).toBe(false);
    expect(fine.meshes[0].visible).toBe(true);
    expect(coarse.meshes.map((m) => m.visible)).not.toEqual(fine.meshes.map((m) => m.visible));
  });

  it('does not flicker while diving through a band threshold', async () => {
    const h = await initSeaBands(new THREE.Scene());
    const camera = new THREE.Vector3(0, 120, 0);
    h.update(camera, RPP, 0);
    expect(h.meshes[0].visible).toBe(false); // above 103.5 + 10

    // Descending through the raw threshold: still hidden, all the way into the dead band.
    for (const y of [112, 106, 103.5, 100, 96]) {
      camera.y = y;
      h.update(camera, RPP, 0);
      expect(h.meshes[0].visible).toBe(false);
    }

    // Reappears only below 103.5 - 10.
    camera.y = 93;
    h.update(camera, RPP, 0);
    expect(h.meshes[0].visible).toBe(true);

    // Climbing back: stays drawn past the raw threshold, until 113.5.
    for (const y of [100, 108, 113]) {
      camera.y = y;
      h.update(camera, RPP, 0);
      expect(h.meshes[0].visible).toBe(true);
    }
    camera.y = 114;
    h.update(camera, RPP, 0);
    expect(h.meshes[0].visible).toBe(false);
  });

  it('keeps its mask inside the closure, so two band sets do not share hysteresis state', async () => {
    const a = await initSeaBands(new THREE.Scene());
    const b = await initSeaBands(new THREE.Scene());

    a.update(new THREE.Vector3(0, 240, 0), RPP, 0);
    expect(a.meshes[0].visible).toBe(false);

    // b's own mask starts all-on, so 100 m is inside its on-threshold of 113.5. A
    // module-scope mask would have b inherit a's "off" and stay hidden here.
    b.update(new THREE.Vector3(0, 100, 0), RPP, 0);
    expect(b.meshes[0].visible).toBe(true);
    expect(a.meshes[0].visible).toBe(false);
  });

  it('draws everything rather than guessing when the altitude is unusable', async () => {
    const h = await initSeaBands(new THREE.Scene());
    h.update(new THREE.Vector3(0, 240, 0), RPP, 0);
    expect(h.meshes[0].visible).toBe(false);
    h.update(new THREE.Vector3(0, Number.NaN, 0), RPP, 0);
    expect(h.meshes.every((m) => m.visible)).toBe(true);
    // All-on means b0 is the innermost drawn band, so no other band stays closed.
    for (const mesh of h.meshes.slice(1)) {
      expect(mesh.geometry.drawRange.count).toBeLessThan(mesh.geometry.index!.count);
    }
  });
});
