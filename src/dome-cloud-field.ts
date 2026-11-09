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
