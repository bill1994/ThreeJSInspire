/**
 * src/camera-rig.ts — portrait third-person chase camera: dead zone, look-ahead,
 * frame-rate-independent exponential smoothing, pitch follow, bank roll, speed FOV kick, and an
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
 * a 60 deg vertical FOV (`main.ts` base FOV, 69 deg at full `CAM_FOV_KICK`) puts the
 * wingspan at roughly half the frame width at cruise (plus ~7 m of smoothing lag), which
 * leaves the sun and the horizon readable around it.
 */
export const CAM_DISTANCE = 30;

/** Camera height above the plane (higher = more sky, less plane-in-frame). */
export const CAM_HEIGHT = 6.8;

/** Height above the y=0 plane the camera refuses to go below. */
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

/** Follow only part of the nose pitch, preserving a readable horizon. */
export const CAM_PITCH_FOLLOW = 0.42;
export const CAM_PITCH_UP_MAX = 18 * Math.PI / 180;
export const CAM_PITCH_DOWN_MAX = 22 * Math.PI / 180;
export const CAM_PITCH_LAMBDA = 4.5;
const CAM_AIM_HEIGHT = 0.9;

/** Extra vertical FOV at top speed. */
export const CAM_FOV_KICK = 9;

/**
 * The tunable camera parameters, injected so the director layer (src/director.ts)
 * can shape them per frame without owning the constants. Defaults are exactly the
 * module constants above, so an un-injected rig behaves bit-for-bit as before.
 */
export interface CameraTuning {
  /** Extra vertical FOV at top speed (rig cap: 15 — portrait default 9). */
  fovKick: number;
  /** Fraction of the plane's bank the camera copies (0..1, default 0.28). */
  bankFollow: number;
  /** Fraction of nose pitch followed; 0 disables pitch orbit. */
  pitchFollow: number;
  /** Chase distance behind the plane. */
  distance: number;
  /** Camera height above the plane. */
  height: number;
}

export const CAMERA_TUNING: CameraTuning = {
  fovKick: CAM_FOV_KICK,
  bankFollow: CAM_BANK_FOLLOW,
  pitchFollow: CAM_PITCH_FOLLOW,
  distance: CAM_DISTANCE,
  height: CAM_HEIGHT,
};

/**
 * Free-play ranges (loosened 2026-11-13 — was fovKick [0,9] / bankFollow
 * [0,0.5] / distance [12,60] / height [2,20]).
 *
 * Defaults are unchanged, so existing frames are bit-for-bit identical.
 * Wider ranges only permit freer composition — e.g. a low 6 m chase or a
 * 1.0 bank lock for acro. Portrait 9:16 framing still needs a retune of
 * distance/height together when changed; the smoothing core is untouched.
 */
export const TUNING_RANGES: Record<keyof CameraTuning, [number, number]> = {
  fovKick: [0, 15],
  bankFollow: [0, 1],
  pitchFollow: [0, 0.65],
  distance: [6, 120],
  height: [1, 40],
};

/** Clamp a partial tuning into the safe ranges; any non-finite field falls back to
 *  the default so a NaN frame cannot poison the camera. */
export function clampTuning(t: Partial<CameraTuning>): CameraTuning {
  const out = { ...CAMERA_TUNING };
  for (const key of Object.keys(TUNING_RANGES) as Array<keyof CameraTuning>) {
    const v = t[key];
    if (Number.isFinite(v)) {
      const [lo, hi] = TUNING_RANGES[key];
      out[key] = Math.min(Math.max(v as number, lo), hi);
    }
  }
  return out;
}

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
  /** Merge a partial tuning into the current one (clamped); the director calls this. */
  setTuning(t: Partial<CameraTuning>): void;
  dispose(): void;
}

