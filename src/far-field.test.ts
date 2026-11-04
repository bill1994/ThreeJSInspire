/**
 * Far-field follow: the finite sky shell must stay under the camera, and the
 * puff field must wrap around it without popping.
 *
 * reconstruct baseline: the sea tow (whole-period snap) and the cloud-dome tow
 * left with sea-fft.ts and clouds-compute.ts. These tests pin what is left —
 * the sky tow and the puff wrap — so the rebuild re-adds its own contract.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { initFarField } from './far-field';

function world(skyName = 'sky_sunset_tsl'): THREE.Scene {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
  mesh.name = skyName;
  scene.add(mesh);
  return scene;
}

describe('far field', () => {
  it('tows the sky shell with the camera', () => {
    const scene = world();
    const far = initFarField(scene);
    far.update(-120.5, 730.25);
    expect(far.followed).toEqual({ sky: 'sky_sunset_tsl' });
    expect((scene.getObjectByName('sky_sunset_tsl') as THREE.Mesh).position.x).toBe(-120.5);
    expect((scene.getObjectByName('sky_sunset_tsl') as THREE.Mesh).position.z).toBe(730.25);
    far.dispose();
  });

  it('survives a scene with none of the expected objects', () => {
    const far = initFarField(new THREE.Scene());
    expect(far.followed).toEqual({ sky: null });
    expect(() => far.update(1, 2)).not.toThrow();
    far.dispose();
  });
});

describe('puff field follow', () => {
  it('puff 绕相机取模，不绕飞机', () => {
    // Review Focus 3：rig 有滞后，窗口中心必须是相机。若有人把这里「清理」成
    // 别的锚点，云场会在相机追上之前就开始回收抖动，而别的测试仍然全绿。
    const scene = world();
    const puff = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
    puff.name = 'puff-00';
    puff.position.set(0, 60, -2400);
    scene.add(puff);
    const far = initFarField(scene);
    far.update(-120, 730); // 相机在 z=730
    expect(puff.position.z).toBeGreaterThan(730 - 1000);
    expect(puff.position.z).toBeLessThanOrEqual(730 + 1000);
    expect(Math.abs(puff.position.x - -120)).toBeLessThanOrEqual(1000);
    far.dispose();
  });
});
