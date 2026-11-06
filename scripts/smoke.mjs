import { existsSync, readFileSync, statSync } from 'node:fs';

// Explicit list on purpose: a module that vanishes in a refactor should fail here.
// Keep it in sync when a module lands or is renamed -- the guard is only as good as
// the list. `src/sea-fft.ts` and `src/clouds-compute.ts` were removed on 2026-11-04;
// the whole `src/sea/` directory and `src/sun-road.ts` followed on 2026-11-06
// (`rebuild/sea-dome-reset`). A sea module that comes back has to be added here.
const modules = [
  'src/renderer.ts',
  'src/palettes.ts',
  'src/lights.ts',
  'src/world.ts',
  'src/sky-webgpu.ts',
  'src/far-field.ts',
  'src/puff-cloud.ts',
  'src/puff-field.ts',
  'src/puff-shape.ts',
  'src/post.ts',
  'src/toon.ts',
  'src/stall.ts',
  'src/skim.ts',
  'src/spiral.ts',
  'src/director.ts',
  'src/in-cloud.ts',
  'src/horizon.ts',
  'src/subtitles.ts',
  'src/portrait.ts',
  'src/qa.ts',
  'src/game.ts',
  'src/plane.ts',
  'src/input.ts',
  'src/camera-rig.ts',
  'src/feel.ts',
  'src/hud.ts',
  'src/audio.ts',
  'src/main.ts',
  'index.html',
  'package.json',
];

const assets = [
  // v001 is the archived predecessor and is kept forever by ruling. Its .blend is
  // not loadable (fabricated header, no DNA1/ENDB) -- the check here is existence
  // only, because v002.blend is the real source of record.
  'assets/blend/porco-fighter-v001.blend',
  'assets/blend/porco-fighter-v002.blend',
  'assets/porco-fighter.glb',
  'assets/porco-fighter-v002.glb',
  'public/assets/porco-fighter-v002.glb',
];

let failed = false;

const miss = [...modules, ...assets].filter((f) => !existsSync(f));
if (miss.length) {
  console.error('missing: ' + miss.join(', '));
  failed = true;
}

// v002 is what the game actually loads, so it is the one that must be a real GLB.
for (const glb of ['assets/porco-fighter-v002.glb', 'public/assets/porco-fighter-v002.glb']) {
  if (!existsSync(glb)) continue;
  const head = readFileSync(glb).subarray(0, 4).toString('ascii');
  const size = statSync(glb).size;
  if (head !== 'glTF' || size < 1024) {
    console.error(`${glb} is not a valid GLB (magic=${head}, size=${size})`);
    failed = true;
  }
}

// --- v002 airframe contract (Batch E) -----------------------------------------
// The GLB is the only aircraft the game renders, and its promises are structural:
// six livery materials plane.ts matches on by name, a non-trivial mesh count, a
// 3-5k tri budget, a nose still pointing +Z, and a served copy identical to the
// archived one. The loader tests deliberately run with every GLB request failing,
// so a silent regression here would be invisible to them. This lives in smoke.mjs
// rather than vitest because it is a build-artifact check and the project has no
// @types/node for the test tsconfig.
const EXPECTED_MATERIALS = [
  'dark_trim',
  'glass_canopy',
  'livery_green',
  'livery_red',
  'livery_white',
  'metal_prop',
];

function readGltfJson(path) {
  const buf = readFileSync(path);
  const jsonLength = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== 0x4e4f534a) return null; // 'JSON'
  return JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8'));
}

function checkAirframe() {
  const archived = 'assets/porco-fighter-v002.glb';
  if (!existsSync(archived)) return;
  const gltf = readGltfJson(archived);
  if (!gltf) {
    console.error(`${archived}: JSON chunk missing`);
    failed = true;
    return;
  }

  const materials = (gltf.materials ?? []).map((m) => m.name).sort();
  if (materials.join(',') !== EXPECTED_MATERIALS.join(',')) {
    console.error(`airframe materials drifted: ${materials.join(', ')}`);
    failed = true;
  }

  const meshCount = (gltf.meshes ?? []).length;
  if (meshCount < 25) {
    console.error(`airframe has only ${meshCount} meshes`);
    failed = true;
  }

  let tris = 0;
  for (const mesh of gltf.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      if (typeof prim.indices === 'number') {
        tris += Math.floor(gltf.accessors[prim.indices].count / 3);
      }
    }
  }
  if (tris < 3000 || tris > 5000) {
    console.error(`airframe tri count ${tris} is outside the 3-5k budget`);
    failed = true;
  }

  // The exporter converts Blender's Z-up / nose -Y into Y-up / nose +Z, and plane.ts
  // relies on that. If the nose flipped, max Z would stop being the forward end.
  const zs = (gltf.nodes ?? [])
    .map((n) => (n.translation ? n.translation[2] : undefined))
    .filter((z) => typeof z === 'number');
  if (!(Math.max(...zs) > 4 && Math.min(...zs) < -3)) {
    console.error('airframe nose no longer points +Z');
    failed = true;
  }

  const served = 'public/assets/porco-fighter-v002.glb';
  if (existsSync(served) && !readFileSync(served).equals(readFileSync(archived))) {
    console.error(`${served} is out of date with ${archived}`);
    failed = true;
  }
}

checkAirframe();

if (failed) process.exit(1);
console.log('smoke ok');