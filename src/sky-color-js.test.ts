import { describe, expect, it } from 'vitest';

import { skyColorJs } from './sky-color-js';
import { REFERENCE_ELEVATION_DEG, rampColorJs, skyTrackAt, srgbToLinear, type Vec3 } from './sky-track';
import { HORIZON, antiSolarCool, horizonGlow, sunDisc, sunDirectionFromAzEl } from './horizon';
import { SKY_STOPS, SUN_DIRECTION, SUN_POSITION, SUN_TINT_LINEAR } from './palettes';

/** 默认太阳方位角（度），由 SUN_POSITION 算出，不写字面量。 */
const AZ = (Math.atan2(SUN_POSITION[0], -SUN_POSITION[2]) * 180) / Math.PI;
const REF_STATE = skyTrackAt(REFERENCE_ELEVATION_DEG);
const REF_P = REF_STATE.preetham;
const COS_HALF = Math.cos((HORIZON.DISK_HALF_ANGLE_DEG * Math.PI) / 180);

const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lum = (v: Vec3): number => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];

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
