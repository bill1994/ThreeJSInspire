import { describe, expect, it } from 'vitest';

import {
  PAINT_CONSTANTS,
  lightBlend,
  mapPalette,
  paintMixJs,
  smoothstepJs,
  type CloudColors,
} from './bg-cumulus-paint';

const BANDS: readonly [number, number, number][] = [
  [0.14, 0.16, 0.27], // band0 背光底
  [0.17, 0.19, 0.33], // band1 背光顶
  [0.23, 0.19, 0.31], // band2 迎光底
  [0.27, 0.23, 0.29], // band3 迎光顶
];
const HAZE: [number, number, number] = [0.15, 0.19, 0.31];

describe('bg-cumulus-paint 上色映射', () => {
  it('mapPalette 恒等表：bands[3]→lit、[2]→mid、[1]→shade、[0]→under、haze 直传', () => {
    const p = mapPalette(BANDS, HAZE);
    expect(p.lit).toEqual(BANDS[3]);
    expect(p.mid).toEqual(BANDS[2]);
    expect(p.shade).toEqual(BANDS[1]);
    expect(p.under).toEqual(BANDS[0]);
    expect(p.haze).toEqual(HAZE);
  });

  it('mapPalette 不改写输入', () => {
    const bands: [number, number, number][] = BANDS.map((b) => [b[0], b[1], b[2]] as [number, number, number]);
    mapPalette(bands, HAZE);
    expect(bands).toEqual(BANDS);
  });

  it('lightBlend：正午 dayW=1 取太阳、深夜 dayW=0 取反相月亮、−4° 恰 0.5（单调过渡）', () => {
    const sun: [number, number, number] = [0.2, 0.9, -0.37];
    const noon = lightBlend(sun, 65);
    expect(noon.dayW).toBeCloseTo(1, 6);
    expect(noon.dir[0]).toBeCloseTo(sun[0], 6);
    const night = lightBlend(sun, -30);
    expect(night.dayW).toBeCloseTo(0, 6);
    expect(night.dir[0]).toBeCloseTo(-sun[0], 6);
    expect(night.dir[1]).toBeCloseTo(-sun[1], 6);
    const dusk = lightBlend(sun, -4);
    expect(dusk.dayW).toBeCloseTo(0.5, 6);
    // 过渡单调：−6° 的 dayW 介于 0 与 0.5 之间
    const d6 = lightBlend(sun, -6);
    expect(d6.dayW).toBeGreaterThan(0);
    expect(d6.dayW).toBeLessThan(0.5);
    // 混合向量在 0.5 处退化为零向量——由 shader 侧 lift(+0.5y) 兜底，契约钉在这里
    expect(dusk.dir[0]).toBeCloseTo(0, 6);
    expect(dusk.dir[1]).toBeCloseTo(0, 6);
  });

  it('paintMixJs：硬边亮侧落 uLit、暗侧落 uShade 邻域（参考 clouds.js:279-310 尾段）', () => {
    const colors: CloudColors = {
      lit: [1.2, 1.15, 1.0],
      mid: [0.6, 0.7, 0.85],
      shade: [0.3, 0.42, 0.62],
      under: [0.25, 0.35, 0.55],
      haze: HAZE,
    };
    const litSide = paintMixJs(0.65, 0.8, 1, 1, 1, colors);
    for (let i = 0; i < 3; i += 1) expect(litSide[i]).toBeCloseTo(colors.lit[i], 2);
    const shadeSide = paintMixJs(0.5, 0.3, 1, 1, 1, colors);
    for (let i = 0; i < 3; i += 1) expect(Math.abs(shadeSide[i] - colors.shade[i])).toBeLessThan(0.06);
    // 无灰律：亮侧输出不得是中性灰（三通道全等）
    expect(litSide[0] === litSide[1] && litSide[1] === litSide[2]).toBe(false);
  });

  it('PAINT_CONSTANTS 字面值钉（防漂移；与归档真本的同源核对见下方 describe）', () => {
    expect(PAINT_CONSTANTS.hardEdge).toEqual([0.55, 0.6]);
    expect(PAINT_CONSTANTS.shadeMix).toEqual([0.25, 0.85]);
    expect(PAINT_CONSTANTS.foldDeepen).toBe(0.07);
    expect(PAINT_CONSTANTS.underMix).toEqual([-0.2, 0.5]);
    expect(PAINT_CONSTANTS.shadowNear).toBe(2.6);
    expect(PAINT_CONSTANTS.shadowFar).toBe(6.5);
    expect(PAINT_CONSTANTS.liftY).toBe(0.5);
  });

  it('smoothstepJs 与 GLSL smoothstep 同式', () => {
    expect(smoothstepJs(0, 1, 0.5)).toBeCloseTo(0.5, 6);
    expect(smoothstepJs(0, 1, -1)).toBe(0);
    expect(smoothstepJs(0, 1, 2)).toBe(1);
    expect(smoothstepJs(0.55, 0.6, 0.6)).toBe(1);
  });
});


