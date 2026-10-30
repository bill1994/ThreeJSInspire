/**
 * WebGPU clouds — a slab raymarch written in TSL node graphs (custom GLSL does
 * not run under WebGPURenderer).
 *
 * The dome is just a backface shell at radius CLOUD_DOME_RADIUS; the volume comes
 * from marching the view ray through a horizontal slab between CLOUD_BOTTOM and
 * CLOUD_TOP. Steps are unrolled at build time, so the shader has constant loop
 * bounds and no dynamism the driver has to reason about. The low quality tier
 * rebuilds the same graph with fewer steps.
 */
import * as THREE from 'three';

import { CLOUD_PALETTE, SUN_DIRECTION } from './palettes';

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
export const CLOUD_BOTTOM = 95;
export const CLOUD_TOP = 265;

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
  bottom: number = CLOUD_BOTTOM,
  top: number = CLOUD_TOP,
): { tStart: number; tEnd: number } {
  if (!Number.isFinite(camY) || !Number.isFinite(dirY) || !Number.isFinite(tMax)) {
    return { tStart: 0, tEnd: 0 };
  }
  const max = Math.max(tMax, 0);
  if (Math.abs(dirY) < 1e-6) {
    // Parallel ray: inside the slab it never exits, outside it never enters.
    return camY >= bottom && camY <= top ? { tStart: 0, tEnd: max } : { tStart: 0, tEnd: 0 };
  }
  const tBottom = (bottom - camY) / dirY;
  const tTop = (top - camY) / dirY;
  const tNear = Math.min(tBottom, tTop);
  const tFar = Math.max(tBottom, tTop);
  return { tStart: Math.max(0, tNear), tEnd: Math.min(max, tFar) };
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
 * The wispy second deck: cotton scraps at cruise altitude, under the main bank.
 *
 * It is a real volume with its own slab (not a billboard layer) so it parallaxes correctly
 * when the aircraft crosses it, but it is deliberately thin: 5 steps and a low optical
 * depth mean it reads as torn shreds of cloud rather than a second solid bank. The player
 * cruises at 60 m, so this band is the one they actually fly *through*.
 */
export const CLOUD_WISP_BOTTOM = 30;
export const CLOUD_WISP_TOP = 82;
export const CLOUD_WISP_STEPS = 5;
/** Optical depth per wisp step. Low, or the scraps close up into a veil over the whole frame. */
const CLOUD_WISP_STEP_ALPHA = 0.14;
/** How much of the whiteout a wisp-only crossing may cause. A scrap is not a cumulus bank. */
export const WISP_DENSITY = 0.35;

/**
 * One horizontal slab the volume marches through.
 *
 * Parameterised so the main bank and the wisp deck share every line of shading — same
 * palette, same quantised bands, same sun terms — and differ only in geometry, noise scale
 * and opacity. A second hand-written shader would drift out of style within a batch.
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
}

const MAIN_SLAB: CloudSlabSpec = {
  bottom: CLOUD_BOTTOM,
  top: CLOUD_TOP,
  noiseScale: CLOUD_NOISE_SCALE,
  stepAlpha: CLOUD_STEP_ALPHA,
  densityLow: 0.5,
  densityHigh: 0.68,
  cellular: true,
};

const WISP_SLAB: CloudSlabSpec = {
  bottom: CLOUD_WISP_BOTTOM,
  top: CLOUD_WISP_TOP,
  // ~2.8x the main cell frequency: scraps must be an order smaller than the banks above them.
  noiseScale: CLOUD_NOISE_SCALE * 2.8,
  stepAlpha: CLOUD_WISP_STEP_ALPHA,
  // A higher threshold keeps the wisp band sparse; only the densest noise cores survive.
  densityLow: 0.56,
  densityHigh: 0.72,
  cellular: false,
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

  // Guard the slab intersection: a near-horizontal ray would divide by ~0.
  const dyAbs = TSL.max(TSL.abs(dir.y), TSL.float(0.002));
  const tBottom = TSL.float(slab.bottom).sub(camY).div(dyAbs);
  const tTop = TSL.float(slab.top).sub(camY).div(dyAbs);
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
  // transparent hole through the volume the player just flew into (the flight ceiling now
  // reaches 240 m, inside 95..265). Inside the slab, every direction sees cloud.
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

  // Two sun terms, both needed. A broad one (cos^6, ~35 deg) biases the whole cloud deck warm;
  // a tight one (cos^24, ~20 deg) is what actually lights the sun side pink. Using only the
  // broad term turned every ray in the upper half of the frame into pale pink cream, because
  // at 30 deg elevation a ray is still within 23 deg of a sun sitting 7 deg above the horizon.
  const sunWide = TSL.pow(TSL.max(TSL.dot(dir, uSunDir), 0), 6.0);
  const sunTight = TSL.pow(TSL.max(TSL.dot(dir, uSunDir), 0), 24.0);
  const windOffset = uTime.mul(0.01);

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

    // Lens-shaped vertical profile: nothing at the slab floor or ceiling, thickest in the
    // middle. This is what makes the puffs read as cumulus banks instead of fog.
    const hFrac = p.y.sub(slab.bottom).div(slabHeight);
    const heightMask = TSL.smoothstep(0.02, 0.26, hFrac).mul(
      TSL.float(1).sub(TSL.smoothstep(0.62, 1.0, hFrac)),
    );

    // Worley base + two erosion scales. The fractal alone gave soft blobs with no cells, so
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
    const erodeFine = TSL.mx_fractal_noise_float(
      noisePos.mul(4.3).add(TSL.vec3(11.3, 3.7, 7.1)),
      2,
      2.0,
      0.5,
      1.0,
    ).mul(0.5).add(0.5);
    const shape = TSL.clamp(
      blobs.mul(0.55).add(erodeCoarse.mul(0.30)).add(erodeFine.mul(0.15)),
      0,
      1,
    );
    // Threshold band, not a soft ramp: 0.5..0.68 leaves real gaps of purple sky between
    // puffs. Opening the low end to 0.4 covered the whole dome and the sky went flat pink.
    const density = TSL.smoothstep(slab.densityLow, slab.densityHigh, shape).mul(heightMask);
    const stepAlpha = density.mul(slab.stepAlpha);

    // Toon banding — the reason this file changed. Three nested `mix` calls used to shade the
    // body, which is a continuous gradient; the reference clouds are colour blocks (flat
    // violet body, pink sun-side, gold rim). The bands are now quantised with narrow
    // smoothstep windows (0.03 wide) so the step is hard but not aliased. `toon.ts`'s old
    // "clouds do not quantise" note only ever applied to the sea.
    const lightAmt = TSL.clamp(sunTight.mul(0.80).add(sunWide.mul(0.20)), 0, 1);
    const band1 = TSL.smoothstep(0.22, 0.25, lightAmt);
    const band2 = TSL.smoothstep(0.58, 0.61, lightAmt);
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

  const material = new MeshBasicNodeMaterial();
  material.colorNode = rgb;
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
  // The wisp deck draws first: it is nearer the camera than most of the bank, and at its low
  // optical depth it must not be occluded by the bank's outer shell.
  const layers: CloudLayer[] = [
    await buildLayer('clouds-wisp', WISP_SLAB, CLOUD_WISP_STEPS, 1, CLOUD_WISP_STEPS),
    await buildLayer('clouds-volumetric', MAIN_SLAB, steps, 2, null),
  ];
  const main = layers[1];

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
  bottom: CLOUD_BOTTOM,
  top: CLOUD_TOP,
  wispBottom: CLOUD_WISP_BOTTOM,
  wispTop: CLOUD_WISP_TOP,
  wispSteps: CLOUD_WISP_STEPS,
  stepsHigh: CLOUD_STEPS_HIGH,
  stepsLow: CLOUD_STEPS_LOW,
};
