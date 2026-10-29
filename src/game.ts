/**
 * src/game.ts — the single entry point the app calls.
 *
 * `initGame` mounts plane + input + camera rig + feel + HUD + audio and returns an
 * `update(t, dt)` that advances the flight model, then (in late-update order) the
 * camera, the contrails and the HUD readouts. Nothing here may throw: a missing GLB,
 * a blocked AudioContext or a DOM-less host all degrade instead of failing boot.
 *
 * The flight model and the smoothing live in exported pure functions so they are
 * testable in node without a renderer.
 */
import * as THREE from 'three';
import { initPlane } from './plane';
import { initInput } from './input';
import { initCameraRig, smoothCamera, CAM_FOV_KICK, type FlightPose, type Vec3 } from './camera-rig';
import { initFeel } from './feel';
import { createDirector, DIRECTOR } from './director';
import { HUD_BUS_DEFAULTS, defaultHudReadout, initHud, type HudHandle, type HudReadout } from './hud';
import { initAudio, type AudioHandle } from './audio';
import { STALL, stall01 } from './stall';

export { smoothCamera };

export type Backend = 'webgpu' | 'webgl2';

export interface GameHandles {
  update(t: number, dt: number): void;
  /**
   * Live aircraft position, so the composition root can re-centre the far field (ocean
   * patch, cloud dome, sky dome) under the aircraft. Read-only view, no allocation.
   */
  pose(): { x: number; y: number; z: number };
  dispose(): void;
}

/** Flight model constants. Everything the tuning pass needs lives here. */
export const FLIGHT = {
  /** Longest step the integrator will take (a tab-switch hitch must not teleport). */
  DT_CLAMP: 0.1,
  MAX_BANK: 1.05,
  MAX_PITCH: 1.2,
  /** Turn rate at a 90 degree bank, rad/s. */
  TURN_RATE: 1.25,
  /** Exponential approach rates (1/s). */
  BANK_ATTACK: 6.5,
  PITCH_ATTACK: 6,
  SPEED_ATTACK: 1.6,
  MIN_SPEED: 34,
  MAX_SPEED: 78,
  CRUISE_SPEED: 46,
  /** Speed gained per m/s of sink (and lost per m/s of climb). */
  DIVE_GAIN: 16,
  ALT_MIN: 6,
  ALT_MAX: 46,
  START_Y: 30,
} as const;

export interface FlightState {
  pos: Vec3;
  /** Radians. 0 = nose along -Z (toward the sun); right turns DECREASE yaw. */
  yaw: number;
  /** Radians. + = nose up. */
  pitch: number;
  /** Radians. + = right wing down. */
  bank: number;
  /** Metres per second along the nose. */
  speed: number;
  /** 0..1 stylised stall intensity, written by `stepFlight` every step. */
  stall: number;
}

export interface SteerLike {
  x: number;
  y: number;
}

