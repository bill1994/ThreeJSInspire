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
