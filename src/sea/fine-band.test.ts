import { describe, expect, it } from 'vitest';

import { BAND_SPLIT_METRES, CASCADES } from './cascades';
import { accumulateSpectrum, buildSpectrum, spectrumScaleToPeak, type ComplexField } from './spectrum';

/** C1 子带生产口径（material.ts 模块常量的 golden 契约副本；seed 已被 cascades.test 钉）。 */
const SUB_OPTS = {
  n: 256,
  tileMetres: 192,
  bandMetres: [32, 128] as readonly [number, number],
  windSpeed: 9,
  windDirRad: 0.212,
  seed: 20261106,
};

const C1 = CASCADES[1];
const FINE_OPTS = {
  n: 256,
  tileMetres: 192,
  bandMetres: C1.fineBandMetres ?? [4, 27.5],
  windSpeed: 9,
  windDirRad: 0.212,
  seed: C1.fineSeed ?? 20261107,
};

const TILE = 192;
const N = 256;
const DK = (2 * Math.PI) / TILE;

/** 波长窗口（米）→ 模式半径（整数格点 hypot）范围。λ = tile/r。 */
function radiusRange(loMetres: number, hiMetres: number): [number, number] {
  return [TILE / hiMetres, TILE / loMetres];
}

describe('fine band — 字段 pin（子带契约不动 + 细带字段就位）', () => {
  it('CASCADES[1]: bandMetres [32,128]、amplitudePeak 0.1 不变；细带字段 = [4,27.5]/0.04/20261107', () => {
    expect(C1.bandMetres).toEqual([32, 128]);
    expect(C1.amplitudePeak).toBe(0.1);
    expect(BAND_SPLIT_METRES).toBe(128);
    expect(C1.fineBandMetres).toEqual([4, 27.5]);
    expect(C1.fineCrestMetres).toBe(0.04);
    expect(C1.fineSeed).toBe(20261107);
  });
});

describe('fine band — 格点零交集（λ=32 绝不双计）', () => {
  it('n=256/tile=192 全格点：子带窗 [32,128] 与细带窗 [4,27.5] 无共同格点；细带半径恰为 7–48', () => {
    const [subLo, subHi] = radiusRange(32, 128); // [1.5, 6]
    const [fineLo, fineHi] = radiusRange(4, 27.5); // [6.98…, 48]
    let fineRadii = new Set<number>();
    for (let nz = 0; nz < N; nz += 1) {
      for (let nx = 0; nx < N; nx += 1) {
        if (nx === 0 && nz === 0) continue; // DC
        if (nx === N / 2 || nz === N / 2) continue; // Nyquist lines
        const kz = ((nz <= N / 2 ? nz : nz - N) * DK);
        const kx = ((nx <= N / 2 ? nx : nx - N) * DK);
        const r = Math.hypot(kx, kz) / DK;
        const inSub = r >= subLo && r <= subHi;
        const inFine = r >= fineLo && r <= fineHi;
        if (inSub && inFine) throw new Error(`格点半径 ${r} 同时落入两窗`);
        if (inFine) fineRadii.add(r);
      }
    }
    // 半径 7–48 全部在场（r=7 → λ=27.43 收入；r=48 → λ=4.0 收入；r=6 的 λ=32 归子带）
    expect(Math.min(...fineRadii)).toBe(7);
    expect(Math.max(...fineRadii)).toBe(48);
    for (const r of fineRadii) {
      const lambda = TILE / r;
      expect(lambda).toBeGreaterThanOrEqual(4);
      expect(lambda).toBeLessThanOrEqual(27.5);
    }
  });
});

/** spectrumScaleToPeak 同款配对口径（re[k]+re[−k], im[k]−im[−k]）的能量和，可加 k² 权重。 */
function pairedEnergy(spec: ComplexField, weightK2: boolean): { total: number; below8: number } {
  let total = 0;
  let below8 = 0;
  for (let nz = 0; nz < N; nz += 1) {
    for (let nx = 0; nx < N; nx += 1) {
      const idx = nz * N + nx;
      const pidx = ((N - nz) % N) * N + ((N - nx) % N);
      const re = spec.re[idx] + spec.re[pidx];
      const im = spec.im[idx] - spec.im[pidx];
      let e = re * re + im * im;
      if (weightK2) {
        const kz = (nz <= N / 2 ? nz : nz - N) * DK;
        const kx = (nx <= N / 2 ? nx : nx - N) * DK;
        const k = Math.hypot(kx, kz);
        e *= k * k;
      } else {
        const kz = (nz <= N / 2 ? nz : nz - N) * DK;
        const kx = (nx <= N / 2 ? nx : nx - N) * DK;
        const lambda = (2 * Math.PI) / Math.hypot(kx, kz);
        if (Number.isFinite(lambda) && lambda < 8) below8 += e;
      }
      total += e;
    }
  }
  return { total, below8 };
}

