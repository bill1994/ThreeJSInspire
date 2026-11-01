/**
 * WebGPU clouds — a slab raymarch written in TSL node graphs (custom GLSL does
 * not run under WebGPURenderer).
 *
 * The dome is just a backface shell at radius CLOUD_DOME_RADIUS; the volume comes
 * from marching the view ray through a horizontal slab between CLOUD_BAND.bottom and
 * CLOUD_BAND.top. Steps are unrolled at build time, so the shader has constant loop
 * bounds and no dynamism the driver has to reason about. The low quality tier
 * rebuilds the same graph with fewer steps and the fine erosion octave cut.
 */
import * as THREE from 'three';

import { CLOUD_HAZE, cloudHaze } from './horizon';
import { CLOUD_PALETTE, HAZE_COLOR, SUN_DIRECTION } from './palettes';

export type Backend = 'webgpu' | 'webgl2';

/** Shared cloud handle contract; lives here so deleting the sprite path cannot delete it. */
export interface CloudHandle {
  readonly kind: 'tsl' | 'sprite';
  update(t: number, sunDir: THREE.Vector3): void;
  /** false = degraded budget (fewer raymarch steps / dimmer puffs). */
  setQuality(high: boolean): void;
  dispose(): void;
}

/** Slightly inside the r=800 sky dome so the two shells cannot z-fight. */
const CLOUD_DOME_RADIUS = 780;

/**
 * The one cloud band. D2 merged the old bank (95..265) and the wisp deck (30..82) into a
 * single slab; D1 set the top so the deck can grow a tower — the review measured the
 * reference's central cloud column at aspect ≈1.95, which the old 170 m slab could never
 * reach. `in-cloud.ts` and the puff scatter both read this, so it is the single source
 * for every "how tall is the deck" question.
 */
export const CLOUD_BAND = { bottom: 95, top: 480 } as const;

/**
 * Vertical profile of the tower body. The old mask was a lens — `smoothstep(0.02,0.26) ×
 * (1 - smoothstep(0.62,1.0))` — which held the dense body to a 61 m ribbon mid-slab and
 * is why the deck read as a pancake. The tower instead holds full density from the base
 * to `waist`, then falls off over the remaining height:
 *
 * - `base`: plateau density while `hFrac ≤ waist` (≥0.85 keeps the cloud floor solid);
 * - `waist`: hFrac where the taper starts (0..1 of the slab height);
 * - `topBias`: power on the taper — >1 holds the shoulders fuller and rounds the top.
 */
export interface CloudProfile {
  base: number;
  waist: number;
  topBias: number;
}

export const CLOUD_PROFILE: CloudProfile = { base: 0.92, waist: 0.45, topBias: 1.6 };

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0;
}

/**
 * Density of the tower body at normalised slab height `hFrac`, 0..1. The tested JS mirror
 * of the TSL expression in `createTslCloudMaterial` — the shader inlines the same three
 * constants, the same way `horizon.ts` and `sun-road.ts` mirror their graphs.
 *
 * Non-finite inputs read 0 rather than injecting NaN into the march.
 */
export function profileDensity(hFrac: number, p: CloudProfile): number {
  if (!Number.isFinite(hFrac) || !p) return 0;
  if (!Number.isFinite(p.base) || !Number.isFinite(p.waist) || !Number.isFinite(p.topBias)) return 0;
  const base = clamp01(p.base);
  const waist = clamp01(p.waist);
  const topBias = Math.max(p.topBias, 1e-6);
  const h = clamp01(hFrac);
  // Hermite smoothstep from the waist to the top; below the waist the body is the plateau.
  const span = 1 - waist;
  const t = span > 1e-6 ? clamp01((h - waist) / span) : h >= 1 ? 1 : 0;
  const taper = t * t * (3 - 2 * t);
  return base * (1 - Math.pow(taper, topBias));
}

/**
 * Noise-blend weights for the shape sum, per quality tier. The fine erosion octave
 * undersamples at CLOUD_STEPS_LOW and only injects aliasing there, so it is cut and its
 * weight renormalised across the two remaining terms — keeping the sum's mean where the
 * density threshold band (0.5..0.68) was tuned. Tested mirror of the build-time branch
 * in `createTslCloudMaterial`.
 */
