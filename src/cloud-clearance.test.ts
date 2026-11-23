import { describe, expect, it } from 'vitest';
import { gridPeak } from './land/terrain';
import { footprintPeak, gridCol, gridRow, islandAtCell, meshHeight } from './land/archipelago-layout';
import { cloudProximity01 } from './in-cloud';
import { createDirector, DIRECTOR } from './director';
import { skyEdgeGap } from './bg-cloud-field';

it('accents a deliberate pullout once and leaves automatic leveling quiet', () => {
  const director=createDirector();
  const frame=(dive01:number,pullingUp:boolean)=>director.update(1/60,{dive01,pullingUp,
    bank:0,stall01:0,inCloud01:0,speed01:.9}).traumaHit;
  frame(.9,false);
  expect(frame(.1,true)).toBe(DIRECTOR.HIT_PULL_OUT);
  expect(frame(.08,true)).toBe(0);
  frame(.95,false);
  expect(frame(.1,false)).toBe(0);
});

describe('cloud clearance at final placement', () => {
  it('includes an isolated grid peak between sparse probes and just outside the footprint', () => {
    const vertex=(i:number,j:number)=>i===13 && j===7?98:0;
    expect(gridPeak(10,10,2.1,3,0,0,1,64,vertex)).toBe(98);
    expect(gridPeak(9,10,2.1,3,0,0,1,64,vertex)).toBe(0);
  });
  it('uses the shorter depth of a broad shelf for cloud entry', () => {
    const cloud={x:0,y:60,z:0,halfW:80,halfD:12,halfH:20};
    expect(cloudProximity01({x:35,y:60,z:0},[cloud])).toBe(1);
    expect(cloudProximity01({x:0,y:60,z:35},[cloud])).toBe(0);
  });
  it('bounds triangulated heights on the two ridge routes and across owner cells', () => {
    for(const [x,z] of [[299,-1880],[-673,-7937],[500,-1860]]) {
      const peak=footprintPeak(20261120,x,z,93,71);
      for(let dz=-71;dz<=71;dz+=3) for(let dx=-93;dx<=93;dx+=3) {
        const spec=islandAtCell(20261120,gridCol(x+dx),gridRow(z+dz));
        expect(meshHeight(spec,x+dx,z+dz)).toBeLessThanOrEqual(peak+1e-7);
      }
    }
  });
  it('reserves a visible border across the azimuth seam, allowing separate elevations', () => {
    const a={az:Math.PI-.01,el:.1,w:.2,h:.1}, b={...a,az:-Math.PI+.01};
    expect(skyEdgeGap(a,b)).toBeLessThan(0);
    expect(skyEdgeGap(a,{...b,el:.45})).toBeGreaterThan(.1);
  });
});
