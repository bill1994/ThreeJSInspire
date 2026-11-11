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
import type { Vec3 } from './sky-track';

/** 一朵云在世界坐标里的包围体；`halfW`/`halfH` 已含整朵缩放。 */
export interface CloudBlob {
  x: number;
  y: number;
  z: number;
  halfW: number;
  halfH: number;
}

/**
 * 白雾的进/出阈值。**硬触发**：只有碰到云面才白，附近不提前白。
 * `cloudProximity01` 在云面(d=1)为 1、两倍半径(d=2)为 0，所以 ENTER=0.999 约等于
 * d≈1.02（30m 云约 0.5m 外）、EXIT=0.985 约等于 d≈1.06——也就是数学版 trigger mesh：
 * 纯函数椭球相交判，不配真正的 THREE.Mesh（25 朵每帧 Box3/Sphere 检查是同样的数学，
 * 还多一份场景图同步和回收对齐的活，纯函数可单测、确定性强）。
 * 进/出必须分开：贴着云面微动时单阈值会让白雾一闪一闪。
 * 状态由调用方保存（进用 `ENTER`、出用 `EXIT`）。
 */
export const IN_CLOUD = { ENTER: 0.999, EXIT: 0.985 } as const;

/**
 * 雾永远不到完全不透明。1.0 是一块遮住 HUD 的米色卡片，会被读成白屏 bug 而不是
 * 「我在云里」。留一点透，HUD 与机身还看得见。
 *
 * 0.6 → 0.45（2026-11-07）：白纱降级为兜底层——体积感改由兜底瓣
 * （`puff-cloud.ts` 的 `puff-interior` 壳层）提供，纱只负责最深处不发黑，
 * 0.6 的平纱会把兜底瓣的浓淡整个盖平。
 */
export const WHITEOUT_MAX = 0.45;

/**
 * 白纱的兜底色：按「视线与太阳的夹角余弦」在两端混色。
 * 背太阳（cos = −1）灰紫——云里的散射光被云体挡住；朝太阳（cos = +1）暖米——
 * 前向散射透过云层。0.5 混色值 #e7d7cf 兼作非有限输入的中性回退色。
 */
const DEFAULT_VEIL_COOL = { r: 0xcf, g: 0xc6, b: 0xda } as const;
const DEFAULT_VEIL_WARM = { r: 0xff, g: 0xe9, b: 0xc4 } as const;

// 端点是可注入的（day-night Task 7）：main 在启动时把轨道参考档的 veilCool/veilWarm
// 灌进来（线性 Vec3），本模块负责线性→sRGB byte 回转——veilTintCss 在 byte 空间
// floor 插值，线性值直灌会被 Math.floor 截成全黑。非有限回退色一并随端点换轨道值
// （端点在 byte 空间的 t=0.5 混色，与原 #e7d7cf 的推导同式）。
let veilCool: { r: number; g: number; b: number } = { ...DEFAULT_VEIL_COOL };
let veilWarm: { r: number; g: number; b: number } = { ...DEFAULT_VEIL_WARM };
let veilNeutral = '#e7d7cf';

/** 注入轨道纱色端点（线性 RGB）。启动时调用一次——game 的 opts 是 init 快照，不逐帧。 */
export function setVeilTintEndpoints(coolLinear: Vec3, warmLinear: Vec3): void {
  const toByte = (c: number): number => {
    const s =
      c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.min(Math.max(c, 0), 1), 1 / 2.4) - 0.055;
    return Math.round(Math.min(Math.max(s, 0), 1) * 255);
  };
  const cl = [coolLinear[0], coolLinear[1], coolLinear[2]].map(toByte);
  const wl = [warmLinear[0], warmLinear[1], warmLinear[2]].map(toByte);
  veilCool = { r: cl[0], g: cl[1], b: cl[2] };
  veilWarm = { r: wl[0], g: wl[1], b: wl[2] };
  veilNeutral = byteCss(
    Math.floor((cl[0] + wl[0]) / 2),
    Math.floor((cl[1] + wl[1]) / 2),
    Math.floor((cl[2] + wl[2]) / 2),
  );
}

function byteCss(r: number, g: number, b: number): string {
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b
    .toString(16)
    .padStart(2, '0')}`;
}

/** 视线-太阳夹角（cos，[-1,1]）→ 白纱 CSS 色；非有限输入回中性色。 */
export function veilTintCss(fwdDotSun: number): string {
  if (!Number.isFinite(fwdDotSun)) return veilNeutral;
  const t = Math.min(Math.max((fwdDotSun + 1) / 2, 0), 1);
  // 1/64 量化：转向时 cos 连续变化，不量化就会每帧改写全屏 DOM 背景并触发重绘
  // （终审 Minor #1 升级处理）。64 步 ≈ 每 1.4° 一档，肉眼不可分。
  const q = Math.round(t * 64) / 64;
  const ch = (a: number, b: number): number => Math.floor(a + (b - a) * q);
  return byteCss(ch(veilCool.r, veilWarm.r), ch(veilCool.g, veilWarm.g), ch(veilCool.b, veilWarm.b));
}

/**
 * 兜底瓣（相机周围的内部壳层）的整体透明度系数：贴着云面（prox→1）起瓣，
 * 云内恒定 1。0.7 起步让瓣在临近云面时已经淡入，出云对称淡出，
 * 与白雾的滞回状态机解耦——兜底瓣只读接近度，不持有状态。
 */
export function interiorOpacity01(prox: number): number {
  if (!Number.isFinite(prox)) return 0;
  return Math.min(Math.max((prox - 0.7) / 0.25, 0), 1);
}

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

/**
 * 白雾不透明度：接近度的线性映射，封顶 `cap`（默认 `WHITEOUT_MAX`）。
 * P1-3：`?flash=reduced` 把 cap 压到 0.25，云里只剩薄纱。
 */
export function whiteout01(proximity: number, cap: number = WHITEOUT_MAX): number {
  if (!Number.isFinite(proximity)) return 0;
  const c = Number.isFinite(cap) && cap > 0 ? Math.min(cap, 1) : WHITEOUT_MAX;
  const p = Math.min(Math.max(proximity, 0), 1);
  return p * c;
}

/** 把散布结果与尺寸拼成包围体列表；`halfW`/`halfH` 已含整朵缩放。 */
export function blobsFromSpots(spots: readonly PuffSpot[], sizes: readonly PuffSize[]): CloudBlob[] {
  const out: CloudBlob[] = [];
  for (let i = 0; i < spots.length && i < sizes.length; i += 1) {
    out.push({ x: spots[i].x, y: spots[i].y, z: spots[i].z, halfW: sizes[i].halfW, halfH: sizes[i].halfH });
  }
  return out;
}
