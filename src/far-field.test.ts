/**
 * Far-field follow: the finite sky shell must stay under the camera, and the
 * puff field must wrap around it without popping.
 *
 * There used to be three tows here (sea, cloud dome, sky). The sea and the dome cloud
 * were deleted on 2026-11-06 (`rebuild/sea-dome-reset`), so these tests pin what is
 * left — the sky tow and the puff wrap.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { initFarField } from './far-field';

function world(skyName = 'sky_sunset_tsl'): THREE.Scene {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
  mesh.name = skyName;
  scene.add(mesh);
  return scene;
}

describe('far field', () => {
  it('tows the sky shell with the camera', () => {
    const scene = world();
    const far = initFarField(scene);
    far.update(-120.5, 730.25);
    expect(far.followed).toEqual({ towed: ['sky_sunset_tsl'] });
    expect((scene.getObjectByName('sky_sunset_tsl') as THREE.Mesh).position.x).toBe(-120.5);
    expect((scene.getObjectByName('sky_sunset_tsl') as THREE.Mesh).position.z).toBe(730.25);
    far.dispose();
  });

  it('tows the shell in full 3D so its centre sits ON the eye (2026-11-08)', () => {
    // The dome shades with normalize(positionWorld - cameraPosition). Leaving
    // its centre at y=0 while the camera cruises at 60-240 m adds a fixed
    // vertical parallax between the painted sky and the sea's reflected sky.
    const scene = world();
    const far = initFarField(scene);
    far.update(-120.5, 730.25, 66.8);
    const sky = scene.getObjectByName('sky_sunset_tsl') as THREE.Mesh;
    expect(sky.position.x).toBe(-120.5);
    expect(sky.position.y).toBe(66.8);
    expect(sky.position.z).toBe(730.25);
    // Two-arg callers (older captures) keep their original behaviour.
    far.update(1, 2);
    expect(sky.position.y).toBe(0);
    far.dispose();
  });

  it('survives a scene with none of the expected objects', () => {
    const far = initFarField(new THREE.Scene());
    expect(far.followed).toEqual({ towed: [] });
    expect(() => far.update(1, 2)).not.toThrow();
    far.dispose();
  });
});

describe('puff field follow', () => {
  it('puff 绕相机取模，不绕飞机', () => {
    // Review Focus 3：rig 有滞后，窗口中心必须是相机。若有人把这里「清理」成
    // 别的锚点，云场会在相机追上之前就开始回收抖动，而别的测试仍然全绿。
    const scene = world();
    const puff = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
    puff.name = 'puff-00';
    puff.position.set(0, 60, -2400);
    scene.add(puff);
    const far = initFarField(scene);
    far.update(-120, 730); // 相机在 z=730
    expect(puff.position.z).toBeGreaterThan(730 - 1000);
    expect(puff.position.z).toBeLessThanOrEqual(730 + 1000);
    expect(Math.abs(puff.position.x - -120)).toBeLessThanOrEqual(1000);
    far.dispose();
  });
});

describe('cloud gates wiring (P2-1)', () => {
  const gateWorld = (): { scene: THREE.Scene; puffs: THREE.Mesh[] } => {
    const scene = world();
    const puffs: THREE.Mesh[] = [];
    // 三朵全在身后：0 号掉队 500m，1 号掉队 100m，2 号前方 300m 正脸（穿云位，不是门）。
    const zs = [500, 100, -300];
    for (let i = 0; i < 3; i += 1) {
      const puff = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
      puff.name = `puff-0${i}`;
      puff.position.set(0, 60, zs[i]);
      scene.add(puff);
      puffs.push(puff);
    }
    return { scene, puffs };
  };

  it('到点无门 → 掉队最远的进门位（前 200~400m × 侧 40~70m），y 不动', () => {
    const { scene, puffs } = gateWorld();
    const far = initFarField(scene);
    far.update(0, 0, 60, 0, -1, 100); // 首帧（lastGateT 非有限）直接开门
    // 0 号（身后 500m，最远）被搬走；1、2 号原地。
    expect(puffs[0].position.z).toBeLessThan(-200);
    expect(puffs[0].position.z).toBeGreaterThanOrEqual(-400);
    expect(Math.abs(puffs[0].position.x)).toBeGreaterThanOrEqual(40);
    expect(Math.abs(puffs[0].position.x)).toBeLessThanOrEqual(70);
    expect(puffs[0].position.y).toBe(60);
    expect(puffs[1].position.z).toBe(100);
    expect(puffs[2].position.z).toBe(-300);
    far.dispose();
  });

  it('场上有门 → 谁都不动；节拍内重复 update 也不补门', () => {
    const { scene, puffs } = gateWorld();
    const far = initFarField(scene);
    // 先放一朵现成的门。
    puffs[1].position.set(55, 60, -250);
    far.update(0, 0, 60, 0, -1, 100);
    expect(puffs[0].position.z).toBe(500);
    expect(puffs[1].position.z).toBe(-250);
    expect(puffs[2].position.z).toBe(-300);
    far.dispose();
  });

  it('低档藏掉的云不当门源：visible=false 的再远也不搬', () => {
    const { scene, puffs } = gateWorld();
    puffs[0].visible = false; // 掉队最远但低档藏了
    const far = initFarField(scene);
    far.update(0, 0, 60, 0, -1, 100);
    // 搬的是 1 号（可见朵里掉队最远），0 号原地不动。
    expect(puffs[0].position.z).toBe(500);
    expect(puffs[1].position.z).toBeLessThan(-200);
    far.dispose();
  });
});
