import * as THREE from 'three';
import { biome, cellSeed, elevation, extent, meshHeight, ORIGIN_Z, PITCH, shore, SIDE, surface, waterwayBounds, type IslandSpec } from './archipelago-layout';
import { fieldRoots } from './field-cover';
import { seededRandom, smooth } from './terrain';
import type { IslandTree } from './vegetation';

export const GRASS_TILE = 32;
export const MASK_SIDE = 96;
export type Job = { key: string; spec: IslandSpec; painted?:boolean; tile?: [number, number] };

const wet = new THREE.Color('#bca884'), sand = new THREE.Color('#efd69f');
const meadow = new THREE.Color('#a4ba64'), slope = new THREE.Color('#70a36b'), forest = new THREE.Color('#709660');

function geometry(s: IslandSpec, side: number) {
  const count = (side + 1) ** 2, half = extent(s), step = 2 * half / side;
  const position = new Float32Array(3 * count), normal = new Float32Array(3 * count), color = new Uint8Array(3 * count);
  const indices: number[] = [], green = new THREE.Color();
  for (let j = 0; j <= side; j++) for (let i = 0; i <= side; i++) {
    const k = j * (side + 1) + i, x = s.x - half + i * step, z = s.z - half + j * step;
    const d = shore(s, x, z), b = biome(s, x, z, d);
    position.set([x, elevation(s, x, z, d), z], 3 * k);
    const nx = elevation(s, x - 2, z) - elevation(s, x + 2, z);
    const nz = elevation(s, x, z - 2) - elevation(s, x, z + 2);
    const length = Math.hypot(nx, 4, nz);
    normal.set([nx / length, 4 / length, nz / length], 3 * k);
    green.copy(meadow).lerp(slope, 0.48 + 0.22 * Math.sin(x / 33 + z / 58) + 0.23 * Math.sin(z / 34 - x / 68));
    for (const [n, c] of (['r', 'g', 'b'] as const).entries())
      color[3 * k + n] = Math.round(255 * (wet[c] * b.wet + sand[c] * b.sand + green[c] * b.grass + forest[c] * b.woods));
  }
  for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) {
    const k = j * (side + 1) + i, down = k + side + 1;
    if ([k, k + 1, down, down + 1].every(v => position[v * 3 + 1] < -4)) continue;
    indices.push(k, down, k + 1, k + 1, down, down + 1);
  }
  return {position, normal, color, index: Uint16Array.from(indices)};
}

function island(s: IslandSpec, painted:boolean) {
  const waterways = waterwayBounds(s);
  if (waterways.lower < 250 || waterways.upper > 800) throw Error('Waterway outside spacing bounds at '+s.id);
  const random = seededRandom(s.seed + 1), trees: IslandTree[] = [];
  const target = Math.round(26 * (s.radius / 225) ** 1.45);
  for (let i = 0; i < target * 35 && trees.length < target; i++) {
    const x = s.x + (random() * 2 - 1) * s.radius, z = s.z + (random() * 2 - 1) * s.radius;
    if (biome(s, x, z, shore(s, x, z)).woods < 0.4 || trees.some(t => Math.hypot(x - t.x, z - t.z) < 11)) continue;
    trees.push({x, y: meshHeight(s, x, z), z, size: 0.85 + random() * 0.54});
  }
  const cells = s.kind === 'large' ? 2 : 1, width = cells * MASK_SIDE;
  const mask = new Uint8Array(width * width);
  for (let j = 0; j < width; j++) for (let i = 0; i < width; i++) {
    const x = (s.col - 0.5 + (i + 0.5) / MASK_SIDE) * PITCH;
    const z = (s.row - 0.5 + (j + 0.5) / MASK_SIDE) * PITCH + ORIGIN_Z;
    mask[j * width + i] = Math.round(255 * smooth(-30, 2, shore(s, x, z)));
  }
  const cover = painted ? fieldRoots(s.seed,s.x-s.radius,s.z-s.radius,s.radius*2,(x,z)=>surface(s,x,z)) : undefined;
  return {kind: 'island' as const, cover, waterways, full: geometry(s, SIDE), proxy: geometry(s, 16), mask, trees};
}

function grass(s: IslandSpec, tx: number, tz: number) {
  const random = seededRandom(cellSeed(s.seed, tx, tz)), pose = new THREE.Object3D();
  const matrices: THREE.Matrix4[] = [], up = new THREE.Vector3(0, 1, 0), normal = new THREE.Vector3();
  for (let j = 0; j < 14; j++) for (let i = 0; i < 14; i++) {
    const x = (tx + (i + random()) / 14) * GRASS_TILE, z = (tz + (j + random()) / 14) * GRASS_TILE;
    const b = surface(s, x, z);
    if (random() >= (b.grass + b.woods * 0.55) * 0.91) continue;
    pose.position.set(x, b.height, z);
    pose.quaternion.setFromUnitVectors(up, normal.fromArray(b.normal));
    pose.rotateY(random() * Math.PI * 2);
    pose.scale.setScalar(0.74 + random() * 0.65);
    pose.updateMatrix();
    matrices.push(pose.matrix.clone());
  }
  for (let i = matrices.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [matrices[i], matrices[j]] = [matrices[j], matrices[i]];
  }
  const data = new Float32Array(matrices.length * 16);
  matrices.forEach((matrix, i) => matrix.toArray(data, i * 16));
  return {kind: 'grass' as const, matrices: data};
}
export const generate = (job: Job) => job.tile ? grass(job.spec, ...job.tile) : island(job.spec,!!job.painted);
export type Packet = ReturnType<typeof generate>;
export function buffers(packet: Packet): ArrayBuffer[] {
  if (packet.kind === 'grass') return [packet.matrices.buffer];
  return [...(packet.cover ? [packet.cover.anchors.buffer,packet.cover.normals.buffer] : []),packet.mask.buffer, ...[packet.full, packet.proxy].flatMap(g => [g.position.buffer, g.normal.buffer, g.color.buffer, g.index.buffer])];
}
