/**
 * src/puff-field.ts — 近景云簇的散布与回收：方形环面窗口 + 抖动网格 + 相干覆盖掩码。
 *
 * 这一层是纯函数，不碰 THREE，也不读时间：同 seed 同尺寸 → 深相等。
 * 造型在 `puff-shape.ts`，着色在 `puff-cloud.ts`。
 *
 * 为什么是「方形窗口」而不是「走廊」：飞机能任意方向飞，云场必须跟着**相机**、
 * 而不是只认 -Z。窗口是一个边长 `PUFF_WINDOW` 的正方形环面，每朵云各自取模回收到
 * 窗口内——不是整场一起挪，所以世界锚定和视差都保住了。
 *
 * 取模的瞬间必须看不见：`PUFF_EDGE_FADE` 让云在越过边界之前先淡到 0，
 * 淡出带落在雾饱和（`puff-cloud.ts` 的 `PUFF_HAZE.FAR = 860`）之外，跳变发生时它已经不在画面上了。
 */

import { FLIGHT } from './game';
import { mulberry32 } from './puff-shape';

/**
 * 环面窗口的边长（米）。
 *
 * 半边长 750 小于雾饱和距离 860，所以**不是靠雾藏跳变，是靠边界淡出**：
 * 云在 600 m 就开始淡，750 m 归零，跳变发生时它已经不在画面上。
 * 窗口收小是为了画面：同样 25 朵，铺在 1500² 里比铺在 2000² 里在竖屏上厚一倍。
 */
export const PUFF_WINDOW = 1500;
/** 目标间距（米）：400 m 在 46 m/s 下约合每 8.7 秒遇一朵。 */
export const PUFF_SPACING = 400;
/** 边界淡出宽度（米）：越界前这一段先淡到 0。 */
export const PUFF_EDGE_FADE = 150;
/**
 * 格子相对最小间距的放大倍数。必须 > 1：格子恰好等于 minGap 时抖动余量是 0，
 * 25 朵会钉在 46 m 的正交格点上，看着像棋盘而不是撒出来的云。
 */
export const PUFF_JITTER_SCALE = 1.4;
/**
 * 云的径向带（米）。外径必须落在边界淡出开始之前（WINDOW/2 - EDGE_FADE = 600），
 * 否则带边缘的云还没飞到就被淡掉一半。窗口以相机为心，所以这个环也以相机为心——不管往哪个方向飞，
 * 云总在你前后这个距离上，这也正是「在云中穿行」要的空间关系。
 * 均匀铺满整个方窗会把 25 朵摊进 225 万 m²，竖屏前向锥里平均只剩一朵。
 */
export const PUFF_RING = { inner: 150, outer: 600 } as const;
/** 一个粗分桶里最多放几朵——掩码喜欢扎堆，不封顶就会整场挤进一个 blob。 */
export const PUFF_BUCKET_CAP = 2;

/**
 * TSL 距离淡出：3m 内全透（钻进去不糊脸）12m 外全显。
 *
 * 之前是 8~30m：云本身才 30m 宽，老远就开始透整朵没了看着像“没靠近就消失”。
 * 淡出带必须远小于云体半径穿云才成立。
 */
export const PUFF_FADE_NEAR = 3;
export const PUFF_FADE_FAR = 12;

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
 * 散布观感旋钮：
 * - `SEA_CLEAR`：云底距 y=0 基准面的最小净空（海删了，名字留着，语义是「地面」）；
 * - `SPAWN_CLEAR`：出生点半径净空（剔除，不平移）；
 * - `VERTICAL_BIAS`：竖直分布下偏（1 = 均匀，>1 往下压——参考图云底压着水平线）；
 * - `MASK_FREQ` / `MASK_R`：覆盖掩码的特征尺度（成片，不是白噪声撒盐）；
 * - `GAP_MARGIN`：最小中心距 = 1.15 × 2 × maxHalfW（15% 余量允许轻微咬合）；
 * - `BAND_MARGIN`：反解 scale 上限时给竖直带留的自由度。
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
  window: number;
  spawnClear: number;
  seaClear: number;
  verticalBias: number;
  maskFreq: number;
  maskR: number;
}