const TAU = Math.PI * 2;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function finite(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

/** Frame-rate independent smoothing factor. */
function attack(dt: number, lambda: number): number {
  if (dt <= 0 || lambda <= 0) return 0;
  const a = 1 - Math.exp(-lambda * dt);
  return a > 1 ? 1 : a;
}

/** Wrap an angle into (-PI, PI]. NaN reads as 0. */
export function wrapAngle(a: number): number {
  if (!Number.isFinite(a)) return 0;
  let x = (a + Math.PI) % TAU;
  if (x < 0) x += TAU;
  return x - Math.PI;
}

/** Unit nose direction for the current attitude. Writes into `out` (no allocation). */
export function flightForward(yaw: number, pitch: number, out: Vec3): Vec3 {
  const y = finite(yaw, 0);
  const p = finite(pitch, 0);
  const cp = Math.cos(p);
  out.x = -Math.sin(y) * cp;
  out.y = Math.sin(p);
  out.z = -Math.cos(y) * cp;
  return out;
}

export function createFlightState(): FlightState {
  return {
    pos: { x: 0, y: FLIGHT.START_Y, z: 0 },
    yaw: 0,
    pitch: 0,
    bank: 0,
    speed: FLIGHT.CRUISE_SPEED,
    stall: 0,
  };
}

const _fwd: Vec3 = { x: 0, y: 0, z: -1 };

/**
 * Advance the flight model one clamped step, in place.
 *
 * Input convention (one `steer` action for pointer and touch): x = + right, y = + drag
 * down. Drag up (y < 0) climbs, drag down (y > 0) dives, drag right banks right.
 */
export function stepFlight(state: FlightState, dt: number, input: SteerLike): FlightState {
  const d = Number.isFinite(dt) && dt > 0 ? Math.min(dt, FLIGHT.DT_CLAMP) : 0;
  if (d === 0) return state;

  const sx = clamp(finite(input?.x, 0), -1, 1);
  const sy = clamp(finite(input?.y, 0), -1, 1);

  // attitude: bank from horizontal drag, pitch from vertical drag (inverted: up climbs)
  const bankTarget = FLIGHT.MAX_BANK * sx;
  const pitchTarget = -FLIGHT.MAX_PITCH * sy;
  state.bank += (bankTarget - state.bank) * attack(d, FLIGHT.BANK_ATTACK);
  state.pitch += (pitchTarget - state.pitch) * attack(d, FLIGHT.PITCH_ATTACK);
  state.bank = clamp(state.bank, -FLIGHT.MAX_BANK, FLIGHT.MAX_BANK);
  state.pitch = clamp(state.pitch, -FLIGHT.MAX_PITCH, FLIGHT.MAX_PITCH);

  // yaw: positive bank = right wing down = right turn = yaw decreases
  state.yaw = wrapAngle(state.yaw - FLIGHT.TURN_RATE * Math.sin(state.bank) * d);

  // speed: energy trade, fast in a dive, slow in a climb, always inside the band
  const speedTarget = clamp(
    (FLIGHT.MIN_SPEED + FLIGHT.MAX_SPEED) * 0.5 - Math.sin(state.pitch) * FLIGHT.DIVE_GAIN,
    FLIGHT.MIN_SPEED,
    FLIGHT.MAX_SPEED,
  );
  state.speed += (speedTarget - state.speed) * attack(d, FLIGHT.SPEED_ATTACK);
  state.speed = clamp(finite(state.speed, FLIGHT.CRUISE_SPEED), FLIGHT.MIN_SPEED, FLIGHT.MAX_SPEED);

  // integrate along the nose, then hold the altitude band
  flightForward(state.yaw, state.pitch, _fwd);

  // Stylised stall (see stall.ts): nose up + no airspeed presses the nose down and
  // bleeds speed, whose lower speed01 feeds the next stall01 — the self-lock the
  // HUD's STALL block and the buffet ride on. Recovers the moment pitch unloads.
  const stallSpeed01 = clamp((state.speed - FLIGHT.MIN_SPEED) / (FLIGHT.MAX_SPEED - FLIGHT.MIN_SPEED), 0, 1);
  const stall = stall01(state.pitch, stallSpeed01);
  state.stall = stall;
  if (stall > 0) {
    _fwd.y = _fwd.y * (1 - stall) - STALL.NOSE_DROP * stall;
    const len = Math.hypot(_fwd.x, _fwd.y, _fwd.z) || 1;
    _fwd.x /= len;
    _fwd.y /= len;
    _fwd.z /= len;
    // Floor at MIN_SPEED so the band invariant the tests pin survives the step; the
    // stall keeps biting at the floor anyway — speed01 = 0 keeps stall01 maxed.
    state.speed = Math.max(state.speed - STALL.DRAG * stall * d, FLIGHT.MIN_SPEED);
  }

  const adv = state.speed * d;
  state.pos.x = finite(state.pos.x, 0) + _fwd.x * adv;
  state.pos.y = finite(state.pos.y, FLIGHT.START_Y) + _fwd.y * adv;
  state.pos.z = finite(state.pos.z, 0) + _fwd.z * adv;

  // Hold the altitude band. The attitude is deliberately left alone: zeroing pitch at
  // the ceiling would fight the stick, so the plane merely slides along the boundary
  // until the pilot eases off.
  if (state.pos.y > FLIGHT.ALT_MAX) state.pos.y = FLIGHT.ALT_MAX;
  else if (state.pos.y < FLIGHT.ALT_MIN) state.pos.y = FLIGHT.ALT_MIN;
  return state;
}

function noopHandles(): GameHandles {
  return {
    pose(): { x: number; y: number; z: number } {
      return { x: 0, y: FLIGHT.START_Y, z: 0 };
    },
    update(): void {},
    dispose(): void {},
  };
}

export async function initGame(opts: {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  backend: Backend;
}): Promise<GameHandles> {
  const { scene, camera, canvas } = opts;
  let plane: Awaited<ReturnType<typeof initPlane>> | null = null;
  let input: ReturnType<typeof initInput> | null = null;
  let rig: ReturnType<typeof initCameraRig> | null = null;
  let feel: ReturnType<typeof initFeel> | null = null;
  let hud: HudHandle | null = null;
  let audio: AudioHandle | null = null;
  let disposed = false;

  try {
    plane = await initPlane(scene);
    input = initInput(canvas);
    rig = initCameraRig(camera);
    feel = initFeel(scene);
    try {
      audio = initAudio();
      for (const bus of ['master', 'music', 'sfx', 'ambience', 'ui'] as const) {
        audio.setBus(bus, HUD_BUS_DEFAULTS[bus]);
      }
    } catch (err) {
      console.warn('[porco] audio unavailable, running silent');
      void err;
      audio = null;
    }
    try {
      hud = initHud({
        onBusChange: (bus, v) => {
          audio?.setBus(bus, v);
        },
      });
    } catch (err) {
      console.warn('[porco] HUD unavailable');
      void err;
      hud = null;
    }
  } catch (err) {
    console.error('[porco] initGame failed to mount', err);
    return noopHandles();
  }

  const state = createFlightState();
  const director = createDirector();
  const pose: FlightPose = { pos: state.pos, forward: { x: 0, y: 0, z: -1 }, bank: 0, speed01: 0 };
  const readout: HudReadout = defaultHudReadout();
  const leftTip = { x: 0, y: 0, z: 0 };
  const rightTip = { x: 0, y: 0, z: 0 };

  let fps = 60;
  let lastIntensity = -1;
  let duckUntil = 0;
  let contrailActive = false;
  let clock = 0;

  // ---- aspect: mirror the drawing buffer, never the CSS box -------------------
  // The buffer is what the renderer actually rasterises, so deriving the aspect from
  // it can never stretch the image, whatever the CSS does. NaN/0 sizes are ignored,
  // and an extreme (landscape) window is clamped so the portrait framing survives a
  // rotation instead of producing a degenerate projection.
  const syncAspect = (): void => {
    const bw = canvas.width;
    const bh = canvas.height;
    let w = Number.isFinite(bw) && bw > 0 ? bw : canvas.clientWidth;
    let h = Number.isFinite(bh) && bh > 0 ? bh : canvas.clientHeight;
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      w = 9;
      h = 16;
    }
    // Match the drawing buffer EXACTLY. Clamping here instead would change the projection
    // without changing the buffer, i.e. it would stretch the frame — the one thing the
    // portrait contract forbids. A landscape window simply shows more world, never a
    // squashed one; index.html's 9:16 CSS box is what keeps the framing portrait.
    const aspect = w / h;
    if (Math.abs(aspect - camera.aspect) > 1e-4) {
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    }
  };
  syncAspect();
  window.addEventListener('resize', syncAspect);
  window.addEventListener('orientationchange', syncAspect);

  const unlisten = (): void => {
    window.removeEventListener('resize', syncAspect);
    window.removeEventListener('orientationchange', syncAspect);
  };

  return {
    pose(): { x: number; y: number; z: number } {
      return { x: state.pos.x, y: state.pos.y, z: state.pos.z };
    },
    update(t: number, dt: number): void {
      if (disposed || !plane || !input || !rig || !feel) return;
      syncAspect(); // cheap guard against a renderer resize landing mid-frame
      const d = Number.isFinite(dt) && dt > 0 ? Math.min(dt, FLIGHT.DT_CLAMP) : 0;
      if (d === 0) {
        void t;
        // still refresh the readouts once so a paused frame shows real numbers
        fps = 0;
      } else {
        clock += d;
        fps += (1 / d - fps) * 0.08;
      }

      // 1. flight model
      stepFlight(state, d, input.steer);

      // 2. visual attitude
      plane.group.position.set(state.pos.x, state.pos.y, state.pos.z);
      plane.setYaw(state.yaw);
      plane.setPitch(state.pitch);
      plane.setBank(state.bank);

      // 3. wingtips for the contrails (analytic: no matrix update, no allocation)
      const speed01 = clamp((state.speed - FLIGHT.MIN_SPEED) / (FLIGHT.MAX_SPEED - FLIGHT.MIN_SPEED), 0, 1);
      const cy = Math.cos(state.yaw);
      const sy = Math.sin(state.yaw);
      const fx = -sy;
      const fz = -cy;
      const rx = cy;
      const rz = -sy;
      const spanHalf = 4.9;
      leftTip.x = state.pos.x - rx * spanHalf + fx * -0.1;
      leftTip.y = state.pos.y - 0.25;
      leftTip.z = state.pos.z - rz * spanHalf + fz * -0.1;
      rightTip.x = state.pos.x + rx * spanHalf + fx * -0.1;
      rightTip.y = state.pos.y - 0.25;
      rightTip.z = state.pos.z + rz * spanHalf + fz * -0.1;

      // 3.5 director: camera tuning deltas + edge-triggered trauma, ahead of
      // feel.update so a hit lands on this frame's shake instead of the next one.
      const dive01 = clamp(-_fwd.y * 2, 0, 1);
      const directed = director.update(d, {
        speed01,
        bank: state.bank,
        stall01: state.stall,
        inCloud01: 0, // wired when Task 10 lands the cloud slab
        dive01,
      });
      rig.setTuning({
        fovKick: Math.min(CAM_FOV_KICK, DIRECTOR.FOV_BASE + directed.fovExtra),
        bankFollow: directed.bankFollow,
      });
      feel.addTrauma(directed.traumaHit);

      // 4. feel (contrails + shake) with the plane already moved
      feel.update(d, { speed01, bank: state.bank, stall01: state.stall, leftTip, rightTip });

      // 5. camera last: it must follow the finished pose, not a stale one
      pose.pos = state.pos;
      flightForward(state.yaw, state.pitch, pose.forward);
      pose.bank = state.bank;
      pose.speed01 = speed01;
      rig.update(d, pose, feel.shake);

      // 6. audio + HUD readouts
      if (audio) {
        const intensity = clamp(0.2 + speed01 * 0.62 + (Math.abs(state.bank) / FLIGHT.MAX_BANK) * 0.18, 0, 1);
        if (Math.abs(intensity - lastIntensity) > 0.01) {
          lastIntensity = intensity;
          audio.setIntensity(intensity);
        }
        const nowActive = Math.abs(state.bank) > 0.42 || speed01 > 0.72;
        if (nowActive && !contrailActive) {
          audio.playSfx('whoosh');
          audio.duck(true); // sidechain: music dips under the wing buffet
          duckUntil = clock + 0.25;
        }
        contrailActive = nowActive;
        if (duckUntil > 0 && clock >= duckUntil) {
          audio.duck(false);
          duckUntil = 0;
        }
      }

      if (hud) {
        const climb = Math.sin(state.pitch) * state.speed;
        readout.speed = state.speed;
        readout.speed01 = speed01;
        readout.throttle = speed01;
        readout.bank = state.bank;
        readout.climb = climb;
        readout.stall01 = state.stall;
        readout.mode =
          state.pitch > 0.28 ? 'CLIMB' : state.pitch < -0.28 ? 'DIVE' : state.bank > 0.4 ? 'TURN R' : state.bank < -0.4 ? 'TURN L' : 'CRUISE';
        readout.fps = fps;
        const st = audio ? audio.state() : 'off';
        readout.audioState = st === 'live' ? 'AUDIO : LIVE' : st === 'blocked' ? 'AUDIO : TAP TO ENABLE' : 'AUDIO : UNAVAILABLE';
        hud.update(readout);
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unlisten();
      input?.dispose();
      rig?.dispose();
      feel?.dispose();
      hud?.dispose();
      audio?.dispose();
      plane?.dispose();
      input = null;
      rig = null;
      feel = null;
      hud = null;
      audio = null;
      plane = null;
    },
  };
}
