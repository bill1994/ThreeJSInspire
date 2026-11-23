import * as THREE from 'three';
import { surfaceEffect } from '../surface-interaction';
import { DistanceEmitter, type Point } from './airflow';
import { GRID, seededRandom, smooth, type createTerrain } from './terrain';
import type { IslandTree } from './vegetation';

const CAPACITY = 96;
const LOW_CAPACITY = 48;
const LIFE = [1.35, 1.8, 0.72] as const;

// Only birth records cross the bus. The vertex shader evaluates each particle's
// age, drag, velocity, gravity and flutter from that immutable initial state.
export async function createDebris(group: THREE.Group, terrain: Pick<ReturnType<typeof createTerrain>, 'sample'>,
  trees: IslandTree[], clock: ReturnType<typeof import('three/tsl').uniform<'float', number>>, seed: number, streamed = false) {
  const T = await import('three/tsl');
  const { MeshBasicNodeMaterial } = await import('three/webgpu');
  const material = new MeshBasicNodeMaterial({ side: THREE.DoubleSide, fog: false });
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, -0.15, -0.46, 0, 1, 0.10, 0, 0.18, 0.53, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const births = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 4), 4);
  const velocities = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 4), 4);
  for (let i = 0; i < CAPACITY; i++) births.setW(i, -100);
  for (const [key, attr] of [['birth', births], ['velocityKind', velocities]] as const) {
    geo.setAttribute(key, attr.setUsage(THREE.DynamicDrawUsage));
  }
  const birth = T.attribute('birth', 'vec4'), velocity = T.attribute('velocityKind', 'vec4');
  const dryWash = surfaceEffect('sand');
  const isTree = velocity.w.equal(1), isSand = velocity.w.equal(2);
  const elapsed = clock.sub(birth.w);
  const age = elapsed.max(0);
  const lifespan = T.select(isSand, LIFE[2], T.select(isTree, LIFE[1], LIFE[0]));
  const phase = age.mul(T.select(isSand, 3, 7)).add(birth.x);
  const drag = T.float(1).sub(age.mul(-1.8).exp()).div(1.8);
  const travel = velocity.xyz.mul(drag);
  const flutter = phase.sin().mul(T.select(isSand, 0.03, 0.38)).mul(age);
  const up = age.mul(age).mul(T.select(isSand, -3.8, T.select(isTree, -1.9, -2.8)));
  const width = T.select(isSand, dryWash ? .64 : .15, T.select(isTree, 0.48, 0.62));
  const height = T.select(isSand, dryWash ? .13 : .20, T.select(isTree, 0.56, 0.24));
  const scale = T.smoothstep(lifespan.mul(0.62), lifespan, age).oneMinus().mul(T.step(0, elapsed));
  const local = T.positionGeometry;
  const offset = T.vec3(local.x.mul(width).mul(phase.cos()), local.y.mul(height).add(local.x.mul(width).mul(phase.sin()).mul(0.45)),
    local.x.mul(width).mul(phase.sin())).mul(scale);
  material.positionNode = birth.xyz.add(travel).add(T.vec3(flutter, up, flutter.mul(-0.6))).add(offset);
  const tint = T.uniform(1);
  material.colorNode = T.select(isSand, T.vec3(dryWash ? .77 : .69, dryWash ? .61 : .49, dryWash ? .38 : .26),
    T.select(isTree, T.vec3(0.20, 0.38, 0.09), T.vec3(0.43, 0.53, 0.17))).mul(tint);
  geo.instanceCount = CAPACITY;
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'island-leaves-and-sand';
  mesh.frustumCulled = false;
  mesh.visible = false;
  group.add(mesh);
  const random = seededRandom(seed + 38), emitter = new DistanceEmitter();
  const end = new Float64Array(CAPACITY);
  const stats = { capacity: CAPACITY, alive: 0, peakAlive: 0, births: [0, 0, 0], uploadedBytes: 0, peakUploadBytes: 0 };
  let cursor = 0;
  function update(time: number, previous: Point, p: Point, distance: number, high: boolean, grade: THREE.Color) {
    stats.capacity = high ? CAPACITY : LOW_CAPACITY;
    geo.instanceCount = stats.capacity;
    stats.uploadedBytes = 0;
    const dx = p.x - previous.x, dz = p.z - previous.z;
    const rx = -dz / (distance || 1), rz = dx / (distance || 1);
    emitter.step(distance, high ? 0.85 : 1.55, high ? 8 : 4, fraction => {
      const lateral = (random() - 0.5) * 13;
      let x = previous.x + dx * fraction + rx * lateral;
      let z = previous.z + dz * fraction + rz * lateral;
      if (!streamed && (x < GRID.x || z < GRID.z || x > GRID.x + 512 || z > GRID.z + 512)) return;
      const surface = terrain.sample(x, z);
      if (surface.distance < 0) return;
      const planeY = previous.y + (p.y - previous.y) * fraction;
      const tree = trees.find(t => Math.hypot(x - t.x, z - t.z) < 9 * t.size && Math.abs(planeY - t.y - 11 * t.size) < 12);
      const kind = tree ? 1 : surface.grass + surface.woods > 0.45 ? 0 : 2;
      let y = surface.height + 0.3;
      if (tree) {
        x = tree.x + (x - tree.x) * (surfaceEffect('trees') ? .87 : .56);
        z = tree.z + (z - tree.z) * (surfaceEffect('trees') ? .87 : .56);
        y = tree.y + (10 + 3 * random()) * tree.size;
      }
      const strength = 1 - smooth(12, 24, Math.abs(planeY - y));
      if (random() > strength * (kind === 2 ? 0.72 * (1 - surface.wet * 0.95) : 1)) return;
      // Do not evict a live particle when a tier change or a burst fills the pool.
      let slot = cursor % stats.capacity;
      for (let i = 0; i < stats.capacity && end[slot] > time; i++) slot = (slot + 1) % stats.capacity;
      if (end[slot] > time) return;
      cursor = (slot + 1) % stats.capacity;
      const sideSpeed = Math.sign(lateral || 1) * (3 + random() * 4) * (dryWash && kind === 2 ? 1.7 : 1);
      const release = time + (kind === 1 && surfaceEffect('trees') ? .14 : 0);
      births.setXYZW(slot, x, y, z, release);
      velocities.setXYZW(slot, rx * sideSpeed + dx / (distance || 1) * 3, kind === 2 ? (dryWash ? .65 + random() : 2 + random() * 2) : 4 + random() * 3,
        rz * sideSpeed + dz / (distance || 1) * 3, kind);
      end[slot] = release + LIFE[kind];
      for (const attr of [births, velocities]) { attr.addUpdateRange(slot * 4, 4); attr.needsUpdate = true; }
      stats.births[kind]++;
      stats.uploadedBytes += 32;
    });
    stats.alive = 0;
    for (let i = 0; i < stats.capacity; i++) if (end[i] > time) stats.alive++;
    stats.peakAlive = Math.max(stats.peakAlive, stats.alive);
    stats.peakUploadBytes = Math.max(stats.peakUploadBytes, stats.uploadedBytes);
    tint.value = 0.14 + 0.86 * smooth(0.54, 1, grade.r);
    mesh.visible = stats.alive > 0;
  }
  return { update, stats };
}
