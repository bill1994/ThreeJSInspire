/**
 * P2-3 海面近场流速暗示·其一（spec Q2-2）：wake ribbon 上的 foam streak
 * 行波——顶点 alpha 行波，不开新纹理通道（ribbon 几何本来就没有 uv，
 * MeshBasicMaterial 纹理反而要动顶点布局；行波是顶点色原生手段）。
 * 速度只调「流得多快」，不调「有多亮」：speed01=0 时条纹静止但仍在。
 */
import { describe, it, expect } from 'vitest';
import { WAKE_STREAK_DEPTH, WAKE_STREAK_K, WAKE_STREAK_OMEGA, wakeStreak } from './feel';

describe('wake streaks (P2-3)', () => {
  it('pins the depth: 0.2 行波，alpha 在 0.8..1 之间呼吸', () => {
    expect(WAKE_STREAK_DEPTH).toBe(0.2);
    for (let i = 0; i < 48; i += 1) {
      const s = wakeStreak(i, 1.7, 0.5);
      expect(s).toBeGreaterThanOrEqual(0.8);
      expect(s).toBeLessThanOrEqual(1.0);
    }
  });

  it('行波方向：条纹随时间向尾部（+i）走，相速=空间频率/时间频率', () => {
    // 同一相位：(i+1)*K - (t+dt)*w == i*K - t*w，取 dt = K/w(s=1)。
    const wFull = WAKE_STREAK_OMEGA * (1 + 3 * 1);
    const dt = WAKE_STREAK_K / wFull;
    expect(wakeStreak(5, dt, 1)).toBeCloseTo(wakeStreak(4, 0, 1), 9);
    // 反向不成立：向前走对不上。
    expect(Math.abs(wakeStreak(3, dt, 1) - wakeStreak(4, 0, 1)) > 1e-3).toBe(true);
  });

  it('速度调流速不调亮度：speed01 只改相位速度，值域不动', () => {
    const slow = wakeStreak(10, 3.3, 0);
    const fast = wakeStreak(10, 3.3, 1);
    expect(slow).toBeGreaterThanOrEqual(0.8);
    expect(fast).toBeGreaterThanOrEqual(0.8);
    // 同一时刻不同速度相位不同（除非恰好撞周期——3.3s/10段选的是错开点）。
    expect(Math.abs(slow - fast) > 1e-3).toBe(true);
  });

  it('NaN 输入不炸：回 1（无条纹，原样 alpha）', () => {
    expect(wakeStreak(5, Number.NaN, 0.5)).toBe(1);
    expect(wakeStreak(5, 1, Number.NaN)).toBe(1);
  });
});
