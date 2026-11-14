/**
 * planB Phase 1 Task 5 — 月盘（R6）pins.
 *
 * Static moon disc in the sky shader, fed by Task 1 `moonDirectionFor`
 * (antipodal: el→−el, az→az+180). B2 static rule — set-and-effective, no
 * elapsed advance, same as Task 3.
 *
 * - Disc is an angle threshold ISOMORPHIC to `sunDisc` (horizon.ts:193):
 *   `smoothstep(cosHalf, 1.0, cos)`, radius 1.5° (NOT the sun's 4x stylized
 *   exaggeration — a physical-size moon).
 * - Surface: 2–3 in-shader trig noise layers, no textures.
 * - Brightness anchor 0.72 (< 0.82 bloom budget, cf. stars.ts:14-18 压色做法).
 * - Day side invisible: sun el > 0 → moon alpha→0 step structure.
 * - Render order: stars shell r780 sits INSIDE the moon-painted dome r800 —
 *   dome renders first (renderOrder -1000), stars after (-999), so the two
 *   never interleave (plan Review Focus 4: 星点月盘互咬).
 * - Wiring: main.ts syncSun pushes `uMoonDir` from `moonDirectionFor(el, az)`.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { moonDirectionFor, solarAzimuthFor, solarElevationFor } from './time-of-day';
import { skyColorJs } from './sky-color-js';
import { REFERENCE_ELEVATION_DEG, skyTrackAt } from './sky-track';
import { SUN_DIRECTION, SUN_POSITION } from './palettes';
import { sunDirectionFromAzEl } from './horizon';
import { initStars } from './stars';
import { MOON_DISC_HALF_ANGLE_DEG, MOON_TINT_LINEAR } from './sky-webgpu';

const sources = import.meta.glob('./*.ts', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

const skySrc = sources['./sky-webgpu.ts'] as string;
const mainSrc = sources['./main.ts'] as string;

const lum = (v: readonly number[]): number => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];

describe('moon disc constants (R6: real 1.5° size, 0.72 anchor < 0.82)', () => {
  it('MOON_DISC_HALF_ANGLE_DEG is the real ~1.5° — not the sun 4x stylization', () => {
    expect(MOON_DISC_HALF_ANGLE_DEG).toBeGreaterThanOrEqual(1.2);
    expect(MOON_DISC_HALF_ANGLE_DEG).toBeLessThanOrEqual(1.8);
  });

  it('MOON_TINT_LINEAR Rec709 luminance sits at/below the 0.72 anchor (budget headroom)', () => {
    const l = lum(MOON_TINT_LINEAR);
    expect(l).toBeLessThanOrEqual(0.72);
    // Not a near-black stub: the disc must read as a moon, not a hole.
    expect(l).toBeGreaterThan(0.3);
    // And unconditionally under the bloom threshold — fail-dangerous, no bypass.
    expect(l).toBeLessThan(0.82);
  });
});

describe('moon is antipodal (Task 1 moonDirectionFor, static — no elapsed)', () => {
  it('?tod=0 → sun el≈−65° → moon overhead el≈+65°', () => {
    expect(solarElevationFor(0)).toBeCloseTo(-65, 6);
    const moon = moonDirectionFor(solarElevationFor(0), solarAzimuthFor(0));
    expect(moon.el).toBeCloseTo(65, 6);
  });

  it('?tod=12 → sun el≈+65° → moon el≈−65° (below horizon, invisible)', () => {
    expect(solarElevationFor(12)).toBeCloseTo(65, 6);
    const moon = moonDirectionFor(solarElevationFor(12), solarAzimuthFor(12));
    expect(moon.el).toBeCloseTo(-65, 6);
  });

  it('moon direction is a unit vector opposite the sun (az +180 wrap)', () => {
    const sun = sunDirectionFromAzEl(12.09, 6.97);
    const moon = moonDirectionFor(6.97, 12.09);
    const mdir = sunDirectionFromAzEl(moon.az, moon.el);
    const dot = sun[0] * mdir[0] + sun[1] * mdir[1] + sun[2] * mdir[2];
    expect(dot).toBeCloseTo(-1, 9);
    expect(moon.az).toBeCloseTo(192.09, 2);
  });
});

describe('moon disc TSL structure (source pins, isomorphic to sunDisc)', () => {
  it('uMoonDir uniform exists: declared + seeded + normalized setter (mirror setSunDirection)', () => {
    expect(skySrc).toMatch(/moonDir/);
    expect(skySrc).toMatch(/setMoonDirection\(dir: import\('three'\)\.Vector3\): void/);
    expect(skySrc).toMatch(/moonDir\.value\.copy\(dir\)\.normalize\(\)/);
  });

  it('angle-threshold disc isomorphic to sunDisc: smoothstep(cosHalf, 1.0, cosMoon)', () => {
    expect(skySrc).toMatch(/smoothstep\(cosMoonHalf, 1\.0, cosMoon\)/);
    expect(skySrc).toMatch(/MOON_DISC_HALF_ANGLE_DEG/);
  });

  it('surface is 2–3 in-shader trig noise layers, no texture sampling in skyColorTsl', () => {
    const fnStart = skySrc.indexOf('export function skyColorTsl');
    const fnEnd = skySrc.indexOf('TSL replacement for the GLSL dome', fnStart);
    const fnBlock = skySrc.slice(fnStart, fnEnd);
    // At least two sin( mottle layers on the moon path.
    const moonStart = fnBlock.indexOf('cosMoon');
    const moonBlock = fnBlock.slice(moonStart);
    expect(moonBlock.match(/sin\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    // The moon mottles procedurally — no texture fetch inside the sky colour fn.
    expect(fnBlock).not.toMatch(/texture\(/);
    expect(fnBlock).not.toMatch(/texture3D\(/);
  });

  it('day-side gate: moon rides the track nightWeight (0 by day, 1 by night)', () => {
    // 门控走轨道自带的昼夜交叉淡化（skyTrackAt：参考档 nightWeight === 0，
    // -8° 档 === 1，sky-track.test.ts:119-120/529-530）：与穹顶昼夜混合用的是
    // 同一个已验证 uniform——曾试过 smoothstep(0, 0.035, sunDirNode.y) 的
    // shader 内门，在 SwiftShader 路径下午夜仍输出 1（ Artefact 见 task-5-report），
    // 故门控收敛到 nightWeight，行为（tod0 见 / tod12 不见）由浏览器截图钉死。
    expect(skySrc).toMatch(/disc\.mul\(mottle\)\.mul\(u\.nightWeight\)/);
    // 月项仍在 floor 之后、量化之前加入出口（预算铁律：量化包住全出口）。
    expect(skySrc).toMatch(/\.add\(u\.floor\)\.add\(moonTint\.mul\(moonGated\)\)/);
  });

  it('moon term is sky-only: gated behind includeDisc like the sun disc (sea path excluded)', () => {
    const fnStart = skySrc.indexOf('export function skyColorTsl');
    const fnEnd = skySrc.indexOf('TSL replacement for the GLSL dome', fnStart);
    const fnBlock = skySrc.slice(fnStart, fnEnd);
    expect(fnBlock).toMatch(/includeDisc/);
    expect(fnBlock).toMatch(/moonDirNode/);
  });
});

describe('render order: stars shell (r780) vs moon-on-dome (r800)', () => {
  it('dome renders first (-1000), stars after (-999): no 星点月盘互咬', () => {
    // Dome side is a source pin (WebGPU material cannot instantiate in node).
    expect(skySrc).toMatch(/mesh\.renderOrder = -1000/);
    // Stars side is behavioral (initStars runs in node).
    const scene = new THREE.Scene();
    const stars = initStars(scene);
    const points = scene.getObjectByName('sky_stars') as THREE.Points;
    expect(points.renderOrder).toBe(-999);
    expect(-1000).toBeLessThan(points.renderOrder);
    stars.dispose();
  });

  it('moon is painted in the dome colorNode — not a second mesh that could z-fight', () => {
    // 2026-11-14：colorNode 改由 buildColorNode() 产出（cubeTexture 只能吃裸 Texture，
    // 换装要重构图），构造点仍是 skyColorTsl(tsl, dir, sunDir, ...)。
    expect(skySrc).toMatch(/material\.colorNode = buildColorNode\(\)/);
    expect(skySrc).toMatch(/skyColorTsl\(tsl, dir, sunDir/);
    expect(skySrc).not.toMatch(/moon.*Mesh|Mesh.*moon/i);
  });
});

describe('main.ts syncSun pushes uMoonDir (Task 1 moonDirectionFor)', () => {
  it('syncSun derives moon from live el/az via moonDirectionFor + sunDirectionFromAzEl', () => {
    expect(mainSrc).toMatch(/moonDirectionFor/);
    const start = mainSrc.indexOf('const syncSun = (): void => {');
    const end = mainSrc.indexOf('const stepFrame', start);
    const body = mainSrc.slice(start, end);
    expect(body).toMatch(/moonDirectionFor\(el,/);
    expect(body).toMatch(/sunDirectionFromAzEl\(moon/);
  });

  it('moon push goes through the dome handle (null-safe like the sun push)', () => {
    const start = mainSrc.indexOf('const syncSun = (): void => {');
    const end = mainSrc.indexOf('const stepFrame', start);
    const body = mainSrc.slice(start, end);
    expect(body).toMatch(/skyTsl\?\.setMoonDirection\(/);
  });
});

// ---- planB Phase 1 Task 6 Step 0 (M1 review debt): COMBINED moon+background ----
// Reviewer: moon tint (~0.66 ≤ 0.72 anchor) and moonward background (< 0.82)
// are pinned SEPARATELY — assert the SUM so the margin is guarded, not lore.
// Bound is analytic: lum is linear, so outlet lum at the moon ≤ bg lum +
// moonTint lum · disc(≤1) · mottle(≤1) · nightWeight. Literal 0.82 (not the
// state field) so a silent threshold raise also goes red. No exemptions.
describe('combined moon+background peak (M1: the sum, not lore)', () => {
  it('every key: moonward bg + moonTint·nightWeight < 0.82 (unconditional)', () => {
    const AZ = (Math.atan2(SUN_POSITION[0], -SUN_POSITION[2]) * 180) / Math.PI;
    const REF_STATE = skyTrackAt(REFERENCE_ELEVATION_DEG);
    const REF_P = REF_STATE.preetham;
    const moonLum = lum(MOON_TINT_LINEAR);
    const KEYS = [-8, -4, -2, 0, 3, REFERENCE_ELEVATION_DEG, 15, 30, 45, 65];
    // Disc neighbourhood: moon centre ±2° (1.5° disc + margin), el/az five points.
    const offs = [
      [0, 0],
      [2, 0],
      [-2, 0],
      [0, 2],
      [0, -2],
    ] as const;
    const peaks: Record<string, number> = {};
    for (const el of KEYS) {
      const state = skyTrackAt(el);
      const sun = sunDirectionFromAzEl(AZ, el);
      const moon = moonDirectionFor(el, AZ);
      let peak = 0;
      for (const [azO, elO] of offs) {
        const dir = sunDirectionFromAzEl(moon.az + azO, moon.el + elO);
        const bg = lum(skyColorJs(dir, sun, state, SUN_DIRECTION, REF_P, true));
        peak = Math.max(peak, bg + moonLum * state.nightWeight);
      }
      peaks[el.toFixed(2)] = Number(peak.toFixed(4));
      expect(peak).toBeLessThan(0.82);
    }
    // eslint-disable-next-line no-console
    console.log('[bloom-budget] combined moon+background peaks:', JSON.stringify(peaks));
  });
});
