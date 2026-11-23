import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import * as T from 'three/tsl';
import { SEA_WIND_ANGLE } from '../coastal-atmosphere';
import { cellSeed } from '../land/archipelago-layout';
import { seededRandom } from '../land/terrain';

const CELL = 34;
const SIDE = 5;
const PER_PATCH = 5;
const CAPACITY = SIDE * SIDE * PER_PATCH;
const driftX = Math.sin(SEA_WIND_ANGLE) * 1.4;
const driftZ = -Math.cos(SEA_WIND_ANGLE) * 1.4;
const smooth = THREE.MathUtils.smoothstep;

interface Drop {
  x: number; y: number; z: number; size: number; light: number;
}

export function initMistDrops(scene: THREE.Scene, seed: number, bedHeight?: (x: number, z: number) => number) {
  const patches = Array.from({length: SIDE * SIDE}, () => ({
    col: NaN, row: NaN, x: 0, z: 0, occupied: false,
    drops: Array.from({length: PER_PATCH}, (): Drop => ({x:0, y:0, z:0, size:0, light:0})),
  }));
  const geometry = new THREE.PlaneGeometry(1, 1);
  const opacity = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY), 1).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('coastDropAlpha', opacity);
  const material = new MeshBasicNodeMaterial({transparent: true, depthTest: true, depthWrite: false, fog: false});
  const uv = T.uv().sub(0.5).mul(2);
  const edge = T.smoothstep(0.08, 1, uv.dot(uv)).oneMinus();
  const tint = T.uniform(new THREE.Color());
  material.fragmentNode = T.vec4(tint, edge.mul(T.attribute('coastDropAlpha', 'float')));
  const mesh = new THREE.InstancedMesh(geometry, material, CAPACITY);
  mesh.name = 'coastal-mist-drops';
  mesh.frustumCulled = false;
  mesh.count = 0;
  mesh.visible = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(mesh);
  const stamp = new THREE.Object3D();
  const offset = new THREE.Vector3(), forward = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3();
  let perPatch = PER_PATCH;

  function patchAt(col: number, row: number) {
    const slot = THREE.MathUtils.euclideanModulo(col, SIDE) + SIDE * THREE.MathUtils.euclideanModulo(row, SIDE);
    const patch = patches[slot];
    if (patch.col === col && patch.row === row) return patch;
    patch.col = col;
    patch.row = row;
    const random = seededRandom(cellSeed(seed ^ 0x23a478, col, row));
    patch.occupied = random() < 0.64;
    if (patch.occupied) {
      patch.x = (col + 0.15 + random() * 0.7) * CELL;
      patch.z = (row + 0.15 + random() * 0.7) * CELL;
      const height = 5 + random() * 19;
      for (const drop of patch.drops) {
        drop.x = (random() - 0.5) * 17;
        drop.z = (random() - 0.5) * 22;
        drop.y = Math.max(2, height + (random() - 0.5) * 11);
        drop.size = 0.10 + random() * 0.14;
        drop.light = 0.42 + random() * 0.58;
      }
    }
    return patch;
  }

  return {
    setQuality(high: boolean) { perPatch = high ? PER_PATCH : 3; },
    update(time: number, camera: THREE.PerspectiveCamera, altitude: number,
      sun: {x: number; y: number; z: number}, cloud: number) {
      const light = smooth(sun.y, -0.065, 0.18) * (1 - smooth(altitude, 28, 46)) * (1 - 0.88 * cloud);
      mesh.count = 0;
      mesh.visible = false;
      if (light < 0.012) return;
      camera.getWorldDirection(forward);
      right.setFromMatrixColumn(camera.matrixWorld, 0);
      up.setFromMatrixColumn(camera.matrixWorld, 1);
      stamp.quaternion.copy(camera.quaternion);
      const halfY = Math.tan(camera.fov * Math.PI / 360), halfX = halfY * camera.aspect;
      const windX = driftX * time, windZ = driftZ * time;
      const baseCol = Math.floor((camera.position.x - windX) / CELL);
      const baseRow = Math.floor((camera.position.z - windZ) / CELL);
      const sunset = (1 - smooth(sun.y, 0.12, 0.68)) * smooth(forward.dot(sun), 0.16, 0.92);
      tint.value.setRGB(0.72 + 0.35 * sunset, 0.86 + 0.10 * sunset, 0.96 - 0.17 * sunset);
      for (let row = baseRow - 2; row <= baseRow + 2; row++) {
        for (let col = baseCol - 2; col <= baseCol + 2; col++) {
          const patch = patchAt(col, row);
          if (!patch.occupied) continue;
          const cx = patch.x + windX, cz = patch.z + windZ;
          if (Math.abs(cx - camera.position.x) > 61 || Math.abs(cz - camera.position.z) > 61) continue;
          for (let i = 0; i < perPatch; i++) {
            const drop = patch.drops[i];
            const x = cx + drop.x, z = cz + drop.z;
            const y = drop.y + 0.5 * Math.sin(time * 0.65 + drop.z);
            offset.set(x - camera.position.x, y - camera.position.y, z - camera.position.z);
            const depth = offset.dot(forward);
            if (depth <= 4 || depth >= 46 || Math.abs(offset.dot(right)) > depth * halfX + 0.2 ||
              Math.abs(offset.dot(up)) > depth * halfY + 0.2) continue;
            const sea = bedHeight ? smooth(-bedHeight(x, z), 0.1, 2.5) : 1;
            const lit = smooth(offset.dot(sun) / offset.length(), -0.12, 0.94);
            const alpha = light * sea * drop.light * (0.14 + 0.68 * lit) *
              smooth(depth, 4, 11) * (1 - smooth(depth, 26, 46));
            if (alpha < 0.026) continue;
            stamp.position.set(x, y, z);
            stamp.scale.set(drop.size, drop.size * 0.84, 1);
            stamp.updateMatrix();
            mesh.setMatrixAt(mesh.count, stamp.matrix);
            opacity.setX(mesh.count++, alpha);
          }
        }
      }
      if (mesh.count) {
        mesh.visible = true;
        opacity.needsUpdate = true;
        mesh.instanceMatrix.needsUpdate = true;
      }
    },
    dispose() {
      mesh.removeFromParent();
      mesh.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}
