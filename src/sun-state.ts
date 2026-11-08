/**
 * src/sun-state.ts — the ONE live sun direction for the whole scene.
 *
 * Why this module exists (2026-11-08 review): before it, the sun was four
 * separate facts that only agreed by accident —
 *
 *   - `main.ts` owned a `liveSunDir` Vector3 seeded once from `?sun=az,el`;
 *   - the TSL sky dome copied it into its own uniform every frame;
 *   - the sea's four ring materials captured it BY REFERENCE at boot and had no
 *     setter at all;
 *   - the puff field re-derived a direction from the DirectionalLight's
 *     position instead.
 *
 * Nothing could rotate the sun after boot, and the sea had no way to be told
 * that the sky (or the sky shell's tow) had changed. The result was a sun whose
 * reflection on the water stayed put while the sky moved.
 *
 * The contract here is deliberately narrow:
 *
 *   1. `direction` is ONE Vector3 object that is NEVER replaced — every setter
 *      mutates it in place. three's `uniform( value )` keeps the reference (see
 *      `three/src/nodes/core/UniformNode.js`), so the sky and all four sea
 *      materials can bind to it directly and can never drift apart.
 *   2. `version` bumps on every change, so consumers that must do extra work
 *      (moving a DirectionalLight, rebuilding a LUT, QA bookkeeping) can do it
 *      only when the sun actually moved instead of every frame.
 *   3. `subscribe()` is the explicit "the sky/sun changed" signal. Consumers
 *      that only need the direction need not subscribe — binding to
 *      `direction` is enough.
 *
 * Import-side-effect-free and renderer-agnostic: no TSL, no DOM, no renderer.
 */
import * as THREE from 'three';

import { clampSunElevation, sunDirectionFromAzEl } from './horizon';
import { SUN_DIRECTION } from './palettes';

const RAD_TO_DEG = 180 / Math.PI;

export interface SunState {
  /** The one and only sun direction (unit length). NEVER reassign this object. */
  readonly direction: THREE.Vector3;
  /** Degrees; azimuth 0 points down -Z and grows toward +X. */
  readonly azimuthDeg: number;
  /** Degrees above the horizon. */
  readonly elevationDeg: number;
  /** Increments on every accepted change; starts at 1 (the boot value). */
  readonly version: number;

  /** Set by azimuth/elevation. Elevation is clamped into the measured dusk band. */
  setAzEl(azDeg: number, elDeg: number): void;
  /** Rotate the sun (and therefore the sky's warm side) around world +Y. */
  rotateAzimuth(deg: number): void;
  /** Set from an arbitrary vector; normalised, azimuth/elevation back-solved. */
  setDirection(v: THREE.Vector3): void;

  /** Register a change listener. Returns an unsubscribe function. */
  subscribe(listener: (state: SunState) => void): () => void;

  /** Plain-object copy for QA readouts; never handed to a shader. */
  snapshot(): { x: number; y: number; z: number; azimuthDeg: number; elevationDeg: number; version: number };
}

/** Inverse of `sunDirectionFromAzEl`: atan2(x, -z). */
export function azimuthDegOf(v: THREE.Vector3): number {
  return Math.atan2(v.x, -v.z) * RAD_TO_DEG;
}

/** Inverse of `sunDirectionFromAzEl`: asin(y). */
export function elevationDegOf(v: THREE.Vector3): number {
  return Math.asin(Math.min(Math.max(v.y, -1), 1)) * RAD_TO_DEG;
}

/** Wrap into (-180, 180] so repeated rotations stay readable. */
export function wrapAzimuthDeg(deg: number): number {
  const wrapped = ((deg + 180) % 360 + 360) % 360 - 180;
  return wrapped === -180 ? 180 : wrapped;
}

export function createSunState(): SunState {
  // Seed from the single-source palette constant, not a second literal.
  const direction = new THREE.Vector3(...SUN_DIRECTION).normalize();
  let azimuthDeg = wrapAzimuthDeg(azimuthDegOf(direction));
  let elevationDeg = elevationDegOf(direction);
  let version = 1;
  const listeners = new Set<(state: SunState) => void>();

  const state: SunState = {
    get direction() {
      return direction;
    },
    get azimuthDeg() {
      return azimuthDeg;
    },
    get elevationDeg() {
      return elevationDeg;
    },
    get version() {
      return version;
    },

    setAzEl(azDeg: number, elDeg: number): void {
      if (!Number.isFinite(azDeg) || !Number.isFinite(elDeg)) return;
      const el = clampSunElevation(elDeg);
      const [x, y, z] = sunDirectionFromAzEl(azDeg, el);
      // In-place by contract: every bound TSL uniform sees the change at once.
      direction.set(x, y, z).normalize();
      azimuthDeg = wrapAzimuthDeg(azDeg);
      elevationDeg = el;
      version += 1;
      for (const listener of listeners) listener(state);
    },

    rotateAzimuth(deg: number): void {
      if (!Number.isFinite(deg)) return;
      state.setAzEl(azimuthDeg + deg, elevationDeg);
    },

    setDirection(v: THREE.Vector3): void {
      if (!v || !Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) return;
      const len = Math.hypot(v.x, v.y, v.z);
      if (!(len > 1e-9)) return;
      direction.set(v.x / len, v.y / len, v.z / len);
      azimuthDeg = wrapAzimuthDeg(azimuthDegOf(direction));
      elevationDeg = elevationDegOf(direction);
      version += 1;
      for (const listener of listeners) listener(state);
    },

    subscribe(listener: (state: SunState) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    snapshot(): { x: number; y: number; z: number; azimuthDeg: number; elevationDeg: number; version: number } {
      return {
        x: direction.x,
        y: direction.y,
        z: direction.z,
        azimuthDeg,
        elevationDeg,
        version,
      };
    },
  };

  return state;
}
