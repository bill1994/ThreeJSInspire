import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import {
  REFERENCE_ELEVATION_DEG,
  TOON_BANDS_REF,
  applyToonLook,
  applyTrackPatch,
  deriveDayKey,
  deriveToonBands,
  lerpTrackStates,
  linearToByte,
  linearToSrgbCss,
  rampColorJs,
  skyTrackAt,
  srgbToLinear,
  type PreethamParams,
  type SkyTrackState,
  type Vec3,
} from './sky-track';
import { HORIZON, awayHorizonLinear } from './horizon';
import { PUFF_BAND_COLORS, SKY_PALETTE, SKY_STOPS, SUN_TINT_LINEAR } from './palettes';

const BLACK: Vec3 = [0, 0, 0];
const WHITE: Vec3 = [1, 1, 1];

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

/** 数值反解 smoothstep(e0, e1, x) = s（二分；smoothstep 在 [e0,e1] 单调）。 */
function invSmoothstep(e0: number, e1: number, s: number): number {
  let lo = e0;
  let hi = e1;
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    if (smoothstep(e0, e1, mid) < s) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function expectVec3(actual: Vec3, expected: readonly number[], eps = 1e-9): void {
  expect(Math.abs(actual[0] - expected[0])).toBeLessThanOrEqual(eps);
  expect(Math.abs(actual[1] - expected[1])).toBeLessThanOrEqual(eps);
  expect(Math.abs(actual[2] - expected[2])).toBeLessThanOrEqual(eps);
}

/** 全 Vec3 字段 = color、全标量 = scalar、全 CSS = css 的合成轨道态。 */
function syntheticState(color: Vec3, scalar: number, css: string): SkyTrackState {
  return {
    dayStops: [color, color, color, color],
    nightStops: [color, color, color, color],
    nightWeight: scalar,
    awayColor: color,
    awayGain: scalar,
    awayHeight: scalar,
    glowPow: scalar,
    glowGain: scalar,
    sunTint: color,
    discGain: scalar,
    cloudBands: [color, color, color, color],
    cloudHaze: color,
    hazeLinear: color,
    awayEdgeLinear: color,
    floorLinear: color,
    preetham: {
      turbidity: scalar,
      rayleigh: scalar,
      mieCoefficient: scalar,
      mieDirectionalG: scalar,
    },
    sunLightColorCss: css,
    sunLightIntensity: scalar,
    hemiSkyCss: css,
    hemiGroundCss: css,
    hemiIntensity: scalar,
    veilCool: color,
    veilWarm: color,
    starOpacity: scalar,
    bloomThreshold: scalar,
  };
}

describe('srgbToLinear', () => {
  it('与 THREE.Color 的 sRGB→线性解码一致（#ff9a5a / #4a2f74 / #5a3f60，1e-9）', () => {
    for (const css of ['#ff9a5a', '#4a2f74', '#5a3f60']) {
      const c = new THREE.Color(css);
      const [r, g, b] = srgbToLinear(css);
      expect(Math.abs(r - c.r)).toBeLessThan(1e-9);
      expect(Math.abs(g - c.g)).toBeLessThan(1e-9);
      expect(Math.abs(b - c.b)).toBeLessThan(1e-9);
    }
  });
});

describe('skyTrackAt — 参考档恒等来源', () => {
  const ref = skyTrackAt(REFERENCE_ELEVATION_DEG);

  it('dayStops 逐通道 = srgbToLinear(SKY_STOPS[i].color)', () => {
    SKY_STOPS.forEach((stop, i) => {
      expectVec3(ref.dayStops[i], srgbToLinear(stop.color));
    });
  });

  it('标量恒等：awayGain/awayHeight/glowPow/glowGain/discGain 来自 HORIZON', () => {
    expect(ref.awayGain).toBe(HORIZON.AWAY_GAIN);
    expect(ref.awayHeight).toBe(HORIZON.AWAY_HEIGHT);
    expect(ref.glowPow).toBe(HORIZON.GLOW_POW);
    expect(ref.glowGain).toBe(HORIZON.GLOW_GAIN);
    expect(ref.discGain).toBe(HORIZON.DISK_GAIN);
  });

  it('sunTint = SUN_TINT_LINEAR（palettes 单源，无第二份）', () => {
    expectVec3(ref.sunTint, SUN_TINT_LINEAR);
  });

  it('nightWeight === 0、floorLinear === [0,0,0]、nightStops 全零', () => {
    expect(ref.nightWeight).toBe(0);
    expectVec3(ref.floorLinear, [0, 0, 0]);
    ref.nightStops.forEach((stop) => expectVec3(stop, [0, 0, 0]));
  });

  it('cloudBands 逐档 = srgbToLinear(PUFF_BAND_COLORS[i])，cloudHaze = srgbToLinear(SKY_PALETTE.horizon)', () => {
    PUFF_BAND_COLORS.forEach((hex, i) => {
      expectVec3(ref.cloudBands[i], srgbToLinear(hex));
    });
    expectVec3(ref.cloudHaze, srgbToLinear(SKY_PALETTE.horizon));
  });

  it('hazeLinear = srgbToLinear(SKY_PALETTE.horizon)；awayEdgeLinear = awayHorizonLinear()', () => {
    expectVec3(ref.hazeLinear, srgbToLinear(SKY_PALETTE.horizon));
    const edge = awayHorizonLinear();
    expectVec3(ref.awayEdgeLinear, edge);
  });
});

describe('lerpTrackStates — 插值空间', () => {
  it('t=0.5 时颜色字段输出 ≈ [0.5,0.5,0.5]（线性空间，sRGB 插值会得到别的值）', () => {
    const mid = lerpTrackStates(syntheticState(BLACK, 0, '#000000'), syntheticState(WHITE, 1, '#ffffff'), 0.5);
    const colorFields: readonly (keyof SkyTrackState)[] = [
      'awayColor',
      'sunTint',
      'cloudHaze',
      'hazeLinear',
      'awayEdgeLinear',
      'floorLinear',
      'veilCool',
      'veilWarm',
    ];
    for (const field of colorFields) {
      expectVec3(mid[field] as Vec3, [0.5, 0.5, 0.5], 1e-12);
    }
    (['dayStops', 'nightStops', 'cloudBands'] as const).forEach((field) => {
      (mid[field] as readonly Vec3[]).forEach((stop) => expectVec3(stop, [0.5, 0.5, 0.5], 1e-12));
    });
    expect(mid.nightWeight).toBeCloseTo(0.5, 12);
    expect(mid.glowGain).toBeCloseTo(0.5, 12);
    expect(mid.preetham.turbidity).toBeCloseTo(0.5, 12);
  });
});

describe('skyTrackAt — 段外钳制', () => {
  it('skyTrackAt(-20) 深等于 skyTrackAt(-8)', () => {
    expect(skyTrackAt(-20)).toEqual(skyTrackAt(-8));
  });
  it('skyTrackAt(80) 深等于 65° 档（段外钳新上界；Task 4 前此处是 30=参考档）', () => {
    expect(skyTrackAt(80)).toEqual(skyTrackAt(65));
  });
});

describe('rampColorJs — 现 stop 链式 mix 的 JS 镜像', () => {
  const stops: [Vec3, Vec3, Vec3, Vec3] = [
    [0.1, 0.2, 0.3],
    [0.4, 0.5, 0.6],
    [0.7, 0.8, 0.9],
    [1.0, 0.0, 0.5],
  ];

  it('t=0（dirY ≤ -0.02）返回 stops[0]', () => {
    expectVec3(rampColorJs(-0.02, stops), stops[0], 0);
    expectVec3(rampColorJs(-0.5, stops), stops[0], 0);
  });

  it('t ≥ 1（dirY ≥ 0.55）返回 stops[3]', () => {
    expectVec3(rampColorJs(0.55, stops), stops[3], 0);
    expectVec3(rampColorJs(2, stops), stops[3], 0);
  });

  it('段内四分点 = smoothstep 四分点 0.15625（线性插值会得 0.25）', () => {
    // 第一段 25% 处的外层 t 值：锚点 0 与 0.42 之间
    const quarterT = SKY_STOPS[0].at + 0.25 * (SKY_STOPS[1].at - SKY_STOPS[0].at);
    const dirY = invSmoothstep(-0.02, 0.55, quarterT);
    const binary: [Vec3, Vec3, Vec3, Vec3] = [BLACK, WHITE, BLACK, BLACK];
    const out = rampColorJs(dirY, binary);
    expect(out[0]).toBeCloseTo(0.15625, 9);
    expect(out[1]).toBeCloseTo(0.15625, 9);
    expect(out[2]).toBeCloseTo(0.15625, 9);
  });
});

// ---- debug color panel（计划 Task 1）：linearToSrgbCss 钉输出、linearToByte、applyTrackPatch ----

describe('linearToSrgbCss — 重构前先钉死现有输出（D4）', () => {
  it('pins current linearToSrgbCss output before refactor (must NOT regress sky CSS)', () => {
    expect(linearToSrgbCss([0, 0, 0])).toBe('#000000');
    expect(linearToSrgbCss([1, 1, 1])).toBe('#ffffff');
    expect(linearToSrgbCss([0.5, 0.5, 0.5])).toBe('#bcbcbc'); // 1.055·0.5^(1/2.4)−0.055 = 0.7354 → round 188
    expect(linearToSrgbCss([-0.1, -0.1, -0.1])).toBe('#000000'); // 超下界钳制
    expect(linearToSrgbCss([1.5, 1.5, 1.5])).toBe('#ffffff'); // 超上界钳制
  });
});

describe('linearToByte — 面板回显与往返共用（Review Focus 5）', () => {
  it('srgbToLinear 的逐字节逆：#ff0000 精确回 [255,0,0]', () => {
    expect(linearToByte(srgbToLinear('#ff0000'))).toEqual([255, 0, 0]);
  });

  it('#808080 往返每通道差 ≤ 1', () => {
    const bytes = linearToByte(srgbToLinear('#808080'));
    for (const byte of bytes) expect(Math.abs(byte - 128)).toBeLessThanOrEqual(1);
  });

  it('钳制与 linearToSrgbCss 同一套：超界收进 0–255', () => {
    expect(linearToByte([-0.5, -0.5, -0.5])).toEqual([0, 0, 0]);
    expect(linearToByte([2, 2, 2])).toEqual([255, 255, 255]);
  });

  it('与 srgbToLinear 全字节精确互逆（doc contract：exact inverse for every byte value）', () => {
    for (const css of ['#ff9a5a', '#4a2f74', '#5a3f60', '#26304f', '#e07040']) {
      expect(linearToSrgbCss(srgbToLinear(css))).toBe(css);
    }
  });
});

describe('applyTrackPatch — 调试补丁合并', () => {
  const base = skyTrackAt(0);

  it('patch 为 null 返回 base 本人（引用相等——默认路径逐位一致）', () => {
    expect(applyTrackPatch(base, null)).toBe(base);
  });

  it('非 null：提出字段覆盖，未提字段保持 base 引用', () => {
    const preetham = { turbidity: 7, rayleigh: 2, mieCoefficient: 0.01, mieDirectionalG: 0.9 };
    const out = applyTrackPatch(base, { nightWeight: 0.42, glowGain: 0.9, preetham });
    expect(out).not.toBe(base);
    expect(out.nightWeight).toBe(0.42);
    expect(out.glowGain).toBe(0.9);
    expect(out.preetham).toBe(preetham);
    expect(out.awayGain).toBe(base.awayGain);
    expect(out.dayStops).toBe(base.dayStops);
    expect(out.floorLinear).toBe(base.floorLinear);
    expect(out.sunLightColorCss).toBe(base.sunLightColorCss);
  });

  it('数组字段整替不逐元合并；preetham 对象整替而非嵌套合并', () => {
    const dayStops: [Vec3, Vec3, Vec3, Vec3] = [
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
      [0.7, 0.8, 0.9],
      [1, 1, 1],
    ];
    // 面板正常给完整 preetham；这里故意给只带 turbidity 的残缺对象，钉死「整替」语义。
    const partial = { turbidity: 9 } as unknown as PreethamParams;
    const out = applyTrackPatch(base, { dayStops, preetham: partial });
    expect(out.dayStops).toBe(dayStops);
    expect(out.preetham).toBe(partial);
    expect(out.preetham.turbidity).toBe(9);
    // 嵌套合并会把 base 的旧值带回来；整替语义下未提字段就是 undefined。
    expect(out.preetham.rayleigh).toBeUndefined();
    expect(out.preetham.mieDirectionalG).toBeUndefined();
  });
});

// ---- toon-look Phase 1 计划 Task 4：applyToonLook 调色硬化层（D1 载体）----------------------
//
// 设计定案（plan 定案记录 D1 / veil ruling）：applyToonLook 是 state→state 纯函数，
// 插在 syncSun 的扇出里（skyTrackAt → applyToonLook → applyTrackPatch），toon 作
// 底层、用户补丁在上——不是 setTrackPatch 快照（整体替换会杀死逐仰角轨道插值）。
// 触达面只有 cloudBands/cloudHaze（veilCool/veilWarm 明确不在 T4 范围；海霾端点
// 自动 toon 化归 D2）。参考档映射人工锚 TOON_BANDS_REF，非参考档按同一条校准
// ramp 派生：暗色沿紫锚色相收敛、亮色沿暖锚收敛（hue-shifted ramp 标准手法）。

/** 0-255 字节空间的 HSV 色相（度，[0,360)）——色相断言读显示空间，不读线性空间。 */
function hueOf(v: Vec3): number {
  const [r8, g8, b8] = linearToByte(v);
  const r = r8 / 255;
  const g = g8 / 255;
  const b = b8 / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  if (max === r) return ((((g - b) / d) % 6) + 6) % 6 * 60;
  if (max === g) return (((b - r) / d) + 2) * 60;
  return (((r - g) / d) + 4) * 60;
}

/** 环上最短弧距（度）——色相方向断言用距离收敛表述，绕开环绕期的正负歧义。 */
function hueDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

const lum01 = (v: Vec3): number => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];