const SCATTER_DEFAULTS: ScatterOpts = {
  window: PUFF_WINDOW,
  spawnClear: PUFF_SCATTER.SPAWN_CLEAR,
  seaClear: PUFF_SCATTER.SEA_CLEAR,
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

/** 三个倍频程的 fbm，0..1。给覆盖掩码一个成片的云/晴空分布。 */
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
 * 每轴的格子数。格子必须是**方**的且格距 ≥ `minGap`，所以向下取整——向上取整会把
 * 格距压到 minGap 以下，抖动余量变负，两两最小间距的承诺当场失效。
 */
export function puffGridCells(minGap: number, size: number = PUFF_WINDOW): number {
  const gap = Number.isFinite(minGap) && minGap > 0 ? minGap : 1;
  const win = Number.isFinite(size) && size > 0 ? size : PUFF_WINDOW;
  return Math.max(1, Math.floor(win / (gap * PUFF_JITTER_SCALE)));
}

/**
 * 方形环面抖动网格散布。
 *
 * - A 尺寸驱动高度带：每朵云按自己的 halfH 求 `[ALT_MIN+SEA_CLEAR+halfH, ALT_MAX-halfH]`，
 *   塞不下的尺寸直接抛错（调用方必须先用 fitMax 反解缩放，不许硬夹）；
 * - B 抖动网格：格距 ≥ minGap，抖动 ±(格距-minGap)/2，两两最坏距离恰为 minGap；
 *   两轴都按 `window` 取模，和 `wrapPuffAxis` 的回收天然咬合；
 * - C 相干覆盖掩码：低频 fbm 在 (x, 环面角) 柱面上采样，按值排序取前 N——数量确定，
 *   分布成簇（一屏一团、一块晴空），而不是白噪声撒盐。
 *
 * 出生点净空是**剔除**不是平移：撞上净空圈的格按掩码序跳过，少一朵可接受。
 * 纯函数：同 seed 同尺寸 → 深相等；不读全局随机、不读时间。
 */
export function puffScatter(seed: number, sizes: readonly PuffSize[], opts?: Partial<ScatterOpts>): PuffSpot[] {
  const o: ScatterOpts = { ...SCATTER_DEFAULTS, ...opts };
  const rand = mulberry32(Math.floor(seed) || 1);

  const maxHalfW = sizes.reduce((m, s) => (Number.isFinite(s?.halfW) ? Math.max(m, s.halfW) : m), 0);
  const minGap = PUFF_SCATTER.GAP_MARGIN * 2 * maxHalfW;
  const cells = puffGridCells(minGap, o.window);
  const cell = o.window / cells;
  const half = o.window / 2;
  const jitter = Math.max(0, (cell - minGap) / 2);
  if (!Number.isFinite(minGap) || minGap <= 0) {
    throw new Error(`[puff] scatter needs a positive minimum gap, got ${minGap}`);
  }

  // C：每个格的掩码值。z 映射到环面角，噪声在柱面上连续，跨接缝无痕。
  const grid: { i: number; k: number; mask: number }[] = [];
  for (let i = 0; i < cells; i += 1) {
    for (let k = 0; k < cells; k += 1) {
      const cx = (i + 0.5) * cell - half;
      const cz = (k + 0.5) * cell - half;
      const a = (2 * Math.PI * cz) / o.window;
      const mask = fbm2(cx * o.maskFreq + o.maskR * Math.cos(a), o.maskR * Math.sin(a), seed);
      grid.push({ i, k, mask });
    }
  }
  // 总序（含平手决胜）保证跨引擎确定。
  grid.sort((p, q) => q.mask - p.mask || p.i - q.i || p.k - q.k);

  const lo = FLIGHT.ALT_MIN;
  const hi = FLIGHT.ALT_MAX;
  // 掩码喜欢扎堆：不按粗分桶封顶，25 朵会整场挤进一个 blob，剩下的天空全是空的。
  const bucketAxis = Math.max(1, Math.round(Math.sqrt(sizes.length / PUFF_BUCKET_CAP)));
  const perBucket = Math.max(1, Math.ceil(cells / bucketAxis));
  const used = new Map<number, number>();
  const spots: PuffSpot[] = [];
  for (const box of grid) {
    if (spots.length >= sizes.length) break;
    // 只收径向带里的格：方窗的四个角在这个距离上根本没有画面上存在的意义。
    const cellCx = (box.i + 0.5) * cell - half;
    const cellCz = (box.k + 0.5) * cell - half;
    const radial = Math.hypot(cellCx, cellCz);
    if (radial < PUFF_RING.inner || radial > PUFF_RING.outer) continue;
    const bucketId = Math.floor(box.i / perBucket) * 1000 + Math.floor(box.k / perBucket);
    if ((used.get(bucketId) ?? 0) >= PUFF_BUCKET_CAP) continue;
    const x = (box.i + 0.5) * cell - half + (rand() * 2 - 1) * jitter;
    const z = (box.k + 0.5) * cell - half + (rand() * 2 - 1) * jitter;
    // 出生点净空：剔除，不平移——平移会撞进别的格的间距承诺里。
    if (Math.hypot(x, z) < o.spawnClear) continue;

    const size = sizes[spots.length];
    if (!size || !Number.isFinite(size.halfH) || !Number.isFinite(size.halfW) || !Number.isFinite(size.s)) {
      throw new Error('[puff] scatter received a non-finite size');
    }
    // A：这朵云自己的可行高度带。塞不下说明调用方的 scale 没按带反解——抛错，
    // 绝不返回 NaN 位置。
    const bandLo = lo + o.seaClear + size.halfH;
    const bandHi = hi - size.halfH;
    if (!(bandHi > bandLo)) {
      throw new Error(`[puff] cloud too tall for the band: halfH ${size.halfH} leaves [${bandLo}, ${bandHi}]`);
    }
    const y = bandLo + (bandHi - bandLo) * Math.pow(rand(), o.verticalBias);
    used.set(bucketId, (used.get(bucketId) ?? 0) + 1);
    spots.push({ x, y, z, s: size.s });
  }
  return spots;
}

/**
 * 单轴回收：把任意偏移一次搬进 `[centre - size/2, centre + size/2)`。
 *
 * 位移永远是 `size` 的整数倍——否则云会真的漂走。非有限输入直接回原值不炸帧循环。
 * 切后台再回来那种巨大偏移也一步到位，不靠循环步进（老实现的 guard-8 会越界乒乓）。
 */
export function wrapPuffAxis(v: number, centre: number, size: number = PUFF_WINDOW): number {
  if (!Number.isFinite(v) || !Number.isFinite(centre)) return v;
  const win = Number.isFinite(size) && size > 0 ? size : PUFF_WINDOW;
  const half = win / 2;
  let rel = (v - centre) % win;
  if (rel < -half) rel += win;
  else if (rel >= half) rel -= win;
  return centre + rel;
}

/** 两轴一起回收。窗口中心是**相机**，不是飞机——相机会滞后，用飞机会让回收抖。 */
export function wrapPuffWindow(
  x: number,
  z: number,
  camX: number,
  camZ: number,
  size: number = PUFF_WINDOW,
): { x: number; z: number } {
  return { x: wrapPuffAxis(x, camX, size), z: wrapPuffAxis(z, camZ, size) };
}

/**
 * 边界淡出：0（在边界上）→ 1（离边界还有 `PUFF_EDGE_FADE` 以上）。
 * 取两轴里更靠边的那一个，两轴都对齐了才会淡。
 */
export function puffEdgeFade(
  x: number,
  z: number,
  camX: number,
  camZ: number,
  size: number = PUFF_WINDOW,
  fade: number = PUFF_EDGE_FADE,
): number {
  if (!Number.isFinite(fade) || fade <= 0) return 1;
  const wx = wrapPuffAxis(x, camX, size);
  const wz = wrapPuffAxis(z, camZ, size);
  const d = Math.max(Math.abs(wx - camX), Math.abs(wz - camZ));
  const t = Math.min(Math.max((size / 2 - d) / fade, 0), 1);
  return t * t * (3 - 2 * t);
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
