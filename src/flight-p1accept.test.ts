/**
 * P1 验收（spec §4 P1 行的 headless 切片）：
 * 贴海有水花有声；云里一路颠；设置里可关抖。
 * 主观项（水花好不好看、云里颠得爽不爽）留给浏览器 QA；
 * 这里锁的是跨模块合同：纯函数形状 + 帧接线存在 + 两端数值对得上。
 */
import * as THREE from 'three';
import { describe, it, expect } from 'vitest';
import { waterLevel01 } from './game';
import { splashGain01, propHumHz } from './audio';
import { propOpacity01, propSpinRate } from './plane';
import { DIRECTOR, cloudTraumaTarget } from './director';
import { comfortFromQuery } from './comfort';
import { whiteout01 } from './in-cloud';
import { initFeel } from './feel';

const gameSrc = import.meta.glob('./game.ts', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;
const SRC = () => gameSrc['./game.ts'];

describe('P1 accept: 贴海有水花有声', () => {
  it('水位只在掠海开：skim 0.7 有水、0.3 无水，声增益同形', () => {
    expect(waterLevel01(0.7, 0.5)).toBeGreaterThan(0);
    expect(waterLevel01(0.3, 0.5)).toBe(0);
    expect(splashGain01(waterLevel01(0.7, 0.5))).toBeGreaterThan(0);
    expect(splashGain01(waterLevel01(0.3, 0.5))).toBe(0);
  });

  it('帧接线存在：水位、桨转、桨声三路都进了 game 帧', () => {
    expect(SRC()).toMatch(/audio\.setWaterLevel\(/);
    expect(SRC()).toMatch(/plane\.setProp\(/);
    expect(SRC()).toMatch(/audio\.setPropHum\(/);
    expect(SRC()).toMatch(/sprayBackwash\(/);
  });
});

describe('P1 accept: 桨随油门', () => {
  it('opacity 与转速都从 idle 爬到 full，单调', () => {
    expect(propOpacity01(0)).toBe(0.1);
    expect(propOpacity01(1)).toBe(0.35);
    expect(propOpacity01(0.5)).toBeGreaterThan(0.1);
    expect(propOpacity01(0.5)).toBeLessThan(0.35);
    expect(propSpinRate(0)).toBe(6);
    expect(propSpinRate(1)).toBe(46);
    expect(propSpinRate(0.5)).toBeCloseTo(26, 9);
    expect(propHumHz(0)).toBeLessThan(propHumHz(1));
    expect(propHumHz(0.5)).toBeGreaterThan(propHumHz(0));
  });
});

describe('P1 accept: 云里一路颠（director 目标 == feel 收敛值）', () => {
  it('HIT_CLOUD 已下调，进云目标 0.40，且 feel 2s 真能 track 到', () => {
    expect(DIRECTOR.HIT_CLOUD).toBe(0.6);
    expect(cloudTraumaTarget(1)).toBeCloseTo(0.4, 9);
    const scene = new THREE.Scene();
    const feel = initFeel(scene);
    try {
      const tips = { leftTip: { x: -4, y: 7, z: 0 }, rightTip: { x: 4, y: 7, z: 0 } };
      for (let i = 0; i < 120; i += 1) {
        feel.update(1 / 60, { speed01: 0.5, bank: 0, stall01: 0, skim01: 0, cloud01: 1, ...tips });
      }
      // 两端对上：director 说 0.40，feel 2s 后真站到 0.40 附近。
      expect(feel.trauma01()).toBeGreaterThan(0.3);
      expect(feel.trauma01()).toBeLessThan(0.5);
    } finally {
      feel.dispose();
    }
  });
});

describe('P1 accept: 设置里可关抖（query → shake + whiteout 端到端）', () => {
  it('?shake=reduced&flash=reduced 同时压住抖与纱', () => {
    const c = comfortFromQuery('?shake=reduced&flash=reduced');
    expect(c.shakeScale).toBe(0.4);
    expect(c.whiteoutMax).toBe(0.25);
    // 白纱端：同样的云，reduced 档就是比基线薄。
    expect(whiteout01(1, c.whiteoutMax)).toBeLessThan(whiteout01(1));
    // 抖动端：同样的 trauma，reduced 档送进相机的只有四成。
    const mk = (): { feel: ReturnType<typeof initFeel> } => {
      const scene = new THREE.Scene();
      return { feel: initFeel(scene) };
    };
    const a = mk();
    const b = mk();
    b.feel.setShakeScale(c.shakeScale);
    const tips = { leftTip: { x: -4, y: 7, z: 0 }, rightTip: { x: 4, y: 7, z: 0 } };
    for (let i = 0; i < 10; i += 1) {
      a.feel.addTrauma(0.1);
      b.feel.addTrauma(0.1);
      const ctx = { speed01: 0.5, bank: 0.3, stall01: 0.2, skim01: 0.6, ...tips };
      a.feel.update(1 / 60, ctx);
      b.feel.update(1 / 60, ctx);
    }
    expect(Math.hypot(b.feel.shake.x, b.feel.shake.y, b.feel.shake.z)).toBeCloseTo(
      Math.hypot(a.feel.shake.x, a.feel.shake.y, a.feel.shake.z) * 0.4,
      9,
    );
    a.feel.dispose();
    b.feel.dispose();
  });
});
