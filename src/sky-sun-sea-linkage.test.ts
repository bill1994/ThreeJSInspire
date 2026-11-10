/**
 * Sky / sun / sea linkage regression (2026-11-08 review).
 *
 * The GPU graphs cannot run in node, so this file pins the linkage in two ways:
 *
 *  1. ALGEBRA — the JS mirrors of the TSL terms (`horizonGlow`, `antiSolarCool`,
 *     `roadMask` / `azimuthDiff`, `reflect(sun, N)`) are evaluated off ONE
 *     `SunState.direction`. Rotating the sun must move BOTH the sky's glow and
 *     the sea's sun road. This is the exact failure the review reported: the sky
 *     moved, the water's reflection did not.
 *  2. WIRING — source tripwires for the two things that actually caused it:
 *     the dome must shade with the camera-relative view ray (not world
 *     position, which drifts because the shell is towed), and main must push
 *     the live sun into sky, lights and sea.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { createSunState } from './sun-state';
import { antiSolarCool, horizonGlow } from './horizon';
import { azimuthDiff, roadMask } from './sea/sun-road';

const rootSources = import.meta.glob('./*.ts', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;
const seaSources = import.meta.glob('./sea/*.ts', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/** Horizontal-plane cosine between the sun and a fixed viewing bearing. */
function cosAz(sun: THREE.Vector3, viewX: number, viewZ: number): number {
  const la = Math.hypot(sun.x, sun.z);
  const lb = Math.hypot(viewX, viewZ);
  return (sun.x * viewX + sun.z * viewZ) / (la * lb);
}

/** The sea's specular direction: reflect(sunU, N) with a flat water normal. */
function mirrorOf(sun: THREE.Vector3): THREE.Vector3 {
  return sun.clone().reflect(new THREE.Vector3(0, 1, 0));
}

describe('one sun drives sky AND sea', () => {
  it('rotating the sun moves the sky glow, the away-cool and the sea sun road together', () => {
    const sun = createSunState();
    sun.setAzEl(0, 8);
    const viewX = 0;
    const viewZ = -1;
    // A view ray straight at the original sun, elevation 8 degrees.
    const eye = new THREE.Vector3(0, Math.sin((8 * Math.PI) / 180), -Math.cos((8 * Math.PI) / 180));

    const skyGlow0 = horizonGlow(sun.direction.dot(eye));
    const cool0 = antiSolarCool(cosAz(sun.direction, viewX, viewZ), 0);
    const road0 = roadMask(azimuthDiff(sun.direction.x, sun.direction.z, viewX, viewZ));
    const glint0 = mirrorOf(sun.direction);
    const v0 = sun.version;

    sun.rotateAzimuth(90);

    const skyGlow1 = horizonGlow(sun.direction.dot(eye));
    const cool1 = antiSolarCool(cosAz(sun.direction, viewX, viewZ), 0);
    const road1 = roadMask(azimuthDiff(sun.direction.x, sun.direction.z, viewX, viewZ));
    const glint1 = mirrorOf(sun.direction);

    expect(sun.version).toBe(v0 + 1);
    // The sky's sunward halo leaves the frame centre.
    expect(skyGlow0).toBeGreaterThan(0.3);
    expect(skyGlow1).toBeLessThan(0.01);
    // The anti-solar horizon cool (shared by dome and sea haze) turns on.
    expect(cool0).toBeCloseTo(0, 6);
    expect(cool1).toBeGreaterThan(0.2);
    // The sea's road gate collapses off the sun's new bearing, and the mirror
    // glint direction really rotates — the reflection cannot stay put.
    expect(road0).toBeCloseTo(1, 6);
    expect(road1).toBeCloseTo(0, 6);
    expect(glint0.distanceTo(glint1)).toBeGreaterThan(0.5);
  });

  it('the sun direction stays unit length through repeated rotations', () => {
    const sun = createSunState();
    for (let i = 0; i < 24; i += 1) sun.rotateAzimuth(15);
    expect(sun.direction.length()).toBeCloseTo(1, 6);
    expect(Number.isFinite(sun.direction.x)).toBe(true);
  });
});

describe('sky dome view-ray basis (root cause)', () => {
  const src = rootSources['./sky-webgpu.ts'];

  it('shades with the camera-relative ray, not towed world position', () => {
    // `positionWorld.normalize()` measures from the WORLD ORIGIN. The shell is
    // towed to camera X/Z every frame, so that direction slides by camX/R and
    // camZ/R — the sun disc drifts while the sea's reflection stays put.
    expect(src).toMatch(/const dir = positionWorld\.sub\(cameraPosition\)\.normalize\(\)/);
    expect(src).not.toMatch(/const dir = positionWorld\.normalize\(\)/);
  });

  it('binds the shared live sun vector, not a compile-time literal or a copy', () => {
    expect(src).toMatch(/uniform\(sunDirection \?\? new THREE\.Vector3\(\.\.\.SUN_DIRECTION\)\)/);
    expect(src).not.toMatch(/uniform\(new THREE\.Vector3\(\.\.\.SUN_DIRECTION\)\)/);
    expect(src).toMatch(/sunDir\.value\.copy\(dir\)\.normalize\(\)/);
  });
});

