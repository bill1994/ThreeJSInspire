import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { initSunsetLights } from './lights';

describe('initSunsetLights — 默认值（参考档恒等的灯光侧）', () => {
  it('sun #ffd9a0 / 2.2，hemi #8a6fd0 / #2a1a3a / 0.7', () => {
    const scene = new THREE.Scene();
    const { sun } = initSunsetLights(scene);
    expect(sun.color.getHexString()).toBe('ffd9a0');
    expect(sun.intensity).toBe(2.2);
    const hemi = scene.children.find((c) => c instanceof THREE.HemisphereLight) as THREE.HemisphereLight;
    expect(hemi).toBeTruthy();
    expect(hemi.color.getHexString()).toBe('8a6fd0');
    expect(hemi.groundColor.getHexString()).toBe('2a1a3a');
    expect(hemi.intensity).toBe(0.7);
  });
});

describe('initSunsetLights — 轨道 setter（day-night Task 5）', () => {
  it('setSunLook / setAmbience 改现有灯对象，不新建', () => {
    const scene = new THREE.Scene();
    const { sun, setSunLook, setAmbience } = initSunsetLights(scene);
    const lightsBefore = scene.children.length;
    setSunLook('#ff8a50', 1.4);
    expect(sun.color.getHexString()).toBe('ff8a50');
    expect(sun.intensity).toBe(1.4);
    setAmbience('#6a55b0', '#201430', 0.5);
    expect(scene.children.length).toBe(lightsBefore);
    const hemi = scene.children.find((c) => c instanceof THREE.HemisphereLight) as THREE.HemisphereLight;
    expect(hemi.color.getHexString()).toBe('6a55b0');
    expect(hemi.groundColor.getHexString()).toBe('201430');
    expect(hemi.intensity).toBe(0.5);
  });

  it('setSunDirection 仍把灯摆在原距离上', () => {
    const scene = new THREE.Scene();
    const { sun, setSunDirection, setSunLook } = initSunsetLights(scene);
    const distance = sun.position.length();
    setSunLook('#304060', 0.15);
    setSunDirection(new THREE.Vector3(0, 0.2, -1).normalize());
    expect(Math.abs(sun.position.length() - distance)).toBeLessThan(1e-6);
    expect(sun.position.y).toBeGreaterThan(0);
  });
});
