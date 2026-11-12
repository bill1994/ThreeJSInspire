import { describe, it, expect } from 'vitest';
import { AZ_OFFSET, TOD_DEFAULT_H, moonDirectionFor, solarAzimuthFor, solarElevationFor } from './time-of-day';
import { parseTod, parseTodSpeed } from './qa';

/**
 * time-of-day 量具（day-night planB Phase 1 Task 1）。
 *
 * 参考锚点全部用独立字面量（6.97 / 12.09 / 65 / −65）——量具不与实现共享推导，
 * 否则同一个错会把公式和测试一起带歪。锚点的来源：
 * - 仰角锚 = `skyTrackAt` 参考档的 REFERENCE_ELEVATION_DEG ≈ 6.97（asin(SUN_DIRECTION[1])）；
 * - 方位锚 = main.ts syncSun 口径 `atan2(x, −z)·180/π` = atan2(60, 280) ≈ 12.09。
 */
describe('time-of-day (planB R1/R2, reverse-solved anchors)', () => {
  it('reference anchors: el(17.59)≈6.97±0.02, az(17.59)≈12.09±0.02', () => {
    // t0 反解自参考仰角（tod = 6 + 12·(1 − asin(6.97/65)/π) ≈ 17.5896 → 默认 17.59）。
    expect(TOD_DEFAULT_H).toBe(17.59);
    // AZ_OFFSET 推导自同一锚（az_ref − (t0−12)·15 ≈ −71.755）；±0.01 容差钉住
    // 「拿 12.09 当偏移」的错误推导（那会让 az(17.59) 跑到 ≈95.9°）。
    expect(Math.abs(AZ_OFFSET - -71.76)).toBeLessThanOrEqual(0.01);
    // 双 pin：公式在 t0 处必须同时回到参考仰角与参考方位。
    expect(Math.abs(solarElevationFor(TOD_DEFAULT_H) - 6.97)).toBeLessThanOrEqual(0.02);
    expect(Math.abs(solarAzimuthFor(TOD_DEFAULT_H) - 12.09)).toBeLessThanOrEqual(0.02);
  });

  it('arc shape: el(6)=0, el(12)=65, el(18)=0, el(0)=−65', () => {
    // 四点结构钉：日出 0°、正午弧顶 65°、日落 0°、午夜 −65°（R1 单一正弦弧）。
    expect(solarElevationFor(6)).toBeCloseTo(0, 9);
    expect(solarElevationFor(12)).toBeCloseTo(65, 9);
    expect(solarElevationFor(18)).toBeCloseTo(0, 9);
    expect(solarElevationFor(0)).toBeCloseTo(-65, 9);
  });

  it('moon is antipodal: moonDirectionFor(6.97, 12.09) → el≈−6.97, az≈192.09', () => {
    // 反相位（R2 静态版）：el 取负、az +180——太阳落月亮升，无第二套相位参数。
    const moon = moonDirectionFor(6.97, 12.09);
    expect(moon.el).toBeCloseTo(-6.97, 9);
    expect(moon.az).toBeCloseTo(192.09, 9);
    // wrap 约定：az+180 越过 360 时回卷进 [0, 360)，与 solarAzimuthFor 同一约定。
    expect(moonDirectionFor(0, 350).az).toBeCloseTo(170, 9);
  });

  it('parseTod rejects <0, >24, non-numeric; parseTodSpeed defaults 0, rejects negative', () => {
    // 字面量纪律（parseSunSpin 同款）：垃圾输入不抛错、不打断启动。
    // tod 域 [0,24] 闭区间，越界是「超范围」不是「可夹取」——拒绝为 null。
    expect(parseTod('24.5')).toBeNull();
    expect(parseTod('-0.1')).toBeNull();
    expect(parseTod('abc')).toBeNull();
    expect(parseTod('')).toBeNull();
    expect(parseTod(null)).toBeNull();
    expect(parseTod(undefined)).toBeNull();
    // 闭区间端点与合法值原样放行。
    expect(parseTod('0')).toBe(0);
    expect(parseTod('24')).toBe(24);
    expect(parseTod('17.59')).toBe(17.59);

    // 速度 ≥0（小时/秒）：缺省/空串/垃圾/负数一律缺省 0，非负数原样放行。
    expect(parseTodSpeed(null)).toBe(0);
    expect(parseTodSpeed(undefined)).toBe(0);
    expect(parseTodSpeed('')).toBe(0);
    expect(parseTodSpeed('abc')).toBe(0);
    expect(parseTodSpeed('-1')).toBe(0);
    expect(parseTodSpeed('0')).toBe(0);
    expect(parseTodSpeed('2')).toBe(2);
  });
});
