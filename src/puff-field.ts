/**
 * src/puff-field.ts — 近景云簇的散布与回收：环面抖动网格 + 相干覆盖掩码 + 走廊回收。
 *
 * 这一层是纯函数，不碰 THREE，也不读时间：同 seed 同尺寸 → 深相等。
 * 造型在 `puff-shape.ts`，着色在 `puff-cloud.ts`。
 */

import { CLOUD_BAND } from './clouds-compute';
import { mulberry32 } from './puff-shape';

/** 回收走廊：飞机沿 -Z 飞，身后 +BEHIND 的云搬回前方 -DEPTH 处。 */
export const PUFF_FIELD_DEPTH = 1000;
export const PUFF_BEHIND_MARGIN = 120;
/**
 * TSL 距离淡出：3m 内全透（钻进去不糊脸）12m 外全显。
 *
 * 之前是 8~30m：云本身才 30m 宽，老远就开始透整朵没了看着像“没靠近就消失”。
 * 淡出带必须远小于云体半径穿云才成立。
 */
export const PUFF_FADE_NEAR = 3;
export const PUFF_FADE_FAR = 12;
/**
 * 布局走廊：x ±130m（竖屏横向 FOV 窄±200 全飞出画外了）。
 * y 不再有固定上下限——每朵云按自己的 halfH 从云层底反解可行带（`PUFF_SCATTER`），
 * 旧的 38~75 死带随 `puffLayout` 一起退役，常量留一版做兼容。
 *
 * 之前半径才 14~26m：在 160m 外只有几个像素参考图里是几百米的塔云。
 * 现在 blob 9~18m + 整朵 scale 1.6~2.6 → 半径 45~70m150m 外占竖向 FOV 约 1/3。
 */
export const PUFF_X_SPAN = 130;
/** @deprecated 由 `puffScatter` 的尺寸驱动高度带取代，仅为兼容保留。 */
export const PUFF_Y_MIN = 38;
/** @deprecated 由 `puffScatter` 的尺寸驱动高度带取代，仅为兼容保留。 */
export const PUFF_Y_MAX = 75;

export interface PuffSpot {
  x: number;
  y: number;
  z: number;
  /** 整朵的体量缩放（回显输入 `PuffSize.s`，调用方按同一索引取用）。 */
  s: number;
}

/** 一朵待散布的云的世界尺寸；`s` 是定下尺寸时用的缩放，散点时原样回显。 */
export interface PuffSize {
  /** 世界半宽（局部 bbox 半宽 × scale）。 */
  halfW: number;
  /** 世界半高（局部 bbox 半高 × scale）。 */
  halfH: number;
  /** 与这对 half 对应的整朵缩放。 */
  s: number;
}

/**
 * 散布观感旋钮。默认值来自散布专文 §2，实拍后可调：
 * - `SEA_CLEAR`：云底距海面的最小净空；
 * - `SPAWN_CLEAR`：出生点半径净空（约两朵云的中心距）；
 * - `VERTICAL_BIAS`：竖直分布下偏（1 = 均匀，>1 往下压——参考图云底压着水平线）；
 * - `MASK_FREQ` / `MASK_R`：覆盖掩码的特征尺度（≈320 m 一团，一屏一 bank 一晴空）；
 * - `GAP_MARGIN`：最小中心距 = 1.15 × 2 × maxHalfW（15% 余量允许轻微咬合）；
 * - `BAND_MARGIN`：反解 scale 上限时给竖直带留的自由度（用尽上限会让带塌成一点）。
 */
export const PUFF_SCATTER = {
  SEA_CLEAR: 8,
  SPAWN_CLEAR: 120,
  VERTICAL_BIAS: 1.6,
  MASK_FREQ: 1 / 320,
  MASK_R: 1.7,
  GAP_MARGIN: 1.15,
  BAND_MARGIN: 6,
} as const;

export interface ScatterOpts {
  xSpan: number;
  depth: number;
  spawnX: number;
  spawnZ: number;
  seaClear: number;
  spawnClear: number;
  verticalBias: number;
  maskFreq: number;
  maskR: number;
}

