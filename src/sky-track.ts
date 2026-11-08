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
import { HORIZON } from './horizon';
import { PUFF_BAND_COLORS, SKY_PALETTE, SKY_STOPS, SUN_DIRECTION, SUN_TINT_LINEAR } from './palettes';

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

/** linear RGB → CSS hex. Exact inverse of `srgbToLinear` for every byte value. */
function linearToSrgbCss(v: Vec3): string {
  const enc = (c: number): string => {
    const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.min(Math.max(c, 0), 1), 1 / 2.4) - 0.055;
    return Math.round(Math.min(Math.max(s, 0), 1) * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${enc(v[0])}${enc(v[1])}${enc(v[2])}`;
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
      cloudBands: linear4(PUFF_BAND_COLORS),
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

/**
 * The track evaluated at a sun elevation (degrees). Outside [-8, REFERENCE_ELEVATION_DEG]
 * the endpoint keyframes are returned; inside, each field smoothstep-interpolates
 * across the containing segment (in linear space for colours).
 */
export function skyTrackAt(sunElevationDeg: number): SkyTrackState {
  if (!(sunElevationDeg > KEYS[0].el)) return cloneState(KEYS[0].state);
  if (sunElevationDeg >= KEYS[KEYS.length - 1].el) return cloneState(KEYS[KEYS.length - 1].state);
  for (let i = 0; i < KEYS.length - 1; i += 1) {
    if (sunElevationDeg <= KEYS[i + 1].el) {
      const t = smoothstepBetween(KEYS[i].el, KEYS[i + 1].el, sunElevationDeg);
      return lerpTrackStates(KEYS[i].state, KEYS[i + 1].state, t);
    }
  }
  return cloneState(KEYS[KEYS.length - 1].state);
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
