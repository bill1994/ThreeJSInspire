/**
 * src/dome-cloud-light.ts — 体积云的光照数学（纯函数，node 下可测）。
 *
 * 相机永远在云层下方，所以看到的几乎全是云底——物理上属于背光面。这套模型因此
 * 只做四件事，每件都能被单测钉住：
 *
 * 1. `transmittance` — Beer-Lambert，厚处发暗、薄处透光。
 * 2. `hgPhase` — 两瓣 Henyey-Greenstein，逆光时的银边来自前向瓣。
 * 3. `powder` — 云底压暗（厚的地方反而更暗，是云的标志性观感）。
 * 4. `shadeSunAndAmbient` — 把三者与天空环境项合成一个颜色。
 *
 * 环境项必须由调用方从 `sky-track` 的 `cloudHaze` / `cloudBands` 灌进来，
 * 本模块不持有任何颜色常量——调色单源。
 *
 * 2026-11-09 首版。设计见
 * `docs/superpowers/specs/2026-11-09-dome-cloud-volumetric-design.md` §5.4。
 */

import type { Vec3 } from './sky-track';

/** 前向瓣的偏心率（越大越「迎光刺眼」）。 */
export const HG_FORWARD_G = 0.6;
/** 后向瓣的偏心率（负责背光侧的柔光）。 */
export const HG_BACK_G = -0.3;
/** 前向瓣在合成里的权重；后向拿剩下的。 */
export const HG_FORWARD_WEIGHT = 0.7;

function nonNegative(v: number): number {
  return Number.isFinite(v) ? Math.max(0, v) : 0;
}

/**
 * Beer-Lambert 透射率：`exp(−σ·d)`。
 *
 * 非有限或非正输入一律返回 1（「没有东西挡着」），宁可过亮也不要产生 NaN 黑块。
 *
 * @param sigmaT 消光系数（大 = 不透明）
 * @param distanceMetres 穿过介质的距离
 */
export function transmittance(sigmaT: number, distanceMetres: number): number {
  if (!Number.isFinite(sigmaT) || !Number.isFinite(distanceMetres)) return 1;
  if (sigmaT <= 0 || distanceMetres <= 0) return 1;
  return Math.exp(-sigmaT * distanceMetres);
}

/**
 * Henyey-Greenstein 相函数。
 *
 * `g = 0` 退化为各向同性 `1/(4π)`；`g > 0` 把能量推到前向（迎光侧），
 * `g < 0` 推到后向。分母被夹到 `1e-4`，避免 `g→1, cosθ→1` 时炸成 Infinity。
 */
export function hgPhase(cosTheta: number, g: number): number {
  const c = Number.isFinite(cosTheta) ? Math.min(1, Math.max(-1, cosTheta)) : 0;
  const gs = Number.isFinite(g) ? Math.min(0.999, Math.max(-0.999, g)) : 0;
  const denom = Math.max(1 + gs * gs - 2 * gs * c, 1e-4);
  return (1 - gs * gs) / (4 * Math.PI * denom ** 1.5);
}

/**
 * Powder 项：云体越厚，越把光「吸」进内部，边缘反而更亮。
 *
 * `1 − exp(−2·density·strength)`，零密度时精确为 0。
 */
export function powder(density: number, strength: number): number {
  if (!Number.isFinite(density) || !Number.isFinite(strength)) return 0;
  if (density <= 0 || strength <= 0) return 0;
  return 1 - Math.exp(-2 * density * strength);
}

/** `shadeSunAndAmbient` 的输入。 */
export interface CloudShadingInput {
  /** 太阳颜色（线性空间）。 */
  sunColor: Vec3;
  /** 天空环境色，由 `sky-track` 的 `cloudHaze` / `cloudBands` 给出。 */
  ambient: Vec3;
  /** 该采样点的消光系数。 */
  sigmaT: number;
  /** 朝太阳方向 light march 得到的遮挡距离。 */
  lightDistance: number;
  /** 视线与太阳方向的余弦。 */
  cosTheta: number;
  /** 该采样点的密度。 */
  density: number;
}

/**
 * 合成一个采样点的颜色：`ambient + sunColor · transmittance · phase · powder`。
 *
 * 逐分量 clamp 到 ≥ 0 且过滤非有限值——夜档色比黄昏暗一个量级，任何漏网的
 * 除法都会把云变成 NaN 黑块。
 */
export function shadeSunAndAmbient(input: CloudShadingInput): Vec3 {
  const { sunColor, ambient, sigmaT, lightDistance, cosTheta, density } = input;

  const phase =
    HG_FORWARD_WEIGHT * hgPhase(cosTheta, HG_FORWARD_G) +
    (1 - HG_FORWARD_WEIGHT) * hgPhase(cosTheta, HG_BACK_G);
  const k = transmittance(sigmaT, lightDistance) * phase * powder(density, 1);

  return [
    nonNegative(ambient[0] + sunColor[0] * k),
    nonNegative(ambient[1] + sunColor[1] * k),
    nonNegative(ambient[2] + sunColor[2] * k),
  ] as const;
}
