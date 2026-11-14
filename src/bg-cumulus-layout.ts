/**
 * src/bg-cumulus-layout.ts — 背景积云的纯函数布局层（bg-cumulus Task 1）。
 *
 * 职责：给定 seed 产出确定性云布局（球堆 puff + 角向排布）与 billow 3D 噪声场。
 * 尺度按计划 §裁定 3：7–9 朵、2 塔在远半段、角隙 ≥10°、最大空档 ≤45°、覆盖 ≤70%。
 * 所有角度量在布局内自算（角宽 = 2·atan(宽/2/距离)），GPU 层只消费结果。
 * 移植自参考仓 clouds.js:23-190（billow 与 heap/cumulus），差异仅尺度带与
 * 方位求解器（计划 §裁定 3 的角宽约束排布，替代参考的手摆布局）。
 */

import { mulberry32 } from './puff-shape';

/** 有限半径球壳采样半径（米，计划 §裁定 1：距离带 3–7 km 的中值偏内）。 */
export const BG_CLOUD_SHELL_R = 4500;
/** 云数带：7–9 朵（计划 §裁定 3）。 */
export const CLOUD_COUNT_RANGE = [7, 9] as const;
/** 巨塔宽带（米）。 */
export const WIDTH_TOWER_RANGE = [6000, 9000] as const;
/** 中云宽带（米）。 */
export const WIDTH_MID_RANGE = [1500, 3000] as const;
/** 云底带（米）。 */
export const BASE_RANGE = [300, 900] as const;
/** 塔高/云高带（米）。 */
export const HEIGHT_RANGE = [400, 1600] as const;
/** 距离带（米）。 */
export const DIST_RANGE = [3000, 7000] as const;
/** 塔的远半段下限（米）：压角宽（计划 §裁定 3）。 */
export const TOWER_DIST_MIN = 5000;
/** 相邻云覆盖边之间的最小角隙（度）：不互相吞。 */
export const MIN_ANGULAR_GAP_EXTRA_DEG = 10;
/** 最大空档（度）：任一朝向 ±22.5° 内必有云边（「随便往哪个方向看都有几块」）。 */
export const MAX_EMPTY_ARC_DEG = 45;
/** 总角覆盖上限（360° 的比例）：留白，不是云毯。 */
export const MAX_COVERAGE = 0.7;
/** 塔高度带（米）：高于中云。 */
export const TOWER_HEIGHT_RANGE = [900, 1600] as const;
/** 中云高度带（米）。 */
export const MID_HEIGHT_RANGE = [400, 900] as const;
/** 塔云底带（米）。 */
export const TOWER_BASE_RANGE = [500, 900] as const;
/** 中云云底带（米）。 */
export const MID_BASE_RANGE = [300, 700] as const;
/** 中云距离带（米）：偏远压角宽。 */
export const MID_DIST_RANGE = [4500, 7000] as const;
/** 中云 puff 数带。 */
export const MID_PUFF_RANGE = [8, 14] as const;

/** 一个 puff（球心 + 半径，米，世界坐标）。 */
export type Puff = [number, number, number, number];

/** 一朵积云的布局结果。 */
export interface CloudLayout {
  kind: 'tower' | 'mid';
  /** 球堆（参考 clouds.js heap() 语义：贴上表皮的鼓包）。 */
  puffs: Puff[];
  /** 云底高度（米，世界 y）。 */
  base: number;
  /** billow 尺度（米）：参考 `scale = width × 0.07`。 */
  scale: number;
  widthMetres: number;
  heightMetres: number;
  distanceMetres: number;
  /** 绝对方位（度，0 = −Z，与 game.ts 右转为负同约定）。 */
  azimuthDeg: number;
  /** 包围球（含 scale×4 billow 外推余量，参考 createClouds 同款）。 */
  bounds: { cx: number; cy: number; cz: number; r: number };
}

