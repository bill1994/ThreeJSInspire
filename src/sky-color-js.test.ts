import { describe, expect, it } from 'vitest';

import { skyColorJs } from './sky-color-js';
import { TOON_STEPS, toonQuantizeJs } from './toon-look';
import { REFERENCE_ELEVATION_DEG, rampColorJs, skyTrackAt, srgbToLinear, type Vec3 } from './sky-track';
import { HORIZON, antiSolarCool, horizonGlow, sunDisc, sunDirectionFromAzEl } from './horizon';
import { moonDirectionFor, solarAzimuthFor, solarElevationFor } from './time-of-day';
import { SKY_STOPS, SUN_DIRECTION, SUN_POSITION, SUN_TINT_LINEAR } from './palettes';

/** 默认太阳方位角（度），由 SUN_POSITION 算出，不写字面量。 */
const AZ = (Math.atan2(SUN_POSITION[0], -SUN_POSITION[2]) * 180) / Math.PI;
const REF_STATE = skyTrackAt(REFERENCE_ELEVATION_DEG);
const REF_P = REF_STATE.preetham;
const COS_HALF = Math.cos((HORIZON.DISK_HALF_ANGLE_DEG * Math.PI) / 180);

const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lum = (v: Vec3): number => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];

it('keeps the real 06:00 sky readable in every direction instead of black behind bright clouds', () => {
  const sun = sunDirectionFromAzEl(solarAzimuthFor(6), solarElevationFor(6));
  const state = skyTrackAt(0);
  for (const az of [0, 90, 180, 270]) {
    const colour = skyColorJs(sunDirectionFromAzEl(az, 30), sun, state, SUN_DIRECTION, REF_P, false);
    expect(lum(colour)).toBeGreaterThan(.06);
    expect(colour[2]).toBeGreaterThan(colour[0]);
  }
});

it('keeps noon blue on both sides of the sky, with a pale horizon and readable cloud bands', () => {
  const state = skyTrackAt(65);
  const sun = sunDirectionFromAzEl(AZ, 65);
  for (const offset of [0, 90, 180]) {
    const zenith = skyColorJs(sunDirectionFromAzEl(AZ + offset, 40), sun, state, SUN_DIRECTION, REF_P, false);
    const horizon = skyColorJs(sunDirectionFromAzEl(AZ + offset, 0), sun, state, SUN_DIRECTION, REF_P, false);
    expect(zenith[2]).toBeGreaterThan(zenith[0]);
    expect(lum(zenith)).toBeGreaterThan(.1);
    expect(lum(horizon)).toBeGreaterThan(lum(zenith));
  }
  for (let i = 1; i < 4; i++) expect(lum(state.cloudBands[i])).toBeGreaterThan(lum(state.cloudBands[i - 1]));
});

function cosAzimuth(dir: Vec3, sun: Vec3): number {
  const dl = Math.max(Math.hypot(dir[0], dir[2]), 1e-4);
  const sl = Math.max(Math.hypot(sun[0], sun[2]), 1e-4);
  return (dir[0] / dl) * (sun[0] / sl) + (dir[2] / dl) * (sun[2] / sl);
}

/**
 * 内联重建旧 skyColorTsl 公式（v1）——恒等测试的基准。
 * AWAY_COLOR / SKY_STOPS 直接 import；禁止经过 awayHorizonLinear()（那是海面端点，
 * 自带一次 AWAY_GAIN，混它等于 g²）。
 */
