/**
 * World composition — owns the FFT sea, the near-field puff clouds and the
 * adaptive-quality governor.
 *
 * The sea came back on 2026-11-07 as the stylized FFT ocean (plan
 * `2026-11-06-stylized-fft-ocean.md`): mounted through a dynamic `import()`
 * behind try/catch so a module that cannot link costs only the sea, never the
 * sky. It needs the live renderer (the IFFT chain dispatches through it) and
 * main's live sun vector by reference — see `initSea`.
 *
 * Import-side-effect-free: nothing here runs at module scope, and the WebGPU module is only
 * pulled in through dynamic `import()` behind try/catch.
 */
import * as THREE from 'three';

import type { CloudBlob } from './in-cloud';
import { SUN_POSITION } from './palettes';
import { CANONICAL_RAD_PER_PIXEL } from './view-budget';
import type { SeaOcean } from './sea/material';
import type { Vec3 } from './sky-track';

/** What the sea needs per frame: the camera it tows to and the view budget. */
export interface WorldView {
  camera: THREE.Vector3;
  radPerPixel: number;
}

export interface WorldHandles {
  /** Advance one frame; `view` feeds the sea's displacement sampling. */
  update(t: number, dt: number, view?: WorldView): void;
  dispose(): void;
  readonly quality: 'high' | 'low';
  /** True when the puff field actually mounted, so the boot label cannot claim clouds it lost. */
  readonly clouds: boolean;
  /** The mounted ocean, or null when it failed to link. */
  readonly sea: SeaOcean | null;
  /** QA lever (plan Task 5): the governor path is unreachable in frozen captures. */
  setQuality?(high: boolean): void;
  /** 近景云的世界包围体；白雾与相机扰动按它算接近度。 */
  readonly blobs: readonly CloudBlob[];
  /** 抓帧开关：?puff=0 关掉近景云场。 */
  setPuffVisible(visible: boolean): void;
  /** 抓帧开关：?sea=0 关掉海面。 */
  setSeaVisible(visible: boolean): void;
  /**
   * 太阳/天空变化后显式通知海面，让四条 ring 的太阳映射（反射、光路、
   * 逆光浪峰、方位霾）跟着一起转。云的方向仍按既有约定从 DirectionalLight
   * 派生，本次不碰。
   */
  setSunDirection(dir: THREE.Vector3): void;
  /**
   * 轨道接线（day-night Task 7）：把 `skyColorJs.seaHazeEndpoints` 派生的霾端点
   * （线性 RGB）灌进四条 ring 的共享 uniform —— main 每次太阳版本变更调一次。
   */
  setHazeTargets(hazeLinear: Vec3, awayEdgeLinear: Vec3): void;
  /** 轨道接线：四档云带色 + 空气透视雾色（线性 RGB），puff handle 原地写 uniform。 */
  setCloudPalette(bands: readonly Vec3[], haze: Vec3): void;
  /** 兜底瓣驱动：进云度 0..1 + 相机位。game 每帧经 onInCloud 送来。 */
  setInterior(inCloud01: number, cam: { x: number; y: number; z: number }): void;
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
  /** 兜底瓣驱动：进云度 0..1 + 相机位置（世界系）。可选——旧句柄没有壳层。 */
  setInterior?(inCloud01: number, cam: { x: number; y: number; z: number }): void;
  /** 轨道调色（day-night Task 5/7）。可选——旧句柄没有。 */
  setCloudPalette?(bands: readonly Vec3[], haze: Vec3): void;
  dispose(): void;
}

export async function initWorld(
  scene: THREE.Scene,
  sunLight?: THREE.DirectionalLight,
  renderer?: any,
  sunDirLive?: THREE.Vector3,
): Promise<WorldHandles> {
  const governor = new FrameGovernor();
  const sunDir = new THREE.Vector3(SUN_POSITION[0], SUN_POSITION[1], SUN_POSITION[2]).normalize();

  // 风格化 FFT 海：失败只丢海，不丢天穹。renderer 与活太阳按引用传入
  // （见 initSea 的 ruling——uniform 共享同一 Vector3 对象，免每帧同步）。
  let sea: SeaOcean | null = null;
  try {
    const mod = await import('./sea/material');
    sea = await mod.initSea(scene, renderer, sunDirLive ?? sunDir);
  } catch (error) {
    console.error('[world] sea unavailable, sky only:', error);
    sea = null;
  }

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
  // A caller that never passes a view still gets a defined sea update.
  let lastView: WorldView = { camera: new THREE.Vector3(), radPerPixel: CANONICAL_RAD_PER_PIXEL };

  const applyQuality = (high: boolean): void => {
    quality = high ? 'high' : 'low';
    sea?.setQuality(high);
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
    setSeaVisible(visible: boolean): void {
      sea?.setVisible(visible);
    },
    setSunDirection(dir: THREE.Vector3): void {
      sea?.setSunDirection(dir);
    },
    setHazeTargets(hazeLinear: Vec3, awayEdgeLinear: Vec3): void {
      sea?.setHazeTargets(hazeLinear, awayEdgeLinear);
    },
    setCloudPalette(bands: readonly Vec3[], haze: Vec3): void {
      puffs?.setCloudPalette?.(bands, haze);
    },
    setInterior(inCloud01: number, cam: { x: number; y: number; z: number }): void {
      puffs?.setInterior?.(inCloud01, cam);
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

      // The sea's clock is the accumulated elapsed time (frozen captures step it
      // deterministically), never the wall clock.
      if (sea) {
        if (view) lastView = view;
        sea.update(lastView.camera, lastView.radPerPixel, time);
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      sea?.dispose();
      puffs?.dispose();
    },
  };
}
