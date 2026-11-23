import { describe, expect, it } from 'vitest';
import { generate } from './archipelago-data';
import { islandAtCell, meshHeight } from './archipelago-layout';
import { lighthouseSite, PLATFORM_RADIUS, PLATFORM_BOTTOM } from './lighthouse';

describe('offshore lighthouse', () => {
  it.each([20261120,991,7261])('rebuilds a submerged foundation near shore and clear of the dock for seed %i',seed=>{
    const spec=islandAtCell(seed,0,-2), packet=generate({key:spec.id,spec});
    if(packet.kind!=='island' || !packet.lighthouse || !packet.harbour) throw Error('missing coastal landmarks');
    const site=packet.lighthouse;
    expect(lighthouseSite(spec,packet.harbour)).toEqual(site);
    expect(Math.hypot(site.x-packet.harbour.x,site.z-packet.harbour.z)).toBeGreaterThanOrEqual(95);
    expect(site.y).toBe(0);
    expect(meshHeight(spec,site.x-65*Math.sin(site.yaw),site.z-65*Math.cos(site.yaw))).toBeGreaterThanOrEqual(1);
    for(let j=0;j<32;j++){
      const a=j*Math.PI/16;
      const h=meshHeight(spec,site.x+PLATFORM_RADIUS*Math.cos(a),site.z+PLATFORM_RADIUS*Math.sin(a));
      expect(h).toBeGreaterThan(PLATFORM_BOTTOM);
      expect(h).toBeLessThan(-1.9);
    }
    expect(meshHeight(spec,site.x+55*Math.sin(site.yaw),site.z+55*Math.cos(site.yaw))).toBeLessThanOrEqual(-1);
  });
  it('leaves smaller islands without towers',()=>{
    expect(lighthouseSite(islandAtCell(20261120,0,0),null)).toBeNull();
  });
});
