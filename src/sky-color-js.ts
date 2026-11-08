/**
 * src/sky-color-js.ts — the pure JS mirror of `skyColorTsl` v2 (sky-webgpu.ts).
 *
 * Every term here corresponds item-by-item to the TSL graph: rampColorJs → the
 * dome ramp chain, antiSolarCool → the away-cool weight, energyRatioJs → the
 * Preetham ratio field, horizonGlow/sunDisc → the direct terms. The two must stay
 * shape-identical — this is the drift-guard contract, same as `horizon.ts`; the
 * bloom budget tests (plan Task 4) and the sea haze endpoint derivation (Task 5)
 * both run on THIS file, and Task 8's pixel gate proves the GPU side agrees.
 *
 * Pure module: no THREE import.
 */
import { rampColorJs, type PreethamParams, type SkyTrackState, type Vec3 } from './sky-track';
import { energyRatioJs } from './sky-preetham';
import { antiSolarCool, HORIZON, horizonGlow, sunDisc, sunDirectionFromAzEl } from './horizon';

const COS_HALF = Math.cos((HORIZON.DISK_HALF_ANGLE_DEG * Math.PI) / 180);

const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function mix3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [(1 - t) * a[0] + t * b[0], (1 - t) * a[1] + t * b[1], (1 - t) * a[2] + t * b[2]];
}

/** Horizontal alignment of view and sun — the JS twin of the graph's XZ normalize + dot (with the same 1e-4 length guard). */
function cosAzimuth(dir: Vec3, sun: Vec3): number {
  const dl = Math.max(Math.hypot(dir[0], dir[2]), 1e-4);
  const sl = Math.max(Math.hypot(sun[0], sun[2]), 1e-4);
  return (dir[0] / dl) * (sun[0] / sl) + (dir[2] / dl) * (sun[2] / sl);
}

/**
 * The sky colour as ONE function of a direction and the live sun — the JS total
 * mirror of `skyColorTsl` v2:
 *
 *     E     = clamp(P(dir, sun, pLive) / P(dir, refSun, refP), 0, 2)   // diffuse only
 *     diff  = ramp(dayStops) cooled toward awayColor (track away params)
 *     day   = diff·E + sunTint·(glow + disc)      // direct term OUTSIDE E
 *     night = ramp(nightStops)
 *     C     = mix(day, night, nightWeight) + floorLinear
 *
 * `includeDisc` matches `skyColorTsl`'s sixth sense: the sun DISC is a sky-only
 * feature — the sea path and the Task 5 endpoint derivation pass `false`, or the
 * 0°-key disc (weight 1 at the sunward horizon) would leak into the sea endpoints
 * and flip the sea-sky seam bright.
 *
 * `dir` and `sun` are assumed UNIT (the graph relies on the same caller contract
 * and does not normalize inside).
 */
export function skyColorJs(
  dir: Vec3,
  sun: Vec3,
  state: SkyTrackState,
  refSun: Vec3,
  refP: PreethamParams,
  includeDisc: boolean = true,
): Vec3 {
  const energy = energyRatioJs(dir, sun, state.preetham, refSun, refP);

  // diffuse term: dusk ramp + away cool (track parameters)
  let diff = rampColorJs(dir[1], state.dayStops);
  const cool = antiSolarCool(cosAzimuth(dir, sun), dir[1], {
    awayGain: state.awayGain,
    awayHeight: state.awayHeight,
  });
  diff = mix3(diff, state.awayColor, cool);

  // direct terms OUTSIDE the energy field
  const cos = Math.max(dot3(dir, sun), 0);
  const glow = horizonGlow(cos, { pow: state.glowPow, gain: state.glowGain });
  const disc = includeDisc ? sunDisc(cos, COS_HALF) * state.discGain : 0;
  const sunTerm = glow + disc;

  const day = [
    diff[0] * energy[0] + state.sunTint[0] * sunTerm,
    diff[1] * energy[1] + state.sunTint[1] * sunTerm,
    diff[2] * energy[2] + state.sunTint[2] * sunTerm,
  ];
  const night = rampColorJs(dir[1], state.nightStops);
  const w = state.nightWeight;
  return [
    day[0] * (1 - w) + night[0] * w + state.floorLinear[0],
    day[1] * (1 - w) + night[1] * w + state.floorLinear[1],
    day[2] * (1 - w) + night[2] * w + state.floorLinear[2],
  ];
}

/**
 * The sea haze endpoints for one track state — `skyColorJs` evaluated at the TWO
 * standard horizon directions (dirY = 0, one facing the sun's azimuth, one away;
 * BOTH with `includeDisc = false` — at the 0° key the sun sits ON the horizon and
 * a disc inside the endpoints would flip the sea-sky seam bright).
 *
 * This is the sky-track plan's Global Constraint 5 landing: the endpoints come from
 * the mirror itself, so the energy field's azimuth variation is INCLUDED and cannot
 * be double-modelled by the away weight. The track's own `hazeLinear` /
 * `awayEdgeLinear` fields are legacy reference-identity shapes from Task 1 — the
 * runtime feeds THESE values to the sea.
 */
export function seaHazeEndpoints(
  state: SkyTrackState,
  sun: Vec3,
  refSun: Vec3,
  refP: PreethamParams,
): { haze: Vec3; awayEdge: Vec3 } {
  const azDeg = (Math.atan2(sun[0], -sun[2]) * 180) / Math.PI;
  const sunward = sunDirectionFromAzEl(azDeg, 0);
  const away = sunDirectionFromAzEl(azDeg + 180, 0);
  return {
    haze: skyColorJs(sunward, sun, state, refSun, refP, false),
    awayEdge: skyColorJs(away, sun, state, refSun, refP, false),
  };
}
