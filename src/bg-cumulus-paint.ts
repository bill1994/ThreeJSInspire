/**
 * src/bg-cumulus-paint.ts — 背景积云的纯函数上色映射层（bg-cumulus Task 2）。
 *
 * 色彩单源：五色全部来自 sky-track 的 cloudBands/cloudHaze（计划 §裁定 5），
 * 参考仓 clouds.js:279-310 只抄**结构常数**（硬边位置/阴影探针距离/混合区间）。参考真本已归档在
 * `docs/reference/painted-valley/clouds.js`（MIT, (c) 2026 Patch；出处/版本见同目录 PROVENANCE.md），
 * 一个颜色常量都不抄（主 spec §7 第 4 条）。
 * paint() 的 JS 镜像（paintMixJs）供测试钉值与 shader 调试对拍；GPU 侧按同一组
 * 常数在 TSL 里重写（Task 3a）。
 */

/** Vec3 同 sky-track 的三元组形态（输出是可变的，喂给 uniform Vector3）。 */
type Vec3 = [number, number, number];
/** 输入侧只读三元组：world 的调色板来自 sky-track 的 readonly Vec3，不能要求可变。 */
type Vec3In = readonly [number, number, number];

/** 烘焙五色（计划 §裁定 5 的映射目标）。 */
export interface CloudColors {
  lit: Vec3;
  mid: Vec3;
  shade: Vec3;
  under: Vec3;
  haze: Vec3;
}

/** paint() 的结构常数（参考 clouds.js:279-310 定值，全部无单位/比例量）。 */
export const PAINT_CONSTANTS = {
  /** 受光白硬边位置：smoothstep(0.55, 0.6, light) —— 画师式的干净一条边。 */
  hardEdge: [0.55, 0.6] as const,
  /** 阴影侧双调混合区间：smoothstep(0.25, 0.85, broad)。 */
  shadeMix: [0.25, 0.85] as const,
  /** 折痕加深幅度与区间。 */
  foldDeepen: 0.07,
  foldRange: [0.1, 0.18] as const,
  /** 云底深调混合区间与高度归一项分母（scale×2.2）。 */
  underMix: [-0.2, 0.5] as const,
  underScale: 2.2,
  /** 阴影双探针距离（×scale）与权重。 */
  shadowNear: 2.6,
  shadowNearW: 0.5,
  shadowFar: 6.5,
  shadowFarW: 0.7,
  /** light 的阴影衰减指数。 */
  lightExpo: 1.3,
  /** light/broad 的几何项权重。 */
  litUp: 0.1,
  litOpen: 0.04,
  litNy: 0.1,
  broadUp: 0.25,
  broadNy: 0.1,
  broadBillow: 0.34,
  /** 光方向的上抬与径向内拉（参考 clouds.js:293：L = normalize(sunDir + (0,0.5,0) − radial·0.3)）。 */
  liftY: 0.5,
  radialPull: 0.3,
} as const;

/** GLSL smoothstep 同式。 */
export function smoothstepJs(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * 色彩单源映射（§裁定 5）：bands[0]=背光底=under、[1]=背光顶=shade、
 * [2]=迎光底=mid、[3]=迎光顶=lit；haze 直传。不写输入。
 */
export function mapPalette(bands: readonly Vec3In[], haze: Vec3In): CloudColors {
  const at = (i: number): Vec3 => [bands[i][0], bands[i][1], bands[i][2]];
  return { lit: at(3), mid: at(2), shade: at(1), under: at(0), haze: [haze[0], haze[1], haze[2]] };
}

/**
 * 昼夜光照混合（§裁定 8）：月亮 = 太阳反相位（time-of-day.ts:66 的恒等式），
 * 模块内部派生，不新增接口。dayW = smoothstep(−8°, 0°, 太阳仰角)。
 *
 * 返回的 dir 是**未归一的混合向量** sunDir·(2·dayW−1)：在 dayW=0.5 处退化为零向量，
 * 由 shader 侧 lift(+0.5y) 与径向项兜底后再 normalize（光在黄昏扫过「从上方来」，
 * 连续无跳变）。这里刻意不 normalize，保留幅值给 shader 判断。
 */
export function lightBlend(sunDir: Vec3, sunElevDeg: number): { dir: Vec3; dayW: number } {
  const dayW = smoothstepJs(-8, 0, sunElevDeg);
  const k = 2 * dayW - 1;
  return { dir: [sunDir[0] * k, sunDir[1] * k, sunDir[2] * k], dayW };
}

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * paint() 尾段的 JS 镜像（参考 clouds.js:300-309）：给定预计算的
 * light（含阴影/朝向项）、broad（大形态明暗）、up（离云底高度 0..1）、open（褶皱开度 0..1）、
 * h（(p.y−base)/(scale×2.2)），返回表面色。
 * 前半段（法线/阴影 march）是 GPU 侧职责，进不了单测——由 PAINT_CONSTANTS 源码钉 + Task 6 目检。
 */
export function paintMixJs(
  light: number,
  broad: number,
  up: number,
  open: number,
  h: number,
  colors: CloudColors,
): Vec3 {
  const { hardEdge, shadeMix, foldDeepen, foldRange, underMix } = PAINT_CONSTANTS;
  const inShade0 = mix(colors.shade[0], colors.mid[0], smoothstepJs(shadeMix[0], shadeMix[1], broad));
  const inShade1 = mix(colors.shade[1], colors.mid[1], smoothstepJs(shadeMix[0], shadeMix[1], broad));
  const inShade2 = mix(colors.shade[2], colors.mid[2], smoothstepJs(shadeMix[0], shadeMix[1], broad));
  const deepen = 1 - foldDeepen * (1 - smoothstepJs(foldRange[0], foldRange[1], open));
  const col0 = mix(inShade0 * deepen, colors.lit[0], smoothstepJs(hardEdge[0], hardEdge[1], light));
  const col1 = mix(inShade1 * deepen, colors.lit[1], smoothstepJs(hardEdge[0], hardEdge[1], light));
  const col2 = mix(inShade2 * deepen, colors.lit[2], smoothstepJs(hardEdge[0], hardEdge[1], light));
  const u = smoothstepJs(underMix[0], underMix[1], h + light);
  return [mix(colors.under[0], col0, u), mix(colors.under[1], col1, u), mix(colors.under[2], col2, u)];
}
