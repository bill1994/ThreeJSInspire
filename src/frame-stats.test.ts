import { describe, expect, it } from 'vitest';

import { createFrameStats } from './frame-stats';

describe('createFrameStats', () => {
  it('reports the mean of what was pushed', () => {
    const s = createFrameStats(4);
    [10, 20, 30, 40].forEach((ms) => s.push(ms));
    expect(s.count).toBe(4);
    expect(s.mean).toBeCloseTo(25, 6);
  });

  it('returns percentiles from the ring', () => {
    const s = createFrameStats(100);
    for (let i = 1; i <= 100; i += 1) s.push(i);
    expect(s.percentile(50)).toBeCloseTo(50, 0);
    expect(s.percentile(95)).toBeCloseTo(95, 0);
  });

  it('drops the oldest sample when full', () => {
    const s = createFrameStats(3);
    [1, 2, 3, 4].forEach((ms) => s.push(ms));
    expect(s.count).toBe(3);
    expect(s.mean).toBeCloseTo(3, 6);
  });

  it('ignores non-finite samples', () => {
    const s = createFrameStats(4);
    s.push(Number.NaN);
    expect(s.count).toBe(0);
  });
});