export function cloudErosionWeights(steps: number): { blobs: number; coarse: number; fine: number } {
  const fine = Number.isFinite(steps) && steps >= CLOUD_STEPS_HIGH ? 0.15 : 0;
  const scale = 1 / (0.85 + fine);
  return { blobs: 0.55 * scale, coarse: 0.30 * scale, fine };
}

/**
 * Shape/depth constants for the cloud body lighting. The TSL graph in
 * `createTslCloudMaterial` reads these same values, so the tested mirror below and the
 * shader cannot drift apart.
 */
export const CLOUD_LIGHTING = {
  /** Depth (1 - transmittance) where the body starts losing light. */
  depthNear: 0.05,
  /** Depth where the body is fully in shadow. */
  depthFar: 0.78,
  /** How much of the body light the march progress takes away by the last step. */
  progressDarken: 0.3,
  /** Weak sun-side bias, gated by local transmittance so only surface samples get it. */
  sunBias: 0.15,
} as const;

/**
 * T2 — advection rates, in noise-space units per second (multiply by `1 / noiseScale` for
 * metres per second; the slab's `noiseScale` is 0.0065, so BASE is about 1.5 m/s).
 *
 * The deck used to advect as one rigid plate: a single `windOffset` for every sample, so all
 * three noise octaves and every height moved in lockstep and the cloud only ever *translated*.
 * `SHEAR` makes the offset grow linearly with the sample's height inside the slab, so the
 * top of a tower moves faster than its base — that is what makes the volume evolve rather
 * than slide. Relative difference between base and top is `SHEAR / BASE` = 60%.
 */
export const CLOUD_WIND = {
  BASE: 0.01,
  SHEAR: 0.006,
} as const;

/**
 * Lit amount (0..1) of one raymarch sample, from how deep it sits in the volume — the
 * tested JS mirror of the TSL expression in `createTslCloudMaterial`.
 *
 * This replaces the old `dot(viewRay, sunDir)` near-neighbour: that term lit every sample
 * on the sun side of the sky regardless of how much cloud was in front of it, which is why
 * the deck read as one flat luminance. The body now darkens with (a) the transmittance
 * already absorbed before the sample and (b) progress along the march; `sunTight` survives
 * only as a weak surface bias. Non-finite inputs read 0.
 */
export function cloudLighting(o: {
  accumTransmittance: number;
  stepIndex: number;
  steps: number;
  sunTight: number;
}): number {
  const t = o?.accumTransmittance;
  const i = o?.stepIndex;
  const n = o?.steps;
  const s = o?.sunTight;
  if (![t, i, n, s].every(Number.isFinite)) return 0;
  if (n <= 0) return 0;
  const transmittance = Math.min(Math.max(t, 0), 1);
  const progress = Math.min(Math.max((i + 0.5) / n, 0), 1);
  const sun = Math.min(Math.max(s, 0), 1);
  const depth = 1 - transmittance;
  const band = (depth - CLOUD_LIGHTING.depthNear) / (CLOUD_LIGHTING.depthFar - CLOUD_LIGHTING.depthNear);
  const tb = Math.min(Math.max(band, 0), 1);
  const body = 1 - (tb * tb * (3 - 2 * tb));
  const lit =
    body * (1 - CLOUD_LIGHTING.progressDarken * progress) +
    CLOUD_LIGHTING.sunBias * sun * transmittance;
  return Math.min(Math.max(lit, 0), 1);
}

/**
 * Reference slab intersection for the view ray, mirrored by the TSL graph below
 * (the shader inlines the same clamp; this one is what the unit tests pin).
 * `tStart` is clamped at 0 so a camera already inside the slab integrates forward
 * only — an unclamped negative start would flip the whole march behind the camera.
 */
export function slabRayT(
  camY: number,
  dirY: number,
  tMax: number,
  bottom: number = CLOUD_BAND.bottom,
  top: number = CLOUD_BAND.top,
): { tStart: number; tEnd: number } {
  if (!Number.isFinite(camY) || !Number.isFinite(dirY) || !Number.isFinite(tMax)) {
    return { tStart: 0, tEnd: 0 };
  }
  const max = Math.max(tMax, 0);
  if (Math.abs(dirY) < SLAB_MIN_DIR_Y) {
    // Parallel ray: inside the slab it never exits, outside it never enters. The top bound is
    // exclusive on purpose — at exactly `y = top` the vertical profile is 1.0, where
    // `profileDensity` is 0, so marching 900 m along that plane integrates nothing; the node
    // graph's saturated crossings already answer 0 there and both sides should say the same.
    return camY >= bottom && camY < top ? { tStart: 0, tEnd: max } : { tStart: 0, tEnd: 0 };
  }
  const tBottom = (bottom - camY) / dirY;
  const tTop = (top - camY) / dirY;
  const tNear = Math.min(tBottom, tTop);
  const tFar = Math.max(tBottom, tTop);
  return { tStart: Math.max(0, tNear), tEnd: Math.min(max, tFar) };
}

