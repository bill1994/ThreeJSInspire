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
 * Integration glue: moves scene objects and updates their distance-fade uniforms.
 */

import * as THREE from 'three';
import { CloudArrivalGate, OffscreenCloudGate, cloudViewTest, cloudArrivalClear } from './cloud-arrival';

import { wrapPuffAxis, PUFF_EDGE_FADE, PUFF_SCATTER, puffEdgeFade, wrapPuffWindow } from './puff-field';

/**
 * Names owned by the sky module. EVERY match is towed — a first-hit lookup here is
 * how the star layer (`sky_stars`, day-night Task 6) would silently never move:
 * the hit-and-return shape means adding a name to the list changes nothing.
 */
const SKY_NAMES = ['sky_sunset_tsl', 'sky_stars'];

/** Below this the object is already where it needs to be; skip the matrix update. */
const EPSILON = 1e-3;

export interface FarFieldHandles {
  /**
   * @param camX camera world x
   * @param camZ camera world z
   * @param camY camera world y (optional; defaults to 0 for 2-arg callers)
   * Direction and clock arguments are retained for existing callers. Cloud
   * recycling no longer relocates clouds into timed near-camera encounter slots.
   */
  update(camX: number, camZ: number, camY?: number, dirX?: number, dirZ?: number, nowS?: number, camera?: THREE.PerspectiveCamera): void;
  /** Names found AND towed (one entry per object), for the boot readout and tests. */
  readonly followed: { towed: string[] };
  dispose(): void;
}

function findAll(scene: THREE.Scene, names: readonly string[]): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  for (const name of names) {
    const found = scene.getObjectByName(name);
    if (found) out.push(found);
  }
  return out;
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

