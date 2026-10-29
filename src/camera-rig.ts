/**
 * src/camera-rig.ts — portrait third-person chase camera: dead zone, look-ahead,
 * frame-rate-independent exponential smoothing, bank roll, speed FOV kick, and an
 * additive shake offset that rides on top of the follow (it never drives it).
 *
 * The pure math (`expAlpha`, `smoothCamera`, `deadzoneFocus`) is exported and
 * node-testable; the THREE glue lives in `initCameraRig`.
 */
import * as THREE from 'three';

/** Longest dt the smoothing will trust (a tab-switch hitch must not teleport the cam). */
export const MAX_DT = 0.1;

/**
 * Camera distance behind the plane (world units).
 *
 * Tuned for the portrait 9:16 frame, not for a 16:9 monitor: a narrow horizontal FOV
 * makes an 11.4 m wingspan read enormous, so the chase has to sit well back. 30 m at
 * a ~55 deg vertical FOV puts the wingspan at roughly half the frame width at cruise
 * (plus ~7 m of smoothing lag), which leaves the sun and sea readable around it.
 */
export const CAM_DISTANCE = 30;

/** Camera height above the plane (higher = more sky, less plane-in-frame). */
export const CAM_HEIGHT = 6.8;

/** Height above the sea the camera refuses to go below. */
export const CAM_MIN_Y = 4;

/** Half-extents (world units) of the XZ follow dead zone. */
export const CAM_DEADZONE_X = 2.4;
export const CAM_DEADZONE_Z = 3.2;

/** How far ahead of the plane the camera aims, at full speed. */
export const CAM_LOOKAHEAD = 9;

/** Exponential smoothing rates (per second). Position is lazier than aim. */
export const CAM_POS_LAMBDA = 6.5;
export const CAM_AIM_LAMBDA = 8.5;
export const CAM_FOV_LAMBDA = 4;

/** Fraction of the plane's bank the camera copies (it lags the roll). */
export const CAM_BANK_FOLLOW = 0.28;

/** Extra vertical FOV at top speed. */
export const CAM_FOV_KICK = 9;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface FlightPose {
  /** Plane world position. */
  pos: Vec3;
  /** Unit forward vector (world). */
  forward: Vec3;
  /** Signed bank angle in radians (+ = right wing down). */
  bank: number;
  /** 0..1 speed normalisation. */
  speed01: number;
}

/**
 * Frame-rate-independent smoothing factor: 1 - e^(-lambda*dt).
 * A fixed `lerp(cur, target, 0.1)` would be frame-rate dependent (floaty at 30 fps,
 * snappy at 144); this converges identically at any dt.
 */
export function expAlpha(dt: number, lambda: number): number {
  if (!Number.isFinite(dt) || dt <= 0) return 0;
  if (!Number.isFinite(lambda) || lambda <= 0) return 0;
  const a = 1 - Math.exp(-lambda * dt);
  return a < 0 ? 0 : a > 1 ? 1 : a;
}

/** Move `cur` toward `target` in place. Returns `cur` so the hot path allocates nothing. */
export function smoothCamera<T extends Vec3>(cur: T, target: Vec3, dt: number, lambda: number): T {
  const a = expAlpha(dt > MAX_DT ? MAX_DT : dt, lambda);
  if (a === 0) return cur;
  if (Number.isFinite(target.x)) cur.x += (target.x - cur.x) * a;
  if (Number.isFinite(target.y)) cur.y += (target.y - cur.y) * a;
  if (Number.isFinite(target.z)) cur.z += (target.z - cur.z) * a;
  return cur;
}

/**
 * Move the follow focus only by the amount the target has left the dead zone box,
 * so micro-movements do not nudge the camera. XZ only: altitude follows directly.
 * Mutates `focus` in place and returns it.
 */
export function deadzoneFocus(target: Vec3, focus: Vec3, halfX: number, halfZ: number): Vec3 {
  if (!Number.isFinite(target.x) || !Number.isFinite(target.z)) return focus;
  const dx = target.x - focus.x;
  const dz = target.z - focus.z;
  if (Math.abs(dx) > halfX) focus.x += Math.sign(dx) * (Math.abs(dx) - halfX);
  if (Math.abs(dz) > halfZ) focus.z += Math.sign(dz) * (Math.abs(dz) - halfZ);
  return focus;
}