describe('applyToonLook (palette hardening, track-aware)', () => {
  it('amount=0 returns a deep-copy identity（逐字段 deepEqual + 引用不等）', () => {
    const state = skyTrackAt(2.5); // 段内插值态——不是端点克隆路径
    const out = applyToonLook(state, 0);
    expect(out).toEqual(state);
    expect(out).not.toBe(state);
    // 深拷贝：所有数组/对象字段都不与输入共享引用
    expect(out.dayStops).not.toBe(state.dayStops);
    expect(out.nightStops).not.toBe(state.nightStops);
    expect(out.awayColor).not.toBe(state.awayColor);
    expect(out.sunTint).not.toBe(state.sunTint);
    expect(out.cloudBands).not.toBe(state.cloudBands);
    expect(out.cloudHaze).not.toBe(state.cloudHaze);
    expect(out.hazeLinear).not.toBe(state.hazeLinear);
    expect(out.awayEdgeLinear).not.toBe(state.awayEdgeLinear);
    expect(out.floorLinear).not.toBe(state.floorLinear);
    expect(out.preetham).not.toBe(state.preetham);
    expect(out.veilCool).not.toBe(state.veilCool);
    expect(out.veilWarm).not.toBe(state.veilWarm);
    // 嵌套 Vec3 也不共享
    expect(out.cloudBands[0]).not.toBe(state.cloudBands[0]);
    expect(out.dayStops[3]).not.toBe(state.dayStops[3]);
  });

  it('reference-key bands map to TOON_BANDS_REF exactly (human-picked anchor)', () => {
    // 参考档（REFERENCE_ELEVATION_DEG ≈ 6.97）的 cloudBands 就是校准源 ramp 本身：
    // applyToonLook(·, 1) 必须逐位落回人工锚——校准恒等，不是近似。
    const out = applyToonLook(skyTrackAt(REFERENCE_ELEVATION_DEG), 1);
    expect(out.cloudBands).toEqual(TOON_BANDS_REF);
  });

  it('校准前提：源 ramp（PUFF_BAND_COLORS）与锚 ramp（TOON_BANDS_REF）亮度都递升', () => {
    // deriveToonColor 用亮度在源 ramp 上定位——递升是结构性前提，调色板改动若破坏它必须红。
    const src = skyTrackAt(REFERENCE_ELEVATION_DEG).cloudBands;
    const srcLums = src.map(lum01);
    for (let i = 0; i < 3; i += 1) {
      expect(srcLums[i + 1]).toBeGreaterThan(srcLums[i]);
      expect(lum01(TOON_BANDS_REF[i + 1])).toBeGreaterThan(lum01(TOON_BANDS_REF[i]));
    }
  });

  it('deriveToonBands: amount=0 逐档直通；amount=1 与 applyToonLook 的 cloudBands 一致', () => {
    const bands = skyTrackAt(0).cloudBands;
    expect(deriveToonBands(bands, 0)).toEqual(bands);
    expect(deriveToonBands(bands, 1)).toEqual(applyToonLook(skyTrackAt(0), 1).cloudBands);
  });

  it('non-reference keys derive via hue-shift: dark keys shift toward purple, lit keys toward warm', () => {
    const purpleHue = hueOf(TOON_BANDS_REF[0]);
    const warmHue = hueOf(TOON_BANDS_REF[3]);
    // 暗档（-8° 夜云 + 夜霾，非参考档）：色相收敛向人工紫锚，且亮度序保持、
    // 整体停在亮锚之下——派生保留逐仰角变化，不是整体替换。
    const night = skyTrackAt(-8);
    const nightToon = applyToonLook(night, 1);
    nightToon.cloudBands.forEach((band, i) => {
      expect(hueDist(hueOf(band), purpleHue)).toBeLessThan(hueDist(hueOf(night.cloudBands[i]), purpleHue));
    });
    expect(hueDist(hueOf(nightToon.cloudHaze), purpleHue)).toBeLessThan(hueDist(hueOf(night.cloudHaze), purpleHue));
    const lum = (bands: readonly Vec3[]) => bands.map(lum01);
    const outLums = lum(nightToon.cloudBands);
    for (let i = 0; i < 4; i += 1) {
      expect(outLums[i]).toBeLessThan(lum01(TOON_BANDS_REF[3])); // 夜档仍在亮锚之下
    }
    expect(outLums[3]).toBeGreaterThan(outLums[0]); // ramp 序保持（逐仰角变化未被整体替换抹平）
    // 亮档（合成亮粉，亮度落在 ramp 顶段之上）：色相收敛向人工暖橙锚。
    const lit = syntheticState([0.55, 0.28, 0.3], 0.5, '#ffffff');
    const litToon = applyToonLook(lit, 1);
    expect(hueDist(hueOf(litToon.cloudBands[3]), warmHue)).toBeLessThan(hueDist(hueOf(lit.cloudBands[3]), warmHue));
  });

  it('touches only cloudBands/cloudHaze — preetham/lights/bloomThreshold fields reference-identical', () => {
    const base = skyTrackAt(0);
    const out = applyToonLook(base, 1);
    // 触达的两个字段：引用换新 + 数值确实变了
    expect(out.cloudBands).not.toBe(base.cloudBands);
    expect(out.cloudBands).not.toEqual(base.cloudBands);
    expect(out.cloudHaze).not.toBe(base.cloudHaze);
    expect(out.cloudHaze).not.toEqual(base.cloudHaze);
    // 其余全部引用恒等（toBe）——amount=0 深拷贝之外的路径只做浅展开
    expect(out.dayStops).toBe(base.dayStops);
    expect(out.nightStops).toBe(base.nightStops);
    expect(out.nightWeight).toBe(base.nightWeight);
    expect(out.awayColor).toBe(base.awayColor);
    expect(out.awayGain).toBe(base.awayGain);
    expect(out.awayHeight).toBe(base.awayHeight);
    expect(out.glowPow).toBe(base.glowPow);
    expect(out.glowGain).toBe(base.glowGain);
    expect(out.sunTint).toBe(base.sunTint);
    expect(out.discGain).toBe(base.discGain);
    expect(out.hazeLinear).toBe(base.hazeLinear); // D2：海霾端点自动 toon 化不在本任务
    expect(out.awayEdgeLinear).toBe(base.awayEdgeLinear);
    expect(out.floorLinear).toBe(base.floorLinear);
    expect(out.preetham).toBe(base.preetham);
    expect(out.sunLightColorCss).toBe(base.sunLightColorCss);
    expect(out.sunLightIntensity).toBe(base.sunLightIntensity);
    expect(out.hemiSkyCss).toBe(base.hemiSkyCss);
    expect(out.hemiGroundCss).toBe(base.hemiGroundCss);
    expect(out.hemiIntensity).toBe(base.hemiIntensity);
    expect(out.veilCool).toBe(base.veilCool); // veil ruling：白纱端点保持轨道原值
    expect(out.veilWarm).toBe(base.veilWarm);
    expect(out.starOpacity).toBe(base.starOpacity);
    expect(out.bloomThreshold).toBe(base.bloomThreshold);
  });
});

