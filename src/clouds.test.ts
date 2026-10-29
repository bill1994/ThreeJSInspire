import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
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
