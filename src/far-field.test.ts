/**
 * Far-field follow: the ocean patch, the cloud shell and the sky shell must stay under the
 * aircraft, and the FFT sea must snap by whole wave periods so the tiled field stays pinned to
 * world space. These tests pin that contract without a renderer.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { initFarField, snapToPeriod } from './far-field';
import { SEA_FOLLOW_STEP } from './sea-fft';

function world(seaName = 'sea-fft', cloudsName = 'clouds-volumetric', skyName = 'sky_sunset_tsl'): THREE.Scene {
  const scene = new THREE.Scene();
  for (const name of [seaName, cloudsName, skyName]) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
    mesh.name = name;
    scene.add(mesh);
  }
  return scene;
}

describe('far field', () => {
  it('exposes the 400 m wave period the FFT tile is authored around', () => {
    expect(SEA_FOLLOW_STEP).toBe(400);
  });

  it('snaps to whole periods and refuses non-finite input', () => {
    expect(snapToPeriod(0)).toBe(0);
    expect(snapToPeriod(199)).toBe(0);
    expect(snapToPeriod(201)).toBe(400);
    expect(snapToPeriod(-205)).toBe(-400);
    expect(snapToPeriod(Number.NaN)).toBe(0);
    expect(snapToPeriod(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('keeps the FFT sea within half a period of the aircraft', () => {
    const scene = world();
    const far = initFarField(scene, 'fft');
    const sea = scene.getObjectByName('sea-fft') as THREE.Mesh;
    for (const z of [0, 37, 199, 1699.9, -4820.5]) {
      far.update(0, 0, 0, z);
      expect(Math.abs(sea.position.z - z)).toBeLessThanOrEqual(SEA_FOLLOW_STEP / 2 + 1e-6);
      expect(Math.abs(sea.position.z % SEA_FOLLOW_STEP)).toBe(0);
    }
    far.dispose();
  });

  it('slides the Gerstner sea continuously, since its waves are world-anchored', () => {
    const scene = world('sea-gerstner');
    const far = initFarField(scene, 'gerstner');
    const sea = scene.getObjectByName('sea-gerstner') as THREE.Mesh;
    far.update(0, 0, 13.5, -71.25);
    expect(sea.position.x).toBe(13.5);
    expect(sea.position.z).toBe(-71.25);
    far.dispose();
  });

  it('tows the cloud and sky shells with the camera, not the aircraft', () => {
    const scene = world();
    const far = initFarField(scene, 'fft');
    far.update(-120.5, 730.25, 0, -900);
    expect(far.followed).toEqual({ sea: 'sea-fft', clouds: 'clouds-volumetric', sky: 'sky_sunset_tsl' });
    expect((scene.getObjectByName('clouds-volumetric') as THREE.Mesh).position.x).toBe(-120.5);
    expect((scene.getObjectByName('clouds-volumetric') as THREE.Mesh).position.z).toBe(730.25);
    expect((scene.getObjectByName('sky_sunset_tsl') as THREE.Mesh).position.z).toBe(730.25);
    far.dispose();
  });

  it('survives a scene with none of the expected objects', () => {
    const far = initFarField(new THREE.Scene(), 'fft');
    expect(far.followed).toEqual({ sea: null, clouds: null, sky: null });
    expect(() => far.update(1, 2, 3, 4)).not.toThrow();
    far.dispose();
  });
});
