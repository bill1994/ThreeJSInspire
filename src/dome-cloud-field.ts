/**
 * src/dome-cloud-field.ts — 穹顶云层的几何契约（纯函数，node 下可测）。
 *
 * 这层云永远在相机上方，所以射线只需要往上打：从相机射线的 slab 进入点开始，
 * 到「出 slab」或「出水平盒」为止。三个量在这里一次定死，shader 只做消费：
 *
 * - `DOME_SLAB`：云层的垂直区间与水平半宽。云底 380 高于飞行上限 240，留 140 m
 *   余量；半宽 1800 必须小于相机远平面 2000（`src/main.ts:65`），否则整层被裁掉。
 * - `fadeEnd === halfExtent`：盒壁处必须已经全透明，这是「看不见盒子边」的唯一保证。
 * - `slabSpan` / `boxExit`：两段求交分别给上界，shader 取 `min` 得到真实射程。
 *
 * 2026-11-09 首版。设计的取舍与验收门见
 * `docs/superpowers/specs/2026-11-09-dome-cloud-volumetric-design.md`。
 */

/** 云层的垂直区间、水平半宽与淡出带（米）。 */
export const DOME_SLAB = {
  /** 云底：高于飞行上限 `FLIGHT.ALT_MAX = 240`，保证相机永远在云下。 */
  base: 380,
  /** 云顶：够高才有塔感；太厚只是浪费射程。 */
  top: 1150,
  /** 水平半宽：必须 < 相机远平面 2000。 */
  halfExtent: 1800,
  /** 开始融进地平线霾的距离。 */
  fadeStart: 1200,
  /** 完全消失的距离，恒等于 `halfExtent`。 */
  fadeEnd: 1800,
} as const;

/** 一段射线的行进区间（沿射线方向的米数）。 */
export interface SlabSpan {
  t0: number;
  t1: number;
}

/**
 * 射线（只给 y 分量）穿过云层 slab 的区间。
 *
 * `dirY` 近乎 0 时无法用两个平面的交点求区间：只有「相机已经在 slab 内」才算命中，
 * 此时射程交给水平盒上界（`boxExit`）截断。
 *
 * @param originY 相机高度（米）
 * @param dirY 射线方向的 y 分量（不必归一化）
 * @returns 命中区间；永不进入 slab 时返回 `null`
 */
export function slabSpan(originY: number, dirY: number): SlabSpan | null {
  if (!Number.isFinite(originY) || !Number.isFinite(dirY)) return null;

  const inside = originY >= DOME_SLAB.base && originY <= DOME_SLAB.top;
  if (Math.abs(dirY) < 1e-6) {
    // 平视：在 slab 内就是无限射程，交给盒壁截断；在外面永远不会进。
    return inside ? { t0: 0, t1: Infinity } : null;
  }

  const tBase = (DOME_SLAB.base - originY) / dirY;
  const tTop = (DOME_SLAB.top - originY) / dirY;
  const enter = Math.min(tBase, tTop);
  const exit = Math.max(tBase, tTop);

  // 整段都在相机背后。
  if (exit <= 0) return null;

  const t0 = Math.max(enter, 0);
  if (exit <= t0) return null;
  return { t0, t1: exit };
}

/**
 * 射线从相机（盒子中心）走到水平盒壁的米数。
 *
 * `horizontalPerUnitT` 是射线方向的水平分量长度（`hypot(dirX, dirZ)`），
 * 垂直射线没有水平位移，永远不会撞墙，返回 `Infinity`。
 *
 * @param horizontalPerUnitT 每单位 t 的水平位移
 * @param halfExtent 盒子的水平半宽（米）
 */
export function boxExit(horizontalPerUnitT: number, halfExtent: number): number {
  const h = Math.abs(horizontalPerUnitT);
  if (!Number.isFinite(h) || h <= 1e-6) return Infinity;
  if (!Number.isFinite(halfExtent) || halfExtent <= 0) return 0;
  return halfExtent / h;
}

