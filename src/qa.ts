/**
 * src/qa.ts — 抓帧用的纯解析器。
 *
 * 验收里有三条必须逐帧看（穿云无硬切边、不凭空消失、白雾平滑进出），而布局每调一次
 * 云的位置就会变，靠「飞过去碰运气」不可复现。所以摆位和开关都要能从 URL 给定。
 */

export interface Pos {
  x: number;
  y: number;
  z: number;
}

/** `?pos=x,y,z` → 三个有限数，否则 null（宁可忽略也不要把飞机扔到 NaN）。 */
export function parsePos(raw: string | null | undefined): Pos | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const parts = raw.split(',');
  if (parts.length !== 3) return null;
  // 空分量必须拒绝：Number('') 是 0，?pos=1,,3 会把飞机静默按到海平面。
  if (parts.some((p) => p.trim().length === 0)) return null;
  const nums = parts.map((p) => Number(p.trim()));
  if (!nums.every((n) => Number.isFinite(n))) return null;
  return { x: nums[0], y: nums[1], z: nums[2] };
}

/** `?puff=0` 关掉近景云场；其它值（含缺省）一律当开。 */
export function parsePuffVisible(raw: string | null | undefined): boolean {
  return raw !== '0';
}

/** `?sea=0` 关掉海面；其它值（含缺省）一律当开。 */
export function parseSeaVisible(raw: string | null | undefined): boolean {
  return raw !== '0';
}

/** `?sea=debug` 进假色模式；真当且仅当显式 `debug`。 */
export function parseSeaDebug(raw: string | null | undefined): boolean {
  return raw === 'debug';
}

/**
 * `?sunspin=<deg/s>` → 太阳匀速自转速度（度/秒）。
 *
 * 2026-11-08 联动验收杠杆：让天空的太阳盘/光晕与海面的太阳映射一起转，
 * 肉眼或 `qa.step()` 抓帧都能直接验证二者是否同步。缺省、非法、非正数
 * 一律 0（默认画面完全不变）；上限 360 deg/s 防 typo 把太阳转成频闪。
 */
export function parseSunSpin(raw: string | null | undefined): number {
  if (typeof raw !== 'string' || raw.length === 0) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, 360);
}
