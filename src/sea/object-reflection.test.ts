import * as THREE from 'three';
import { describe,expect,it,vi } from 'vitest';
import { initObjectReflection,mirrorWaterCamera,waterReflectables } from './object-reflection';

describe('local water reflection',()=>{
  it('owns a separate puff reflection material, refreshes style changes, and never disposes the live cloud material',async()=>{
    const {MeshBasicNodeMaterial}=await import('three/webgpu');
    const {vec4}=await import('three/tsl');
    const material=new MeshBasicNodeMaterial();material.fragmentNode=vec4(1,1,1,1);
    const liveDispose=vi.spyOn(material,'dispose'), scene=new THREE.Scene(),puffs=new THREE.Group();puffs.name='puff-field';scene.add(puffs);
    const puff=new THREE.Mesh(new THREE.BoxGeometry(),material);puff.name='puff-0';puffs.add(puff);
    const camera=new THREE.PerspectiveCamera();camera.position.y=60;
    let capture:THREE.Scene|undefined;
    const renderer={autoClear:true,xr:{enabled:false},getDrawingBufferSize:(s:THREE.Vector2)=>s.set(450,800),
      getRenderTarget:()=>null,getActiveCubeFace:()=>0,getActiveMipmapLevel:()=>0,setRenderTarget:vi.fn(),getMRT:()=>null,setMRT:vi.fn(),
      getClearAlpha:()=>1,getClearColor:(c:THREE.Color)=>c.set(0),setClearColor:vi.fn(),render:(s:THREE.Scene)=>{capture=s;}};
    const r=await initObjectReflection(renderer);r.update(scene,camera,1);
    const copy=capture!.getObjectByName('puff-0') as THREE.Mesh;
    expect(copy.material).not.toBe(material);expect(copy.geometry).toBe(puff.geometry);
    const reflectedDispose=vi.spyOn(copy.material as THREE.Material,'dispose');
    r.setPuffSoftness(false);r.update(scene,camera,1);expect(r.captures).toBe(2);
    puffs.visible=false;r.update(scene,camera,2);expect(reflectedDispose).toHaveBeenCalledOnce();
    r.dispose();expect(liveDispose).not.toHaveBeenCalled();
  });
  it('selects visible aircraft, puffs and opt-in terrain, excluding water and hidden ancestors',()=>{
    const scene=new THREE.Scene(), plane=new THREE.Group(),puffs=new THREE.Group(),land=new THREE.Group();
    plane.name='porco_root';puffs.name='puff-field';land.userData.waterReflect=true;
    const make=(root:THREE.Object3D,name:string)=>{const m=new THREE.Mesh();m.name=name;root.add(m);return m;};
    const a=make(plane,'wing'),b=make(puffs,'puff-0'),c=make(land,'coast');
    make(land,'sea-r0');make(scene,'sky');scene.add(plane,puffs,land);
    expect(waterReflectables(scene)).toEqual([a,b,c]);
    puffs.visible=false;expect(waterReflectables(scene)).toEqual([a,c]);
  });
  it('mirrors the full camera pose and keeps standard depth projection',()=>{
    const source=new THREE.PerspectiveCamera(60,.6,.1,2000),mirror=new THREE.PerspectiveCamera();
    source.position.set(30,40,50);source.lookAt(-20,10,-200);
    mirrorWaterCamera(source,mirror);
    expect(mirror.position.toArray()).toEqual([30,-40,50]);
    const d=source.getWorldDirection(new THREE.Vector3());d.y=-d.y;
    expect(mirror.getWorldDirection(new THREE.Vector3()).distanceTo(d)).toBeLessThan(1e-10);
    expect(mirror.projectionMatrix.elements).toEqual(source.projectionMatrix.elements);
    expect(mirror.projectionMatrixInverse.elements).toEqual(source.projectionMatrixInverse.elements);
  });
  it('bounds resolution and refresh rate, disables capture and restores state even after failure',async()=>{
    let rt:unknown={name:'main'},mrt:unknown={name:'mrt'},alpha=.7;
    const original=rt,originalMrt=mrt,color=new THREE.Color('#123456');
    const renderer={autoClear:false,xr:{enabled:true},coordinateSystem:THREE.WebGPUCoordinateSystem,
      getDrawingBufferSize:(s:THREE.Vector2)=>s.set(1200,2000),getRenderTarget:()=>rt,getActiveCubeFace:()=>2,getActiveMipmapLevel:()=>1,
      setRenderTarget:(v:unknown)=>{rt=v;},getMRT:()=>mrt,setMRT:(v:unknown)=>{mrt=v;},
      getClearAlpha:()=>alpha,getClearColor:(c:THREE.Color)=>c.copy(color),setClearColor:(c:THREE.Color|number,a:number)=>{color.set(c);alpha=a;},render:vi.fn()};
    const r=await initObjectReflection(renderer),scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera();camera.position.y=40;
    r.update(scene,camera,0);expect(r.captures).toBe(1);expect(r.resolution).toEqual([307,512]);
    r.update(scene,camera,.01);expect(r.captures).toBe(1);
    r.setQuality(false);r.update(scene,camera,.02);expect(r.resolution).toEqual([154,256]);
    r.setEnabled(false);r.update(scene,camera,1);expect(r.captures).toBe(2);expect(r.enabled.value).toBe(0);
    r.setEnabled(true);renderer.render.mockImplementationOnce(()=>{throw new Error('capture failed');});
    expect(()=>r.update(scene,camera,2)).toThrow('capture failed');
    expect(rt).toBe(original);expect(mrt).toBe(originalMrt);expect(alpha).toBe(.7);expect(color.getHexString()).toBe('123456');
    expect(renderer.autoClear).toBe(false);expect(renderer.xr.enabled).toBe(true);r.dispose();
  });
});
