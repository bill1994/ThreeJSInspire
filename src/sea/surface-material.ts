/**
 * Sea surface material (Task 5): Lagrangian Gerstner displacement with a
 * per-train distance fade, plus a per-fragment base ramp and crest tint.
 *
 * Lagrangian rule (plan Global Constraints, stylized-sea C4): displacement and
 * sampling both evaluate at BASE coordinates. The vertex stage builds the base
 * world position from `modelWorldMatrix * positionLocal` and evaluates the
 * Gerstner sum there; the result is never fed back into the sampler, so the
 * old self-feedback bug (sampling post-displacement coordinates) is
 * structurally impossible. `positionWorld` is deliberately never read: inside
 * a graph that overrides `positionNode` it would close the loop.
 *
 * `positionLocal` (not `positionGeometry`): the plan names `positionGeometry`,
 * but the TSL skill wires displacement on `positionLocal`, which additionally
 * carries skinning / morph / batching transforms. This surface has none of
 * those, so the two are identical here; `positionLocal` is kept so a future
 * instanced foam pass does not silently sample the wrong frame.
 *
 * Local-to-world mapping (see `bands.ts`): geometry is authored in local XY
 * with +Z up, laid flat by `rotation.x = -PI/2`, so local (x, y, z) lands at
 * world (x + mx, z + my, -y + mz). Displacing local by (ox, -oz, h) therefore
 * lands at world (baseX + ox, h, baseZ + oz), which is exactly the displaced
 * surface point `(x + ox, y, z + oz)` that `gerstnerField` in `waves.ts`
 * defines. Dropping `ox`/`oz` would rebuild the "有面无形" failure that got
 * the FFT sea deleted, so the chop terms are load-bearing, not decoration.
 *
 * Per-train fade (spec M4): weight is `1 - smoothstep(d0, d1, dist)` with
 * `d1 = A / uRadPerPixel` (per-frame uniform, so the 60 -> 69 deg fov flight
 * cannot flatten the water) and `d0 = d1 - 48` (one band width; 48 is the
 * pre-retune B0 extent and is kept as the conservative, wider fade). There is
 * exactly one exception: B0 ends at 45 m while train 5 lives to ~104 m (D7),
 * so the finest train of a 5-train material reaches 0 at 45 m, not at its
 * visibility distance — otherwise the edge carries a 2.2 px step (M5). The
 * builder only knows the train count, and B0 is the only 5-train band, so the
 * cap applies to train index 4 when `trains >= 5`; a retune that moves the
 * 5-train set elsewhere must revisit this line.
 *
 * Fragment work (spec M10): the base ramp and the crest tint re-evaluate the
 * exact height sum PER FRAGMENT at the base position carried down in a
 * varying — vertex-interpolated height would alias the short trains into
 * low-frequency mottling at distance. This task wires height only; the
 * per-pixel analytic normal arrives with the light terms (stylized-sea
 * follow-up), because computing it here would double the fragment
 * transcendentals for zero wired effect. The ramp stops (deep -> mid -> lit)
 * and the crest window are provisional: total amplitude is 0.89 m and typical
 * crests read ~0.4-0.6 m, so the numbers below are a starting point to be
 * eye-tuned against frozen captures, not a calibration.
 *
 * M11: `fog` is false; the sea's own haze owns distance colour (that haze
 * ramp itself lands with the shading follow-ups, not here).
 *
 * No static `three/webgpu` or `three/tsl` import anywhere in this module —
 * both arrive via dynamic `import()` inside the builder, so the boot graph
 * never links the WebGPU build (see `module-graph.test.ts` and the Task 5
 * source-scan test in `surface-material.test.ts`).
 */

import { TRAINS } from './waves';
import { CANONICAL_RAD_PER_PIXEL } from './lod';
import { SEA_PALETTE } from '../palettes';

/** Fade width in metres: weight goes 1 -> 0 over `[d1 - 48, d1]` (M4). */
export const TRAIN_FADE_WIDTH_M = 48;

/** M4 exception: the finest train of the 5-train (B0) material is gone at 45 m. */
export const B0_TRAIN5_FADE_END_M = 45;

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

