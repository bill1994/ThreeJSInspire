/**
 * Grain layer — high-frequency detail normals from a NOISE gradient.
 *
 * This is the second attempt. The first used a sum of short sine trains; it measured fine
 * (3x3 high-pass std 3.93 -> 7.19) and looked like wallpaper, because a sum of sines is
 * periodic and the mid-field turned into a diagonal lattice. Evidence of that rejection is in
 * `artifacts/archive/sea-detail-attempt/`. Noise has no period, which is the whole point.
 *
 * Division of labour with `waves.ts`: the Gerstner field is the *form* (displacement, analytic
 * normal, Jacobian). This layer only perturbs the normal — it never displaces, because two
 * systems moving the same vertex is how the old self-feedback bug happened — and it fades out
 * on the same angular budget as the swell trains, so it cannot alias into sparkle noise.
 *
 * Parity note, stated plainly: the shader samples `mx_noise_float` (MaterialX), this module
 * samples a value-noise hash. They are NOT numerically equal and should not be compared
 * sample-by-sample. What they share, and what the tests pin, is the *contract*: bounded slope,
 * deterministic, aperiodic, distance-faded, NaN-degrades-to-zero.
 *
 * Cost: three noise taps per fragment (forward difference), which is what a normal map would
 * have cost in one texture fetch plus a mip chain — cheap here, and no asset to ship.
 */

/** One noise cell in metres. Also the spatial scale of the grain. */
export const DETAIL_FEATURE_M = 3;

/** Hard bound on how far the grain may tilt the normal (dimensionless slope). */
export const DETAIL_SLOPE_BUDGET = 0.22;

/** Slope per unit of noise gradient. Tuned so the budget is reached only at steep features. */
const GAIN = 0.28;

/** Finite-difference step in metres: about 1/8 of a cell, small enough for a real gradient. */
const EPS_M = 0.38;

/** Scroll velocities in m/s. Two speeds so the field does not translate as one sheet. */
const SCROLL_A: readonly [number, number] = [0.25, -0.18];
const SCROLL_B: readonly [number, number] = [-0.11, 0.29];

function hash2(ix: number, iy: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smoothstep-interpolated value noise, unit range. */
function valueNoise(x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0);
  const b = hash2(x0 + 1, y0);
  const c = hash2(x0, y0 + 1);
  const d = hash2(x0 + 1, y0 + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Two octaves at 1 : 1.7, scrolling in different directions. */
function sampleGrain(x: number, z: number, t: number): number {
  const ax = (x + SCROLL_A[0] * t) / DETAIL_FEATURE_M;
  const az = (z + SCROLL_A[1] * t) / DETAIL_FEATURE_M;
  const bx = (x * 1.7 + SCROLL_B[0] * t) / DETAIL_FEATURE_M;
  const bz = (z * 1.7 + SCROLL_B[1] * t) / DETAIL_FEATURE_M;
  return valueNoise(ax, az) * 0.65 + valueNoise(bx, bz) * 0.35;
}

/**
 * Distance weight for the grain: 1 near, 0 once one feature spans under two pixels.
 *
 * Same rule as the swell trains (`lambda / (2 * radPerPixel)`), applied to the feature size
 * instead of a wavelength. A grit layer has to fade on its feature size, not its height.
 */
export function detailFade(featureM: number, distance: number, radPerPixel: number): number {
  if (
    !Number.isFinite(featureM) ||
    !Number.isFinite(distance) ||
    !Number.isFinite(radPerPixel) ||
    featureM <= 0 ||
    radPerPixel <= 0
  ) {
    return 0;
  }
  const d1 = featureM / (2 * radPerPixel);
  const d0 = d1 * 0.5;
  if (distance <= d0) return 1;
  if (distance >= d1) return 0;
  const t = (d1 - distance) / (d1 - d0);
  return t * t * (3 - 2 * t);
}

export interface DetailSlope {
  dx: number;
  dz: number;
}

/**
 * Slope perturbation at world (x, z), time t, view distance.
 *
 * Forward difference on the noise field, scaled and then clamped to the budget: the grain can
 * tilt the surface, never flip it. Broken input returns zero — a missing grain layer must look
 * like flat water, never like static.
 */
export function detailNormal(
  x: number,
  z: number,
  t: number,
  distance: number,
  radPerPixel: number,
): DetailSlope {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(z) ||
    !Number.isFinite(t) ||
    !Number.isFinite(distance) ||
    !Number.isFinite(radPerPixel) ||
    radPerPixel <= 0
  ) {
    return { dx: 0, dz: 0 };
  }
  const w = detailFade(DETAIL_FEATURE_M, distance, radPerPixel);
  if (w <= 0) return { dx: 0, dz: 0 };
  const n0 = sampleGrain(x, z, t);
  const nx = sampleGrain(x + EPS_M, z, t);
  const nz = sampleGrain(x, z + EPS_M, t);
  let dx = ((nx - n0) / EPS_M) * GAIN * w;
  let dz = ((nz - n0) / EPS_M) * GAIN * w;
  const m = Math.hypot(dx, dz);
  if (m > DETAIL_SLOPE_BUDGET) {
    const s = DETAIL_SLOPE_BUDGET / m;
    dx *= s;
    dz *= s;
  }
  return { dx, dz };
}

/**
 * TSL mirror of `detailNormal`, for the surface material.
 *
 * Three `mx_noise_float` taps (centre, +x, +z) instead of a texture fetch. Forward difference
 * rather than central: one tap less, and the bias is invisible at this scale. The clamp is the
 * same budget, applied in the shader so a freak gradient cannot flip the normal.
 */
export function detailNormalNode(
  TSL: any,
  bx: any,
  bz: any,
  uTime: any,
  uRadPerPixel: any,
  dist: any,
): { dx: any; dz: any } {
  const scale = 1 / DETAIL_FEATURE_M;
  const tap = (ox: number, oz: number): any =>
    TSL.mx_noise_float(
      TSL.vec3(
        bx.add(TSL.float(ox)).mul(TSL.float(scale)).add(uTime.mul(TSL.float(SCROLL_A[0] * scale))),
        bz.add(TSL.float(oz)).mul(TSL.float(scale)).add(uTime.mul(TSL.float(SCROLL_A[1] * scale))),
        TSL.float(0),
      ),
    );
  const n0 = tap(0, 0);
  const nx = tap(EPS_M, 0);
  const nz = tap(0, EPS_M);

  const d1: any = TSL.float(DETAIL_FEATURE_M / 2).div(uRadPerPixel);
  const d0: any = d1.mul(TSL.float(0.5));
  const w: any = TSL.float(1).sub(TSL.smoothstep(d0, d1, dist));

  const k = GAIN / EPS_M;
  const dx = nx.sub(n0).mul(TSL.float(k)).mul(w);
  const dz = nz.sub(n0).mul(TSL.float(k)).mul(w);
  const budget = TSL.float(DETAIL_SLOPE_BUDGET);
  return {
    dx: TSL.clamp(dx, budget.mul(-1), budget),
    dz: TSL.clamp(dz, budget.mul(-1), budget),
  };
}
