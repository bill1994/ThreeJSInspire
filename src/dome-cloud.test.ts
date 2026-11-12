import { describe, expect, it } from 'vitest';

import { boxScale, FLAT_BAND_THRESHOLDS, qualityParams } from './dome-cloud';
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
  it('density must not depend on the quality tier (Task 9 low-tier fix)', () => {
    // 低档穹顶云消失的根因：erosion 吃了 octave 混合后的 detail，
    // uOctaves=1 时 detail=detailBase、侵蚀系统性偏强，薄云整层被抹掉
    // （accept 矩阵：low on/off coverage 0.117%、天空行 mean 0.1）。
    // 密度只许走 tier 无关的 blended；light-march 单路径，不分档
    // （uOctaves 仅保留步数/采样预算记录，setQuality 照写）。
    expect(src).not.toMatch(/uOctaves\.sub\(1\)/);
    expect(src).not.toMatch(/uOctaves\.lessThan/); // single path, no tier fork
  });

  it('marches one density-gated light path for both tiers (Task 9 low-tier fix)', () => {
    // Single 3-tap path: exactly one density gate, no tier fork.
    expect((src.match(/den\.greaterThan\(0\.12\)/g) ?? []).length).toBe(1);
  });

  it('marches three sun taps gated by density (both tiers share it)', () => {
    expect(src).toMatch(/LIGHT_MARCH_DELTA_METRES\s*=\s*40/); // Δ 具名常量
    expect(src).toMatch(/0\.12/); // 密度门
    expect(src).not.toMatch(/uOctaves\.lessThan/); // Task 9: single 3-tap path, probe branch deleted
    expect(src).not.toMatch(/LIGHT_PROBE_METRES/); // Task 9: probe const deleted with the branch
    // 三 tap 显式展开：ray 步 1 处 + march tap 3 处 = 4 处 densityAt(。
    expect((src.match(/densityAt\(/g) ?? []).length).toBe(4);
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

describe('P2 uLook output branch (soft/flat switchable looks)', () => {
  it('adds a uLook output branch that never touches alpha', () => {
    expect(src).toMatch(/uLook/);
    expect(src).toMatch(/setCloudLook/);
    // world.ts 的 DomeLike 透传也必须存在，否则 main 拿不到句柄（world.ts 必须改）
    const worldSrc = sources['./world.ts'] as string;
    expect(worldSrc).toMatch(/setCloudLook/);
  });

  it('flat cannot reshape the cloud: alpha accumulation ignores uLook', () => {
    const alphaLines = src.split('\n').filter((l) => l.includes('accA'));
    expect(alphaLines.length).toBeGreaterThan(0);
    for (const l of alphaLines) expect(l).not.toMatch(/uLook/);
  });

  it('flat path preserves existing alpha exactly (vec4 colorPart, unchangedAccA)', () => {
    // 输出 vec4 的 alpha 分量必须直接是累积值 accA，不能是 uLook 参与计算的表达式
    const out = src.match(/vec4\([^;]*accA[^;]*\)/g) ?? [];
    expect(out.length).toBeGreaterThan(0);
    for (const v of out) expect(v).not.toMatch(/uLook/);
  });

  it('pins the calibrated flat thresholds and keeps every band >= 0.15 wide', () => {
    // 测试即定值（同 P1.5 形状旋钮口径）：抓帧标定后若数值变动，同步 dome-cloud.ts
    // 的出处注释并在提交信息注明原因——门柱只能由抓帧数据搬。
    // 出处：?pos=0,240,-300 机位三轮加权占比 21.6/17.2/23.6/37.7 →
    // 22.4/19.6/26.1/32.0 → 22.4/18.6/27.4/31.6%（analyze_p15_look.py，
    // 帧 p15-look-flat-*-r2/r3.png）；停轮理由与档宽教义见 dome-cloud.ts 注释。
    expect([...FLAT_BAND_THRESHOLDS]).toEqual([0.28, 0.61, 0.84]);
    // 每档宽度不小于 0.15（puff-cloud PUFF_BAND_THRESHOLDS 同款教义），
    // 否则某档在画面上窄成一条缝、四档读成三档。
    const edges = [0, ...FLAT_BAND_THRESHOLDS, 1];
    for (let i = 1; i < edges.length; i++) {
      expect(edges[i] - edges[i - 1]).toBeGreaterThanOrEqual(0.15);
    }
    // flat 路径必须真的消费这组阈值（step 硬切），不是只挂了个常量。
    expect(src).toMatch(/step\(FLAT_BAND_THRESHOLDS\[/);
  });
});

describe('toon quantized lighting (stepped transmittance)', () => {
  // T3（toon-look Phase 1 Task 3）：三条独立 pin，沿上方 uLook describe 的源码 pin
  // 先例。阶梯 = trans 域六档（TOON_TRANS_STEPS）+ IGN 档间抖动；uToon 从
  // sky-webgpu 的共享组直读（Task 1 单例，不造第二根 uniform）。

  it('pin-A: toon branch touches only color output lines, before the uLook mix', () => {
    const mixOffset = src.indexOf('mix(ambient.add(lit), flatCol, uLook)');
    expect(mixOffset).toBeGreaterThan(-1); // 防呆：uLook mix 行还在
    // 序约束：阶梯定义与阈值使用都必须在 uLook mix 行之前（D3 前提：
    // uLook=1 整取 flatCol 时 toon 自动无影响，靠的就是这条行序）
    const toonOffset = src.indexOf('const transToon =');
    const stepsOffset = src.indexOf('step(TOON_TRANS_STEPS[');
    expect(toonOffset).toBeGreaterThan(-1);
    expect(stepsOffset).toBeGreaterThan(-1);
    expect(toonOffset).toBeLessThan(mixOffset);
    expect(stepsOffset).toBeLessThan(mixOffset);
    // 混入点只能是 lit 行（颜色输出行）：uToon 混合嵌在 uSunColor.mul(...) 里
    const blendLine = src.split('\n').find((l) => l.includes('mix(trans, transToon, uToon)'));
    expect(blendLine).toBeDefined();
    expect(blendLine).toMatch(/uSunColor\.mul/);
    // 独立标识符恰两处出现（定义 + lit 行唯一消费）：多一处消费就可能漏进非颜色路径
    expect((src.match(/transToon\b/g) ?? []).length).toBe(2);
  });

  it('pin-B: alpha accumulation and density lines contain no toon (cannot reshape)', () => {
    // 防呆：toon 混入必须在场，否则下面的反向断言空转（红阶段由这条变红）
    expect(src).toMatch(/mix\(trans, transToon, uToon\)/);
    const toonMarker = /transToon|TOON_TRANS|getSharedToonUniform|uToon/;
    // alpha 累积（accA / sampleA）行零 toon——uLook 先例（:118）同款口径
    const alphaLines = src.split('\n').filter((l) => l.includes('accA') || l.includes('sampleA'));
    expect(alphaLines.length).toBeGreaterThan(0);
    for (const l of alphaLines) expect(l).not.toMatch(toonMarker);
    // 输出 vec4 的 alpha 分量零 toon（:124 先例同款）
    const out = src.match(/vec4\([^;]*accA[^;]*\)/g) ?? [];
    expect(out.length).toBeGreaterThan(0);
    for (const v of out) expect(v).not.toMatch(toonMarker);
    // 密度行（采样点 + 密度门）零 toon——march/几何一条不碰
    const densityLines = src
      .split('\n')
      .filter((l) => l.includes('densityAt(') || l.includes('greaterThan(0.12'));
    expect(densityLines.length).toBeGreaterThan(0);
    for (const l of densityLines) expect(l).not.toMatch(toonMarker);
  });

  it('pin-C: stepped transmittance + IGN jitter structure present', () => {
    // 阶梯：具名阈值表 + 5 切点 step 阶梯（6 档，flat 路径同款嵌套 mix 形态）
    expect(src).toMatch(/TOON_TRANS_STEPS\s*=\s*\[/);
    expect((src.match(/step\(TOON_TRANS_STEPS\[/g) ?? []).length).toBe(5);
    // 档间抖动复用 march 入口的既有 IGN jitter（同一变量摆动半档），不是新噪声函数；
    // 全文件 interleavedGradientNoise 恰一处 = 没造第二根噪声
    expect(src).toMatch(/jitter\.sub\(0\.5\)\.mul\(TOON_TRANS_DITHER\)/);
    expect((src.match(/interleavedGradientNoise\(/g) ?? []).length).toBe(1);
    // uToon 读共享组（Task 1 TrackUniforms 单例），不是第二根 uniform
    expect(src).toMatch(/getSharedToonUniform\(tsl\)/);
    expect(src).not.toMatch(/uToon\s*=\s*uniform\(/);
    // sky-webgpu 侧：getter 幂等 ensure-build，复用 buildTrackUniforms 懒建单例路径
    const skySrc = sources['./sky-webgpu.ts'] as string;
    expect(skySrc).toMatch(/export function getSharedToonUniform/);
    expect(skySrc).toMatch(/if \(!trackU\) trackU = buildTrackUniforms\(tsl, trackState\);/);
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
