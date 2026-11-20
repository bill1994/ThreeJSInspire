import { describe, expect, it } from 'vitest';
import { CloudArrivalGate, OffscreenCloudGate, cloudViewTest, cloudArrivalClear } from './cloud-arrival';
import * as THREE from 'three';

describe('offscreen cloud preparation', () => {
  it('does not admit a cloud above the screen while its mirrored silhouette is visible on the water', () => {
    const camera=new THREE.PerspectiveCamera(60,.6,.1,2000);
    camera.position.set(0,60,0);camera.lookAt(0,-640,-1000);
    const cloud=new THREE.Vector3(0,600,-1000);
    expect(cloudViewTest(camera)(cloud,50)).toBe(true);
    expect(cloudViewTest(camera,true)(cloud,50)).toBe(false);
    expect(cloudViewTest(camera,true)(new THREE.Vector3(2000,600,-1000),50)).toBe(true);
  });
  it('blocks all new onscreen clouds, prepares offscreen clouds immediately, and retains them through a turn', () => {
    const gate=new OffscreenCloudGate(), a={},b={};
    for(let i=0;i<600;i++) expect(gate.update(a,1,true,false)).toBe(0);
    expect(gate.update(a,1,true,true)).toBe(1);
    expect(gate.update(a,1,false,false)).toBe(1);
    expect(gate.update(b,1,false,true)).toBe(0);
    gate.reset(a);
    expect(gate.update(a,1,true,false)).toBe(0);
  });
  it('keeps partially visible silhouettes inside and ignores the bg world far distance', () => {
    const camera=new THREE.PerspectiveCamera(60,.6,.1,2000);
    const outside=cloudViewTest(camera);
    expect(outside(new THREE.Vector3(400,0,-1000),100)).toBe(false);
    expect(outside(new THREE.Vector3(1000,0,-1000),100)).toBe(true);
    expect(outside(new THREE.Vector3(0,0,-15000),500)).toBe(false);
    expect(outside(new THREE.Vector3(0,0,1000),100)).toBe(true);
    camera.rotation.y=Math.PI;
    expect(cloudViewTest(camera)(new THREE.Vector3(0,0,-1000),100)).toBe(true);
  });
});

describe('cloud arrivals', () => {
  it('admits at most one cloud per interval and ramps opacity over four seconds', () => {
    const gate = new CloudArrivalGate(), keys = Array.from({length: 20}, () => ({}));
    const born = new Map<object, number>();
    const previous = keys.map(() => 0);
    for (let frame = 0; frame < 600; frame++) {
      gate.begin(1/60);
      keys.forEach((key, i) => {
        const value = gate.update(key, 1, 1/60, true);
        if (value > 0 && !born.has(key)) born.set(key, frame);
        expect(value - previous[i]).toBeLessThanOrEqual(1/240 + 1e-9);
        previous[i] = value;
      });
    }
    const frames = [...born.values()];
    expect(frames.length).toBeGreaterThan(5);
    for (let i=1;i<frames.length;i++) expect(frames[i]-frames[i-1]).toBeGreaterThanOrEqual(54);
    expect(previous[0]).toBe(1);
  });
  it('blocks new overlaps without hiding an existing cloud; recycling fades in again', () => {
    const gate = new CloudArrivalGate(), a={}, b={};
    gate.begin(.1);
    expect(gate.update(a,1,.1,true)).toBeCloseTo(.025);
    expect(gate.update(a,1,.1,false)).toBeCloseTo(.05);
    for(let i=0;i<20;i++) gate.begin(.1);
    expect(gate.update(b,1,.1,false)).toBe(0);
    gate.reset(a);
    expect(gate.update(a,1,.1,true)).toBeCloseTo(.025);
    expect(gate.update(a,0,.1,true)).toBe(0);
    expect(gate.active(a)).toBe(false);
  });
  it('rejects physical collisions and same-bearing silhouettes, including across the angle seam', () => {
    expect(cloudArrivalClear({x:0,z:1000,radius:100},[{x:0,z:2000,radius:100}],0,0)).toBe(false);
    expect(cloudArrivalClear({x:5,z:-1000,radius:100},[{x:-5,z:-1000,radius:100}],0,0)).toBe(false);
    expect(cloudArrivalClear({x:0,z:1000,radius:100},[{x:1000,z:0,radius:100}],0,0)).toBe(true);
  });
});