/** march 窗口（计划 §裁定 4）：uSlabStartY/tEnd 的派生源。 */
export interface LayoutWindow {
  /** 全部云的最低有效云底（含云底微波 + billow 下推的估计）。 */
  minBase: number;
  /** 包围球最远 reach（米）。 */
  maxDistance: number;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** 云底微波振幅的估计（参考 clouds.js:264 的最大波幅 ≈ scale×0.85）。 */
const baseWaveAmp = (scale: number): number => scale * 0.85;

/** 角宽半径（度）——尺寸表形态（width/dist）。 */
function hwOf(s: { width: number; dist: number }): number {
  return (Math.atan(s.width / 2 / s.dist) * 180) / Math.PI;
}

/** 角宽半径（度）——CloudLayout 形态（widthMetres/distanceMetres）。 */
function halfWidthDeg(c: { widthMetres: number; distanceMetres: number }): number {
  return (Math.atan(c.widthMetres / 2 / c.distanceMetres) * 180) / Math.PI;
}

/** 圆环排序后的相邻覆盖边空档（度）。 */
function edgeGapsDeg(cs: CloudLayout[]): number[] {
  const n = cs.length;
  const order = cs.map((_, i) => i).sort((a, b) => cs[a].azimuthDeg - cs[b].azimuthDeg);
  const gaps: number[] = [];
  for (let k = 0; k < n; k += 1) {
    const i = order[k];
    const j = order[(k + 1) % n];
    let centerGap = cs[j].azimuthDeg - cs[i].azimuthDeg;
    if (k === n - 1) centerGap += 360;
    gaps.push(centerGap - halfWidthDeg(cs[i]) - halfWidthDeg(cs[j]));
  }
  return gaps;
}

/** 计划 §裁定 3 的三条角约束（NaN 一律判无效，防上游除零渗入）。 */
function valid(cs: CloudLayout[]): boolean {
  const gaps = edgeGapsDeg(cs);
  for (const g of gaps) {
    if (!Number.isFinite(g) || g < MIN_ANGULAR_GAP_EXTRA_DEG || g > MAX_EMPTY_ARC_DEG) return false;
  }
  const sum = cs.reduce((acc, c) => acc + 2 * halfWidthDeg(c), 0);
  return Number.isFinite(sum) && sum <= 360 * MAX_COVERAGE;
}

/**
 * 参考 clouds.js:124-133 heap()：一个圆堆的 puff 球，多在表皮（「skin is all bulges」）。
 * 逐式移植，差异仅：坐标即世界坐标。
 */
function heap(
  list: Puff[],
  rand: () => number,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  n: number,
): void {
  for (let i = 0; i < n; i += 1) {
    const a = rand() * Math.PI * 2;
    const up = -0.15 + 1.15 * rand();
    const out = Math.sqrt(Math.max(0, 1 - up * up)) * (0.35 + 0.65 * Math.sqrt(rand()));
    const r = Math.min(w * 0.3, h * 0.62) * (0.72 + 0.5 * rand());
    list.push([
      x + Math.cos(a) * out * (w * 0.5 - r * 0.6),
      y + up * (h - r * 0.7),
      z + Math.sin(a) * out * (w * 0.5 - r * 0.6) * 0.85,
      r,
    ]);
  }
}

/**
 * 参考 clouds.js:138-159 cumulus()：平底积云 = 底座 + heads 个逐层收小的头（顺 lean 倾斜堆积）。
 * 逐式移植；返回 puff 列表（世界坐标）。
 */
function cumulus(
  rand: () => number,
  cx: number,
  cz: number,
  base: number,
  width: number,
  height: number,
  puffCount: number,
  heads: number,
): Puff[] {
  const list: Puff[] = [];
  const each = Math.max(4, Math.floor(puffCount / (heads + 1.6)));
  const first = heads > 0 ? height * 0.42 : height;
  heap(list, rand, cx, base + first * 0.1, cz, width, first, Math.round(each * 1.6));
  const lean = rand() * Math.PI * 2;
  let x = cx;
  let z = cz;
  let y = base + first * 0.55;
  let w = width;
  for (let k = 0; k < heads; k += 1) {
    w *= 0.66 + 0.12 * rand();
    const a = lean + (rand() - 0.5) * 1.6;
    x += Math.cos(a) * w * 0.2;
    z += Math.sin(a) * w * 0.2;
    const h = ((height - first * 0.55) / heads) * 1.25;
    heap(list, rand, x, y, z, w, h, each);
    y += h * 0.72;
  }
  return list.slice(0, 44); // PER_CLOUD 上限（参考 clouds.js:9）
}

/**
 * 一次构造尝试：尺寸 → 覆盖收缩/扩张 → 空档均分环排布 → 世界坐标 puff。
 * 失败（约束不过）返回 null，由 layoutClouds 换内部随机流重试。
 */
function buildOnce(rand: () => number): CloudLayout[] | null {
  const n = CLOUD_COUNT_RANGE[0] + Math.floor(rand() * (CLOUD_COUNT_RANGE[1] - CLOUD_COUNT_RANGE[0] + 1));

  // 类型混洗（塔不强制相邻）：先做 n 朵的尺寸表，0/1 是塔
  const kinds: ('tower' | 'mid')[] = ['tower', 'tower'];
  for (let i = 2; i < n; i += 1) kinds.push('mid');
  for (let i = kinds.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
  }

  interface Spec {
    kind: 'tower' | 'mid';
    width: number;
    dist: number;
    base: number;
    height: number;
  }
  const specs: Spec[] = kinds.map((kind) => {
    if (kind === 'tower') {
      return {
        kind,
        width: lerp(WIDTH_TOWER_RANGE[0], WIDTH_TOWER_RANGE[1], rand()),
        dist: lerp(TOWER_DIST_MIN, DIST_RANGE[1], rand()),
        base: lerp(TOWER_BASE_RANGE[0], TOWER_BASE_RANGE[1], rand()),
        height: lerp(TOWER_HEIGHT_RANGE[0], TOWER_HEIGHT_RANGE[1], rand()),
      };
    }
    return {
      kind,
      width: lerp(WIDTH_MID_RANGE[0], WIDTH_MID_RANGE[1], rand()),
      dist: lerp(MID_DIST_RANGE[0], MID_DIST_RANGE[1], rand()),
      base: lerp(MID_BASE_RANGE[0], MID_BASE_RANGE[1], rand()),
      height: lerp(MID_HEIGHT_RANGE[0], MID_HEIGHT_RANGE[1], rand()),
    };
  });

  // 覆盖门（双向）：总角覆盖 ∈ [360×(1 − 45/n·容差), 360×0.7] 内才可能满足双约束
  const coverageOf = (ss: Spec[]): number => ss.reduce((acc, s) => acc + 2 * hwOf(s), 0);
  const minCover = 360 - n * (MAX_EMPTY_ARC_DEG - 2); // 每个空档至少留点边
  let guard = 0;
  while (coverageOf(specs) > 360 * MAX_COVERAGE && guard < 24) {
    for (const s of specs) if (s.kind === 'mid') s.width *= 0.94;
    guard += 1;
  }
  guard = 0;
  while (coverageOf(specs) < minCover && guard < 24) {
    for (const s of specs) s.width *= 1.05;
    guard += 1;
  }
  if (coverageOf(specs) > 360 * MAX_COVERAGE) return null;

  // 空档总量 = 360 − 覆盖；按每档 [12,42]° 均分 + 抖动，归一化保总量
  const totalEmpty = 360 - coverageOf(specs);
  const perGap = totalEmpty / n;
  if (perGap < MIN_ANGULAR_GAP_EXTRA_DEG + 2 || perGap > MAX_EMPTY_ARC_DEG - 3) return null;
  const jitter = Array.from({ length: n }, () => 0.6 + 0.8 * rand());
  const jitterSum = jitter.reduce((a, b) => a + b, 0);
  const gaps = jitter.map((j) => (j / jitterSum) * totalEmpty);
  for (let it = 0; it < 8; it += 1) {
    let clamped = false;
    let delta = 0;
    const gaps2 = gaps.map((g) => {
      if (g < MIN_ANGULAR_GAP_EXTRA_DEG + 2) { clamped = true; delta += MIN_ANGULAR_GAP_EXTRA_DEG + 2 - g; return MIN_ANGULAR_GAP_EXTRA_DEG + 2; }
      if (g > MAX_EMPTY_ARC_DEG - 3) { clamped = true; delta -= g - (MAX_EMPTY_ARC_DEG - 3); return MAX_EMPTY_ARC_DEG - 3; }
      return g;
    });
    for (let k = 0; k < n; k += 1) gaps[k] = gaps2[k];
    if (!clamped || Math.abs(delta) < 1e-6) break;
    // 把钳制差额摊回未钳制的档
    const free = gaps.map((g, k) => ({ g, k })).filter(({ g }) => g > MIN_ANGULAR_GAP_EXTRA_DEG + 3 && g < MAX_EMPTY_ARC_DEG - 4);
    if (free.length === 0) break;
    const freeSum = free.reduce((a, { g }) => a + g, 0);
    for (const { g, k } of free) gaps[k] = Math.max(MIN_ANGULAR_GAP_EXTRA_DEG + 2, g + (delta * g) / freeSum);
  }
  if (gaps.some((g) => g < MIN_ANGULAR_GAP_EXTRA_DEG || g > MAX_EMPTY_ARC_DEG)) return null;

  // 环排布：云 0 中心从 0 起步累积（闭合性：Σ(2hw + gaps) = 360），整体旋转 rand·360
  const centers: number[] = [];
  let acc = 0;
  centers.push(acc);
  for (let k = 0; k < n; k += 1) {
    const j = (k + 1) % n;
    acc += hwOf(specs[k]) + gaps[k] + hwOf(specs[j]);
    centers.push(acc);
  }
  centers.pop();
  const rot = rand() * 360;
  const azimuths = centers.map((c) => ((c + rot) % 360 + 360) % 360);

  const out: CloudLayout[] = [];
  for (let k = 0; k < n; k += 1) {
    const spec = specs[k];
    const az = azimuths[k];
    const cx = -Math.sin(toRad(az)) * spec.dist;
    const cz = -Math.cos(toRad(az)) * spec.dist;
    const puffs =
      spec.kind === 'tower'
        ? cumulus(rand, cx, cz, spec.base, spec.width, spec.height, 42, 3)
        : cumulus(rand, cx, cz, spec.base, spec.width, spec.height,
            MID_PUFF_RANGE[0] + Math.floor(rand() * (MID_PUFF_RANGE[1] - MID_PUFF_RANGE[0] + 1)),
            rand() < 0.35 ? 1 : 0);
    // 包围球（puffs ± r 的 AABB → 球，外推 scale×4）
    const box = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
    for (const [px, py, pz, pr] of puffs) {
      box.minX = Math.min(box.minX, px - pr); box.maxX = Math.max(box.maxX, px + pr);
      box.minY = Math.min(box.minY, py - pr); box.maxY = Math.max(box.maxY, py + pr);
      box.minZ = Math.min(box.minZ, pz - pr); box.maxZ = Math.max(box.maxZ, pz + pr);
    }
    const cx2 = (box.minX + box.maxX) / 2;
    const cy2 = (box.minY + box.maxY) / 2;
    const cz2 = (box.minZ + box.maxZ) / 2;
    const r = Math.hypot(box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ) / 2 + spec.width * 0.07 * 4;
    out.push({
      kind: spec.kind,
      puffs,
      base: spec.base,
      scale: spec.width * 0.07,
      widthMetres: spec.width,
      heightMetres: spec.height,
      distanceMetres: spec.dist,
      azimuthDeg: az,
      bounds: { cx: cx2, cy: cy2, cz: cz2, r },
    });
  }
  return valid(out) ? out : null;
}

/**
 * 确定性布局入口：内部随机流 = f(seed, attempt)，约束不过换流重试（上限 32）。
 * 全部种子在测试里钉死可解。
 */
export function layoutClouds(seed: number): CloudLayout[] {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const h = ((seed & 0xffff) * 0x9e37 + attempt * 0x85eb + 0x5eed) >>> 0;
    const rand = mulberry32(h);
    const cs = buildOnce(rand);
    if (cs) return cs;
  }
  throw new Error(`bg-cumulus-layout: seed ${seed} 无可行布局`);
}

