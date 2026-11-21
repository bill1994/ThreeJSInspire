import * as THREE from 'three';
import { FlightTrail, type Point } from './airflow';
import { GRID, seededRandom, type createTerrain } from './terrain';
import type { FieldLight } from './field-shading';
import { createDebris } from './vegetation-particles';

export interface IslandTree extends Point { size: number }
type Terrain = Pick<ReturnType<typeof createTerrain>, 'sample'>;
type Lambert = import('three/webgpu').MeshLambertNodeMaterial;

function grassClump(meadow: boolean, painted: boolean) {
  const positions: number[] = [], colors: number[] = [], tips: number[] = [], indices: number[] = [];
  const folds: number[] = [];
  const random = seededRandom(3109);
  const root = new THREE.Color(meadow ? '#8da966' : '#7d9b5f'), tip = new THREE.Color(meadow ? '#cadd8d' : '#cbcd87');
  for (let blade = 0; blade < (meadow ? 12 : 7); blade++) {
    const angle = blade * 2.4 + random() * 0.55;
    const dx = Math.cos(angle), dz = Math.sin(angle);
    const radius = random() * 0.72, width = 0.10 + random() * 0.12;
    const height = 0.68 + random() * 0.72;
    // Several uneven fans per instance read as a grassy patch at flight speed.
    const fan = Math.floor(blade / 4) * 2.4;
    const spread = meadow ? 0.84 : 0;
    const baseX = spread * Math.cos(fan), baseZ = spread * Math.sin(fan);
    const reach = meadow ? 0.9 + 0.6 * Math.sin(fan + 1) : 1;
    const offset = tips.length;
    for (const [side, t] of [[-1, 0], [1, 0], [-0.64, 0.56], [0.64, 0.56], [0, 1]]) {
      const lean = radius + t * t * 0.61;
      positions.push(baseX + dx * lean - dz * side * width + spread * t*t, t * height * reach - 0.10,
        baseZ + dz * lean + dx * side * width);
      colors.push(...root.clone().lerp(tip, meadow ? t*(0.67+0.26*Math.cos(fan)) : t*0.77).toArray());
      tips.push(t * t);
      if (painted) folds.push(side * (0.4 + 0.6*t));
    }
    for (const i of [0, 1, 2, 2, 1, 3, 2, 3, 4]) indices.push(offset + i);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  if (painted) geo.setAttribute('fold',new THREE.Float32BufferAttribute(folds,1));
  geo.setAttribute('bend', new THREE.Float32BufferAttribute(tips, 1));
  geo.setIndex(indices);
  // Both sides of a small blade receive the meadow's broad skylight.
  const normals = new Float32Array(positions.length);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  return geo;
}

export async function plantIsland(group: THREE.Group, terrain: Terrain, trees: IslandTree[], seed: number,
  bark: Lambert, leaves: Lambert, ground: Lambert, streamed = false, meadow = false, field?: FieldLight, farTrees?: Lambert) {
  const T = await import('three/tsl');
  const clock = T.uniform(0);
  const range = T.uniform(115);
  const wakeGain = T.uniform(1);
  const trail = new FlightTrail();
  const path = T.uniformArray<'vec4'>(trail.points, 'vec4');
  // Instance matrices already put positionLocal in island coordinates. Apply
  // the strongest nearby segment once so slow frames and overlapping segments
  // cannot add multiple kicks. The decaying cosine supplies a small overshoot.
  const bend = (part: 'grass' | 'branch' | 'crown') => T.Fn(() => {
    const isGrass = part === 'grass';
    const p = T.positionLocal;
    const weight = part === 'crown' ? T.float(1) : T.attribute('bend', 'float');
    const wind = p.x.mul(0.14).add(p.z.mul(0.087)).add(clock.mul(1.8)).sin()
      .add(p.z.mul(0.29).sub(clock.mul(2.8)).sin().mul(0.32));
    const motion = T.vec2(0).toVar();
    const strongest = T.float(0).toVar();
    T.If(p.xz.distance(path.element(0).xz).lessThan(150), () => {
      T.Loop(8, ({ i }) => {
        const a = path.element(i.add(1)), b = path.element(i);
        const ab = b.xz.sub(a.xz);
        const len2 = ab.dot(ab).max(0.001);
        const f = p.xz.sub(a.xz).dot(ab).div(len2).clamp();
        const nearest = T.mix(a, b, f);
        const delta = p.xz.sub(nearest.xz);
        const sideways = T.vec2(ab.y.negate(), ab.x).div(len2.sqrt());
        const age = clock.sub(nearest.w).max(0);
        const speed = ab.length().div(b.w.sub(a.w).max(0.001));
        const kick = T.smoothstep(15, 55, speed)
          .mul(T.smoothstep(3, isGrass ? 15 : 18, delta.length()).oneMinus())
          .mul(T.smoothstep(isGrass ? 12 : 6, isGrass ? 27 : 21, nearest.y.sub(p.y).abs()).oneMinus())
          .mul(age.mul(-2.6).exp());
        T.If(kick.greaterThan(strongest), () => {
          strongest.assign(kick);
          const side = delta.dot(sideways).mul(0.8).clamp(-1, 1);
          motion.assign(sideways.mul(side).mul(kick).mul(age.mul(3.4).cos()));
        });
      });
    });
    const sweep = motion.mul(wakeGain).mul(isGrass ? 1.65 : 0.78).add(T.vec2(wind.mul(isGrass ? 0.20 : 0.14), wind.mul(0.06)));
    const y = isGrass ? motion.length().mul(wakeGain).mul(-0.68) : wind.mul(0.045);
    const shifted = p.add(T.vec3(sweep.x, y, sweep.y).mul(weight));
    if (isGrass && field) {
      // Blades already match the ground pigment at this distance. Retract
      // only their free ends, from a root fixed to the slope, at the last LOD.
      const distance = p.distance(T.cameraPosition);
      const retire = T.smoothstep(range.mul(.86),range,distance);
      const height = T.positionGeometry.y.add(.10).max(0);
      return shifted.sub(T.vec3(0,retire.mul(height).mul(1.55),0));
    }
    // Lower far grass beneath the surface before its cell is distance-culled.
    if (isGrass) return shifted.sub(T.vec3(0, T.smoothstep(range.mul(0.74), range, p.xz.distance(T.cameraPosition.xz)).mul(2.5), 0));
    return part === 'branch' ? T.mix(p, shifted, 0.40) : shifted;
  })();
  const grassMat = ground.clone();
  grassMat.side = THREE.DoubleSide;
  grassMat.normalNode = T.normalViewGeometry;
  grassMat.positionNode = bend('grass');
  leaves.positionNode = bend('crown');
  bark.positionNode = bend('branch');
  const grassShape = grassClump(meadow,!!field);
  let strokes: Lambert | undefined;
  if (field) {
    strokes = (await import('./field-shading')).shadeField(ground,grassMat,leaves,farTrees,field,clock);
    if (!streamed) {
      const {fieldRoots,fieldGeometry}=await import('./field-cover');
      const roots=fieldRoots(seed,GRID.x,GRID.z,GRID.cells*GRID.step,terrain.sample);
      group.add(new THREE.Mesh(fieldGeometry(roots),strokes));
    }
  } else if (meadow) {
    (await import('./meadow')).paintMeadow(ground);
    const p = T.positionWorld;
    const patch = p.x.div(17).add(p.z.div(29).sin().mul(2)).sin().mul(p.z.div(38).sub(p.x.div(51)).cos());
    grassMat.colorNode = T.materialColor.rgb.mul(T.vec3(patch.mul(0.17).add(1),patch.mul(0.07).add(1),patch.mul(-0.1).add(1)));
  }
  const random = seededRandom(seed + 72), pose = new THREE.Object3D();
  const up = new THREE.Vector3(0, 1, 0), normal = new THREE.Vector3();
  const cells: { mesh: THREE.InstancedMesh; x: number; z: number; count: number }[] = [];
  const tile = 32, gridWidth = GRID.cells * GRID.step;
  let clumps = 0;
  // Independent jittered lattice, deterministic shuffle for evenly distributed
  // low-tier prefixes. All infill is generated only once on this single island.
  for (let z = GRID.z; !streamed && z < GRID.z + gridWidth; z += tile) for (let x = GRID.x; x < GRID.x + gridWidth; x += tile) {
    const roots: THREE.Matrix4[] = [];
    for (let j = 0; j < 14; j++) for (let i = 0; i < 14; i++) {
      const px = x + (i + random()) * tile / 14, pz = z + (j + random()) * tile / 14;
      const s = terrain.sample(px, pz);
      if (random() > (s.grass + s.woods * 0.55) * 0.91) continue;
      pose.position.set(px, s.height, pz);
      pose.quaternion.setFromUnitVectors(up, normal.fromArray(s.normal));
      pose.rotateY(random() * Math.PI * 2);
      pose.scale.setScalar(0.74 + random() * 0.65);
      pose.updateMatrix();
      roots.push(pose.matrix.clone());
    }
    if (!roots.length) continue;
    const mesh = new THREE.InstancedMesh(grassShape, grassMat, roots.length);
    for (let i = roots.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [roots[i], roots[j]] = [roots[j], roots[i]];
    }
    roots.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
    mesh.computeBoundingSphere();
    mesh.boundingSphere!.radius += 2;
    group.add(mesh);
    cells.push({ mesh, x: x + tile / 2, z: z + tile / 2, count: roots.length });
    clumps += roots.length;
  }

  const trunkShape = new THREE.CylinderGeometry(0.63, 1.10, 1, 7);
  const trunkPositions = trunkShape.getAttribute('position');
  trunkShape.setAttribute('bend', new THREE.Float32BufferAttribute(
    Array.from({ length: trunkPositions.count }, (_, i) => (trunkPositions.getY(i) + 0.5) ** 2), 1));
  const crownShape = new THREE.IcosahedronGeometry(1, 2);
  const vertices = crownShape.getAttribute('position'), crownColors = [];
  for (let i = 0; i < vertices.count; i++) {
    const x = vertices.getX(i), y = vertices.getY(i), z = vertices.getZ(i);
    const lobes = 1 + 0.085 * Math.sin(4 * x + z) * Math.cos(3 * z - 2 * y) + 0.046 * Math.sin(6 * y + x);
    vertices.setXYZ(i, x * lobes, y * lobes + 0.06 * x, z * lobes);
    const sunward = 0.5 + 0.5 * y;
    crownColors.push(0.82 + 0.18 * sunward, 0.88 + 0.12 * sunward, 0.89 + 0.07 * sunward);
  }
  crownShape.setAttribute('color', new THREE.Float32BufferAttribute(crownColors, 3));
  leaves.vertexColors = true;
  function writeTree(branches: THREE.InstancedMesh, crowns: THREE.InstancedMesh, tree: IslandTree, i: number, random: () => number) {
    const { x, y, z, size } = tree;
    const twist = random() * 6.28;
    for (let j = 0; j < 3; j++) {
      const a = twist + j * 2.6, branch = j > 0;
      pose.position.set(x + (branch ? 1.5 * Math.cos(a) * size : 0), y + (branch ? 6.7 : 4) * size,
        z + (branch ? 1.5 * Math.sin(a) * size : 0));
      pose.rotation.set(0, -a, branch ? -0.70 : 0.04, 'YXZ');
      pose.scale.set(branch ? 0.62 : 1, branch ? 5 : 8.4, branch ? 0.62 : 1).multiplyScalar(size);
      pose.updateMatrix(); branches.setMatrixAt(i * 3 + j, pose.matrix);
    }
    const tone = new THREE.Color('#507f60').lerp(new THREE.Color('#8aa764'), random());
    for (let j = 0; j < 5; j++) {
      const a = twist + j * 2.4, radius = j === 0 ? 0 : (3 + random() * 1.6) * size;
      pose.position.set(x + Math.cos(a) * radius, y + (j === 0 ? 12.7 : 8.9 + random() * 1.8) * size, z + Math.sin(a) * radius);
      pose.rotation.set(0.12 * Math.cos(a), a, 0.2 * Math.sin(a));
      pose.scale.set(4.8 + random(), 3.1 + random() * 1.6, 4.6 + random()).multiplyScalar(size);
      pose.updateMatrix(); crowns.setMatrixAt(i * 5 + j, pose.matrix);
      crowns.setColorAt(i * 5 + j, tone.clone().multiplyScalar(j === 0 ? 1.1 : 0.91 + random() * 0.13));
    }
  }
  function nearTreeBatch(capacity: number) {
    const root = new THREE.Group();
    const branches = new THREE.InstancedMesh(trunkShape, bark, capacity * 3);
    const crowns = new THREE.InstancedMesh(crownShape, leaves, capacity * 5);
    crowns.setColorAt(0,new THREE.Color());
    branches.frustumCulled = crowns.frustumCulled = false;
    branches.count = crowns.count = 0;
    root.add(branches, crowns); group.add(root);
    let previous: IslandTree[] = [];
    return {root, replace(list: IslandTree[]) {
      if (list.length === previous.length && list.every((t,i)=>t===previous[i])) return;
      list.forEach((tree,i) => {
        if (tree === previous[i]) return;
        writeTree(branches,crowns,tree,i,seededRandom(Math.imul(Math.round(tree.x*64),73856093)^Math.round(tree.z*64)));
      });
      previous = list.slice();
      branches.count = list.length * 3; crowns.count = list.length * 5;
      branches.instanceMatrix.needsUpdate = crowns.instanceMatrix.needsUpdate = true;
      crowns.instanceColor!.needsUpdate = true;
    }};
  }
  function growTrees(root: THREE.Group, list: IslandTree[], random: () => number) {
    const batches = new Map<string, IslandTree[]>();
    for (const tree of list) {
      const batchWidth = 96;
      const key = Math.floor(tree.x / batchWidth) + ',' + Math.floor(tree.z / batchWidth);
      if (!batches.has(key)) batches.set(key, []);
      batches.get(key)!.push(tree);
    }
    for (const grove of batches.values()) {
      const capacity = grove.length;
      const branches = new THREE.InstancedMesh(trunkShape, bark, capacity * 3);
      const crowns = new THREE.InstancedMesh(crownShape, leaves, capacity * 5);
      branches.count = grove.length * 3;
      crowns.count = grove.length * 5;
      grove.forEach((tree, i) => writeTree(branches, crowns, tree, i, random));
      crowns.computeBoundingSphere(); crowns.boundingSphere!.radius += 1.5;
      root.add(branches, crowns);
    }
    return batches.size;
  }
  const initialBatches = growTrees(group, trees, random);
  const debris = await createDebris(group, terrain, trees, clock, seed, streamed);
  const stats = { clumps, cells: cells.length, treeBatches: initialBatches, visibleCells: 0, activeClumps: 0, debris: debris.stats };
  const previous = new THREE.Vector3();
  function update(time: number, p: Point, eye: Point, high: boolean) {
    const distance = trail.advance(p, time);
    clock.value = time;
    range.value = meadow ? (high ? 145 : 98) : (high ? 115 : 78);
    stats.visibleCells = stats.activeClumps = 0;
    for (const cell of cells) {
      const bounds = cell.mesh.boundingSphere!;
      cell.mesh.visible = field
        ? Math.hypot(eye.x-bounds.center.x,eye.y-bounds.center.y,eye.z-bounds.center.z) < range.value+bounds.radius
        : Math.hypot(eye.x-cell.x,eye.z-cell.z) < range.value+24 && Math.abs(eye.y-25) < 220;
      if (!cell.mesh.visible) continue;
      cell.mesh.count = high ? cell.count : Math.ceil(cell.count * 0.62);
      stats.visibleCells++;
      stats.activeClumps += cell.mesh.count;
    }
    grassMat.color.copy(ground.color);
    debris.update(time, previous, p, distance, high, ground.color);
    previous.set(p.x, p.y, p.z);
  }
  const idleGrass: THREE.InstancedMesh[] = [];
  function addGrass(x: number, z: number, matrices: Float32Array) {
    const count = matrices.length / 16;
    if (!count) return () => {};
    // All 14x14 tiles use the same layout. Recycle the GPU buffers and
    // pipeline when tiles leave the resident disk, including over open water.
    const mesh = idleGrass.pop() ?? new THREE.InstancedMesh(grassShape, grassMat, 14 * 14);
    mesh.count = count;
    mesh.instanceMatrix.array.set(matrices);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.boundingSphere!.radius += 2;
    const cell = {mesh, x, z, count};
    cells.push(cell);
    group.add(mesh);
    stats.cells++; stats.clumps += count;
    return () => {
      cells.splice(cells.indexOf(cell), 1);
      mesh.removeFromParent(); idleGrass.push(mesh);
      stats.cells--; stats.clumps -= count;
    };
  }
  return { update, stats, strokes, nearTreeBatch, addGrass, setWakeEnabled(enabled: boolean) { wakeGain.value = enabled ? 1 : 0; } };
}
