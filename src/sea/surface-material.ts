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
import { SEA_PALETTE, SUN_DIRECTION } from '../palettes';
import { SUN_ROAD, fresnel01, sunRoadGain } from '../sun-road';

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

// ---------------------------------------------------------------------------
// Light terms (Task 5). Pure mirrors of what the shader does, so the look can be
// argued about on the CPU instead of by squinting at a frame. Every constant
// here is a uniform in the graph — change it once, both sides move.
// ---------------------------------------------------------------------------

/** Distance (m) over which the far field becomes pure haze. `far` matches `HAZE_FAR` at the horizon. */
export const DISTANCE_TINT = { near: 600, far: 2000 } as const;

/** Falloff exponent of the analytic sky reflection: 1 at grazing, 0 looking straight down. */
export const REFLECTION_EXP = 4;

/** Glitter is a solid sheet right under the camera without this; it fades in over 20 m. */
export const NEAR_GLITTER_FADE_M = 20;

/**
 * Colour the grazing reflection is pushed toward — warm, not white.
 *
 * White here reads as a grey sheen and kills the violet water (the same failure the
 * `FRESNEL_GAIN` comment in `sun-road.ts` records at 0.55). `lit` is the sea's own warm
 * band, so the sheen arrives in the palette instead of on top of it.
 */
export const FRESNEL_TINT = SEA_PALETTE.lit;

/** How far the reflection colour is pushed toward `FRESNEL_TINT`. Small on purpose. */
export const FRESNEL_TINT_MIX = 0.35;

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0;
}

