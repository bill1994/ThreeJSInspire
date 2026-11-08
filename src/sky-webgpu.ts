/**
 * src/sky-webgpu.ts — the sunset sky, on both backends.
 *
 * Both backends now run WebGPURenderer (WebGL2 through `forceWebGL`), so the classic
 * GLSL `sky-sunset.ts` dome this module was originally written to *replace* is gone on
 * reconstruct and this is the only sky implementation left. It ships two pieces:
 *
 *   1. `sunsetGradientTexture()` — a tiny canvas gradient used as `scene.background`.
 *      Works on every backend and guarantees the horizon is warm even if the dome fails.
 *   2. `initSunsetSkyTSL()` — the TSL (node material) backside dome, loaded through a
 *      dynamic import so a TSL API change degrades to the gradient instead of breaking
 *      the boot.
 *
 * The ramp itself is not authored here: both renderers walk `palettes.SKY_STOPS`, which is
 * also where the sun direction comes from.
 *
 * 2026-11-08 linkage fix: the dome is a FINITE sphere that `far-field.ts` tows to
 * the camera every frame. Shading it with `positionWorld.normalize()` therefore
 * measured the direction from the WORLD ORIGIN to the shell fragment, not from
 * the camera — the sun disc and the whole ramp slid across the sky as the
 * aircraft flew, while the sea (which uses a pure world-space sun direction)
 * kept its reflection in one place. The dome now shades with the real view ray
 * `normalize(positionWorld - cameraPosition)`, the exact same basis the sea's
 * `viewDir` uses in `sea/material.ts`, so sky and reflection cannot disagree.
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
  /**
   * Explicitly sync the dome's glow/disc to a sun direction. The uniform also
   * shares the `SunState.direction` object by reference, so this is a defensive
   * second path — the caller uses it when `SunState.version` changes to make the
   * linkage visible and testable rather than relying on an implicit alias.
   */
  setSunDirection(dir: import('three').Vector3): void;
}

/** The sun tint the dome and the sea's reflection must agree on. */
const SUN_TINT = [1.0, 0.78, 0.52] as const;

/**
 * The sky's colour as ONE TSL expression of a direction and the live sun uniform.
 * The dome evaluates it at `positionWorld`; the sea's material evaluates it at the
 * reflected view ray — "the sea reflects the sky" has to be literally this function,
 * or the reflection and the sky drift apart. Kept beside the dome so a ramp change
 * updates both in one commit.
 *
 * `includeDisc` (default true) drops the sun DISC from the returned radiance. The
 * sea passes false: its specular road (`sun-road.ts`) already paints the sun's
 * mirror image from the same normals, so a disc inside the reflection painted the
 * sun twice — and after the road's knee capped the road at `ROAD_CEILING`, the
 * disc term (~DISK_GAIN × Fresnel) would resurface as a second, sharper sun. The
 * GLOW stays in both: atmospheric halo is genuine sky radiance a real mirror
 * reflects.
 */
export function skyColorTsl(tsl: any, dirNode: any, sunDirNode: any, includeDisc: boolean = true): any {
  const { float, mix, smoothstep, vec2, vec3 } = tsl;
  const t = smoothstep(-0.02, 0.55, dirNode.y);
  const stops = SKY_STOPS.map((stop) => ({ at: stop.at, color: vec3(...linearFromCss(stop.color)) }));
  let base: any = stops[0].color;
  for (let i = 1; i < stops.length; i += 1) {
    base = mix(base, stops[i].color, smoothstep(stops[i - 1].at, stops[i].at, t));
  }
  // Azimuth, not just height. The stop ramp is one colour per elevation in EVERY
  // direction, so the horizon stayed #ff9a5a behind the camera as well: the sea's
  // reflection came out a flat gold sheet and its Fresnel falloff read as a drawn
  // line. Cool the low sky toward HORIZON.AWAY_COLOR as the view turns away from
  // the sun. Component access, not `.xz`: swizzling the sun's uniform node is not
  // reliable, and a wrong basis here paints the tint uniformly in all directions.
  // Length is clamped because the horizontal part is zero at the zenith.
  const dirXZ = vec2(dirNode.x, dirNode.z);
  const sunXZ = vec2(sunDirNode.x, sunDirNode.z);
  const cosAz = dirXZ.div(dirXZ.length().max(1e-4)).dot(sunXZ.div(sunXZ.length().max(1e-4)));
  const away = float(1.0).sub(cosAz).mul(0.5);
  const lowSky = float(1.0).sub(smoothstep(0.0, HORIZON.AWAY_HEIGHT, dirNode.y));
  const cool = away.pow(1.2).mul(lowSky).mul(HORIZON.AWAY_GAIN);
  base = mix(base, vec3(...linearFromCss(HORIZON.AWAY_COLOR)), cool);
  const cos = dirNode.dot(sunDirNode).max(0.0);
  const haze = cos.pow(HORIZON.GLOW_POW).mul(HORIZON.GLOW_GAIN);
  let sunLight: any = haze;
  if (includeDisc) {
    const cosHalf = Math.cos((HORIZON.DISK_HALF_ANGLE_DEG * Math.PI) / 180);
    sunLight = haze.add(smoothstep(cosHalf, 1.0, cos).mul(HORIZON.DISK_GAIN));
  }
  return base.add(vec3(...SUN_TINT).mul(sunLight));
}

/**
 * TSL replacement for the GLSL dome. Returns `null` when the node-material path is not
 * available (older three, missing export, no DOM), so the caller keeps the gradient.
 */
export async function initSunsetSkyTSL(
  THREE: typeof import('three'),
  scene: import('three').Scene,
  /**
   * The shared live sun vector (`SunState.direction`). `uniform()` keeps this
   * object BY REFERENCE, so rotating the sun moves the dome and every sea ring
   * at the same instant — no copy, no per-frame sync, no drift.
   */
  sunDirection?: import('three').Vector3,
  radius = 800,
): Promise<SkyTslHandle | null> {
  try {
    const webgpu = (await import('three/webgpu')) as any;
    const tsl = (await import('three/tsl')) as any;
    const MeshBasicNodeMaterial = webgpu.MeshBasicNodeMaterial;
    if (!MeshBasicNodeMaterial || !tsl.mix || !tsl.smoothstep) return null;

    const { positionWorld, cameraPosition, uniform } = tsl;

    // VIEW RAY, not world position. The shell is towed with the camera every
    // frame (`far-field.ts`), so `positionWorld.normalize()` is a direction from
    // the world origin — it drifts by camX/R and camZ/R (R = 800 m) and drags the
    // sun disc + ramp across the sky while the sea's reflection stays put.
    // `positionWorld - cameraPosition` is the same basis as the sea's `viewDir`
    // (`sea/material.ts`), which is what "the sea reflects the sky" requires.
    const dir = positionWorld.sub(cameraPosition).normalize();
    // A uniform, not a `vec3(...)` literal: the literal is baked at shader compile
    // time and the sun could never move. `palettes.SUN_DIRECTION` seeds the default.
    const sunDir = uniform(sunDirection ?? new THREE.Vector3(...SUN_DIRECTION));

    const material = new MeshBasicNodeMaterial();
    material.colorNode = skyColorTsl(tsl, dir, sunDir);
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
      setSunDirection(dir: import('three').Vector3): void {
        // Normalise defensively: a non-unit sun scales every dot() in
        // `skyColorTsl` and would silently resize the disc and the glow.
        sunDir.value.copy(dir).normalize();
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
