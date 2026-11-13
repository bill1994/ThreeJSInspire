import { describe, it, expect } from 'vitest';
import {
  AZ_OFFSET,
  TOD_DEFAULT_H,
  moonDirectionFor,
  resolveStaticTodSun,
  solarAzimuthFor,
  solarElevationFor,
} from './time-of-day';
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

// ---- Task 3：静态 tod 接线（B2：设了就生效，不推进）量具 -----------------------

/**
 * main.ts 源码（sky-sun-sea-linkage 量具同款 import.meta.glob ?raw）——接线形状的
 * tripwire。main.ts 的 boot 时序在 node 里跑不了（WebGPU/DOM），所以裁决逻辑
 * 用上面 import 的纯函数直接钉，接线本身用源码 pin。
 */
const rootSources = import.meta.glob('./*.ts', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

describe('static tod wiring (planB Task 3, B2: set-once, no advance)', () => {
  it('resolveStaticTodSun: ?tod=12 → el≈65, az≈288.24（正午弧顶）', () => {
    const dir = resolveStaticTodSun(12, false);
    expect(dir).not.toBeNull();
    expect(dir!.el).toBeCloseTo(65, 9);
    // az(12) = wrap360(0·15 + (−71.7552)) = 288.2448——独立字面量锚
    // （12.0948 − 5.59·15 + 360），量具不与实现共享推导。
    expect(Math.abs(dir!.az - 288.24)).toBeLessThanOrEqual(0.02);
  });

  it('resolveStaticTodSun: ?tod=0 → el≈−65, az≈108.24；az(0)===az(24)（一天方位弧闭合）', () => {
    const dir = resolveStaticTodSun(0, false);
    expect(dir).not.toBeNull();
    expect(dir!.el).toBeCloseTo(-65, 9);
    // az(0) = wrap360(−12·15 + (−71.7552)) = wrap360(−251.7552) = 108.2448。
    expect(Math.abs(dir!.az - 108.24)).toBeLessThanOrEqual(0.02);
    // 走完一整天回到同一方位（wrap 约定的结构性后果，接线依赖它不跳变）。
    expect(resolveStaticTodSun(24, false)!.az).toBeCloseTo(dir!.az, 9);
  });

  it('优先级 ?sun= 胜 ?tod=：?sun= 已应用时一律 null（与参数在 URL 里的顺序无关）', () => {
    // ?tod=12&sun=180,7 与 ?sun=180,7&tod=12 同判：URLSearchParams 按名取值，
    // 顺序自由度在 main.ts 的解析里结构性消掉（下面的源码 pin 钉住喂参形状——
    // sunApplied 只在 ?sun= 真正 setAzEl 过才置位）。
    expect(resolveStaticTodSun(12, true)).toBeNull();
    expect(resolveStaticTodSun(0, true)).toBeNull();
    // 非法 ?sun=（如 ?sun=garbage）不抢优先级：tod 照常生效。
    expect(resolveStaticTodSun(12, false)).not.toBeNull();
  });

  it('无 ?tod → null：t0 不消费（默认太阳方向留在 SUN_POSITION，逐位不变）', () => {
    // 缺省/非法（parseTod → null）一律 null——闭包里的 TOD_DEFAULT_H 只是 Task 4
    // 的推进基点，绝不因缺省而自动上台（17.59 与参考位「几乎」相同但不是逐位相同）。
    expect(resolveStaticTodSun(null, false)).toBeNull();
    expect(resolveStaticTodSun(NaN, false)).toBeNull();
  });

  it('main.ts 源码 pin：启动裁决喂的是 todQa（URL 真值）+ sunApplied（?sun= 是否真应用）', () => {
    const main = rootSources['./main.ts'];
    // 解析与 ?sun= 同一块、在 initSunsetSkyTSL/initWorld 之前——initGame 的白纱
    // sunDir 启动快照必须看到 tod 方向，而不是默认方向。
    expect(main).toMatch(/const todQa = parseTod\(urlParams\.get\('tod'\)\)/);
    expect(main).toMatch(/resolveStaticTodSun\(todQa, sunApplied\)/);
    expect(main).toMatch(/if \(todBoot\) sun\.setAzEl\(todBoot\.az, todBoot\.el\)/);
    // 闭包基点仍是 URL 真值 ?? 默认（缺省回退 TOD_DEFAULT_H，Task 4 的推进起点）。
    expect(main).toMatch(/let tod = todQa \?\? TOD_DEFAULT_H/);
    // sunApplied 只在 ?sun= 合法且已 setAzEl 的分支里置位。
    expect(main).toMatch(/sunApplied = true/);
  });

  it('main.ts 源码 pin：qa.setTod 设了就生效（clamp → R1 弧 → setAzEl 版本递增 → syncSun 扇出）', () => {
    const main = rootSources['./main.ts'];
    const start = main.indexOf('setTod(h: number): void');
    const end = main.indexOf('setTodSpeed(x: number): void', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = main.slice(start, end);
    expect(body).toMatch(/tod = Math\.min\(Math\.max\(h, 0\), 24\)/);
    expect(body).toMatch(/sun\.setAzEl\(solarAzimuthFor\(tod\), solarElevationFor\(tod\)\)/);
    expect(body).toMatch(/syncSun\(\)/);
  });

  it('B2 纪律：不推进——stepFrame 不读不写 tod；todSpeed 保持只写（期 2 才消费）', () => {
    const main = rootSources['./main.ts'];
    const start = main.indexOf('const stepFrame = (dt: number): void => {');
    const end = main.indexOf('const qaFrozen', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = main.slice(start, end);
    expect(body).not.toMatch(/\btod\b/);
    expect(body).not.toMatch(/todSpeed/);
    // todSpeed 全文件只出现两处：闭包声明 + setter（camelCase 的 parseTodSpeed /
    // setTodSpeed 因大小写不计入）——任何消费端出现都会让这条 tripwire 变红，
    // 逼着期 2 有意识地更新量具。?qa=frozen 下「纹丝不动」由这个只写性 +
    // 浏览器冒烟（getSun 前后对照）共同保证。
    expect(main.match(/todSpeed/g)).toHaveLength(2);
  });
});