/**
 * Zero-guard for the slab's signed divisor, shared by `shaderSlabSpan` and the node graph.
 *
 * It has to be an epsilon on the *signed* value, not on its magnitude: the guard exists so a
 * near-horizontal ray does not divide by ~0, and `max(abs(dir.y), eps)` did that too — but it
 * also erased the sign, which is a different bug wearing the same guard's clothes.
 */
export const SLAB_MIN_DIR_Y = 1e-6;

/**
 * The slab span **as the node graph computes it**, mirrored term for term in JS.
 *
 * `slabRayT` above is the semantic reference; this is the arithmetic the shader actually
 * performs, and it has to leave the mirror's answer standing or the two diverge silently in
 * the one quadrant no test looked at. That divergence is real and shipped: the graph guarded
 * the divisor with `max(abs(dir.y), eps)`, which erases the SIGN, so a camera inside the slab
 * pitching down got the *upward* crossing as `t1` and integrated another
 * `(camY - bottom)/|dir.y|` metres below the floor — where `hFrac` clamps to 0 and
 * `profileDensity(0)` is the full 0.92 plateau. At the 240 m ceiling that draws a white card.
 *
 * The graph itself cannot be executed here, so this transcription is the spec: change one and
 * `in-cloud.test.ts` fails until the other follows.
 */
export function shaderSlabSpan(
  camY: number,
  dirY: number,
  tMax: number,
  bottom: number = CLOUD_BAND.bottom,
  top: number = CLOUD_BAND.top,
): { t0: number; t1: number; span: number } {
  if (!Number.isFinite(camY) || !Number.isFinite(dirY) || !Number.isFinite(tMax)) {
    return { t0: 0, t1: 0, span: 0 };
  }
  // --- start of the block mirrored by createTslCloudMaterial ---
  const dy = Math.abs(dirY) < SLAB_MIN_DIR_Y ? SLAB_MIN_DIR_Y : dirY;
  const tBottom = (bottom - camY) / dy;
  const tTop = (top - camY) / dy;
  const tNear = Math.min(tBottom, tTop);
  const tFar = Math.max(tBottom, tTop);
  const t0 = Math.max(tNear, 0);
  const t1 = Math.min(tFar, 900);
  const span = Math.max(t1 - t0, 0);
  // --- end of the mirrored block ---
  return { t0, t1, span };
}

export const CLOUD_STEPS_HIGH = 12;
export const CLOUD_STEPS_LOW = 8;

/**
 * 1/m. Base noise feature size ~150 m, which fits several cumulus banks inside the 780 m
 * dome. The old 0.0021 spanned roughly one noise cell across the whole sky, so the volume
 * could only ever render as a uniform haze.
 */
const CLOUD_NOISE_SCALE = 0.0065;
/** Optical depth per step at full density. 12 steps x 0.30 -> cores are dense enough to read
 * as solid cumulus, while the outer steps stay thin so the puffs keep soft edges. */
const CLOUD_STEP_ALPHA = 0.3;
/** Luminance steps the accumulated volume is posterised into.
 *
 * The per-sample colour is already a flat band, but 12 samples of *varying density* are
 * averaged back into a smooth gradient, which is why the deck kept reading as a pastel
 * wash even after the bands went in. Quantising the accumulated result — not the
 * per-sample colour — is what actually produces the reference's colour blocks.
 * Four steps keeps the violet/pink/gold separation legible without turning the volume
 * into a paint-by-numbers poster. */
export const CLOUD_TOON_STEPS = 4;

/**
 * Quantise a 0..1 luminance to `steps` levels, centred so each input level maps to the
 * middle of its output band rather than its floor.
 *
 * This is the tested JS reference for the TSL expression in `buildCloudVolume`; the two
 * must stay in step (same pattern `horizon.ts` and `sun-road.ts` use).
 */
export function posterise01(value: number, steps: number = CLOUD_TOON_STEPS): number {
  if (!Number.isFinite(value) || !Number.isFinite(steps) || steps < 1) return 0;
  const clamped = value < 0 ? 0 : value > 1 ? 1 : value;
  const n = Math.round(steps);
  return Math.floor(clamped * n + 0.5) / n;
}


