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
 *
 * `setSunLook` / `setAmbience` (day-night track, 2026-11-08): the track owns the
 * sun's colour/intensity and the hemisphere ambience per keyframe — they mutate the
 * EXISTING lights (no re-creation, no re-registration). Callers still clamp the
 * light's elevation themselves (plan Task 7).
 */
export function initSunsetLights(scene: THREE.Scene): {
  sun: THREE.DirectionalLight;
  setSunDirection(dir: THREE.Vector3): void;
  setSunLook(colorCss: string, intensity: number): void;
  setAmbience(skyCss: string, groundCss: string, intensity: number): void;
} {
  const sun = new THREE.DirectionalLight('#ffd9a0', 2.2);
  sun.position.set(SUN_POSITION[0], SUN_POSITION[1], SUN_POSITION[2]);
  scene.add(sun);
  const hemi = new THREE.HemisphereLight('#8a6fd0', '#2a1a3a', 0.7);
  scene.add(hemi);
  const distance = sun.position.length();
  return {
    sun,
    setSunDirection(dir: THREE.Vector3): void {
      sun.position.copy(dir).normalize().multiplyScalar(distance);
    },
    setSunLook(colorCss: string, intensity: number): void {
      sun.color.set(colorCss);
      sun.intensity = intensity;
    },
    setAmbience(skyCss: string, groundCss: string, intensity: number): void {
      hemi.color.set(skyCss);
      hemi.groundColor.set(groundCss);
      hemi.intensity = intensity;
    },
  };
}
