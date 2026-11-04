import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { BANDS } from './lod';
import { initSeaBands, snapOrigin } from './bands';

/**
 * The load-bearing assertion here is the *quantum*. Each band must tow onto a multiple of
 * its own cell, because Task 4 welds skirts to that lattice: a tow that used one shared
 * cell, or the raw camera position, draws fine and breaks the stitching silently.
 *
 * `snapOrigin` is tested separately from the tow because the failure it guards — flooring
 * below zero — only shows up south/west of the origin, which is exactly where the default
 * test camera is not.
 */

describe('snapOrigin', () => {
  it('snaps an origin down to its own cell grid', () => {
    expect(snapOrigin(7.3, 4.5)).toBeCloseTo(4.5, 9);
    expect(snapOrigin(-7.3, 4.5)).toBeCloseTo(-9, 9);
    expect(snapOrigin(0, 2.25)).toBe(0);
  });
});

describe('initSeaBands', () => {
  it('adds one mesh per band with stable names', async () => {
    const scene = new THREE.Scene();
    const h = await initSeaBands(scene);
    expect(h.meshes.map((m) => m.name)).toEqual([
      'sea-b0',
      'sea-b1',
      'sea-b2',
      'sea-b3',
      'sea-b4',
      'sea-b5',
    ]);
    expect(scene.children.length).toBe(6);
  });

  it('tows every band to the camera, each on its own quantum', async () => {
    const h = await initSeaBands(new THREE.Scene());
    h.update(new THREE.Vector3(101, 7, -37), 5.797e-4, 0, true);
    const byName = new Map(h.meshes.map((m) => [m.name, m]));
    expect(byName.get('sea-b1')!.position.x % 4.5).toBeCloseTo(0, 9);
    expect(byName.get('sea-b0')!.position.x % 2.25).toBeCloseTo(0, 9);
  });

  it('snaps both axes, and floors a negative tow instead of rounding it', async () => {
    const h = await initSeaBands(new THREE.Scene());
    h.update(new THREE.Vector3(-101, 7, -37.4), 5.797e-4, 0, true);
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

  it('builds one flat square per band, sized from the table', async () => {
    const scene = new THREE.Scene();
    const h = await initSeaBands(scene);
    scene.updateMatrixWorld(true);
    for (const mesh of h.meshes) {
      const band = BANDS.find((b) => b.name === mesh.name)!;
      const geo = mesh.geometry as THREE.PlaneGeometry;
      expect(geo.parameters.width).toBeCloseTo(2 * band.outer, 6);
      expect(geo.parameters.height).toBeCloseTo(2 * band.outer, 6);
      expect(geo.parameters.widthSegments).toBe(band.segments);
      expect(geo.parameters.heightSegments).toBe(band.segments);

      // Flat: the 2*outer square lies in XZ, so its world bounds have no height.
      const box = new THREE.Box3().setFromObject(mesh);
      expect(box.max.y - box.min.y).toBeCloseTo(0, 6);
      expect(box.max.x - box.min.x).toBeCloseTo(2 * band.outer, 6);
      expect(box.max.z - box.min.z).toBeCloseTo(2 * band.outer, 6);
    }
  });

  it('disposes idempotently and detaches every mesh from the scene', async () => {
    const scene = new THREE.Scene();
    const h = await initSeaBands(scene);
    h.dispose();
    expect(scene.children.length).toBe(0);
    expect(() => h.dispose()).not.toThrow();
    // A tow after dispose must not resurrect a detached mesh's transform silently.
    h.update(new THREE.Vector3(5, 5, 5), 5.797e-4, 0, true);
    expect(h.meshes[0].position.x).toBe(0);
  });
});