/**
 * The one horizontal slab the volume marches through.
 *
 * D2 deleted the second (wisp) slab: the near-field scraps role moved to the puff sprites,
 * and the volume is now a single tower bank so its vertical profile can develop without
 * competing with an overlapping layer. All shading — palette, quantised bands, sun terms —
 * still lives on this one spec.
 */
interface CloudSlabSpec {
  bottom: number;
  top: number;
  /** Base cell size. Larger features read as banks, smaller as scraps. */
  noiseScale: number;
  /** Optical depth per step at full density. */
  stepAlpha: number;
  /** Density threshold band. Opening the low end floods the dome. */
  densityLow: number;
  densityHigh: number;
  /** Use Worley cells for the base, or plain fractal noise (wisps are streaky, not cellular). */
  cellular: boolean;
  /** Tower body shape — see `CloudProfile` / `profileDensity`. */
  profile: CloudProfile;
}

const MAIN_SLAB: CloudSlabSpec = {
  bottom: CLOUD_BAND.bottom,
  top: CLOUD_BAND.top,
  noiseScale: CLOUD_NOISE_SCALE,
  stepAlpha: CLOUD_STEP_ALPHA,
  densityLow: 0.5,
  densityHigh: 0.68,
  cellular: true,
  profile: CLOUD_PROFILE,
};

interface CloudUniforms {
  uTime: { value: number };
  uSunDir: { value: THREE.Vector3 };
}

interface CloudMaterialBundle {
  material: any;
  uniforms: CloudUniforms;
}

/**
 * Default light for the cloud volume. Derived from `palettes.SUN_DIRECTION` so the clouds,
 * the sea glitter and the sky glow cannot light from different bearings (they used to: this
 * was `normalize(0.28, 0.14, -1)`, a different sun from the other two).
 */
const DEFAULT_SUN = new THREE.Vector3(...SUN_DIRECTION);

