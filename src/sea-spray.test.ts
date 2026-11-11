/**
 * src/sea-spray.test.ts — P1-1 海粒子 4 层 + 击水声（设计 §Q4）。
 *
 * L1 泡沫尾迹已有（P0-2 脉动）。本文件 pin 新增三层：
 * L2 spray（400 点池，60/s，0.7s）、L3 mist（8 软 sprite，1.2s 轮替）、
 * L4 第二环（延迟 0.15s）+ 翼尖涡环（bank>0.5）+ 击水声纯函数。
 * 全部 headless：seeded PRNG 保证确定性。
 */
import * as THREE from 'three';
import { describe, it, expect } from 'vitest';
import {
  initFeel,
  SPRAY_COUNT,
  SPRAY_BURST,
  SPRAY_LIFE,
  SPRAY_UP_MIN,
  SPRAY_UP_MAX,
  SPRAY_BACK,
  MIST_COUNT,
  MIST_LIFE,
  MIST_ALPHA,
  MIST_SIZE_MIN,
  MIST_SIZE_MAX,
  RING2_DELAY,
  RING2_GROWTH,
  RING2_ALPHA,
  TIP_BANK,
} from './feel';
import { splashGain01 } from './audio';
import { sprayBackwash, waterLevel01 } from './game';

const DT = 1 / 60;
const TIPS = { leftTip: { x: -4, y: 7, z: 0 }, rightTip: { x: 4, y: 7, z: 0 } };
const CALM_BACKWASH = { x: 0, z: 0 };

function run(feel: ReturnType<typeof initFeel>, n: number, skim: number, bank = 0): void {
  for (let i = 0; i < n; i += 1) {
    feel.update(DT, { speed01: 0.5, bank, stall01: 0, skim01: skim, backwash: CALM_BACKWASH, ...TIPS });
  }
}

function aliveSpray(scene: THREE.Scene): number {
  const pts = scene.getObjectByName('porco_spray') as THREE.Points;
  const attr = pts.geometry.getAttribute('position') as THREE.BufferAttribute;
  let alive = 0;
  for (let i = 0; i < SPRAY_COUNT; i += 1) {
    if (attr.getY(i) > -25) alive += 1;
  }
  return alive;
}

function mistOpacities(scene: THREE.Scene): number[] {
  const out: number[] = [];
  for (let i = 0; i < MIST_COUNT; i += 1) {
    const s = scene.getObjectByName(`porco_mist_${i}`) as THREE.Sprite;
    out.push((s.material as THREE.SpriteMaterial).opacity);
  }
  return out;
}

describe('P1-1 粒子常量（设计 §Q4 量级表）', () => {
  it('pins the spray / mist / ring anchors', () => {
    expect(SPRAY_COUNT).toBe(400);
    expect(SPRAY_BURST).toBe(60);
    expect(SPRAY_LIFE).toBe(0.7);
    expect(SPRAY_UP_MIN).toBe(3);
    expect(SPRAY_UP_MAX).toBe(7);
    expect(SPRAY_BACK).toBe(5);
    expect(MIST_COUNT).toBe(8);
    expect(MIST_LIFE).toBe(1.2);
    expect(MIST_ALPHA).toBe(0.18);
    expect(MIST_SIZE_MIN).toBe(2);
    expect(MIST_SIZE_MAX).toBe(6);
    expect(RING2_DELAY).toBe(0.15);
    expect(RING2_GROWTH).toBe(1.6);
    expect(RING2_ALPHA).toBe(0.5);
    expect(TIP_BANK).toBe(0.5);
  });
});

describe('P1-1 L2 spray（60/s，活 0.7s）', () => {
  it('emits while skimming and settles at burst*life alive', () => {
    const scene = new THREE.Scene();
    const feel = initFeel(scene);
    run(feel, 60, 0.8);
    const alive = aliveSpray(scene);
    expect(alive).toBeGreaterThan(25);
    expect(alive).toBeLessThanOrEqual(60);
    const pts = scene.getObjectByName('porco_spray') as THREE.Points;
    const attr = pts.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < SPRAY_COUNT; i += 1) {
      expect(Number.isFinite(attr.getX(i))).toBe(true);
    }
    feel.dispose();
  });

  it('stops emitting on calm water and drains within a life', () => {
    const scene = new THREE.Scene();
    const feel = initFeel(scene);
    run(feel, 60, 0.8);
    expect(aliveSpray(scene)).toBeGreaterThan(0);
    run(feel, 60, 0);
    expect(aliveSpray(scene)).toBe(0);
    feel.dispose();
  });

  it('carries the slipstream backward (backwash drifts the plume)', () => {
    const mk = (): { scene: THREE.Scene; feel: ReturnType<typeof initFeel> } => {
      const scene = new THREE.Scene();
      return { scene, feel: initFeel(scene) };
    };
    const a = mk();
    const b = mk();
    for (let i = 0; i < 60; i += 1) {
      a.feel.update(DT, { speed01: 0.5, bank: 0, stall01: 0, skim01: 0.8, backwash: { x: 0, z: 0 }, ...TIPS });
      b.feel.update(DT, { speed01: 0.5, bank: 0, stall01: 0, skim01: 0.8, backwash: { x: 5, z: 0 }, ...TIPS });
    }
    const meanX = (scene: THREE.Scene): number => {
      const pts = scene.getObjectByName('porco_spray') as THREE.Points;
      const attr = pts.geometry.getAttribute('position') as THREE.BufferAttribute;
      let sum = 0;
      let n = 0;
      for (let i = 0; i < SPRAY_COUNT; i += 1) {
        if (attr.getY(i) > -25) {
          sum += attr.getX(i);
          n += 1;
        }
      }
      return n > 0 ? sum / n : 0;
    };
    // Same seed, same ages — the +5 m/s backwash must show up downstream.
    expect(meanX(b.scene) - meanX(a.scene)).toBeGreaterThan(1);
    a.feel.dispose();
    b.feel.dispose();
  });
});

