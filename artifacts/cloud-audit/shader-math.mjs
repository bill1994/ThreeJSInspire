/**
 * Mirror of the cloud shader's *non-noise* math, run over the real portrait frame.
 *
 * The point is not to re-implement MaterialX noise: it is to answer two questions
 * the noise itself cannot change.
 *
 *  Q1 (colour resolution): `lightAmt` depends only on the view direction, never on
 *      the cloud's own shape. So which of the four toon colours can the upper frame
 *      possibly show, and over how much of the frame?
 *  Q2 (sampling): with 12 fixed steps and no dither, how many samples does the march
 *      put inside one noise feature? <2 means the "detail" octaves are pure aliasing.
 */
import * as THREE from 'three';

const SUN = new THREE.Vector3(...[60, 35, -280]).normalize();

const CLOUD = { bottom: 95, top: 265, steps: 12, noiseScale: 0.0065, stepAlpha: 0.3 };
const WISP = { bottom: 30, top: 82, steps: 5, noiseScale: 0.0065 * 2.8, stepAlpha: 0.14 };

// --- camera, straight from the rig constants -----------------------------
const CAM = { distance: 30, height: 6.8, aimAbovePlane: 0.9, lookahead: 9, fov: 60, fovKick: 9 };
const PORTRAIT = 9 / 16;

function cameraBasis(alt, speed01) {
  const py = alt;
  const fov = CAM.fov + CAM.fovKick * speed01;
  const lead = CAM.lookahead * (0.35 + 0.65 * speed01);
  const camPos = new THREE.Vector3(0, py + CAM.height, CAM.distance); // plane at origin flying -Z
  const aim = new THREE.Vector3(0, py + CAM.aimAbovePlane, -lead);
  const fwd = aim.clone().sub(camPos).normalize();
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
  const pitchDeg = (Math.asin(fwd.y) * 180) / Math.PI;
  return { camPos, fwd, right, up, fov, pitchDeg, lead };
}

/** Ray direction for normalised device coords, matching the perspective camera. */
function rayDir(b, ndcX, ndcY) {
  const th = Math.tan((b.fov * Math.PI) / 360);
  const ty = ndcY * th;
  const tx = ndcX * th * PORTRAIT;
  return b.fwd
    .clone()
    .addScaledVector(b.right, tx)
    .addScaledVector(b.up, ty)
    .normalize();
}

/** Mirror of slabRayT in clouds-compute.ts. */
function slabRayT(camY, dirY, tMax, bottom, top) {
  const dyAbs = Math.max(Math.abs(dirY), 0.002);
  const tB = (bottom - camY) / dyAbs;
  const tT = (top - camY) / dyAbs;
  const t0 = Math.max(Math.min(tB, tT), 0);
  const t1 = Math.min(Math.max(tB, tT), tMax);
  return { t0, span: Math.max(t1 - t0, 0) };
}