function smoothstepN(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/**
 * How much haze owns the pixel: 0 inside `near`, 1 beyond `far`.
 *
 * A non-finite distance reads as 1 (fully hazed) rather than 0: an unmeasurable distance
 * must not flash the near colour across the whole patch — the far end of this fade is the
 * one place where being wrong is invisible, because the haze colour *is* the sky there.
 */
export function distanceTint01(distance: number): number {
  if (!Number.isFinite(distance)) return 1;
  return smoothstepN(DISTANCE_TINT.near, DISTANCE_TINT.far, distance);
}

/**
 * Analytic sky reflection weight from the surface normal's Y.
 *
 * 0 with the normal straight up (you are looking into deep water), 1 at grazing (you see
 * the horizon band). No mirror pass and no planar reflection: this is a gradient, and it
 * is the reason the far water warms toward the sky instead of ending at a hard line.
 */
export function reflection01(normalY: number): number {
  if (!Number.isFinite(normalY)) return 0;
  return Math.pow(1 - clamp01(normalY), REFLECTION_EXP);
}

/**
 * Schlick Fresnel, straight from `sun-road.ts` so there is one curve, not two.
 *
 * This is the RAW term (grazing → 1). The graph multiplies it by
 * `SUN_ROAD.FRESNEL_GAIN` before it touches colour; keep that multiplication out of here
 * so the physical curve stays comparable with the number `sun-road.test.ts` pins.
 */
export function fresnelWeight(cosTheta: number): number {
  return fresnel01(cosTheta);
}

/** The glint gain, gated into a road toward the sun. Thin alias over the single source. */
export function glitterGain(spec: number, azimuthDiff: number, nearFade: number): number {
  return sunRoadGain(spec, azimuthDiff, nearFade);
}

/** Ramp for the near-field glitter: 0 under the camera, 1 past `NEAR_GLITTER_FADE_M`. */
export function nearGlitterFade(distance: number): number {
  if (!Number.isFinite(distance)) return 0;
  return smoothstepN(0, NEAR_GLITTER_FADE_M, distance);
}

export interface SurfaceMaterialOpts {
  trains: number;
  radPerPixel: number;
}/**
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

// ---------------------------------------------------------------------------
// Base ramp (Task 7). These stops were literals inside the builder; they are
// exported because the band *shares* are a measurable property of the ramp, not
// a matter of taste: `surface-material.test.ts` evaluates the real field against
// these exact numbers and fails if a band owns less than 5%, more than 40%, or
// the crest drops under 10% of the water.
// ---------------------------------------------------------------------------

/**
 * Height thresholds (metres) where the ramp hands over from one band to the next.
 *
 * The field spans only +-0.89 m, so these are cuts into a very narrow strip. The
 * pre-Task-7 values (-0.55/0.05, 0.0/0.4, 0.38/0.6) measured mid 45.6% of the water and
 * crest 6.3% — half the surface one flat colour, the crest reduced to a hint. This set
 * measured 19.4 / 33.2 / 29.7 / 17.7.
 */
export const SEA_RAMP = {
  deepToMid: [-0.46, -0.28],
  midToLit: [-0.14, 0.12],
  litToCrest: [0.28, 0.48],
} as const;

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
): { h: any; ox: any; oz: any; dhdx: any; dhdz: any } {
  let h: any = TSL.float(0);
  let ox: any = TSL.float(0);
  let oz: any = TSL.float(0);
  // Slope (dh/dx, dh/dz) for the analytic normal. Accumulated in the SAME loop as the
  // height, from the same phase term — a second pass would double the fragment
  // transcendentals to recompute what is already sitting here.
  let dhdx: any = TSL.float(0);
  let dhdz: any = TSL.float(0);
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
    // built for `trainCount` trains (a TSL loop bound cannot be a uniform), so
    // the low tier masks the surplus ones out of the SUM instead of rebuilding
    // the material. That fixes the appearance, not the cost — every train's
    // sin/cos still executes; see the module header for the deferred half of M9.
    //
    // The mask is a ramp, not a step: `uTrains` is eased by the caller, and
    // smoothstep(i, i+1, ...) makes an integer tier a clean on/off while a
    // fractional one is a genuinely partial train, so a governor step-down
    // fades the finest train out instead of deleting 0.15 m of swell between
    // two frames.
    const active = TSL.smoothstep(TSL.float(i), TSL.float(i + 1), uTrains);
    const phase = TSL.float(k)
      .mul(TSL.float(tr.dir[0]).mul(bx).add(TSL.float(tr.dir[1]).mul(bz)))
      .sub(TSL.float(tr.speed).mul(uTime));
    const s = TSL.sin(phase);
    h = h.add(TSL.float(tr.amp).mul(s).mul(w).mul(active));
    // cos is needed by the chop AND by the slope, so it is computed once, here.
    const c = TSL.cos(phase);
    const ak = tr.amp * k;
    dhdx = dhdx.add(TSL.float(ak * tr.dir[0]).mul(c).mul(w).mul(active));
    dhdz = dhdz.add(TSL.float(ak * tr.dir[1]).mul(c).mul(w).mul(active));
    if (withChop) {
      const qa = tr.sharpnessQ * tr.amp;
      ox = ox.add(TSL.float(qa * tr.dir[0]).mul(c).mul(w).mul(active));
      oz = oz.add(TSL.float(qa * tr.dir[1]).mul(c).mul(w).mul(active));
    }
  }
  return { h, ox, oz, dhdx, dhdz };
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

  // ---- Base ramp and crest tint (structure from the LOD plan's Task 5) ----
  let colorNode: any = TSL.mix(
    col(SEA_PALETTE.deep),
    col(SEA_PALETTE.mid),
    TSL.smoothstep(TSL.float(SEA_RAMP.deepToMid[0]), TSL.float(SEA_RAMP.deepToMid[1]), f.h),
  );
  colorNode = TSL.mix(
    colorNode,
    col(SEA_PALETTE.lit),
    TSL.smoothstep(TSL.float(SEA_RAMP.midToLit[0]), TSL.float(SEA_RAMP.midToLit[1]), f.h),
  );
  colorNode = TSL.mix(
    colorNode,
    col(SEA_PALETTE.crest),
    TSL.smoothstep(TSL.float(SEA_RAMP.litToCrest[0]), TSL.float(SEA_RAMP.litToCrest[1]), f.h),
  );

  // ---- Light terms (Task 5) ----
  // Surface point = base xz + the height just evaluated. The horizontal chop (<= 0.50 m
  // over all five trains) is deliberately left out of the view vector: including it would
  // cost a third varying for a view-angle error under 1 deg at the nearest band edge.
  const surf = TSL.vec3(vBase.x, f.h, vBase.z);
  const toEye = TSL.normalize(TSL.cameraPosition.sub(surf));
  // Heightfield normal, built from the slope the height sum already produced. Same
  // approximation `waves.ts` documents (Ny = 1 - sum(Q k A sin phi), error <= 7%).
  const normal = TSL.normalize(TSL.vec3(f.dhdx.mul(-1), TSL.float(1), f.dhdz.mul(-1)));

  // Fresnel: the RAW Schlick curve from sun-road.ts, scaled by its gain. The gain is what
  // keeps this a warm-up at grazing instead of a second light that flattens the bands.
  const cosT = TSL.max(TSL.dot(normal, toEye), TSL.float(0));
  const fr = TSL.float(SUN_ROAD.F0).add(
    TSL.float(1 - SUN_ROAD.F0).mul(
      TSL.pow(TSL.float(1).sub(cosT), TSL.float(5)),
    ),
  );
  const fresnelGainNode = fr.mul(TSL.float(SUN_ROAD.FRESNEL_GAIN));

  // Analytic sky reflection: deep straight down, horizon at grazing, then warmed toward
  // FRESNEL_TINT so the sheen is sunset light rather than a grey sheet.
  const reflWeight = TSL.pow(
    TSL.float(1).sub(TSL.clamp(normal.y, TSL.float(0), TSL.float(1))),
    TSL.float(REFLECTION_EXP),
  );
  const skyRefl = TSL.mix(col(SEA_PALETTE.deep), col(SEA_PALETTE.haze), reflWeight);
  const warmRefl = TSL.mix(skyRefl, col(FRESNEL_TINT), TSL.float(FRESNEL_TINT_MIX));
  colorNode = TSL.mix(colorNode, warmRefl, fresnelGainNode);

  // Sun glitter, gated into a road. `sun-road.ts` owns every constant here; this is the
  // composition it was written for, in TSL instead of on a ping-pong buffer.
  const sunDir = TSL.vec3(
    TSL.float(SUN_DIRECTION[0]),
    TSL.float(SUN_DIRECTION[1]),
    TSL.float(SUN_DIRECTION[2]),
  );
  const incident = sunDir.mul(-1);
  const reflected = incident.sub(normal.mul(TSL.dot(incident, normal).mul(2)));
  const specBase = TSL.max(TSL.dot(reflected, toEye), TSL.float(0));
  // A flat facet mirrors the sun (narrow); a steep one smears it (broad).
  const slopeNode = TSL.clamp(
    TSL.float(1).sub(normal.y).div(TSL.float(SUN_ROAD.SLOPE_FULL)),
    TSL.float(0),
    TSL.float(1),
  );
  const expoNode = TSL.float(SUN_ROAD.NARROW).add(
    TSL.float(SUN_ROAD.BROAD - SUN_ROAD.NARROW).mul(slopeNode),
  );
  const spec = TSL.pow(specBase, expoNode);
  // Bearings are horizontal: the sun's is a constant (normalized on the CPU, since
  // SUN_DIRECTION is fixed), the view's is projected from toEye every fragment.
  const sunBearingLen = Math.hypot(SUN_DIRECTION[0], SUN_DIRECTION[2]);
  const sunBearing = TSL.vec2(
    TSL.float(SUN_DIRECTION[0] / sunBearingLen),
    TSL.float(SUN_DIRECTION[2] / sunBearingLen),
  );
  const viewBearing = TSL.normalize(TSL.vec2(toEye.x, toEye.z));
  const azimuth = TSL.acos(TSL.clamp(TSL.dot(sunBearing, viewBearing), TSL.float(-1), TSL.float(1)));
  const cosEdge = Math.cos((SUN_ROAD.WIDTH_DEG * Math.PI) / 180);
  const roadT = TSL.clamp(
    TSL.cos(azimuth).sub(TSL.float(cosEdge)).div(TSL.float(1 - cosEdge)),
    TSL.float(0),
    TSL.float(1),
  );
  const roadMaskNode = roadT.mul(roadT).mul(TSL.float(3).sub(roadT.mul(2)));
  const gateNode = TSL.float(SUN_ROAD.ROAD_FLOOR).add(
    TSL.float(SUN_ROAD.ROAD_PEAK - SUN_ROAD.ROAD_FLOOR).mul(roadMaskNode),
  );
  const nearFadeNode = TSL.smoothstep(TSL.float(0), TSL.float(NEAR_GLITTER_FADE_M), distF);
  const gainNode = spec.mul(TSL.float(SUN_ROAD.BASE)).mul(nearFadeNode).mul(gateNode);
  // Additive and HDR (the road's peak is > 1): that is what the bloom threshold was tuned
  // against, so it must stay an add, not a mix.
  colorNode = colorNode.add(col(SEA_PALETTE.glitter).mul(gainNode));

  // Distance tint last: the far field dissolves into the contracted haze, never into black.
  colorNode = TSL.mix(
    colorNode,
    col(SEA_PALETTE.haze),
    TSL.smoothstep(TSL.float(DISTANCE_TINT.near), TSL.float(DISTANCE_TINT.far), distF),
  );
  material.colorNode = colorNode;

  // M11: the sea opts out of scene.fog; its own haze owns distance colour.
  material.fog = false;

  const uniforms: SurfaceUniforms = { uTime, uRadPerPixel, uTrains };
  material.userData.seaUniforms = uniforms;
  // Marker the test suite asserts on: the light chain is wired into the graph, not just
  // implemented as CPU mirrors that nothing samples.
  material.userData.seaLight = true;
  return { material, uniforms };
}
