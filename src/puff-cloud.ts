/**
 * src/puff-cloud.ts — 近景同层云：大瓣球体堆叠 + 烘焙 toon，造型对标 ref-01。
 *
 * 远景/顶层继续走 `clouds-compute.ts` 的 dome slab；身边飞过的云不用 slab
 * （slab 是远景穹顶做法，调不出单朵体积），也不用 billboard（billboard 永远
 * 朝向相机，侧看没视差、穿进去像纸片）。这里是真 3D：一朵云 = 竖直主轴上
 * 5~10 个大瓣 + 若干肩瓣，合并成一个 mesh，14 朵共 14 个 draw call。
 *
 * 形状取自参考图实测（`artifacts/cloud-audit/ref_probe.py`），不是凭手感：
 * 单瓣直径占云宽 0.6~0.8、轮廓是 5~6 段浅圆弧、整朵只有 4~6 个平涂色阶。
 * 比例全部集中在 `PUFF_SHAPE` 里，改"银行还是柱子"只动 `aspect` 一个数。
 *
 * 风格锚点（和 dome 同一套，不许漂）：
 * - 配色只读 `CLOUD_PALETTE`：背光整块深紫、受光跳粉/金、云顶提奶白、肚皮压紫。
 *   太阳是静态日落（`SUN_DIRECTION` 单源），所以 toon 直接烘进顶点色运行时零
 *   光照计算，还天然双后端可跑。
 * - 三档分档（`puffBandIndex`，纯函数可测）：太阳仰角只有 6.97°，所以明暗
 *   分界线接近竖直——参考图那根云柱左亮右暗就是这个，不需要假法线。
 *
 * 可穿：不透明排序地狱的解法是片元级距离淡出（TSL opacityNode，和 dome
 * 同一写法，`three/tsl` 全后端编译）。相机钻进云芯时近处片元先淡到 0，
 * 远处 dome 的整屏 whiteout（`WHITEOUT_MAX`）正好接管，不穿帮。
 */

import * as THREE from 'three';

import { CLOUD_BAND } from './clouds-compute';
import { CLOUD_PALETTE, SUN_DIRECTION } from './palettes';

/** 高/低档的云朵数。低档直接藏一半，不重建，和 dome 的 setQuality 同思路。 */
export const PUFF_COUNT_HIGH = 14;
export const PUFF_COUNT_LOW = 7;
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

export interface PuffHandle {
  readonly kind: 'puff';
  update(t: number, sunDir: THREE.Vector3): void;
  setQuality(high: boolean): void;
  dispose(): void;
}

