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
 * The ramp itself is not authored here: both renderers walk `palettes.SKY_STOPS`, which is
 * also where the sun direction comes from.
 */

import * as THREE from 'three';

import { HORIZON } from './horizon';
import { SKY_BELOW_HORIZON, SKY_STOPS, SUN_DIRECTION } from './palettes';

/** Vertical sunset gradient as a canvas texture, safe as `scene.background` on any backend. */
export function sunsetGradientTexture(THREE: typeof import('three')): InstanceType<typeof THREE.CanvasTexture> | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
  // Row positions come from each stop's own `canvasY`; the dome reads `at` instead. See the
  // SKY_STOPS docblock: these are screen rows and elevations, not the same coordinate.
  for (let i = SKY_STOPS.length - 1; i >= 0; i -= 1) {
    g.addColorStop(SKY_STOPS[i].canvasY, SKY_STOPS[i].color);
  }
  g.addColorStop(1.0, SKY_BELOW_HORIZON);
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

    const sunTint = vec3(1.0, 0.78, 0.52);

    // sunset ramp: 0 at the waterline, 1 at the zenith
    const h = positionWorld.y.div(radius);
    const t = smoothstep(-0.02, 0.55, h);
    // Walk the authored ramp stop by stop. Two stops (the old `mix(horizon, top, t)`) put the
    // entire mid-band on the straight line between #ff9a5a and #6b4fa1, which lands on a
    // muddy grey-red — the reference's magenta band is a colour in its own right, not a
    // waypoint between two others.
    const stops = SKY_STOPS.map((stop) => ({ at: stop.at, color: vec3(...linearFromCss(stop.color)) }));
    let base: any = stops[0].color;
    for (let i = 1; i < stops.length; i += 1) {
      base = mix(base, stops[i].color, smoothstep(stops[i - 1].at, stops[i].at, t));
    }

    // per-fragment sun glow: broad haze + an angle-threshold disc, both read from
    // `horizon.ts` so the sky and the sea's horizon band cannot drift apart.
    const dir = positionWorld.normalize();
    const sunDir = vec3(...SUN_DIRECTION); // palettes.ts is the single source
    const cos = dir.dot(sunDir).max(0.0);
    const haze = cos.pow(HORIZON.GLOW_POW).mul(HORIZON.GLOW_GAIN);
    // The disc used to be `pow(cos, 220)` — a 9.09 deg blob, 17x a real sun. Reaching
    // 0.53 deg by exponent needs `pow ~= 64000`, which underflows in the HalfFloat
    // target, so it is an angle threshold now. `HORIZON.DISK_GAIN` is 0 (decision D4:
    // ref-01 has no hard disc); `sunDisc` in horizon.ts is the tested JS mirror.
    const cosHalf = Math.cos((HORIZON.DISK_HALF_ANGLE_DEG * Math.PI) / 180);
    const disc = smoothstep(cosHalf, 1.0, cos).mul(HORIZON.DISK_GAIN);
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
