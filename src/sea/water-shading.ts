/**
 * src/sea/water-shading.ts — continuous water optics for the FFT sea.
 *
 * Why this module exists: the shipped material painted the surface with four
 * FLAT band colours switched by `step()` and then mixed a CONSTANT 45% of the
 * sky's colour over the result. Both choices show up as hard-edged patches —
 * the bands have no gradient by construction, and a constant reflection weight
 * is physically backwards: water reflects ~2% of the sky head-on and ~100% at
 * grazing incidence, never a flat 45% everywhere.
 *
 * This is the standard real-time water composition, written once here and read
 * by the material graph:
 *
 *   L = F(theta) * L_sky(omega_r)
 *     + (1 - F(theta)) * (L_body + L_crest)
 *     + L_sun_road
 *     + foam * L_foam
 *
 * - `F(theta)` is Schlick's Fresnel with F0 = 0.02 (water against air at normal
 *   incidence). The single Fresnel implementation stays in `sun-road.ts`
 *   (`fresnel01`) — this module must not grow a second copy.
 * - `L_body` is the body colour, ramped CONTINUOUSLY by Beer-Lambert
 *   transmittance through the water column above the sample. Thin water near a
 *   crest lets the shallow tint through; thick water in a trough goes navy.
 * - `L_crest` is sunlight forward-scattered through thin water when the eye is
 *   on the sun side of the wave.
 * - `L_sun_road` is the existing art-tuned glint, untouched: its brightness is
 *   pinned against `post.ts`'s bloom threshold (`roadBudget`).
 *
 * Units are metres and seconds; `height` is the same C0 swell height the band
 * thresholds used, so the shader, the tests and the old debug swatch all talk
 * about the same field.
 */

/**
 * Crest reference height in metres — the C0 cascade's amplitude peak
 * (`CASCADES[0].amplitudePeak`). Kept as a literal instead of an import cycle:
 * `cascades.ts` must stay importable from the spectrum tests without pulling
 * the sea material's dependencies in.
 */
export const CREST_REFERENCE_METRES = 0.45;

export const WATER_OPTICS = {
  /**
   * Beer-Lambert extinction through the water column, per metre.
   *
   * This is a REDUCED extinction, not the physical one. Clear water attenuates
   * over tens of metres (`~0.05 /m`), so using the true value over a 0.45 m
   * swell would paint the body a single flat colour again — exactly the defect
   * the bands were. 2.4 /m makes one swell span the full ramp
   * (T: 1.00 at the crest -> 0.34 at the trough), which is the gradient that
   * lets the eye read the wave without any threshold in the shader.
   */
  EXTINCTION_PER_METRE: 2.4,
  /**
   * How far the crest tint is allowed to pull the body toward `shallow`.
   * 0 would drop the wave relief back to normals alone; 1 would re-create a
   * height ramp. 0.35 is a tint, not a band.
   */
  CREST_TINT: 0.35,
  /**
   * Schlick F0 for water against air: ((1 - 1.333) / (1 + 1.333))^2 = 0.0204.
   *
   * NOT 0.04. 0.04 is the generic-dielectric value several water shader
   * tutorials carry, and it doubles the head-on sky reflection, which is
   * exactly what makes water read as glossy plastic.
   */
  F0: 0.0204,
  /** Ambient that reaches the body, relative to the authored body colour. */
  BODY_AMBIENT: 1.0,
  /** Extra body lighting on faces turned toward the sun. */
  BODY_SUN: 0.9,
  /**
   * Slope exaggeration applied to the FFT spectrum before it becomes a normal.
   *
   * The cascades resolve 32-1024 m wavelengths at wind 9 m/s, which puts the
   * surface slope near 0.01 — a fraction of a degree of tilt, i.e. a mirror.
   * The 1-32 m band that carries most of a real sea's slope variance is simply
   * not in the tiles, so the resolved slope is multiplied to stand in for it.
   * 8 lands the RMS slope near 0.1 (Cox-Munk at 9 m/s), which is the point
   * where the sun road breaks into sparkle instead of one bloom blob. The
   * shipped value is 14: 8 still read as a mirror in the near field, and past
   * ~20 the whole surface turns to molten stripes because every normal ends up
   * tilted into the sky's horizon band.
   */
  SLOPE_GAIN: 14.0,
  /** Backlit crest glow gain, and its falloff exponent on cos(eye->sun). */
  CREST_GAIN: 0.55,
  CREST_POW: 5.0,
  /** Foam coverage edge width on `1 - J`; wider than the old 0.15 hairline. */
  FOAM_SOFTNESS: 0.15,
  /**
   * Distance haze toward `SEA_PALETTE.haze`, as `1 - exp(-d * density)`.
   *
   * The far water must converge on the colour the sky paints at its own edge,
   * or the horizon is a hard line. 2.5e-4 /m is the reference shape (50% at
   * ~2.8 km).
   *
   * **2026-11-12 修正**：这里原先写"the sea's outer ring is 1.9 km, so the mix
   * tops out around 0.38"——`1−exp(−1900×2.5e-4)` 确实是 0.378，但那是**乘
   * `HAZE_MAX` 之前**的值；实际混合只到 **0.208**，远海并没有收敛到天空色，
   * 地平线因此是一条硬线。收敛由 `HAZE_CONVERGE_START/END` 在外缘强制补齐。
   */
  HAZE_DENSITY_PER_METRE: 2.5e-4,
  /** Ceiling on the haze mix: the near water must never wash out. */
  HAZE_MAX: 0.55,
} as const;

