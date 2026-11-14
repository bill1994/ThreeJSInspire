/**
 * src/sky-track.ts — the keyframed palette track over sun elevation.
 *
 * The first step of the day-night sky (plan 2026-11-08-day-night-sky): the sky was
 * ONE dusk snapshot; this module turns every colour/scalar the dome, the sea, the
 * lights and the clouds read into a smooth function of the live sun elevation, with
 * four keyframes at [-8, -4, 0, REFERENCE_ELEVATION_DEG] degrees.
 *
 * Contracts pinned here:
 *
 * - **Reference-key identity** — `skyTrackAt(REFERENCE_ELEVATION_DEG)` reproduces
 *   today's implementation exactly: every reference-column value is IMPORTED from
 *   `SKY_STOPS` / `HORIZON` / `SKY_PALETTE` / `SUN_TINT_LINEAR` / `PUFF_BAND_COLORS`,
 *   never a copied literal (plan Global Constraint 2). The night/transition columns
 *   are initial art values, tunable at acceptance.
 * - **Pure module** — no THREE import (Global Constraint 9): the sRGB decode here is
 *   self-contained and test-verified against `THREE.Color`. All colours are linear
 *   Vec3; interpolation happens in linear space.
 * - `hazeLinear` / `awayEdgeLinear` are NOT authored per keyframe: haze = the
 *   keyframe's first ramp stop (night keyframe: first night stop), awayEdge =
 *   `(1-k)·haze + k·awayColor` — the generalisation of `horizon.awayHorizonLinear()`
 *   to track values. Task 5 replaces both with `skyColorJs`-derived endpoints; until
 *   then this shape exists only to make the reference-identity tests pass.
 *
 * The CSS-string light fields (`sunLightColorCss` / `hemiSkyCss` / `hemiGroundCss`)
 * interpolate by decode → linear lerp → re-encode, so the lights move in the same
 * linear space as everything else (a plain string snap would step between keyframes).
 */
import { HORIZON, sunDirectionFromAzEl } from './horizon';
import { PUFF_BAND_COLORS, SKY_PALETTE, SKY_STOPS, SUN_DIRECTION, SUN_POSITION, SUN_TINT_LINEAR } from './palettes';
import { TOON_LUM_WEIGHTS } from './toon-look';
import { seaHazeEndpoints } from './sky-color-js';
import { sunColorFor } from './sun-color';

export type Vec3 = readonly [number, number, number];

/** sin(elevation) of the default sun (`SUN_DIRECTION`), in degrees ≈ 6.97. */
export const REFERENCE_ELEVATION_DEG = (Math.asin(SUN_DIRECTION[1]) * 180) / Math.PI;

export interface PreethamParams {
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  mieDirectionalG: number;
}

export interface SkyTrackState {
  /** Ramp stops of the DUSK look, linear RGB (night keyframe carries the −4 values, unused at nightWeight 1). */
  dayStops: [Vec3, Vec3, Vec3, Vec3];
  /** Ramp stops of the NIGHT look, linear RGB. */
  nightStops: [Vec3, Vec3, Vec3, Vec3];
  nightWeight: number;
  awayColor: Vec3;
  awayGain: number;
  awayHeight: number;
  glowPow: number;
  glowGain: number;
  sunTint: Vec3;
  discGain: number;
  /** The four puff band colours (shadow → lit), linear RGB. */
  cloudBands: [Vec3, Vec3, Vec3, Vec3];
  cloudHaze: Vec3;
  /** Sea haze warm endpoint (legacy field, reference-identity shape; Task 5 re-derives it from `skyColorJs`). */
  hazeLinear: Vec3;
  /** Sea haze away endpoint (legacy field, same caveat as `hazeLinear`). */
  awayEdgeLinear: Vec3;
  /** Night floor added AFTER the day/night mix so it is not multiplied away. */
  floorLinear: Vec3;
  preetham: PreethamParams;
  sunLightColorCss: string;
  sunLightIntensity: number;
  hemiSkyCss: string;
  hemiGroundCss: string;
  hemiIntensity: number;
  /** In-cloud veil endpoints (linear; the DOM side converts at injection, see Task 7). */
  veilCool: Vec3;
  veilWarm: Vec3;
  starOpacity: number;
  bloomThreshold: number;
}

/**
 * Debug-panel override over a track state (debug color panel plan Task 1). All
 * fields are data — no functions — and each present field replaces the base
 * field WHOLESALE (arrays and `preetham` included: a patch that only changes
 * `preetham.turbidity` swaps the whole object, so the panel always sends a
 * complete `preetham`).
 */
export type DebugTrackPatch = Partial<SkyTrackState>;

/**
 * Merge a debug patch over a track state. `patch === null` returns `base`
 * ITSELF (reference equality — the default path must stay bit-identical);
 * otherwise a shallow spread on a new object, unmentioned fields keeping the
 * base's references.
 */
export function applyTrackPatch(base: SkyTrackState, patch: DebugTrackPatch | null): SkyTrackState {
  if (patch === null) return base;
  return { ...base, ...patch };
}