/**
 * Fade factor for one train at `distance` metres under `radPerPixel`.
 *
 * `1 - smoothstep(d0, d1, dist)` with `d1 = amplitude / radPerPixel` and
 * `d0 = d1 - TRAIN_FADE_WIDTH_M`. `fadeEnd` optionally caps `d1` (the M4
 * exception for B0's train 5); the default leaves the visibility distance
 * untouched. A broken budget degrades to full weight — extra displacement,
 * never missing water.
 */
export function trainWeight(
  amplitude: number,
  distance: number,
  radPerPixel: number,
  fadeEnd: number = Infinity,
): number {
  if (
    !Number.isFinite(amplitude) ||
    !Number.isFinite(distance) ||
    !Number.isFinite(radPerPixel) ||
    radPerPixel <= 0 ||
    amplitude <= 0
  ) {
    return 1;
  }
  let d1 = amplitude / radPerPixel;
  if (Number.isFinite(fadeEnd) && fadeEnd > 0 && fadeEnd < d1) d1 = fadeEnd;
  const d0 = d1 - TRAIN_FADE_WIDTH_M;
  return 1 - smoothstep(d0, d1, distance);
}

export interface SurfaceMaterialOpts {
  trains: number;
  radPerPixel: number;
}

/**
 * CPU mirror of the material's uniforms, for node tests: no GPU needed.
 *
 * Degenerate budgets fall back to the hardest configuration (never zero), and
 * the train count is truncated into `[0, TRAINS.length]` with a non-finite
 * input meaning "everything" — both err toward visible water.
 */
export function materialUniforms(opts: SurfaceMaterialOpts): Map<string, { value: number }> {
  const rp =
    Number.isFinite(opts.radPerPixel) && opts.radPerPixel > 0
      ? opts.radPerPixel
      : CANONICAL_RAD_PER_PIXEL;
  const n = Number.isFinite(opts.trains)
    ? Math.min(Math.max(Math.trunc(opts.trains), 0), TRAINS.length)
    : TRAINS.length;
  return new Map<string, { value: number }>([
    ['uRadPerPixel', { value: rp }],
    ['uTime', { value: 0 }],
    ['uTrains', { value: n }],
  ]);
}

export interface SurfaceUniforms {
  uTime: { value: number };
  uRadPerPixel: { value: number };
  uTrains: { value: number };
}

/**
 * Build one band's TSL node in the Gerstner sum at base (bx, bz).
 *
 * `withChop` selects the horizontal terms: the vertex stage needs them (the
 * displaced point), the fragment stage only re-evaluates height for the ramp
 * and crest tint (see the module header for why the normal waits).
 */
function gerstnerNodes(
  TSL: any,
  trainCount: number,
  bx: any,
  bz: any,
  dist: any,
  uTime: any,
  uRadPerPixel: any,
  uTrains: any,
  withChop: boolean,
): { h: any; ox: any; oz: any } {
  let h: any = TSL.float(0);
  let ox: any = TSL.float(0);
  let oz: any = TSL.float(0);
  for (let i = 0; i < trainCount; i++) {
    const tr = TRAINS[i];
    const k = (Math.PI * 2) / tr.lambda;
    let d1: any = TSL.float(tr.amp).div(uRadPerPixel);
    if (trainCount >= 5 && i === 4) {
      // M4 exception, band-agnostic form: the only 5-train band is B0.
      d1 = TSL.select(d1.lessThan(TSL.float(B0_TRAIN5_FADE_END_M)), d1, TSL.float(B0_TRAIN5_FADE_END_M));
    }
    const d0 = d1.sub(TSL.float(TRAIN_FADE_WIDTH_M));
    const w = TSL.float(1).sub(TSL.smoothstep(d0, d1, dist));
    // M9: the fine tier drops the finest trains at runtime. The graph is still
    // built for `trainCount` trains (a TSL loop bound cannot be a uniform),
    // so the low tier masks the surplus ones out of the SUM instead of
    // rebuilding the material. That fixes the appearance, not the cost — see
    // the module header for the half of M9 that is deferred.
    const active = TSL.select(uTrains.greaterThan(TSL.float(i)), TSL.float(1), TSL.float(0));
    const phase = TSL.float(k)
      .mul(TSL.float(tr.dir[0]).mul(bx).add(TSL.float(tr.dir[1]).mul(bz)))
      .sub(TSL.float(tr.speed).mul(uTime));
    const s = TSL.sin(phase);
    h = h.add(TSL.float(tr.amp).mul(s).mul(w).mul(active));
    if (withChop) {
      const c = TSL.cos(phase);
      const qa = tr.sharpnessQ * tr.amp;
      ox = ox.add(TSL.float(qa * tr.dir[0]).mul(c).mul(w).mul(active));
      oz = oz.add(TSL.float(qa * tr.dir[1]).mul(c).mul(w).mul(active));
    }
  }
  return { h, ox, oz };
}

