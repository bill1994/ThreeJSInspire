import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import {
  energyRatioJs,
  preethamRadianceJs,
  preethamRadianceTsl,
} from './sky-preetham';
import { REFERENCE_ELEVATION_DEG, skyTrackAt, type Vec3 } from './sky-track';
import { SUN_DIRECTION, SUN_POSITION } from './palettes';
import { sunDirectionFromAzEl } from './horizon';

/** 默认太阳方位角（度）——由 SUN_POSITION 算出，不写字面量（计划 Task 4 同口径）。 */
const DEFAULT_AZ = (Math.atan2(SUN_POSITION[0], -SUN_POSITION[2]) * 180) / Math.PI;
const REF_P = skyTrackAt(REFERENCE_ELEVATION_DEG).preetham;

const lum = (v: Vec3): number => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];

/** 该仰角档的 Preetham 求值：太阳与参数同档（轨道口径）。 */
const radianceAt = (elDeg: number, dir: Vec3): Vec3 =>
  preethamRadianceJs(dir, sunDirectionFromAzEl(DEFAULT_AZ, elDeg), skyTrackAt(elDeg).preetham);

describe('energyRatioJs — 参考档恒等', () => {
  const dirs: Vec3[] = [];
  for (const az of [-90, -45, 0, 45, 90]) {
    for (const el of [-30, 0, 30, 60, 90]) {
      dirs.push(sunDirectionFromAzEl(az, el));
    }
  }

  it('sun === refSun 且 p === refP 时逐通道 === 1（25 个方向：地平线向阳/背阳、天顶、±30°/60° 仰角）', () => {
    expect(dirs.length).toBeGreaterThanOrEqual(20);
    for (const dir of dirs) {
      const r = energyRatioJs(dir, SUN_DIRECTION, REF_P, SUN_DIRECTION, REF_P);
      expect(r[0]).toBe(1);
      expect(r[1]).toBe(1);
      expect(r[2]).toBe(1);
    }
  });
});

describe('energyRatioJs — 过渡档有限性与值域', () => {
  it('仰角从参考档扫到 -8°、方位 ±90°：所有采样点无 NaN/Inf 且比值在 [0,2]', () => {
    for (const el of [REFERENCE_ELEVATION_DEG, 4, 2, 0, -2, -4, -6, -8]) {
      const sun = sunDirectionFromAzEl(DEFAULT_AZ, el);
      const p = skyTrackAt(el).preetham;
      for (const az of [-90, -45, 0, 45, 90]) {
        for (const dirEl of [0, 15, 30]) {
          const dir = sunDirectionFromAzEl(az, dirEl);
          const r = energyRatioJs(dir, sun, p, SUN_DIRECTION, REF_P);
          for (const c of r) {
            expect(Number.isFinite(c)).toBe(true);
            expect(c).toBeGreaterThanOrEqual(0);
            expect(c).toBeLessThanOrEqual(2);
          }
        }
      }
    }
  });
});

describe('preethamRadianceJs — 关键方向的粗粒度单调', () => {
  const horizonSunward = sunDirectionFromAzEl(DEFAULT_AZ, 0);
  const zenith: Vec3 = [0, 1, 0];

  it('地平线向阳亮度：参考档 > -4° 档 > -8° 档', () => {
    const ref = lum(radianceAt(REFERENCE_ELEVATION_DEG, horizonSunward));
    const m4 = lum(radianceAt(-4, horizonSunward));
    const m8 = lum(radianceAt(-8, horizonSunward));
    expect(ref).toBeGreaterThan(m4);
    expect(m4).toBeGreaterThan(m8);
  });

  it('天顶方向亮度：参考档 > -4° 档 > -8° 档', () => {
    const ref = lum(radianceAt(REFERENCE_ELEVATION_DEG, zenith));
    const m4 = lum(radianceAt(-4, zenith));
    const m8 = lum(radianceAt(-8, zenith));
    expect(ref).toBeGreaterThan(m4);
    expect(m4).toBeGreaterThan(m8);
  });

  it('0° 档实测值记录（物理回弹允许，不设断言——数值进计划进度段）', () => {
    const horizon = radianceAt(0, horizonSunward);
    const zen = radianceAt(0, zenith);
    // eslint-disable-next-line no-console
    console.log(
      `[sky-preetham] 0 deg key: horizon lum=${lum(horizon).toExponential(4)} rgb=[${horizon.map((c) => c.toExponential(3)).join(', ')}]; ` +
        `zenith lum=${lum(zen).toExponential(4)}; ` +
        `m4 horizon lum=${lum(radianceAt(-4, horizonSunward)).toExponential(4)}; m8 horizon lum=${lum(radianceAt(-8, horizonSunward)).toExponential(4)}`,
    );
    expect(Number.isFinite(lum(horizon))).toBe(true);
    expect(Number.isFinite(lum(zen))).toBe(true);
  });
});

