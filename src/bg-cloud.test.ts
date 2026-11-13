import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import {
  BG_Y_MAX,
  BG_Y_MIN,
  HEADING_BIN_DEG,
  HEADING_BIN_HYST_DEG,
  PATCH_AZIMUTH_MAX_DEG,
  PATCH_COUNT_MAX,
  PATCH_COUNT_MIN,
  PATCH_FADE_IN_S,
  PATCH_SILHOUETTE_DARKEN,
  headingBinHysteresis,
  headingBinIndex,
  initDomeHorizon,
  mergeHeadingPatches,
  patchesFor,
  patchOffsetXZ,
  type PatchSpec,
} from './bg-cloud';

/** 纯函数 patch：散布/量化/合并/定位（node 下直接测，不需要 renderer）。 */
describe('patchesFor', () => {
  it('scatters 5-9 visible patches ahead in the fade band', () => {
    const ps = patchesFor(7, 0);
    expect(ps.length).toBeGreaterThanOrEqual(PATCH_COUNT_MIN);
    expect(ps.length).toBeLessThanOrEqual(PATCH_COUNT_MAX);
    for (const p of ps) {
      expect(p.distanceMetres).toBeGreaterThanOrEqual(1300);
      expect(p.distanceMetres).toBeLessThanOrEqual(1700);
      expect(Math.abs(p.azimuthDeg)).toBeLessThanOrEqual(PATCH_AZIMUTH_MAX_DEG);
      expect(p.sizeMetres).toBeGreaterThanOrEqual(80);
      expect(p.sizeMetres).toBeLessThanOrEqual(200);
      expect(p.alpha).toBeGreaterThanOrEqual(0.5); // 全部过可见门：spec 数 = 可见数
      expect(p.alpha).toBeLessThanOrEqual(0.8);
    }
  });

  it('is deterministic per (seed, bin)', () => {
    expect(patchesFor(7, 0)).toEqual(patchesFor(7, 0));
    expect(patchesFor(7, 0)).not.toEqual(patchesFor(8, 0));
    expect(patchesFor(7, 0)).not.toEqual(patchesFor(7, 1)); // 跨 bin 散布不同（滑窗补生的来源）
  });

  it('keeps every heading bin (-9..8) inside spec ranges and the horizon y band', () => {
    for (let bin = -9; bin <= 8; bin += 1) {
      const ps = patchesFor(7, bin);
      expect(ps.length).toBeGreaterThanOrEqual(PATCH_COUNT_MIN);
      expect(ps.length).toBeLessThanOrEqual(PATCH_COUNT_MAX);
      for (const p of ps) {
        expect(p.distanceMetres).toBeGreaterThanOrEqual(1300);
        expect(p.distanceMetres).toBeLessThanOrEqual(1700);
        expect(Math.abs(p.azimuthDeg)).toBeLessThanOrEqual(PATCH_AZIMUTH_MAX_DEG);
        expect(p.yMetres).toBeGreaterThanOrEqual(BG_Y_MIN); // 350：海天线高度带下缘
        expect(p.yMetres).toBeLessThanOrEqual(BG_Y_MAX); // 440
        expect(p.alpha).toBeGreaterThanOrEqual(0.5);
        expect(p.alpha).toBeLessThanOrEqual(0.8);
      }
    }
  });

  it('does not pile every patch onto one spot (散布不要密布)', () => {
    const ps = patchesFor(7, 0);
    const azimuths = ps.map((p) => p.azimuthDeg).sort((a, b) => a - b);
    const spread = azimuths[azimuths.length - 1] - azimuths[0];
    expect(spread).toBeGreaterThanOrEqual(20);
  });

  it('keeps the ring inside the horizontal frustum so the band is never empty (DOME-01)', () => {
    // 视野半角：fovY 60°、canvas 434×772 → atan(tan(30°) × 434/772) ≈ 18.0°。
    // patch 敷在 ±PATCH_AZIMUTH_MAX_DEG：超得太多，绝大多数团就永远在投影之外，
    // 探针带里只剩一两团（DOME-01 实测 8 团有 7 团在屏外，足迹 32×17 px）。
    const HALF_FOV_X_DEG = 18.0;
    expect(PATCH_AZIMUTH_MAX_DEG).toBeLessThanOrEqual(HALF_FOV_X_DEG + 2);
  });
});

describe('PATCH_SILHOUETTE_DARKEN (背光剪影压暗)', () => {
  it('stays in a range that darkens the silhouette without turning it into a black band', () => {
    // 0 等于不压（DOME-01 体量修复前就是看不见的）；>0.6 会把云压成不透明黑带。
    expect(PATCH_SILHOUETTE_DARKEN).toBeGreaterThan(0);
    expect(PATCH_SILHOUETTE_DARKEN).toBeLessThanOrEqual(0.6);
  });
});