function classify(dir) {
  const d = Math.max(dir.dot(SUN), 0);
  const sunTight = Math.pow(d, 24);
  const sunWide = Math.pow(d, 6);
  const lightAmt = Math.min(Math.max(sunTight * 0.8 + sunWide * 0.2, 0), 1);
  const band1 = smoothstep(0.22, 0.25, lightAmt);
  const band2 = smoothstep(0.58, 0.61, lightAmt);
  // rims only exist where sunTight*edge can clear 0.30 -> edge==1 is the best case
  const rimPossible = smoothstep(0.3, 0.33, sunTight) > 0;
  return { sunTight, sunWide, lightAmt, band1, band2, rimPossible };
}
function smoothstep(a, b, x) {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

const NAMES = ['shadow', 'base', 'pink'];
const colorsOf = (c) => (c.band2 > 0 ? NAMES[2] : c.band1 > 0 ? NAMES[1] : NAMES[0]);

// --- Q1: colour map of the upper 60% of the frame ------------------------
for (const speed01 of [0, 1]) {
  const b = cameraBasis(60, speed01);
  const counts = { shadow: 0, base: 0, pink: 0, rim: 0 };
  let total = 0;
  const rows = 60;
  const cols = 34;
  const rowSummary = [];
  for (let r = 0; r < rows; r++) {
    // ndcY = +1 is the top of the frame
    const ndcY = 1 - (r / (rows - 1)) * 1.2;
    let rowCounts = { shadow: 0, base: 0, pink: 0, rim: 0 };
    for (let c = 0; c < cols; c++) {
      const ndcX = -1 + (c / (cols - 1)) * 2;
      const dir = rayDir(b, ndcX, ndcY);
      if (dir.y <= 0) continue;
      const cl = classify(dir);
      counts[colorsOf(cl)]++;
      rowCounts[colorsOf(cl)]++;
      if (cl.rimPossible && cl.band1 > 0) counts.rim++;
      total++;
    }
    rowSummary.push({ ndcY: +ndcY.toFixed(2), ...rowCounts });
  }
  const pct = (n) => +(100 * n / total).toFixed(1);
  console.log(`\n=== speed01=${speed01}  pitch=${b.pitchDeg.toFixed(1)}deg  fov=${b.fov} ===`);
  console.log(
    `upper-frame colour split: shadow ${pct(counts.shadow)}%  base ${pct(counts.base)}%  pink ${pct(counts.pink)}%  (gold-rim reachable on ${pct(counts.rim)}%)`,
  );
  console.log('top 6 rows (ndcY>=0.8):', JSON.stringify(rowSummary.slice(0, 6)));
}

// --- Q2: samples per noise feature along the march ----------------------
console.log('\n=== sampling density: samples inside one noise feature ===');
const feature = (scale) => 1 / scale;
const specs = [
  { name: 'cloud base worley', scale: CLOUD.noiseScale },
  { name: 'cloud erodeCoarse x1.7', scale: CLOUD.noiseScale * 1.7 },
  { name: 'cloud erodeFine  x4.3', scale: CLOUD.noiseScale * 4.3 },
  { name: 'cloud vertical y*2.6', scale: CLOUD.noiseScale * 2.6 },
  { name: 'wisp base', scale: WISP.noiseScale },
];
const b60 = cameraBasis(60, 1);
for (const elev of [3, 5, 8, 12, 20, 30, 45, 60, 80]) {
  const dir = new THREE.Vector3(0, Math.sin((elev * Math.PI) / 180), -Math.cos((elev * Math.PI) / 180));
  const m = slabRayT(b60.camPos.y, dir.y, 900, CLOUD.bottom, CLOUD.top);
  const dt = m.span / CLOUD.steps;
  const w = slabRayT(b60.camPos.y, dir.y, 900, WISP.bottom, WISP.top);
  const wdt = w.span / WISP.steps;
  const row = specs.map((s) => `${(feature(s.scale) / dt).toFixed(2)}`);
  const wrow = (feature(WISP.noiseScale) / wdt).toFixed(2);
  console.log(
    `elev ${String(elev).padStart(2)}deg  span ${m.span.toFixed(0).padStart(4)}m  dt ${dt.toFixed(1).padStart(5)}m  ` +
      `samples/feature [${row.join(', ')}]   wisp dt ${wdt.toFixed(1)}m samples/feature ${wrow}`,
  );
}

// --- Q3: how much opaque cloud can 12 steps actually produce? -----------
console.log('\n=== alpha ceiling: 12 steps x 0.30 stepAlpha, density 0..1 ===');
for (const density of [0.15, 0.3, 0.5, 0.7, 1.0]) {
  let t = 1;
  for (let i = 0; i < CLOUD.steps; i++) t *= 1 - density * CLOUD.stepAlpha;
  console.log(`  density ${density.toFixed(2)} -> alpha ${(1 - t).toFixed(3)}`);
}
console.log('wisp (5 steps x 0.14):');
for (const density of [0.3, 0.5, 0.8]) {
  let t = 1;
  for (let i = 0; i < WISP.steps; i++) t *= 1 - density * WISP.stepAlpha;
  console.log(`  density ${density.toFixed(2)} -> alpha ${(1 - t).toFixed(3)}`);
}