export interface CameraRigHandle {
  /** Call in the late/post step, after the flight model has moved the plane. */
  update(dt: number, pose: FlightPose, shake: Vec3): void;
  /** Snap to the pose with no smoothing (boot / respawn). */
  reset(pose: FlightPose): void;
  dispose(): void;
}

export function initCameraRig(camera: THREE.PerspectiveCamera): CameraRigHandle {
  const baseFov = camera.fov;

  // Scratch objects: allocated once per rig, reused every frame.
  const focus = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const aim = new THREE.Vector3();
  const aimSmooth = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  const shakeVec = new THREE.Vector3();

  let primed = false;
  let fov = baseFov;
  let roll = 0;

  const horiz = (pose: FlightPose): number => {
    const fx = Number.isFinite(pose.forward.x) ? pose.forward.x : 0;
    const fz = Number.isFinite(pose.forward.z) ? pose.forward.z : -1;
    const len = Math.hypot(fx, fz);
    return len > 1e-4 ? len : 1;
  };

  const poseKey = (pose: FlightPose, lead: number): void => {
    const l = horiz(pose);
    const fx = (Number.isFinite(pose.forward.x) ? pose.forward.x : 0) / l;
    const fz = (Number.isFinite(pose.forward.z) ? pose.forward.z : -1) / l;
    const py = Number.isFinite(pose.pos.y) ? pose.pos.y : 0;
    // Desired position is derived from the dead-zone focus, not the raw plane
    // position, so the dead zone actually stabilises the camera.
    desired.set(focus.x - fx * CAM_DISTANCE, py + CAM_HEIGHT, focus.z - fz * CAM_DISTANCE);
    if (desired.y < CAM_MIN_Y) desired.y = CAM_MIN_Y;
    aim.set(focus.x + fx * lead, py + 0.9, focus.z + fz * lead);
  };

  const applyPose = (pose: FlightPose, shake: Vec3, dt: number): void => {
    const speed01 = Number.isFinite(pose.speed01) ? Math.min(Math.max(pose.speed01, 0), 1) : 0;
    const px = Number.isFinite(pose.pos.x) ? pose.pos.x : 0;
    const pz = Number.isFinite(pose.pos.z) ? pose.pos.z : 0;
    const py = Number.isFinite(pose.pos.y) ? pose.pos.y : 0;
    const bank = Number.isFinite(pose.bank) ? pose.bank : 0;

    if (!primed) {
      focus.set(px, 0, pz);
      primed = true;
      poseKey(pose, CAM_LOOKAHEAD * (0.35 + 0.65 * speed01));
      camPos.copy(desired);
      aimSmooth.copy(aim);
      roll = -bank * CAM_BANK_FOLLOW;
      fov = baseFov + CAM_FOV_KICK * speed01;
    } else {
      deadzoneFocus({ x: px, y: py, z: pz }, focus, CAM_DEADZONE_X, CAM_DEADZONE_Z);
      poseKey(pose, CAM_LOOKAHEAD * (0.35 + 0.65 * speed01));
      smoothCamera(camPos, desired, dt, CAM_POS_LAMBDA);
      smoothCamera(aimSmooth, aim, dt, CAM_AIM_LAMBDA);
      const a = expAlpha(Math.min(dt, MAX_DT), CAM_AIM_LAMBDA * 0.7);
      roll += (-bank * CAM_BANK_FOLLOW - roll) * a;
      const targetFov = baseFov + CAM_FOV_KICK * speed01;
      fov += (targetFov - fov) * expAlpha(Math.min(dt, MAX_DT), CAM_FOV_LAMBDA);
    }

    shakeVec.set(
      Number.isFinite(shake.x) ? shake.x : 0,
      Number.isFinite(shake.y) ? shake.y : 0,
      Number.isFinite(shake.z) ? shake.z : 0,
    );

    camera.position.set(camPos.x + shakeVec.x, camPos.y + shakeVec.y, camPos.z + shakeVec.z);
    camera.up.set(Math.sin(roll), Math.cos(roll), 0);
    camera.lookAt(aimSmooth.x + shakeVec.x * 0.35, aimSmooth.y + shakeVec.y * 0.35, aimSmooth.z + shakeVec.z * 0.35);
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  };

  return {
    update(dt: number, pose: FlightPose, shake: Vec3): void {
      applyPose(pose, shake, dt);
    },
    reset(pose: FlightPose): void {
      primed = false;
      applyPose(pose, { x: 0, y: 0, z: 0 }, 0);
    },
    dispose(): void {
      primed = false;
    },
  };
}
