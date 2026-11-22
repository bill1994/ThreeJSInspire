import * as THREE from 'three';
import type { IslandTree } from './vegetation';

type Detail = 'near' | 'far' | 'reflection';
type Section = [x: number, y: number, z: number, radius: number];

// The same branch tips and crown shoulders anchor all three silhouettes.
export function coastalTreeGeometry(detail: Detail) {
  const positions: number[] = [], normals: number[] = [], colors: number[] = [];
  const bends: number[] = [], indices: number[] = [];
  const bark = new THREE.Color('#836a4e'), leaf = new THREE.Color('#83aa64');
  const near = detail === 'near', reflection = detail === 'reflection';
  function vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number,
    pigment: THREE.Color, shade: number) {
    const length = Math.hypot(nx, ny, nz);
    positions.push(x, y, z);
    normals.push(nx / length, ny / length, nz / length);
    colors.push(pigment.r * shade, pigment.g * shade, pigment.b * shade);
    bends.push(Math.min(1, Math.max(0, y / 16)) ** 2);
    return bends.length - 1;
  }
  function join(lower: number[], upper: number[]) {
    lower.forEach((v, i) => {
      const j = (i + 1) % lower.length;
      indices.push(v, upper[i], lower[j], lower[j], upper[i], upper[j]);
    });
  }
  function limb(sections: Section[], sides: number) {
    let previous: number[] = [];
    for (const [x, y, z, r] of sections) {
      const ring = Array.from({ length: sides }, (_, i) => {
        const a = 2 * Math.PI * i / sides;
        return vertex(x + r * Math.cos(a), y, z + r * Math.sin(a),
          Math.cos(a), .12, Math.sin(a), bark, .82 + .15 * Math.min(1, y / 10));
      });
      if (previous.length) join(previous, ring);
      previous = ring;
    }
  }
  function canopy(cx: number, cy: number, cz: number, width: number, height: number,
    depth: number, sides: number, phase: number) {
    const bottom = vertex(cx - .12 * width, cy - height, cz, -.15, -1, 0, leaf, .62);
    const layers = reflection ? [[0, 1]] : near ? [[-.64, .76], [-.13, 1], [.43, .9], [.8, .58]] : [[-.4, .88], [.35, .91]];
    let previous: number[] = [];
    for (const [level, radius] of layers) {
      const ring = Array.from({ length: sides }, (_, i) => {
        const a = 2 * Math.PI * i / sides + phase;
        const dx = Math.cos(a), dz = Math.sin(a);
        const scallop = 1 + .12 * Math.cos(3*a + phase) + .085 * Math.sin(5*a - .6);
        const x = dx * radius * scallop, z = dz * radius * scallop;
        const y = level + .21 * dx + .12 * Math.sin(3*a + phase);
        return vertex(cx + width * (x + .18 * level), cy + height * y, cz + depth * z,
          x + .16, level * 1.7 + .36, z, leaf, .80 + .18 * level + .035 * dx);
      });
      if (previous.length) join(previous, ring);
      else ring.forEach((v, i) => indices.push(bottom, v, ring[(i + 1) % sides]));
      previous = ring;
    }
    const top = vertex(cx + .24 * width, cy + height, cz, .1, 1, 0, leaf, 1);
    previous.forEach((v, i) => indices.push(v, top, previous[(i + 1) % sides]));
  }

  const fork: Section = [.55, 4.4, -.35, .76];
  limb([[0, -.7, 0, 1.06], fork, [4.6, 10.8, .15, .4]], near ? 6 : 3);
  if (!reflection) limb([fork, [-3.8, 8.1, 1.4, .36]], near ? 5 : 3);
  canopy(4.6, 12.8, -.4, 7.5, 3.6, 5.5, near ? 14 : reflection ? 5 : 7, .13);
  canopy(-4.4, 9.2, 1.5, 4.3, 2.3, 3.5, near ? 10 : reflection ? 4 : 6, .62);
  if (near) {
    canopy(8.7, 12.0, 1.5, 3.9, 1.9, 2.8, 8, .33);
    canopy(1.6, 12.0, -3.1, 3.5, 2.0, 3.4, 7, .51);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('bend', new THREE.Float32BufferAttribute(bends, 1));
  return geometry;
}

export function coastalTreePose(pose: THREE.Object3D, tree: IslandTree) {
  const { x, y, z, size } = tree;
  const phase = Math.sin(x * .71 + z * .43);
  pose.position.set(x, y, z);
  pose.rotation.set(0, .28 + .72 * phase, 0);
  pose.scale.set(1 + .16 * phase, 1 + .12 * Math.sin(z), 1).multiplyScalar(size);
  pose.updateMatrix();
}

export function coastalTreeBatch(capacity: number, material: THREE.Material, geometry = coastalTreeGeometry('near')) {
  const root = new THREE.Group();
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  const pose = new THREE.Object3D();
  mesh.count = 0;
  mesh.frustumCulled = false;
  root.add(mesh);
  let previous: IslandTree[] = [];
  return {root, replace(trees: IslandTree[]) {
    let changed = false;
    trees.forEach((tree, i) => {
      if (previous[i] === tree) return;
      coastalTreePose(pose, tree);
      mesh.setMatrixAt(i, pose.matrix);
      mesh.instanceMatrix.addUpdateRange(i * 16, 16);
      changed = true;
    });
    if (changed) mesh.instanceMatrix.needsUpdate = true;
    if (changed || previous.length !== trees.length) previous = trees.slice();
    mesh.count = trees.length;
  }};
}
