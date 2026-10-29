import * as THREE from 'three';

import { SUN_POSITION } from './palettes';

/**
 * Sunset lighting rig. Backend-agnostic: three's WebGPURenderer supports
 * DirectionalLight/HemisphereLight, so this runs on both backends.
 *
 * Kept apart from the sky dome modules so deleting either dome implementation cannot
 * delete the lights that both of them need.
 */
export function initSunsetLights(scene: THREE.Scene): void {
  const sun = new THREE.DirectionalLight('#ffd9a0', 2.2);
  sun.position.set(SUN_POSITION[0], SUN_POSITION[1], SUN_POSITION[2]);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight('#8a6fd0', '#2a1a3a', 0.7));
}
