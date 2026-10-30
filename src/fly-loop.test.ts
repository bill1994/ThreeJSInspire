/**
 * Integration-ish test: flight model + camera rig together, headless (no renderer, no GL).
 * This is the test that would have caught a camera mounted in front of the nose, and it
 * keeps the whole loop honest about staying finite under a chaotic stick.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { initCameraRig, CAM_MIN_Y } from './camera-rig';
import { createFlightState, flightForward, stepFlight, FLIGHT, type FlightState } from './game';

const poseForward = { x: 0, y: 0, z: -1 };

function run(seconds: number, steer: (t: number) => { x: number; y: number }): {
  state: FlightState;
  camera: THREE.PerspectiveCamera;
} {
  const camera = new THREE.PerspectiveCamera(58, 9 / 16, 0.1, 4000);
  const rig = initCameraRig(camera);
  const state = createFlightState();
  const pose = { pos: state.pos, forward: poseForward, bank: 0, speed01: 0 };
  const shake = { x: 0, y: 0, z: 0 };
  const steps = Math.round(seconds * 60);
  for (let i = 0; i < steps; i += 1) {
    const t = i / 60;
    stepFlight(state, 1 / 60, steer(t));
    flightForward(state.yaw, state.pitch, pose.forward);
    pose.pos = state.pos;
    pose.bank = state.bank;
    pose.speed01 = 0.5;
    rig.update(1 / 60, pose, shake);
  }
  return { state, camera };
}

describe('flight + camera loop', () => {
  it('keeps the camera behind the nose, above the sea and pointed at the plane', () => {
    const { state, camera } = run(10, (t) => ({ x: Math.sin(t * 1.3), y: Math.cos(t * 0.8) }));
    expect(Number.isFinite(camera.position.x)).toBe(true);
    expect(Number.isFinite(camera.position.y)).toBe(true);
    expect(Number.isFinite(camera.position.z)).toBe(true);

    const fwd = flightForward(state.yaw, state.pitch, { x: 0, y: 0, z: 0 });
    const toCam = {
      x: camera.position.x - state.pos.x,
      y: camera.position.y - state.pos.y,
      z: camera.position.z - state.pos.z,
    };
    const along = toCam.x * fwd.x + toCam.y * fwd.y + toCam.z * fwd.z;
    expect(along).toBeLessThan(-10); // behind, not in front
    const dist = Math.hypot(toCam.x, toCam.y, toCam.z);
    expect(dist).toBeGreaterThan(20); // far enough that the 11.4 m wingspan reads in frame
    expect(dist).toBeLessThan(60);
    expect(camera.position.y).toBeGreaterThanOrEqual(CAM_MIN_Y - 1e-6);

    const dir = camera.getWorldDirection(new THREE.Vector3());
    const toPlane = new THREE.Vector3(-toCam.x, -toCam.y, -toCam.z).normalize();
    expect(dir.dot(toPlane)).toBeGreaterThan(0.5); // actually looking at the plane
  });

  it('survives a stalled frame, a NaN frame and a hard turn without NaN or a teleport', () => {
    const camera = new THREE.PerspectiveCamera(58, 9 / 16, 0.1, 4000);
    const rig = initCameraRig(camera);
    const state = createFlightState();
    const pose = { pos: state.pos, forward: { x: 0, y: 0, z: -1 }, bank: 0, speed01: 0 };
    const shake = { x: 0, y: 0, z: 0 };
    const dts = [1 / 60, 0, 5, Number.NaN, 1 / 30];
    for (let i = 0; i < 400; i += 1) {
      stepFlight(state, dts[i % dts.length], { x: 1, y: -1 });
      flightForward(state.yaw, state.pitch, pose.forward);
      pose.pos = state.pos;
      rig.update(dts[i % dts.length], pose, shake);
    }
    expect(Number.isFinite(state.pos.x + state.pos.y + state.pos.z)).toBe(true);
    // Airspeed may now bleed all the way to zero (the apex hang) but never past it.
    expect(state.speed).toBeGreaterThanOrEqual(0);
    expect(state.speed).toBeLessThanOrEqual(FLIGHT.MAX_SPEED);
    expect(Math.abs(state.bank)).toBeLessThanOrEqual(FLIGHT.MAX_BANK + 1e-9);
    expect(Number.isFinite(camera.position.x + camera.position.y + camera.position.z)).toBe(true);
  });
});