describe('fine band — 能量口径（校准实测钉值）', () => {
  const fineRaw = buildSpectrum(FINE_OPTS);
  const fineScale = spectrumScaleToPeak(fineRaw, C1.fineCrestMetres ?? 0.04);
  const fine: ComplexField = { re: Float32Array.from(fineRaw.re), im: Float32Array.from(fineRaw.im) };
  for (let i = 0; i < fine.re.length; i += 1) {
    fine.re[i] *= fineScale;
    fine.im[i] *= fineScale;
  }
  const subRaw = buildSpectrum(SUB_OPTS);
  const subScale = spectrumScaleToPeak(subRaw, 0.1);
  const sub: ComplexField = { re: Float32Array.from(subRaw.re), im: Float32Array.from(subRaw.im) };
  for (let i = 0; i < sub.re.length; i += 1) {
    sub.re[i] *= subScale;
    sub.im[i] *= subScale;
  }

  it('<8 m 模式能量占比 ≤ 1%（校准实测 0.50%——Phillips ℓ=tile/100 阻尼）', () => {
    const { total, below8 } = pairedEnergy(fine, false);
    expect(below8 / total).toBeLessThanOrEqual(0.01);
  });

  it('细带坡度方差（k² 权重）占子带+细带合计 ≥ 0.5（校准实测 0.623，防退化 seed）', () => {
    const fineSlope = pairedEnergy(fine, true).total;
    const subSlope = pairedEnergy(sub, true).total;
    expect(fineSlope / (subSlope + fineSlope)).toBeGreaterThanOrEqual(0.5);
  });

  it('接线自检：2·scale·rms = 0.040 ± 1e-6（恒等式，失败说明用错缩放函数）', () => {
    const rms = Math.sqrt(pairedEnergy(fineRaw, false).total);
    expect(2 * fineScale * rms).toBeCloseTo(0.04, 5);
  });
});

describe('fine band — 子带逐位不动（真契约）', () => {
  it('合并产物逐格 = subPre + fine（fround 语义）；子带窗格点不受扰动；golden pin 四点', () => {
    const sub = buildSpectrum(SUB_OPTS);
    const subPre: ComplexField = { re: Float32Array.from(sub.re), im: Float32Array.from(sub.im) };
    const fineRaw = buildSpectrum(FINE_OPTS);
    const fineScale = spectrumScaleToPeak(fineRaw, C1.fineCrestMetres ?? 0.04);
    const fine: ComplexField = { re: Float32Array.from(fineRaw.re), im: Float32Array.from(fineRaw.im) };
    for (let i = 0; i < fine.re.length; i += 1) {
      fine.re[i] *= fineScale;
      fine.im[i] *= fineScale;
    }
    accumulateSpectrum(sub, fine);
    const [subLo, subHi] = radiusRange(32, 128);
    const [fineLo, fineHi] = radiusRange(4, 27.5);
    for (let nz = 0; nz < N; nz += 1) {
      for (let nx = 0; nx < N; nx += 1) {
        const idx = nz * N + nx;
        // 逐格加法契约（Float32 舍入语义）
        expect(sub.re[idx]).toBe(Math.fround(subPre.re[idx] + fine.re[idx]));
        expect(sub.im[idx]).toBe(Math.fround(subPre.im[idx] + fine.im[idx]));
        // 窗口互斥：细带窗格点上子带原值为 0，反之亦然（λ=32 只归子带）
        const r = Math.hypot((nx <= N / 2 ? nx : nx - N) * DK, (nz <= N / 2 ? nz : nz - N) * DK) / DK;
        if (r >= fineLo && r <= fineHi) {
          expect(Math.abs(subPre.re[idx]) + Math.abs(subPre.im[idx])).toBe(0);
        }
        if (r >= subLo && r <= subHi) {
          expect(Math.abs(fine.re[idx]) + Math.abs(fine.im[idx])).toBe(0);
        }
      }
    }
    // golden pin（float32 全精度）：子带构建+amplitudePeak 缩放路径在带内四点。
    // 遍历序或缩放路径一变即红；勿用带外点（钉不住缩放漂移）。
    const golden: Array<readonly [number, number, number, number]> = [
      // [nz, nx, re, im] — 2026-11-09 探针打印（子带 seed 20261106 + amplitudePeak 0.1 缩放路径）
      [0, 2, 0.0019052011193707585, 0.00027827444137074053],
      [0, 3, -0.0002210232923971489, 0.0010625967988744378],
      [1, 4, 0.0000392610345443245, 0.00003192086660419591],
      [3, 5, -0.0012915247352793813, -0.0008732064161449671],
    ];
    const mergedSub = buildSpectrum(SUB_OPTS);
    const ms = spectrumScaleToPeak(mergedSub, 0.1);
    for (let i = 0; i < mergedSub.re.length; i += 1) {
      mergedSub.re[i] *= ms;
      mergedSub.im[i] *= ms;
    }
    // eslint-disable-next-line no-console
    console.log('[golden-probe]', JSON.stringify(golden.map(([nz, nx]) => {
      const idx = nz * N + nx;
      return { nz, nx, re: mergedSub.re[idx], im: mergedSub.im[idx] };
    })));
    for (const [nz, nx, re, im] of golden) {
      const idx = nz * N + nx;
      expect(mergedSub.re[idx]).toBe(re);
      expect(mergedSub.im[idx]).toBe(im);
    }
  });
});
