import * as THREE from 'three';

export const CLOUD_REFLECTION = { size: 128, interval: 0.25, lowInterval: 0.5, lod: 1.5, gain: 2.1, maxWeight: 0.28 } as const;

/** Capture only the existing baked cloud cards, never the sea, aircraft or puff
 * ray marcher. Clones share their source geometry/material; this owns neither. */
export function syncReflectionCards(source: THREE.Scene, capture: THREE.Scene,
  pairs: Map<THREE.Mesh, THREE.Mesh>, eye: THREE.Vector3): boolean {
  let visible = false;
  for (const clone of pairs.values()) clone.visible = false;
  for (const name of ['bg_cloud_backdrop', 'bg_cloud_field']) {
    const group = source.getObjectByName(name);
    if (!group) continue;
    group.updateWorldMatrix(true, true);
    for (const child of group.children) {
      if (!(child instanceof THREE.Mesh)) continue;
      let clone = pairs.get(child);
      if (!clone) {
        clone = new THREE.Mesh(child.geometry, child.material);
        clone.matrixAutoUpdate = false;
        clone.frustumCulled = true;
        capture.add(clone); pairs.set(child, clone);
      }
      clone.matrix.copy(child.matrixWorld);
      clone.matrix.elements[12] -= eye.x;
      clone.matrix.elements[13] -= eye.y;
      clone.matrix.elements[14] -= eye.z;
      clone.matrixWorldNeedsUpdate = true;
      clone.renderOrder = child.renderOrder;
      clone.visible = group.visible && child.visible;
      visible ||= clone.visible;
    }
  }
  return visible;
}

export async function initCloudReflection(renderer: any) {
  const { CubeRenderTarget } = await import('three/webgpu');
  const { uniform } = await import('three/tsl');
  const target = new CubeRenderTarget(CLOUD_REFLECTION.size, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat,
    generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter,
    depthBuffer: false,
  });
  target.texture.name = 'sea_cloud_environment';
  const camera = new THREE.CubeCamera(1, 1800, target as any);
  const capture = new THREE.Scene();
  const pairs = new Map<THREE.Mesh, THREE.Mesh>();
  const enabled = uniform(0), stage = uniform(0), night = uniform(1);
  const clear = new THREE.Color(), lastEye = new THREE.Vector3();
  let previous = -Infinity, captures = 0, high = true;
  return {
    texture: target.texture, enabled, stage, night,
    setQuality(value: boolean) { high = value; },
    get captures() { return captures; },
    update(scene: THREE.Scene, eye: THREE.Vector3, time: number) {
      if (!renderer || stage.value === 0) { enabled.value = 0; return; }
      const visible = syncReflectionCards(scene, capture, pairs, eye);
      if (!visible) { enabled.value = 0; return; }
      if (enabled.value && lastEye.distanceToSquared(eye) < 1600 * 1600 && time >= previous && time - previous < (high ? CLOUD_REFLECTION.interval : CLOUD_REFLECTION.lowInterval)) return;
      const oldTarget = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
      renderer.getClearColor(clear); const alpha = renderer.getClearAlpha(), auto = renderer.autoClear;
      const xr = renderer.xr.enabled;
      try {
        renderer.setClearColor(0, 0); renderer.autoClear = true;
        camera.update(renderer, capture);
        enabled.value = 1; previous = time; lastEye.copy(eye); captures++;
      } finally {
        renderer.setRenderTarget(oldTarget, face, mip);
        renderer.setClearColor(clear, alpha); renderer.autoClear = auto;
        renderer.xr.enabled = xr;
        target.texture.generateMipmaps = true;
      }
    },
    dispose() { target.dispose(); capture.clear(); pairs.clear(); },
  };
}