describe('headingBinIndex (18 bins, ±180° 共用 −9)', () => {
  it('quantizes yaw onto 20° bin centers', () => {
    expect(HEADING_BIN_DEG).toBe(20);
    expect(headingBinIndex(0)).toBe(0);
    expect(headingBinIndex(9.9)).toBe(0);
    expect(headingBinIndex(10.1)).toBe(1);
    expect(headingBinIndex(19)).toBe(1);
    expect(headingBinIndex(21)).toBe(1);
    expect(headingBinIndex(-10.1)).toBe(-1);
    expect(headingBinIndex(-19)).toBe(-1);
    expect(headingBinIndex(-21)).toBe(-1);
  });

  it('wraps both ends of the circle onto the shared -9 bin', () => {
    expect(headingBinIndex(180)).toBe(-9);
    expect(headingBinIndex(-180)).toBe(-9);
    expect(headingBinIndex(179)).toBe(-9); // round(8.95) = 9 → (18 mod 18) − 9
    expect(headingBinIndex(169)).toBe(8);
    // 恰在半档边界上 JS Math.round 向 +∞ 取整：−170 → bin −8（中心 −160），非对称是既定语义。
    expect(headingBinIndex(-170)).toBe(-8);
    expect(headingBinIndex(-169)).toBe(-8);
    // 非常规输入也不出界：binIndex 恒落在 −9..8。
    for (const yaw of [-720, -360.5, -100, 0, 100, 360.5, 720]) {
      const b = headingBinIndex(yaw);
      expect(b).toBeGreaterThanOrEqual(-9);
      expect(b).toBeLessThanOrEqual(8);
    }
  });
});

describe('headingBinHysteresis (2° 滞回)', () => {
  it('stays in the current bin until yaw crosses the boundary by > 2°', () => {
    expect(HEADING_BIN_HYST_DEG).toBe(2);
    // 半档宽 10° + 滞回 2°：12° 内不换 bin。
    expect(headingBinHysteresis(0, 0)).toBe(0);
    expect(headingBinHysteresis(12.0, 0)).toBe(0);
    expect(headingBinHysteresis(12.1, 0)).toBe(1);
    expect(headingBinHysteresis(-12.0, 0)).toBe(0);
    expect(headingBinHysteresis(-12.1, 0)).toBe(-1);
    // 换过去之后，往回抖不出滞回带（对当前 bin 中心量距离）。
    expect(headingBinHysteresis(11.0, 1)).toBe(1);
    expect(headingBinHysteresis(-11.0, -1)).toBe(-1);
  });

  it('handles the ±180 wrap around bin -9', () => {
    expect(headingBinHysteresis(179, -9)).toBe(-9);
    expect(headingBinHysteresis(-179, -9)).toBe(-9);
    expect(headingBinHysteresis(168, -9)).toBe(-9); // 恰在 12° 阈值上：不动
    expect(headingBinHysteresis(-168, -9)).toBe(-9);
    expect(headingBinHysteresis(167.9, -9)).toBe(8); // 越界 0.1° 以上才换
    expect(headingBinHysteresis(-167.9, -9)).toBe(-8);
  });
});

describe('patchOffsetXZ (定位公式符号：0 = −Z 正前，右转为负)', () => {
  it('places azimuth 0 straight ahead along -Z, never behind', () => {
    const o = patchOffsetXZ(1500, 0);
    expect(o.x).toBeCloseTo(0, 9);
    expect(o.z).toBeCloseTo(-1500, 9); // 正前是 −Z，不是 +Z
  });

  it('puts positive azimuth on the -X side (left), mirroring the game yaw convention', () => {
    const o = patchOffsetXZ(1500, 90);
    expect(o.x).toBeCloseTo(-1500, 9);
    expect(o.z).toBeCloseTo(0, 9);
    const d = patchOffsetXZ(1500, 40);
    expect(d.x).toBeLessThan(0); // bin 中心 + 40° 仍在前方偏左，绝不镜像到身后
    expect(d.z).toBeLessThan(0);
    const w = patchOffsetXZ(1500, -40);
    expect(w.x).toBeGreaterThan(0);
    expect(w.z).toBeLessThan(0);
  });
});

