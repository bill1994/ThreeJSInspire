import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createFlightState, flightForward, stepFlight, FLIGHT } from './game';
import { smoothCamera, deadzoneFocus, expAlpha, initCameraRig, CAM_MIN_Y, type FlightPose, type Vec3 } from './camera-rig';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

const flightPose = (pitch = 0, altitude = 60): FlightPose => ({
  pos: v(0, altitude, 0), forward: v(0, Math.sin(pitch), -Math.cos(pitch)),
  bank: 0, speed01: 0.5,
});
const viewPitch = (camera: THREE.PerspectiveCamera): number =>
  Math.asin(camera.getWorldDirection(new THREE.Vector3()).y);
const screenPlane = (camera: THREE.PerspectiveCamera, pose: FlightPose): THREE.Vector3 => {
  camera.updateMatrixWorld();
  return new THREE.Vector3(pose.pos.x, pose.pos.y, pose.pos.z).project(camera);
};

describe('chase pitch', () => {
  it('looks up in a climb and down in a dive while keeping the plane framed', () => {
    const camera = new THREE.PerspectiveCamera(60, 9 / 16, 0.1, 10000);
    const rig = initCameraRig(camera);
    rig.reset(flightPose());
    const level = viewPitch(camera);
    const levelScreen = screenPlane(camera, flightPose()).y;
    for (const pitch of [0.7, -0.7]) {
      const pose = flightPose(pitch);
      rig.reset(pose);
      const delta = viewPitch(camera) - level;
      expect(delta * Math.sign(pitch)).toBeGreaterThan(0.2);
      expect(Math.abs(delta)).toBeLessThan(0.4);
      expect(Math.abs(screenPlane(camera, pose).y - levelScreen)).toBeLessThan(0.025);
    }
  });

  it('eases into pitch and returns to level after releasing the stick', () => {
    const camera = new THREE.PerspectiveCamera(60, 9 / 16);
    const rig = initCameraRig(camera);
    rig.reset(flightPose());
    const level = viewPitch(camera);
    rig.update(1 / 60, flightPose(0.7), v(0, 0, 0));
    const first = viewPitch(camera);
    for (let i = 0; i < 180; i++) rig.update(1 / 60, flightPose(0.7), v(0, 0, 0));
    const settled = viewPitch(camera);
    expect(first).toBeGreaterThan(level);
    expect(first - level).toBeLessThan((settled - level) * 0.1);
    for (let i = 0; i < 240; i++) rig.update(1 / 60, flightPose(), v(0, 0, 0));
    expect(viewPitch(camera)).toBeCloseTo(level, 5);
  });

  it('keeps the camera above water and the plane in frame through low flight reversals', () => {
    const camera = new THREE.PerspectiveCamera(60, 9 / 16);
    const rig = initCameraRig(camera);
    rig.reset(flightPose(0, 6));
    for (const pitch of [1.2, -1.2, 0, 1.2]) {
      const pose = flightPose(pitch, 6);
      for (let i = 0; i < 90; i++) {
        rig.update(1 / 60, pose, v(0, -0.2, 0));
        const screen = screenPlane(camera, pose);
        expect(camera.position.y).toBeGreaterThanOrEqual(CAM_MIN_Y);
        expect(Math.abs(screen.y)).toBeLessThan(0.5);
        expect(screen.z).toBeLessThan(1);
      }
    }
  });

  it('gives similar pitch response at 30 and 120 fps', () => {
    const angles = [30, 120].map(fps => {
      const camera = new THREE.PerspectiveCamera();
      const rig = initCameraRig(camera);
      rig.reset(flightPose());
      for (let i = 0; i < fps; i++) rig.update(1 / fps, flightPose(0.6), v(0, 0, 0));
      return viewPitch(camera);
    });
    expect(Math.abs(angles[0] - angles[1])).toBeLessThan(0.005);
  });

  it('resets pitch history on respawn and tolerates a malformed forward vector', () => {
    const camera = new THREE.PerspectiveCamera();
    const rig = initCameraRig(camera);
    rig.reset(flightPose());
    const initial = camera.quaternion.clone();
    rig.reset(flightPose(-1.2));
    rig.reset(flightPose());
    expect(camera.quaternion.angleTo(initial)).toBeLessThan(1e-6);
    const pose = flightPose();
    pose.forward.y = Number.NaN;
    rig.update(1 / 60, pose, v(0, 0, 0));
    expect(camera.quaternion.toArray().every(Number.isFinite)).toBe(true);
  });

  it('keeps a moving aircraft framed through climb, release, dive and banking', () => {
    const camera = new THREE.PerspectiveCamera(60, 9 / 16);
    const rig = initCameraRig(camera);
    const state = createFlightState(60);
    const pose = flightPose();
    pose.pos = state.pos;
    rig.reset(pose);
    const sequence = [
      { x: 0, y: -0.7 }, { x: 0, y: 0 }, { x: 0, y: 0.7 },
      { x: 0.8, y: -0.3 }, { x: -0.8, y: 0.3 }, { x: 0, y: 0 },
    ];
    for (const input of sequence) {
      for (let i = 0; i < 180; i++) {
        stepFlight(state, 1 / 60, input);
        flightForward(state.yaw, state.pitch, pose.forward);
        pose.bank = state.bank;
        pose.speed01 = (state.speed - FLIGHT.MIN_SPEED) / (FLIGHT.MAX_SPEED - FLIGHT.MIN_SPEED);
        rig.update(1 / 60, pose, v(0, 0, 0));
        const screen = screenPlane(camera, pose);
        expect(Math.abs(screen.x)).toBeLessThan(0.65);
        expect(Math.abs(screen.y)).toBeLessThan(0.5);
        expect(screen.z).toBeLessThan(1);
        expect(camera.position.y).toBeGreaterThanOrEqual(CAM_MIN_Y);
      }
    }
  });

  it('keeps bank feedback identical at every heading, including pitched views', () => {
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const pose = flightPose(0.6);
      flightForward(yaw, 0.6, pose.forward);
      const level = new THREE.PerspectiveCamera();
      const banked = new THREE.PerspectiveCamera();
      initCameraRig(level).reset(pose);
      pose.bank = 0.8;
      initCameraRig(banked).reset(pose);
      const delta = level.quaternion.clone().invert().multiply(banked.quaternion);
      expect(Math.abs(delta.x)).toBeLessThan(1e-6);
      expect(Math.abs(delta.y)).toBeLessThan(1e-6);
      expect(2 * Math.atan2(delta.z, delta.w)).toBeCloseTo(0.8 * 0.28, 6);
    }
  });
});

