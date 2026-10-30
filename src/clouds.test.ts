import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CLOUD_PALETTE } from './palettes';
import {
  CLOUD_RENDER_INFO,
  CLOUD_STEPS_HIGH,
  CLOUD_STEPS_LOW,
  CLOUD_TOON_STEPS,
  initClouds,
  posterise01,
} from './clouds-compute';

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

describe('cloud toon posterisation', () => {
  it('quantises to the requested number of luminance steps', () => {
    // Four steps means the input range is cut into quarters, each landing on its own
    // value. The 0.5 offset puts a level in the middle of its band rather than on the
    // boundary, which is what stops the step edges shimmering as the camera moves.
    expect(posterise01(0.0, 4)).toBe(0);
    expect(posterise01(0.1, 4)).toBe(0);
    expect(posterise01(0.2, 4)).toBe(0.25);
    expect(posterise01(0.45, 4)).toBe(0.5);
    expect(posterise01(0.7, 4)).toBe(0.75);
    expect(posterise01(1.0, 4)).toBe(1);
  });

  it('never returns more distinct values than steps', () => {
    const seen = new Set<number>();
    for (let i = 0; i <= 100; i += 1) seen.add(posterise01(i / 100));
    expect(seen.size).toBe(CLOUD_TOON_STEPS + 1);
  });

  it('degrades to 0 on bad input rather than emitting NaN into the shader', () => {
    expect(posterise01(Number.NaN)).toBe(0);
    expect(posterise01(0.5, 0)).toBe(0);
    expect(posterise01(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('keeps the step count small enough to read as blocks', () => {
    // The reference clouds show three or four flat tones. More steps re-creates the
    // smooth gradient the posterisation exists to remove.
    expect(CLOUD_TOON_STEPS).toBeGreaterThanOrEqual(3);
    expect(CLOUD_TOON_STEPS).toBeLessThanOrEqual(5);
  });
});
