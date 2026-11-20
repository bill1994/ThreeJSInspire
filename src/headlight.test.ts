import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { HEADLIGHT, headlightStrength, initHeadlight, parseHeadlightMode } from './headlight';

describe('aircraft headlight', () => {
  it('automatically follows twilight continuously and respects manual overrides', () => {
    expect(parseHeadlightMode(null)).toBe('auto');
    expect(parseHeadlightMode('bad')).toBe('auto');
    expect(headlightStrength('auto', 0.5)).toBe(0);
    expect(headlightStrength('auto', -0.5)).toBe(1);
    expect(headlightStrength('auto', NaN)).toBe(0);
    expect(headlightStrength('on', 0.5)).toBe(1);
    expect(headlightStrength('off', -0.5)).toBe(0);
    let previous = 1;
    for (let y = -0.2; y < 0.2; y += 0.0001) {
      const v = headlightStrength('auto', y);
      expect(v).toBeLessThanOrEqual(previous);
      expect(previous - v).toBeLessThan(0.002);
      previous = v;
    }
  });

  it('moves and banks with the aircraft while retaining its downward aim; disables and disposes cleanly', async () => {
    const scene = new THREE.Scene(), root = new THREE.Group(), roll = new THREE.Group();
    roll.name = 'porco_roll'; root.add(roll); scene.add(root);
    root.position.set(100, 25, -200); root.rotation.set(0.2, 1.1, 0);
    roll.rotation.z = -0.7;
    const lamp = await initHeadlight(scene);
    lamp.update(-1);
    const expectedPosition = new THREE.Vector3(...HEADLIGHT.position).applyMatrix4(roll.matrixWorld);
    expect(lamp.uniforms.position.value.distanceTo(expectedPosition)).toBeLessThan(1e-8);
    const expectedDirection = new THREE.Vector3(0, Math.sin(HEADLIGHT.tilt), -Math.cos(HEADLIGHT.tilt))
      .transformDirection(roll.matrixWorld);
    expect(lamp.uniforms.direction.value.distanceTo(expectedDirection)).toBeLessThan(1e-8);
    const beam = scene.getObjectByName('porco_headlight_beam') as THREE.Mesh;
    expect(beam.visible).toBe(true);
    lamp.update(1); expect(beam.visible).toBe(false);
    lamp.setMode('on'); lamp.update(1); expect(beam.visible).toBe(true);
    lamp.setMode('off'); lamp.update(-1); expect(lamp.uniforms.strength.value).toBe(0);
    scene.remove(root); lamp.update(-1); expect(scene.getObjectByName('porco_headlight')!.visible).toBe(false);
    lamp.dispose(); expect(scene.getObjectByName('porco_headlight')).toBeUndefined();
    expect(lamp.uniforms.strength.value).toBe(0);
  });
});
