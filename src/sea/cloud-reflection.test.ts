import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { initCloudReflection, syncReflectionCards } from './cloud-reflection';

function fixture() {
  const scene = new THREE.Scene(), group = new THREE.Group();
  group.name = 'bg_cloud_field'; group.position.set(20, 10, -30);
  const cloud = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial());
  cloud.position.set(10, 60, -700); cloud.scale.set(100, 80, 1);
  group.add(cloud); scene.add(group);
  return { scene, group, cloud };
}

describe('distant cloud reflection', () => {
  it('captures camera-relative world transforms and reuses only cloud resources', () => {
    const { scene, group, cloud } = fixture(), capture = new THREE.Scene();
    scene.add(new THREE.Mesh()); // aircraft/sea must never enter this scene
    const pairs = new Map<THREE.Mesh, THREE.Mesh>(), eye = new THREE.Vector3(8, 12, 20);
    expect(syncReflectionCards(scene, capture, pairs, eye)).toBe(true);
    const clone = pairs.get(cloud)!;
    expect(capture.children).toHaveLength(1);
    expect(clone.geometry).toBe(cloud.geometry); expect(clone.material).toBe(cloud.material);
    expect(new THREE.Vector3().setFromMatrixPosition(clone.matrix).toArray()).toEqual([22, 58, -750]);
    eye.x += 50; cloud.position.x += 50;
    syncReflectionCards(scene, capture, pairs, eye);
    expect(pairs.get(cloud)).toBe(clone);
    expect(new THREE.Vector3().setFromMatrixPosition(clone.matrix).toArray()).toEqual([22, 58, -750]);
    group.visible = false;
    expect(syncReflectionCards(scene, capture, pairs, eye)).toBe(false);
    expect(clone.visible).toBe(false);
    scene.remove(group);
    expect(syncReflectionCards(scene, capture, pairs, eye)).toBe(false);
  });

  it('throttles captures, stops when disabled/hidden, and preserves renderer state', async () => {
    const { scene, group, cloud } = fixture(), eye = new THREE.Vector3();
    let target: unknown = { name: 'main' }, face = 2, mip = 1, alpha = 0.7;
    const initialTarget = target, clear = new THREE.Color('#123456');
    const renderer = {
      coordinateSystem: THREE.WebGPUCoordinateSystem, xr: { enabled: true }, autoClear: false,
      getRenderTarget: () => target, getActiveCubeFace: () => face, getActiveMipmapLevel: () => mip,
      setRenderTarget: (t: unknown, f = 0, m = 0) => { target = t; face = f; mip = m; },
      getClearColor: (c: THREE.Color) => c.copy(clear), getClearAlpha: () => alpha,
      setClearColor: (c: THREE.Color | number, a: number) => { clear.set(c); alpha = a; },
      render: vi.fn(),
    };
    const reflection = await initCloudReflection(renderer);
    reflection.update(scene, eye, 0); expect(renderer.render).not.toHaveBeenCalled();
    reflection.stage.value = 1;
    reflection.update(scene, eye, 0); expect(renderer.render).toHaveBeenCalledTimes(6);
    reflection.update(scene, eye, 0.1); expect(reflection.captures).toBe(1);
    reflection.update(scene, eye, 0.26); expect(reflection.captures).toBe(2);
    reflection.setQuality(false);
    reflection.update(scene, eye, 0.52); expect(reflection.captures).toBe(2);
    reflection.update(scene, eye, 0.77); expect(reflection.captures).toBe(3);
    group.visible = false; reflection.update(scene, eye, 1);
    expect(reflection.enabled.value).toBe(0); expect(reflection.captures).toBe(3);
    group.visible = true; reflection.update(scene, eye, 0); // reset clock refreshes
    expect(reflection.captures).toBe(4);
    eye.x = 2000; reflection.update(scene, eye, 0.01);
    expect(reflection.captures).toBe(5); // teleport must not wait for the refresh timer
    expect(target).toBe(initialTarget); expect([face, mip, alpha]).toEqual([2, 1, 0.7]);
    expect(clear.getHexString()).toBe('123456'); expect(renderer.xr.enabled).toBe(true);
    expect(renderer.autoClear).toBe(false);
    renderer.render.mockImplementationOnce(() => { throw new Error('test capture failure'); });
    expect(() => reflection.update(scene, eye, 2)).toThrow('test capture failure');
    expect(target).toBe(initialTarget); expect(renderer.xr.enabled).toBe(true);
    const disposed = vi.spyOn(cloud.geometry, 'dispose'); reflection.dispose();
    expect(disposed).not.toHaveBeenCalled();
  });
});
