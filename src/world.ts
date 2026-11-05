/**
 * World composition — owns the banded sea, the near-field puff clouds, and the
 * adaptive-quality governor.
 *
 * The sea is the reconstruct rebuild's: six snap-towed square annuli with one
 * TSL material each, mounted here and driven per frame with the live camera and
 * the live angular budget. Both the sea and the puffs are loaded through
 * dynamic `import()` behind try/catch, so a module that cannot link costs only
 * its own feature.
 *
 * Import-side-effect-free: nothing here runs at module scope, and the WebGPU
 * modules are only pulled in through dynamic `import()` behind try/catch.
 */
import * as THREE from 'three';

import type { CloudBlob } from './in-cloud';
import type { SeaBands } from './sea/bands';
import { SUN_POSITION } from './palettes';

/**
 * Per-frame view state the sea needs and the world cannot invent.
 *
 * `camera` is the camera's world position (its `y` is the altitude the M7
 * visibility mask is keyed on, not the aircraft's), and `radPerPixel` is the
 * live angular budget derived from the drawing buffer — see `perPixelRadians`
 * in `sea/lod.ts`. Both are passed in rather than read here so the world stays
 * renderer-agnostic and unit-testable.
 */
export interface WorldView {
  camera: THREE.Vector3;
  radPerPixel: number;
}

export interface WorldHandles {
  /**
   * Advance one frame. `view` is optional; without it the sea keeps its last
   * tow and only its clock advances (tests and the pre-mount frames use that).
   */
  update(t: number, dt: number, view?: WorldView): void;
  dispose(): void;
  readonly quality: 'high' | 'low';
  /** The mounted banded sea, or `null` when the module could not load. */
  readonly sea: SeaBands | null;
  /** QA lever (plan Task 5): the governor path is unreachable in frozen captures. */
  setQuality?(high: boolean): void;
  /** 近景云的世界包围体；白雾与相机扰动按它算接近度。 */
  readonly blobs: readonly CloudBlob[];
  /** 抓帧开关：?puff=0 关掉近景云场。 */
  setPuffVisible(visible: boolean): void;
}

/** Above this frame time a frame counts as slow. */
export const SLOW_FRAME_MS = 24;
/** Consecutive slow frames before the world steps its quality down. */
export const SLOW_FRAME_LIMIT = 60;
/** Frame delta ceiling (a tab restore must not teleport the animation). */
export const MAX_DT = 0.1;

/**
 * Adaptive-quality governor. Pure and dependency-free so the step-down rule is
 * unit-testable without a renderer.
 */
export class FrameGovernor {
  readonly slowFrameMs: number;
  readonly slowFrameLimit: number;
  readonly maxDt: number;

  private slowRun = 0;
  private degradedFlag = false;

  constructor(options: { slowFrameMs?: number; slowFrameLimit?: number; maxDt?: number } = {}) {
    this.slowFrameMs = options.slowFrameMs ?? SLOW_FRAME_MS;
    this.slowFrameLimit = options.slowFrameLimit ?? SLOW_FRAME_LIMIT;
    this.maxDt = options.maxDt ?? MAX_DT;
  }

  /** Records one frame and returns the sanitised delta in seconds. */
  tick(dtSeconds: number): number {
    const finite = Number.isFinite(dtSeconds) && dtSeconds > 0 ? dtSeconds : 0;
    const clamped = Math.min(finite, this.maxDt);

    if (clamped * 1000 > this.slowFrameMs) this.slowRun += 1;
    else this.slowRun = 0;

    if (!this.degradedFlag && this.slowRun >= this.slowFrameLimit) this.degradedFlag = true;

    return clamped;
  }

  /** True once the quality tier has been dropped (never flips back on its own). */
  get degraded(): boolean {
    return this.degradedFlag;
  }

  get slowFrames(): number {
    return this.slowRun;
  }
}