/**
 * 距离淡出系数：1 = 完全不透明，0 = 完全融进霾。
 *
 * 在 `[fadeStart, fadeEnd]` 上走 `3t² − 2t³` 的 smoothstep，两端斜率为 0，
 * 所以远处不会出现一条「淡出开始」的硬线。
 */
export function fadeAt(distanceMetres: number): number {
  if (!Number.isFinite(distanceMetres)) return 0;

  const { fadeStart, fadeEnd } = DOME_SLAB;
  if (distanceMetres <= fadeStart) return 1;
  if (distanceMetres >= fadeEnd) return 0;

  const t = (distanceMetres - fadeStart) / (fadeEnd - fadeStart);
  return 1 - t * t * (3 - 2 * t);
}

/**
 * 云的漂移速度与方向（米/秒、米）。
 *
 * 两层速度不同，所以偏移必须分开算——用一个偏移装两层会让 weather 图跟着
 * detail 的速度走，云块位置和毛边以不同速率漂移这件事就没了。
 *
 * 量级来自「盯 30 秒能发现它变了」的**实测反推**：初版 0.35 m/s 在 30 秒里只让画面变化\n * 0.06/255，肉眼等于静止（门 3 实测），所以提到 3.5 m/s——仍然远慢于真实积云的 5–15 m/s。
 */
export const DOME_DRIFT = {
  /** 侵蚀细节的漂移速度。 */
  detailMetresPerSecond: 3.5,
  /** 天气图（云块位置）的漂移速度，略快于细节。 */
  weatherMetresPerSecond: 2.0,
  /** detail 纹理在世界里铺开的边长，用来把米换算成 UV。 */
  detailTileMetres: 400,
  /** weather 纹理在世界里铺开的边长。 */
  weatherTileMetres: 8000,
  /** 两层共用的风向（弧度）。 */
  headingRad: 0.6,
} as const;

/** 可以各自漂移的两层。 */
export type DomeDriftLayer = 'detail' | 'weather';

/**
 * 某一层在 `elapsedSeconds` 时刻的世界空间漂移量（米）。
 *
 * 只吃累加的 `elapsed`，**不读墙上时钟**：冻结抓帧（`?qa=frozen`）靠这个
 * 保证同一个 `step(n)` 两次跑出完全相同的云。
 */
export function driftOffset(
  elapsedSeconds: number,
  layer: DomeDriftLayer,
): { x: number; z: number } {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return { x: 0, z: 0 };

  const speed =
    layer === 'weather' ? DOME_DRIFT.weatherMetresPerSecond : DOME_DRIFT.detailMetresPerSecond;
  const travelled = elapsedSeconds * speed;
  return {
    x: Math.cos(DOME_DRIFT.headingRad) * travelled,
    z: Math.sin(DOME_DRIFT.headingRad) * travelled,
  };
}

/**
 * 一次 march 的每步长度（米）。
 *
 * 用权重 `w_i = (i+1)^p − i^p` 归一化到射程：近处步长细（首步约 1 m），远处
 * 粗（末步约 110 m），**总和精确等于 `span`**。这替代了「12 m 起、60 m 封顶」
 * 的固定序列——那种写法在 28 步内最多覆盖 28×60 = 1680 m，压不住 1800 m 射程。
 *
 * 末尾元素吸收浮点误差，保证 `sum(widths) === span` 在浮点意义上也成立。
 *
 * @param count 步数
 * @param span 需要覆盖的射程（米）
 */
export function stepSizes(count: number, span: number): Float64Array {
  if (!Number.isFinite(count) || !Number.isFinite(span) || count <= 0 || span <= 0) {
    return new Float64Array(0);
  }

  const n = Math.floor(count);
  const p = 2.2;
  const weights = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const a = (i + 1) ** p;
    const b = i ** p;
    weights[i] = a - b;
    total += weights[i];
  }

  const widths = new Float64Array(n);
  let assigned = 0;
  for (let i = 0; i < n - 1; i += 1) {
    const w = (weights[i] / total) * span;
    widths[i] = w;
    assigned += w;
  }
  // 最后一步吸收全部浮点误差，命中「总和精确等于射程」。
  widths[n - 1] = span - assigned;
  return widths;
}