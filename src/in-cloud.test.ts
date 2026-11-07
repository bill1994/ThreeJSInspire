import { describe, expect, it } from 'vitest';

import {
  IN_CLOUD,
  WHITEOUT_MAX,
  cloudProximity01,
  interiorOpacity01,
  veilTintCss,
  whiteout01,
  type CloudBlob,
} from './in-cloud';

const blob: CloudBlob = { x: 0, y: 60, z: -300, halfW: 30, halfH: 25 };

describe('cloudProximity01', () => {
  it('云心是 1，两倍半径之外是 0', () => {
    expect(cloudProximity01({ x: 0, y: 60, z: -300 }, [blob])).toBeCloseTo(1, 6);
    expect(cloudProximity01({ x: 0, y: 60, z: -300 + 200 }, [blob])).toBe(0);
  });

  it('120 m 高空旁边没有云时是 0 —— 旧实现按高度这里会给满值', () => {
    expect(cloudProximity01({ x: 0, y: 120, z: -5000 }, [blob])).toBe(0);
    expect(cloudProximity01({ x: 0, y: 120, z: -300 }, [blob])).toBeLessThan(1);
  });

  it('60 m 贴着云是 1 —— 旧实现按高度这里是 0', () => {
    expect(cloudProximity01({ x: 0, y: 60, z: -300 }, [blob])).toBeGreaterThan(0.9);
  });

  it('空列表、非有限输入都回 0', () => {
    expect(cloudProximity01({ x: 0, y: 0, z: 0 }, [])).toBe(0);
    expect(cloudProximity01({ x: Number.NaN, y: 0, z: 0 }, [blob])).toBe(0);
    expect(cloudProximity01({ x: 0, y: 0, z: 0 }, [{ ...blob, halfW: Number.NaN }])).toBe(0);
  });

  it('取所有云里最近的那朵，不是第一朵', () => {
    const far: CloudBlob = { x: 900, y: 200, z: 900, halfW: 20, halfH: 20 };
    expect(cloudProximity01({ x: 0, y: 60, z: -300 }, [far, blob])).toBeCloseTo(1, 6);
  });

  it('贴着云底也在云里 —— 竖直方向按半高归一化', () => {
    expect(cloudProximity01({ x: 0, y: 60 - 25, z: -300 }, [blob])).toBeGreaterThan(0.5);
  });
});

describe('whiteout01', () => {
  it('上限是 WHITEOUT_MAX，绝不整屏糊死', () => {
    expect(whiteout01(1)).toBeCloseTo(WHITEOUT_MAX, 6);
    expect(WHITEOUT_MAX).toBeLessThan(1);
    expect(whiteout01(0)).toBe(0);
  });

  it('白纱降级为兜底层：封顶 0.45，体积感由兜底瓣提供', () => {
    expect(WHITEOUT_MAX).toBeCloseTo(0.45, 6);
  });

  it('单调不减，且夹住越界输入', () => {
    const v = [0, 0.25, 0.5, 0.75, 1].map((p) => whiteout01(p));
    for (let i = 1; i < v.length; i += 1) expect(v[i]).toBeGreaterThanOrEqual(v[i - 1]);
    expect(whiteout01(-1)).toBe(0);
    expect(whiteout01(4)).toBeCloseTo(WHITEOUT_MAX, 6);
  });

  it('滞回阈值必须分开，否则贴边飞会一闪一闪', () => {
    expect(IN_CLOUD.ENTER).toBeGreaterThan(IN_CLOUD.EXIT);
  });

  it('白雾不再依赖云带高度', () => {
    // CLOUD_BAND (dome 95-480 m) 随 clouds-compute.ts 一起删了：近景云的雾本来
    // 就不该读它。这里冻一个层带内的高度 (105 m)，断言无云包围体时接近度为 0。
    expect(cloudProximity01({ x: 0, y: 105, z: 0 }, [])).toBe(0);
  });
});

describe('veilTintCss', () => {
  it('背太阳侧给灰紫，朝太阳侧给暖米，中间取混色', () => {
    expect(veilTintCss(-1)).toBe('#cfc6da');
    expect(veilTintCss(1)).toBe('#ffe9c4');
    expect(veilTintCss(0)).toBe('#e7d7cf');
  });

  it('非有限输入回退中性色 #e7d7cf，绝不输出 NaN 色', () => {
    expect(veilTintCss(Number.NaN)).toBe('#e7d7cf');
    expect(veilTintCss(Number.POSITIVE_INFINITY)).toBe('#e7d7cf');
  });

  it('越界但有限的输入被钳到两端色', () => {
    expect(veilTintCss(-3)).toBe('#cfc6da');
    expect(veilTintCss(7)).toBe('#ffe9c4');
  });
});

describe('interiorOpacity01', () => {
  it('prox 0.7 起步、0.95 饱和、越界钳制', () => {
    expect(interiorOpacity01(0.7)).toBe(0);
    expect(interiorOpacity01(0.95)).toBe(1);
    expect(interiorOpacity01(1)).toBe(1);
    expect(interiorOpacity01(0.5)).toBe(0);
  });

  it('非有限输入回 0', () => {
    expect(interiorOpacity01(Number.NaN)).toBe(0);
  });
});
