/**
 * 径向包络可行性验证（只读，不参与构建）。
 *
 * 复现 puff-shape.ts 的 lobes 布局，对同一批球做两件事：
 *   1. 硬并集（径向 max）—— 现状几何的剪影近似
 *   2. log-sum-exp 融合 —— 方案 A
 * 然后比较半径曲线的二阶差分（折痕）与包围盒。
 *
 * 用法: node artifacts/archive/puff-shell-fusion/shell-probe.mjs [variant] [detail] [k]
 */

import * as THREE from 'three';

// ---- 与 puff-shape.ts 完全一致的布局（RNG 序列不许变）----
const PUFF_VARIANTS = {
  bank: { width: 30, aspect: 0.85, lobeDiameter: 0.62, spineFrac: 0.6 },
  tower: { width: 22, aspect: 1.95, lobeDiameter: 0.62, spineFrac: 0.62 },
  scraps: { width: 24, aspect: 0.55, lobeDiameter: 0.62, spineFrac: 0.5 },
  leviathan: { width: 48, aspect: 1.15, lobeDiameter: 0.62, spineFrac: 0.6 },
};

function mulberry32(seed) {
  let a = Math.imul(Math.floor(seed) || 1, 0x6d2b79f5) >>> 0;
  return () => {
    a = (Math.imul(a ^ (a >>> 15), a | 1) >>> 0) + 0x6d2b79f5;
    let t = Math.imul(a ^ (a >>> 7), a | 61) ^ a;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildLobes(variant, seed) {
  const rand = mulberry32(seed);
  const spec = PUFF_VARIANTS[variant];
  const halfW = spec.width / 2;
  const height = spec.width * spec.aspect;
  const halfH = height / 2;
  const lobeR = (spec.lobeDiameter * spec.width) / 2;

  const n = Math.max(7, Math.round(9 + (rand() - 0.5) * 4));
  const spine = Math.max(3, Math.round(n * spec.spineFrac));
  const flanks = Math.max(1, n - spine);
  const step = Math.max(lobeR * 0.55, (height - lobeR * 2) / Math.max(1, spine - 1));

  const lobes = [];
  for (let i = 0; i < spine; i += 1) {
    const u = spine === 1 ? 0.5 : i / (spine - 1);
    const swell = 0.86 + 0.24 * Math.sin(Math.PI * Math.pow(u, 0.8));
    lobes.push({
      x: (rand() - 0.5) * lobeR * 0.7,
      y: -halfH + lobeR + i * step + (rand() - 0.5) * step * 0.22,
      z: (rand() - 0.5) * lobeR * 0.9,
      r: lobeR * swell * (0.92 + rand() * 0.16),
    });
  }
  for (let i = 0; i < flanks; i += 1) {
    const u = (i + 0.5) / flanks;
    const side = rand() < 0.5 ? -1 : 1;
    lobes.push({
      x: side * halfW * (0.40 + rand() * 0.28),
      y: -halfH * 0.78 + u * height * 0.82 + (rand() - 0.5) * height * 0.16,
      z: (rand() - 0.5) * halfW * 0.5,
      r: lobeR * (0.52 + rand() * 0.26),
    });
  }
  return { lobes, halfW, halfH, lobeR };
}

// ---- 射线-球远交点 ----
function farHit(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const mx = ox - cx;
  const my = oy - cy;
  const mz = oz - cz;
  const b = 2 * (mx * dx + my * dy + mz * dz);
  const c = mx * mx + my * my + mz * mz - r * r;
  const disc = b * b - 4 * c;
  if (disc <= 0) return -Infinity;
  const t = (-b + Math.sqrt(disc)) / 2;
  return t > 0 ? t : -Infinity;
}

function shellRadius(dir, lobes, O, k) {
  let tmax = -Infinity;
  const ts = new Array(lobes.length);
  for (let i = 0; i < lobes.length; i += 1) {
    const l = lobes[i];
    const t = farHit(O.x, O.y, O.z, dir.x, dir.y, dir.z, l.x, l.y, l.z, l.r);
    ts[i] = t;
    if (t > tmax) tmax = t;
  }
  if (!Number.isFinite(tmax)) return { r: NaN, hits: 0 };
  if (!Number.isFinite(k) || k <= 0) return { r: tmax, hits: ts.filter(Number.isFinite).length };
  let sum = 0;
  let hits = 0;
  for (const t of ts) {
    if (!Number.isFinite(t)) continue;
    sum += Math.exp(k * (t - tmax));
    hits += 1;
  }
  return { r: tmax + Math.log(sum) / k, hits };
}

async function main() {
  const variant = process.argv[2] ?? 'bank';
  const detail = Number(process.argv[3] ?? 4);
  const k = Number(process.argv[4] ?? 1.0);
  const seed = 7 * 1000 + 11; // 与 initPuffClouds 的第一个 rand 同源

  const { lobes, halfW, halfH, lobeR } = buildLobes(variant, seed);

  // 云心：半径立方加权重心
  let wsum = 0;
  const O = new THREE.Vector3();
  for (const l of lobes) {
    const w = l.r ** 3;
    O.x += l.x * w;
    O.y += l.y * w;
    O.z += l.z * w;
    wsum += w;
  }
  O.divideScalar(wsum);

  const geo = new THREE.IcosahedronGeometry(1, detail);
  const pos = geo.getAttribute('position');
  const dirs = [];
  for (let i = 0; i < pos.count; i += 1) {
    dirs.push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize());
  }

  const hard = { min: new THREE.Vector3(1e9, 1e9, 1e9), max: new THREE.Vector3(-1e9, -1e9, -1e9) };
  const soft = { min: new THREE.Vector3(1e9, 1e9, 1e9), max: new THREE.Vector3(-1e9, -1e9, -1e9) };
  let noHit = 0;
  let maxHits = 0;
  let maxInflate = 0;
  let sumInflate = 0;
  const radiiHard = [];
  const radiiSoft = [];
  for (const d of dirs) {
    const h = shellRadius(d, lobes, O, 0);
    const s = shellRadius(d, lobes, O, k);
    if (!Number.isFinite(h.r)) {
      noHit += 1;
      continue;
    }
    maxHits = Math.max(maxHits, s.hits);
    const inflate = s.r - h.r;
    maxInflate = Math.max(maxInflate, inflate);
    sumInflate += inflate;
    radiiHard.push(h.r);
    radiiSoft.push(s.r);
    for (const [box, rr] of [[hard, h.r], [soft, s.r]]) {
      box.min.x = Math.min(box.min.x, O.x + d.x * rr);
      box.min.y = Math.min(box.min.y, O.y + d.y * rr);
      box.min.z = Math.min(box.min.z, O.z + d.z * rr);
      box.max.x = Math.max(box.max.x, O.x + d.x * rr);
      box.max.y = Math.max(box.max.y, O.y + d.y * rr);
      box.max.z = Math.max(box.max.z, O.z + d.z * rr);
    }
  }

  // 折痕指标：沿赤道采半径，量二阶差分的分位数。
  // 硬并集在球交界处一阶不连续 -> 二阶差分尖峰；融合后应显著下降。
  // 用分位数而不是 max：max 会被单个采样点主导，不可比。
  function equatorProfile(fuse) {
    const N = 2000;
    const rs = [];
    for (let i = 0; i < N; i += 1) {
      const a = (i / N) * Math.PI * 2;
      const d = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const out = shellRadius(d, lobes, O, fuse ? k : 0);
      rs.push(Number.isFinite(out.r) ? out.r : 0);
    }
    const d2 = [];
    for (let i = 0; i < N; i += 1) {
      const a0 = rs[i];
      const a1 = rs[(i + 1) % N];
      const a2 = rs[(i + 2) % N];
      d2.push(Math.abs(a2 - 2 * a1 + a0));
    }
    d2.sort((x, y) => x - y);
    const q = (p) => +d2[Math.min(d2.length - 1, Math.floor(p * d2.length))].toFixed(5);
    return { p50: q(0.5), p90: q(0.9), p99: q(0.99), max: q(0.999), radii: rs };
  }

  const profHard = equatorProfile(false);
  const profSoft = equatorProfile(true);

  const size = (b) => ({
    x: +(b.max.x - b.min.x).toFixed(2),
    y: +(b.max.y - b.min.y).toFixed(2),
    z: +(b.max.z - b.min.z).toFixed(2),
  });

  const out = {
    variant,
    detail,
    k,
    lobes: lobes.length,
    lobeR: +lobeR.toFixed(2),
    cloudCenter: [O.x, O.y, O.z].map((v) => +v.toFixed(2)),
    nominalBox: { x: halfW * 2, y: halfH * 2 },
    directions: dirs.length,
    noHitDirections: noHit,
    maxHits,
    inflation: {
      max: +maxInflate.toFixed(3),
      mean: +(sumInflate / Math.max(1, radiiSoft.length)).toFixed(3),
      asFractionOfLobeR: +(maxInflate / lobeR).toFixed(3),
    },
    hardBox: size(hard),
    softBox: size(soft),
    equator: {
      hard: { p50: profHard.p50, p90: profHard.p90, p99: profHard.p99, max: profHard.max },
      soft: { p50: profSoft.p50, p90: profSoft.p90, p99: profSoft.p99, max: profSoft.max },
    },
    // 供 shell-plot.py 画极坐标对比图
    curve: { hard: profHard.radii.map((v) => +v.toFixed(3)), soft: profSoft.radii.map((v) => +v.toFixed(3)) },
  };
  console.log(JSON.stringify(out, null, 2));

  if (process.argv[5] === '--dump') {
    const fs = await import('node:fs');
    fs.writeFileSync(
      `artifacts/archive/puff-shell-fusion/shell-curve-${variant}.json`,
      JSON.stringify({ variant, k, center: [O.x, O.y, O.z], curve: out.curve }),
    );
  }
}

main();
