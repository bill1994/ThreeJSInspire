import { existsSync, readFileSync, statSync } from 'node:fs';

const modules = [
  'src/renderer.ts',
  'src/palettes.ts',
  'src/lights.ts',
  'src/world.ts',
  'src/sea-fft.ts',
  'src/clouds-compute.ts',
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
  'assets/blend/porco-fighter-v001.blend',
  'assets/porco-fighter.glb',
  'public/assets/porco-fighter.glb',
];

let failed = false;

const miss = [...modules, ...assets].filter((f) => !existsSync(f));
if (miss.length) {
  console.error('missing: ' + miss.join(', '));
  failed = true;
}

for (const glb of ['assets/porco-fighter.glb', 'public/assets/porco-fighter.glb']) {
  if (!existsSync(glb)) continue;
  const head = readFileSync(glb).subarray(0, 4).toString('ascii');
  const size = statSync(glb).size;
  if (head !== 'glTF' || size < 1024) {
    console.error(`${glb} is not a valid GLB (magic=${head}, size=${size})`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log('smoke ok');
