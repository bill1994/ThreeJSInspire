/**
 * P2-1 云门关卡（spec Q2-3）：散布只保证「8.7s 遇一朵」，不保证「从侧方掠过」。
 * 门调度是纯函数：每 10s 检查一次，前侧方 100~500m × 侧向 30~90m 无云，
 * 就把掉队最远的那朵搬到门位（前 200~400m × 侧 40~70m，左右交替）。
 * 搬家的是掉队朵（在身后、看不见），新门落在雾里（600m 起淡），两头都不闪现。
 */
import { describe, it, expect } from 'vitest';
import {
  GATE_PERIOD,
  GATE_SIDE_MIN,
  GATE_SIDE_MAX,
  GATE_AHEAD_MIN,
  GATE_AHEAD_MAX,
  gateDue,
  gateSlot,
  gateCandidate,
  pickGateSource,
} from './cloud-gates';

describe('cloud gates (P2-1)', () => {
  it('pins the gate geometry: 10s 一拍，前 200~400m × 侧 40~70m', () => {
    expect(GATE_PERIOD).toBe(10);
    expect(GATE_SIDE_MIN).toBe(40);
    expect(GATE_SIDE_MAX).toBe(70);
    expect(GATE_AHEAD_MIN).toBe(200);
    expect(GATE_AHEAD_MAX).toBe(400);
  });

  it('gateDue: 满 10s 才开门，非有限上次=首帧直接开', () => {
    expect(gateDue(0, 9.9)).toBe(false);
    expect(gateDue(0, 10)).toBe(true);
    expect(gateDue(5, 15.2)).toBe(true);
    expect(gateDue(Number.NaN, 100)).toBe(true);
    expect(gateDue(0, Number.NaN)).toBe(false);
  });

  it('gateSlot: 门位落在框里，左右交替', () => {
    for (let i = 0; i < 8; i += 1) {
      const s = gateSlot(i);
      expect(s.ahead).toBeGreaterThanOrEqual(200);
      expect(s.ahead).toBeLessThanOrEqual(400);
      expect(Math.abs(s.side)).toBeGreaterThanOrEqual(40);
      expect(Math.abs(s.side)).toBeLessThanOrEqual(70);
    }
    expect(Math.sign(gateSlot(0).side)).not.toBe(Math.sign(gateSlot(1).side));
    expect(gateSlot(0)).toEqual(gateSlot(0));
  });

  it('gateCandidate: 只有前侧方框里的云才算门', () => {
    const cam = { x: 0, z: 0, dirX: 0, dirZ: -1 };
    // 前 250m、侧 55m：正牌门。
    expect(gateCandidate([{ x: 55, z: -250 }], cam)).toBe(true);
    // 身后：掉队，不算。
    expect(gateCandidate([{ x: 55, z: 250 }], cam)).toBe(false);
    // 正前方：那是穿云 hit，不是掠过。
    expect(gateCandidate([{ x: 5, z: -250 }], cam)).toBe(false);
    // 太远（700m）：雾里，看不见参照。
    expect(gateCandidate([{ x: 55, z: -700 }], cam)).toBe(false);
    // 空场：当然没门。
    expect(gateCandidate([], cam)).toBe(false);
  });

  it('pickGateSource: 搬掉队最远的（ahead 最小），不动门里其它的', () => {
    const cam = { x: 0, z: 0, dirX: 0, dirZ: -1 };
    const spots = [
      { x: 0, z: 100 }, // 身后 100m
      { x: 0, z: -300 }, // 前方 300m
      { x: 0, z: 500 }, // 身后 500m：最远
    ];
    expect(pickGateSource(spots, cam)).toBe(2);
    expect(pickGateSource([], cam)).toBe(-1);
  });
});
