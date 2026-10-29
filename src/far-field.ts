/**
 * Far-field stitching.
 *
 * The aircraft flies an unbounded line along -Z, but the ocean patch, the cloud dome and the
 * sky dome are all finite and were all authored centred on the world origin. Left alone the
 * camera leaves every one of them within ten seconds and the frame collapses to the flat
 * gradient background. This module re-centres them on the aircraft every frame:
 *
 * - FFT sea: snapped to whole 400 m pattern periods, so the tiled wave field is effectively
 *   pinned to world space — the snap moves the mesh by exactly one period, which is why it is
 *   invisible. (Snapping instead of sliding is what stops the swell from travelling with the
 *   plane, which would rob the scene of all sense of speed.)
 * - Gerstner sea: its vertex shader evaluates waves in world space, so a smooth slide is safe
 *   and keeps the analytic swell perfectly continuous.
 * - Cloud + sky domes: slid smoothly with the camera. They are far-field shells; nothing inside
 *   them is world-anchored, so following the camera is exactly the intended behaviour.
 *
 * Pure integration glue: it only reads scene objects by name and never touches their materials.
 */

import * as THREE from 'three';

import { SEA_FOLLOW_STEP } from './sea-fft';

/** Names owned by the sea/cloud/sky modules. Kept as lists so either backend path resolves. */
const SEA_NAMES = ['sea-fft', 'sea-gerstner'];
const CLOUD_NAMES = ['clouds-volumetric', 'clouds-sprites'];
const SKY_NAMES = ['sky_sunset_tsl', 'sky_sunset_glsl'];

/** Below this the object is already where it needs to be; skip the matrix update. */
const EPSILON = 1e-3;

export interface FarFieldHandles {
  /**
   * @param camX camera world x
   * @param camZ camera world z
   * @param planeX aircraft world x (the sea follows the aircraft, not the lagging camera)
   * @param planeZ aircraft world z
   */
  update(camX: number, camZ: number, planeX: number, planeZ: number): void;
  /** Names found, for the boot readout and tests. */
  readonly followed: { sea: string | null; clouds: string | null; sky: string | null };
  readonly seaKind: 'fft' | 'gerstner';
  dispose(): void;
}

function findFirst(scene: THREE.Scene, names: readonly string[]): THREE.Object3D | null {
  for (const name of names) {
    const found = scene.getObjectByName(name);
    if (found) return found;
  }
  return null;
}

function moveTo(obj: THREE.Object3D | null, x: number, z: number): void {
  if (!obj) return;
  if (Math.abs(obj.position.x - x) > EPSILON || Math.abs(obj.position.z - z) > EPSILON) {
    obj.position.x = x;
    obj.position.z = z;
  }
}

/** Snap a coordinate to the nearest whole wave-pattern period. */
export function snapToPeriod(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value / SEA_FOLLOW_STEP) * SEA_FOLLOW_STEP;
}

export function initFarField(scene: THREE.Scene, seaKind: 'fft' | 'gerstner'): FarFieldHandles {
  const sea = findFirst(scene, SEA_NAMES);
  const clouds = findFirst(scene, CLOUD_NAMES);
  const sky = findFirst(scene, SKY_NAMES);
  let disposed = false;

  return {
    followed: {
      sea: sea ? sea.name : null,
      clouds: clouds ? clouds.name : null,
      sky: sky ? sky.name : null,
    },
    seaKind,
    update(camX: number, camZ: number, planeX: number, planeZ: number): void {
      if (disposed) return;
      const seaX = seaKind === 'fft' ? snapToPeriod(planeX) : planeX;
      const seaZ = seaKind === 'fft' ? snapToPeriod(planeZ) : planeZ;
      moveTo(sea, seaX, seaZ);
      moveTo(clouds, camX, camZ);
      moveTo(sky, camX, camZ);
    },
    dispose(): void {
      disposed = true;
    },
  };
}
