import { describe, expect, it } from 'vitest';

import { CLOUD_BAND } from './clouds-compute';
import { IN_CLOUD, WHITEOUT_MAX, cloudProximity01, whiteout01, type CloudBlob } from './in-cloud';

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
    // CLOUD_BAND 仍是 dome 的层带，近景云的雾不该再读它
    expect(cloudProximity01({ x: 0, y: CLOUD_BAND.bottom + 10, z: 0 }, [])).toBe(0);
  });
});
