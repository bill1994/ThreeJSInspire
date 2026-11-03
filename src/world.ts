/**
 * World composition — picks the sea/cloud implementation for the active backend
 * and owns the adaptive-quality governor.
 *
 * Import-side-effect-free: nothing here runs at module scope, and the WebGPU
 * modules are only pulled in through dynamic `import()` behind try/catch, so a
 * TSL failure degrades to the GLSL path instead of a black screen.
 */
import * as THREE from 'three';

import type { CloudBlob } from './in-cloud';
import { SUN_POSITION } from './palettes';

export interface WorldHandles {
  update(t: number, dt: number): void;
  dispose(): void;
  /** Which implementations actually ended up in the scene (fallbacks included). */
  readonly seaKind: 'fft' | 'gerstner';
  readonly cloudKind: 'tsl' | 'sprite';
  readonly quality: 'high' | 'low';
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

interface SeaLike {
  readonly kind: 'fft' | 'gerstner';
  update(t: number): void;
  setQuality?(high: boolean): void;
  dispose(): void;
}

interface CloudLike {
  readonly kind: 'tsl' | 'sprite';
  update(t: number, sunDir: THREE.Vector3): void;
  setQuality?(high: boolean): void;
  dispose(): void;
}

interface PuffLike {
  readonly kind: 'puff';
  readonly blobs: readonly CloudBlob[];
  setVisible?(visible: boolean): void;
  update(t: number, sunDir: THREE.Vector3): void;
  setQuality?(high: boolean): void;
  dispose(): void;
}

async function createSea(scene: THREE.Scene): Promise<SeaLike> {
  try {
    // Built before the mesh is added, so a throw here leaves the scene clean.
    const mod = await import('./sea-fft');
    return await mod.initSea(scene, 'webgpu');
  } catch (error) {
    // No silent Gerstner fallback any more: the WebGL2 backend runs the same TSL sea.
    console.error('[world] FFT sea failed to build:', error);
    throw error;
  }
}

async function createClouds(scene: THREE.Scene): Promise<CloudLike> {
  try {
    const mod = await import('./clouds-compute');
    return await mod.initClouds(scene, 'webgpu');
  } catch (error) {
    console.error('[world] volumetric clouds failed to build:', error);
    throw error;
  }
}

export async function initWorld(
  scene: THREE.Scene,
  sunLight?: THREE.DirectionalLight,
): Promise<WorldHandles> {
  const sea = await createSea(scene);

  let clouds: CloudLike;
  try {
    clouds = await createClouds(scene);
  } catch (error) {
    // Even the one remaining cloud path failed: keep the sea rather than crash the frame loop.
    console.error('[world] clouds unavailable, sea only:', error);
    clouds = {
      kind: 'tsl',
      update: () => undefined,
      dispose: () => undefined,
    };
  }

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

  const applyQuality = (high: boolean): void => {
    quality = high ? 'high' : 'low';
    sea.setQuality?.(high);
    clouds.setQuality?.(high);
    puffs?.setQuality?.(high);
  };

  // Mobile is the primary target for the cheap path: start there instead of
  // burning a second on frames before the governor notices.
  if (readIsMobileLike()) applyQuality(false);

  return {
    get seaKind() {
      return sea.kind;
    },
    get cloudKind() {
      return clouds.kind;
    },
    get quality() {
      return quality;
    },
    get blobs() {
      return puffs?.blobs ?? [];
    },
    setPuffVisible(visible: boolean): void {
      puffs?.setVisible?.(visible);
    },
    update(t: number, dt: number): void {
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
      sea.update(time);
      clouds.update(time, sunDir);
      puffs?.update(time, sunDir);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      sea.dispose();
      clouds.dispose();
      puffs?.dispose();
    },
  };
}
