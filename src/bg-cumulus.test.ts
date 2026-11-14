import { describe, expect, it } from 'vitest';

import {
  BG_BAKE_SIZE_DEFAULT,
  BG_HAZE_METRES,
  FACES_BAKED,
  MAX_STRIPS_PER_FRAME,
  STEPS,
  STRIPS_PER_FACE,
  TOTAL_STRIPS,
  bakeBudget,
  initBgCumulus,
  type LightState,
} from './bg-cumulus';

const st = (azDeg: number, elDeg: number, paletteVersion = 0): LightState => ({ azDeg, elDeg, paletteVersion });

describe('bg-cumulus bakeBudget（限速条带调度，计划 §裁定 6）', () => {
  it('全静止 → 0 条带（停烘）', () => {
    const bb = bakeBudget(st(10, 20, 3), st(10, 20, 3), 0);
    expect(bb.strips).toBe(0);
    expect(bb.staleStrips).toBe(0);
  });

  it('0.033°/帧 慢转 → 1 条带', () => {
    const bb = bakeBudget(st(0, 20, 0), st(0.033, 20, 0), 0);
    expect(bb.strips).toBe(1);
  });

  it('4° 跳变 → 8 条带（硬顶）', () => {
    const bb = bakeBudget(st(0, 20, 0), st(4, 20, 0), 0);
    expect(bb.strips).toBe(8);
  });

  it('90° 跳变也是 8（单帧硬顶不可破）', () => {
    const bb = bakeBudget(st(0, 20, 0), st(90, 20, 0), 0);
    expect(bb.strips).toBe(8);
    expect(bb.strips).toBeLessThanOrEqual(MAX_STRIPS_PER_FRAME);
  });

  it('跳变后靠 stale 追平：40 条带 ≤ 8 帧收敛', () => {
    let prev = st(0, 20, 0);
    const next = st(12, 20, 0);
    let stale = 0;
    let frames = 0;
    let baked = 0;
    for (; frames < 16; frames += 1) {
      const bb = bakeBudget(prev, next, stale);
      baked += bb.strips;
      stale = bb.staleStrips;
      prev = next;
      if (stale === 0) break;
    }
    expect(baked).toBeGreaterThanOrEqual(TOTAL_STRIPS);
    expect(frames).toBeLessThanOrEqual(8);
  });

  it('paletteVersion 变化单独触发 ≥ 1 条带', () => {
    const bb = bakeBudget(st(10, 20, 3), st(10, 20, 4), 0);
    expect(bb.strips).toBeGreaterThanOrEqual(1);
  });

  it('stale 追平期间太阳静止也继续烘到 0', () => {
    const bb1 = bakeBudget(st(0, 20, 0), st(10, 20, 0), 0); // 跳变帧
    expect(bb1.staleStrips).toBe(TOTAL_STRIPS - 8);
    const bb2 = bakeBudget(st(10, 20, 0), st(10, 20, 0), bb1.staleStrips); // 静止但未追平
    expect(bb2.strips).toBe(8);
    const bb3 = bakeBudget(st(10, 20, 0), st(10, 20, 0), 0); // 静止且已追平
    expect(bb3.strips).toBe(0);
  });
});

describe('bg-cumulus 模块钉（计划 Global Constraints + §裁定 4/6）', () => {
  it('常量钉：64 步 / 霾长 12000 / 条带 8×5=40 / 默认烘焙 1024', () => {
    expect(STEPS).toBe(64);
    expect(BG_HAZE_METRES).toBe(12000);
    expect(STRIPS_PER_FACE).toBe(8);
    expect(FACES_BAKED).toBe(5);
    expect(TOTAL_STRIPS).toBe(40);
    expect(MAX_STRIPS_PER_FRAME).toBe(8);
    expect(BG_BAKE_SIZE_DEFAULT).toBe(1024);
  });

  it('module-graph：src 根文件禁止静态 import three/webgpu|three/tsl', async () => {
    const src = await import('./bg-cumulus?raw');
    expect(src.default).not.toMatch(/^\s*import\s+(?!type\b)[^;]*from\s+['"]three\/(webgpu|tsl)['"]/m);
    expect(src.default).toMatch(/await import\(['"]three\/webgpu['"]\)/);
    expect(src.default).toMatch(/await import\(['"]three\/tsl['"]\)/);
  });

  it('参考尺度字面量禁入（520/14500/56000/46000 是参考仓云场的遗产）', async () => {
    const raw = (await import('./bg-cumulus?raw')).default as string;
    // 剥注释后匹配——钉的是代码里的字面量，不是文档提及
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/\b520\b/);
    expect(code).not.toMatch(/\b14500\b/);
    expect(code).not.toMatch(/\b56000\b/);
    expect(code).not.toMatch(/\b46000\b/);
    // slab 起点必须由 layoutWindow 派生
    expect(code).toMatch(/minBase/);
  });

  it('initBgCumulus 存在且为异步工厂（动态导入在函数体内）', () => {
    expect(typeof initBgCumulus).toBe('function');
    expect(initBgCumulus.constructor.name).toBe('AsyncFunction');
  });
});
