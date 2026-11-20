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
import { PUFF_WINDOW, PUFF_EDGE_FADE, puffEdgeFade } from './puff-field';

describe('staggered puff visibility in flight', () => {
  it('replenishes a recycled cloud only outside the actual camera view, ready for the next turn', () => {
    const scene=new THREE.Scene(), camera=new THREE.PerspectiveCamera(60,.6,.1,2000);
    const cloud=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial());
    cloud.name='puff-0';cloud.position.set(0,60,-1150);
    cloud.userData.scatterOffset={x:0,z:-1150};cloud.userData.blobSize={halfW:50,halfD:50,halfH:50};
    cloud.material.userData.edgeFade={value:0};scene.add(cloud);
    const far=initFarField(scene);
    camera.position.set(0,60,0);far.update(0,0,60,0,-1,0,camera);
    expect(cloud.material.userData.edgeFade.value).toBe(1); // established initial scene
    camera.position.z=6000;far.update(0,6000,60,0,-1,1,camera);
    expect(cloud.material.userData.edgeFade.value).toBe(0);
    camera.rotation.y=Math.PI;far.update(0,6000,60,0,1,2,camera);
    expect(cloud.material.userData.edgeFade.value).toBe(1); // behind viewer, fully ready
    camera.rotation.y=0;far.update(0,6000,60,0,-1,3,camera);
    expect(cloud.material.userData.edgeFade.value).toBe(1);
    far.dispose();
  });
  it('keeps births distant and gradual across two minutes of diagonal flight and repeated recycling', () => {
    const scene = new THREE.Scene();
    const clouds = Array.from({length: 16}, (_,i) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
      const angle = i*Math.PI/8, x=Math.sin(angle)*1100, z=Math.cos(angle)*1100;
      m.name=`puff-${i}`; m.position.set(x,60,z);
      m.userData.scatterOffset={x,z}; m.userData.blobSize={halfW:50,halfD:50};
      m.material.userData.edgeFade={value:0}; scene.add(m); return m;
    });
    const far=initFarField(scene), before=clouds.map(()=>0);
    let births=0, recycled=0;
    for(let frame=0;frame<7200;frame++) {
      const t=frame/60, x=t*18, z=-t*40;
      const positions=clouds.map(m=>m.position.clone());
      far.update(x,z,60,0,-1,t);
      clouds.forEach((m,i)=>{
        const fade=m.material.userData.edgeFade.value;
        expect(fade-before[i]).toBeLessThanOrEqual(1/240+1e-8);
        if(before[i]===0 && fade>0) {
          births++;
          expect(Math.hypot(m.position.x-x,m.position.z-z)).toBeGreaterThanOrEqual(850);
        }
        if(m.position.distanceTo(positions[i])>400) {
          recycled++;
          expect(fade).toBeLessThan(.01);
        }
        before[i]=fade;
      });
    }
    expect(births).toBeGreaterThan(16); expect(recycled).toBeGreaterThan(16);
    far.dispose();
  });
  it('keeps delayed clouds hidden near the aircraft and resets opacity on teleport', () => {
    const scene = new THREE.Scene();
    const make = (id: number, x: number, z: number) => {
      const material = new THREE.MeshBasicMaterial();
      material.userData.edgeFade = {value: 0};
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
      mesh.name = `puff-${id}`;
      mesh.position.set(x,60,z);
      mesh.userData.scatterOffset = {x,z};
      mesh.userData.blobSize = {halfW: 70,halfD: 70};
      scene.add(mesh);
      return mesh;
    };
    const a=make(0,0,-1150), b=make(1,0,-1250), near=make(2,400,0);
    const fade=(p: typeof a)=>p.material.userData.edgeFade.value;
    const far=initFarField(scene);
    for(let i=0;i<=360;i++) far.update(0,0,60,0,-1,i/60);
    expect(fade(a)).toBe(1);
    expect(fade(b)).toBe(0); // same bearing stays queued
    expect(fade(near)).toBe(0); // never release queued clouds nearby
    // A visible cloud stays present as we fly closer, preserving cloud entry.
    for(let i=1;i<=60;i++) far.update(0,-i*5,60,0,-1,6+i/60);
    expect(fade(a)).toBe(1);
    far.update(6000,6000,60,0,-1,7+1/60);
    expect(fade(a)).toBeLessThan(.01);
    expect(fade(b)).toBe(0);
    far.dispose();
  });
});

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
    expect(puff.position.z).toBeGreaterThan(730 - PUFF_WINDOW / 2);
    expect(puff.position.z).toBeLessThanOrEqual(730 + PUFF_WINDOW / 2);
    expect(Math.abs(puff.position.x - -120)).toBeLessThanOrEqual(PUFF_WINDOW / 2);
    far.dispose();
  });
});

describe('distant puff recycling', () => {
  function cloud(scene: THREE.Scene, x: number, z: number): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
    mesh.name = `puff-${scene.children.length}`;
    mesh.position.set(x, 60, z);
    mesh.material.userData.edgeFade = { value: 1 };
    scene.add(mesh);
    return mesh;
  }

  it('never schedules a nearby encounter cloud, even after many old gate periods or a turn', () => {
    const scene = world();
    const puffs = [cloud(scene, 0, 500), cloud(scene, 0, 100), cloud(scene, 0, -300)];
    const positions = puffs.map(p => p.position.clone());
    const far = initFarField(scene);
    for (let time = 0; time <= 120; time++) far.update(0, 0, 60, Math.sin(time), Math.cos(time), time);
    expect(puffs.map(p => p.position)).toEqual(positions);
    far.dispose();
  });

  it('anchors new clouds around the actual initial camera; teleport resets them far away', () => {
    const scene = world();
    const puff = cloud(scene, 0, -1100);
    puff.userData.scatterOffset = { x: 0, z: -1100 };
    const far = initFarField(scene);
    far.update(20000, -20000, 70);
    expect(puff.position.toArray()).toEqual([20000, 60, -21100]);
    far.update(20000, -20100, 70);
    expect(puff.position.z).toBe(-21100); // world anchored while approaching
    far.update(-20000, 20000, 70);
    expect(puff.position.toArray()).toEqual([-20000, 60, 18900]);
    far.dispose();
  });

  it('wraps only at the distant boundary, with both sides hidden, in every flight direction', () => {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [.707, .707]]) {
      const scene = world();
      const puff = cloud(scene, 1100, -1100);
      const far = initFarField(scene);
      let previousFade = puffEdgeFade(puff.position.x, puff.position.z, 0, 0);
      let wraps = 0;
      for (let step = 0; step < 6000; step++) {
        const before = puff.position.clone();
        const cx = step * dx, cz = step * dz;
        far.update(cx, cz, 70, dx, dz, step / 46);
        const fade = (puff.material as THREE.MeshBasicMaterial).userData.edgeFade.value;
        if (before.distanceTo(puff.position) > PUFF_EDGE_FADE) {
          wraps++;
          expect(Math.hypot(puff.position.x - cx, puff.position.z - cz)).toBeGreaterThan(PUFF_WINDOW / 2 - 2);
          expect(fade).toBeLessThan(0.0001);
          expect(previousFade).toBeLessThan(0.0001);
        }
        expect(Math.abs(fade - previousFade)).toBeLessThan(.01);
        previousFade = fade;
      }
      expect(wraps).toBeGreaterThan(0);
      far.dispose();
    }
  });
});