describe('P1-1 L3 mist（8 sprite，1.2s 轮替）', () => {
  it('breathes while skimming and vanishes on calm water', () => {
    const scene = new THREE.Scene();
    const feel = initFeel(scene);
    run(feel, 40, 1);
    const on = mistOpacities(scene);
    expect(Math.max(...on)).toBeGreaterThan(0.05);
    for (const s of [1, 2, 3, 4, 5, 6, 7, 0]) {
      const sp = scene.getObjectByName(`porco_mist_${s}`) as THREE.Sprite;
      const sc = sp.scale.x;
      expect(sc).toBeGreaterThanOrEqual(MIST_SIZE_MIN - 0.01);
      expect(sc).toBeLessThanOrEqual(MIST_SIZE_MAX + 0.01);
    }
    run(feel, 90, 0);
    expect(Math.max(...mistOpacities(scene))).toBe(0);
    feel.dispose();
  });
});

describe('P1-1 L4 第二环 + 翼尖涡环', () => {
  it('fires the second ring 0.15s after the first, then both die', () => {
    const scene = new THREE.Scene();
    const feel = initFeel(scene);
    const c1 = scene.getObjectByName('porco_skim_ring') as THREE.Mesh;
    const c2 = scene.getObjectByName('porco_skim_ring2') as THREE.Mesh;
    run(feel, 1, 0);
    run(feel, 1, 0.8);
    expect(c1.visible).toBe(true);
    expect(c2.visible).toBe(false); // delay not yet spent
    run(feel, 12, 0.8); // 0.2 s > 0.15 s delay
    expect(c2.visible).toBe(true);
    run(feel, 60, 0.8);
    expect(c1.visible).toBe(false);
    expect(c2.visible).toBe(false);
    feel.dispose();
  });

  it('throws wingtip rings on the bank edge while skimming', () => {
    const scene = new THREE.Scene();
    const feel = initFeel(scene);
    const tl = scene.getObjectByName('porco_skim_ringL') as THREE.Mesh;
    const tr = scene.getObjectByName('porco_skim_ringR') as THREE.Mesh;
    run(feel, 10, 0.8, 0);
    expect(tl.visible).toBe(false);
    run(feel, 1, 0.8, 0.6);
    expect(tl.visible).toBe(true);
    expect(tr.visible).toBe(true);
    feel.dispose();
  });
});

describe('P1-1 帧接线纯函数（game.ts 喂给 feel/audio 的那两行）', () => {
  it('pushes the spray backward along the nose frame', () => {
    expect(sprayBackwash(-1, 0)).toEqual({ x: 5, z: 0 });
    expect(sprayBackwash(0, -1)).toEqual({ x: 0, z: 5 });
    expect(sprayBackwash(Number.NaN, 1)).toEqual({ x: 0, z: -5 });
  });

  it('opens the water voice past the 0.5 skim gate only', () => {
    expect(waterLevel01(0.4, 1)).toBe(0);
    expect(waterLevel01(0.5, 1)).toBe(0);
    expect(waterLevel01(0.8, 0.5)).toBeCloseTo(0.4, 9);
    expect(waterLevel01(Number.NaN, 1)).toBe(0);
  });
});

describe('P1-1 低档裁剪 + 击水声', () => {
  it('hides L2/L3 on low quality and restores on high', () => {
    const scene = new THREE.Scene();
    const feel = initFeel(scene);
    run(feel, 30, 0.8);
    expect(aliveSpray(scene)).toBeGreaterThan(0);
    feel.setQuality(false);
    feel.update(DT, { speed01: 0.5, bank: 0, stall01: 0, skim01: 0.8, backwash: CALM_BACKWASH, ...TIPS });
    const pts = scene.getObjectByName('porco_spray') as THREE.Points;
    expect(pts.visible).toBe(false);
    feel.setQuality(true);
    feel.update(DT, { speed01: 0.5, bank: 0, stall01: 0, skim01: 0.8, backwash: CALM_BACKWASH, ...TIPS });
    expect(pts.visible).toBe(true);
    feel.dispose();
  });

  it('maps the water level to a loop gain (pure, tested without a context)', () => {
    expect(splashGain01(0)).toBe(0);
    expect(splashGain01(1)).toBe(0.25);
    expect(splashGain01(0.5)).toBeCloseTo(0.125, 6);
    expect(splashGain01(Number.NaN)).toBe(0);
  });
});
