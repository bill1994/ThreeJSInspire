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
import { REFERENCE_ELEVATION_DEG, skyTrackAt, type SkyTrackState, type Vec3 } from './sky-track';
import { preethamRadianceTsl } from './sky-preetham';

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

/** The sun tint lives in `palettes.SUN_TINT_LINEAR` (single source) and reaches this
 * graph ONLY through the track uniform seeded from the reference keyframe — no
 * second copy here. */

// ---- the track uniform singleton -------------------------------------------------------
//
// ONE uniform group shared by the dome and every sea ring: two `skyColorTsl` graphs
// reading different uniforms would drift apart the first frame the track moved.
// Created lazily on the first `skyColorTsl` call (the `tsl` namespace is caller-passed,
// module-graph.test.ts forbids static three/tsl imports here); seeded from the
// reference keyframe so the default state is today's sky.

interface TrackUniforms {
  dayStops: any[];
  nightStops: any[];
  awayColor: any;
  awayGain: any;
  awayHeight: any;
  glowPow: any;
  glowGain: any;
  sunTint: any;
  discGain: any;
  floor: any;
  nightWeight: any;
  turbidity: any;
  rayleigh: any;
  mieCoefficient: any;
  mieDirectionalG: any;
  refSun: any;
  refTurbidity: any;
  refRayleigh: any;
  refMieCoefficient: any;
  refMieDirectionalG: any;
}

let trackState: SkyTrackState = skyTrackAt(REFERENCE_ELEVATION_DEG);
let trackU: TrackUniforms | null = null;

// Pre-compute the reference keyframe ONCE at module load — it never changes.
// Minor 6 fix: applySkyTrack was recomputing skyTrackAt(REFERENCE_ELEVATION_DEG)
// and rewriting u.ref* every frame. buildTrackUniforms already used the same
// value; hoisting to module scope keeps both paths consistent and saves one
// skyTrackAt() call per frame.
const REF_STATE: SkyTrackState = skyTrackAt(REFERENCE_ELEVATION_DEG);

function vec3Uniform(tsl: any, v: readonly number[]): any {
  return tsl.uniform(new THREE.Vector3(v[0], v[1], v[2]));
}

function buildTrackUniforms(tsl: any, s: SkyTrackState): TrackUniforms {
  // REF_STATE is a module-level const (computed once at import, see above) —
  // the reference keyframe is a deterministic pure-interpolation result.
  return {
    dayStops: s.dayStops.map((v) => vec3Uniform(tsl, v)),
    nightStops: s.nightStops.map((v) => vec3Uniform(tsl, v)),
    awayColor: vec3Uniform(tsl, s.awayColor),
    awayGain: tsl.uniform(s.awayGain),
    awayHeight: tsl.uniform(s.awayHeight),
    glowPow: tsl.uniform(s.glowPow),
    glowGain: tsl.uniform(s.glowGain),
    sunTint: vec3Uniform(tsl, s.sunTint),
    discGain: tsl.uniform(s.discGain),
    floor: vec3Uniform(tsl, s.floorLinear),
    nightWeight: tsl.uniform(s.nightWeight),
    turbidity: tsl.uniform(s.preetham.turbidity),
    rayleigh: tsl.uniform(s.preetham.rayleigh),
    mieCoefficient: tsl.uniform(s.preetham.mieCoefficient),
    mieDirectionalG: tsl.uniform(s.preetham.mieDirectionalG),
    refSun: vec3Uniform(tsl, SUN_DIRECTION),
    refTurbidity: tsl.uniform(REF_STATE.preetham.turbidity),
    refRayleigh: tsl.uniform(REF_STATE.preetham.rayleigh),
    refMieCoefficient: tsl.uniform(REF_STATE.preetham.mieCoefficient),
    refMieDirectionalG: tsl.uniform(REF_STATE.preetham.mieDirectionalG),
  };
}

/**
 * Write a track state into the singleton uniforms. Safe to call before the first
 * `skyColorTsl` (the state is stored and seeds the group when the graphs are built)
 * and cheap enough to call every frame — the dome and the sea read the SAME group,
 * so one write moves both.
 */
export function applySkyTrack(state: SkyTrackState): void {
  trackState = state;
  const u = trackU;
  if (!u) return;
  state.dayStops.forEach((v, i) => u.dayStops[i].value.set(v[0], v[1], v[2]));
  state.nightStops.forEach((v, i) => u.nightStops[i].value.set(v[0], v[1], v[2]));
  u.awayColor.value.set(state.awayColor[0], state.awayColor[1], state.awayColor[2]);
  u.awayGain.value = state.awayGain;
  u.awayHeight.value = state.awayHeight;
  u.glowPow.value = state.glowPow;
  u.glowGain.value = state.glowGain;
  u.sunTint.value.set(state.sunTint[0], state.sunTint[1], state.sunTint[2]);
  u.discGain.value = state.discGain;
  u.floor.value.set(state.floorLinear[0], state.floorLinear[1], state.floorLinear[2]);
  u.nightWeight.value = state.nightWeight;
  u.turbidity.value = state.preetham.turbidity;
  u.rayleigh.value = state.preetham.rayleigh;
  u.mieCoefficient.value = state.preetham.mieCoefficient;
  u.mieDirectionalG.value = state.preetham.mieDirectionalG;
  // ref* uniforms are written ONCE in buildTrackUniforms — they are the
  // reference keyframe and never change. Minor 6 fix: this function used to
  // rebuild the reference keyframe per call and rewrite every u.ref* slot.
}