function oldSkyColor(dir: Vec3, sun: Vec3, includeDisc: boolean): Vec3 {
  const stops = SKY_STOPS.map((s) => srgbToLinear(s.color)) as [Vec3, Vec3, Vec3, Vec3];
  let base = rampColorJs(dir[1], stops);
  const cool = antiSolarCool(cosAzimuth(dir, sun), dir[1]);
  const away = srgbToLinear(HORIZON.AWAY_COLOR);
  base = [
    (1 - cool) * base[0] + cool * away[0],
    (1 - cool) * base[1] + cool * away[1],
    (1 - cool) * base[2] + cool * away[2],
  ];
  const cos = Math.max(dot3(dir, sun), 0);
  const glow = horizonGlow(cos);
  const disc = includeDisc ? sunDisc(cos, COS_HALF) * HORIZON.DISK_GAIN : 0;
  return [
    base[0] + SUN_TINT_LINEAR[0] * (glow + disc),
    base[1] + SUN_TINT_LINEAR[1] * (glow + disc),
    base[2] + SUN_TINT_LINEAR[2] * (glow + disc),
  ];
}

describe('skyColorJs — 参考档恒等（对旧公式逐通道 ≤1e-6）', () => {
  const dirs: Vec3[] = [];
  for (const az of [-90, -45, 0, 45, 90, 180]) {
    for (const el of [-10, -2, 0, 3, 7, 15, 30, 60, 90]) {
      dirs.push(sunDirectionFromAzEl(az, el));
    }
  }

  it('includeDisc=true：54 个方向逐通道 ≤1e-6', () => {
    expect(dirs.length).toBeGreaterThanOrEqual(20);
    for (const dir of dirs) {
      const oldV = oldSkyColor(dir, SUN_DIRECTION, true);
      const newV = skyColorJs(dir, SUN_DIRECTION, REF_STATE, SUN_DIRECTION, REF_P, true);
      for (let i = 0; i < 3; i += 1) {
        expect(Math.abs(oldV[i] - newV[i])).toBeLessThanOrEqual(1e-6);
      }
    }
  });

  it('includeDisc=false：与 true 只差盘项', () => {
    for (const dir of dirs) {
      const oldV = oldSkyColor(dir, SUN_DIRECTION, false);
      const newV = skyColorJs(dir, SUN_DIRECTION, REF_STATE, SUN_DIRECTION, REF_P, false);
      for (let i = 0; i < 3; i += 1) {
        expect(Math.abs(oldV[i] - newV[i])).toBeLessThanOrEqual(1e-6);
      }
    }
  });
});

describe('skyColorJs — 夜档形态与余晖', () => {
  it('-8° 档天顶亮度 < 参考档 ×0.2', () => {
    const zenith: Vec3 = [0, 1, 0];
    const refZen = lum(skyColorJs(zenith, SUN_DIRECTION, REF_STATE, SUN_DIRECTION, REF_P, false));
    const nightZen = lum(
      skyColorJs(zenith, sunDirectionFromAzEl(AZ, -8), skyTrackAt(-8), SUN_DIRECTION, REF_P, false),
    );
    expect(nightZen).toBeLessThan(refZen * 0.2);
  });

  it('-8° 档向阳与背阳地平线逐通道相等（纯夜：day 支路整支丢弃，无方位残留）', () => {
    const state = skyTrackAt(-8);
    const sun = sunDirectionFromAzEl(AZ, -8);
    const sunward = skyColorJs(sunDirectionFromAzEl(AZ, 0), sun, state, SUN_DIRECTION, REF_P, false);
    const away = skyColorJs(sunDirectionFromAzEl(AZ + 180, 0), sun, state, SUN_DIRECTION, REF_P, false);
    for (let i = 0; i < 3; i += 1) {
      expect(Math.abs(sunward[i] - away[i])).toBeLessThanOrEqual(1e-12);
    }
  });

  it('-4° 档余晖：地平线向阳显著亮于背阳（直射项已移出 E，glow≈0.45·cos^150 可测）', () => {
    const state = skyTrackAt(-4);
    const sun = sunDirectionFromAzEl(AZ, -4);
    const sunward = skyColorJs(sunDirectionFromAzEl(AZ, 0), sun, state, SUN_DIRECTION, REF_P, false);
    const away = skyColorJs(sunDirectionFromAzEl(AZ + 180, 0), sun, state, SUN_DIRECTION, REF_P, false);
    expect(lum(sunward)).toBeGreaterThan(lum(away) + 0.02);
  });
});