/** sRGB (CSS hex string or numeric 0xRRGGBB) → linear RGB. Mirrors `THREE.Color`'s decode. */
export function srgbToLinear(css: string | number): Vec3 {
  const bytes =
    typeof css === 'string'
      ? [parseInt(css.slice(1, 3), 16), parseInt(css.slice(3, 5), 16), parseInt(css.slice(5, 7), 16)]
      : [(css >> 16) & 255, (css >> 8) & 255, css & 255];
  const [r, g, b] = bytes.map((byte) => {
    const c = byte / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return [r, g, b];
}

/** linear RGB → sRGB bytes (0–255, rounded; same clamp/gamma as the CSS form). */
export function linearToByte(v: Vec3): [number, number, number] {
  const enc = (c: number): number => {
    const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.min(Math.max(c, 0), 1), 1 / 2.4) - 0.055;
    return Math.round(Math.min(Math.max(s, 0), 1) * 255);
  };
  return [enc(v[0]), enc(v[1]), enc(v[2])];
}

/** linear RGB → CSS hex. Exact inverse of `srgbToLinear` for every byte value. */
export function linearToSrgbCss(v: Vec3): string {
  const [r, g, b] = linearToByte(v);
  const hex = (n: number): string => n.toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

function smoothstepBetween(e0: number, e1: number, x: number): number {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

function lerpN(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [lerpN(a[0], b[0], t), lerpN(a[1], b[1], t), lerpN(a[2], b[2], t)];
}

function lerp4(a: readonly Vec3[], b: readonly Vec3[], t: number): [Vec3, Vec3, Vec3, Vec3] {
  return [lerp3(a[0], b[0], t), lerp3(a[1], b[1], t), lerp3(a[2], b[2], t), lerp3(a[3], b[3], t)];
}

/** CSS light colours interpolate in linear space (decode → lerp → re-encode). */
function lerpCss(a: string, b: string, t: number): string {
  return linearToSrgbCss(lerp3(srgbToLinear(a), srgbToLinear(b), t));
}

/**
 * Segment-internal interpolation of two track states, `t` in [0,1]. Exported so the
 * linear-space contract can be tested with synthetic endpoints (`sky-track.test.ts`).
 */
export function lerpTrackStates(a: SkyTrackState, b: SkyTrackState, t: number): SkyTrackState {
  return {
    dayStops: lerp4(a.dayStops, b.dayStops, t),
    nightStops: lerp4(a.nightStops, b.nightStops, t),
    nightWeight: lerpN(a.nightWeight, b.nightWeight, t),
    awayColor: lerp3(a.awayColor, b.awayColor, t),
    awayGain: lerpN(a.awayGain, b.awayGain, t),
    awayHeight: lerpN(a.awayHeight, b.awayHeight, t),
    glowPow: lerpN(a.glowPow, b.glowPow, t),
    glowGain: lerpN(a.glowGain, b.glowGain, t),
    sunTint: lerp3(a.sunTint, b.sunTint, t),
    discGain: lerpN(a.discGain, b.discGain, t),
    cloudBands: lerp4(a.cloudBands, b.cloudBands, t),
    cloudHaze: lerp3(a.cloudHaze, b.cloudHaze, t),
    hazeLinear: lerp3(a.hazeLinear, b.hazeLinear, t),
    awayEdgeLinear: lerp3(a.awayEdgeLinear, b.awayEdgeLinear, t),
    floorLinear: lerp3(a.floorLinear, b.floorLinear, t),
    preetham: {
      turbidity: lerpN(a.preetham.turbidity, b.preetham.turbidity, t),
      rayleigh: lerpN(a.preetham.rayleigh, b.preetham.rayleigh, t),
      mieCoefficient: lerpN(a.preetham.mieCoefficient, b.preetham.mieCoefficient, t),
      mieDirectionalG: lerpN(a.preetham.mieDirectionalG, b.preetham.mieDirectionalG, t),
    },
    sunLightColorCss: lerpCss(a.sunLightColorCss, b.sunLightColorCss, t),
    sunLightIntensity: lerpN(a.sunLightIntensity, b.sunLightIntensity, t),
    hemiSkyCss: lerpCss(a.hemiSkyCss, b.hemiSkyCss, t),
    hemiGroundCss: lerpCss(a.hemiGroundCss, b.hemiGroundCss, t),
    hemiIntensity: lerpN(a.hemiIntensity, b.hemiIntensity, t),
    veilCool: lerp3(a.veilCool, b.veilCool, t),
    veilWarm: lerp3(a.veilWarm, b.veilWarm, t),
    starOpacity: lerpN(a.starOpacity, b.starOpacity, t),
    bloomThreshold: lerpN(a.bloomThreshold, b.bloomThreshold, t),
  };
}

/** `(1-k)·haze + k·away` — `horizon.awayHorizonLinear()` generalised to track values. */
function awayEdgeFrom(haze: Vec3, away: Vec3, gain: number): Vec3 {
  return [(1 - gain) * haze[0] + gain * away[0], (1 - gain) * haze[1] + gain * away[1], (1 - gain) * haze[2] + gain * away[2]];
}

const ZEROS: [Vec3, Vec3, Vec3, Vec3] = [
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
];

const linear4 = (cssList: readonly (string | number)[]): [Vec3, Vec3, Vec3, Vec3] =>
  cssList.map(srgbToLinear) as [Vec3, Vec3, Vec3, Vec3];

const scale3 = (v: Vec3, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s];

/*
 * The four keyframes. Reference column imports its numbers; the other columns are
 * initial art values (plan Task 1 Step 3) tunable at Task 8 acceptance — EXCEPT the
 * numbers the identity tests pin (away/glow/disc constants come from HORIZON).
 * `dayStops` at −8° does not participate (nightWeight = 1) and carries the −4 values
 * so no new colours are invented there.
 */
const NIGHT_STOPS_CSS = ['#26304f', '#1b2340', '#101630', '#080d1e'] as const;

const REF_DAY = linear4(SKY_STOPS.map((s) => s.color));
const REF_AWAY = srgbToLinear(HORIZON.AWAY_COLOR);
const REF_HAZE = REF_DAY[0];
// 参考档云调色 ramp（PUFF_BAND_COLORS 线性解码）——KEYS 参考档与 Task 4 toon 校准
// 共用同一份（toon 派生的源 ramp 就是它，单源不复制）。
const REF_BANDS = linear4(PUFF_BAND_COLORS);

const KEY_0_DAY = linear4(['#e07040', '#a4557d', '#57417f', '#3a2860']);
const KEY_M4_DAY = linear4(['#8f4a52', '#5f3a5e', '#33305a', '#1e1a40']);
const KEY_M4_NIGHT = linear4(NIGHT_STOPS_CSS);

const KEYS: readonly { el: number; state: SkyTrackState }[] = [
  {
    el: -8,
    state: {
      dayStops: KEY_M4_DAY,
      nightStops: KEY_M4_NIGHT,
      nightWeight: 1,
      awayColor: srgbToLinear('#1c1c2e'),
      awayGain: 0.2,
      awayHeight: 0.42,
      glowPow: 180,
      glowGain: 0.06,
      sunTint: [0.5, 0.35, 0.3],
      discGain: 0,
      cloudBands: linear4(['#232845', '#2c3055', '#3a3050', '#453a4a']),
      cloudHaze: srgbToLinear('#26304f'),
      hazeLinear: KEY_M4_NIGHT[0],
      awayEdgeLinear: awayEdgeFrom(KEY_M4_NIGHT[0], srgbToLinear('#1c1c2e'), 0.2),
      floorLinear: [0.002, 0.0025, 0.005],
      preetham: { turbidity: 4, rayleigh: 4, mieCoefficient: 0.004, mieDirectionalG: 0.85 },
      sunLightColorCss: '#304060',
      sunLightIntensity: 0.15,
      hemiSkyCss: '#1a2040',
      hemiGroundCss: '#080a14',
      hemiIntensity: 0.12,
      veilCool: srgbToLinear('#8085a8'),
      veilWarm: srgbToLinear('#b08860'),
      starOpacity: 1,
      bloomThreshold: 0.82,
    },
  },
  {
    el: -4,
    state: {
      dayStops: KEY_M4_DAY,
      nightStops: KEY_M4_NIGHT,
      nightWeight: 0.7,
      awayColor: srgbToLinear('#3a2f45'),
      awayGain: 0.5,
      awayHeight: 0.42,
      glowPow: 150,
      glowGain: 0.45,
      sunTint: [0.9, 0.45, 0.25],
      discGain: 0,
      cloudBands: linear4(['#45406b', '#554a80', '#6d4a68', '#75606a']),
      cloudHaze: srgbToLinear('#8f4a52'),
      hazeLinear: KEY_M4_DAY[0],
      awayEdgeLinear: awayEdgeFrom(KEY_M4_DAY[0], srgbToLinear('#3a2f45'), 0.5),
      floorLinear: [0.0015, 0.002, 0.004],
      preetham: { turbidity: 3.5, rayleigh: 3.5, mieCoefficient: 0.006, mieDirectionalG: 0.82 },
      sunLightColorCss: '#d05a40',
      sunLightIntensity: 0.6,
      hemiSkyCss: '#3a3060',
      hemiGroundCss: '#101020',
      hemiIntensity: 0.3,
      veilCool: srgbToLinear('#a8a2c0'),
      veilWarm: srgbToLinear('#d8a880'),
      starOpacity: 0.35,
      bloomThreshold: 0.82,
    },
  },
  {
    el: 0,
    state: {
      dayStops: KEY_0_DAY,
      nightStops: KEY_M4_NIGHT.map((stop) => scale3(stop, 0.3)) as [Vec3, Vec3, Vec3, Vec3],
      nightWeight: 0.15,
      awayColor: REF_AWAY,
      awayGain: 0.8,
      awayHeight: 0.42,
      glowPow: HORIZON.GLOW_POW,
      glowGain: 0.5,
      sunTint: [1.0, 0.62, 0.34],
      discGain: 0.35,
      cloudBands: linear4(['#5f5a84', '#6f62a0', '#9c688e', '#a08088']),
      cloudHaze: srgbToLinear('#e07040'),
      hazeLinear: KEY_0_DAY[0],
      awayEdgeLinear: awayEdgeFrom(KEY_0_DAY[0], REF_AWAY, 0.8),
      // floor art values: the plan's originals ([0.002,0.002,0.005] here) made the
      // −8° night zenith 0.266× the reference zenith, failing the plan's own < 0.2
      // assertion (Task 3 test) — the floor dominated the night zenith's luminance.
      // Darkened per the plan's art-value grant; the assertion is the contract.
      floorLinear: [0.001, 0.0015, 0.003],
      preetham: { turbidity: 3, rayleigh: 2.5, mieCoefficient: 0.008, mieDirectionalG: 0.8 },
      sunLightColorCss: '#ff8a50',
      sunLightIntensity: 1.4,
      hemiSkyCss: '#6a55b0',
      hemiGroundCss: '#201430',
      hemiIntensity: 0.5,
      veilCool: srgbToLinear('#cfc6da'),
      veilWarm: srgbToLinear('#ffe9c4'),
      starOpacity: 0,
      bloomThreshold: 0.82,
    },
  },
  {
    el: REFERENCE_ELEVATION_DEG,
    state: {
      dayStops: REF_DAY,
      nightStops: ZEROS,
      nightWeight: 0,
      awayColor: REF_AWAY,
      awayGain: HORIZON.AWAY_GAIN,
      awayHeight: HORIZON.AWAY_HEIGHT,
      glowPow: HORIZON.GLOW_POW,
      glowGain: HORIZON.GLOW_GAIN,
      sunTint: SUN_TINT_LINEAR,
      discGain: HORIZON.DISK_GAIN,
      cloudBands: REF_BANDS,
      cloudHaze: srgbToLinear(SKY_PALETTE.horizon),
      hazeLinear: REF_HAZE,
      awayEdgeLinear: awayEdgeFrom(REF_HAZE, REF_AWAY, HORIZON.AWAY_GAIN),
      floorLinear: [0, 0, 0],
      preetham: { turbidity: 2, rayleigh: 1, mieCoefficient: 0.005, mieDirectionalG: 0.8 },
      sunLightColorCss: SKY_PALETTE.sun,
      sunLightIntensity: 2.2,
      hemiSkyCss: '#8a6fd0',
      hemiGroundCss: '#2a1a3a',
      hemiIntensity: 0.7,
      veilCool: srgbToLinear('#cfc6da'),
      veilWarm: srgbToLinear('#ffe9c4'),
      starOpacity: 0,
      bloomThreshold: 0.82,
    },
  },
];

function cloneState(s: SkyTrackState): SkyTrackState {
  return {
    dayStops: s.dayStops.map((v) => [...v] as Vec3) as [Vec3, Vec3, Vec3, Vec3],
    nightStops: s.nightStops.map((v) => [...v] as Vec3) as [Vec3, Vec3, Vec3, Vec3],
    nightWeight: s.nightWeight,
    awayColor: [...s.awayColor] as Vec3,
    awayGain: s.awayGain,
    awayHeight: s.awayHeight,
    glowPow: s.glowPow,
    glowGain: s.glowGain,
    sunTint: [...s.sunTint] as Vec3,
    discGain: s.discGain,
    cloudBands: s.cloudBands.map((v) => [...v] as Vec3) as [Vec3, Vec3, Vec3, Vec3],
    cloudHaze: [...s.cloudHaze] as Vec3,
    hazeLinear: [...s.hazeLinear] as Vec3,
    awayEdgeLinear: [...s.awayEdgeLinear] as Vec3,
    floorLinear: [...s.floorLinear] as Vec3,
    preetham: { ...s.preetham },
    sunLightColorCss: s.sunLightColorCss,
    sunLightIntensity: s.sunLightIntensity,
    hemiSkyCss: s.hemiSkyCss,
    hemiGroundCss: s.hemiGroundCss,
    hemiIntensity: s.hemiIntensity,
    veilCool: [...s.veilCool] as Vec3,
    veilWarm: [...s.veilWarm] as Vec3,
    starOpacity: s.starOpacity,
    bloomThreshold: s.bloomThreshold,
  };
}

// ---- planB Phase 1 Task 4：R4 日弧派生 +15/30/45/65 ---------------------------
// 命名裁定（brief 决议 1）：`deriveDayKey(el, lowKey, highKey)` —— §Interfaces 的
// 签名是精确的（§Files 只给了描述性名 deriveKeyFromNeighbors）；一个规范导出，
// 四档共用。用法：deriveDayKey(el, REF_STATE, MIDDAY_TOP)，t 为全日弧定位。
//
// 手法（R4）：nightStops/dayStops/cloudBands 在相邻已调档之间做 hue-shift 插值——
// 暗端向紫、亮端向暖，与 toon D1 同向（锚直接复用 TOON_BANDS_REF 两端，无第二份
// 手值）；hazeLinear/awayEdgeLinear 走 seaHazeEndpoints 真值；灯光色从 sunColorFor
// 派生（线性 sunTint + 同源 CSS）；人工只调双 ramp 8 色 + cloudBands 4 色（正午锚
// 初值 my call，Task 6 抓帧复评——档间取平滑 ramp，不做 bold 选择）。

/** R4 日弧派生域：低端 = 参考档仰角，高端 = R1 弧顶 65°（PEAK_ELEVATION_DEG）。 */
const DAY_ARC_LOW_EL = REFERENCE_ELEVATION_DEG;
const DAY_ARC_HIGH_EL = 65;

/** 日弧新档仰角（升序；skyTrackAt 段内插值与钳制都认它）。 */
const DAY_KEY_ELS = [15, 30, 45, 65] as const;

/** hue-shift 偏置强度（端点处 sin(πt)=0，恒等不受影响）。 */
const HUE_SHIFT_BIAS = 0.12;

/** 暗/亮分界（Rec.709 线性亮度；低于此算暗端向紫，否则亮端向暖）。 */
const HUE_SHIFT_LUM_MID = 0.35;

function dayArcT(el: number): number {
  // Concave 幂映射（指数 0.6），不是 smoothstep——实测结论（Task 4 probe）：
  // smoothstep(REF,65) 在 15° 处只给 t=0.052，TOP 的压制稀释到 5%，而 15° 行
  // E 已饱和（[1.84,2,2]），TOP0 全黑都救不回来（极限 0.821）；幂映射给
  // t(15°)=0.305 / t(30°)=0.574 / t(45°)=0.776 / t(65°)=1，每档都有实权。
  // 端点恒等（0^0.6=0、1^0.6=1）与单调性不变；档间仍由 skyTrackAt 段内
  // smoothstep 连续（关键帧处斜率归零是既有设计）。
  const x = Math.min(Math.max((el - DAY_ARC_LOW_EL) / (DAY_ARC_HIGH_EL - DAY_ARC_LOW_EL), 0), 1);
  return Math.pow(x, 0.6);
}

/** 单色 hue-shift 插值：线性 lerp + 暗向紫/亮向暖偏置；t≤0/≥1 精确取端点。 */
function interpBand(a: Vec3, b: Vec3, t: number): Vec3 {
  if (t <= 0) return [...a] as Vec3;
  if (t >= 1) return [...b] as Vec3;
  const base = lerp3(a, b, t);
  const bias = Math.sin(Math.PI * t) * HUE_SHIFT_BIAS;
  const pull = toonLum(base) < HUE_SHIFT_LUM_MID ? TOON_BANDS_REF[0] : TOON_BANDS_REF[3];
  return [(1 - bias) * base[0] + bias * pull[0], (1 - bias) * base[1] + bias * pull[1], (1 - bias) * base[2] + bias * pull[2]];
}

function interpRamp4(a: readonly Vec3[], b: readonly Vec3[], t: number): [Vec3, Vec3, Vec3, Vec3] {
  return [interpBand(a[0], b[0], t), interpBand(a[1], b[1], t), interpBand(a[2], b[2], t), interpBand(a[3], b[3], t)];
}

/**
 * R4 派生纯函数：`el` 在全日弧 [REFERENCE_ELEVATION_DEG, 65] 定位 `t`，在
 * lowKey→highKey 之间插值。band/ramp 走 hue-shift（端点精确恒等）；标量走 lerp；
 * 灯光色走 `sunColorFor(el)`（线性 + CSS 同源）；霾端点走 `seaHazeEndpoints` 真值。
 * 同输入同输出，不别名输入（返回全新 state；端点处也是拷贝）。
 */
export function deriveDayKey(el: number, lowKey: SkyTrackState, highKey: SkyTrackState): SkyTrackState {
  const t = dayArcT(el);
  const pickN = (a: number, b: number): number => (t <= 0 ? a : t >= 1 ? b : lerpN(a, b, t));
  const pick3 = (a: Vec3, b: Vec3): Vec3 =>
    t <= 0 ? ([...a] as Vec3) : t >= 1 ? ([...b] as Vec3) : lerp3(a, b, t);
  const pickCss = (a: string, b: string): string => (t <= 0 ? a : t >= 1 ? b : lerpCss(a, b, t));
  const tint = sunColorFor(el);
  const provisional: SkyTrackState = {
    dayStops: interpRamp4(lowKey.dayStops, highKey.dayStops, t),
    nightStops: interpRamp4(lowKey.nightStops, highKey.nightStops, t),
    nightWeight: pickN(lowKey.nightWeight, highKey.nightWeight),
    awayColor: pick3(lowKey.awayColor, highKey.awayColor),
    awayGain: pickN(lowKey.awayGain, highKey.awayGain),
    awayHeight: pickN(lowKey.awayHeight, highKey.awayHeight),
    glowPow: pickN(lowKey.glowPow, highKey.glowPow),
    glowGain: pickN(lowKey.glowGain, highKey.glowGain),
    sunTint: [...tint] as Vec3,
    discGain: pickN(lowKey.discGain, highKey.discGain),
    cloudBands: interpRamp4(lowKey.cloudBands, highKey.cloudBands, t),
    cloudHaze: interpBand(lowKey.cloudHaze, highKey.cloudHaze, t),
    hazeLinear: [0, 0, 0], // 占位：下由 seaHazeEndpoints 真值覆盖
    awayEdgeLinear: [0, 0, 0], // 占位：同上
    floorLinear: pick3(lowKey.floorLinear, highKey.floorLinear),
    preetham: {
      turbidity: pickN(lowKey.preetham.turbidity, highKey.preetham.turbidity),
      rayleigh: pickN(lowKey.preetham.rayleigh, highKey.preetham.rayleigh),
      mieCoefficient: pickN(lowKey.preetham.mieCoefficient, highKey.preetham.mieCoefficient),
      mieDirectionalG: pickN(lowKey.preetham.mieDirectionalG, highKey.preetham.mieDirectionalG),
    },
    sunLightColorCss: linearToSrgbCss(tint),
    sunLightIntensity: pickN(lowKey.sunLightIntensity, highKey.sunLightIntensity),
    hemiSkyCss: pickCss(lowKey.hemiSkyCss, highKey.hemiSkyCss),
    hemiGroundCss: pickCss(lowKey.hemiGroundCss, highKey.hemiGroundCss),
    hemiIntensity: pickN(lowKey.hemiIntensity, highKey.hemiIntensity),
    veilCool: pick3(lowKey.veilCool, highKey.veilCool),
    veilWarm: pick3(lowKey.veilWarm, highKey.veilWarm),
    starOpacity: pickN(lowKey.starOpacity, highKey.starOpacity),
    bloomThreshold: pickN(lowKey.bloomThreshold, highKey.bloomThreshold),
  };
  // 霾端点真值：新档自身参数 × 本档太阳方向（与 sea/material.test.ts 同口径——
  // 向阳/背阳两标准地平方向，includeDisc=false；能量比的分母恒为参考档）。
  const azDeg = (Math.atan2(SUN_POSITION[0], -SUN_POSITION[2]) * 180) / Math.PI;
  const sun = sunDirectionFromAzEl(azDeg, el);
  const refP = skyTrackAt(REFERENCE_ELEVATION_DEG).preetham;
  const { haze, awayEdge } = seaHazeEndpoints(provisional, sun, SUN_DIRECTION, refP);
  return { ...provisional, hazeLinear: [...haze] as Vec3, awayEdgeLinear: [...awayEdge] as Vec3 };
}

/**
 * 正午锚（人工 12 色初值 my call + 程序化其余字段；Task 6 抓帧复评）。
 * 12 手值 = 双 ramp 8（dayStops 4 brighter-lift + nightStops 恒零沿用参考形态）
 * + cloudBands 4（等亮度步距上抬、色相家族不变）；其余走 t=1 端同一套规则
 * （灯光 sunColorFor(65)、霾占位由 deriveDayKey 覆盖），保证档列自洽。
 *
 * 预算压制（Task 4 probe 实测）：峰值方向 E 通道饱和（G/B 恒钳 2.0），总量被
 * 绿通道主导——stop0 按 REF 色相家族等比压 0.8×（#ff9a5a→#E78B51，lum 0.45→0.36），
 * 而非另起色相；preetham 走清朗正午空气（rayleigh 0.3——sweep 最优，E_R 最低），
 * turb/mie/g 贴近参考保连续。禁碰 0.82 与参考列。
 */
function buildMiddayTop(): SkyTrackState {
  const tint = sunColorFor(DAY_ARC_HIGH_EL);
  return {
    dayStops: linear4(['#e78b51', '#d98aa5', '#7d63b4', '#57408a']),
    nightStops: ZEROS.map((v) => [...v] as Vec3) as [Vec3, Vec3, Vec3, Vec3],
    nightWeight: 0,
    awayColor: srgbToLinear('#6a4a70'),
    awayGain: 0.8,
    awayHeight: 0.42,
    glowPow: 150,
    glowGain: 0.3,
    sunTint: [...tint] as Vec3,
    discGain: 0.3,
    cloudBands: linear4(['#7e6fa3', '#937eb8', '#d17fa2', '#d09da0']),
    cloudHaze: srgbToLinear('#e78b51'),
    hazeLinear: srgbToLinear('#e78b51'), // 占位：deriveDayKey 内由真值覆盖
    awayEdgeLinear: awayEdgeFrom(srgbToLinear('#e78b51'), srgbToLinear('#6a4a70'), 0.8),
    floorLinear: [0, 0, 0],
    preetham: { turbidity: 1.6, rayleigh: 0.3, mieCoefficient: 0.0035, mieDirectionalG: 0.78 },
    sunLightColorCss: linearToSrgbCss(tint),
    sunLightIntensity: 2.6,
    hemiSkyCss: '#9a80e0',
    hemiGroundCss: '#33244a',
    hemiIntensity: 0.85,
    veilCool: srgbToLinear('#cfc6da'),
    veilWarm: srgbToLinear('#ffe9c4'),
    starOpacity: 0,
    bloomThreshold: 0.82,
  };
}

let dayKeysCache: readonly { el: number; state: SkyTrackState }[] | null = null;

/** R4 日弧键（懒构造，原因见 `skyTrackAt` 文档）。四档共用同一对已调邻档。 */
function dayKeys(): readonly { el: number; state: SkyTrackState }[] {
  if (!dayKeysCache) {
    const ref = skyTrackAt(REFERENCE_ELEVATION_DEG);
    const top = buildMiddayTop();
    dayKeysCache = DAY_KEY_ELS.map((el) => ({ el, state: deriveDayKey(el, ref, top) }));
  }
  return dayKeysCache;
}

/**
 * The track evaluated at a sun elevation (degrees). Outside [-8, 65] the
 * endpoint keyframes are returned; inside, each field smoothstep-interpolates
 * across the containing segment (in linear space for colours).
 *
 * planB Phase 1 Task 4: the day-arc keys (+15/30/45/65) are built LAZILY by
 * `dayKeys()` (not at module top level) — their derivation calls
 * `seaHazeEndpoints`, and this module is imported BY `sky-color-js`, so a
 * top-level call would run before `sky-preetham`'s constant table initialises
 * (import-order TDZ). Any `skyTrackAt` call happens after module evaluation,
 * where every transitive dependency is ready.
 */
export function skyTrackAt(sunElevationDeg: number): SkyTrackState {
  if (!(sunElevationDeg > KEYS[0].el)) return cloneState(KEYS[0].state);
  if (sunElevationDeg <= KEYS[KEYS.length - 1].el) {
    for (let i = 0; i < KEYS.length - 1; i += 1) {
      if (sunElevationDeg <= KEYS[i + 1].el) {
        const t = smoothstepBetween(KEYS[i].el, KEYS[i + 1].el, sunElevationDeg);
        return lerpTrackStates(KEYS[i].state, KEYS[i + 1].state, t);
      }
    }
    return cloneState(KEYS[KEYS.length - 1].state);
  }
  const days = dayKeys();
  if (sunElevationDeg >= days[days.length - 1].el) return cloneState(days[days.length - 1].state);
  const seq: readonly { el: number; state: SkyTrackState }[] = [
    KEYS[KEYS.length - 1],
    ...days,
  ];
  for (let i = 0; i < seq.length - 1; i += 1) {
    if (sunElevationDeg <= seq[i + 1].el) {
      const t = smoothstepBetween(seq[i].el, seq[i + 1].el, sunElevationDeg);
      return lerpTrackStates(seq[i].state, seq[i + 1].state, t);
    }
  }
  return cloneState(days[days.length - 1].state);
}

/**
 * JS mirror of the dome ramp's stop-chain mix (`sky-webgpu.ts skyColorTsl`):
 * `t = smoothstep(-0.02, 0.55, dirY)`, then the four stops mixed in order with
 * smoothstep weights across the SKY_STOPS anchor positions — the segment mix is
 * SMOOTHSTEP, not linear (a linear middle would drift every mid-band colour).
 */
export function rampColorJs(dirY: number, stops: readonly [Vec3, Vec3, Vec3, Vec3]): Vec3 {
  const t = smoothstepBetween(-0.02, 0.55, dirY);
  let out = [...stops[0]] as Vec3;
  for (let i = 1; i < stops.length; i += 1) {
    const w = smoothstepBetween(SKY_STOPS[i - 1].at, SKY_STOPS[i].at, t);
    out = lerp3(out, stops[i], w);
  }
  return out;
}

// ---- toon palette hardening（toon-look-toggle Phase 1 Task 4，D1 载体）----------------------
//
// applyToonLook 是 syncSun 扇出里的 state→state 纯函数底色层：
//
//     skyTrackAt(el) → applyToonLook(·, toonAmount) → applyTrackPatch(·, trackPatch)
//
// toon 在下、用户补丁在上（D1 裁定：不是 setTrackPatch 快照——整体替换会杀死逐仰角
// 轨道插值）。触达面只有 cloudBands/cloudHaze（veilCool/veilWarm 不在设计稿 T4 范围；
// 海霾端点自动 toon 化归 D2），其余字段引用恒等。cloudBands 的消费端是两层（puff、
// bg-cumulus 烘焙背景层）——背景层跟着档位化是整体 look 语义的预期行为，不是回归。
//
// 派生方法（人工锚校准的 hue-shifted ramp）：人工 picked 锚 TOON_BANDS_REF 钉住参考档
// 四个 band 的目标色；任意输入色按自身 Rec.709 亮度（与出口 posterize 同一套权重）在
// 源 ramp（REF_BANDS，即参考档 cloudBands，亮度递升——sky-track.test.ts 钉前提）上定位
// u，输出取锚 ramp 在 u 处的逐通道分段线性重采样：
//   · 参考档输入的 u 恰落在结点上 → 输出逐位等于 TOON_BANDS_REF（校准恒等）；
//   · 暗于源 ramp 的输入沿紫锚色相射线按亮度比例缩放（hue 向紫收敛、相对变化保留）；
//   · 亮于源 ramp 的输入沿暖锚射线放大（向暖橙移动）；
//   · cloudHaze 过同一条 ramp——「暗端向紫/亮端向暖」的同一规则，无第二份手值。
// amount 是总闸 uToon 在轨道层的用量：0 = 深拷贝恒等，(0, 1] = mix(c, toon(c), amount)。
// 输入假定非负有限（轨道插值与合法补丁的值域；出口侧 GPU 路径另有 toonQuantizeJs 的
// sanitize 兜底）。

/** 参考档 toon 锚（人工初值，my call，Task 6 抓帧复评后钉死）：暗两档 hue 向紫收敛 +
 * 饱和抬，亮两档向暖橙移、档间亮度差拉开——hue-shifted ramp 标准手法。 */
export const TOON_BANDS_REF: readonly [Vec3, Vec3, Vec3, Vec3] = linear4([
  '#4a3d78',
  '#6355a0',
  '#b06a80',
  '#d09a70',
]);

/** 校准源 ramp = 参考档 cloudBands（单源，KEYS 与派生共用）。 */
const TOON_BANDS_SRC: readonly [Vec3, Vec3, Vec3, Vec3] = REF_BANDS;

const TOON_SRC_LUMS: readonly number[] = TOON_BANDS_SRC.map(toonLum);

/** Rec.709 linear luminance — 与出口 posterize（toonQuantizeJs/Tsl）同一套权重。 */
function toonLum(v: Vec3): number {
  return TOON_LUM_WEIGHTS[0] * v[0] + TOON_LUM_WEIGHTS[1] * v[1] + TOON_LUM_WEIGHTS[2] * v[2];
}

/**
 * One colour through the calibrated toon ramp（单色派生；`deriveToonBands` 把四个
 * band 逐个送进来）。结点处刻意用 `a·(1−u) + b·u` 的形态——u=0/1 时逐位等于结点
 * 值，参考档校准恒等不靠容差。
 */
function deriveToonColor(c: Vec3): Vec3 {
  const t = toonLum(c);
  if (t <= TOON_SRC_LUMS[0]) return scale3(TOON_BANDS_REF[0], t / TOON_SRC_LUMS[0]);
  if (t >= TOON_SRC_LUMS[3]) return scale3(TOON_BANDS_REF[3], t / TOON_SRC_LUMS[3]);
  let i = 0;
  while (t > TOON_SRC_LUMS[i + 1]) i += 1;
  const u = (t - TOON_SRC_LUMS[i]) / (TOON_SRC_LUMS[i + 1] - TOON_SRC_LUMS[i]);
  const a = TOON_BANDS_REF[i];
  const b = TOON_BANDS_REF[i + 1];
  return [a[0] * (1 - u) + b[0] * u, a[1] * (1 - u) + b[1] * u, a[2] * (1 - u) + b[2] * u];
}

/** mix(c, toon(c), amount)——轨道层的用量混合，形态与出口 `toonQuantizeJs` 的末段一致。 */
function mixTowardToon(c: Vec3, amount: number): Vec3 {
  const g = deriveToonColor(c);
  return [
    (1 - amount) * c[0] + amount * g[0],
    (1 - amount) * c[1] + amount * g[1],
    (1 - amount) * c[2] + amount * g[2],
  ];
}

/**
 * The four band colours through the calibrated toon ramp（接口契约导出；状态级消费
 * 走 `applyToonLook`）。
 */
export function deriveToonBands(
  bands: readonly [Vec3, Vec3, Vec3, Vec3],
  amount: number,
): [Vec3, Vec3, Vec3, Vec3] {
  return bands.map((c) => mixTowardToon(c, amount)) as [Vec3, Vec3, Vec3, Vec3];
}

/**
 * Toon palette hardening over a track state（D1 载体，syncSun 插入点）。amount=0
 * 返回深拷贝恒等；其余 amount 只把 cloudBands/cloudHaze 换成派生值，其余字段
 * 浅展开保持输入引用（「只动两个字段」由 sky-track.test.ts 的 toBe 面钉住）。
 */
export function applyToonLook(state: SkyTrackState, amount: number): SkyTrackState {
  if (amount === 0) return cloneState(state);
  return {
    ...state,
    cloudBands: deriveToonBands(state.cloudBands, amount),
    cloudHaze: mixTowardToon(state.cloudHaze, amount),
  };
}