/** The four-stop ramp chain (smoothstep segment mix) over TSL colour nodes; anchors from SKY_STOPS. */
function rampTsl(tsl: any, t: any, stops: any[]): any {
  const { mix, smoothstep } = tsl;
  let base: any = stops[0];
  for (let i = 1; i < stops.length; i += 1) {
    base = mix(base, stops[i], smoothstep(SKY_STOPS[i - 1].at, SKY_STOPS[i].at, t));
  }
  return base;
}

/**
 * The sky's colour as ONE TSL expression of a direction and the live sun uniform —
 * v2, the palette-track × Preetham-ratio hybrid (plan 2026-11-08-day-night-sky):
 *
 *     E     = clamp(P(dir, sun, pLive) / P(dir, refSun, refP), 0, 2)   // diffuse only
 *     diff  = ramp(dayStops) cooled toward awayColor (track away params)
 *     day   = diff·E + sunTint·(glow + disc)      // direct term OUTSIDE E
 *     night = ramp(nightStops)
 *     C     = mix(day, night, nightWeight) + floorLinear
 *
 * Reference-key identity: nightWeight = 0, E = 1 (same function, same inputs),
 * track parameters = the HORIZON/SKY_STOPS constants → identical output to v1.
 * The direct term stays OUTSIDE E because vSunE is identically 0 below sun
 * elevation −2.31° — inside E it would multiply the transition keys' afterglow
 * into ≈1e-8 (visually zero).
 *
 * The dome evaluates it at the view ray; the sea's material evaluates it at the
 * reflected view ray — "the sea reflects the sky" is still literally this function.
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
  const { float, mix, smoothstep, vec2, clamp, dot, max } = tsl;
  if (!trackU) trackU = buildTrackUniforms(tsl, trackState);
  const u = trackU;

  // energy ratio field — multiplies the DUSK diffuse term only
  const num = preethamRadianceTsl(tsl, dirNode, sunDirNode, {
    turbidity: u.turbidity,
    rayleigh: u.rayleigh,
    mieCoefficient: u.mieCoefficient,
    mieDirectionalG: u.mieDirectionalG,
  });
  const den = preethamRadianceTsl(tsl, dirNode, u.refSun, {
    turbidity: u.refTurbidity,
    rayleigh: u.refRayleigh,
    mieCoefficient: u.refMieCoefficient,
    mieDirectionalG: u.refMieDirectionalG,
  });
  // Aligns energyRatioJs' `d === 0 → 0` guard (sky-preetham.ts:136): the JS
  // side collapses underflow/denormal denominators to 0; TSL needs an explicit
  // floor since GLSL's division on tiny denormals is not uniformly defined.
  const energy = clamp(num.div(den.max(1e-12)), 0.0, 2.0);

  // diffuse term: day ramp + away cool (track parameters)
  const t = smoothstep(-0.02, 0.55, dirNode.y);
  const diff = rampTsl(tsl, t, u.dayStops);
  // Azimuth, not just height (see v1 comment: component access, not `.xz`; length
  // clamped because the horizontal part is zero at the zenith).
  const dirXZ = vec2(dirNode.x, dirNode.z);
  const sunXZ = vec2(sunDirNode.x, sunDirNode.z);
  const cosAz = dirXZ.div(dirXZ.length().max(1e-4)).dot(sunXZ.div(sunXZ.length().max(1e-4)));
  const away = float(1.0).sub(cosAz).mul(0.5);
  const lowSky = float(1.0).sub(smoothstep(0.0, u.awayHeight, dirNode.y));
  const cool = away.pow(1.2).mul(lowSky).mul(u.awayGain);
  const shaded = mix(diff, u.awayColor, cool);

  // direct terms outside E
  const cos = dot(dirNode, sunDirNode).max(0.0);
  const glow = cos.pow(u.glowPow).mul(u.glowGain);
  let sunLight: any = glow;
  if (includeDisc) {
    const cosHalf = Math.cos((HORIZON.DISK_HALF_ANGLE_DEG * Math.PI) / 180);
    sunLight = glow.add(smoothstep(cosHalf, 1.0, cos).mul(u.discGain));
  }
  const day = shaded.mul(energy).add(u.sunTint.mul(sunLight));

  // night ramp + floor (floor added AFTER the mix so the energy field cannot
  // multiply the night sky to black)
  const night = rampTsl(tsl, t, u.nightStops);
  return mix(day, night, u.nightWeight).add(u.floor);
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
