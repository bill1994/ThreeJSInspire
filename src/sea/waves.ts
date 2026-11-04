/**
 * Parametric Gerstner wave field (pure math, no three.js import).
 *
 * Five directional trains with deep-water dispersion. The TSL side evaluates
 * this shape at pre-displacement (base) coordinates, so the field is
 * world-anchored by construction: sliding the mesh moves no wave.
 */

const GRAVITY = 9.81;

/** Nominal wind direction the train spread is centred on. */
const WIND: readonly [number, number] = [0.82, -0.57];

/** Per-train spread around the wind direction, in degrees. */
const SPREAD_DEG: readonly number[] = [-12, -5, 0, 7, 15];

const LAMBDAS: readonly number[] = [180, 90, 45, 22, 11];
const AMPS: readonly number[] = [0.34, 0.24, 0.15, 0.1, 0.06];
const SHARPNESS: readonly number[] = [0.5, 0.55, 0.6, 0.65, 0.7];

export interface GerstnerTrain {
  lambda: number;
  dir: readonly [number, number];
  amp: number;
  sharpnessQ: number;
  speed: number;
}

function rotate(dir: readonly [number, number], deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const x = dir[0] * c - dir[1] * s;
  const z = dir[0] * s + dir[1] * c;
  const len = Math.hypot(x, z);
  return [x / len, z / len];
}

function buildTrains(): GerstnerTrain[] {
  return LAMBDAS.map((lambda, i) => {
    const k = (Math.PI * 2) / lambda;
    return {
      lambda,
      dir: rotate(WIND, SPREAD_DEG[i]),
      amp: AMPS[i],
      sharpnessQ: SHARPNESS[i],
      speed: Math.sqrt(GRAVITY * k),
    };
  });
}

export const TRAINS: readonly GerstnerTrain[] = buildTrains();

/** World size of the square sea patch, in metres. */
export const SEA_PATCH_SIZE = 1600;

/** Mesh segments per side: high tier resolves the 11 m train at 4+ samples. */
export const SEGMENTS_HIGH = 600;

/** Low tier drops the two shortest trains, so 300 segments still satisfy the rule. */
export const SEGMENTS_LOW = 300;

/** How many of the longest trains the low tier evaluates. */
export const LOW_TIER_TRAINS = 3;

export interface GerstnerSample {
  y: number;
  nx: number;
  nz: number;
  /** Determinant of the horizontal (x+ox, z+oz) mapping; 1 = unstrained, -> 0 = crest collapse. */
  jac: number;
}

/**
 * Evaluate the wave field at world (x, z) and time t, summing the first
 * `trainCount` trains. Closed-form accumulation: height, analytic slope
 * normal and the horizontal Jacobian, no finite differences.
 */
export function gerstnerField(x: number, z: number, t: number, trainCount: number): GerstnerSample {
  const n = Math.max(0, Math.min(TRAINS.length, Math.trunc(trainCount)));
  let y = 0;
  let dhdx = 0;
  let dhdz = 0;
  let dxx = 0;
  let dxz = 0;
  let dzz = 0;
  for (let i = 0; i < n; i++) {
    const tr = TRAINS[i];
    const k = (Math.PI * 2) / tr.lambda;
    const phase = k * (tr.dir[0] * x + tr.dir[1] * z) - tr.speed * t;
    const s = Math.sin(phase);
    const c = Math.cos(phase);
    y += tr.amp * s;
    const ak = tr.amp * k;
    dhdx += ak * tr.dir[0] * c;
    dhdz += ak * tr.dir[1] * c;
    const qaks = tr.sharpnessQ * tr.amp * k * s;
    dxx -= qaks * tr.dir[0] * tr.dir[0];
    dxz -= qaks * tr.dir[0] * tr.dir[1];
    dzz -= qaks * tr.dir[1] * tr.dir[1];
  }
  const inv = 1 / Math.hypot(dhdx, 1, dhdz);
  return {
    y,
    nx: -dhdx * inv,
    nz: -dhdz * inv,
    jac: (1 + dxx) * (1 + dzz) - dxz * dxz,
  };
}

/** Shortest wavelength among the first `trainCount` trains. */
export function finestWavelength(trainCount: number): number {
  const n = Math.max(1, Math.min(TRAINS.length, Math.trunc(trainCount)));
  let min = Infinity;
  for (let i = 0; i < n; i++) min = Math.min(min, TRAINS[i].lambda);
  return min;
}

/** Combined RMS height of the first `trainCount` trains. */
export function combinedRms(trainCount: number): number {
  const n = Math.max(0, Math.min(TRAINS.length, Math.trunc(trainCount)));
  let sum = 0;
  for (let i = 0; i < n; i++) sum += TRAINS[i].amp * TRAINS[i].amp;
  return Math.sqrt(sum / 2);
}