describe('skyColorJs — 海面路径（includeDisc）', () => {
  it('false 与 true 只差 sunTint·discGain·sunDisc 项；盘外方向逐位相等', () => {
    // 盘内：贴近太阳方向的观察方向
    const inside = sunDirectionFromAzEl(AZ, 6.97);
    const full = skyColorJs(inside, SUN_DIRECTION, REF_STATE, SUN_DIRECTION, REF_P, true);
    const no = skyColorJs(inside, SUN_DIRECTION, REF_STATE, SUN_DIRECTION, REF_P, false);
    const cos = Math.max(dot3(inside, SUN_DIRECTION), 0);
    const disc = sunDisc(cos, COS_HALF) * HORIZON.DISK_GAIN;
    for (let i = 0; i < 3; i += 1) {
      expect(Math.abs(full[i] - no[i] - SUN_TINT_LINEAR[i] * disc)).toBeLessThanOrEqual(1e-9);
    }
    // 盘外：地平线背阳方向，disc 权重为 0
    const outside = sunDirectionFromAzEl(AZ + 180, 0);
    const full2 = skyColorJs(outside, SUN_DIRECTION, REF_STATE, SUN_DIRECTION, REF_P, true);
    const no2 = skyColorJs(outside, SUN_DIRECTION, REF_STATE, SUN_DIRECTION, REF_P, false);
    for (let i = 0; i < 3; i += 1) {
      expect(full2[i]).toBe(no2[i]);
    }
  });
});

// ---- bloom 预算（计划 Task 4）：换轨道参数前必须重跑 -------------------------------

describe('bloom 预算 — 每档峰值（JS 镜像钉值）', () => {
  // 四个关键帧 + 段内采样 3°/−2° + planB Phase 1 Task 4 的 +15/30/45/65 真值档。
  // Task 4（2026-11-13）已补齐轨道键：65° 行是真值，不再是钳位基线——此 it 对
  // 全部 BUDGET_KEYS 严格断言 < bloomThreshold（红则压档内曲线，禁碰阈值与参考列）。
  const BUDGET_KEYS = [-8, -4, -2, 0, 3, REFERENCE_ELEVATION_DEG, 15, 30, 45, 65];
  // 方向网格：仰角 −2…40°（步长 2°）、相对太阳方位 ±90°（步长 5°）
  const grid: { el: number; off: number }[] = [];
  for (let el = -2; el <= 40; el += 2) {
    for (let off = -90; off <= 90; off += 5) grid.push({ el, off });
  }

  function peakFor(el: number, includeDisc: boolean, toonAmount: number = 0): number {
    const state = skyTrackAt(el);
    const sun = sunDirectionFromAzEl(AZ, el);
    let peak = 0;
    for (const d of grid) {
      const dir = sunDirectionFromAzEl(AZ + d.off, d.el);
      peak = Math.max(
        peak,
        lum(skyColorJs(dir, sun, state, SUN_DIRECTION, REF_P, includeDisc, toonAmount)),
      );
    }
    return peak;
  }

  it('非盘区（includeDisc=false）峰值 < 该档 bloomThreshold', () => {
    const peaks: Record<string, number> = {};
    for (const el of BUDGET_KEYS) {
      const state = skyTrackAt(el);
      const peak = peakFor(el, false);
      peaks[el.toFixed(2)] = Number(peak.toFixed(4));
      expect(peak).toBeLessThan(state.bloomThreshold);
    }
    // eslint-disable-next-line no-console
    console.log('[bloom-budget] non-disc peaks:', JSON.stringify(peaks));
  });

  it('盘区（includeDisc=true）峰值 ≤ 1.10（日盘有意越阈是 post.ts 既有设计）', () => {
    const peaks: Record<string, number> = {};
    for (const el of BUDGET_KEYS) {
      const peak = peakFor(el, true);
      peaks[el.toFixed(2)] = Number(peak.toFixed(4));
      expect(peak).toBeLessThanOrEqual(1.1);
    }
    // eslint-disable-next-line no-console
    console.log('[bloom-budget] disc-region peaks:', JSON.stringify(peaks));
  });

  it('toon mode (toonAmount=1) non-disc peak < bloomThreshold at EVERY budget key', () => {
    // toon-look Phase 1 Task 5（T7 量具先行）：出口档位化后输出亮度恒落锚点集
    // TOON_STEPS（最大 0.75），数学上封顶于 0.82 预算——此 it 钉死该不变量，
    // 压 TOON_STEPS 档内锚值之外的任何调参（glow/disc/轨道）都会在这里红。
    const peaks: Record<string, number> = {};
    for (const el of BUDGET_KEYS) {
      const state = skyTrackAt(el);
      const peak = peakFor(el, false, 1);
      peaks[el.toFixed(2)] = Number(peak.toFixed(4));
      expect(peak).toBeLessThan(state.bloomThreshold);
    }
    // eslint-disable-next-line no-console
    console.log('[bloom-budget] toon non-disc peaks:', JSON.stringify(peaks));
  });
});

