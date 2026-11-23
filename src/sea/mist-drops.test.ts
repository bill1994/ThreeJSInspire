import {describe, expect, it} from 'vitest';
import {InstancedMesh, Matrix4, PerspectiveCamera, Scene, Vector3} from 'three';
import {initMistDrops} from './mist-drops';

function seaPass() {
  const scene = new Scene(), camera = new PerspectiveCamera(60, 9 / 16);
  const sun = new Vector3(0.12, 0.32, -0.94).normalize();
  let bed = -14;
  const drops = initMistDrops(scene, 20261120, () => bed);
  const mesh = scene.getObjectByName('coastal-mist-drops') as InstancedMesh;
  const update = () => drops.update(5, camera, camera.position.y, sun, 0);
  for (let z = -380; z >= -940; z -= 3) {
    camera.position.set(550, 18, z);
    update();
    if (mesh.count >= 3) break;
  }
  expect(mesh.count).toBeGreaterThanOrEqual(3);
  const positions = () => Array.from({length:mesh.count}, (_, index) => {
    const matrix = new Matrix4();
    mesh.getMatrixAt(index, matrix);
    return matrix.elements.slice(12, 15).join(',');
  });
  return {camera, sun, drops, mesh, update, positions, setBed(value: number) { bed = value; }};
}

describe('sea mist in flight', () => {
  it('leaves droplets in world space and reconstructs the same patch after recycling', () => {
    const pass = seaPass(), eye = pass.camera.position.clone();
    const before = pass.positions();
    pass.camera.position.x += 0.1;
    pass.update();
    expect(pass.positions().some(p => before.includes(p))).toBe(true);
    pass.camera.position.x += 12000;
    pass.update();
    pass.camera.position.copy(eye);
    pass.update();
    expect(pass.positions()).toEqual(before);
    pass.drops.setQuality(false);
    pass.update();
    expect(pass.positions().every(p => before.includes(p))).toBe(true);
    pass.drops.dispose();
    expect(pass.mesh.parent).toBeNull();
  });

  it('clears the draw batch over land, at night and above the marine layer', () => {
    const pass = seaPass();
    pass.setBed(3);
    pass.update();
    expect(pass.mesh.count).toBe(0);
    pass.setBed(-14);
    pass.update();
    expect(pass.mesh.visible).toBe(true);
    pass.sun.y = -0.4;
    pass.update();
    expect(pass.mesh.visible).toBe(false);
    pass.sun.y = 0.6;
    pass.camera.position.y = 60;
    pass.update();
    expect(pass.mesh.count).toBe(0);
    pass.drops.dispose();
  });
});