// ---- planB Phase 1 Task 4：轨道补档 +15/30/45/65（R4 派生 + 人工 ramp）----------

import { sunColorFor } from './sun-color';

describe('deriveDayKey (planB Task 4, R4 derivation)', () => {
  const low = syntheticState([0.2, 0.22, 0.45], 0.3, '#404060');
  const high = syntheticState([0.75, 0.45, 0.28], 0.9, '#c08050');
  const lowBands: [Vec3, Vec3, Vec3, Vec3] = [
    [0.05, 0.06, 0.16],
    [0.1, 0.09, 0.22],
    [0.2, 0.12, 0.25],
    [0.3, 0.18, 0.28],
  ];
  const highBands: [Vec3, Vec3, Vec3, Vec3] = [
    [0.35, 0.3, 0.5],
    [0.5, 0.38, 0.45],
    [0.7, 0.48, 0.35],
    [0.9, 0.58, 0.28],
  ];
  const bandLow: SkyTrackState = { ...low, cloudBands: lowBands };
  const bandHigh: SkyTrackState = { ...high, cloudBands: highBands };

  it('低端恒等：deriveDayKey(REFERENCE_ELEVATION_DEG, low, high) bands == low bands（逐位）', () => {
    const out = deriveDayKey(REFERENCE_ELEVATION_DEG, bandLow, bandHigh);
    expect(out.cloudBands).toEqual(bandLow.cloudBands);
    expect(out.dayStops).toEqual(bandLow.dayStops);
  });

  it('高端恒等：deriveDayKey(65, low, high) bands == high bands（逐位）', () => {
    const out = deriveDayKey(65, bandLow, bandHigh);
    expect(out.cloudBands).toEqual(bandHigh.cloudBands);
    expect(out.dayStops).toEqual(bandHigh.dayStops);
  });

  it('派生方向：15/30/45 的 band 色相在 low→high 之间、随 el 单调趋近 high', () => {
    const highs = bandHigh.cloudBands.map(hueOf);
    const lows = bandLow.cloudBands.map(hueOf);
    let prev = lows.map((l, i) => hueDist(l, highs[i]));
    for (const el of [15, 30, 45]) {
      const out = deriveDayKey(el, bandLow, bandHigh);
      const cur = out.cloudBands.map((b, i) => hueDist(hueOf(b), highs[i]));
      for (let i = 0; i < 4; i += 1) {
        // 插值位于两侧之间：离 high 比 low 近、离 low 比 high 近
        expect(cur[i]).toBeLessThan(prev[i]);
        expect(hueDist(hueOf(out.cloudBands[i]), lows[i])).toBeLessThan(hueDist(highs[i], lows[i]));
      }
      prev = cur;
    }
  });

  it('暗端向紫 / 亮端向暖：mid-key 偏置与 toon D1 同向', () => {
    const purpleHue = hueOf(TOON_BANDS_REF[0]);
    const warmHue = hueOf(TOON_BANDS_REF[3]);
    const out = deriveDayKey(30, bandLow, bandHigh);
    // 最暗 band 向紫锚收敛（相对 low 更近紫）
    expect(hueDist(hueOf(out.cloudBands[0]), purpleHue)).toBeLessThan(
      hueDist(hueOf(bandLow.cloudBands[0]), purpleHue),
    );
    // 最亮 band 向暖锚收敛（相对 low 更近暖）
    expect(hueDist(hueOf(out.cloudBands[3]), warmHue)).toBeLessThan(
      hueDist(hueOf(bandLow.cloudBands[3]), warmHue),
    );
  });

  it('灯光色从 sunColorFor 派生（线性 sunTint + CSS 同源）', () => {
    const out = deriveDayKey(30, bandLow, bandHigh);
    const tint = sunColorFor(30);
    expectVec3(out.sunTint, tint, 1e-12);
    expect(out.sunLightColorCss).toBe(linearToSrgbCss(tint));
  });

  it('纯函数：同输入同输出、不别名输入的数组字段', () => {
    const a = deriveDayKey(30, bandLow, bandHigh);
    const b = deriveDayKey(30, bandLow, bandHigh);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.cloudBands).not.toBe(bandLow.cloudBands);
    expect(a.cloudBands).not.toBe(bandHigh.cloudBands);
    expect(a.cloudBands[0]).not.toBe(bandLow.cloudBands[0]);
    expect(a.preetham).not.toBe(bandLow.preetham);
  });
});