describe('mergeHeadingPatches (跨 bin 滑窗合并)', () => {
  /** 旧组用 seed 9999 标记，好和 patchesFor 补生的新对象区分开。 */
  const spec = (azimuthDeg: number): PatchSpec => ({
    distanceMetres: 1500,
    azimuthDeg,
    yMetres: 400,
    sizeMetres: 120,
    alpha: 0.6,
    seed: 9999,
  });

  it('keeps old patches whose absolute azimuth falls in the new sector, re-based to the new bin', () => {
    // 旧 bin 0（中心 0°）：绝对方位 −35 / 0 / +35。新 bin 1（中心 20°，扇区 −20..+60）。
    const old = [spec(-35), spec(0), spec(35)];
    const merged = mergeHeadingPatches(0, old, 1, 7, 12);
    const kept = merged.filter((p) => p.seed === 9999);
    // −35 → 距新中心 55°：出扇区被丢；0 → 保留，换算成 −20；+35 → 保留，+15。
    expect(kept.map((p) => p.azimuthDeg).sort((a, b) => a - b)).toEqual([-20, 15]);
  });

  it('spawns only the newly-exposed 20° wedge from the new bin', () => {
    // 从 bin 0 → bin 1：新暴露楔形 = 绝对方位 (40, 60]（在旧扇区之外、新扇区之内）。
    const old = [spec(0)];
    const merged = mergeHeadingPatches(0, old, 1, 7, 12);
    const spawned = merged.filter((p) => !old.includes(p)); // 保留的旧组是同一引用
    expect(spawned.length).toBeGreaterThan(0);
    for (const p of spawned) {
      const abs = 1 * HEADING_BIN_DEG + p.azimuthDeg;
      expect(abs).toBeGreaterThan(PATCH_AZIMUTH_MAX_DEG); // 不在旧扇区
      expect(abs).toBeLessThanOrEqual(PATCH_AZIMUTH_MAX_DEG + HEADING_BIN_DEG); // 不超出新扇区
      expect(p.seed).not.toBe(9999);
    }
  });

  it('caps the merged set at PATCH_COUNT_MAX and drops far-from-view-axis first', () => {
    // 8 个旧 patch 全落在新扇区（abs 0..35 ⊂ [0,40]），视轴在 12°（跨 bin 瞬间的实际航向）。
    const old: PatchSpec[] = [];
    for (let i = 0; i < 8; i += 1) old.push(spec(i * 5));
    const merged = mergeHeadingPatches(0, old, 1, 7, 12);
    expect(merged.length).toBeLessThanOrEqual(PATCH_COUNT_MAX);

    // 候选全集 = 旧组（可保留的）∪ 新组楔形补生（用同一 RNG 重算出值相等的集合）。
    // 补生判据与实现同源：距新 bin 中心 ≤ MAX、距旧 bin 中心 > MAX。
    // 一律用**绝对**方位（相对值只在 keptSpawned 里做匹配时换算），否则 distFromAxis 会算错。
    const distFromAxis = (abs: number): number => Math.abs(((abs - 12 + 540) % 360) - 180);
    const distFrom = (abs: number, center: number): number =>
      Math.abs(((abs - center + 540) % 360) - 180);
    const spawnedAbs = patchesFor(7, 1)
      .map((p) => 1 * HEADING_BIN_DEG + p.azimuthDeg)
      .filter(
        (abs) =>
          distFrom(abs, 1 * HEADING_BIN_DEG) <= PATCH_AZIMUTH_MAX_DEG &&
          distFrom(abs, 0 * HEADING_BIN_DEG) > PATCH_AZIMUTH_MAX_DEG,
      );
    const keptOldAbs = old
      .filter((o) => merged.includes(o))
      .map((o) => o.azimuthDeg + 20);
    const keptSpawned = merged.filter((p) => !old.includes(p)).map((p) => p.azimuthDeg);
    const keptDists = [...keptOldAbs, ...keptSpawned.map((az) => az + 20)].map(distFromAxis);
    const candidateCount = old.length + spawnedAbs.length;
    expect(merged.length).toBe(Math.min(PATCH_COUNT_MAX, candidateCount));
    if (merged.length < candidateCount) {
      // 丢弃规则：被丢的每个候选离视轴都不比任何留下来的更近。
      const maxKept = Math.max(...keptDists);
      const droppedOld = old
        .filter((o) => !merged.includes(o))
        .map((o) => distFromAxis(o.azimuthDeg + 20));
      for (const d of droppedOld) expect(d).toBeGreaterThanOrEqual(maxKept);
      const droppedSpawned = spawnedAbs
        .filter((abs) => !keptSpawned.some((k) => Math.abs(k - (abs - 20)) < 1e-9))
        .map(distFromAxis);
      for (const d of droppedSpawned) expect(d).toBeGreaterThanOrEqual(maxKept);
    }
  });

  it('is deterministic for identical inputs', () => {
    // 注意合并会原地改写输入的 azimuthDeg（换算到新 bin）——确定性以同值新输入为准。
    const a = mergeHeadingPatches(0, [spec(-10), spec(30)], 1, 7, 12);
    const b = mergeHeadingPatches(0, [spec(-10), spec(30)], 1, 7, 12);
    expect(a).toEqual(b);
  });
});

