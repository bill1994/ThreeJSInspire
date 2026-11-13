/**
 * src/time-of-day.ts — planB R1 纯函数层：tod（0..24 小时制）→ 太阳仰角/方位，
 * 外加静态月亮的反相位（R2 静态版）。无 THREE、无 DOM——本任务只定义「时刻到
 * 方向」的映射并让量具先行（time-of-day.test.ts），渲染路径的消费接线在 Task 3
 * （syncSun 扇出），KEYS 轨道键扩展在 Task 4，月亮盘的 shader 在 Task 5。
 *
 * R1 定案公式：
 *   el(tod) = PEAK·sin(π(tod−6)/12)      —— 6 点日出 0°、12 点正午弧顶、18 点日落
 *                                           0°、0 点午夜 −PEAK，单一正弦弧闭合。
 *   az(tod) = (tod−12)·15 + AZ_OFFSET    —— 匀速方位（15°/小时），偏移量把 t0
 *                                           钉回参考太阳方位（见 AZ_OFFSET）。
 *
 * 反解锚点（planB 审计 B1，推导见 commit 89e61d0）：默认 tod 必须让 el(t0) 回到
 * 参考太阳仰角（skyTrackAt 参考档的 REFERENCE_ELEVATION_DEG ≈ 6.97°）——
 * tod = 6 + 12·(1 − asin(6.97/65)/π) ≈ 17.5896，默认取 17.59
 * （el(17.59) ≈ 6.964，钉在锚点 ±0.02 容差内）。
 *
 * 输出约定：el 为度（正 = 地平线上）；az 回卷进 [0, 360)——tod 走完一整天
 * az(0) === az(24)，一天的方位弧无缝闭合。
 */
import { SUN_POSITION } from './palettes';

/**
 * 缺省 tod（小时）。不是拍脑袋：它是把参考仰角反解进 R1 弧的 t0（见文件头），
 * `?tod=` 缺省/非法时 main.ts 回退到这里。
 */
export const TOD_DEFAULT_H = 17.59;

/** R1 弧顶仰角（度）：正午的太阳高度，公式字面量 65。 */
export const PEAK_ELEVATION_DEG = 65;

/** 参考方位（度），main.ts syncSun 的口径 `atan2(x, −z)·180/π`：atan2(60, 280) ≈ 12.0948°。 */
const AZ_REF_DEG = (Math.atan2(SUN_POSITION[0], -SUN_POSITION[2]) * 180) / Math.PI;

/**
 * 方位偏移（度），推导而非拍脑袋——公式在 t0 处必须回到参考方位：
 *
 *   AZ_OFFSET = az_ref − (t0 − 12)·15 ≈ 12.0948 − 5.59·15 ≈ −71.7552°
 *
 * **错误做法**是把 12.09 本身当偏移：那样 az(17.59) ≈ 95.9°，默认接 ?tod 时
 * 太阳方位横跳 84°。与 `REFERENCE_ELEVATION_DEG` 同一手法的派生常量：从
 * `SUN_POSITION` 算出来而不是抄字面量，太阳挪窝时锚点自动跟随。
 */
export const AZ_OFFSET = AZ_REF_DEG - (TOD_DEFAULT_H - 12) * 15;

/** 角度回卷进 [0, 360)（负角与多圈一并归一）。 */
function wrap360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** R1 太阳仰角（度）：`65·sin(π(tod−6)/12)`，6/18 点过地平线，正午弧顶，午夜弧底。 */
export function solarElevationFor(tod: number): number {
  return PEAK_ELEVATION_DEG * Math.sin((Math.PI * (tod - 6)) / 12);
}

/** R1 太阳方位（度，[0, 360)）：匀速 15°/小时加偏移，t0 处精确回到参考方位。 */
export function solarAzimuthFor(tod: number): number {
  return wrap360((tod - 12) * 15 + AZ_OFFSET);
}

/**
 * R2 静态月亮：太阳的对跖点——el 取负、az +180（回卷 [0, 360)）。太阳落月亮升，
 * 共享同一套方位参数，无第二套相位。静态版：不随日期/纬度摆动，Task 5 的
 * 月亮盘 shader 只消费这个方向。
 */
export function moonDirectionFor(elDeg: number, azDeg: number): { el: number; az: number } {
  return { el: -elDeg, az: wrap360(azDeg + 180) };
}

/**
 * ?tod= 静态接线的启动裁决（planB Task 3，B2「设了就生效，不推进」）。纯函数：
 * 不碰 SunState、不碰 DOM，main.ts 启动块拿它裁决一次。
 *
 *   - `sunParamValid`（?sun= 已被 main.ts 成功应用）→ null——优先级 ?sun= 胜
 *     ?tod=。URLSearchParams 按名取值，与两参数在 URL 里的先后顺序无关。
 *   - `todParam` 缺省/非法（main.ts 的 parseTod 已给 null）→ null——「无参数 =
 *     无消费」，t0（无 ?tod）的太阳方向保持 SUN_POSITION 默认，逐位不变；闭包
 *     里的 TOD_DEFAULT_H 只是 Task 4 的推进基点，不参与这次裁决。
 *   - 其余 → R1 弧上的 {az, el}（solarAzimuthFor / solarElevationFor）。
 *
 * 运行时 qa.setTod 的「设了就生效」不经过这里——那是显式写入，无 URL 冲突
 * 可仲裁，直接走 setAzEl + syncSun。
 */
export function resolveStaticTodSun(
  todParam: number | null,
  sunParamValid: boolean,
): { az: number; el: number } | null {
  if (sunParamValid) return null;
  if (todParam === null || !Number.isFinite(todParam)) return null;
  return { az: solarAzimuthFor(todParam), el: solarElevationFor(todParam) };
}