describe('skyTrackAt — day keys +15/30/45/65（planB Task 4）', () => {
  it('skyTrackAt(65) 不再是钳位参考值（与参考档逐通道差远超 float noise）', () => {
    const noon = skyTrackAt(65);
    const ref = skyTrackAt(REFERENCE_ELEVATION_DEG);
    expect(noon).not.toEqual(ref);
    let maxDiff = 0;
    for (let i = 0; i < 4; i += 1) {
      for (let c = 0; c < 3; c += 1) {
        maxDiff = Math.max(maxDiff, Math.abs(noon.dayStops[i][c] - ref.dayStops[i][c]));
      }
    }
    expect(maxDiff).toBeGreaterThan(1e-3);
  });

  it('+15/+30/+45 档存在且逐档不同（段内连续、非坍缩）', () => {
    const k15 = skyTrackAt(15);
    const k30 = skyTrackAt(30);
    const k45 = skyTrackAt(45);
    const k65 = skyTrackAt(65);
    expect(k15).not.toEqual(k30);
    expect(k30).not.toEqual(k45);
    expect(k45).not.toEqual(k65);
    // 段内插值连续：22.5 落在 15/30 之间（亮度序不断）
    const mid = skyTrackAt(22.5);
    const l15 = lum01(k15.dayStops[3]);
    const lMid = lum01(mid.dayStops[3]);
    const l30 = lum01(k30.dayStops[3]);
    expect(lMid).toBeGreaterThanOrEqual(Math.min(l15, l30) - 1e-9);
    expect(lMid).toBeLessThanOrEqual(Math.max(l15, l30) + 1e-9);
  });

  it('参考档以下段不受新档影响：skyTrackAt(3) 仍落在 0°/参考档段内', () => {
    const s = skyTrackAt(3);
    // nightWeight 在 [0°(0.15), 参考(0)] 之间，星点未点亮
    expect(s.nightWeight).toBeLessThanOrEqual(0.15);
    expect(s.nightWeight).toBeGreaterThanOrEqual(0);
    expect(s.starOpacity).toBe(0);
  });
});
