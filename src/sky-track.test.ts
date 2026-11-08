import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import {
  REFERENCE_ELEVATION_DEG,
  lerpTrackStates,
  rampColorJs,
  skyTrackAt,
  srgbToLinear,
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
  it('skyTrackAt(30) 深等于参考档', () => {
    expect(skyTrackAt(30)).toEqual(skyTrackAt(REFERENCE_ELEVATION_DEG));
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