/**
 * 远端强制收敛的起点/终点（米，`R3` 外缘 1900）。
 *
 * 为什么需要它：上面那条指数雾在最远环只到 `0.378`，再乘 `HAZE_MAX 0.55`
 * 实际只剩 **0.208**——远海**没有**收敛到天空色，地平线就是一条硬线
 * （画面里那条橙色海天线），也谈不上"雾化远景"。
 *
 * 修法：900 m 以内逐位保持原曲线（近海观感不动），900→1900 把混合平滑推向 1，
 * 外缘必然满雾。TSL 侧（`material.ts`）镜像同一式，常量从这里 import。
 */
export const HAZE_CONVERGE_START = 900;
export const HAZE_CONVERGE_END = 1900;

function smoothstep01(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/**
 * 距离 → 雾混合量，0..1。指数雾 + 远端强制收敛（见上）。
 * JS 侧与 TSL 侧必须同式；常量漂了两边就会重新出现接缝。
 */
export function seaHazeAmount(distanceMetres: number): number {
  const d = Number.isFinite(distanceMetres) ? Math.max(0, distanceMetres) : 0;
  const base = (1 - Math.exp(-d * WATER_OPTICS.HAZE_DENSITY_PER_METRE)) * WATER_OPTICS.HAZE_MAX;
  const converge = smoothstep01((d - HAZE_CONVERGE_START) / (HAZE_CONVERGE_END - HAZE_CONVERGE_START));
  return base + (1 - base) * converge;
}

/**
 * Transmittance of the water column above a sample: `T = exp(-sigma * column)`.
 *
 * `T -> 1` at and above the crest reference (thin water, shallow tint), `T -> 0`
 * deep in a trough (thick water, navy). Degenerate input returns 0 rather than
 * NaN — a NaN here would poison the whole material colour.
 */
export function columnTransmittance(
  heightMetres: number,
  crestMetres: number = CREST_REFERENCE_METRES,
  sigma: number = WATER_OPTICS.EXTINCTION_PER_METRE,
): number {
  if (!Number.isFinite(heightMetres) || !Number.isFinite(crestMetres) || !Number.isFinite(sigma)) {
    return 0;
  }
  const column = Math.max(0, crestMetres - heightMetres);
  return Math.exp(-sigma * column);
}

/**
 * Backlit crest glow: how much sunlight is visible THROUGH the wave.
 *
 * `cosEyeToSun` is `dot(viewDir, sunDir)` with viewDir running camera→surface —
 * 1 when the eye looks straight into the sun through the water, 0 when the sun
 * is behind the viewer. (Fixed 2026-11-07, QA round 1: the shipped negate
 * convention fired the glow on the front-lit side.) Gated by the column
 * transmittance, so the glow rides the crests and dies in the troughs; the
 * `CREST_POW` falloff keeps it off the shoulder of the wave.
 */
export function crestGlow(
  cosEyeToSun: number,
  transmittance: number,
  gain: number = WATER_OPTICS.CREST_GAIN,
  exponent: number = WATER_OPTICS.CREST_POW,
): number {
  if (!Number.isFinite(cosEyeToSun) || !Number.isFinite(transmittance)) return 0;
  if (!(cosEyeToSun > 0) || !(transmittance > 0)) return 0;
  return Math.pow(cosEyeToSun, exponent) * transmittance * gain;
}
