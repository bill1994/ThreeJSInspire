/**
 * src/flight-p2accept.test.ts — P2 验收（设计 §6 P2 行，headless 切片）。
 *
 * 60s 巡航每 10s 一参照：云门开火节奏 / G 闪边沿+回零 / streak 随速 /
 * 低档一键裁剪（spray+mist+streaks）/ 海面 speed 链透传。主观项
 * （云门侧掠、G 黑边观感）留给浏览器 QA，见 ledger。
 */
import * as THREE from 'three';
import { describe, it, expect } from 'vitest';
import { gateDue, GATE_PERIOD } from './cloud-gates';
import { gFlashTrigger, gFlashDecay, G_FLASH_PEAK } from './game';
import { initFeel, wakeStreak } from './feel';
import { initStreaks, WIND_STREAKS, WIND_STREAKS_LOW } from './wind-streaks';

const DT = 1 / 60;
const TIPS = { leftTip: { x: -4, y: 7, z: 0 }, rightTip: { x: 4, y: 7, z: 0 } };
const sources = import.meta.glob('./{game,world,main,feel}.ts', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

describe('flight P2 accept (spec §6 P2)', () => {
  it('云门 60s 开火 ≥5 次（PERIOD 10s，首帧即开）', () => {
    expect(GATE_PERIOD).toBe(10);
    let last = Number.NaN;
    let fires = 0;
    for (let t = 0; t <= 60; t += 1) {
      if (gateDue(last, t)) {
        fires += 1;
        last = t;
      }
    }
    // t=0 首开 + 10/20/30/40/50/60 = 7 次；留 2 次余量给实现漂移。
    expect(fires).toBeGreaterThanOrEqual(5);
  });

  it('G 闪：大机动改出只开一次火，0.25s 线性回零', () => {
    // 巡航 dive 0.2 → 压杆 0.8（2s）→ 改出 0.5：只在下降沿开火。
    const dives = [0.2, 0.8, 0.8, 0.5, 0.3, 0.2];
    let g = 0;
    let fired = 0;
    let prev = dives[0];
    for (const d of dives.slice(1)) {
      if (gFlashTrigger(prev, d)) {
        g = G_FLASH_PEAK;
        fired += 1;
      }
      prev = d;
    }
    expect(fired).toBe(1);
    expect(g).toBe(0.25);
    for (let i = 0; i < 16; i += 1) g = gFlashDecay(g, DT);
    expect(g).toBe(0);
  });

  it('wake streak 行波 60s 不散：相位速度随速 1x..4x，值域恒 [0.8,1]', () => {
    for (let s = 0; s <= 60; s += 1) {
      for (let i = 0; i < 48; i += 4) {
        const v = wakeStreak(i, s, 0.75);
        expect(v).toBeGreaterThanOrEqual(0.8);
        expect(v).toBeLessThanOrEqual(1.0);
      }
    }
  });

  it('低档一键裁剪：spray 停发排空 + mist 熄灭 + streaks 100/200', () => {
    const scene = new THREE.Scene();
    const feel = initFeel(scene);
    // 先掠海 1s 把池子打满。
    for (let i = 0; i < 60; i += 1) {
      feel.update(DT, { speed01: 0.8, bank: 0, stall01: 0, skim01: 0.8, backwash: { x: 0, z: 0 }, ...TIPS });
    }
    const spray = scene.getObjectByName('porco_spray') as THREE.Points;
    const pos = spray.geometry.getAttribute('position') as THREE.BufferAttribute;
    let alive = 0;
    for (let i = 0; i < 400; i += 1) if (pos.getY(i) > -25) alive += 1;
    expect(alive).toBeGreaterThan(0);
    // 降档：spray 整池隐藏（visible=false，不逐粒排空——弱 GPU 省的是片元），mist 熄灭。
    feel.setQuality(false);
    for (let i = 0; i < 60; i += 1) {
      feel.update(DT, { speed01: 0.8, bank: 0, stall01: 0, skim01: 0.8, backwash: { x: 0, z: 0 }, ...TIPS });
    }
    expect(spray.visible).toBe(false);
    for (let m = 0; m < 8; m += 1) {
      const s = scene.getObjectByName(`porco_mist_${m}`) as THREE.Sprite;
      expect(s.visible).toBe(false);
    }
    const streaks = initStreaks(scene);
    streaks.setQuality(false);
    const pts = scene.getObjectByName('porco_streaks') as THREE.Points;
    expect(pts.geometry.drawRange.count).toBe(WIND_STREAKS_LOW);
    streaks.setQuality(true);
    expect(pts.geometry.drawRange.count).toBe(WIND_STREAKS);
    feel.dispose();
    streaks.dispose();
  });

  it('海面 speed 链透传：game.pose → main → world → sea.update', () => {
    // game.pose 恒带 speed01；main 每帧透传；world 转交 sea.update 第 4 参。
    expect(sources['./game.ts']).toMatch(/speed01: pose\.speed01/);
    expect(sources['./main.ts']).toMatch(/speed01: game\?\.pose\?\.\(\)\.speed01/);
    expect(sources['./world.ts']).toMatch(/sea\.update\(lastView\.camera, lastView\.radPerPixel, time, lastView\.speed01 \?\? 0\)/);
    expect(sources['./feel.ts']).toMatch(/wakeStreak\(i, streak\.t, streak\.speed01\)/);
  });
});