/** 句柄：node 下也能构造（DataTexture + BufferGeometry 不需要 GPU）。 */
describe('initDomeHorizon handles', () => {
  const sun = new THREE.Vector3(0, 0.12, -1).normalize();
  const BANDS = [
    [0.1, 0.1, 0.2],
    [0.2, 0.2, 0.3],
    [0.3, 0.3, 0.4],
    [0.4, 0.4, 0.5],
  ] as const;

  function makeView(x: number, y: number, z: number, headingRad: number) {
    return { camera: new THREE.Vector3(x, y, z), radPerPixel: 6.014e-4, headingRad };
  }

  it('spawns the initial sector on the first update and reports count', () => {
    const scene = new THREE.Scene();
    const h = initDomeHorizon(scene, { seed: 7, bands: BANDS, sunDir: sun });
    const yaw0 = headingBinIndex(0);
    h.update(0, sun, makeView(0, 60, -300, 0));
    expect(h.count).toBe(patchesFor(7, yaw0).length);
    expect(h.count).toBeGreaterThanOrEqual(PATCH_COUNT_MIN);
    h.dispose();
  });

  it('keeps count within the cap across heading changes (sliding window)', () => {
    const scene = new THREE.Scene();
    const h = initDomeHorizon(scene, { seed: 7, bands: [], sunDir: sun });
    h.update(0, sun, makeView(0, 60, -300, 0));
    // 满舵 rate 71.6°/s 的离散采样扫两圈：任何时刻存活 patch 都 ≤ PATCH_COUNT_MAX。
    for (let deg = 0; deg <= 720; deg += 4) {
      const t = deg / 71.6;
      h.update(t, sun, makeView(deg * 2, 60, -300, (-deg * Math.PI) / 180));
      expect(h.count).toBeLessThanOrEqual(PATCH_COUNT_MAX);
      expect(h.count).toBeGreaterThanOrEqual(1); // 永不清空：前方永远有云
    }
    h.dispose();
  });

  it('accepts palette / sun color / visibility / double dispose without throwing', () => {
    const scene = new THREE.Scene();
    const h = initDomeHorizon(scene, { seed: 7, bands: [], sunDir: sun });
    h.update(0, sun, makeView(0, 60, -300, 0));
    expect(() =>
      h.setCloudPalette(
        [
          [0.1, 0.1, 0.12],
          [0.2, 0.2, 0.24],
          [0.5, 0.3, 0.35],
          [0.55, 0.4, 0.4],
        ],
        [0.15, 0.19, 0.31],
      ),
    ).not.toThrow();
    expect(() => h.setSunColor([1, 0.78, 0.62])).not.toThrow();
    expect(() => h.setVisible(false)).not.toThrow();
    expect(() => h.update(1, sun, makeView(0, 60, -300, 0))).not.toThrow(); // 隐藏也要能更新
    expect(() => h.setVisible(true)).not.toThrow();
    h.dispose();
    expect(() => h.dispose()).not.toThrow(); // 幂等
    expect(() => h.update(2, sun, makeView(0, 60, -300, 0))).not.toThrow();
  });

  it('tolerates a missing view and non-finite input (never throws)', () => {
    const scene = new THREE.Scene();
    const h = initDomeHorizon(scene, { seed: 7, bands: [], sunDir: sun });
    expect(() => h.update(0, sun)).not.toThrow();
    expect(() => h.update(Number.NaN, sun, makeView(0, 60, -300, Number.NaN))).not.toThrow();
    h.dispose();
  });

  it('exposes PATCH_FADE_IN_S at 0.15 (补生淡入，满舵下入画前走完)', () => {
    expect(PATCH_FADE_IN_S).toBeCloseTo(0.15, 6);
  });
});

/** Task 2（2026-11-13）：背景层改名 bg-cloud 后必须自持——体积层删除时不受牵连。 */
describe('bg-cloud 模块自持（不再依赖 dome 链）', () => {
  it('背景层不再依赖 dome 链：模块内无 dome-cloud/DOME_SLAB 引用，高度常量自持', () => {
    // tsconfig 只挂 vite/client 类型（node:fs 过不了 tsc），读源码走 repo 的 '?raw' glob 惯例。
    const sources = import.meta.glob('./bg-cloud.ts', {
      query: '?raw',
      eager: true,
      import: 'default',
    }) as Record<string, string>;
    const src = sources['./bg-cloud.ts'];
    expect(src).not.toMatch(/dome-cloud|DOME_SLAB/); // 同时盖住两条 import 与头注释残留
    expect(BG_Y_MIN).toBe(350);
    expect(BG_Y_MAX).toBe(440);
  });
});