/**
 * Build the band material for `opts.trains` trains.
 *
 * `THREE_NS` is the three.js namespace (injected so tests pass the real one
 * without this module statically importing anything but pure-math siblings).
 * The returned `uniforms` are live TSL uniform nodes — the caller writes
 * `uTime` / `uRadPerPixel` per frame — and the same object is stashed on
 * `material.userData.seaUniforms` so per-frame plumbing needs no new handle.
 */
export async function buildSurfaceMaterial(
  THREE_NS: any,
  opts: SurfaceMaterialOpts,
): Promise<{ material: any; uniforms: SurfaceUniforms }> {
  const TSL: any = await import('three/tsl');
  const WEB: any = await import('three/webgpu');

  const mirror = materialUniforms(opts);
  const rp = mirror.get('uRadPerPixel')!.value;
  const n = mirror.get('uTrains')!.value;

  const uTime = TSL.uniform(0);
  const uRadPerPixel = TSL.uniform(rp);
  const uTrains = TSL.uniform(n);

  // Base world position BEFORE displacement: the Lagrangian sample point.
  const pl = TSL.positionLocal;
  const base4 = TSL.modelWorldMatrix.mul(TSL.vec4(pl.x, pl.y, pl.z, 1));
  const bx = base4.x;
  const bz = base4.z;
  const distV = TSL.length(base4.xyz.sub(TSL.cameraPosition));

  const v = gerstnerNodes(TSL, n, bx, bz, distV, uTime, uRadPerPixel, uTrains, true);
  // Local (x + ox, y - oz, h) -> world (baseX + ox, h, baseZ + oz): the
  // displaced surface point, with the chop mapped through the -90 deg X lay-flat.
  const material = new WEB.MeshBasicNodeMaterial();
  material.positionNode = TSL.vec3(pl.x.add(v.ox), pl.y.sub(v.oz), v.h);

  // The fragment re-derives height from the exact sum at the base position —
  // interpolated vertex height would alias the short trains at distance.
  const vBase = TSL.varying(TSL.vec3(bx, TSL.float(0), bz), 'vSeaBase');
  const distF = TSL.length(vBase.sub(TSL.cameraPosition));
  const f = gerstnerNodes(TSL, n, vBase.x, vBase.z, distF, uTime, uRadPerPixel, uTrains, false);
  const col = (hex: number): any => TSL.color(new THREE_NS.Color(hex));
  let colorNode: any = TSL.mix(
    col(SEA_PALETTE.deep),
    col(SEA_PALETTE.mid),
    TSL.smoothstep(TSL.float(-0.55), TSL.float(0.05), f.h),
  );
  colorNode = TSL.mix(
    colorNode,
    col(SEA_PALETTE.lit),
    TSL.smoothstep(TSL.float(0.0), TSL.float(0.4), f.h),
  );
  colorNode = TSL.mix(
    colorNode,
    col(SEA_PALETTE.crest),
    TSL.smoothstep(TSL.float(0.38), TSL.float(0.6), f.h),
  );
  material.colorNode = colorNode;

  // M11: the sea opts out of scene.fog; its own haze owns distance colour.
  material.fog = false;

  const uniforms: SurfaceUniforms = { uTime, uRadPerPixel, uTrains };
  material.userData.seaUniforms = uniforms;
  return { material, uniforms };
}
