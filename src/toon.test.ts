import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import toonSource from './toon.ts?raw';
import { TOON_BANDS, TOON_RAMP, makeGradientMap, bandIndex, toonify } from './toon';

describe('bandIndex', () => {
  it('is a step function, not a lerp — that is the whole look', () => {
    expect(bandIndex(0.0, 3)).toBe(0);
    expect(bandIndex(0.34, 3)).toBe(1);
    expect(bandIndex(0.67, 3)).toBe(2);
  });

  it('pins the ends so the highlight never wraps to shadow', () => {
    expect(bandIndex(1, 3)).toBe(2);
    expect(bandIndex(-2, 3)).toBe(0);
    expect(bandIndex(Number.NaN, 3)).toBe(0);
  });
});

describe('makeGradientMap', () => {
  it('is a nearest-filtered 1D ramp with no mipmaps (three requires it for gradientMap)', () => {
    const tex = makeGradientMap(THREE, TOON_RAMP);
    expect(tex.image.width).toBe(TOON_BANDS);
    expect(tex.image.height).toBe(1);
    expect(tex.minFilter).toBe(THREE.NearestFilter);
    expect(tex.magFilter).toBe(THREE.NearestFilter);
    expect(tex.generateMipmaps).toBe(false);
    expect(tex.colorSpace).toBe(THREE.NoColorSpace);
  });
});

describe('toonify', () => {
  it('swaps every standard material on the aircraft for a toon node material', async () => {
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: '#efeadb' })));
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: '#2f6b4e' })));
    const ramp = makeGradientMap(THREE, TOON_RAMP);
    expect(await toonify(THREE, root, ramp)).toBe(2);
    root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material & { isNodeMaterial?: boolean; gradientMap?: unknown };
      if (!m) return;
      expect(m.isNodeMaterial).toBe(true);
      expect(m.gradientMap).toBe(ramp);
    });
  });
});

describe('module graph', () => {
  it('never imports three/webgpu statically, so the classic fallback stays reachable', () => {
    // The whole-repo version of this guard lives in module-graph.test.ts; this one states the
    // contract for the module that introduced the problem.
    const staticImport = /^\s*import\s+(?!type\b)[^;]*from\s+['"]three\/webgpu['"]/m;
    expect(staticImport.test(toonSource)).toBe(false);
    expect(toonSource).toMatch(/await import\(['"]three\/webgpu['"]\)/);
  });
});
