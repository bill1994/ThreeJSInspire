/**
 * src/cloud-gates.ts — P2-1 云门关卡（spec Q2-3）。
 *
 * 散布（`puff-field.ts`）只保证「约 8.7s 遇一朵」（`PUFF_SPACING 400m`），
 * 不保证「从侧方 40~70m 掠过」——正前方撞脸的是穿云 hit，太远的是雾，
 * 只有前侧方框里的才算「门」。门调度是纯函数，不碰 THREE、不读时间：
 * 调用方（`far-field.ts` 的逐帧回收循环）每帧喂进 spots + 相机，拿回
 * 「搬哪朵、搬去哪」，自己动手搬 mesh。
 *
 * 为什么搬的是掉队朵：`pickGateSource` 选 ahead 最小的——它在身后，
 * 本来就看不见；门位在前 200~400m，`PUFF_HAZE` 600m 起淡，出现的那一头
 * 也泡在雾里。两头都不闪现，这是门调度不做渐显也能成立的全部理由。
 */

/** 开门节拍（秒）：spec「每 8~12s 一朵」，取中 10s。 */
export const GATE_PERIOD = 10;
/** 门位侧向带（米）：spec 原文 40~70m。 */
export const GATE_SIDE_MIN = 40;
export const GATE_SIDE_MAX = 70;
/** 门位前向带（米）：200m 外才有雾遮头，400m 内 10s 可达（46m/s）。 */
export const GATE_AHEAD_MIN = 200;
export const GATE_AHEAD_MAX = 400;
/** 候选框（米）：比门位松一圈——门里的云漂一会儿不许立刻触发补门。 */
const CAND_AHEAD_MIN = 100;
const CAND_AHEAD_MAX = 500;
const CAND_SIDE_MIN = 30;
const CAND_SIDE_MAX = 90;

export interface GateCam {
  x: number;
  z: number;
  /** 前向（2D，不必归一，内部归一）。 */
  dirX: number;
  dirZ: number;
}

export interface GateSpot {
  x: number;
  z: number;
}

/** 前向分量（米）：>0 在前，<0 掉队。 */
export function gateAhead(s: GateSpot, cam: GateCam): number {
  const len = Math.hypot(cam.dirX, cam.dirZ);
  if (!Number.isFinite(len) || len < 1e-9) return 0;
  if (!Number.isFinite(s.x) || !Number.isFinite(s.z)) return 0;
  return ((s.x - cam.x) * cam.dirX + (s.z - cam.z) * cam.dirZ) / len;
}

/** 侧向分量绝对值（米）。 */
function gateSide(s: GateSpot, cam: GateCam): number {
  const len = Math.hypot(cam.dirX, cam.dirZ);
  if (!Number.isFinite(len) || len < 1e-9) return 0;
  if (!Number.isFinite(s.x) || !Number.isFinite(s.z)) return 0;
  return Math.abs(((s.z - cam.z) * cam.dirX - (s.x - cam.x) * cam.dirZ) / len);
}

/** 到点了吗：上次开门 ≥10s 前，或上次非有限（首帧）→ 直接开。 */
export function gateDue(lastGateT: number, now: number): boolean {
  if (!Number.isFinite(now)) return false;
  if (!Number.isFinite(lastGateT)) return true;
  return now - lastGateT >= GATE_PERIOD;
}

/**
 * 第 n 扇门的门位（前向/侧向，米）。无 RNG 也确定：
 * 侧向在 40~70m 里按黄金分割散列，符号左右交替；
 * 前向在 200~400m 里另一组散列。调用方按相机朝向换算成世界坐标。
 */
export function gateSlot(n: number): { ahead: number; side: number } {
  const i = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  const frac = (v: number): number => v - Math.floor(v);
  const side = GATE_SIDE_MIN + (GATE_SIDE_MAX - GATE_SIDE_MIN) * frac(i * 0.61803398875 + 0.13);
  const ahead = GATE_AHEAD_MIN + (GATE_AHEAD_MAX - GATE_AHEAD_MIN) * frac(i * 0.38196601125 + 0.47);
  return { ahead, side: i % 2 === 0 ? side : -side };
}

/** 场上有现成的门吗：任一云落在候选框里即 true。 */
export function gateCandidate(spots: readonly GateSpot[], cam: GateCam): boolean {
  for (const s of spots) {
    const a = gateAhead(s, cam);
    const d = gateSide(s, cam);
    if (a >= CAND_AHEAD_MIN && a <= CAND_AHEAD_MAX && d >= CAND_SIDE_MIN && d <= CAND_SIDE_MAX) {
      return true;
    }
  }
  return false;
}

/**
 * 搬哪朵：ahead 最小的那朵（掉队最远）。空场回 -1，调用方直接不开门。
 */
export function pickGateSource(spots: readonly GateSpot[], cam: GateCam): number {
  let best = -1;
  let bestAhead = Number.POSITIVE_INFINITY;
  for (let i = 0; i < spots.length; i += 1) {
    const a = gateAhead(spots[i], cam);
    if (a < bestAhead) {
      bestAhead = a;
      best = i;
    }
  }
  return best;
}
