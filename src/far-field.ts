/**
 * Far-field stitching.
 *
 * The aircraft flies an unbounded line along -Z, but the sky dome was authored
 * centred on the world origin. Left alone the camera leaves it within ten
 * seconds and the frame collapses to the flat gradient background. This module
 * re-centres the sky shell on the camera every frame and wraps the puff field
 * around it.
 *
 * There used to be three tows here (sea, cloud dome, sky). The sea and the dome cloud
 * were deleted on 2026-11-06 (`rebuild/sea-dome-reset`), so only the sky tow and the
 * puff wrap remain. The sea that returned on 2026-11-07 does NOT tow through here:
 * it owns its own ring tow and world-mod sampling inside `src/sea/`.
 *
 * 2026-11-08: the sky tow is now FULL 3D (x, y, z). The dome shades with the real
 * view ray `normalize(positionWorld - cameraPosition)`; leaving its centre at
 * y=0 while the camera cruises at 60-240 m introduces a fixed ~camY/R vertical
 * parallax (R = 800 m, so up to ~17 deg) between the painted sky and the sea's
 * reflected sky. Optional third argument keeps the old 2-arg callers valid.
 *
 * Pure integration glue: it only reads scene objects by name and never touches their materials.
 */

import * as THREE from 'three';

import { puffEdgeFade, wrapPuffWindow } from './puff-field';

/** Names owned by the sky module. One implementation since the TSL unification. */
const SKY_NAMES = ['sky_sunset_tsl'];

/** Below this the object is already where it needs to be; skip the matrix update. */
const EPSILON = 1e-3;

export interface FarFieldHandles {
  /**
   * @param camX camera world x
   * @param camZ camera world z
   * @param camY camera world y (optional; defaults to 0 for 2-arg callers)
   */
  update(camX: number, camZ: number, camY?: number): void;
  /** Names found, for the boot readout and tests. */
  readonly followed: { sky: string | null };
  dispose(): void;
}

function findFirst(scene: THREE.Scene, names: readonly string[]): THREE.Object3D | null {
  for (const name of names) {
    const found = scene.getObjectByName(name);
    if (found) return found;
  }
  return null;
}

function moveTo(obj: THREE.Object3D | null, x: number, z: number, y: number): void {
  if (!obj) return;
  if (
    Math.abs(obj.position.x - x) > EPSILON ||
    Math.abs(obj.position.y - y) > EPSILON ||
    Math.abs(obj.position.z - z) > EPSILON
  ) {
    obj.position.set(x, y, z);
  }
}

export function initFarField(scene: THREE.Scene): FarFieldHandles {
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
      sky: sky ? sky.name : null,
    },
    update(camX: number, camZ: number, camY = 0): void {
      if (disposed) return;
      // Sky is a far-field shell: nothing inside it is world-anchored, so towing it
      // with the camera is exactly the intended behaviour. Towing Y too keeps the
      // shell centred ON the eye, so its view-ray shading matches the sea's.
      const eyeY = Number.isFinite(camY) ? camY : 0;
      moveTo(sky, camX, camZ, eyeY);
      if (puffs.length === 0) retrackPuffs();
      for (const puff of puffs) {
        // 窗口中心是相机，不是飞机：rig 有滞后，用飞机会让回收抖。
        const wrapped = wrapPuffWindow(puff.position.x, puff.position.z, camX, camZ);
        if (Math.abs(wrapped.x - puff.position.x) > EPSILON) puff.position.x = wrapped.x;
        if (Math.abs(wrapped.z - puff.position.z) > EPSILON) puff.position.z = wrapped.z;
        // 越界前先淡到 0，跳变就发生在看不见的时候。淡出只走 uniform，不动 visible——
        // visible 归 setQuality 管，两者抢同一个开关会互相打架。
        const mesh = puff as THREE.Mesh;
        const fade = puffEdgeFade(puff.position.x, puff.position.z, camX, camZ);
        const holder = mesh.material as unknown as { userData?: { edgeFade?: { value: number } } };
        if (holder?.userData?.edgeFade) holder.userData.edgeFade.value = fade;
      }
    },
    dispose(): void {
      disposed = true;
    },
  };
}