/** Touch-first mobile detection; pure so it can be tested directly. */
export function isMobileLike(userAgent: string, maxTouchPoints: number): boolean {
  if (/Mobi|Android|iPhone|iPad|iPod|Windows Phone/i.test(userAgent)) return true;
  // iPadOS reports a desktop UA but exposes a touch-capable Macintosh.
  if (/Macintosh/i.test(userAgent) && maxTouchPoints > 1) return true;
  return false;
}

function readIsMobileLike(): boolean {
  const nav = (globalThis as { navigator?: { userAgent?: string; maxTouchPoints?: number } }).navigator;
  return isMobileLike(nav?.userAgent ?? '', nav?.maxTouchPoints ?? 0);
}

interface PuffLike {
  readonly kind: 'puff';
  readonly blobs: readonly CloudBlob[];
  setVisible?(visible: boolean): void;
  update(t: number, sunDir: THREE.Vector3): void;
  setQuality?(high: boolean): void;
  dispose(): void;
}

export async function initWorld(
  scene: THREE.Scene,
  sunLight?: THREE.DirectionalLight,
): Promise<WorldHandles> {
  const governor = new FrameGovernor();
  const sunDir = new THREE.Vector3(SUN_POSITION[0], SUN_POSITION[1], SUN_POSITION[2]).normalize();

  // 近景碎棉花：mesh 球体簇和 dome slab 同场；失败只丢碎云不丢海和顶云。
  let puffs: PuffLike | null = null;
  try {
    const mod = await import('./puff-cloud');
    puffs = await mod.initPuffClouds(scene);
  } catch (error) {
    console.error('[world] puff clouds unavailable, dome only:', error);
    puffs = null;
  }

  let disposed = false;
  let quality: 'high' | 'low' = 'high';

  // The banded sea. Dynamic import for the same reason the puffs use one: the
  // module chain reaches `three/tsl` through `buildSurfaceMaterial`, and a
  // failed sea must cost the sea, not the sky. Unlike the old FFT sea this one
  // is fully owned here — `initSeaBands` adds its six meshes to `scene` and
  // `dispose` takes them back out.
  let sea: SeaBands | null = null;
  try {
    const mod = await import('./sea/bands');
    sea = await mod.initSeaBands(scene);
  } catch (error) {
    console.error('[world] sea unavailable, sky + puffs only:', error);
    sea = null;
  }

  const applyQuality = (high: boolean): void => {
    quality = high ? 'high' : 'low';
    puffs?.setQuality?.(high);
    sea?.setQuality(high);
  };

  // Mobile is the primary target for the cheap path: start there instead of
  // burning a second on frames before the governor notices.
  if (readIsMobileLike()) applyQuality(false);

  return {
    get quality() {
      return quality;
    },
    get sea() {
      return sea;
    },
    setQuality: applyQuality,
    get blobs() {
      return puffs?.blobs ?? [];
    },
    setPuffVisible(visible: boolean): void {
      puffs?.setVisible?.(visible);
    },
    update(t: number, dt: number, view?: WorldView): void {
      if (disposed) return;
      governor.tick(dt);

      if (governor.degraded && quality === 'high') {
        applyQuality(false);
        console.info('[world] quality stepped down to low');
      }

      const time = Number.isFinite(t) ? t : 0;
      // 太阳方向优先读场景里那盏 DirectionalLight：转灯，云的四档色带跟着转。
      // 没有灯（测试/无灯场景）才退回模块自己的 SUN_POSITION 派生值。
      if (sunLight) {
        sunDir.copy(sunLight.position).sub(sunLight.target.position);
        if (sunDir.lengthSq() > 1e-9) sunDir.normalize();
      }
      puffs?.update(time, sunDir);
      // The sea is towed on the camera, not on the plane: the camera rig lags the
      // aircraft, and towing on the plane would open a gap ahead of the nose the
      // moment the rig pulls back.
      if (view) sea?.update(view.camera, view.radPerPixel, time);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      puffs?.dispose();
      sea?.dispose();
    },
  };
}
