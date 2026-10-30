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
import { skim01, waterHit01 } from './skim';
import { inCloud01, whiteout01 } from './in-cloud';
import { initSubtitles, createCues } from './subtitles';
import { portraitAspect } from './portrait';

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
  /** Airspeed of a comfortable cruise — the reference the energy model balances at. */
  MIN_SPEED: 34,
  MAX_SPEED: 78,
  CRUISE_SPEED: 46,
  /** Speed gained per m/s of sink (and lost per m/s of climb). */
  DIVE_GAIN: 16,
  /**
   * Airspeed (m/s) below which the aircraft has no control authority: the apex hang
   * fires here, and free fall only hands the stick back once the dive rebuilds it.
   */
  STALL_SPEED: 22,
  /** m/s² of engine thrust, and the quadratic drag that balances it at CRUISE_SPEED. */
  THRUST: 6,
  /** THRUST / CRUISE_SPEED² — kept literal so it stays a compile-time constant. */
  DRAG_K: 6 / (46 * 46),
  /** Seconds the aircraft hangs at the apex before gravity takes over. */
  HOVER_HOLD: 0.5,
  /** Real-time hit-stop (s) on hover entry — the "top of the zoom climb" beat. */
  HOVER_FREEZE: 0.08,
  /** Nose-up attitude the apex needs before it counts as a zoom climb. */
  HOVER_PITCH: 0.25,
  /** Seconds of real flight required before another apex may fire. */
  APEX_COOLDOWN: 1.2,
  /** Camera trauma on the apex (importance tier: medium). */
  APEX_TRAUMA: 0.3,
  /** Pitch the nose falls to in free fall, the sink cap, and the recovery floor. */
  FALL_PITCH: -1.1,
  FALL_MAX_SINK: 32,
  FALL_MIN_AIRSPEED: 6,
  /** How fast the fall rebuilds airspeed (1/s). */
  FALL_SPEED_ATTACK: 2.2,
  /** Nose-up attitude the water catch pulls to before letting go. */
  WATER_PULLUP_PITCH: 0.12,
  /** Camera trauma for a full-severity water contact (importance tier: small/medium). */
  WATER_TRAUMA: 0.35,
  ALT_MIN: 6,
  ALT_MAX: 240,
  START_Y: 60,
} as const;

/** Where the aircraft is in the zoom-climb beat (see `stepFlight`). */
export type FlightPhase = 'cruise' | 'hover' | 'fall';

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
  /** Cruise, hanging at the apex, or in free fall. */
  phase: FlightPhase;
  /** Extra vertical speed (m/s, + up) carried while hovering or falling. 0 in cruise. */
  vy: number;
  /** Seconds left of the apex hang. */
  hoverT: number;
  /** Seconds left of the hit-stop; while > 0 the airframe does not advance. */
  freeze: number;
  /** 0..1 deck-skim amount (see skim.ts), written every step. */
  skim: number;
  /** Seconds before another apex hover may fire. */
  apexCooldown: number;
  /** 0..1 severity of a water contact this step; decays to 0 on the next one. */
  waterHit: number;
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

