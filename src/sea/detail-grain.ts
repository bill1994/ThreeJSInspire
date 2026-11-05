/**
 * Grain layer — high-frequency detail normals sampled from a generated normal map.
 *
 * History, because both earlier shapes are still visible in the design:
 * 1. A sum of short sine trains measured fine and looked like wallpaper (periodic). Rejected,
 *    evidence in `artifacts/archive/sea-detail-attempt/`.
 * 2. Three `mx_noise_float` taps gave a real aperiodic gradient and looked right — but cost
 *    **6x the analytic field's per-pixel price** (measured: water 2.25 -> 16.15 ms at
 *    4096x7279), because MaterialX noise is a procedural evaluation.
 * 3. This: bake the same noise into a **tileable normal map** once at startup, then pay two
 *    texture fetches per fragment. The map's pixels are the single source of truth — the
 *    shader reads the very array the tests check.
 *
 * Division of labour with `waves.ts` is unchanged: the Gerstner field is the *form*
 * (displacement, analytic normal, Jacobian). This layer only perturbs the normal — it never
 * displaces — and it fades on the same angular budget as the swell trains.
 *
 * The reference (`_refs/Uber-Stylized-Water`) samples its normal map twice from opposite
 * directions (`Normal_Pan` is a single value for that reason); the two-sample structure here
 * follows it, at two different scales instead of two pan directions.
 */

/** One noise cell in metres: the spatial scale of the grain. Also drives the fade distance. */
export const DETAIL_FEATURE_M = 3;

/** Hard bound on how far the grain may tilt the normal (dimensionless slope). */
export const DETAIL_SLOPE_BUDGET = 0.14;

/** Normal-map resolution. 256 is plenty for a pattern that repeats every few metres. */
export const DETAIL_MAP_SIZE = 512;

/** Noise cells across the map. Must divide evenly for the tiling to be seamless. */
const DETAIL_MAP_CELLS = 14;

/** Height amplitude of the baked field, in map units, before the normal is derived. */
const DETAIL_MAP_AMP = 1;

function hash2(ix: number, iy: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Wrap the lattice index so the noise tiles: this is what makes the texture seamless. */
function wrapIndex(i: number, period: number): number {
  return ((i % period) + period) % period;
}

function valueNoiseTileable(x: number, y: number, period: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const i0 = wrapIndex(x0, period);
  const j0 = wrapIndex(y0, period);
  const i1 = wrapIndex(x0 + 1, period);
  const j1 = wrapIndex(y0 + 1, period);
  const a = hash2(i0, j0);
  const b = hash2(i1, j0);
  const c = hash2(i0, j1);
  const d = hash2(i1, j1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Two octaves, both periodic on the same tile. */
function heightAt(u: number, v: number): number {
  const coarse = valueNoiseTileable(u * DETAIL_MAP_CELLS, v * DETAIL_MAP_CELLS, DETAIL_MAP_CELLS);
  const fine = valueNoiseTileable(
    u * DETAIL_MAP_CELLS * 2,
    v * DETAIL_MAP_CELLS * 2,
    DETAIL_MAP_CELLS * 2,
  );
  return (coarse * 0.65 + fine * 0.35) * DETAIL_MAP_AMP;
}

/**
 * Build the tileable tangent-space normal map as RGBA bytes.
 *
 * Height is sampled on an integer lattice and differenced with wrap-around, so the normals
 * across the seam are continuous with their neighbours — a tiling artefact here would show up
 * as a visible grid on the water, exactly the failure the sine version died of.
 *
 * Red = +x slope, Green = +z slope, Blue = up, all encoded `0.5 + 0.5 * n`.
 */
export function buildDetailNormalMap(size: number = DETAIL_MAP_SIZE): Uint8Array {
  const n = Math.max(4, Math.trunc(size));
  const data = new Uint8Array(n * n * 4);
  const h = new Float64Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      h[y * n + x] = heightAt(x / n, y / n);
    }
  }
  const wrap = (i: number): number => ((i % n) + n) % n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const hl = h[y * n + wrap(x - 1)];
      const hr = h[y * n + wrap(x + 1)];
      const hd = h[wrap(y - 1) * n + x];
      const hu = h[wrap(y + 1) * n + x];
      // Central differences; the 2/texel scale only sets how steep the baked normals are.
      const sx = (hr - hl) * n * 0.5;
      const sz = (hu - hd) * n * 0.5;
      const inv = 1 / Math.hypot(sx, 1, sz);
      const i = (y * n + x) * 4;
      data[i] = Math.round((0.5 - 0.5 * sx * inv) * 255);
      data[i + 1] = Math.round((0.5 - 0.5 * sz * inv) * 255);
      data[i + 2] = Math.round((0.5 + 0.5 * inv) * 255);
      data[i + 3] = 255;
    }
  }
  return data;
}

/**
 * Distance weight for the grain: 1 near, 0 once one feature spans under two pixels.
 *
 * Same rule as the swell trains (`feature / (2 * radPerPixel)`). A grain layer has to fade on
 * its feature size, not its height: a 3 m ripple is already aliasing when it is one pixel wide.
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

/** Tangent-space normal decoded from the map at texel (x, y), as a slope pair. */
export function normalAt(data: Uint8Array, size: number, x: number, y: number): { dx: number; dz: number } {
  const n = Math.max(4, Math.trunc(size));
  const i = (((y % n) + n) % n * n + (((x % n) + n) % n)) * 4;
  return {
    dx: (data[i] / 255) * 2 - 1,
    dz: (data[i + 1] / 255) * 2 - 1,
  };
}

/**
 * TSL sampling of the baked map.
 *
 * Two fetches at different scales and scroll directions, exactly like the reference's dual
 * normal sampling: one fetch alone reads as a sliding sheet. The result is clamped to
 * `DETAIL_SLOPE_BUDGET` so the grain can tilt the surface, never flip it, and faded by the
 * same angular budget as everything else.
 */
export function detailMapNode(
  TSL: any,
  texture: any,
  bx: any,
  bz: any,
  uTime: any,
  uRadPerPixel: any,
  dist: any,
): { dx: any; dz: any } {
  const sample = (scaleM: number, timeScale: number, dirX: number, dirZ: number): any => {
    const uv = TSL.vec2(
      bx.div(TSL.float(scaleM)).add(uTime.mul(TSL.float(timeScale * dirX))),
      bz.div(TSL.float(scaleM)).add(uTime.mul(TSL.float(timeScale * dirZ))),
    );
    return TSL.texture(texture, uv);
  };
  const a = sample(DETAIL_FEATURE_M, 0.035, 1, 0.6);
  const b = sample(DETAIL_FEATURE_M * 1.7, -0.02, -0.7, 1);

  // Decode: rgb in 0..1 -> tangent-space normal, x = +x slope, y = +z slope.
  const dx = a.xy.x.sub(0.5).add(b.xy.x.sub(0.5)).mul(TSL.float(2 * 0.5));
  const dz = a.xy.y.sub(0.5).add(b.xy.y.sub(0.5)).mul(TSL.float(2 * 0.5));

  const d1: any = TSL.float(DETAIL_FEATURE_M / 2).div(uRadPerPixel);
  const d0: any = d1.mul(TSL.float(0.5));
  const w: any = TSL.float(1).sub(TSL.smoothstep(d0, d1, dist));

  const budget = TSL.float(DETAIL_SLOPE_BUDGET);
  return {
    dx: TSL.clamp(dx.mul(w), budget.mul(-1), budget),
    dz: TSL.clamp(dz.mul(w), budget.mul(-1), budget),
  };
}
