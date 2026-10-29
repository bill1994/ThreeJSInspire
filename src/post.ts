/**
 * src/post.ts — the WebGPU post pipeline: bloom, distance blur, SMAA.
 *
 * Node chain (the order matters, and two of the three steps are easy to get backwards):
 *
 *   pass(samples: 0) → bloom() ─add→ dof() → smaa()
 *
 * - `bloom()` returns **only the glow**, so it must be added to the scene colour.
 * - `dof()` returns the **finished image**, so it must not be added to anything.
 * - `smaa()` works in **linear space**: leave `pipeline.outputColorTransform` at its default
 *   (true) so the pipeline tone-maps and converts to sRGB *after* SMAA. Wrapping it in
 *   `renderOutput()` is the FXAA recipe — running the edge detector on already-encoded pixels
 *   softens every edge in the frame.
 *
 * `pass()` with `samples: 0` because `antialias: true` is silently zeroed in WebGPU
 * compatibility mode (older Android), so SMAA does the anti-aliasing on every device.
 */
import * as THREE from 'three/webgpu';
import { pass, uniform } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';

export interface PostFx {
  bloom: boolean;
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
  dof: boolean;
  focusDistance: number;
  focalLength: number;
  bokehScale: number;
}

export interface PostHandle {  render(): void;
  /** Keeps the aircraft sharp by pulling focus onto it every frame. */
  focusTo(cam: { x: number; y: number; z: number }, plane: { x: number; y: number; z: number }): void;
  setQuality(high: boolean): void;
  setFx(p: Partial<PostFx>): void;
  dispose(): void;
  readonly fx: PostFx;
}

/**
 * Desktop budget. `bloomThreshold` 0.82 sits between the horizon (#ff9a5a, ~1.0 but spread
 * wide) and the sun disc (`pow(cos, 220) * 2.4`), so the disc and the sea glitter bloom while
 * the flat sky does not.
 */
export const POST_HIGH: PostFx = {
  bloom: true,
  bloomStrength: 0.7,
  bloomRadius: 0.6,
  bloomThreshold: 0.82,
  dof: true,
  focusDistance: 34,
  focalLength: 420,
  bokehScale: 1.1,
};

/** Mobile budget: half-resolution bloom, no depth of field — blur is the first thing to cut. */
export const POST_LOW: PostFx = {
  ...POST_HIGH,
  bloomStrength: 0.55,
  bloomRadius: 0.55,
  bloomThreshold: 0.85,
  dof: false,
  bokehScale: 0.6,
};

/** `?post=0` turns the whole pipeline off; everything else leaves it on. */
export function usePost(search: string): boolean {
  const query = search.startsWith('?') ? search : `?${search}`;
  return new URLSearchParams(query).get('post') !== '0';
}

/**
 * Distance from the camera to the aircraft, which is where focus belongs. Clamped to
 * [12, 60]: closer than the near field the sea would blur under the nose, further out the
 * aircraft itself would soften as the camera lags in a dive.
 */
export function focusDistanceFor(
  cam: { x: number; y: number; z: number },
  plane: { x: number; y: number; z: number },
): number {
  const dx = plane.x - cam.x;
  const dy = plane.y - cam.y;
  const dz = plane.z - cam.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!Number.isFinite(distance)) return POST_HIGH.focusDistance;
  return Math.min(60, Math.max(12, distance));
}

function clampNumber(value: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(hi, Math.max(lo, value));
}

/** Keeps hand-tuned or externally supplied values inside the ranges the shader expects. */
export function clampFx(fx: PostFx): PostFx {
  return {
    bloom: fx.bloom === true,
    bloomStrength: clampNumber(fx.bloomStrength, 0, 2, POST_HIGH.bloomStrength),
    bloomRadius: clampNumber(fx.bloomRadius, 0, 1, POST_HIGH.bloomRadius),
    bloomThreshold: clampNumber(fx.bloomThreshold, 0, 1, POST_HIGH.bloomThreshold),
    dof: fx.dof === true,
    focusDistance: clampNumber(fx.focusDistance, 12, 60, POST_HIGH.focusDistance),
    focalLength: clampNumber(fx.focalLength, 50, 2000, POST_HIGH.focalLength),
    bokehScale: clampNumber(fx.bokehScale, 0, 3, POST_HIGH.bokehScale),
  };
}

export function initPost(
  renderer: any,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
): PostHandle {
  let fx = clampFx(POST_HIGH);

  const pipeline = new (THREE as any).RenderPipeline(renderer);

  // samples: 0 — SMAA owns anti-aliasing (see the module comment).
  const scenePass = pass(scene, camera, { samples: 0 });
  const color = scenePass.getTextureNode('output'); // HalfFloat: >1 highlights survive for bloom
  const viewZ = scenePass.getViewZNode();

  const glow = bloom(color, fx.bloomStrength, fx.bloomRadius, fx.bloomThreshold);
  const lit = color.add(glow); // ⚠️ bloom() is only the glow

  // Uniforms, not constants: focus follows the aircraft and quality switching retunes these
  // without rebuilding the node graph (`pipeline.needsUpdate` is never needed here).
  const focus = uniform(fx.focusDistance);
  const focal = uniform(fx.focalLength);
  const bokeh = uniform(fx.bokehScale);

  const image = dof(lit, viewZ, focus, focal, bokeh); // ⚠️ dof() is the finished image
  pipeline.outputNode = smaa(image); // linear-space filter; pipeline transforms afterwards
  pipeline.needsUpdate = true;

  const applyFx = (next: PostFx): void => {
    fx = next;
    // `bloom: false` collapses to strength 0: BloomNode has no enable flag, and swapping the
    // outputNode would force a `needsUpdate` rebuild we do not want at runtime.
    glow.strength.value = next.bloom ? next.bloomStrength : 0;
    glow.radius.value = next.bloomRadius;
    glow.threshold.value = next.bloomThreshold;
    focus.value = next.focusDistance;
    focal.value = next.focalLength;
    bokeh.value = next.dof ? next.bokehScale : 0;
  };

  applyFx(fx);

  return {
    render(): void {
      pipeline.render();
    },
    focusTo(cam, plane): void {
      const next = clampFx({ ...fx, focusDistance: focusDistanceFor(cam, plane) });
      fx = next;
      focus.value = next.focusDistance;
    },
    setQuality(high: boolean): void {
      // Half-resolution bloom on the low tier; DOF collapses to bokehScale 0 rather than
      // swapping the outputNode, so the graph is built once for the whole session.
      glow.setResolutionScale(high ? 1 : 0.5);
      applyFx(clampFx(high ? POST_HIGH : POST_LOW));
    },
    setFx(partial: Partial<PostFx>): void {
      applyFx(clampFx({ ...fx, ...partial }));
    },
    dispose(): void {
      pipeline.dispose();
    },
    get fx() {
      return fx;
    },
  };
}
