import { describe, expect, it } from 'vitest';

import {
  BASE_RANGE,
  CLOUD_COUNT_RANGE,
  DIST_RANGE,
  HEIGHT_RANGE,
  MAX_COVERAGE,
  MAX_EMPTY_ARC_DEG,
  MIN_ANGULAR_GAP_EXTRA_DEG,
  TOWER_DIST_MIN,
  WIDTH_MID_RANGE,
  WIDTH_TOWER_RANGE,
  billowField,
  layoutAzToXz,
  layoutClouds,
  layoutWindow,
  type CloudLayout,
} from './bg-cumulus-layout';

const SEEDS = [7, 1, 2, 3, 42, 999, 2026];

/** 半精度 → float（测试内自持解码，避免依赖 DataUtils 的存在性）。 */
function halfToFloat(h: number): number {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const m = h & 0x03ff;
  if (e === 0) return m * Math.pow(2, -24) * (s ? -1 : 1);
  if (e === 0x1f) return m ? NaN : (s ? -Infinity : Infinity);
  return (1 + m / 1024) * Math.pow(2, e - 15) * (s ? -1 : 1);
}

/** 云 i 的角宽半径（度）：2·atan(宽/2/距离) 的一半。 */
function halfWidthDeg(c: CloudLayout): number {
  return (Math.atan(c.widthMetres / 2 / c.distanceMetres) * 180) / Math.PI;
}

describe('bg-cumulus-layout 布局层', () => {
  it('同 seed 两次调用逐值恒等（确定性）', () => {
    for (const s of SEEDS) {
      expect(layoutClouds(s)).toEqual(layoutClouds(s));
    }
  });

  it('数量 7–9、恰 2 朵塔、全部尺寸落带、塔在远半段', () => {
    for (const s of SEEDS) {
      const cs = layoutClouds(s);
      expect(cs.length).toBeGreaterThanOrEqual(CLOUD_COUNT_RANGE[0]);
      expect(cs.length).toBeLessThanOrEqual(CLOUD_COUNT_RANGE[1]);
      expect(cs.filter((c) => c.kind === 'tower')).toHaveLength(2);
      for (const c of cs) {
        expect(c.base).toBeGreaterThanOrEqual(BASE_RANGE[0]);
        expect(c.base).toBeLessThanOrEqual(BASE_RANGE[1]);
        expect(c.heightMetres).toBeGreaterThanOrEqual(HEIGHT_RANGE[0]);
        expect(c.heightMetres).toBeLessThanOrEqual(HEIGHT_RANGE[1]);
        expect(c.distanceMetres).toBeGreaterThanOrEqual(DIST_RANGE[0]);
        expect(c.distanceMetres).toBeLessThanOrEqual(DIST_RANGE[1]);
        expect(c.azimuthDeg).toBeGreaterThanOrEqual(0);
        expect(c.azimuthDeg).toBeLessThan(360);
        if (c.kind === 'tower') {
          expect(c.widthMetres).toBeGreaterThanOrEqual(WIDTH_TOWER_RANGE[0]);
          expect(c.widthMetres).toBeLessThanOrEqual(WIDTH_TOWER_RANGE[1]);
          expect(c.distanceMetres).toBeGreaterThanOrEqual(TOWER_DIST_MIN);
        } else {
          expect(c.widthMetres).toBeGreaterThanOrEqual(WIDTH_MID_RANGE[0]);
          expect(c.widthMetres).toBeLessThanOrEqual(WIDTH_MID_RANGE[1]);
        }
      }
    }
  });

  it('角约束：相邻角隙 ≥ 10°、最大空档 ≤ 45°、总角覆盖 ≤ 70%', () => {
    for (const s of SEEDS) {
      const cs = layoutClouds(s);
      const n = cs.length;
      const order = cs.map((_, i) => i).sort((a, b) => cs[a].azimuthDeg - cs[b].azimuthDeg);
      let sumWidth = 0;
      let maxEmpty = -Infinity;
      for (let k = 0; k < n; k += 1) {
        const i = order[k];
        const j = order[(k + 1) % n];
        let centerGap = cs[j].azimuthDeg - cs[i].azimuthDeg;
        if (k === n - 1) centerGap += 360;
        const empty = centerGap - halfWidthDeg(cs[i]) - halfWidthDeg(cs[j]);
        sumWidth += 2 * halfWidthDeg(cs[i]);
        maxEmpty = Math.max(maxEmpty, empty);
        expect(empty).toBeGreaterThanOrEqual(MIN_ANGULAR_GAP_EXTRA_DEG);
      }
      expect(maxEmpty).toBeLessThanOrEqual(MAX_EMPTY_ARC_DEG);
      expect(sumWidth).toBeLessThanOrEqual(360 * MAX_COVERAGE);
    }
  });

  it('layoutWindow 派生 march 窗口：minBase 低于全部云底、maxDistance 覆盖全部云', () => {
    const cs = layoutClouds(7);
    const w = layoutWindow(cs);
    expect(w.minBase).toBeLessThanOrEqual(Math.min(...cs.map((c) => c.base)));
    expect(w.maxDistance).toBeGreaterThanOrEqual(Math.max(...cs.map((c) => c.distanceMetres)));
  });

  it('包围球包住全部 puff（含 scale×4 billow 余量）', () => {
    for (const s of SEEDS) {
      for (const c of layoutClouds(s)) {
        for (const [px, py, pz, pr] of c.puffs) {
          const d = Math.hypot(px - c.bounds.cx, py - c.bounds.cy, pz - c.bounds.cz);
          expect(d + pr).toBeLessThanOrEqual(c.bounds.r + 1e-6);
        }
        expect(c.puffs.length).toBeGreaterThan(0);
      }
    }
  });

  it('billowField：确定性、32³ RGBA、值域 [0,1]、Repeat 接缝连续', () => {
    const f1 = billowField(32);
    const f2 = billowField(32);
    expect(f1).toEqual(f2);
    expect(f1.length).toBe(32 * 32 * 32 * 4);
    let bad = 0;
    for (let i = 0; i < f1.length; i += 1) {
      const v = halfToFloat(f1[i]);
      if (!(v >= 0 && v <= 1.0001)) bad += 1;
    }
    expect(bad).toBe(0);
    // Repeat 接缝：x=0 与 x=31 的 r 通道差异应远小于斑块尺度
    const at = (x: number, y: number, z: number, ch: number) =>
      halfToFloat(f1[((z * 32 + y) * 32 + x) * 4 + ch]);
    let maxSeam = 0;
    for (let z = 0; z < 32; z += 4) {
      for (let y = 0; y < 32; y += 4) {
        maxSeam = Math.max(maxSeam, Math.abs(at(0, y, z, 0) - at(31, y, z, 0)));
      }
    }
    expect(maxSeam).toBeLessThan(0.4);
  });
});

