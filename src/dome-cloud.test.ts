import { describe, expect, it } from 'vitest';

import { boxScale, qualityParams } from './dome-cloud';
import { DOME_SLAB } from './dome-cloud-field';

// 与 module-graph.test.ts 同款：用 vite 的 ?raw glob 读源码（项目未装 @types/node，
// 不能 import node:fs）。
const sources = import.meta.glob('./*.ts', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;
const src = sources['./dome-cloud.ts'] as string;
const noiseSrc = sources['./dome-cloud-noise.ts'] as string;

describe('qualityParams', () => {
  it('pins the spec step budgets', () => {
    expect(qualityParams(true)).toEqual({ steps: 28, octaves: 2 });
    expect(qualityParams(false)).toEqual({ steps: 16, octaves: 1 });
  });

  it('never changes the volume resolution — setQuality must not rebake', () => {
    expect(Object.keys(qualityParams(true))).toEqual(Object.keys(qualityParams(false)));
  });
});

describe('setQuality', () => {
  it('writes both uSteps and uOctaves (P1 §11.5 leak)', () => {
    const anchor = src.indexOf('const setQuality'); // 箭头函数，无 function 关键字
    expect(anchor).toBeGreaterThan(-1); // 防呆：源文件还在、锚点还能找到
    // 从 anchor 往后找函数体结束位置（箭头函数的 `};` 在 setQuality 末尾，实测 L345-L349）
    const endMarker = src.indexOf('\n  };', anchor);
    const body = src.slice(anchor, endMarker);
    expect(body).toMatch(/uSteps\.value/);
    expect(body).toMatch(/uOctaves\.value/);
    // 断言 uSteps 出现在 uOctaves 之前（都在 setQuality 体内，不跨到 update()）
    expect(body.indexOf('uSteps.value')).toBeLessThan(body.indexOf('uOctaves.value'));
  });
});

describe('P1.5 shape knobs', () => {
  it('pins the P1.5 shape knobs (calibrated, see review)', () => {
    // 测试即定值：抓帧标定后若数值变动，同步改这里与 densityAt 的注释，
    // 改钉死数值需在提交信息注明原因——门柱只能由抓帧数据搬。
    // 起点 smoothstep(0.34,0.42)/0.22 → 标定 0.32,0.40/0.18（Task 3：天空洞更多、瓣更分明）。
    expect(src).toMatch(/smoothstep\(0\.32,\s*0\.40,\s*weather\)/);
    expect(src).toMatch(/\.mul\(0\.18\)/);
  });

  it('pins the P1.5 Worley carve (design §5.1 decision tree, calibrated)', () => {
    // 12 细胞必须整除 96³ 的生成尺寸（回绕无缝）；权重 0.35 起步、抓帧标定后 0.42。
    expect(noiseSrc).toMatch(/const WORLEY_CELLS = 12;/);
    expect(noiseSrc).toMatch(/const WORLEY_CARVE = 0\.42;/);
    expect(96 % 12).toBe(0);
  });
});

describe('P1.5 light march (shader structure)', () => {
  it('marches three sun taps gated by density (high only)', () => {
    expect(src).toMatch(/LIGHT_MARCH_DELTA_METRES\s*=\s*40/); // Δ 具名常量
    expect(src).toMatch(/0\.12/); // 密度门
    expect(src).toMatch(/uOctaves\.lessThan\(1\.5\)/); // low 档走单探针的分支判据
    expect(src).toMatch(/LIGHT_PROBE_METRES/); // low 档保留单次探针
    // 三 tap 用显式展开（断言跟随实现形态）：既有 2 处调用（ray 步 + low 探针）
    // + 3 处 march tap = 至少 5 处 densityAt(。
    expect((src.match(/densityAt\(/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });
});

describe('P1.5 vertical profile modulation', () => {
  it('modulates the vertical profile for 2-3 density peaks', () => {
    // sin 必须在 three/tsl 解构里，否则 ReferenceError（TSL Fn 体懒编译，vitest 抓不到）。
    expect(src).toMatch(/0\.72/);
    expect(src).toMatch(/^\s+sin,$/m);
    expect(src).toMatch(/ceiling\s*=\s*smoothstep\(/); // ceiling 是内联定义，不是外部函数
    expect(src).toMatch(/const yn = y\.sub\(DOME_SLAB\.base\)\.div\(SLAB_HEIGHT\)/); // sin 吃归一化 y
    expect(src).toMatch(/sin\(yn\.mul\(3\)/); // 量纲写死（复审 S3）：米 y 不能直接进 sin
    // 调制乘在 body 之后、erosion 之前（brief 指定的落点）
    expect(src).toMatch(/body\.mul\(profile\)/);
  });

  it('keeps the amplitude in the calibrated window and the phase off the puff seed', () => {
    // 幅度标定窗口（设计）：0.20–0.32；频率钉死为 3（上一条用例的 sin(yn.mul(3)）。
    const amp = src.match(/PROFILE_AMPLITUDE\s*=\s*([\d.]+)/);
    expect(amp).not.toBeNull();
    expect(Number(amp?.[1])).toBeGreaterThanOrEqual(0.2);
    expect(Number(amp?.[1])).toBeLessThanOrEqual(0.32);
    // φ 与 puff cloud 的散布 seed（7，src/puff-cloud.ts）不同源，避免同相位条纹。
    const phase = src.match(/PROFILE_PHASE\s*=\s*([\d.]+)/);
    expect(phase).not.toBeNull();
    expect(Number(phase?.[1])).not.toBe(7);
  });
});

describe('boxScale', () => {
  it('is derived only from DOME_SLAB', () => {
    // 不得从窗口/fov 推导，否则窄窗口会溢出。
    const s = boxScale();
    expect(s.x).toBe(DOME_SLAB.halfExtent * 2);
    expect(s.z).toBe(DOME_SLAB.halfExtent * 2);
    expect(s.y).toBe(DOME_SLAB.top - DOME_SLAB.base);
  });

  it('takes no arguments, so nothing about the viewport can leak in', () => {
    expect(boxScale.length).toBe(0);
  });
});
