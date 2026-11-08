import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

import { azimuthDegOf, createSunState, elevationDegOf, wrapAzimuthDeg } from './sun-state';
import { HORIZON, sunDirectionFromAzEl } from './horizon';
import { SUN_DIRECTION } from './palettes';

describe('createSunState — the one live sun', () => {
  it('seeds from the palette direction and NEVER replaces the Vector3 object', () => {
    const sun = createSunState();
    const ref = sun.direction;
    expect(sun.direction.x).toBeCloseTo(SUN_DIRECTION[0], 6);
    expect(sun.direction.y).toBeCloseTo(SUN_DIRECTION[1], 6);
    expect(sun.direction.z).toBeCloseTo(SUN_DIRECTION[2], 6);
    expect(sun.direction.length()).toBeCloseTo(1, 6);
    expect(sun.version).toBe(1);

    sun.setAzEl(90, 9);
    expect(sun.direction).toBe(ref); // TSL uniforms bind by reference; replacing it would break the link
    expect(sun.direction.length()).toBeCloseTo(1, 6);
  });

  it('az/el round-trips through sunDirectionFromAzEl', () => {
    const sun = createSunState();
    sun.setAzEl(90, 8);
    const [x, y, z] = sunDirectionFromAzEl(90, 8);
    expect(sun.direction.x).toBeCloseTo(x, 6);
    expect(sun.direction.y).toBeCloseTo(y, 6);
    expect(sun.direction.z).toBeCloseTo(z, 6);
    expect(sun.azimuthDeg).toBeCloseTo(90, 6);
    expect(sun.elevationDeg).toBeCloseTo(8, 6);
    expect(azimuthDegOf(sun.direction)).toBeCloseTo(90, 6);
    expect(elevationDegOf(sun.direction)).toBeCloseTo(8, 6);
  });

  it('clamps elevation into the measured dusk band, like ?sun= always did', () => {
    const sun = createSunState();
    sun.setAzEl(20, -40);
    expect(sun.elevationDeg).toBe(HORIZON.DUSK_BAND.minDeg);
    sun.setAzEl(20, 75);
    expect(sun.elevationDeg).toBe(HORIZON.DUSK_BAND.maxDeg);
  });

  it('rotateAzimuth moves the direction, bumps version and notifies listeners', () => {
    const sun = createSunState();
    const listener = vi.fn();
    const off = sun.subscribe(listener);
    const before = sun.direction.clone();
    const v0 = sun.version;

    sun.rotateAzimuth(90);
    expect(sun.version).toBe(v0 + 1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(sun);
    expect(before.distanceTo(sun.direction)).toBeGreaterThan(0.5);
    expect(sun.azimuthDeg).toBeCloseTo(wrapAzimuthDeg(sun.azimuthDeg), 6);

    off();
    sun.rotateAzimuth(10);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('setDirection normalises an arbitrary vector and back-solves the angles', () => {
    const sun = createSunState();
    sun.setDirection(new THREE.Vector3(0, 10, 0));
    expect(sun.direction.y).toBeCloseTo(1, 6);
    expect(sun.elevationDeg).toBeCloseTo(90, 6);
    expect(Number.isFinite(sun.azimuthDeg)).toBe(true);
  });

  it('rejects garbage instead of poisoning shader uniforms with NaN', () => {
    const sun = createSunState();
    const before = sun.snapshot();
    sun.setAzEl(Number.NaN, 8);
    sun.setAzEl(10, Number.POSITIVE_INFINITY);
    sun.rotateAzimuth(Number.NaN);
    sun.setDirection(new THREE.Vector3(0, 0, 0));
    sun.setDirection(new THREE.Vector3(Number.NaN, 1, 0));
    expect(sun.snapshot()).toEqual(before);
  });

  it('snapshot is a plain copy, not a live alias', () => {
    const sun = createSunState();
    const snap = sun.snapshot();
    sun.rotateAzimuth(45);
    expect(snap.version).toBe(1);
    expect(snap.x).not.toBe(sun.direction.x);
  });
});

describe('wrapAzimuthDeg', () => {
  it('wraps into (-180, 180]', () => {
    expect(wrapAzimuthDeg(0)).toBe(0);
    expect(wrapAzimuthDeg(190)).toBe(-170);
    expect(wrapAzimuthDeg(-190)).toBe(170);
    expect(wrapAzimuthDeg(180)).toBe(180);
    expect(wrapAzimuthDeg(540)).toBe(180);
  });
});