// ---- planB Phase 1 Task 4：day keys 镜像对齐（每新档逐点）--------------------------
// TSL 侧经 applySkyTrack 泛型消费整份 SkyTrackState（无逐档分支），结构上不会漂；
// 此处钉可执行的一半：每新档 seaHazeEndpoints == skyColorJs 两标准地平方向输出
// （≤1e-6，与 sea/material.test.ts 同口径）+ 预算网格上输出有限。

describe('skyColorJs — day keys 镜像对齐（planB Task 4，每新档逐点）', () => {
  const AZ = (Math.atan2(SUN_POSITION[0], -SUN_POSITION[2]) * 180) / Math.PI;
  const grid: { el: number; off: number }[] = [];
  for (let el = -2; el <= 40; el += 2) {
    for (let off = -90; off <= 90; off += 5) grid.push({ el, off });
  }

  for (const el of [15, 30, 45, 65]) {
    it(`el=${el}：seaHazeEndpoints 的两端点 = skyColorJs 两标准地平方向（≤1e-6）`, async () => {
      const { seaHazeEndpoints } = await import('./sky-color-js');
      const state = skyTrackAt(el);
      const sun = sunDirectionFromAzEl(AZ, el);
      const { haze, awayEdge } = seaHazeEndpoints(state, sun, SUN_DIRECTION, REF_P);
      const hz = skyColorJs(sunDirectionFromAzEl(AZ, 0), sun, state, SUN_DIRECTION, REF_P, false);
      const aw = skyColorJs(sunDirectionFromAzEl(AZ + 180, 0), sun, state, SUN_DIRECTION, REF_P, false);
      for (let i = 0; i < 3; i += 1) {
        expect(Math.abs(haze[i] - hz[i])).toBeLessThanOrEqual(1e-6);
        expect(Math.abs(awayEdge[i] - aw[i])).toBeLessThanOrEqual(1e-6);
      }
    });

    it(`el=${el}：预算网格上输出有限（无 NaN/Inf）`, () => {
      const state = skyTrackAt(el);
      const sun = sunDirectionFromAzEl(AZ, el);
      for (const d of grid) {
        const dir = sunDirectionFromAzEl(AZ + d.off, d.el);
        for (const includeDisc of [false, true]) {
          const v = skyColorJs(dir, sun, state, SUN_DIRECTION, REF_P, includeDisc);
          for (const c of v) expect(Number.isFinite(c)).toBe(true);
        }
      }
    });
  }
});