// 契约：PAINT_CONSTANTS 的每一项都必须出现在归档参考的 paint() 里。
// 参考真本见 docs/reference/painted-valley/（MIT, (c) 2026 Patch），出处与版本见同目录 PROVENANCE.md。
// 这条测试是 2026-11-14 重建的：此前它只对着字面量自证，因为原参考随换机丢失、从未进过 git。
describe('PAINT_CONSTANTS 与归档参考逐项一致（docs/reference/painted-valley/clouds.js）', () => {
  const refs = import.meta.glob('../docs/reference/painted-valley/clouds.js', {
    query: '?raw',
    eager: true,
    import: 'default',
  }) as Record<string, string>;
  const whole = refs['../docs/reference/painted-valley/clouds.js'];

  const paintBody = (): string => {
    const a = whole.indexOf('vec3 paint(vec3 p');
    const b = whole.indexOf('vec3 faceDir(', a);
    return whole.slice(a, b);
  };

  it('参考已归档，且 paint() 段可定位', () => {
    expect(whole).toBeTruthy();
    expect(whole.length).toBeGreaterThan(10000);
    expect(paintBody().length).toBeGreaterThan(1000);
  });

  it('硬边 / 暗部区间 / 底音 / 折痕：常数与参考的字面值同源', () => {
    const p = paintBody();
    expect(p).toContain(`smoothstep(${PAINT_CONSTANTS.hardEdge[0]}, ${PAINT_CONSTANTS.hardEdge[1]}, light)`);
    expect(p).toContain(`smoothstep(${PAINT_CONSTANTS.shadeMix[0]}, ${PAINT_CONSTANTS.shadeMix[1]}, broad)`);
    expect(p).toContain(`smoothstep(${PAINT_CONSTANTS.foldRange[0]}, ${PAINT_CONSTANTS.foldRange[1]}, open)`);
    expect(p).toContain(`1.0 - ${PAINT_CONSTANTS.foldDeepen} *`);
    expect(p).toContain(`smoothstep(${PAINT_CONSTANTS.underMix[0]}, ${PAINT_CONSTANTS.underMix[1]}, (p.y - base) / (scale * ${PAINT_CONSTANTS.underScale}) + light)`);
  });

  it('阴影双探针 / 光照三项 / broad 三项：常数与参考的字面值同源', () => {
    const p = paintBody();
    expect(p).toContain(`scale * ${PAINT_CONSTANTS.shadowNear}`);
    expect(p).toContain(`scale * ${PAINT_CONSTANTS.shadowFar}`);
    expect(p).toContain(`exp(-shadow * ${PAINT_CONSTANTS.lightExpo})`);
    expect(p).toContain(`${PAINT_CONSTANTS.litUp} * up`);
    expect(p).toContain(`${PAINT_CONSTANTS.litOpen} * (open - 0.5)`);
    expect(p).toContain(`${PAINT_CONSTANTS.litNy} * N.y`);
    expect(p).toContain(`${PAINT_CONSTANTS.broadUp} * up`);
    expect(p).toContain(`${PAINT_CONSTANTS.broadNy} * Ns.y`);
    expect(p).toContain(`${PAINT_CONSTANTS.broadBillow} * (billow(`);
    expect(p).toContain(`vec3(0.0, ${PAINT_CONSTANTS.liftY}, 0.0)`);
    expect(p).toContain(`* ${PAINT_CONSTANTS.radialPull}`);
  });
});