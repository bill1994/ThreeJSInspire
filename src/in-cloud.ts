/**
 * src/in-cloud.ts — 「相机离最近的云团有多近」，驱动 HUD 白雾、相机扰动与台词。
 *
 * **为什么不是按高度**：近景 puff 的高度是随机分布的（spec §6.2），按高度判会在
 * 120 m 的空处糊你一脸白雾、又在你 60 m 一头扎进云里时给 0。所以唯一的输入是
 * 「相机到最近一朵云的距离」，按椭球归一化。
 *
 * dome 的 `CLOUD_BAND` 只决定 dome 自己的 raymarch 起点，与本模块无关。
 */

import type { PuffSpot, PuffSize } from './puff-field';

/** 一朵云在世界坐标里的包围体；`halfW`/`halfH` 已含整朵缩放。 */
export interface CloudBlob {
  x: number;
  y: number;
  z: number;
  halfW: number;
  halfH: number;
}

/**
 * 白雾的进/出阈值。**必须分开**：贴着云底上下微动时，单阈值会让白雾一闪一闪。
 * 状态由调用方保存（进用 `ENTER`、出用 `EXIT`）。
 */
export const IN_CLOUD = { ENTER: 0.35, EXIT: 0.25 } as const;

/**
 * 雾永远不到完全不透明。1.0 是一块遮住 HUD 的米色卡片，会被读成白屏 bug 而不是
 * 「我在云里」。留一点透，HUD 与机身还看得见。
 */
export const WHITEOUT_MAX = 0.6;

/** 椭球归一化距离的平滑边：d=1（云面）为 1，d=2 为 0。 */
function proximityOf(dx: number, dy: number, dz: number, halfW: number, halfH: number): number {
  const d = Math.hypot(dx / halfW, dy / halfH, dz / halfW);
  const t = Math.min(Math.max((d - 1) / 1, 0), 1);
  return 1 - t * t * (3 - 2 * t);
}

/**
 * 相机在云里的程度：对每朵云算椭球归一化接近度，取最大值。
 * 没有云、或输入不是有限数，一律 0——绝不因为坏数据糊屏。
 */
export function cloudProximity01(
  pos: { x: number; y: number; z: number },
  blobs: readonly CloudBlob[],
): number {
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return 0;
  if (!Array.isArray(blobs) || blobs.length === 0) return 0;
  let best = 0;
  for (const b of blobs) {
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y) || !Number.isFinite(b.z)) continue;
    if (!Number.isFinite(b.halfW) || !Number.isFinite(b.halfH)) continue;
    if (b.halfW <= 0 || b.halfH <= 0) continue;
    const p = proximityOf(pos.x - b.x, pos.y - b.y, pos.z - b.z, b.halfW, b.halfH);
    if (p > best) best = p;
  }
  return best;
}

/** 白雾不透明度：接近度的线性映射，封顶 `WHITEOUT_MAX`。 */
export function whiteout01(proximity: number): number {
  if (!Number.isFinite(proximity)) return 0;
  const p = Math.min(Math.max(proximity, 0), 1);
  return p * WHITEOUT_MAX;
}

/** 把散布结果与尺寸拼成包围体列表；`halfW`/`halfH` 已含整朵缩放。 */
export function blobsFromSpots(spots: readonly PuffSpot[], sizes: readonly PuffSize[]): CloudBlob[] {
  const out: CloudBlob[] = [];
  for (let i = 0; i < spots.length && i < sizes.length; i += 1) {
    out.push({ x: spots[i].x, y: spots[i].y, z: spots[i].z, halfW: sizes[i].halfW, halfH: sizes[i].halfH });
  }
  return out;
}