describe('wiring tripwires', () => {
  const main = rootSources['./main.ts'];
  const world = rootSources['./world.ts'];
  const sea = seaSources['./sea/material.ts'];
  const far = rootSources['./far-field.ts'];

  it('main owns one SunState and pushes it to sky, lights and sea', () => {
    expect(main).toMatch(/const sun = createSunState\(\)/);
    expect(main).toMatch(/initSunsetSkyTSL\(THREE, scene, sun\.direction\)/);
    expect(main).toMatch(/initWorld\(scene, lights\.sun, r, sun\.direction\)/);
    expect(main).toMatch(/lights\.setSunDirection\(sun\.direction\)/);
    expect(main).toMatch(/skyTsl\?\.setSunDirection\(sun\.direction\)/);
    expect(main).toMatch(/world\?\.setSunDirection\(sun\.direction\)/);
    expect(main).toMatch(/syncSun\(\)/);
  });

  it('the sea exposes an explicit setter that updates every ring sun uniform', () => {
    expect(sea).toMatch(/setSunDirection\(dir: THREE\.Vector3\): void/);
    expect(sea).toMatch(/sunU: built\.sunU/);
    expect(sea).toMatch(/bits\.sunU\.value\.copy\(dir\)\.normalize\(\)/);
  });

  it('world forwards the sun to the sea (cloud lighting path untouched)', () => {
    expect(world).toMatch(/sea\?\.setSunDirection\(dir\)/);
    expect(world).toMatch(/setSunDirection\(dir: THREE\.Vector3\): void/);
  });

  it('the sky shell is towed in full 3D so the dome centre sits on the eye', () => {
    expect(far).toMatch(/moveTo\(sky, camX, camZ, eyeY\)/);
    expect(main).toMatch(/farField\.update\(camera\.position\.x, camera\.position\.z, camera\.position\.y\)/);
  });
});

// ---- Minor 5 & Minor 6 pins (2026-11-09 consolidated review) ----------------------

describe('Minor 5 — 纱色端点随 syncSun 更新，启动块已删除', () => {
  const main = rootSources['./main.ts'];

  it('syncSun() 末尾调 setVeilTintEndpoints(state.veilCool, state.veilWarm)', () => {
    // state = skyTrackAt(el) 已在 syncSun 开头计算，veilCool/veilWarm 由
    // sky-track lerp 产出（sky-track.ts:157-158），太阳版本变更触发。
    expect(main).toMatch(/setVeilTintEndpoints\(state\.veilCool,\s*state\.veilWarm\)/);
  });

  it('启动时不再有独立的纱色注入块（原来 .*st0\.veilCool.* 模式不应出现）', () => {
    // 旧代码在 main.ts 启动块里 `const st0 = skyTrackAt(el0); setVeilTintEndpoints(st0.veilCool, st0.veilWarm);`
    // 现在只走 syncSun 一条路径，不再有独立的 st0 临时变量 + el0 启动注入。
    expect(main).not.toMatch(/const st0 = skyTrackAt\(el0\)/);
  });
});

describe('Minor 6 — ref uniforms 移到模块级常量，applySkyTrack 不再每帧重算', () => {
  const src = rootSources['./sky-webgpu.ts'];

  it('模块级有 REF_STATE = skyTrackAt(REFERENCE_ELEVATION_DEG)', () => {
    expect(src).toMatch(/const REF_STATE:\s*SkyTrackState\s*=\s*skyTrackAt\(REFERENCE_ELEVATION_DEG\)/);
  });

  it('buildTrackUniforms 用 REF_STATE 而非在内部重算 skyTrackAt(REFERENCE_ELEVATION_DEG)', () => {
    // 正向 pin：REF_STATE.preetham.* 出现在 buildTrackUniforms 内部
    expect(src).toMatch(/refTurbidity:\s*tsl\.uniform\(REF_STATE\.preetham\.turbidity\)/);
    expect(src).toMatch(/refRayleigh:\s*tsl\.uniform\(REF_STATE\.preetham\.rayleigh\)/);
    // 反向 pin：函数内部不应再有 `const ref = skyTrackAt(REFERENCE_ELEVATION_DEG)`
    // （函数边界用 `function buildTrackUniforms` 锚，避免匹配模块级的 REF_STATE）
    const fnStart = src.indexOf('function buildTrackUniforms');
    const fnEnd = src.indexOf('function applySkyTrack', fnStart);
    const fnBlock = src.slice(fnStart, fnEnd);
    expect(fnBlock).not.toMatch(/skyTrackAt\(REFERENCE_ELEVATION_DEG\)/);
  });

  it('applySkyTrack 内不再出现 skyTrackAt(REFERENCE_ELEVATION_DEG) 或 u.refTurbidity/uvu.refRayleigh 重写', () => {
    const fnStart = src.indexOf('export function applySkyTrack');
    const fnEnd = src.indexOf('/** The four-stop ramp chain', fnStart);
    const fnBlock = src.slice(fnStart, fnEnd);
    expect(fnBlock).not.toMatch(/skyTrackAt\(REFERENCE_ELEVATION_DEG\)/);
    expect(fnBlock).not.toMatch(/u\.refSun/);
    expect(fnBlock).not.toMatch(/u\.refTurbidity/);
    expect(fnBlock).not.toMatch(/u\.refRayleigh/);
    expect(fnBlock).not.toMatch(/u\.refMieCoefficient/);
    expect(fnBlock).not.toMatch(/u\.refMieDirectionalG/);
  });
});
