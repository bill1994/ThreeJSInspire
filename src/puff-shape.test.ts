import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import {
  PUFF_LOBE_ATTRIBUTE,
  PUFF_VARIANT_ORDER,
  PUFF_VARIANTS,
  buildPuffGeometry,
  mulberry32,
} from './puff-shape';

describe('PUFF_VARIANTS', () => {
  it('四种变体的高宽比互不相同，且 bank 横摊、tower 竖立', () => {
    expect(PUFF_VARIANTS.bank.aspect).toBeLessThan(1);
    expect(PUFF_VARIANTS.tower.aspect).toBeGreaterThan(1.8);
    expect(PUFF_VARIANTS.scraps.aspect).toBeLessThan(PUFF_VARIANTS.bank.aspect);
    const aspects = PUFF_VARIANT_ORDER.map((n) => PUFF_VARIANTS[n].aspect);
    expect(new Set(aspects).size).toBe(aspects.length);
  });
});

describe('buildPuffGeometry (per-lobe attribute)', () => {
  it('每个顶点的 lobeShade 是所属瓣的常量', async () => {
    const geo = await buildPuffGeometry(mulberry32(3), 'tower');
    const a = geo.getAttribute(PUFF_LOBE_ATTRIBUTE);
    expect(a.itemSize).toBe(1);
    expect(a.count).toBe(geo.getAttribute('position').count);
    const v = Array.from({ length: a.count }, (_, i) => a.getX(i));
    // 合并是逐瓣顺序拼接：等值连续段的条数 = 瓣数，且段内必须同值。
    let runs = 1;
    for (let i = 1; i < v.length; i += 1) if (v[i] !== v[i - 1]) runs += 1;
    expect(runs).toBeGreaterThanOrEqual(3); // 至少 3 团
    expect(runs).toBeLessThanOrEqual(16); // 不是逐顶点噪声
  });

  it('lobeShade 量化成三档，保住参考图的 4~6 个平涂色阶', async () => {
    const geo = await buildPuffGeometry(mulberry32(3), 'tower');
    const a = geo.getAttribute(PUFF_LOBE_ATTRIBUTE);
    const distinct = new Set(Array.from({ length: a.count }, (_, i) => a.getX(i)));
    for (const value of distinct) expect([-1, 0, 1]).toContain(value);
  });

  it('lobeShade 落在 [-1, 1] 且同种子同结果', async () => {
    const g1 = await buildPuffGeometry(mulberry32(9), 'bank');
    const g2 = await buildPuffGeometry(mulberry32(9), 'bank');
    const s1 = Array.from({ length: g1.getAttribute(PUFF_LOBE_ATTRIBUTE).count }, (_, i) =>
      g1.getAttribute(PUFF_LOBE_ATTRIBUTE).getX(i),
    );
    expect(Math.min(...s1)).toBeGreaterThanOrEqual(-1);
    expect(Math.max(...s1)).toBeLessThanOrEqual(1);
    const s2 = Array.from({ length: g2.getAttribute(PUFF_LOBE_ATTRIBUTE).count }, (_, i) =>
      g2.getAttribute(PUFF_LOBE_ATTRIBUTE).getX(i),
    );
    expect(s2).toEqual(s1);
  });

  it('四种变体各自能被撞穿的体积：bbox 高 < 240 m 且宽 > 20 m', async () => {
    for (const name of PUFF_VARIANT_ORDER) {
      const geo = await buildPuffGeometry(mulberry32(11), name, 1);
      geo.computeBoundingBox();
      const b = new THREE.Box3().setFromBufferAttribute(geo.getAttribute('position') as THREE.BufferAttribute);
      expect(b.max.y - b.min.y).toBeGreaterThan(15);
      expect(b.max.y - b.min.y).toBeLessThan(240);
      expect(b.max.x - b.min.x).toBeGreaterThan(20);
    }
  });
});