async function createTslCloudMaterial(
  steps: number,
  slab: CloudSlabSpec = MAIN_SLAB,
): Promise<CloudMaterialBundle> {
  const TSL = await import('three/tsl');
  const { MeshBasicNodeMaterial } = await import('three/webgpu');

  const uTime = TSL.uniform(0);
  const uSunDir = TSL.uniform(DEFAULT_SUN.clone());

  const dir = TSL.normalize(TSL.positionWorld.sub(TSL.cameraPosition));
  const camY = TSL.cameraPosition.y;

  // Guard the slab intersection: a near-horizontal ray would divide by ~0. The guard has to
  // keep the SIGN — `shaderSlabSpan` above transcribes this exact arithmetic and
  // `in-cloud.test.ts` holds it to `slabRayT`. Guarding the magnitude instead (`abs`) turned
  // the downward crossing into the upward one, so a camera inside the slab pitching down
  // marched to the far wall and kept integrating below the floor, where the height profile
  // clamps to its full plateau density.
  const dirY = TSL.select(
    TSL.lessThan(TSL.abs(dir.y), TSL.float(SLAB_MIN_DIR_Y)),
    TSL.float(SLAB_MIN_DIR_Y),
    dir.y,
  );
  const tBottom = TSL.float(slab.bottom).sub(camY).div(dirY);
  const tTop = TSL.float(slab.top).sub(camY).div(dirY);
  const tNear = TSL.min(tBottom, tTop);
  const tFar = TSL.max(tBottom, tTop);
  // Mirror of slabRayT above: start clamped at 0, never 1 — a camera already inside
  // the slab must integrate from right where it is, not from a metre ahead.
  const t0 = TSL.max(tNear, TSL.float(0));
  const t1 = TSL.min(tFar, TSL.float(900));
  const span = TSL.max(t1.sub(t0), TSL.float(0));
  const dt = span.div(steps);

  // A downward ray never enters the slab *from below* — that is why this mask exists. Once
  // the camera is inside the slab a downward ray is 100 % cloud, so masking it would punch a
  // transparent hole through the volume the player just flew into (the flight ceiling is
  // FLIGHT.ALT_MAX = 240 m, well inside the 95..480 m slab). Inside the slab, every
  // direction sees cloud.
  const insideSlab = TSL.step(TSL.float(slab.bottom), camY);
  const up = TSL.max(insideSlab, TSL.step(TSL.float(0), dir.y));

  const slabHeight = slab.top - slab.bottom;
  // Node materials shade in linear-sRGB, so the palette has to go through THREE.Color:
  // feeding the raw hex number to color() renders a washed-out pastel (the same bug the
  // sky had).
  const shadowColor = TSL.color(new THREE.Color(CLOUD_PALETTE.shadow));
  const baseColor = TSL.color(new THREE.Color(CLOUD_PALETTE.base));
  const pinkColor = TSL.color(new THREE.Color(CLOUD_PALETTE.pink));
  const goldColor = TSL.color(new THREE.Color(CLOUD_PALETTE.gold));

  // One sun term for the rim. The old broad/tight pair drove the whole body luminance off
  // `dot(viewRay, sunDir)`, which lit samples regardless of how much cloud stood in front
  // of them; the body now lights from `cloudLighting` (depth + march progress) instead.
  const sunTight = TSL.pow(TSL.max(TSL.dot(dir, uSunDir), 0), 24.0);
  // T2: wind shear. `windOffset` used to be one scalar for the whole slab, so every height
  // moved at the same rate and the deck slid across the sky as a rigid plate. The offset is
  // now a function of the sample's height inside the slab: full speed at the base, plus
  // `CLOUD_WIND.SHEAR` at the top. That is what makes the deck evolve instead of translate.
  // The relative difference between base and top is SHEAR/BASE (60% with these numbers).

  // Front-to-back accumulation as a pure expression tree (no mutable vars).
  // TSL's own typings model node arithmetic through 600+ per-type extension
  // interfaces, which makes a plain accumulator variable unexpressible. The two
  // accumulators are the only untyped locals; everything crossing this module's
  // public surface stays fully typed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let transmittance: any = TSL.float(1);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let acc: any = TSL.vec3(0, 0, 0);

  for (let i = 0; i < steps; i++) {
    const t = t0.add(dt.mul(i + 0.5));
    const p = TSL.cameraPosition.add(dir.mul(t));

    // Tower vertical profile — the JS mirror is `profileDensity` above. Full body from the
    // slab floor to the waist, then a topBias-powered falloff: this is what lets the deck
    // grow vertical structure instead of pinching into the old lens (dense only 139–200 m).
    const hFrac = p.y.sub(slab.bottom).div(slabHeight);
    const h = TSL.clamp(hFrac, 0, 1);
    // T2 wind shear: speed rises linearly with height inside the slab (see the CLOUD_WIND note
    // above the loop). Computed per sample, so the three noise octaves below all see it.
    const windOffset = uTime.mul(
      TSL.float(CLOUD_WIND.BASE).add(TSL.float(CLOUD_WIND.SHEAR).mul(h)),
    );
    const taper = TSL.smoothstep(slab.profile.waist, 1, h);
    const heightMask = TSL.float(slab.profile.base).mul(
      TSL.float(1).sub(TSL.pow(taper, slab.profile.topBias)),
    );

    // Worley base + erosion scales. The fractal alone gave soft blobs with no cells, so
    // the deck read as one even bank; Worley's cellular field is what puts discrete cumulus
    // puffs with real gaps between them. The coarse fractal carves the silhouette, the fine
    // one (different scale *and* different offset, so the two cannot correlate) breaks the
    // interior up — without it the flat toon bands below would read as one solid slab.
    const noisePos = TSL.vec3(
      p.x.mul(slab.noiseScale).add(windOffset),
      p.y.mul(slab.noiseScale * 2.6),
      p.z.mul(slab.noiseScale).sub(windOffset.mul(0.6)),
    );
    const erodeCoarse = TSL.mx_fractal_noise_float(noisePos.mul(1.7), 3, 2.0, 0.5, 1.0).mul(0.5).add(0.5);
    // Cells for the bank, plain fractal for the wisps. Worley on the wisp deck would give it
    // the same bubble structure as the bank above and read as a second solid layer; scraps
    // need to be torn and streaky, which is what the coarse fractal alone already is.
    const blobs = slab.cellular
      ? TSL.float(1).sub(TSL.mx_worley_noise_float(noisePos, 1.0, 0))
      : erodeCoarse;
    // The fine octave undersamples at the low step count and only injects aliasing there:
    // cut it (weights renormalise, see `cloudErosionWeights`) rather than blur the deck.
    const weights = cloudErosionWeights(steps);
    let shape: any = blobs.mul(weights.blobs).add(erodeCoarse.mul(weights.coarse));
    if (weights.fine > 0) {
      const erodeFine = TSL.mx_fractal_noise_float(
        noisePos.mul(4.3).add(TSL.vec3(11.3, 3.7, 7.1)),
        2,
        2.0,
        0.5,
        1.0,
      ).mul(0.5).add(0.5);
      shape = shape.add(erodeFine.mul(weights.fine));
    }
    shape = TSL.clamp(shape, 0, 1);
    // Threshold band, not a soft ramp: 0.5..0.68 leaves real gaps of purple sky between
    // puffs. Opening the low end to 0.4 covered the whole dome and the sky went flat pink.
    const density = TSL.smoothstep(slab.densityLow, slab.densityHigh, shape).mul(heightMask);
    const stepAlpha = density.mul(slab.stepAlpha);

    // Toon banding. The body luminance is `cloudLighting` — the shape/depth signal the JS
    // mirror above pins — quantised with narrow smoothstep windows (0.03 wide) so the step
    // is hard but not aliased. The rim keeps the old sun-side term: `sunTight * edge` is
    // what paints the gold fringe on the sunlit silhouette.
    const progress = TSL.float(i + 0.5).div(steps);
    const depth = TSL.clamp(TSL.float(1).sub(transmittance), 0, 1);
    const body = TSL.float(1).sub(TSL.smoothstep(CLOUD_LIGHTING.depthNear, CLOUD_LIGHTING.depthFar, depth));
    const lit = body
      .mul(TSL.float(1).sub(TSL.float(CLOUD_LIGHTING.progressDarken).mul(progress)))
      .add(TSL.float(CLOUD_LIGHTING.sunBias).mul(sunTight).mul(transmittance));
    const lightAmt = TSL.clamp(lit, 0, 1);
    // Toon ramp, spread across the range the lighting actually produces. The windows used to
    // sit at 0.30..0.33 and 0.62..0.66, which pinned 0.33..0.62 — a third of the range, and
    // the part the eye reads as "cloud body" — to the single `base` value; 24 -> 80 L* of
    // palette had no input that could reach it, so every mid-tone landed on one flat violet.
    // The base->pink step is a ramp now (0.34..0.60) rather than an edge, so the mid-tones
    // have somewhere to live; the 4-step posterise below still supplies the toon banding.
    const band1 = TSL.smoothstep(0.22, 0.30, lightAmt);
    const band2 = TSL.smoothstep(0.34, 0.60, lightAmt);
    const bodyCol = TSL.mix(shadowColor, baseColor, band1);
    const litCol = TSL.mix(bodyCol, pinkColor, band2);
    const edge = TSL.float(1).sub(TSL.smoothstep(0.35, 0.95, density));
    const rimAmt = TSL.smoothstep(0.30, 0.33, sunTight.mul(edge));
    const rim = TSL.mix(litCol, goldColor, rimAmt);
    // Dense cores sit in their own flat shade band; without it the volume flattens into a
    // silhouette, with a smooth falloff it gradients the very bands we just quantised.
    const core = TSL.float(1).sub(TSL.smoothstep(0.55, 0.60, density).mul(0.45));

    acc = acc.add(rim.mul(core).mul(transmittance).mul(stepAlpha));
    transmittance = transmittance.mul(TSL.float(1).sub(stepAlpha));
  }

  const alpha = TSL.float(1).sub(transmittance).mul(up);
  const accumulated = acc.div(TSL.max(alpha, TSL.float(0.0015)));

  // Posterise the accumulated luminance and rescale the colour to it, so hue and saturation
  // survive but the value reads in flat steps. Scaling by (stepped / lum) rather than
  // replacing the colour is what keeps the violet body and the pink highlight distinct
  // instead of collapsing everything to one grey per band.
  const lum = TSL.dot(accumulated, TSL.vec3(0.299, 0.587, 0.114));
  const steppedLum = TSL.floor(lum.mul(CLOUD_TOON_STEPS).add(0.5)).div(CLOUD_TOON_STEPS);
  const rgb = accumulated.mul(steppedLum.div(TSL.max(lum, TSL.float(0.001))));

  // Air perspective. The shell is a concentric sphere, so every fragment is the same 780 m
  // away and a distance ramp would wash the silhouette evenly — taking the lit crowns down
  // with the base and eating the ΔL* 15 those crowns are held to. Elevation is what separates
  // a distant base from a distant crown here, so the ramp is damped toward the zenith:
  // full haze at the waterline, none above ~27 deg. That also softens the volume's flat cut
  // at `CLOUD_BAND.bottom`, which reads as a knife edge against the sky today.
  const crown = TSL.smoothstep(CLOUD_HAZE.CROWN_LO, CLOUD_HAZE.CROWN_HI, dir.y);
  const hazeAmt = TSL.float(cloudHaze(CLOUD_DOME_RADIUS, CLOUD_HAZE.DOME_MAX)).mul(
    TSL.float(1).sub(crown),
  );
  const hazeColor = TSL.color(new THREE.Color(HAZE_COLOR));
  const shaded = TSL.mix(rgb, hazeColor, hazeAmt);

  const material = new MeshBasicNodeMaterial();
  material.colorNode = shaded;
  material.opacityNode = alpha;
  material.transparent = true;
  material.depthWrite = false;
  material.depthTest = true;
  material.side = THREE.BackSide;
  material.fog = false;

  return { material, uniforms: { uTime, uSunDir } as unknown as CloudUniforms };
}