export function initCameraRig(camera: THREE.PerspectiveCamera, tuning?: Partial<CameraTuning>, groundHeight?: (x:number,z:number)=>number): CameraRigHandle {
  const baseFov = camera.fov;
  let tuningNow = clampTuning(tuning ?? {});

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
  let pitch = 0;

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
    // Orbit position AND aim around the same point on the aircraft. Raising
    // only the aim would push the aircraft out of the portrait frame.
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const height = tuningNow.height - CAM_AIM_HEIGHT;
    const back = tuningNow.distance * cp + height * sp;
    desired.set(focus.x - fx * back,
      py + CAM_AIM_HEIGHT + height * cp - tuningNow.distance * sp,
      focus.z - fz * back);
    if (desired.y < CAM_MIN_Y) desired.y = CAM_MIN_Y;
    if (groundHeight) {
      // Raise the chase endpoint enough to clear each sample along the boom.
      for (let i=1;i<=8;i++) {
        const t=i/8;
        const floor=groundHeight(pose.pos.x+(desired.x-pose.pos.x)*t,pose.pos.z+(desired.z-pose.pos.z)*t)+3;
        if (floor>py+(desired.y-py)*t) desired.y=py+(floor-py)/t;
      }
    }
    aim.set(focus.x + fx * lead * cp, py + CAM_AIM_HEIGHT + lead * sp, focus.z + fz * lead * cp);
  };

  const applyPose = (pose: FlightPose, shake: Vec3, dt: number): void => {
    const speed01 = Number.isFinite(pose.speed01) ? Math.min(Math.max(pose.speed01, 0), 1) : 0;
    const px = Number.isFinite(pose.pos.x) ? pose.pos.x : 0;
    const pz = Number.isFinite(pose.pos.z) ? pose.pos.z : 0;
    const py = Number.isFinite(pose.pos.y) ? pose.pos.y : 0;
    const bank = Number.isFinite(pose.bank) ? pose.bank : 0;
    const fy = Number.isFinite(pose.forward.y) ? pose.forward.y : 0;
    const targetPitch = Math.max(-CAM_PITCH_DOWN_MAX,
      Math.min(CAM_PITCH_UP_MAX, Math.atan2(fy, horiz(pose)) * tuningNow.pitchFollow));

    if (!primed) {
      focus.set(px, 0, pz);
      primed = true;
      pitch = targetPitch;
      poseKey(pose, CAM_LOOKAHEAD * (0.35 + 0.65 * speed01));
      camPos.copy(desired);
      aimSmooth.copy(aim);
      roll = -bank * tuningNow.bankFollow;
      fov = baseFov + tuningNow.fovKick * speed01;
    } else {
      pitch += (targetPitch - pitch) * expAlpha(Math.min(dt, MAX_DT), CAM_PITCH_LAMBDA);
      deadzoneFocus({ x: px, y: py, z: pz }, focus, CAM_DEADZONE_X, CAM_DEADZONE_Z);
      poseKey(pose, CAM_LOOKAHEAD * (0.35 + 0.65 * speed01));
      smoothCamera(camPos, desired, dt, CAM_POS_LAMBDA);
      smoothCamera(aimSmooth, aim, dt, CAM_AIM_LAMBDA);
      const a = expAlpha(Math.min(dt, MAX_DT), CAM_AIM_LAMBDA * 0.7);
      roll += (-bank * tuningNow.bankFollow - roll) * a;
      const targetFov = baseFov + tuningNow.fovKick * speed01;
      fov += (targetFov - fov) * expAlpha(Math.min(dt, MAX_DT), CAM_FOV_LAMBDA);
    }

    shakeVec.set(
      Number.isFinite(shake.x) ? shake.x : 0,
      Number.isFinite(shake.y) ? shake.y : 0,
      Number.isFinite(shake.z) ? shake.z : 0,
    );

    camera.position.set(camPos.x + shakeVec.x, Math.max(CAM_MIN_Y, camPos.y + shakeVec.y), camPos.z + shakeVec.z);
    if (groundHeight) {
      const floor=groundHeight(camera.position.x,camera.position.z)+2;
      camera.position.y=Math.max(camera.position.y,floor);
      camPos.y=Math.max(camPos.y,floor);
    }
    camera.up.set(0, 1, 0);
    camera.lookAt(aimSmooth.x + shakeVec.x * 0.35, aimSmooth.y + shakeVec.y * 0.35, aimSmooth.z + shakeVec.z * 0.35);
    // Roll around the view axis. A world-XY up vector lost/inverted the bank
    // response as the aircraft turned through east/west and opposite headings.
    camera.rotateZ(-roll);
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
    setTuning(t: Partial<CameraTuning>): void {
      tuningNow = clampTuning({ ...tuningNow, ...t });
    },
    dispose(): void {
      primed = false;
    },
  };
}