// ---- bg-cumulus 计划 Task 3：环排布方位落在测量系（镜像修复）----------------

describe('layoutAzToXz / 环排布方位（测量系唯一出口）', () => {
  it('layoutAzToXz：az 90 → +X、az 0 → −Z（az = atan2(x, −z)，探针/游戏航向同一约定）', () => {
    const east = layoutAzToXz(90, 5000);
    expect(east.x).toBeCloseTo(5000, 6);
    expect(Math.abs(east.z)).toBeLessThan(1e-6);
    const north = layoutAzToXz(0, 5000);
    expect(Math.abs(north.x)).toBeLessThan(1e-6);
    expect(north.z).toBeCloseTo(-5000, 6);
  });

  it('layoutAzToXz 往返：atan2(x, −z) 读回等于入参方位（全象限）', () => {
    for (const az of [0, 30, 90, 137, 180, 223, 270, 315, 359]) {
      const { x, z } = layoutAzToXz(az, 1234);
      const readback = ((Math.atan2(x, -z) * 180) / Math.PI + 360) % 360;
      expect(readback).toBeCloseTo(az % 360, 6);
    }
  });

  it('layoutClouds 每朵云的摆放方位与 azimuthDeg 同系（镜像修复，探针 layoutMatch 的前提）', () => {
    // Task 3 取证：buildOnce 曾用 (−sin, −cos) 的镜像约定，metadata azimuthDeg=A 的云
    // 实际摆在测量系 −A。采样链的镜像（CubeTextureNode.setupUV）当时恰好把它抵消，
    // 但两层各自都是错的——修采样链（烘焙射线 x 预补偿）必须同时修这层。
    // 容差 15°：puff AABB 中心对名义中心的离散（heap/cumulus 随机鼓包）量级几度；
    // 镜像误差 = 2·min(A, 360−A)，中段方位的云一票否决。
    for (const s of SEEDS) {
      for (const c of layoutClouds(s)) {
        const azMeas = ((Math.atan2(c.bounds.cx, -c.bounds.cz) * 180) / Math.PI + 360) % 360;
        const err = Math.abs(((azMeas - c.azimuthDeg + 540) % 360) - 180);
        expect(err).toBeLessThan(15);
      }
    }
  });
});
