/**
 * World composition — owns the near-field puff clouds and the adaptive-quality governor.
 *
 * There is no sea here any more: the banded sea (and with it the per-frame camera tow and
 * the angular budget) was deleted on 2026-11-06 (`rebuild/sea-dome-reset`). What is left
 * is the puff field, loaded through a dynamic `import()` behind try/catch so a module that
 * cannot link costs only the clouds, never the sky.
 *
 * Import-side-effect-free: nothing here runs at module scope, and the WebGPU module is only
 * pulled in through dynamic `import()` behind try/catch.
 */
import * as THREE from 'three';

import type { CloudBlob } from './in-cloud';
import { SUN_POSITION } from './palettes';

export interface WorldHandles {
  /** Advance one frame. */
  update(t: number, dt: number): void;
  dispose(): void;
  readonly quality: 'high' | 'low';
  /** True when the puff field actually mounted, so the boot label cannot claim clouds it lost. */
  readonly clouds: boolean;
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

  // 近景碎棉花：失败只丢碎云，不丢天穹。
  let puffs: PuffLike | null = null;
  try {
    const mod = await import('./puff-cloud');
    puffs = await mod.initPuffClouds(scene);
  } catch (error) {
    console.error('[world] puff clouds unavailable, sky only:', error);
    puffs = null;
  }

  let disposed = false;
  let quality: 'high' | 'low' = 'high';

  const applyQuality = (high: boolean): void => {
    quality = high ? 'high' : 'low';
    puffs?.setQuality?.(high);
  };

  // Mobile is the primary target for the cheap path: start there instead of
  // burning a second on frames before the governor notices.
  if (readIsMobileLike()) applyQuality(false);

  return {
    get quality() {
      return quality;
    },
    get clouds() {
      return puffs !== null;
    },
    setQuality: applyQuality,
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
      puffs?.update(time, sunDir);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      puffs?.dispose();
    },
  };
}
