/**
 * src/sky-webgpu.ts — sunset sky for backends that cannot run the GLSL dome.
 *
 * `sky-sunset.ts` is a classic GLSL ShaderMaterial, which WebGPURenderer does not
 * render. This module supplies the two replacements:
 *
 *   1. `sunsetGradientTexture()` — a tiny canvas gradient used as `scene.background`.
 *      Works on every backend and guarantees the horizon is warm even if the dome fails.
 *   2. `initSunsetSkyTSL()` — a TSL (node material) backside dome that matches the GLSL
 *      dome's palette and sun glow, loaded through a dynamic import so a TSL API change
 *      degrades to the gradient instead of breaking the boot.
 *
 * Colours are kept in sync with `sky-sunset.ts` (top #6b4fa1, horizon #ff9a5a, sun
 * direction (60, 35, -280)).
 */

import * as THREE from 'three';

export const SKY_TOP = '#6b4fa1';
export const SKY_HORIZON = '#ff9a5a';
export const SKY_SUN = '#ffd9a0';

/** Vertical sunset gradient as a canvas texture, safe as `scene.background` on any backend. */
export function sunsetGradientTexture(THREE: typeof import('three')): InstanceType<typeof THREE.CanvasTexture> | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
  g.addColorStop(0.0, '#4a2f74');
  g.addColorStop(0.34, SKY_TOP);
  g.addColorStop(0.62, '#c96a8f');
  g.addColorStop(0.78, SKY_HORIZON);
  g.addColorStop(1.0, '#8c4a5e');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

export interface SkyTslHandle {
  dispose(): void;
}

/**
 * TSL replacement for the GLSL dome. Returns `null` when the node-material path is not
 * available (older three, missing export, no DOM), so the caller keeps the gradient.
 */
export async function initSunsetSkyTSL(
  THREE: typeof import('three'),
  scene: import('three').Scene,
  radius = 800,
): Promise<SkyTslHandle | null> {
  try {
    const webgpu = (await import('three/webgpu')) as any;
    const tsl = (await import('three/tsl')) as any;
    const MeshBasicNodeMaterial = webgpu.MeshBasicNodeMaterial;
    if (!MeshBasicNodeMaterial || !tsl.mix || !tsl.smoothstep) return null;

    const { mix, smoothstep, vec3, positionWorld } = tsl;

    const top = vec3(...skyTopLinear());
    const horizon = vec3(...skyHorizonLinear());
    const sunTint = vec3(1.0, 0.78, 0.52);

    // height on the dome: 0 at the waterline, 1 at the zenith
    const h = positionWorld.y.div(radius);
    const t = smoothstep(-0.02, 0.55, h);
    const base = mix(horizon, top, t);

    // per-fragment sun glow: broad haze + tight disc, from the same direction as the GLSL dome
    const dir = positionWorld.normalize();
    const sunDir = vec3(0.2074, 0.1210, -0.9707); // normalize(60, 35, -280)
    const cos = dir.dot(sunDir).max(0.0);
    const haze = cos.pow(9.0).mul(0.42);
    // Matches the GLSL dome's disc exponent (sky-sunset.ts uses pow(cos, 220)) so the sun is
    // the same apparent size on both backends. The haze term must stay at 9/0.42 — the sea
    // shader blends its horizon band against exactly that term.
    const disc = cos.pow(220.0).mul(2.4);
    const glow = haze.add(disc);

    const material = new MeshBasicNodeMaterial();
    material.colorNode = base.add(sunTint.mul(glow));
    material.depthWrite = false;
    material.fog = false;
    material.side = THREE.BackSide;

    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 20), material as unknown as import('three').Material);
    mesh.name = 'sky_sunset_tsl';
    mesh.renderOrder = -1000;
    mesh.frustumCulled = false;
    scene.add(mesh);

    return {
      dispose(): void {
        scene.remove(mesh);
        mesh.geometry.dispose();
        (material as unknown as { dispose?: () => void }).dispose?.();
      },
    };
  } catch (err) {
    console.warn('[sky] TSL dome unavailable, using gradient background', err);
    return null;
  }
}

/**
 * CRITICAL: node materials shade in the renderer's working space (linear-sRGB), so the palette
 * has to be converted here. Hand-writing the sRGB floats and feeding them straight into
 * `vec3()` renders a washed-out pastel sky — the value gets treated as linear and then
 * gamma-encoded a second time on output.
 */
function linearFromCss(css: string): [number, number, number] {
  const c = new THREE.Color(css);
  return [c.r, c.g, c.b];
}

function skyTopLinear(): [number, number, number] {
  return linearFromCss(SKY_TOP);
}

function skyHorizonLinear(): [number, number, number] {
  return linearFromCss(SKY_HORIZON);
}
