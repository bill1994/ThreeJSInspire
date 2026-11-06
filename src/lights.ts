import * as THREE from 'three';

import { SUN_POSITION } from './palettes';

/**
 * Sunset lighting rig. Backend-agnostic: three's WebGPURenderer supports
 * DirectionalLight/HemisphereLight, so this runs on both backends.
 *
 * Kept apart from the sky dome modules so deleting either dome implementation cannot
 * delete the lights that both of them need.
 *
 * Returns the sun plus a direction setter so callers that shade from a *live* light
 * direction (the puff clouds) read the same object instead of keeping a second copy
 * that can drift. `setSunDirection` moves the light along the given unit vector at
 * the original light distance, so every consumer that derives a direction from
 * `light.position - target.position` follows the live sun for free.
 */
export function initSunsetLights(scene: THREE.Scene): {
  sun: THREE.DirectionalLight;
  setSunDirection(dir: THREE.Vector3): void;
} {
  const sun = new THREE.DirectionalLight('#ffd9a0', 2.2);
  sun.position.set(SUN_POSITION[0], SUN_POSITION[1], SUN_POSITION[2]);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight('#8a6fd0', '#2a1a3a', 0.7));
  const distance = sun.position.length();
  return {
    sun,
    setSunDirection(dir: THREE.Vector3): void {
      sun.position.copy(dir).normalize().multiplyScalar(distance);
    },
  };
}
