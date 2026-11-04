/**
 * 构建耗时基准：模拟 25 朵云的完整壳生成（布局 + 合并 + 求交 + 法线）。
 * 只读，不参与构建。用法: node artifacts/archive/puff-shell-fusion/shell-bench.mjs [detail] [k]
 */

import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

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

function buildLobes(variant, rand) {
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
  return lobes;
}

function shellFromLobes(lobes, detail, k) {
  const g0 = new THREE.IcosahedronGeometry(1, detail);
  const merged = mergeVertices(g0, 1e-4);
  g0.dispose();
  const pos = merged.getAttribute('position');
  const n = pos.count;

  let wx = 0;
  let wy = 0;
  let wz = 0;
  let wsum = 0;
  for (const l of lobes) {
    const w = l.r ** 3;
    wx += l.x * w;
    wy += l.y * w;
    wz += l.z * w;
    wsum += w;
  }
  wx /= wsum;
  wy /= wsum;
  wz /= wsum;

  const ts = new Float64Array(lobes.length);
  for (let i = 0; i < n; i += 1) {
    let dx = pos.getX(i);
    let dy = pos.getY(i);
    let dz = pos.getZ(i);
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len;
    dy /= len;
    dz /= len;

    let tmax = -Infinity;
    for (let j = 0; j < lobes.length; j += 1) {
      const l = lobes[j];
      const mx = wx - l.x;
      const my = wy - l.y;
      const mz = wz - l.z;
      const b = 2 * (mx * dx + my * dy + mz * dz);
      const c = mx * mx + my * my + mz * mz - l.r * l.r;
      const disc = b * b - 4 * c;
      let t = -Infinity;
      if (disc > 0) {
        const s = (-b + Math.sqrt(disc)) / 2;
        if (s > 0) t = s;
      }
      ts[j] = t;
      if (t > tmax) tmax = t;
    }
    let r = tmax;
    if (Number.isFinite(tmax)) {
      let sum = 0;
      for (let j = 0; j < ts.length; j += 1) {
        if (Number.isFinite(ts[j])) sum += Math.exp(k * (ts[j] - tmax));
      }
      r = tmax + Math.log(sum) / k;
    }
    pos.setXYZ(i, wx + dx * r, wy + dy * r, wz + dz * r);
  }
  pos.needsUpdate = true;
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  return merged;
}

function main() {
  const detail = Number(process.argv[2] ?? 4);
  const k = Number(process.argv[3] ?? 0.75);
  const count = 25;
  const rand = mulberry32(7 * 1000 + 11);
  const names = ['bank', 'tower', 'scraps', 'leviathan'];

  // 预热（JIT + three 模块初始化）
  shellFromLobes(buildLobes('bank', mulberry32(1)), 2, k);

  const t0 = performance.now();
  let verts = 0;
  let tris = 0;
  for (let i = 0; i < count; i += 1) {
    const variant = names[Math.floor(rand() * 4)];
    const lobes = buildLobes(variant, rand);
    const g = shellFromLobes(lobes, detail, k);
    verts += g.getAttribute('position').count;
    tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    g.dispose();
  }
  const ms = performance.now() - t0;

  console.log(
    JSON.stringify(
      {
        detail,
        k,
        count,
        totalMs: +ms.toFixed(1),
        msPerCloud: +(ms / count).toFixed(1),
        verticesPerCloud: Math.round(verts / count),
        trianglesPerCloud: Math.round(tris / count),
      },
      null,
      2,
    ),
  );
}

main();