/** march 窗口派生：uSlabStartY = minBase − 200；tEnd 用 maxDistance + 余量（Task 3）。 */
export function layoutWindow(cs: CloudLayout[]): LayoutWindow {
  let minBase = Infinity;
  let maxDistance = 0;
  for (const c of cs) {
    minBase = Math.min(minBase, c.base - baseWaveAmp(c.scale));
    maxDistance = Math.max(maxDistance, c.distanceMetres + c.bounds.r);
  }
  return { minBase, maxDistance };
}

// ---- billow 3D 噪声场（参考 clouds.js:23-111 逐式移植，尺寸参数化） --------------------

function smooth01(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * 参考 clouds.js:23-111 billowTexture 的场生成（Data3DTexture 组装归 GPU 层，这里只出数据）。
 * RGBA 四通道：r/g = 两档 lumps 混合、b = value 场、a = 细 lumps（shader 三档重采样用）。
 */
export function billowField(size = 32): Uint16Array {
  const rand = mulberry32(90210);
  const grid = (f: number): Float32Array => {
    const p = new Float32Array(f * f * f * 3);
    for (let i = 0; i < p.length; i += 1) p[i] = rand();
    return p;
  };
  const lumps = (pts: Float32Array, f: number, x: number, y: number, z: number): number => {
    const px = x * f;
    const py = y * f;
    const pz = z * f;
    const ix = Math.floor(px);
    const iy = Math.floor(py);
    const iz = Math.floor(pz);
    let best = 9;
    for (let dz = -1; dz <= 1; dz += 1) {
      const cz = (iz + dz + f) % f;
      for (let dy = -1; dy <= 1; dy += 1) {
        const cy = (iy + dy + f) % f;
        for (let dx = -1; dx <= 1; dx += 1) {
          const cx = (ix + dx + f) % f;
          const k = (cx + (cy + cz * f) * f) * 3;
          const ex = ix + dx + pts[k] - px;
          const ey = iy + dy + pts[k + 1] - py;
          const ez = iz + dz + pts[k + 2] - pz;
          const d = ex * ex + ey * ey + ez * ez;
          if (d < best) best = d;
        }
      }
    }
    return Math.sqrt(Math.max(0, 1 - best * 1.5));
  };
  const lattice = (f: number): Float32Array => {
    const p = new Float32Array(f * f * f);
    for (let i = 0; i < p.length; i += 1) p[i] = rand();
    return p;
  };
  const value = (lat: Float32Array, f: number, x: number, y: number, z: number): number => {
    const px = x * f;
    const py = y * f;
    const pz = z * f;
    const ix = Math.floor(px);
    const iy = Math.floor(py);
    const iz = Math.floor(pz);
    const fx = smooth01(px - ix);
    const fy = smooth01(py - iy);
    const fz = smooth01(pz - iz);
    const at = (i: number, j: number, k: number): number =>
      lat[((ix + i) % f) + (((iy + j) % f) + ((iz + k) % f) * f) * f];
    const x00 = at(0, 0, 0) + (at(1, 0, 0) - at(0, 0, 0)) * fx;
    const x10 = at(0, 1, 0) + (at(1, 1, 0) - at(0, 1, 0)) * fx;
    const x01 = at(0, 0, 1) + (at(1, 0, 1) - at(0, 0, 1)) * fx;
    const x11 = at(0, 1, 1) + (at(1, 1, 1) - at(0, 1, 1)) * fx;
    const y0 = x00 + (x10 - x00) * fy;
    const y1 = x01 + (x11 - x01) * fy;
    return y0 + (y1 - y0) * fz;
  };
  const w = [grid(3), grid(6), grid(12), grid(24)];
  const v = [lattice(4), lattice(8), lattice(16)];
  const data = new Uint16Array(size * size * size * 4);
  const half = toHalf;
  let k = 0;
  for (let zi = 0; zi < size; zi += 1) {
    const z = (zi + 0.5) / size;
    for (let yi = 0; yi < size; yi += 1) {
      const y = (yi + 0.5) / size;
      for (let xi = 0; xi < size; xi += 1) {
        const x = (xi + 0.5) / size;
        const a = lumps(w[0], 3, x, y, z);
        const b = lumps(w[1], 6, x, y, z);
        const c = lumps(w[2], 12, x, y, z);
        const d = lumps(w[3], 24, x, y, z);
        data[k] = half(Math.min(1, a * 0.6 + b * 0.28 + c * 0.12)); k += 1;
        data[k] = half(Math.min(1, b * 0.55 + c * 0.3 + d * 0.15)); k += 1;
        data[k] = half(value(v[0], 4, x, y, z) * 0.57 + value(v[1], 8, x, y, z) * 0.29 + value(v[2], 16, x, y, z) * 0.14); k += 1;
        data[k] = half(Math.min(1, c * 0.6 + d * 0.4)); k += 1;
      }
    }
  }
  return data;
}

// ---- half float 编解码（自持，不拉 three） ---------------------------------------------

function toHalf(val: number): number {
  const f32 = new Float32Array(1);
  const i32 = new Int32Array(f32.buffer);
  f32[0] = val;
  const x = i32[0];
  let bits = (x >> 16) & 0x8000;
  let m = (x >> 12) & 0x07ff;
  const e = (x >> 23) & 0xff;
  if (e < 103) return bits; // 次正规下溢 → 0
  if (e >= 103) {
    if (e >= 142) {
      bits |= 0x7c00;
      bits |= e === 255 ? 0 : (m & 0x1000) >> 1 > 0 ? 1 : 0;
    } else {
      if (e < 113) {
        m |= 0x0800;
        bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1);
      } else {
        bits |= ((e - 112) << 10) | (m >> 1);
        bits += m & 1;
      }
    }
  }
  return bits;
}