interface CloudLayer {
  mesh: THREE.Mesh;
  geometry: THREE.SphereGeometry;
  spec: CloudSlabSpec;
  /** Mutable bundle so a quality rebuild can swap the material in place. */
  bundle: CloudMaterialBundle;
  /** Steps this layer is built at. The wisp deck stays fixed — it is already the cheap one. */
  fixedSteps: number | null;
}

export async function initClouds(scene: THREE.Scene, _backend: Backend): Promise<CloudHandle> {
  const geometry = new THREE.SphereGeometry(CLOUD_DOME_RADIUS, 48, 24);

  const buildLayer = async (
    name: string,
    spec: CloudSlabSpec,
    steps: number,
    renderOrder: number,
    fixedSteps: number | null,
  ): Promise<CloudLayer> => {
    const bundle = await createTslCloudMaterial(steps, spec);
    const mesh = new THREE.Mesh(geometry, bundle.material);
    mesh.name = name;
    mesh.position.y = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = renderOrder;
    scene.add(mesh);
    return { mesh, geometry, spec, bundle, fixedSteps };
  };

  let steps = CLOUD_STEPS_HIGH;
  const layers: CloudLayer[] = [await buildLayer('clouds-volumetric', MAIN_SLAB, steps, 2, null)];
  const main = layers[0];

  let disposed = false;
  let high = true;
  let rebuilding = false;

  return {
    kind: 'tsl',
    update(t: number, sunDir: THREE.Vector3): void {
      if (disposed) return;
      const time = Number.isFinite(t) ? t : 0;
      const hasSun =
        sunDir &&
        Number.isFinite(sunDir.x) &&
        Number.isFinite(sunDir.y) &&
        Number.isFinite(sunDir.z) &&
        sunDir.lengthSq() > 1e-6;
      for (const layer of layers) {
        layer.bundle.uniforms.uTime.value = time;
        if (hasSun) layer.bundle.uniforms.uSunDir.value.copy(sunDir).normalize();
      }
    },
    setQuality(next: boolean): void {
      if (disposed || next === high || rebuilding) return;
      high = next;
      const nextSteps = next ? CLOUD_STEPS_HIGH : CLOUD_STEPS_LOW;
      if (nextSteps === steps) return;
      rebuilding = true;
      steps = nextSteps;
      const previous = main.bundle;
      void createTslCloudMaterial(nextSteps, main.spec)
        .then((built) => {
          if (disposed) {
            built.material.dispose();
            return;
          }
          // Carry the live animation state across the rebuild.
          built.uniforms.uTime.value = previous.uniforms.uTime.value;
          built.uniforms.uSunDir.value.copy(previous.uniforms.uSunDir.value);
          previous.material.dispose();
          main.bundle = built;
          main.mesh.material = built.material;
        })
        .finally(() => {
          rebuilding = false;
        });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const layer of layers) {
        scene.remove(layer.mesh);
        layer.bundle.material.dispose();
      }
      geometry.dispose();
    },
  };
}

export const CLOUD_RENDER_INFO = {
  domeRadius: CLOUD_DOME_RADIUS,
  bottom: CLOUD_BAND.bottom,
  top: CLOUD_BAND.top,
  stepsHigh: CLOUD_STEPS_HIGH,
  stepsLow: CLOUD_STEPS_LOW,
};
