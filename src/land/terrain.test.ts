import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createTerrain, GRID } from './terrain';
import { createFlightState, FLIGHT, stepFlight, flightForward } from '../game';
import { initCameraRig } from '../camera-rig';

const seed = 20261120, terrain = createTerrain(seed);

describe('single island', () => {
  it('repeats a bounded coastline and normalized surface weights', () => {
    const repeat = createTerrain(seed);
    expect(repeat.shore).toEqual(terrain.shore);
    expect(createTerrain(seed + 1).shore).not.toEqual(terrain.shore);
    let peak = 0;
    for (let j = 0; j <= 64; j++) for (let i = 0; i <= 64; i++) {
      const s = terrain.sample(GRID.x + i * GRID.step, GRID.z + j * GRID.step);
      peak = Math.max(peak, s.height);
      if (i === 0 || i === 64 || j === 0 || j === 64) expect(s.distance).toBeLessThan(-30);
      expect(s.grass + s.sand + s.wet + s.woods).toBeCloseTo(1);
    }
    expect(peak).toBeGreaterThan(40);
    expect(peak).toBeLessThan(60);
  });

  it('uses each rendered triangle plane on both sides of a chunk boundary', () => {
    for (const i of [15, 16, 31, 32]) for (const [a, b] of [[0.2, 0.4], [0.7, 0.8]]) {
      const x = GRID.x + i * 8, z = GRID.z + 32 * 8;
      const y = (dx: number, dz: number) => terrain.heightAt(x + dx * 8, z + dz * 8);
      const expected = a + b < 1 ? (1 - a - b) * y(0, 0) + a * y(1, 0) + b * y(0, 1)
        : (a + b - 1) * y(1, 1) + (1 - b) * y(1, 0) + (1 - a) * y(0, 1);
      expect(terrain.heightAt(x + a * 8, z + b * 8)).toBeCloseTo(expected, 8);
    }
  });

  it.each([1 / 120, 1 / 30, 0.1])('keeps aircraft and camera above ridges through dives and banked climbs at dt=%s', dt => {
    const state = createFlightState(12), camera = new THREE.PerspectiveCamera(60, 9 / 16, 0.1, 2000);
    const rig = initCameraRig(camera, undefined, terrain.heightAt);
    state.pos.x = -56; state.pos.z = -238; state.speed = FLIGHT.MAX_SPEED;
    const forward = new THREE.Vector3();
    let landFrames = 0, peak = 0;
    for (let i = 0; i < Math.round(8 / dt); i++) {
      const t = i * dt;
      stepFlight(state, dt, { x: t > 4 ? 0.75 : 0, y: t < 4 ? 1 : -0.8 }, terrain.heightAt);
      flightForward(state.yaw, state.pitch, forward);
      rig.update(dt, { pos: state.pos, forward, bank: state.bank, speed01: 1 }, { x: 0.4, y: -0.5, z: 0 });
      const h = terrain.heightAt(state.pos.x, state.pos.z);
      if (h > 0) {
        expect(state.pos.y - h).toBeGreaterThanOrEqual(7.9999);
        expect(state.skim).toBe(0);
        landFrames++;
        peak = Math.max(peak, h);
      }
      expect(camera.position.y - terrain.heightAt(camera.position.x, camera.position.z)).toBeGreaterThanOrEqual(1.9999);
    }
    expect(landFrames * dt).toBeGreaterThan(2);
    expect(peak).toBeGreaterThan(25);
  });
});
