import * as THREE from 'three';
import { GRID, createTerrain, seededRandom, smooth } from './terrain';

export async function mountIsland(scene: THREE.Scene, seed: number, vegetation = false, painted = true, fieldSun?: THREE.Vector3) {
  const { MeshLambertNodeMaterial } = await import('three/webgpu');
  const { diffuseColor, uniform, positionWorld, cameraPosition, smoothstep } = await import('three/tsl');
  const fill = uniform(new THREE.Color());
  const haze = uniform(new THREE.Color());
  const air = smoothstep(100, 1150, positionWorld.distance(cameraPosition)).mul(0.22);
  // Soft skylight preserves the painted local colours on the backlit face.
  const ambient = diffuseColor.rgb.mul(fill).add(haze.mul(air));
  const terrain = createTerrain(seed);
  const group = new THREE.Group();
  group.name = 'single-island';
  const ground = new MeshLambertNodeMaterial({ vertexColors: true, fog: false });
  Object.assign(ground, { emissiveNode: ambient });
  const wet = new THREE.Color('#bca884'), dry = new THREE.Color('#efd69f');
  const meadow = new THREE.Color('#a4ba64'), slope = new THREE.Color('#70a36b');
  const woods = new THREE.Color('#709660'), color = new THREE.Color(), grass = new THREE.Color();
  let bytes = 0, triangles = 0;
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
    const positions: number[] = [], normals: number[] = [], colors: number[] = [], indices: number[] = [];
    for (let j = 0; j <= 16; j++) for (let i = 0; i <= 16; i++) {
      const x = GRID.x + (col * 16 + i) * GRID.step, z = GRID.z + (row * 16 + j) * GRID.step;
      const s = terrain.sample(x, z);
      positions.push(x, s.height, z);
      normals.push(...s.normal);
      const shade = 0.48 + 0.22 * Math.sin(x / 33 + z / 58) + 0.23 * Math.sin(z / 34 - x / 68);
      grass.copy(meadow).lerp(slope, shade);
      color.setRGB(wet.r * s.wet + dry.r * s.sand + grass.r * s.grass + woods.r * s.woods,
        wet.g * s.wet + dry.g * s.sand + grass.g * s.grass + woods.g * s.woods,
        wet.b * s.wet + dry.b * s.sand + grass.b * s.grass + woods.b * s.woods);
      colors.push(color.r, color.g, color.b);
    }
    for (let j = 0; j < 16; j++) for (let i = 0; i < 16; i++) {
      const k = j * 17 + i;
      // The opaque ocean covers the deep shelf. Keep only shore-adjacent cells.
      const y = k * 3 + 1;
      if (Math.max(positions[y], positions[y + 3], positions[y + 51], positions[y + 54]) < -4) continue;
      indices.push(k, k + 17, k + 1, k + 1, k + 17, k + 18);
    }
    if (!indices.length) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    bytes += (positions.length + normals.length + colors.length) * 4 + indices.length * 2;
    triangles += indices.length / 3;
    group.add(new THREE.Mesh(geometry, ground));
  }
  const chunks = group.children.length;
  const random = seededRandom(seed + 1);
  const trees: { x: number; y: number; z: number; size: number }[] = [];
  for (let i = 0; i < 1600 && trees.length < 24; i++) {
    const x = -155 + random() * 380, z = -530 + random() * 250, s = terrain.sample(x, z);
    if (s.woods < 0.32 || trees.some(t => Math.hypot(x - t.x, z - t.z) < 12)) continue;
    trees.push({ x, y: s.height, z, size: 0.82 + random() * 0.52 });
  }
  const bark = new MeshLambertNodeMaterial({ color: '#77583d', fog: false });
  const leaves = new MeshLambertNodeMaterial({ fog: false });
  Object.assign(bark, { emissiveNode: ambient });
  Object.assign(leaves, { emissiveNode: ambient });
  const flora = vegetation ? await (await import('./vegetation')).plantIsland(group, terrain, trees, seed, bark, leaves, ground, false, painted,fieldSun ? {sun:fieldSun,horizon:haze.value} : undefined) : null;
  if (!flora) {
    const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.6, 1.15, 8, 6), bark, trees.length);
    const crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), leaves, trees.length * 3);
    const pose = new THREE.Object3D();
    trees.forEach(({ x, y, z, size }, i) => {
      pose.position.set(x, y + 3.7 * size, z);
      pose.rotation.set(0, random() * 6, 0.08 * (random() - 0.5));
      pose.scale.setScalar(size);
      pose.updateMatrix();
      trunks.setMatrixAt(i, pose.matrix);
      const leafColor = new THREE.Color('#477c59').lerp(new THREE.Color('#7fa05b'), random());
      for (let lobe = 0; lobe < 3; lobe++) {
        const a = lobe * 2.1 + i * 1.3, offset = lobe === 0 ? 0 : 3.4;
        pose.position.set(x + Math.cos(a) * offset * size, y + (lobe === 0 ? 11 : 8.6) * size, z + Math.sin(a) * offset * size);
        pose.rotation.set(0, a, 0.12 * Math.sin(a));
        pose.scale.set(5.4 * size, (lobe === 0 ? 5.5 : 4.1) * size, 4.9 * size);
        pose.updateMatrix();
        crowns.setMatrixAt(i * 3 + lobe, pose.matrix);
        crowns.setColorAt(i * 3 + lobe, leafColor);
      }
    });
    group.add(trunks, crowns);
  }
  scene.add(group);
  // Texel centres correspond to grid vertices. The outermost rows are deep water.
  const size = GRID.cells + 1;
  const pixels = Uint8Array.from(terrain.shore, d => Math.round(smooth(-30, 2, d) * 255));
  const texture = new THREE.DataTexture(pixels, size, size, THREE.RedFormat);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  const coast = { texture, x: GRID.x - GRID.step / 2, z: GRID.z - GRID.step / 2, span: size * GRID.step };
  function setLight(elevation: number, horizon: readonly number[]) {
    const day = smooth(-8, 4, elevation);
    const dusk = day * (1 - smooth(10, 48, elevation));
    fill.value.setRGB(0.035 + day * 0.19 + dusk * 0.24, 0.065 + day * 0.18 + dusk * 0.12, 0.14 + day * 0.15);
    haze.value.setRGB(horizon[0], horizon[1], horizon[2]);
    ground.color.setRGB(0.54 + 0.46 * day, 0.70 + 0.30 * day, 1);
    leaves.color.copy(ground.color);
  }
  return {
    terrain, coast, setLight, flora, counts: {
      chunks, triangles, trees: trees.length, crownInstances: trees.length * (flora ? 5 : 3),
      draws: chunks + (flora ? flora.stats.treeBatches * 2 + flora.stats.cells + 1 : 2),
      terrainBytes: bytes, shoreBytes: pixels.byteLength
    }
  };
}
