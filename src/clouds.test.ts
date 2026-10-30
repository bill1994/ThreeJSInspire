import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CLOUD_PALETTE } from './palettes';
import {
  CLOUD_BAND,
  CLOUD_PROFILE,
  CLOUD_RENDER_INFO,
  CLOUD_STEPS_HIGH,
  CLOUD_STEPS_LOW,
  CLOUD_TOON_STEPS,
  cloudErosionWeights,
  initClouds,
  posterise01,
  profileDensity,
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

  it('places the merged tower slab well above the sea and inside the sky dome', () => {
    // D1/D2: the two old slabs are one tower band now — bottom on the old deck, top at the
    // tower height the review measured off the reference's central column.
    expect(CLOUD_BAND.bottom).toBe(95);
    expect(CLOUD_BAND.top).toBe(480);
    expect(CLOUD_BAND.top).toBeGreaterThan(CLOUD_BAND.bottom);
    expect(CLOUD_BAND.bottom).toBeGreaterThan(50);
    expect(CLOUD_BAND.top).toBeLessThan(CLOUD_RENDER_INFO.domeRadius);
    expect(CLOUD_RENDER_INFO.domeRadius).toBeGreaterThan(400);
    expect(CLOUD_RENDER_INFO.domeRadius).toBeLessThan(800);
  });
});

describe('profileDensity (tower vertical profile)', () => {
  it('is full at the base — a tower, not a lens', () => {
    // The lens mask faded in over the first quarter of the slab, which is what pinned the
    // dense body to a 61 m ribbon. The tower keeps the base solid.
    expect(profileDensity(0, CLOUD_PROFILE)).toBeGreaterThanOrEqual(0.85);
  });

  it('is gone at the top', () => {
    expect(profileDensity(1, CLOUD_PROFILE)).toBeLessThanOrEqual(0.05);
  });

  it('never dips from base to waist, nor rises from waist to top', () => {
    const n = 24;
    let prev = profileDensity(0, CLOUD_PROFILE);
    for (let i = 1; i <= n; i++) {
      const h = i / n;
      const d = profileDensity(h, CLOUD_PROFILE);
      if (h <= CLOUD_PROFILE.waist) expect(d).toBeGreaterThanOrEqual(prev - 1e-9);
      else expect(d).toBeLessThanOrEqual(prev + 1e-9);
      prev = d;
    }
  });

  it('degrades to 0 on non-finite input', () => {
    expect(profileDensity(Number.NaN, CLOUD_PROFILE)).toBe(0);
    expect(profileDensity(Number.POSITIVE_INFINITY, CLOUD_PROFILE)).toBe(0);
    expect(profileDensity(0.5, { base: Number.NaN, waist: 0.4, topBias: 1.5 })).toBe(0);
    expect(profileDensity(0.5, { base: 0.9, waist: Number.NaN, topBias: 1.5 })).toBe(0);
    expect(profileDensity(0.5, null as unknown as typeof CLOUD_PROFILE)).toBe(0);
  });

  it('keeps the default profile inside the smoothstep domain so the TSL mirror is defined', () => {
    expect(CLOUD_PROFILE.waist).toBeGreaterThan(0);
    expect(CLOUD_PROFILE.waist).toBeLessThan(1);
    expect(CLOUD_PROFILE.topBias).toBeGreaterThan(0);
    expect(CLOUD_PROFILE.base).toBeGreaterThanOrEqual(0.85);
    expect(CLOUD_PROFILE.base).toBeLessThanOrEqual(1);
  });
});

describe('quality tiers', () => {
  it('drops the fine erosion octave at the low step count and renormalises the rest', () => {
    // At 8 steps the fine octave undersamples and only injects aliasing; the weights that
    // remain must still sum to 1 so the density band (0.5..0.68) keeps its old mean.
    const low = cloudErosionWeights(CLOUD_STEPS_LOW);
    expect(low.fine).toBe(0);
    expect(low.blobs + low.coarse).toBeCloseTo(1, 6);
    const high = cloudErosionWeights(CLOUD_STEPS_HIGH);
    expect(high.fine).toBeGreaterThan(0);
    expect(high.blobs + high.coarse + high.fine).toBeCloseTo(1, 6);
  });

  it('keeps the tower profile bounds at the low step count too', () => {
    // profileDensity is a pure function of (hFrac, profile) and the low tier rebuilds from
    // the same MAIN_SLAB spec, so the bounds must hold unchanged — pinning that a future
    // tier-specific profile cannot silently flatten the tower.
    expect(profileDensity(0, CLOUD_PROFILE)).toBeGreaterThanOrEqual(0.85);
    expect(profileDensity(1, CLOUD_PROFILE)).toBeLessThanOrEqual(0.05);
  });
});

describe('clouds (webgpu TSL)', () => {
  it('builds the single merged slab and updates without a GPU device', async () => {
    const scene = new THREE.Scene();
    const clouds = await initClouds(scene, 'webgpu');
    expect(clouds.kind).toBe('tsl');
    // D2 merged the wisp deck into the bank: one mesh, and `clouds-wisp` is gone.
    expect(scene.children.length).toBe(1);
    expect(scene.getObjectByName('clouds-volumetric')).toBeDefined();
    expect(scene.getObjectByName('clouds-wisp')).toBeUndefined();

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