describe('preethamRadianceTsl — 真 three/tsl 冒烟', () => {
  it('真 three/tsl 调用不抛异常且返回对象', async () => {
    const tsl = await import('three/tsl');
    const dirNode = tsl.vec3(0.1, 0.35, -0.9);
    const sunNode = tsl.uniform(new THREE.Vector3(SUN_DIRECTION[0], SUN_DIRECTION[1], SUN_DIRECTION[2]));
    const paramsU = {
      turbidity: tsl.uniform(2),
      rayleigh: tsl.uniform(1),
      mieCoefficient: tsl.uniform(0.005),
      mieDirectionalG: tsl.uniform(0.8),
    };
    const node = preethamRadianceTsl(tsl, dirNode, sunNode, paramsU);
    expect(node).toBeTruthy();
    expect(typeof node).toBe('object');
  });
});

// ---- I-SKY-1 / I-SKY-2 / I-SEA-1 源码 pin ----

const skyPreethamSrc = await import.meta.glob('./sky-preetham.ts', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;
const skyWebgpuSrc = await import.meta.glob('./sky-webgpu.ts', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;
const seaMaterialSrc = await import.meta.glob('./sea/material.ts', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

describe('I-SKY-1 · TSL 天顶角上钳对齐 JS', () => {
  it('TSL 侧 zenithAngle = acos(clamp(direction.y, 0.0, 1.0))，不再是 acos(max(0.0, y))', () => {
    const src = skyPreethamSrc['./sky-preetham.ts'];
    expect(src).toMatch(/acos\(clamp\(direction\.y,\s*0\.0,\s*1\.0\)\)/);
    expect(src).not.toMatch(/acos\(max\(0\.0,\s*direction\.y\)\)/);
  });
  it('JS 侧 acos(min(max(dy,0),1)) 已经有上钳（不变）', () => {
    const src = skyPreethamSrc['./sky-preetham.ts'];
    expect(src).toMatch(/Math\.acos\(Math\.min\(Math\.max\(dy,\s*0\),\s*1\)\)/);
  });
});

describe('I-SKY-2 · 能量比率 den 极小值守卫对齐 energyRatioJs', () => {
  it('skyColorTsl 里 den.max(1e-12) 后再除，不再是裸 num.div(den)', () => {
    const src = skyWebgpuSrc['./sky-webgpu.ts'];
    expect(src).toMatch(/clamp\(num\.div\(den\.max\(1e-12\)\),\s*0\.0,\s*2\.0\)/);
    expect(src).not.toMatch(/clamp\(num\.div\(den\),\s*0\.0,\s*2\.0\)/);
  });
});

describe('I-SEA-1 · chopOverride 互斥标志', () => {
  it('initSea 闭包内有 chopOverride 标志（null 表示无覆盖）', () => {
    const src = seaMaterialSrc['./sea/material.ts'];
    expect(src).toMatch(/let chopOverride:\s*boolean\s*\|\s*null\s*=\s*null/);
  });
  it('setQuality 检查 chopOverride：非 null 时 gate 取 override 值而非 (high?1:0)', () => {
    const src = seaMaterialSrc['./sea/material.ts'];
    expect(src).toMatch(/const gate = chopOverride !== null \? chopOverride : \(high \? 1 : 0\)/);
  });
  it('setChopGate 设置 chopOverride 并 warn 冲突', () => {
    const src = seaMaterialSrc['./sea/material.ts'];
    expect(src).toMatch(/chopOverride = on/);
    expect(src).toMatch(/setChopGate\(\$\{on\}\) conflicts with quality/);
  });
  it('SeaOcean 接口暴露 clearChopGate()', () => {
    const src = seaMaterialSrc['./sea/material.ts'];
    expect(src).toMatch(/clearChopGate\(\): void/);
  });
  it('clearChopGate 置 chopOverride=null 并立即同步 c1Gate 为当前档隐含值', () => {
    const src = seaMaterialSrc['./sea/material.ts'];
    expect(src).toMatch(/clearChopGate\(\): void/);
    expect(src).toMatch(/chopOverride = null/);
    expect(src).toMatch(/const gate = highQuality \? 1 : 0/);
  });
  it('clearChopGate 实现内无 warn 调用（解除动作本身不打 warn）', () => {
    const src = seaMaterialSrc['./sea/material.ts'];
    // 找实现而非接口声明：冒号后有 `{`
    const implMatch = src.indexOf('clearChopGate(): void {');
    expect(implMatch).toBeGreaterThan(-1);
    const endIdx = src.indexOf('setDebug(on: boolean): void {', implMatch);
    const block = src.slice(implMatch, endIdx);
    expect(block).not.toMatch(/console\.warn/);
  });
});
