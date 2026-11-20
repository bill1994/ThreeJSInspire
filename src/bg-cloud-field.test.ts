import {describe,expect,it} from 'vitest';
import * as THREE from 'three';
import {BG_FIELD,bgDistanceOpacity,bgSpotDistance,upperCloudClear,cloudProjection,updateBgSpot,type BgFieldSpot} from './bg-cloud-field';
import {upperCloudPlacement,UPPER_CLOUD_COUNT} from './cloud-composition';
import {layoutClouds} from './bg-cumulus-layout';

describe('world-anchored background clouds',()=>{
  it('prepares a separated upper sky at boot, including the initial climb direction and zenith',()=>{
    const eye=new THREE.Vector3(0,70,30);
    const clouds=Array.from({length:UPPER_CLOUD_COUNT},(_,i)=>{
      const p=upperCloudPlacement(i);
      return {spot:{x:p.x,y:p.y,z:p.z,upper:true,age:3,generation:0},radius:p.halfWidth*.7};
    }).sort((a,b)=>bgSpotDistance(b.spot,eye)-bgSpotDistance(a.spot,eye));
    const accepted:typeof clouds=[];
    for(const c of clouds)if(upperCloudClear(c.spot,c.radius,accepted,eye))accepted.push(c);
    expect(accepted.length).toBe(UPPER_CLOUD_COUNT);
    const elevation=(s:BgFieldSpot)=>Math.atan2(s.y-eye.y,Math.hypot(s.x-eye.x,s.z-eye.z))*180/Math.PI;
    expect(accepted.some(c=>Math.abs(Math.atan2(c.spot.x,-c.spot.z))<.3&&elevation(c.spot)>30)).toBe(true);
    expect(accepted.filter(c=>elevation(c.spot)>65).length).toBe(3);
    for(const c of accepted)expect(bgDistanceOpacity(bgSpotDistance(c.spot,eye))).toBe(1);
  });

  it('keeps overhead clouds anchored when flying directly below them, then recycles behind fog',()=>{
    const spot:BgFieldSpot={x:1000,y:4200,z:-2000,upper:true,age:3,generation:0};
    const eye=new THREE.Vector3(1000,240,-2000);
    expect(updateBgSpot(spot,eye,9,.016)).toBe(false);
    expect(bgDistanceOpacity(bgSpotDistance(spot,eye))).toBe(1);
    expect(spot).toMatchObject({x:1000,y:4200,z:-2000,generation:0});
    eye.x+=16000;
    expect(bgDistanceOpacity(bgSpotDistance(spot,eye))).toBe(0);
    expect(updateBgSpot(spot,eye,9,.016)).toBe(true);
    expect(bgDistanceOpacity(bgSpotDistance(spot,eye))).toBe(0);
    expect(spot.age).toBe(0);
  });

  it('allows distinct elevations at one bearing but rejects coincident upper silhouettes',()=>{
    const eye=new THREE.Vector3(0,70,0);
    const a:BgFieldSpot={x:0,y:3700,z:-3500,age:3,generation:0,upper:true};
    expect(upperCloudClear(a,700,[{spot:{...a},radius:700}],eye)).toBe(false);
    expect(upperCloudClear(a,700,[{spot:{...a,y:800,z:-6000},radius:700}],eye)).toBe(true);
  });
  it('keeps visible clouds fixed while the observer moves',()=>{
    const spot:BgFieldSpot={x:4000,y:900,z:-6000,age:3,generation:0};
    for(let x=0;x<=1000;x+=10) {
      expect(updateBgSpot(spot,new THREE.Vector3(x,70,0),0,1/60)).toBe(false);
      expect([spot.x,spot.y,spot.z]).toEqual([4000,900,-6000]);
    }
    // Different depth means different angular parallax, without moving clouds.
    const angle=(distance:number)=>Math.atan2(-1000,distance);
    expect(Math.abs(angle(6000))).toBeGreaterThan(Math.abs(angle(10000)));
  });

  it('recycles only at zero visibility, and places every replacement behind the fog',()=>{
    const camera=new THREE.Vector3(12000,100,-23000);
    for(let index=0;index<9;index++)for(const [dx,dz] of [[1800,0],[16000,0],[-16000,0],[0,16000],[16000,16000]]) {
      const spot:BgFieldSpot={x:camera.x+dx,y:800,z:camera.z+dz,age:3,generation:0};
      expect(bgDistanceOpacity(Math.hypot(dx,dz))).toBe(0);
      expect(updateBgSpot(spot,camera,index,1/60)).toBe(true);
      const distance=Math.hypot(spot.x-camera.x,spot.z-camera.z);
      expect(distance).toBeGreaterThanOrEqual(BG_FIELD.spawnMin-1e-6);
      expect(distance).toBeLessThanOrEqual(BG_FIELD.spawnMax+1e-6);
      expect(bgDistanceOpacity(distance)).toBe(0);
      expect(spot.age).toBe(0);
      expect(spot.y).toBe(800);
    }
  });

  it('fades smoothly at both boundaries and resets after a teleport',()=>{
    expect(bgDistanceOpacity(7000)).toBe(1);
    expect(bgDistanceOpacity(BG_FIELD.fogEnd-1)).toBeLessThan(.000001);
    expect(bgDistanceOpacity(BG_FIELD.nearHidden+1)).toBeLessThan(.000001);
    const spot:BgFieldSpot={x:5000,y:800,z:5000,age:3,generation:0};
    const camera=new THREE.Vector3(0,70,0);
    expect(updateBgSpot(spot,camera,3,.016,true)).toBe(true);
    expect(bgDistanceOpacity(Math.hypot(spot.x,spot.z))).toBe(0);
    updateBgSpot(spot,camera,3,10);
    expect(spot.age).toBe(.1); // tab resume cannot skip the fade-in
  });

  it('fits all authored cloud spheres and displacement margins inside each card',()=>{
    for(const cloud of layoutClouds(7)) {
      const p=cloudProjection(cloud);
      expect(p.right.dot(p.up)).toBeCloseTo(0);
      expect(p.forward.dot(p.right)).toBeCloseTo(0);
      for(const [x,y,z,r] of cloud.puffs) {
        const c=new THREE.Vector3(x,y-70,z);
        const padding=r+cloud.scale*2;
        const depth=c.dot(p.forward)-padding;
        expect(depth).toBeGreaterThan(0);
        expect((Math.abs(c.dot(p.right))+padding)/depth).toBeLessThanOrEqual(p.halfWidth/p.distance+1e-8);
        expect((Math.abs(c.dot(p.up))+padding)/depth).toBeLessThanOrEqual(p.halfHeight/p.distance+1e-8);
      }
    }
  });
});