const SCATTER_DEFAULTS: ScatterOpts = {
  xSpan: PUFF_X_SPAN,
  depth: PUFF_FIELD_DEPTH,
  spawnX: 0,
  spawnZ: 0,
  seaClear: PUFF_SCATTER.SEA_CLEAR,
  spawnClear: PUFF_SCATTER.SPAWN_CLEAR,
  verticalBias: PUFF_SCATTER.VERTICAL_BIAS,
  maskFreq: PUFF_SCATTER.MASK_FREQ,
  maskR: PUFF_SCATTER.MASK_R,
};

/** 整数格点哈希 → [0,1)，给覆盖掩码用；不占 RNG 序列，掩码本身确定。 */
function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(Math.floor(seed) || 1, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** 双线性值噪声（Hermite 权重），确定、无依赖、周期无关。 */
function valueNoise2(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const v00 = hash2(ix, iy, seed);
  const v10 = hash2(ix + 1, iy, seed);
  const v01 = hash2(ix, iy + 1, seed);
  const v11 = hash2(ix + 1, iy + 1, seed);
  return (v00 * (1 - sx) + v10 * sx) * (1 - sy) + (v01 * (1 - sx) + v11 * sx) * sy;
}

/** 三个倍频程的 fbm，0..1。给覆盖掩码一个成片的云/晴空分布而不是白噪声撒盐。 */
function fbm2(x: number, y: number, seed: number): number {
  let v = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < 3; o += 1) {
    v += amp * valueNoise2(x * freq, y * freq, seed + o * 101);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return v / norm;
}

/**
 * 抖动网格的格数。沿 z 必须整除走廊深度（环面回收才无缝），且每格不小于 `minGap`：
 * 所以 z 用 floor（专文 §2.2 的 round(17.5)=18 会把格距压到 55.6 < 57.5，违反自己的
 * 不变量 2），x 本来就是 floor。沿 z 的格距因此 ≥ minGap，抖动余量才非负。
 */
export function puffGridCells(
  minGap: number,
  xSpan: number = PUFF_X_SPAN,
  depth: number = PUFF_FIELD_DEPTH,
): { cellsX: number; cellsZ: number } {
  const gap = Number.isFinite(minGap) && minGap > 0 ? minGap : 1;
  const span = Number.isFinite(xSpan) && xSpan > 0 ? xSpan : PUFF_X_SPAN;
  const dep = Number.isFinite(depth) && depth > 0 ? depth : PUFF_FIELD_DEPTH;
  return { cellsX: Math.max(1, Math.floor((2 * span) / gap)), cellsZ: Math.max(1, Math.floor(dep / gap)) };
}

/**
 * 环面抖动网格散布（散布专文 §2 的 A+B+C 三件套）。
 *
 * - A 尺寸驱动高度带：每朵云按自己的 halfH 求 `[SEA_CLEAR+halfH, DECK_BOTTOM-halfH]`，
 *   塞不下的尺寸直接抛错（调用方必须先用 S_MAX_FIT 反解缩放，不许硬夹）；
 * - B 环面抖动网格：格距 ≥ minGap，抖动 ±(格距-minGap)/2，两两最坏距离恰为 minGap；
 *   沿 z 按走廊深度取模，和 `wrapPuffZ` 的回收取模天然咬合，间距跨接缝、跨回收不变；
 * - C 相干覆盖掩码：低频 fbm 在 (x, 环面角) 柱面上采样，按值排序取前 N——数量确定，
 *   分布成簇（一屏一 bank 一晴空），而不是白噪声撒盐。
 *
 * 出生点净空是**剔除**不是平移：撞上净空圈的格按掩码序跳过，少一朵可接受。
 * 纯函数：同 seed 同尺寸 → 深相等；不读全局随机、不读时间。
 */
export function puffScatter(seed: number, sizes: readonly PuffSize[], opts?: Partial<ScatterOpts>): PuffSpot[] {
  const o: ScatterOpts = { ...SCATTER_DEFAULTS, ...opts };
  const rand = mulberry32(Math.floor(seed) || 1);
  const deckBottom = CLOUD_BAND.bottom;

  const maxHalfW = sizes.reduce((m, s) => (Number.isFinite(s?.halfW) ? Math.max(m, s.halfW) : m), 0);
  const minGap = PUFF_SCATTER.GAP_MARGIN * 2 * maxHalfW;
  const grid = puffGridCells(minGap, o.xSpan, o.depth);
  const cellX = (2 * o.xSpan) / grid.cellsX;
  const cellZ = o.depth / grid.cellsZ;
  const jitterX = Math.max(0, (cellX - minGap) / 2);
  const jitterZ = Math.max(0, (cellZ - minGap) / 2);
  if (!Number.isFinite(minGap) || minGap <= 0 || sizes.length > grid.cellsX * grid.cellsZ) {
    throw new Error(`[puff] cannot scatter ${sizes.length} clouds in a ${grid.cellsX}x${grid.cellsZ} grid`);
  }

  // C：每个格的掩码值。z 映射到环面角，噪声在柱面上连续，跨接缝无痕。
  const cells: { i: number; k: number; mask: number }[] = [];
  for (let i = 0; i < grid.cellsX; i += 1) {
    for (let k = 0; k < grid.cellsZ; k += 1) {
      const cx = (i + 0.5) * cellX - o.xSpan;
      const cz = -(k + 0.5) * cellZ;
      const a = (2 * Math.PI * cz) / o.depth;
      const mask = fbm2(cx * o.maskFreq + o.maskR * Math.cos(a), o.maskR * Math.sin(a), seed);
      cells.push({ i, k, mask });
    }
  }
  // 总序（含平手决胜）保证跨引擎确定。
  cells.sort((p, q) => q.mask - p.mask || p.i - q.i || p.k - q.k);

  const spots: PuffSpot[] = [];
  for (const cell of cells) {
    if (spots.length >= sizes.length) break;
    const cx = (cell.i + 0.5) * cellX - o.xSpan;
    const cz = -(cell.k + 0.5) * cellZ;
    const x = cx + (rand() * 2 - 1) * jitterX;
    const zRaw = cz + (rand() * 2 - 1) * jitterZ;
    const z = Math.min(Math.max(zRaw, -o.depth), 0);
    // 出生点净空：剔除，不平移（§1.3——平移会撞进别的格的间距承诺里）。
    if (Math.hypot(x - o.spawnX, z - o.spawnZ) < o.spawnClear) continue;

    const size = sizes[spots.length];
    if (!size || !Number.isFinite(size.halfH) || !Number.isFinite(size.halfW) || !Number.isFinite(size.s)) {
      throw new Error('[puff] scatter received a non-finite size');
    }
    // A：这朵云自己的可行高度带。塞不下说明调用方的 scale 没按带反解——抛错，
    // 绝不返回 NaN 位置（专文 §4 第 9 条）。
    const lo = o.seaClear + size.halfH;
    const hi = deckBottom - size.halfH;
    if (!(hi > lo)) {
      throw new Error(`[puff] cloud too tall for the band: halfH ${size.halfH} leaves [${lo}, ${hi}]`);
    }
    const u = rand();
    const y = lo + (hi - lo) * Math.pow(u, o.verticalBias);
    spots.push({ x, y, z, s: size.s });
  }
  return spots;
}

/**
 * 回收：云被甩到身后就搬回前面。纯函数给单测和 far-field 共用；
 * 非有限输入直接回原值不炸帧循环。
 *
 * 直接取模进走廊（一步到位）：之前的 guard-8 循环在大偏移下一帧跳 8000m，
 * 会越过 1000m 走廊来回乒乓，云就被甩到几公里外再也回不来。
 */
export function wrapPuffZ(
  z: number,
  planeZ: number,
  depth: number = PUFF_FIELD_DEPTH,
  behind: number = PUFF_BEHIND_MARGIN,
): number {
  if (!Number.isFinite(z) || !Number.isFinite(planeZ)) return z;
  const d = Number.isFinite(depth) && depth > 0 ? depth : PUFF_FIELD_DEPTH;
  const b = Number.isFinite(behind) && behind >= 0 ? behind : PUFF_BEHIND_MARGIN;
  const lo = planeZ - d + b; // 走廊前端（含），长度 d
  let rel = (z - lo) % d;
  if (rel < 0) rel += d;
  return lo + rel;
}

/**
 * CPU 版距离淡出的 JS 镜像（shader 里是同一条 smoothstep），单测钉住它；
 * 非有限距离按全显处理不挡画面。
 */
export function fadeForDistance(
  d: number,
  near: number = PUFF_FADE_NEAR,
  far: number = PUFF_FADE_FAR,
): number {
  if (!Number.isFinite(d)) return 1;
  if (!(near < far)) return 1;
  if (d <= near) return 0;
  if (d >= far) return 1;
  const t = (d - near) / (far - near);
  return t * t * (3 - 2 * t);
}