describe('expAlpha', () => {
  it('is 0 for dt=0 and never leaves [0,1]', () => {
    expect(expAlpha(0, 8)).toBe(0);
    expect(expAlpha(0.016, 8)).toBeGreaterThan(0);
    expect(expAlpha(0.016, 8)).toBeLessThan(1);
    expect(expAlpha(10, 8)).toBeLessThanOrEqual(1);
    expect(expAlpha(10, 8)).toBeGreaterThan(0.99);
  });

  it('sanitizes NaN / negative dt and non-positive lambda', () => {
    expect(expAlpha(Number.NaN, 8)).toBe(0);
    expect(expAlpha(-1, 8)).toBe(0);
    expect(expAlpha(0.016, 0)).toBe(0);
    expect(expAlpha(0.016, Number.NaN)).toBe(0);
  });
});

describe('smoothCamera', () => {
  it('holds position when dt is 0', () => {
    const cur = v(0, 0, 0);
    smoothCamera(cur, v(10, 5, -10), 0, 6);
    expect(cur).toEqual(v(0, 0, 0));
  });

  it('eases toward the target without overshooting', () => {
    const cur = v(0, 0, 0);
    const target = v(10, 4, -2);
    smoothCamera(cur, target, 1 / 60, 6);
    expect(cur.x).toBeGreaterThan(0);
    expect(cur.x).toBeLessThan(10);
    expect(cur.y).toBeGreaterThan(0);
    expect(cur.y).toBeLessThan(4);
  });

  it('is frame-rate independent (exponential, not a fixed per-frame lerp)', () => {
    const a = v(0, 0, 0);
    smoothCamera(a, v(10, 0, 0), 0.1, 5);
    const b = v(0, 0, 0);
    for (let i = 0; i < 10; i += 1) smoothCamera(b, v(10, 0, 0), 0.01, 5);
    expect(Math.abs(a.x - b.x)).toBeLessThan(1e-9);
  });

  it('stays finite when the target carries NaN or Infinity', () => {
    const cur = v(1, 2, 3);
    smoothCamera(cur, v(Number.NaN, 0, 0), 1 / 60, 6);
    expect(Number.isFinite(cur.x)).toBe(true);
    expect(Number.isFinite(cur.y)).toBe(true);
    expect(Number.isFinite(cur.z)).toBe(true);
    const cur2 = v(1, 2, 3);
    smoothCamera(cur2, v(Number.POSITIVE_INFINITY, -1, 0), 1 / 60, 6);
    expect([cur2.x, cur2.y, cur2.z].every((n) => Number.isFinite(n))).toBe(true);
  });

  it('clamps a pathological dt instead of teleporting or exploding', () => {
    const cur = v(0, 0, 0);
    smoothCamera(cur, v(100, 0, 0), 5, 6);
    expect(cur.x).toBeGreaterThan(0);
    expect(cur.x).toBeLessThanOrEqual(100);
    expect([cur.x, cur.y, cur.z].every((n) => Number.isFinite(n))).toBe(true);
  });
});

describe('deadzoneFocus', () => {
  it('ignores target movement inside the dead zone box', () => {
    const focus = v(0, 0, 0);
    deadzoneFocus(v(1.5, 0, -1.2), focus, 2, 2);
    expect(focus).toEqual(v(0, 0, 0));
  });

  it('follows only the overflow beyond the dead zone', () => {
    const focus = v(0, 0, 0);
    deadzoneFocus(v(5, 0, 0), focus, 2, 2);
    expect(focus.x).toBeCloseTo(3, 10);
  });

  it('keeps the focus fixed instead of NaN on a non-finite target', () => {
    const focus = v(1, 0, 1);
    deadzoneFocus(v(Number.NaN, 0, 0), focus, 2, 2);
    expect(focus).toEqual(v(1, 0, 1));
  });
});