export function initFarField(scene: THREE.Scene, relaxed = true, terrain?: (x:number,z:number,w:number,d:number)=>number): FarFieldHandles {
  const skies = findAll(scene, SKY_NAMES);
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
  const arrivals = new CloudArrivalGate();
  const prepared = new OffscreenCloudGate();
  let firstView = true;
  let previousTime: number | undefined;
  const anchored = new WeakSet<THREE.Object3D>();
  let lastCamera: { x: number; z: number } | undefined;

  return {
    followed: {
      towed: skies.map((s) => s.name),
    },
    update(camX: number, camZ: number, camY = 0, _dirX = 0, _dirZ = -1, _nowS?: number, camera?: THREE.PerspectiveCamera): void {
      if (disposed || !Number.isFinite(camX) || !Number.isFinite(camZ)) return;
      // Sky shells (dome + stars) are far-field objects: nothing inside them is
      // world-anchored, so towing them with the camera is exactly the intended
      // behaviour. Towing Y too keeps the shell centred ON the eye, so its
      // view-ray shading matches the sea's.
      const eyeY = Number.isFinite(camY) ? camY : 0;
      for (const sky of skies) moveTo(sky, camX, camZ, eyeY);
      if (puffs.length === 0) retrackPuffs();
      // A debug teleport must not wrap a distant cloud directly onto the eye.
      // Ordinary flight retains world anchoring; discontinuities reset the far ring.
      const jumped = lastCamera !== undefined && Math.hypot(camX - lastCamera.x, camZ - lastCamera.z) >= PUFF_EDGE_FADE;
      lastCamera = { x: camX, z: camZ };
      const outside = camera ? cloudViewTest(camera, true) : null;
      const gate = outside ? prepared : arrivals;
      const now = _nowS ?? 0;
      const dt = previousTime === undefined ? 0 : Math.max(0, now-previousTime);
      previousTime = now; arrivals.begin(dt);
      const radius = (p: THREE.Object3D) => Math.hypot(
        Number(p.userData.blobSize?.halfW ?? 0), Number(p.userData.blobSize?.halfD ?? 0));
      for (const puff of puffs) {
        const beforeX = puff.position.x, beforeZ = puff.position.z;
        const offset = puff.userData.scatterOffset as { x: number; z: number } | undefined;
        if (offset && (!anchored.has(puff) || jumped)) {
          puff.position.x = camX + offset.x;
          puff.position.z = camZ + offset.z;
          anchored.add(puff);
        }
        // 窗口中心是相机，不是飞机：rig 有滞后，用飞机会让回收抖。
        const wrapped = wrapPuffWindow(puff.position.x, puff.position.z, camX, camZ);
        if (Math.abs(wrapped.x - puff.position.x) > EPSILON) puff.position.x = wrapped.x;
        if (Math.abs(wrapped.z - puff.position.z) > EPSILON) puff.position.z = wrapped.z;
        // 越界前先淡到 0，跳变就发生在看不见的时候。淡出只走 uniform，不动 visible——
        // visible 归 setQuality 管，两者抢同一个开关会互相打架。
        const size = puff.userData.blobSize;
        if (terrain && size && (puff.userData.baseAltitude === undefined || jumped ||
            beforeX !== puff.position.x || beforeZ !== puff.position.z)) {
          puff.userData.baseAltitude ??= puff.position.y;
          const floorAt = (cx:number,cz:number) => {
            const peak=terrain(cx,cz,size.halfW,size.halfD);
            return Math.max(puff.userData.baseAltitude,peak+size.halfH+7);
          };
          const x=puff.position.x,z=puff.position.z;
          let altitude=floorAt(x,z);
          for(let attempt=1;altitude+size.halfH>240 && attempt<=8;attempt++){
            const angle=attempt*2.39996;
            puff.position.x=x+Math.cos(angle)*attempt*45;
            puff.position.z=z+Math.sin(angle)*attempt*45;
            // Retain the pairwise border when terrain forces a new horizontal spot.
            const px=puff.position.x,pz=puff.position.z;
            const overlaps=puffs.some(other=>other!==puff && anchored.has(other) &&
              Math.hypot(wrapPuffAxis(other.position.x,px)-px,wrapPuffAxis(other.position.z,pz)-pz)
                <PUFF_SCATTER.GAP_MARGIN*(radius(puff)+radius(other)));
            altitude=overlaps?Infinity:floorAt(px,pz);
          }
          puff.userData.terrainClear=altitude+size.halfH<=240;
          puff.position.y=puff.userData.terrainClear?altitude:puff.userData.baseAltitude;
        }
        const mesh = puff as THREE.Mesh;
        let fade = puffEdgeFade(puff.position.x, puff.position.z, camX, camZ);
        const holder = mesh.material as unknown as { userData?: { edgeFade?: { value: number } } };
        if (relaxed && radius(puff)>0) {
          if (jumped || Math.hypot(puff.position.x-beforeX,puff.position.z-beforeZ)>PUFF_EDGE_FADE) { arrivals.reset(puff); prepared.reset(puff); }
          const clear = gate.active(puff) || (Math.hypot(puff.position.x-camX,puff.position.z-camZ)-radius(puff)>=PUFF_SCATTER.SPAWN_CLEAR &&
            cloudArrivalClear({x:puff.position.x,z:puff.position.z,radius:radius(puff)},
              puffs.filter(p=>p!==puff && gate.active(p) && p.visible).map(p=>({x:p.position.x,z:p.position.z,radius:radius(p)})),camX,camZ));
          if (!puff.visible) prepared.reset(puff);
          fade = outside
            ? prepared.update(puff, puff.visible ? fade : 0, clear && puff.visible,
                outside(puff.position, Math.hypot(radius(puff), Number(puff.userData.blobSize?.halfH ?? 0))), firstView)
            : arrivals.update(puff,puff.visible ? fade : 0,dt,clear);
        }
        if (puff.userData.terrainClear===false) {
          fade=0; prepared.reset(puff); arrivals.reset(puff);
        }
        if (holder?.userData?.edgeFade) holder.userData.edgeFade.value = fade;
        puff.userData.cloudPrepared = gate.active(puff);
      }
      if (outside) firstView = false;
    },
    dispose(): void {
      disposed = true;
    },
  };
}