/** 确定性 RNG：布局和造型可测同值 debug 可复现。 */
export function mulberry32(seed: number): () => number {
  let a = Math.imul(Math.floor(seed) || 1, 0x6d2b79f5) >>> 0;
  return () => {
    a = (Math.imul(a ^ (a >>> 15), a | 1) >>> 0) + 0x6d2b79f5;
    let t = Math.imul(a ^ (a >>> 7), a | 61) ^ a;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

const _sun = new THREE.Vector3(SUN_DIRECTION[0], SUN_DIRECTION[1], SUN_DIRECTION[2]).normalize();

/**
 * 分档阈值单源：`puffBandIndex`（JS 镜像/单测）与 `initPuffClouds` 的 TSL colorNode
 * 都读这一份。挪进片元着色后阈值漂移就是两边色阶对不上，所以必须导出钉住。
 */
export const PUFF_BAND_THRESHOLDS = [0.2, 0.5, 0.76] as const;

/**
 * 一朵云的骨架比例，取自 `ref-01-sunset-glide.png` 的实测，不是凭手感。
 *
 * 参考图里的云是**大瓣圆球的并集**：单瓣直径占云宽的 0.6~0.8，轮廓是 5~6 段浅
 * 圆弧串起来的菜花边，整朵只有 4~6 个平涂色阶、零高频细节。
 * 这跟老实现正好相反——老实现把 10~13 个小球沿 X 摊开、Y 压到 0.62、每球 80 个
 * 三角面，合出来是一块带棱面的横向土豆（详见评审 §7.2 / §8）。
 *
 * 实测数据（`artifacts/cloud-audit/ref_probe.py`）：
 * - 中央云柱 52×101 px → 高宽比 **1.95**
 * - 左侧云团高宽比 ≈ 1.0，6 个平涂色阶
 * - 云体均色 (124,75,141) 紫，受光侧到 255 的奶白/粉
 */
export const PUFF_SHAPE = {
  /** 单朵云的世界宽度（米），缩放前。 */
  width: 22,
  /**
   * 高 / 宽。参考图左边那团是 ~1.0、中间那根柱子是 ~1.95。
   * 默认 1.45 = 有垂直发育的积云，但不是"擎天柱"（spec 拍板：只要 bank＋碎棉花）。
   * 想改口到柱子就动这一个数。
   */
  aspect: 1.45,
  /** 单瓣直径 / 云宽。参考图实测 0.6~0.8。 */
  lobeDiameter: 0.62,
  /**
   * 每瓣的二十面体细分级。three 的细分是每面切 (detail+1)²：detail 1 → 80 面，
   * detail 2 → 180 面。1 在近距离能数出三角面（实拍确认过），2 在最近投影像素下
   * 边长已到 ~4 px 以下。14 朵 × 约 10 瓣 ≈ 5 万顶点，可以接受。
   */
  detail: 2,
} as const;

/**
 * 把 wrap 光照系数分到 4 档平涂色阶，对应 `CLOUD_PALETTE` 的四色。
 *
 * **JS 镜像**：真正的分档现在跑在 `initPuffClouds` 的 TSL colorNode 里（逐片元算
 * radial+normal，终结线是曲面连续的——顶点色分档的硬边界只能沿三角面拓扑走，
 * 近距离出多边形色阶）。这个纯函数读同一份 `PUFF_BAND_THRESHOLDS`，给单测和
 * 调参对照用，与 `horizon.ts` / `sun-road.ts` 一个写法。
 */
export function puffBandIndex(sunW: number): 0 | 1 | 2 | 3 {
  if (!Number.isFinite(sunW)) return 0;
  const v = sunW < 0 ? 0 : sunW > 1 ? 1 : sunW;
  const [t0, t1, t2] = PUFF_BAND_THRESHOLDS;
  if (v < t0) return 0; // shadow：背光边缘（最窄——参考图里纯暗部不多）
  if (v < t1) return 1; // base：云体主色（最宽，云身主要落在这档）
  if (v < t2) return 2; // pink：受光侧
  return 3; // gold/奶白：向光面 + 云顶
}

/**
 * 一朵云：**竖直方向的大瓣堆叠**，不是沿 X 摊开的葡萄串。
 *
 * 结构：一条竖直主轴放 `spine` 个大瓣（半径随高度轻微胀缩，参考图的云柱在中上部
 * 最胖），再从主轴两侧挂 `flanks` 个半尺寸的肩瓣——菜花边就是这些肩瓣撑出来的。
 * 相邻主轴瓣的间距小于半径，所以并集是连续的、只有浅弧度的起伏，正面看不到接缝。
 *
 * 同一个种子出同一朵云（位移只看局部位置，非索引几何也不会裂）。
 */
export async function buildPuffGeometry(
  rand: () => number,
  blobCount = 9,
  detail: number = PUFF_SHAPE.detail,
): Promise<THREE.BufferGeometry> {
  const { mergeGeometries } = await import('three/addons/utils/BufferGeometryUtils.js');
  const parts: THREE.BufferGeometry[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const v = new THREE.Vector3();
  const sc = new THREE.Vector3();

  const n = Math.max(5, Math.min(16, Math.round(blobCount)));
  const d = Math.max(0, Math.min(3, Math.round(detail)));

  const halfW = PUFF_SHAPE.width / 2;
  const height = PUFF_SHAPE.width * PUFF_SHAPE.aspect;
  const halfH = height / 2;
  const lobeR = (PUFF_SHAPE.lobeDiameter * PUFF_SHAPE.width) / 2;

  /** 主轴瓣：沿 Y 排列，中上部略胖。 */
  const spine = Math.max(3, Math.round(n * 0.6));
  /** 肩瓣：挂在主轴两侧，撑出菜花边。 */
  const flanks = Math.max(1, n - spine);
  const step = Math.max(lobeR * 0.55, (height - lobeR * 2) / Math.max(1, spine - 1));

  const lobes: { x: number; y: number; z: number; r: number }[] = [];
  for (let i = 0; i < spine; i += 1) {
    const u = spine === 1 ? 0.5 : i / (spine - 1);
    // 胀缩剖面：u=0（云底）0.86，u≈0.6 最胖 1.10，云顶回落到 ~0.9
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

  for (let i = 0; i < lobes.length; i += 1) {
    const lobe = lobes[i];
    const g = new THREE.IcosahedronGeometry(lobe.r, d);
    // 确定性絮状：位移只看局部位置（同位置同值，非索引也不裂）。
    const pos = g.attributes.position as THREE.BufferAttribute;
    const nor = g.attributes.normal as THREE.BufferAttribute;
    for (let k = 0; k < pos.count; k += 1) {
      const px = pos.getX(k);
      const py = pos.getY(k);
      const pz = pos.getZ(k);
      const lump =
        1 +
        0.10 * Math.sin(px * 0.55 + i * 2.3) * Math.sin(py * 0.75 + i) * Math.sin(pz * 0.62 + i * 0.7);
      pos.setXYZ(k, px * lump, py * lump, pz * lump);
    }
    // 圆瓣：不再压 Y。旧的 0.62 把每瓣拍成扁饼，是"葡萄感"的来源之一。
    e.set(rand() * 0.3 - 0.15, rand() * Math.PI * 2, rand() * 0.3 - 0.15);
    q.setFromEuler(e);
    v.set(lobe.x, lobe.y, lobe.z);
    sc.set(0.94 + rand() * 0.14, 0.94 + rand() * 0.14, 0.94 + rand() * 0.14);
    m.compose(v, q, sc);
    g.applyMatrix4(m);
    parts.push(g);
  }
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error('[puff] mergeGeometries returned null');

  // Centre on the cloud's own middle so the fragment-stage "radial" (from positionLocal)
  // means what it says.
  merged.center();

  const mPos = merged.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(mPos.count * 3);
  for (let k = 0; k < mPos.count; k += 1) {
    // 分档已挪进片元（colorNode 按 radial+normal 算），顶点色只留破平涂塑料感的
    // 极轻灰阶抖动——三通道同值，片元侧乘回去。
    const shade = 0.985 + rand() * 0.03;
    colors[k * 3] = shade;
    colors[k * 3 + 1] = shade;
    colors[k * 3 + 2] = shade;
  }
  merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  merged.computeBoundingSphere();
  return merged;
}

export async function initPuffClouds(
  scene: THREE.Scene,
  seed = 7,
  count: number = PUFF_COUNT_HIGH,
): Promise<PuffHandle> {
  const TSL = await import('three/tsl');
  const { MeshBasicNodeMaterial } = await import('three/webgpu');

  const material = new MeshBasicNodeMaterial();
  // vertexColors 只负责把 color 属性绑进着色器（TSL.vertexColor 才读得到）；
  // 实际的相乘只在下面的 colorNode 里显式做一次。
  material.vertexColors = true;
  material.transparent = true;
  material.depthWrite = true;
  // DoubleSide：unlit 分档色不吃法线双面零代价；FrontSide 在机头钻进云里那一刻
  // 远端内壁全是背面被剔除 + 近端又被淡出整朵云当场隐形——这就是“没靠近就消失”。
  material.side = THREE.DoubleSide;
  material.fog = false;
  // 穿云不糊脸：近处片元先淡掉远处 dome 的 whiteout 再接管。
  // 和 clouds-compute 同一写法（cameraPosition/positionWorld）全后端可编译。
  const dist = TSL.length(TSL.cameraPosition.sub(TSL.positionWorld));
  material.opacityNode = TSL.smoothstep(
    TSL.float(PUFF_FADE_NEAR),
    TSL.float(PUFF_FADE_FAR),
    dist,
  ).mul(0.96);

  // 分档进片元：radial（云心指向片元）+ 28% 表面法线，整朵共享一条曲面连续的
  // 明暗终结线——顶点色分档的硬边界只能沿三角面拓扑走，近距离出多边形色阶。
  // `puffBandIndex` 读同一份 PUFF_BAND_THRESHOLDS，两边不许漂。
  const sunDir = TSL.vec3(_sun.x, _sun.y, _sun.z);
  const radial = TSL.normalize(TSL.positionLocal);
  const surface = TSL.normalLocal;
  const lit = radial.dot(sunDir).mul(0.72).add(surface.dot(sunDir).mul(0.28));
  const sunW = TSL.clamp(lit.mul(0.5).add(0.5), 0, 1);
  const [t0, t1, t2] = PUFF_BAND_THRESHOLDS;
  const b1 = TSL.step(t0, sunW);
  const b2 = TSL.step(t1, sunW);
  const b3 = TSL.step(t2, sunW);
  const shadowC = TSL.color(new THREE.Color(CLOUD_PALETTE.shadow));
  const baseC = TSL.color(new THREE.Color(CLOUD_PALETTE.base));
  const pinkC = TSL.color(new THREE.Color(CLOUD_PALETTE.pink));
  const goldC = TSL.color(new THREE.Color(CLOUD_PALETTE.gold));
  const creamC = TSL.color(new THREE.Color(0xfff6ea));
  let bandCol: any = TSL.mix(TSL.mix(TSL.mix(shadowC, baseC, b1), pinkC, b2), goldC, b3);
  // 肚皮：朝下的面往紫里压一档；band<=1 压得轻（0.3），受光面压得重（0.75）。
  const band = b1.add(b2).add(b3);
  const belly = TSL.clamp(TSL.normalLocal.y.negate(), 0, 1);
  const bellyAmt = TSL.clamp(belly.sub(0.5).mul(1.6), 0, 1).mul(TSL.mix(0.3, 0.75, TSL.step(2, band)));
  bandCol = TSL.mix(bandCol, shadowC, bellyAmt);
  // 顶光：只有最亮那档往奶白提，云顶有个亮盖，云身不被冲白。
  bandCol = TSL.mix(bandCol, creamC, b3.mul(TSL.clamp(TSL.normalLocal.y, 0, 1)).mul(0.45));
  material.colorNode = bandCol.mul(TSL.vertexColor()); // 顶点色 = 灰阶抖动

  const group = new THREE.Group();
  group.name = 'puff-field';
  // 顺序反转（散布专文 §2.1）：先把几何全部造出来拿到真实 bbox，再按尺寸散点——
  // y 带是从每朵云自己的 halfH 反解的，先散点后建模时尺寸根本还不存在。
  const rand = mulberry32(seed * 1000 + 11);
  const built: { geo: THREE.BufferGeometry; size: PuffSize }[] = [];
  for (let i = 0; i < count; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const geo = await buildPuffGeometry(rand, 10 + Math.floor(rand() * 4), PUFF_SHAPE.detail);
    geo.computeBoundingBox();
    const box = new THREE.Vector3();
    geo.boundingBox!.getSize(box);
    // 缩放先按竖直带反解上限：塞不进 [SEA_CLEAR, DECK_BOTTOM] 的体量会压扁云底
    // 的净空感，压上限比硬夹好（硬夹会让云贴着海面/云层底，边界感全露）。
    const fitMax =
      (CLOUD_BAND.bottom - PUFF_SCATTER.SEA_CLEAR - PUFF_SCATTER.BAND_MARGIN) / (2 * box.y * 0.5);
    const s = Math.min(1.6 + rand() * 1.0, fitMax);
    built.push({ geo, size: { halfW: (box.x * 0.5) * s, halfH: (box.y * 0.5) * s, s } });
  }
  const spots = puffScatter(seed, built.map((b) => b.size));
  for (let i = 0; i < built.length; i += 1) {
    const mesh = new THREE.Mesh(built[i].geo, material);
    mesh.name = `puff-${String(i).padStart(2, '0')}`;
    mesh.position.set(spots[i].x, spots[i].y, spots[i].z);
    mesh.scale.setScalar(spots[i].s);
    mesh.frustumCulled = true;
    group.add(mesh);
  }
  scene.add(group);

  let disposed = false;
  return {
    kind: 'puff',
    update(): void {
      if (disposed) return;
      // 静态造型 + TSL 距离淡出：位置不动法线烘焙才成立漂移交给远近步进。
    },
    setQuality(high: boolean): void {
      if (disposed) return;
      // 低档藏一半：不断程序不重建和 dome 的 setQuality 同策略。
      group.children.forEach((child, i) => {
        child.visible = high || i % 2 === 0;
      });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      scene.remove(group);
      group.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh) (mesh.geometry as THREE.BufferGeometry)?.dispose();
      });
      material.dispose();
    },
  };
}
