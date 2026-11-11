/**
 * P2-2 G 黑边（spec §3-4）：dive>0.7 的改出瞬间（dive01 跌回 0.7），
 * 0.25s 暗角 0.25。只做大动作——巡航小起伏不配拥有姓名。
 * FOV 回弹不写新代码：rig 的 fovKick 本来就跟 speed01（改出掉速 → 自动回弹），
 * 这里只锁「G 黑边自己不碰 FOV 链」（Q2-4 冻结令）。
 */
import { describe, it, expect } from 'vitest';
import { G_FLASH_PEAK, G_FLASH_TIME, G_DIVE_ARM, gFlashTrigger, gFlashDecay } from './game';

describe('G flash (P2-2)', () => {
  it('pins the beat: 0.7 臂、0.25 峰、0.25s', () => {
    expect(G_DIVE_ARM).toBe(0.7);
    expect(G_FLASH_PEAK).toBe(0.25);
    expect(G_FLASH_TIME).toBe(0.25);
  });

  it('只在跌回 0.7 的边沿开火（改出），进入时不开', () => {
    expect(gFlashTrigger(0.8, 0.6)).toBe(true); // 改出：开火
    expect(gFlashTrigger(0.6, 0.8)).toBe(false); // 进入：不开
    expect(gFlashTrigger(0.9, 0.85)).toBe(false); // 一直在里面：不开
    expect(gFlashTrigger(0.5, 0.4)).toBe(false); // 从没进去过：不开
    expect(gFlashTrigger(Number.NaN, 0.6)).toBe(false);
  });

  it('线性 0.25s 回零，不欠不超', () => {
    expect(gFlashDecay(0.25, 1 / 60)).toBeCloseTo(0.25 - 1 / 60, 9);
    expect(gFlashDecay(0.25, 0.25)).toBe(0);
    expect(gFlashDecay(0.25, 1)).toBe(0);
    expect(gFlashDecay(0, 1 / 60)).toBe(0);
    expect(gFlashDecay(Number.NaN, 1 / 60)).toBe(0);
  });
});
