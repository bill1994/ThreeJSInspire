import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CLOUD_SPRITE_COUNT, initClouds as initCloudsFallback } from './clouds-fallback';
import { CLOUD_PALETTE } from './palettes';
import { CLOUD_RENDER_INFO, CLOUD_STEPS_HIGH, CLOUD_STEPS_LOW, initClouds } from './clouds-compute';

const SUN = new THREE.Vector3(60, 35, -280).normalize();
const TIME_SWEEP = [0, 0.016, 1, 12.5, 120, 3600, 1e5];

describe('cloud palette', () => {
  it('keeps every colour a finite, in-gamut sRGB triple', () => {
    for (const [name, hex] of Object.entries(CLOUD_PALETTE)) {
      expect(Number.isInteger(hex), `${name} must be an integer hex`).toBe(true);
      expect(hex).toBeGreaterThanOrEqual(0);
      expect(hex).toBeLessThanOrEqual(0xffffff);

      const c = new THREE.Color(hex);
      for (const ch of [c.r, c.g, c.b]) {
        expect(Number.isFinite(ch)).toBe(true);
        expect(ch).toBeGreaterThanOrEqual(0);
        expect(ch).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is purple at the base and pink at the lit edge', () => {
    const base = new THREE.Color(CLOUD_PALETTE.base);
    const pink = new THREE.Color(CLOUD_PALETTE.pink);
    // Purple base: blue outranks green, red in the middle.
    expect(base.b).toBeGreaterThan(base.g);
    expect(base.r).toBeGreaterThan(base.g);
    // Pink edge is much lighter than the base.
    expect(pink.r).toBeGreaterThan(base.r);
    expect(pink.g).toBeGreaterThan(base.g);
  });
});

describe('cloud render budget', () => {
  it('stays within the agreed raymarch budget', () => {
    expect(CLOUD_RENDER_INFO.stepsHigh).toBeLessThanOrEqual(12);
    expect(CLOUD_RENDER_INFO.stepsLow).toBeLessThanOrEqual(8);
    expect(CLOUD_RENDER_INFO.stepsLow).toBeLessThan(CLOUD_RENDER_INFO.stepsHigh);
  });

  it('places the cloud slab well above the sea and inside the sky dome', () => {
    expect(CLOUD_RENDER_INFO.bottom).toBeGreaterThan(50);
    expect(CLOUD_RENDER_INFO.top).toBeGreaterThan(CLOUD_RENDER_INFO.bottom);
    expect(CLOUD_RENDER_INFO.domeRadius).toBeGreaterThan(400);
    expect(CLOUD_RENDER_INFO.domeRadius).toBeLessThan(800);
  });

  it('ships exactly 12 sprite puffs for the WebGL2 path', () => {
    expect(CLOUD_SPRITE_COUNT).toBe(12);
  });
});

describe('clouds (webgl2 fallback)', () => {
  it('returns a handle whose update is safe across the time sweep', () => {
    const scene = new THREE.Scene();
    const clouds = initCloudsFallback(scene, 'webgl2');
    expect(clouds.kind).toBe('sprite');

    // 12 puffs + their group.
    expect(scene.children.length).toBe(1);
    const group = scene.children[0] as THREE.Group;
    expect(group.children.length).toBe(CLOUD_SPRITE_COUNT);

    for (const t of TIME_SWEEP) {
      expect(() => clouds.update(t, SUN)).not.toThrow();
    }

    for (const child of group.children) {
      expect(Number.isFinite(child.position.x)).toBe(true);
      expect(Number.isFinite(child.position.y)).toBe(true);
      expect(Number.isFinite(child.position.z)).toBe(true);
    }

    clouds.dispose();
    expect(scene.children.length).toBe(0);
  });

  it('survives a degenerate sun direction and non-finite time', () => {
    const scene = new THREE.Scene();
    const clouds = initCloudsFallback(scene, 'webgl2');
    const zero = new THREE.Vector3(0, 0, 0);
    expect(() => clouds.update(Number.NaN, zero)).not.toThrow();
    expect(() => clouds.update(1, new THREE.Vector3(Number.NaN, 1, 0))).not.toThrow();
    clouds.dispose();
  });

  it('degrades to fewer visible puffs without throwing', () => {
    const scene = new THREE.Scene();
    const clouds = initCloudsFallback(scene, 'webgl2');
    const group = scene.children[0] as THREE.Group;
    const visibleIn = (): number => group.children.filter((c) => c.visible).length;

    expect(visibleIn()).toBe(CLOUD_SPRITE_COUNT);
    expect(() => clouds.setQuality(false)).not.toThrow();
    expect(visibleIn()).toBeLessThan(CLOUD_SPRITE_COUNT);
    expect(() => clouds.setQuality(true)).not.toThrow();
    expect(visibleIn()).toBe(CLOUD_SPRITE_COUNT);
    clouds.dispose();
  });
});

describe('clouds (webgpu TSL)', () => {
  it('builds the TSL node graph and updates without a GPU device', async () => {
    const scene = new THREE.Scene();
    const clouds = await initClouds(scene, 'webgpu');
    expect(clouds.kind).toBe('tsl');
    expect(scene.children.length).toBe(1);

    for (const t of TIME_SWEEP) {
      expect(() => clouds.update(t, SUN)).not.toThrow();
    }

    const mesh = scene.children[0] as THREE.Mesh;
    const material = mesh.material as unknown as { colorNode: unknown; opacityNode: unknown };
    expect(material.colorNode).toBeTruthy();
    expect(material.opacityNode).toBeTruthy();

    clouds.dispose();
    expect(scene.children.length).toBe(0);
  });
});
