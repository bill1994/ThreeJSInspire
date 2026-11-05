/**
 * What `initSeaBands` leaves behind when a material build fails.
 *
 * The six band builds run concurrently and each one adds its mesh to the scene, so a failure
 * part-way through used to leave the already-resolved bands mounted — un-towed, un-updated,
 * and invisible to the caller, whose fallback path logs "sky + puffs only" while stray meshes
 * sit in the scene. This file pins the fix: nothing is mounted unless all six build.
 *
 * The mock lives here rather than in `bands.test.ts` because `vi.mock` is per-module-registry:
 * mocking the material builder in the shared file would make its real-material tests useless.
 */
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

const built: string[] = [];

vi.mock('./surface-material', async () => {
  const three = await import('three');
  return {
    buildSurfaceMaterial: async () => {
      built.push('build');
      // Fail the third build, after two have already resolved — the exact shape that
      // matters: a rejection that arrives while other bands are already done.
      if (built.length === 3) throw new Error('shader build failed');
      return { material: new three.MeshBasicMaterial(), uniforms: {} };
    },
  };
});

describe('initSeaBands when a material build fails', () => {
  it('leaves the scene empty and propagates the error', async () => {
    const { initSeaBands } = await import('./bands');
    const scene = new THREE.Scene();

    await expect(initSeaBands(scene)).rejects.toThrow('shader build failed');

    // The bands that resolved before the failure must not be left mounted. A partial
    // mount is worse than none: those meshes are never towed, never updated, and the
    // caller's fallback label claims the sea is absent.
    expect(scene.children).toHaveLength(0);
    expect(scene.children.filter((o) => /^sea-b\d$/.test(o.name))).toHaveLength(0);
  });
});
