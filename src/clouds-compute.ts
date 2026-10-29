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
import { CLOUD_PALETTE, type CloudHandle } from './clouds-fallback';

export type Backend = 'webgpu' | 'webgl2';

/** Slightly inside the r=800 sky dome so the two shells cannot z-fight. */
const CLOUD_DOME_RADIUS = 780;
const CLOUD_BOTTOM = 95;
const CLOUD_TOP = 265;

export const CLOUD_STEPS_HIGH = 12;
export const CLOUD_STEPS_LOW = 8;

/**
 * 1/m. Base noise feature size ~150 m, which fits several cumulus banks inside the 780 m
 * dome. The old 0.0021 spanned roughly one noise cell across the whole sky, so the volume
 * could only ever render as a uniform haze.
 */
const CLOUD_NOISE_SCALE = 0.0065;
/** Optical depth per step at full density. 12 steps x 0.34 -> near-opaque cores. */
const CLOUD_STEP_ALPHA = 0.34;


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
  const t0 = TSL.max(tNear, TSL.float(1));
  const t1 = TSL.min(tFar, TSL.float(900));
  const span = TSL.max(t1.sub(t0), TSL.float(0));
  const dt = span.div(steps);

  // Rays pointing down never enter the slab; mask them out instead of selecting.
  const up = TSL.step(TSL.float(0), dir.y);

  const slabHeight = CLOUD_TOP - CLOUD_BOTTOM;
  // Node materials shade in linear-sRGB, so the palette has to go through THREE.Color:
  // feeding the raw hex number to color() renders a washed-out pastel (the same bug the
  // sky had).
  const shadowColor = TSL.color(new THREE.Color(CLOUD_PALETTE.shadow));
  const baseColor = TSL.color(new THREE.Color(CLOUD_PALETTE.base));
  const pinkColor = TSL.color(new THREE.Color(CLOUD_PALETTE.pink));
  const goldColor = TSL.color(new THREE.Color(CLOUD_PALETTE.gold));

  const sunAlign = TSL.pow(TSL.max(TSL.dot(dir, uSunDir), 0), 3.0);
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
      p.y.mul(CLOUD_NOISE_SCALE * 1.7),
      p.z.mul(CLOUD_NOISE_SCALE).sub(windOffset.mul(0.6)),
    );
    const fbm = TSL.mx_fractal_noise_float(noisePos, 4, 2.0, 0.5, 1.0).mul(0.5).add(0.5);
    const density = TSL.smoothstep(0.4, 0.62, fbm).mul(heightMask);
    const stepAlpha = density.mul(CLOUD_STEP_ALPHA);

    // Purple body, pink where the view ray runs into the sun, gold rim on the thin edges —
    // that edge glow is what sells a backlit sunset cloud.
    const body = TSL.mix(shadowColor, baseColor, TSL.smoothstep(0.08, 0.82, hFrac));
    const lit = TSL.mix(body, pinkColor, TSL.clamp(sunAlign.mul(1.15), 0, 0.9));
    const rim = goldColor.mul(sunAlign.mul(sunAlign).mul(0.85)).mul(TSL.smoothstep(0.02, 0.45, density));
    // Dense cores sit in their own shade; without this the volume flattens into a silhouette.
    const core = TSL.float(1).sub(TSL.smoothstep(0.55, 1.0, density).mul(0.45));

    acc = acc.add(lit.add(rim).mul(core).mul(transmittance).mul(stepAlpha));
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
