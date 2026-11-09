import { describe, expect, it } from 'vitest';

import { boxScale, qualityParams } from './dome-cloud';
import { DOME_SLAB } from './dome-cloud-field';

describe('qualityParams', () => {
  it('pins the spec step budgets', () => {
    expect(qualityParams(true)).toEqual({ steps: 28, lightSteps: 4, octaves: 2 });
    expect(qualityParams(false)).toEqual({ steps: 16, lightSteps: 2, octaves: 1 });
  });

  it('never changes the volume resolution — setQuality must not rebake', () => {
    expect(Object.keys(qualityParams(true))).toEqual(Object.keys(qualityParams(false)));
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