/** 3t² - 2t³, ends pinned so the curve leaves 0 and 1 horizontally. */
function smoothstep01(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

export function createFlightState(): FlightState {
  return {
    pos: { x: 0, y: FLIGHT.START_Y, z: 0 },
    yaw: 0,
    pitch: 0,
    bank: 0,
    speed: FLIGHT.CRUISE_SPEED,
    stall: 0,
    phase: 'cruise',
    vy: 0,
    hoverT: 0,
    freeze: 0,
    skim: 0,
    apexCooldown: 0,
    waterHit: 0,
  };
}

const _fwd: Vec3 = { x: 0, y: 0, z: -1 };

/**
 * Advance the flight model one clamped step, in place.
 *
 * Input convention (one `steer` action for pointer and touch): x = + right, y = + drag
 * down. Drag up (y < 0) climbs, drag down (y > 0) dives, drag right banks right.
 *
 * Three phases make the zoom climb a beat rather than an instant:
 * `cruise` → `hover` (out of airspeed with the nose up: hang, hit-stop, then gravity)
 * → `fall` (nose drops, sink accelerates, airspeed rebuilds) → back to `cruise`.
 */
export function stepFlight(state: FlightState, dt: number, input: SteerLike): FlightState {
  const d = Number.isFinite(dt) && dt > 0 ? Math.min(dt, FLIGHT.DT_CLAMP) : 0;
  if (d === 0) return state;

  // Hit-stop: a real-time pause on the airframe only (never on the game clock), so the
  // apex reads as an impact instead of a slide. Juice must return to rest by itself.
  if (state.freeze > 0) {
    state.freeze = Math.max(0, state.freeze - d);
    return state;
  }

  const sx = clamp(finite(input?.x, 0), -1, 1);
  const sy = clamp(finite(input?.y, 0), -1, 1);

  state.apexCooldown = Math.max(0, finite(state.apexCooldown, 0) - d);
  state.waterHit = 0;
  // Sampled before the move: the skim floor uses the altitude the plane is already at.
  state.skim = skim01(finite(state.pos.y, FLIGHT.START_Y), state.pitch);

  if (state.phase === 'hover') stepHover(state, d);
  else if (state.phase === 'fall') stepFall(state, d, sy);
  else stepCruise(state, d, sx, sy);

  state.skim = skim01(finite(state.pos.y, FLIGHT.START_Y), state.pitch);
  return state;
}

function stepCruise(state: FlightState, d: number, sx: number, sy: number): FlightState {
  // attitude: bank from horizontal drag, pitch from vertical drag (inverted: up climbs)
  const bankTarget = FLIGHT.MAX_BANK * sx;
  const pitchTarget = -FLIGHT.MAX_PITCH * sy;
  state.bank += (bankTarget - state.bank) * attack(d, FLIGHT.BANK_ATTACK);
  state.pitch += (pitchTarget - state.pitch) * attack(d, FLIGHT.PITCH_ATTACK);
  state.bank = clamp(state.bank, -FLIGHT.MAX_BANK, FLIGHT.MAX_BANK);
  state.pitch = clamp(state.pitch, -FLIGHT.MAX_PITCH, FLIGHT.MAX_PITCH);

  // yaw: positive bank = right wing down = right turn = yaw decreases
  state.yaw = wrapAngle(state.yaw - FLIGHT.TURN_RATE * Math.sin(state.bank) * d);

  // Stylised stall (see stall.ts): nose up + no airspeed presses the nose down. It must
  // not press the whole forward vector down — that flipped _fwd.y negative at stall >
  // 0.62 and flew a pinned back-stick into the sea. Lowering pitch feeds back into
  // stall01 next frame: the same self-limiting loop without betraying the control.
  const stallSpeed01 = clamp((state.speed - FLIGHT.MIN_SPEED) / (FLIGHT.MAX_SPEED - FLIGHT.MIN_SPEED), 0, 1);
  const stall = stall01(state.pitch, stallSpeed01);
  state.stall = stall;
  if (stall > 0) state.pitch = Math.max(0, state.pitch - STALL.NOSE_DROP * stall * d);

  // Energy: thrust, quadratic drag, the component of gravity along the nose, and the
  // wing's own stall drag. This is what lets a zoom climb genuinely run out of
  // airspeed instead of easing toward a clamped floor.
  const v = Math.max(0, finite(state.speed, FLIGHT.CRUISE_SPEED));
  const accel =
    FLIGHT.THRUST - FLIGHT.DRAG_K * v * v - STALL.G_SINK * Math.sin(state.pitch) - STALL.DRAG * stall;
  state.speed = clamp(v + accel * d, 0, FLIGHT.MAX_SPEED);

  // The apex: out of airspeed with the nose still up. Not tied to ALT_MAX — the energy
  // model now bleeds speed below the ceiling, so the top of a zoom climb can be anywhere.
  if (state.speed < FLIGHT.STALL_SPEED && state.pitch > FLIGHT.HOVER_PITCH && state.apexCooldown <= 0) {
    enterHover(state);
    return state;
  }

  integrate(state, d);
  return state;
}

function enterHover(state: FlightState): void {
  state.phase = 'hover';
  state.speed = 0;
  state.vy = 0;
  state.hoverT = FLIGHT.HOVER_HOLD;
  state.freeze = FLIGHT.HOVER_FREEZE;
  state.apexCooldown = FLIGHT.APEX_COOLDOWN;
  state.stall = 1;
}

/** Hang at the apex: attitude and position hold, the stick is dead, then gravity wins. */
function stepHover(state: FlightState, d: number): FlightState {
  state.speed = 0;
  state.vy = 0;
  state.stall = 1;
  state.hoverT = Math.max(0, finite(state.hoverT, 0) - d);
  if (state.hoverT <= 0) state.phase = 'fall';
  return state;
}

/** Free fall: the nose drops on its own, the sink accelerates, the dive rebuilds speed. */
function stepFall(state: FlightState, d: number, sy: number): FlightState {
  state.vy = Math.max(finite(state.vy, 0) - STALL.G_SINK * d, -FLIGHT.FALL_MAX_SINK);

  // Control authority is gated on airspeed, not blended in from zero: while the wing
  // is dead the player's back-stick must not be able to hold the nose up.
  const authority = smoothstep01(
    (state.speed - FLIGHT.STALL_SPEED * 0.6) / (FLIGHT.STALL_SPEED * 0.4),
  );
  const playerPitch = -FLIGHT.MAX_PITCH * sy;
  const pitchTarget = FLIGHT.FALL_PITCH + (playerPitch - FLIGHT.FALL_PITCH) * authority;
  state.pitch += (pitchTarget - state.pitch) * attack(d, FLIGHT.PITCH_ATTACK * 0.6);
  state.pitch = clamp(state.pitch, -FLIGHT.MAX_PITCH, FLIGHT.MAX_PITCH);
  state.bank += (0 - state.bank) * attack(d, FLIGHT.BANK_ATTACK * 0.5);
  state.yaw = wrapAngle(state.yaw - FLIGHT.TURN_RATE * Math.sin(state.bank) * d);

  // The developing dive is what rebuilds airspeed — you have to fall to fly again.
  const dive = -state.vy * Math.max(0, -Math.sin(state.pitch));
  const speedTarget = Math.min(FLIGHT.MAX_SPEED, dive + FLIGHT.FALL_MIN_AIRSPEED);
  state.speed += (speedTarget - state.speed) * attack(d, FLIGHT.FALL_SPEED_ATTACK);
  state.speed = clamp(finite(state.speed, 0), 0, FLIGHT.MAX_SPEED);

  const stallSpeed01 = clamp((state.speed - FLIGHT.MIN_SPEED) / (FLIGHT.MAX_SPEED - FLIGHT.MIN_SPEED), 0, 1);
  state.stall = stall01(state.pitch, stallSpeed01);

  if (state.speed >= FLIGHT.STALL_SPEED) {
    state.phase = 'cruise';
    state.vy = 0;
    // Real flight before the next apex, or a pinned back-stick would chain hangs.
    state.apexCooldown = FLIGHT.APEX_COOLDOWN;
  }

  integrate(state, d);
  return state;
}

/**
 * Move the aircraft, then resolve the two altitude boundaries.
 *
 * Ceiling: soft. The plane slides along ALT_MAX and its climb is simply spent — the
 * attitude is left alone so the stick is never fought. Deck: the skim floor rises as
 * the plane settles onto the water; a steep or fast contact is a hit, and even a hit
 * only pulls the nose up gently (no penalty, no respawn).
 */
function integrate(state: FlightState, d: number): void {
  flightForward(state.yaw, state.pitch, _fwd);
  const adv = state.speed * d;
  const sink = -(_fwd.y * state.speed + state.vy);
  state.pos.x = finite(state.pos.x, 0) + _fwd.x * adv;
  state.pos.z = finite(state.pos.z, 0) + _fwd.z * adv;
  state.pos.y = finite(state.pos.y, FLIGHT.START_Y) + _fwd.y * adv + state.vy * d;

  if (state.pos.y > FLIGHT.ALT_MAX) {
    state.pos.y = FLIGHT.ALT_MAX;
    if (state.vy > 0) state.vy = 0;
  }

  const floorY = FLIGHT.ALT_MIN + state.skim;
  if (state.pos.y <= floorY) {
    state.pos.y = floorY;
    state.vy = 0;
    const impact = waterHit01(state.pos.y, state.pitch, sink);
    if (impact > 0) {
      state.waterHit = impact;
      state.pitch = Math.max(state.pitch, FLIGHT.WATER_PULLUP_PITCH);
      state.speed = Math.max(state.speed, FLIGHT.STALL_SPEED);
      state.phase = 'cruise';
      state.apexCooldown = FLIGHT.APEX_COOLDOWN;
    } else if (state.phase === 'fall') {
      state.phase = 'cruise';
      state.speed = Math.max(state.speed, FLIGHT.STALL_SPEED);
      state.apexCooldown = FLIGHT.APEX_COOLDOWN;
    }
  }
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
  let subs: ReturnType<typeof initSubtitles> | null = null;
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
    try {
      subs = hud ? initSubtitles(hud.element) : null;
    } catch (err) {
      console.warn('[porco] subtitles unavailable');
      void err;
      subs = null;
    }
  } catch (err) {
    console.error('[porco] initGame failed to mount', err);
    return noopHandles();
  }

  const state = createFlightState();
  const director = createDirector();
  const cues = createCues();
  let takeoffShown = false;
  const pose: FlightPose = { pos: state.pos, forward: { x: 0, y: 0, z: -1 }, bank: 0, speed01: 0 };
  const readout: HudReadout = defaultHudReadout();
  const leftTip = { x: 0, y: 0, z: 0 };
  const rightTip = { x: 0, y: 0, z: 0 };

  let fps = 60;
  let lastIntensity = -1;
  let duckUntil = 0;
  let contrailActive = false;
  let clock = 0;
  let lastStall01 = 0;
  let lastDive01 = 0;
  let lastCloud01 = 0;
  let lastPhase: FlightPhase = 'cruise';

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
    // The #frame box in index.html keeps the buffer at (or narrower than) 9:16, so
    // portraitAspect only fires as a degenerate-frustum safety net: a hostile buffer
    // wider than the story frame clamps instead of stretching the image. NaN/0 sizes
    // fall back to 9:16.
    const aspect = portraitAspect(w, h);
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
        // last frame's rig output (the rig runs later in the update) — one frame
        // of lag is invisible on an edge detector
        inCloud01: inCloud01(camera.position.y),
        dive01,
      });
      rig.setTuning({
        fovKick: Math.min(CAM_FOV_KICK, DIRECTOR.FOV_BASE + directed.fovExtra),
        bankFollow: directed.bankFollow,
      });
      feel.addTrauma(directed.traumaHit);
      // Batch A beats. The apex is a *beat*, not a crash, so it gets the medium tier;
      // a water contact scales with how hard it actually was. Both ride the camera
      // offset, never the simulated transform.
      if (state.phase === 'hover' && lastPhase !== 'hover') feel.addTrauma(FLIGHT.APEX_TRAUMA);
      if (state.waterHit > 0) feel.addTrauma(state.waterHit * FLIGHT.WATER_TRAUMA);
      lastPhase = state.phase;

      // 4. feel (contrails + skim wake + shake) with the plane already moved
      feel.update(d, {
        speed01,
        bank: state.bank,
        stall01: state.stall,
        skim01: state.skim,
        leftTip,
        rightTip,
      });

      // 5. camera last: it must follow the finished pose, not a stale one
      pose.pos = state.pos;
      flightForward(state.yaw, state.pitch, pose.forward);
      pose.bank = state.bank;
      pose.speed01 = speed01;
      rig.update(d, pose, feel.shake);

      // 5.5 whiteout: the camera's own altitude, read after the rig has moved it.
      // Lives here rather than main.ts because the HUD handle is game-internal and
      // the camera is what the rig actually placed this frame.
      const camCloud01 = inCloud01(camera.position.y);
      hud?.setWhiteout(whiteout01(camera.position.y));

      // 5.6 subtitles: one shot per cue, edges read off the same state the HUD shows.
      if (subs) {
        const sub = subs;
        const showCue = (cue: string): void => {
          const id = cues.nextLine(cue);
          if (id) {
            sub.show(id);
            audio?.pulse('line');
          }
        };
        if (!takeoffShown) {
          takeoffShown = true;
          showCue('takeoff');
        }
        if (state.stall > 0.5) showCue('stall');
        if (camCloud01 > 0.5) showCue('cloud');
        if (state.pos.y <= FLIGHT.ALT_MIN + 6) showCue('low');
        if (dive01 > 0.6) showCue('dive');
        subs.update(d);
      }

      // 6. audio + HUD readouts
      if (audio) {
        const intensity = clamp(
          0.2 + speed01 * 0.62 + (Math.abs(state.bank) / FLIGHT.MAX_BANK) * 0.18 + state.skim * 0.12,
          0,
          1,
        );
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
        // gameplay pulses: one shot per threshold crossing, only while live
        if (audio.state() === 'live') {
          if (state.stall > 0.5 && lastStall01 <= 0.5) {
            audio.pulse('stall');
            duckUntil = clock + 0.25; // the existing duck scheduler releases it
          }
          if (dive01 > 0.6 && lastDive01 <= 0.6) audio.pulse('dive');
          if (camCloud01 > 0.5 && lastCloud01 <= 0.5) audio.pulse('cloud');
          if (state.waterHit > 0) audio.pulse('water');
        }
        lastStall01 = state.stall;
        lastDive01 = dive01;
        lastCloud01 = camCloud01;
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
          state.phase === 'hover'
            ? 'HOVER'
            : state.phase === 'fall'
              ? 'FALL'
              : state.skim > 0.5
                ? 'SKIM'
                : state.pitch > 0.28
                  ? 'CLIMB'
                  : state.pitch < -0.28
                    ? 'DIVE'
                    : state.bank > 0.4
                      ? 'TURN R'
                      : state.bank < -0.4
                        ? 'TURN L'
                        : 'CRUISE';
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
      subs?.dispose();
      audio?.dispose();
      plane?.dispose();
      input = null;
      rig = null;
      feel = null;
      hud = null;
      subs = null;
      audio = null;
      plane = null;
    },
  };
}
