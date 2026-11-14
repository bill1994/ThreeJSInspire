/**
 * src/sun-color.ts — 太阳颜色随仰角变化（线性 RGB）。
 *
 * 复审 I1：`uSunColor` previously 写死成黄昏暖色，夜档下云会拿到一块暖太阳，
 * 和 `sky-track` 的天空直接打架。这里把它变成仰角的纯函数，由 `main.ts` 的
 * `syncSun` 每帧灌进 uniform。
 *
 * 低空偏橙红（大气路径长），45° 以上接近中性白。
 *
 * 2026-11-14 自体积穹顶光照模块搬出：纯仰角函数，不依赖任何穹顶常量；背景
 * billboard 层删除后，sunColorFor 的活消费者是 sky-track 的灯色轨道；旧
 * world.setSunColor 通道已随 bg-cloud 层退场成为 no-op（bg-cumulus 的太阳
 * 响应走 uLightDir，bg-cumulus Task 5）。
 */

import type { Vec3 } from './sky-track';

export function sunColorFor(elevationDeg: number): Vec3 {
  const e = Number.isFinite(elevationDeg) ? Math.min(90, Math.max(0, elevationDeg)) : 0;
  const t = Math.min(1, e / 45);
  return [
    1.0,
    0.62 + 0.34 * t,
    0.42 + 0.5 * t,
  ] as const;
}
