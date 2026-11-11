/**
 * Aircraft loader: the asset is allowed to be missing, slow or corrupt — the scene must still
 * fly something. These run in node, where every GLB request fails, which is exactly the
 * "missing/corrupt GLB" review gate.
 */
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { initPlane, propOpacity01, propSpinRate, PROP_OPACITY_MIN, PROP_OPACITY_MAX, PROP_SPIN_IDLE, PROP_SPIN_FULL } from './plane';

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

  it('ignores non-finite attitude values instead of producing NaN transforms', async () => {    vi.spyOn(console, 'warn').mockImplementation(() => {});
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

describe('prop feedback (P1-2: blur disc opacity + spin follow the throttle)', () => {
  it('pins the opacity and spin anchors', () => {
    expect(PROP_OPACITY_MIN).toBe(0.1);
    expect(PROP_OPACITY_MAX).toBe(0.35);
    expect(PROP_SPIN_IDLE).toBe(6);
    expect(PROP_SPIN_FULL).toBe(46);
    expect(propOpacity01(0)).toBeCloseTo(0.1, 9);
    expect(propOpacity01(1)).toBeCloseTo(0.35, 9);
    expect(propOpacity01(0.5)).toBeCloseTo(0.225, 9);
    expect(propOpacity01(Number.NaN)).toBeCloseTo(0.1, 9);
    expect(propSpinRate(0)).toBeCloseTo(6, 9);
    expect(propSpinRate(1)).toBeCloseTo(46, 9);
    expect(propSpinRate(Number.NaN)).toBeCloseTo(6, 9);
  });

  it('spins the blades and breathes the disc with the throttle', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scene = new THREE.Scene();
    const plane = await initPlane(scene);
    const spin = plane.group.getObjectByName('prop_spin');
    expect(spin).toBeTruthy();

    plane.setProp(1, 0.1);
    expect(spin!.rotation.z).toBeCloseTo(4.6, 6); // 46 rad/s x 0.1 s (dt clamps like the frame's DT_CLAMP)
    plane.setProp(0, 0.1);
    expect(spin!.rotation.z).toBeCloseTo(5.2, 6); // + idle 6 rad/s x 0.1 s
    const disc = plane.group.getObjectByName('prop_blade_0') as THREE.Mesh;
    expect((disc.material as THREE.MeshStandardMaterial).opacity).toBeCloseTo(0.1, 9);
    plane.setProp(1, 0);
    expect((disc.material as THREE.MeshStandardMaterial).opacity).toBeCloseTo(0.35, 9);
    plane.dispose();
  });

  it('treats a missing prop (GLB swap) and NaN as a no-op, never NaN', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scene = new THREE.Scene();
    const plane = await initPlane(scene);
    // Simulate the GLB path swallowing the placeholder prop group.
    const spin = plane.group.getObjectByName('prop_spin');
    spin?.parent?.remove(spin);
    expect(() => plane.setProp(0.7, 0.016)).not.toThrow();
    expect(() => plane.setProp(Number.NaN, Number.NaN)).not.toThrow();
    plane.group.traverse((o) => {
      expect(Number.isFinite(o.rotation.z)).toBe(true);
    });
    plane.dispose();
  });
});
