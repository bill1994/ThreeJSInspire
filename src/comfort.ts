/**
 * src/comfort.ts — P1-3 可用性开关（设计 §3.3）。
 *
 * 长飞 + 晕 3D 之前，先把难受的关掉：`?shake=reduced` 把送进相机的抖动
 * 全局 ×0.4，`?flash=reduced` 把云内白纱封顶从 0.45 压到 0.25。
 * 纯解析 + 纯常量，headless 可测；真正的接线在 feel（shake 输出口）
 * 与 game（whiteout 上限）各一行。
 */
import { WHITEOUT_MAX } from './in-cloud';

/** reduce-shake 档：trauma 体系送进相机的部分统一乘这个。 */
export const COMFORT_SHAKE_REDUCED = 0.4;
/** reduce-flash 档：白纱不透明度封顶。 */
export const COMFORT_WHITEOUT_REDUCED = 0.25;

export interface Comfort {
  /** 送进相机的抖动缩放：1 正常，0.4 柔和。 */
  shakeScale: number;
  /** 白纱不透明度上限：0.45 正常，0.25 柔和。 */
  whiteoutMax: number;
}

/** 没有开关时的基线：全抖 + 全纱。 */
export function comfortDefault(): Comfort {
  return { shakeScale: 1, whiteoutMax: WHITEOUT_MAX };
}

/**
 * 从 query 解析：只有精确的 `reduced` 才算数，大小写敏感；
 * 其它一切（缺席、空、拼错、`0`/`off`）都回落到基线——晕 3D 的人
 * 不该因为拼错参数名而吃到全抖。
 */
export function comfortFromQuery(search: string): Comfort {
  const out = comfortDefault();
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(typeof search === 'string' ? search : '');
  } catch {
    return out;
  }
  if (params.get('shake') === 'reduced') out.shakeScale = COMFORT_SHAKE_REDUCED;
  if (params.get('flash') === 'reduced') out.whiteoutMax = COMFORT_WHITEOUT_REDUCED;
  return out;
}
