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
 * - Cloud + sky domes: slid smoothly with the camera. They are far-field shells; nothing inside
 *   them is world-anchored, so following the camera is exactly the intended behaviour.
 *
 * Pure integration glue: it only reads scene objects by name and never touches their materials.
 */

import * as THREE from 'three';

import { SEA_FOLLOW_STEP } from './sea-fft';
import { PUFF_BEHIND_MARGIN, PUFF_FIELD_DEPTH, wrapPuffZ } from './puff-cloud';

/** Names owned by the sea/cloud/sky modules. One implementation each since the TSL unification. */
const SEA_NAMES = ['sea-fft'];
/**
 * The one cloud shell, in draw order. D2 merged the bank and the wisp deck into a single
 * slab, so the old two-mesh tow list collapsed to one name — but the loop still walks every
 * shell found, which is what the history lesson below is about: towing only the
 * representative mesh once left a second shell pinned to the world origin, and the camera
 * outruns a 780 m dome in ~17 s at CRUISE_SPEED (46 m/s).
 */
const CLOUD_NAMES = ['clouds-volumetric'];
const SKY_NAMES = ['sky_sunset_tsl'];

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
  readonly seaKind: 'fft';
  dispose(): void;
}

function findFirst(scene: THREE.Scene, names: readonly string[]): THREE.Object3D | null {
  for (const name of names) {
    const found = scene.getObjectByName(name);
    if (found) return found;
  }
  return null;
}

/** Every named shell that exists — the cloud stack is more than one mesh. */
function findAll(scene: THREE.Scene, names: readonly string[]): THREE.Object3D[] {
  const found: THREE.Object3D[] = [];
  for (const name of names) {
    const obj = scene.getObjectByName(name);
    if (obj) found.push(obj);
  }
  return found;
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

export function initFarField(scene: THREE.Scene): FarFieldHandles {
  const sea = findFirst(scene, SEA_NAMES);
  const clouds = findFirst(scene, CLOUD_NAMES);
  // Every cloud shell that exists — `findAll` keeps the tow list and the representative
  // lookup from disagreeing if the stack ever grows again (see CLOUD_NAMES).
  const cloudShells = findAll(scene, CLOUD_NAMES);
  const sky = findFirst(scene, SKY_NAMES);
  // 近景碎棉花：世界锚定不跟相机只做前后回收（跟相机走视差就死了）。
  // 懒收集：puff 是异步建出来的（TSL import + 逐朵建几何），initFarField 跑的
  // 那一下很可能还不在场子里。启动时 traverse 大概率扑空，数组就永远是空的，
  // 飞机飞离出生点云带后前面永远没云——之前“没靠近就消失”就是它。
  // update 里为空就重扫一次，扫到为止，开销忽略不计。
  const puffs: THREE.Object3D[] = [];
  const retrackPuffs = (): void => {
    scene.traverse((obj) => {
      // 只收 puff-00 这种数字mesh：组自己叫 puff-field 也以前缀命中，
      // 会被当成一朵云整组搬走（之前云场满天乱跳就是它）。
      if (/^puff-\d+$/.test(obj.name) && !puffs.includes(obj)) puffs.push(obj);
    });
  };
  retrackPuffs();
  let disposed = false;

  return {
    followed: {
      sea: sea ? sea.name : null,
      clouds: clouds ? clouds.name : null,
      sky: sky ? sky.name : null,
    },
    seaKind: 'fft',
    update(camX: number, camZ: number, planeX: number, planeZ: number): void {
      if (disposed) return;
      // One sea now: the FFT tile is snapped to whole pattern periods, which moves the mesh
      // by exactly one period and keeps the tiled field pinned to world space. Sliding it
      // would let the swell travel with the aircraft and rob the scene of any sense of speed.
      moveTo(sea, snapToPeriod(planeX), snapToPeriod(planeZ));
      for (const shell of cloudShells) moveTo(shell, camX, camZ);
      moveTo(sky, camX, camZ);
      if (puffs.length === 0) retrackPuffs();
      for (const puff of puffs) {
        const wrapped = wrapPuffZ(puff.position.z, planeZ, PUFF_FIELD_DEPTH, PUFF_BEHIND_MARGIN);
        if (Math.abs(wrapped - puff.position.z) > EPSILON) puff.position.z = wrapped;
      }
    },
    dispose(): void {
      disposed = true;
    },
  };
}
