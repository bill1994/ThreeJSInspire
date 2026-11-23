import {describe,expect,it} from 'vitest';
import {SkimField} from './sea/skim-field';
import {createFlightState,stepFlight} from './game';
import {harbourSite} from './land/boathouse';
import {islandAtCell,meshHeight} from './land/archipelago-layout';
import {generate} from './land/archipelago-data';

describe('continuous flight and water',()=>{
  it('lets a forward command end the suspended apex',()=>{
    const state=createFlightState(70);
    for(let i=0;i<500 && state.phase!=='hover';i++)stepFlight(state,1/60,{x:0,y:-1});
    expect(state.phase).toBe('hover');
    for(let i=0;i<10;i++)stepFlight(state,1/60,{x:0,y:.8});
    expect(state.phase).toBe('pushover');
    expect(state.speed).toBeGreaterThan(0);
  });
  it('pulls the nose up progressively before the sea cushion',()=>{
    const s=createFlightState(110);
    let maximumPitch=-Infinity,atCushion=0;
    for(let i=0;i<300;i++){
      stepFlight(s,1/60,{x:0,y:1});
      maximumPitch=Math.max(maximumPitch,-s.pitch);
      if(s.pos.y<18){atCushion=-s.pitch;break;}
    }
    expect(maximumPitch).toBeGreaterThan(1);
    expect(atCushion).toBeLessThan(.7);
  });
  it('deposits only in water and releases a sleeping or teleported field',()=>{
    const f=new SkimField();
    for(let i=0;i<20;i++)f.update(1/30,{x:0,z:-i,skim:1},x=>x>0?10:-10);
    const pixels=f.texture.image.data as Uint8Array;
    let waterSlope=0;
    for(let j=1;j<95;j++)for(let i=1;i<95;i++){
      const k=(i+96*j)*4;
      if(f.origin.x+(i+.5)*1.5>0)expect(pixels[k+3]).toBe(0);
      else waterSlope+=Math.abs(pixels[k]-128);
    }
    expect(waterSlope).toBeGreaterThan(0);
    for(let i=0;i<75;i++)f.update(1/30,{x:4000,z:0,skim:0});
    expect(pixels.every(v=>v===0)).toBe(true);
    f.texture.dispose();
  });
});

describe('streamed shoreline',()=>{
  it('regenerates valid dry buildings and submerged dock tips across seeds',()=>{
    for(const seed of [20261120,991,7261]){
      const s=islandAtCell(seed,0,-2);
      const packet=generate({key:s.id,spec:s});
      if(packet.kind!=='island')throw Error('expected island');
      const site=packet.harbour;
      expect(site).toEqual(harbourSite(s,packet.trees));
      expect(site).toBeTruthy();
      expect(meshHeight(s,site!.x,site!.z)).toBeGreaterThan(0);
      expect(meshHeight(s,site!.x+26*Math.sin(site!.yaw),site!.z+26*Math.cos(site!.yaw))).toBeLessThan(0);
      expect(packet.depth.length).toBe(packet.mask.length);
    }
  });
});
