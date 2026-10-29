/**
 * Aircraft loader: the asset is allowed to be missing, slow or corrupt — the scene must still
 * fly something. These run in node, where every GLB request fails, which is exactly the
 * "missing/corrupt GLB" review gate.
 */
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { initPlane } from './plane';

function meshCount(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) n += 1;
  });
  return n;
}

describe('plane loader', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to a visible placeholder when the GLB cannot be loaded', async () => {
    const scene = new THREE.Scene();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const plane = await initPlane(scene);

    expect(scene.children).toContain(plane.group);
    expect(meshCount(plane.group)).toBeGreaterThan(6);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('placeholder'));
    // the placeholder has to be named for the QA/visual checks to find it
    expect(plane.group.getObjectByName('porco_placeholder')).toBeTruthy();
    // …and carry the livery, not an untextured grey blob
    const fuselage = plane.group.getObjectByName('fuselage_body') as THREE.Mesh;
    expect((fuselage.material as THREE.MeshStandardMaterial).name).toBe('livery_white');

    plane.dispose();
    expect(scene.children).not.toContain(plane.group);
  });

  it('keeps the nose +Z -> world -Z conversion on the inner model node', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scene = new THREE.Scene();
    const plane = await initPlane(scene);
    const model = plane.group.getObjectByName('porco_model');
    expect(model).toBeTruthy();
    expect(model?.rotation.y).toBeCloseTo(Math.PI, 6);
    plane.dispose();
  });

  it('ignores non-finite attitude values instead of producing NaN transforms', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scene = new THREE.Scene();
    const plane = await initPlane(scene);

    plane.setBank(Number.NaN);
    plane.setPitch(Number.POSITIVE_INFINITY);
    plane.setYaw(Number.NaN);
    plane.group.traverse((o) => {
      expect(Number.isFinite(o.rotation.x)).toBe(true);
      expect(Number.isFinite(o.rotation.y)).toBe(true);
      expect(Number.isFinite(o.rotation.z)).toBe(true);
    });

    plane.setBank(0.6);
    plane.setPitch(-0.25);
    plane.setYaw(1.1);
    expect(plane.group.rotation.y).toBeCloseTo(1.1, 6);
    plane.dispose();
  });
});
