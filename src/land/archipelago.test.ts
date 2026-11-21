import {describe, expect, it} from 'vitest';
import {buffers, generate} from './archipelago-data';
import {gridCol, gridRow, islandAtCell, meshHeight, shoreRadius} from './archipelago-layout';

const seed = 20261120;
describe('archipelago', () => {
  it('keeps all adjacent shorelines within the navigation envelope across signed districts', () => {
    for (let j = -26; j <= 26; j++) for (let i = -26; i <= 26; i++) {
      const a = islandAtCell(seed,i,j);
      for (const [col,row] of [[i+1,j],[i,j+1]]) {
        const b = islandAtCell(seed,col,row);
        if (a.id === b.id) continue;
        const distance = Math.hypot(a.x-b.x,a.z-b.z);
        expect(distance-a.radius-b.radius).toBeGreaterThanOrEqual(250);
        const angle = Math.atan2(b.z-a.z,b.x-a.x);
        expect(distance-shoreRadius(a,angle)-shoreRadius(b,angle+Math.PI)).toBeLessThanOrEqual(800);
      }
      expect(islandAtCell(seed,gridCol(a.x),gridRow(a.z))).toEqual(a);
    }
  });
  it('rebuilds identical terrain and trees after a revisit; safety matches uploaded triangles', () => {
    const spec = islandAtCell(seed,0,-2), job = {key:spec.id,spec,painted:true};
    const p = generate(job), q = generate(job);
    if (p.kind !== 'island' || q.kind !== 'island') throw Error('missing island');
    expect(p.trees).toEqual(q.trees);
    expect(p.cover?.anchors.length).toBeGreaterThan(0);
    const other = buffers(q).map(b => new Uint8Array(b));
    expect(buffers(p).every((b,i)=>new Uint8Array(b).every((v,j)=>v === other[i][j]))).toBe(true);
    expect(buffers(p).reduce((s,b)=>s+b.byteLength,0)).toBeLessThan(256*1024);
    for(let i=0;i<p.full.index.length;i+=159){
      let x=0,y=0,z=0;
      for(const v of p.full.index.slice(i,i+3)) {
        x+=p.full.position[3*v]/3; y+=p.full.position[3*v+1]/3; z+=p.full.position[3*v+2]/3;
      }
      expect(meshHeight(spec,x,z)).toBeCloseTo(y,3);
    }
  });
  it('builds a three-small one-large fixture and repeatable grass tiles', () => {
    expect([[0,0],[1,0],[-1,-1],[0,-2]].map(([x,z])=>islandAtCell(seed,x,z).kind)).toEqual(['small','small','small','large']);
    const spec = islandAtCell(seed,0,0), job = {key:'tile',spec,tile:[0,-12] as [number,number]};
    const a=generate(job), b=generate(job);
    if (a.kind !== 'grass' || b.kind !== 'grass') throw Error('missing grass');
    expect(a.matrices.length).toBeGreaterThan(0);
    expect(a.matrices).toEqual(b.matrices);
  });
});