// ---- toon-look Phase 1 Task 2：出口档位化（双镜像，N=6） ----------------------------
// 与 world.test.ts 同款：用 vite 的 ?raw glob 读源码（项目未装 @types/node，
// 不能 import node:fs）。镜像 pin 断言走源码文本，不信 TSL 懒编译的运行时反射。
const sources = import.meta.glob('./*.ts', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

describe('toonQuantizeJs (outlet posterize, N=6)', () => {
  // 亮度单调递增的输入序列：灰阶横跨全域 + 两个彩色点
  const ramp: Vec3[] = [];
  for (const g of [0.0, 0.01, 0.03, 0.05, 0.08, 0.12, 0.18, 0.25, 0.32, 0.42, 0.52, 0.64, 0.75, 0.9, 1.05]) {
    ramp.push([g, g, g]);
  }
  ramp.push([0.0, 0.5, 0.1], [0.6, 0.35, 0.15]);
  // 输入序列必须亮度单调递增（brief 前置条件）——彩色点按亮度归位
  ramp.sort((a, b) => lum(a) - lum(b));

  it('amount=0 is identity', () => {
    const c: Vec3 = [0.3, 0.2, 0.1];
    expect(toonQuantizeJs(c, 0)).toEqual(c);
  });

  it('amount=1 output stays within the 6-step anchor set (monotone in luminance)', () => {
    const buckets: number[] = [];
    let prev = -Infinity;
    for (const c of ramp) {
      const out = toonQuantizeJs(c, 1);
      const l = lum(out);
      // 全部落在锚点亮度上（实现内部做亮度归一，容差 1e-6）
      const dists = TOON_STEPS.map((s) => Math.abs(s - l));
      expect(Math.min(...dists)).toBeLessThanOrEqual(1e-6);
      // 亮度单调不减（容差 1e-6：锚亮度重建有 ±1ulp 浮点抖动；
      // 错桶映射的凹陷 ≥ 半个锚间距 ≈ 0.03，不会被容差吞掉）
      expect(l).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = l;
      buckets.push(dists.findIndex((d) => d <= 1e-6));
    }
    // 灰阶 0..1.05 必须横跨至少 4 个档（防退化成单档映射）
    expect(new Set(buckets).size).toBeGreaterThanOrEqual(4);
  });

  it('amount=0.5 is strictly between identity and full quantize', () => {
    const c: Vec3 = [0.3, 0.2, 0.1];
    const full = toonQuantizeJs(c, 1);
    const half = toonQuantizeJs(c, 0.5);
    for (let i = 0; i < 3; i += 1) {
      // out ≈ mix(c, c'', 0.5) 逐分量
      expect(Math.abs(half[i] - (c[i] + full[i]) / 2)).toBeLessThanOrEqual(1e-12);
      // 每分量严格落在 [min(c, c''), max(c, c'')] 内且 ≠ 两端
      const lo = Math.min(c[i], full[i]);
      const hi = Math.max(c[i], full[i]);
      expect(half[i]).toBeGreaterThan(lo);
      expect(half[i]).toBeLessThan(hi);
    }
  });

  it('NaN input → darkest anchor, never NaN out', () => {
    // 任一分量 NaN/Infinity → 整色按黑走管线：输出 = TOON_STEPS[0] 档代表色
    const blackRep = toonQuantizeJs([0, 0, 0], 1);
    const bads: Vec3[] = [
      [NaN, NaN, NaN],
      [1, NaN, Infinity],
      [Infinity, 0, 0],
    ];
    for (const bad of bads) {
      const out = toonQuantizeJs(bad, 1);
      expect(out).toEqual(blackRep);
      for (const v of out) expect(Number.isFinite(v)).toBe(true);
      // 半档过渡同样不漏 NaN
      for (const v of toonQuantizeJs(bad, 0.5)) expect(Number.isFinite(v)).toBe(true);
    }
    // 黑色代表色的亮度 = 最暗锚 TOON_STEPS[0]
    expect(Math.abs(lum(blackRep) - TOON_STEPS[0])).toBeLessThanOrEqual(1e-6);
  });

  it('mirror pin: skyColorTsl carries the same step expression (dual mirror)', () => {    const gpuSrc = sources['./sky-webgpu.ts'] as string;
    // TSL 侧同式特征串：出口量化函数、常量同源 import、共享 uToon 消费、出口接线
    expect(gpuSrc).toMatch(/toonQuantizeTsl/);
    expect(gpuSrc).toMatch(/from '\.\/toon-look'/);
    expect(gpuSrc).toMatch(/TOON_HUE_SHIFT/);
    expect(gpuSrc).toMatch(
      // Task 5 (R6 月盘)：出口在 floor 之后再加月盘项——floor 仍在 mix 之后、
      // 量化仍包住全出口（预算铁律）；月盘是出口唯一的加项扩展。
      // bg-cumulus Task 4 (2026-11-14)：云 premultiplied 合成插在月盘之后、量化
      // 之前（§裁定 9）——出口输入改为 skyC 变量，量化仍包住全出口。
      /let skyC: any = mix\(day, night, u\.nightWeight\)\.add\(u\.floor\)\.add\(moonTint\.mul\(moonGated\)\)/,
    );
    expect(gpuSrc).toMatch(/return toonQuantizeTsl\(tsl, skyC, u\.uToon\)/);
    // review round 1：数学体本身也钉死——分桶阈值必须走 TOON_BUCKET_MIDS
    //（step(TOON_STEPS[...]) = 阈值退化为锚值，单调性虽保但档宽错位）；
    // 亮度归一 anchor.div(max(dot(ch…))) 不可删（删了 out 不再落锚点亮度集）
    expect(gpuSrc).toMatch(/TOON_BUCKET_MIDS\[/);
    expect(gpuSrc).toMatch(/anchor\.div\(max\(dot\(ch/);
    // 常量单源：toon-look.ts 导出 TOON_STEPS / TOON_HUE_SHIFT / toonQuantizeJs
    const toonSrc = sources['./toon-look.ts'] as string;
    expect(toonSrc).toMatch(/export const TOON_STEPS/);
    expect(toonSrc).toMatch(/export const TOON_HUE_SHIFT/);
    expect(toonSrc).toMatch(/export function toonQuantizeJs/);
  });
});

// ---- planB Phase 1 Task 5：月向预算（R6，fail-dangerous 无豁免） -----------------
// 月亮是太阳的对跖点（Task 1 moonDirectionFor）：每档在月向及盘邻域采样天空
// 背景（JS 镜像 — 月盘项只活在 shader，见 sky-moon.test.ts 源码 pin），无条件
// < bloomThreshold。Task 2 的教训：本 it 无任何豁免/跳断言分支——红就是红，
// 压档内曲线修，禁碰阈值与参考列。

describe('bloom 预算 — 月向背景（Task 5 月盘着陆点，R6）', () => {
  const KEYS = [-8, -4, -2, 0, 3, REFERENCE_ELEVATION_DEG, 15, 30, 45, 65];

  it('every key: moonward sky background lum < bloomThreshold (unconditional)', () => {
    // 盘邻域：月心 ±2°（1.5° 月盘 + 裕量），仰角/方位各五点。
    const offs = [
      [0, 0],
      [2, 0],
      [-2, 0],
      [0, 2],
      [0, -2],
    ] as const;
    for (const el of KEYS) {
      const state = skyTrackAt(el);
      const sun = sunDirectionFromAzEl(AZ, el);
      const moon = moonDirectionFor(el, AZ);
      for (const [azO, elO] of offs) {
        const dir = sunDirectionFromAzEl(moon.az + azO, moon.el + elO);
        for (const includeDisc of [false, true]) {
          const v = skyColorJs(dir, sun, state, SUN_DIRECTION, REF_P, includeDisc);
          expect(lum(v)).toBeLessThan(state.bloomThreshold);
        }
      }
    }
  });
});
