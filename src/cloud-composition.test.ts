import { describe,it,expect } from 'vitest';
import { distantBankPlacement,puffBankBase,puffScaleRole,DISTANT_BANK_COUNT } from './cloud-composition';

describe('cloud composition',()=>{
  it('varies far-bank spacing and silhouette while covering normal horizontal views',()=>{
    const cards=Array.from({length:DISTANT_BANK_COUNT},(_,i)=>distantBankPlacement(i));
    const gaps=cards.map((c,i)=>(cards[(i+1)%cards.length].azimuth-c.azimuth+Math.PI*2)%(Math.PI*2));
    expect(Math.max(...gaps)-Math.min(...gaps)).toBeGreaterThan(.15);
    expect(Math.max(...cards.map(c=>c.halfAngle))-Math.min(...cards.map(c=>c.halfAngle))).toBeGreaterThan(.05);
    // 75% of the card width as a conservative silhouette; 18° portrait view.
    for(let degrees=0;degrees<360;degrees++){
      const a=degrees*Math.PI/180;
      expect(cards.some(c=>Math.abs(Math.atan2(Math.sin(a-c.azimuth),Math.cos(a-c.azimuth)))<9*Math.PI/180+c.halfAngle*.75)).toBe(true);
    }
  });
  it('keeps a minority of large accents even when every base shape hits the altitude size cap',()=>{
    const sizes=Array.from({length:25},(_,i)=>puffScaleRole(i,7));
    expect(sizes.filter(s=>s>.9).length).toBe(4);
    expect(Math.max(...sizes)/Math.min(...sizes)).toBeGreaterThan(2);
    expect(sizes.every(s=>s>0&&s<=1)).toBe(true);
  });
  it('gives neighbouring clouds a coherent base without a flat global row',()=>{
    for(let x=-1800;x<1800;x+=50){
      expect(Math.abs(puffBankBase(x+100,500,7)-puffBankBase(x,500,7))).toBeLessThan(3);
    }
    expect(Math.abs(puffBankBase(-1400,800,7)-puffBankBase(1400,-800,7))).toBeGreaterThan(10);
  });
});
