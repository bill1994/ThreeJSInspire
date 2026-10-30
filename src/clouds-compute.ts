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

import { CLOUD_PALETTE } from './palettes';

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
export function slabRayT(camY: number, dirY: number, tMax: number): { tStart: number; tEnd: number } {
  if (!Number.isFinite(camY) || !Number.isFinite(dirY) || !Number.isFinite(tMax)) {
    return { tStart: 0, tEnd: 0 };
  }
  const max = Math.max(tMax, 0);
  if (Math.abs(dirY) < 1e-6) {
    // Parallel ray: inside the slab it never exits, outside it never enters.
    return camY >= CLOUD_BOTTOM && camY <= CLOUD_TOP ? { tStart: 0, tEnd: max } : { tStart: 0, tEnd: 0 };
  }
  const tBottom = (CLOUD_BOTTOM - camY) / dirY;
  const tTop = (CLOUD_TOP - camY) / dirY;
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


interface CloudUniforms {
  uTime: { value: number };
  uSunDir: { value: THREE.Vector3 };
}

interface CloudMaterialBundle {
  material: any;
  uniforms: CloudUniforms;
}

const DEFAULT_SUN = new THREE.Vector3(0.28, 0.14, -1).normalize();

async function createTslCloudMaterial(steps: number): Promise<CloudMaterialBundle> {
  const TSL = await import('three/tsl');
  const { MeshBasicNodeMaterial } = await import('three/webgpu');

  const uTime = TSL.uniform(0);
  const uSunDir = TSL.uniform(DEFAULT_SUN.clone());

  const dir = TSL.normalize(TSL.positionWorld.sub(TSL.cameraPosition));
  const camY = TSL.cameraPosition.y;

  // Guard the slab intersection: a near-horizontal ray would divide by ~0.
  const dyAbs = TSL.max(TSL.abs(dir.y), TSL.float(0.002));
  const tBottom = TSL.float(CLOUD_BOTTOM).sub(camY).div(dyAbs);
  const tTop = TSL.float(CLOUD_TOP).sub(camY).div(dyAbs);
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
  const insideSlab = TSL.step(TSL.float(CLOUD_BOTTOM), camY);
  const up = TSL.max(insideSlab, TSL.step(TSL.float(0), dir.y));

  const slabHeight = CLOUD_TOP - CLOUD_BOTTOM;
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
    const hFrac = p.y.sub(CLOUD_BOTTOM).div(slabHeight);
    const heightMask = TSL.smoothstep(0.02, 0.26, hFrac).mul(
      TSL.float(1).sub(TSL.smoothstep(0.62, 1.0, hFrac)),
    );

    // CLOUD_NOISE_SCALE is 1/metres: 0.0065 puts the base feature at ~150 m across, so the
    // 780 m dome holds several banks. (0.0021 held about one noise cell over the whole sky,
    // which is why the volume rendered as a barely-there haze.) The fractal's own octaves
    // add the 75/38/19 m detail on top — no second noise call needed.
    const noisePos = TSL.vec3(
      p.x.mul(CLOUD_NOISE_SCALE).add(windOffset),
      p.y.mul(CLOUD_NOISE_SCALE * 2.6),
      p.z.mul(CLOUD_NOISE_SCALE).sub(windOffset.mul(0.6)),
    );
    const fbm = TSL.mx_fractal_noise_float(noisePos, 4, 2.0, 0.5, 1.0).mul(0.5).add(0.5);
    // Threshold band, not a soft ramp: 0.5..0.68 leaves real gaps of purple sky between
    // puffs. Opening the low end to 0.4 covered the whole dome and the sky went flat pink.
    const density = TSL.smoothstep(0.5, 0.68, fbm).mul(heightMask);
    const stepAlpha = density.mul(CLOUD_STEP_ALPHA);

    // Purple body, pink only in a tight cone around the sun, gold on the thin edges of a puff
    // — that edge glow is what sells a backlit sunset cloud. Both tints are *mixed* into the
    // body rather than added on top of it: adding drove the accumulated colour past 1.0 and
    // the whole upper sky clipped to cream.
    const hLight = TSL.smoothstep(0.15, 0.85, hFrac);
    const body = TSL.mix(shadowColor, baseColor, hLight);
    const lit = TSL.mix(
      body,
      pinkColor,
      TSL.clamp(sunTight.mul(0.75).add(sunWide.mul(0.12)), 0, 0.7),
    );
    const edge = TSL.float(1).sub(TSL.smoothstep(0.35, 0.95, density));
    const rim = TSL.mix(lit, goldColor, TSL.clamp(sunTight.mul(edge).mul(0.85), 0, 0.8));
    // Dense cores sit in their own shade; without this the volume flattens into a silhouette.
    const core = TSL.float(1).sub(TSL.smoothstep(0.5, 1.0, density).mul(0.5));

    acc = acc.add(rim.mul(core).mul(transmittance).mul(stepAlpha));
    transmittance = transmittance.mul(TSL.float(1).sub(stepAlpha));
  }

  const alpha = TSL.float(1).sub(transmittance).mul(up);
  const rgb = acc.div(TSL.max(alpha, TSL.float(0.0015)));

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

export async function initClouds(scene: THREE.Scene, _backend: Backend): Promise<CloudHandle> {
  let steps = CLOUD_STEPS_HIGH;
  let { material, uniforms } = await createTslCloudMaterial(steps);

  const geometry = new THREE.SphereGeometry(CLOUD_DOME_RADIUS, 48, 24);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'clouds-volumetric';
  mesh.position.y = 0;
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  scene.add(mesh);

  let disposed = false;
  let high = true;
  let rebuilding = false;

  return {
    kind: 'tsl',
    update(t: number, sunDir: THREE.Vector3): void {
      if (disposed) return;
      uniforms.uTime.value = Number.isFinite(t) ? t : 0;
      if (
        sunDir &&
        Number.isFinite(sunDir.x) &&
        Number.isFinite(sunDir.y) &&
        Number.isFinite(sunDir.z) &&
        sunDir.lengthSq() > 1e-6
      ) {
        uniforms.uSunDir.value.copy(sunDir).normalize();
      }
    },
    setQuality(next: boolean): void {
      if (disposed || next === high || rebuilding) return;
      high = next;
      const nextSteps = next ? CLOUD_STEPS_HIGH : CLOUD_STEPS_LOW;
      if (nextSteps === steps) return;
      rebuilding = true;
      steps = nextSteps;
      void createTslCloudMaterial(nextSteps)
        .then((built) => {
          if (disposed) {
            built.material.dispose();
            return;
          }
          // Carry the live animation state across the rebuild.
          built.uniforms.uTime.value = uniforms.uTime.value;
          built.uniforms.uSunDir.value.copy(uniforms.uSunDir.value);
          material.dispose();
          material = built.material;
          uniforms = built.uniforms;
          mesh.material = built.material;
        })
        .finally(() => {
          rebuilding = false;
        });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      scene.remove(mesh);
      geometry.dispose();
      material.dispose();
    },
  };
}

export const CLOUD_RENDER_INFO = {
  domeRadius: CLOUD_DOME_RADIUS,
  bottom: CLOUD_BOTTOM,
  top: CLOUD_TOP,
  stepsHigh: CLOUD_STEPS_HIGH,
  stepsLow: CLOUD_STEPS_LOW,
};
