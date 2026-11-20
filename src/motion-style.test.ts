import {describe,it,expect} from 'vitest';
import * as THREE from 'three';
import {initFeel} from './feel';
import {initStreaks} from './wind-streaks';

const context=(t:number,bank=0)=>({speed01:.3,bank,leftTip:{x:-4,y:70,z:-46*t},rightTip:{x:4,y:70,z:-46*t}});
const ribbon=(scene:THREE.Scene)=>scene.getObjectByName('porco_contrail_l') as THREE.Mesh;

describe('continuous trail motion',()=>{
  it('feathers and breaks up the water wake, then lets old foam expire after climbing',()=>{
    const scene=new THREE.Scene(),feel=initFeel(scene,true);
    const mesh=scene.getObjectByName('porco_skim_wake') as THREE.Mesh;
    const ctx=(t:number,skim=1)=>({...context(t),skim01:skim,leftTip:{x:-4,y:7,z:-46*t},rightTip:{x:4,y:7,z:-46*t}});
    for(let i=1;i<=120;i++)feel.update(1/60,ctx(i/60));
    const pos=mesh.geometry.getAttribute('position'),col=mesh.geometry.getAttribute('color');
    const n=mesh.geometry.drawRange.count/6+1;
    const offsets=Array.from({length:n},(_,i)=>(pos.getX(i*2)+pos.getX(i*2+1))/2);
    const alphas=Array.from({length:n},(_,i)=>col.getW(i*2));
    expect(Math.max(...offsets)-Math.min(...offsets)).toBeGreaterThan(.1);
    expect(Math.max(...alphas)).toBeGreaterThan(.02);
    expect(Math.max(...alphas)).toBeLessThan(.21);
    expect(alphas.filter(a=>a<.005).length).toBeGreaterThan(3);
    expect((mesh.material as THREE.MeshBasicMaterial).map).toBeTruthy();
    for(let i=0;i<n*2;i++)expect(pos.getY(i)).toBeCloseTo(.6,5);
    feel.update(1/60,ctx(2+1/60,0));
    expect(mesh.geometry.drawRange.count).toBeGreaterThan(0);
    expect(Array.from({length:mesh.geometry.drawRange.count/6+1},(_,i)=>col.getW(i*2)).some(a=>a>.005)).toBe(true);
    for(let i=2;i<=90;i++)feel.update(1/60,ctx(2+i/60,0));
    expect(mesh.geometry.drawRange.count).toBe(0);feel.dispose();
  });
  it('adds bounded drift while keeping fresh samples anchored and buffers fixed',()=>{
    const scene=new THREE.Scene(),feel=initFeel(scene,true),mesh=ribbon(scene);
    const pos=mesh.geometry.getAttribute('position'),array=pos.array;
    for(let i=1;i<=180;i++)feel.update(1/60,context(i/60,.5));
    const n=mesh.geometry.drawRange.count/6+1;
    expect(Math.abs((pos.getX(0)+pos.getX(1))/2+4)).toBeLessThan(.02);
    const offsets=Array.from({length:n},(_,i)=>Math.abs((pos.getX(i*2)+pos.getX(i*2+1))/2+4));
    expect(Math.max(...offsets)).toBeGreaterThan(.3);
    expect(Math.max(...offsets)).toBeLessThanOrEqual(1.11);
    expect(pos.array).toBe(array);
    for(const v of array)expect(Number.isFinite(v)).toBe(true);
    feel.dispose();
  });
  it('does not relight existing samples when a turn begins, and expires stopped emissions',()=>{
    const scene=new THREE.Scene(),feel=initFeel(scene,true),mesh=ribbon(scene);
    for(let i=1;i<=120;i++)feel.update(1/60,context(i/60));
    const color=mesh.geometry.getAttribute('color');const before=color.getW(20);
    feel.update(.001,context(2.001,1));
    expect(color.getW(20)).toBeLessThanOrEqual(before*1.01);
    for(let i=0;i<110;i++)feel.update(1/60,{...context(2.001),speed01:0});
    expect(mesh.geometry.drawRange.count).toBe(0);feel.dispose();
  });
  it('clears discontinuous travel instead of connecting a kilometre-long ribbon',()=>{
    const scene=new THREE.Scene(),feel=initFeel(scene,true),mesh=ribbon(scene);
    for(let i=1;i<60;i++)feel.update(1/60,context(i/60,.5));
    feel.update(1/60,context(100,.5));
    expect(mesh.geometry.drawRange.count).toBe(0);
    feel.dispose();
  });
});

describe('peripheral wind particles',()=>{
  it('keeps the centre clear in a rolled portrait camera, fades at recycle and responds to night/cloud',()=>{
    const scene=new THREE.Scene(),fx=initStreaks(scene,true);
    const input={origin:{x:0,y:70,z:0},forward:{x:0,y:0,z:-1},right:{x:0,y:1,z:0},up:{x:1,y:0,z:0},
      halfHeight:.58,aspect:.5625,speed:46,speed01:1,daylight01:1,cloud01:0};
    const points=scene.getObjectByName('porco_streaks') as THREE.Points;
    const pos=points.geometry.getAttribute('position'),colors=points.geometry.getAttribute('color'),array=pos.array;
    for(let i=0;i<180;i++)fx.update(1/60,input);
    let visible=0;
    for(let i=0;i<pos.count;i++){
      const depth=-pos.getZ(i),edge=Math.max(Math.abs(pos.getY(i)-70)/input.aspect,Math.abs(pos.getX(i)))/(depth*.58);
      const a=colors.getW(i);expect(Number.isFinite(a)).toBe(true);
      if(a>0){visible++;expect(edge).toBeGreaterThan(.7);expect(edge).toBeLessThan(1.3);expect(depth).toBeGreaterThan(1);expect(depth).toBeLessThan(40);}
    }
    expect(visible).toBeGreaterThan(0);expect(pos.array).toBe(array);
    const mat=points.material as THREE.PointsMaterial,day=mat.opacity;
    fx.update(0,{...input,daylight01:0});expect(mat.opacity).toBeLessThan(day*.5);
    fx.update(0,{...input,cloud01:1});expect(mat.opacity).toBeLessThan(day*.2);
    fx.dispose();
  });
});
