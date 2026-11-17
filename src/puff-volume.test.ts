import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildPuffVolumeData, puffDensitySample, puffOpticalAlpha, puffPaintJs, PUFF_VOLUME } from './puff-volume';
import { parsePuffLook } from './qa';
import { buildPuffGeometry, mulberry32, type PuffLobe } from './puff-shape';

describe('puff volume density', () => {
  const sphere: PuffLobe = { inverse: new THREE.Matrix4().toArray(), radius: 10, index: 0 };
  it('fills the centre, feathers the edge, and leaves air empty', () => {
    expect(puffDensitySample(0,0,0,[sphere])[3]).toBe(1);
    expect(puffDensitySample(9.5,0,0,[sphere])[3]).toBeGreaterThan(0);
    expect(puffDensitySample(9.5,0,0,[sphere])[3]).toBeLessThan(1);
    expect(puffDensitySample(12,0,0,[sphere])[3]).toBe(0);
  });
  it('overlapping lobes are one density field, without internal walls or doubled density', () => {
    const second = { ...sphere, inverse: new THREE.Matrix4().makeTranslation(-8,0,0).toArray() };
    for (let x=0;x<=8;x+=.5) expect(puffDensitySample(x,0,0,[sphere,second])[3]).toBe(1);
  });
  it('keeps smooth normals independent of lobe order after the allocation-free bake optimization', () => {
    const second = { ...sphere, inverse: new THREE.Matrix4().makeTranslation(-8,0,0).toArray() };
    for(const p of [[1,2,3],[7,-4,1],[4,6,-3]]) {
      const a=puffDensitySample(p[0],p[1],p[2],[sphere,second]);
      const b=puffDensitySample(p[0],p[1],p[2],[second,sphere]);
      a.forEach((v,i)=>expect(v).toBeCloseTo(b[i],12));
    }
  });
  it('carries translation and non-uniform scale through the inverse lobe transform', () => {
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(30,5,-20),new THREE.Quaternion(),new THREE.Vector3(2,1,.5));
    const lobe = { ...sphere, inverse:matrix.invert().toArray() };
    expect(puffDensitySample(30,5,-20,[lobe])[3]).toBe(1);
    expect(puffDensitySample(30,5,-27,[lobe])[3]).toBe(0);
    expect(puffDensitySample(43,5,-20,[lobe])[3]).toBe(1);
  });
  it('builds a bounded texture from the same deterministic cloud layout with a zero border', async () => {
    const geo = await buildPuffGeometry(mulberry32(3));
    const {data,resolution:n} = buildPuffVolumeData(geo,12);
    expect(data.length).toBe(12**3*4);
    let full=0;
    for(let z=0;z<n;z++)for(let y=0;y<n;y++)for(let x=0;x<n;x++) {
      const a=data[((z*n+y)*n+x)*4+3];
      if(!x||!y||!z||x===n-1||y===n-1||z===n-1)expect(a).toBe(0);
      if(a===255)full++;
    }
    expect(full).toBeGreaterThan(20);
    geo.dispose();
  });
  it('keeps the production default unchanged unless explicitly selected', () => {
    expect(parsePuffLook(null)).toBe('legacy');
    expect(parsePuffLook('bad')).toBe('legacy');
    expect(parsePuffLook('volume')).toBe('volume');
  });
});

describe('puff opacity and painted colour', () => {
  it('makes a thin cloud opaque from outside while preserving the accepted core attenuation', () => {
    expect(puffOpticalAlpha(1,5,0)).toBeGreaterThan(.85);
    expect(puffOpticalAlpha(1,5,1)).toBeCloseTo(1-Math.exp(-.13*5),12);
    expect(puffOpticalAlpha(0,5,0)).toBe(0);
    expect(puffOpticalAlpha(1,0,0)).toBe(0);
    expect(puffOpticalAlpha(1,5,.5)).toBeGreaterThan(puffOpticalAlpha(1,5,1));
    expect(puffOpticalAlpha(1,5,.5)).toBeLessThan(puffOpticalAlpha(1,5,0));
  });
  it('keeps uniform-density optical thickness independent of the quality step count', () => {
    for(const steps of [PUFF_VOLUME.stepsLow, PUFF_VOLUME.stepsHigh]) {
      const perStep=puffOpticalAlpha(.6,12/steps,.4);
      expect(1-(1-perStep)**steps).toBeCloseTo(puffOpticalAlpha(.6,12,.4),12);
    }
  });
  it('uses the bg-cloud hard light boundary, with haze tint independent of opacity', () => {
    const bands = [[.1,.1,.2],[.2,.2,.3],[.4,.3,.3],[.8,.7,.5]] as const;
    const haze = [1,.4,.2] as const;
    const shade = puffPaintJs(.55,.25,1,1,bands,haze);
    const lit = puffPaintJs(.60,.25,1,1,bands,haze);
    const middle = puffPaintJs(.575,.25,1,1,bands,haze);
    for(let i=0;i<3;i++) {
      expect(shade[i]).toBeCloseTo(bands[1][i]+(haze[i]-bands[1][i])*PUFF_VOLUME.paintAtmosphere,12);
      expect(lit[i]).toBeCloseTo(bands[3][i]+(haze[i]-bands[3][i])*PUFF_VOLUME.paintAtmosphere,12);
      expect(middle[i]).toBeCloseTo((shade[i]+lit[i])*.5,12);
    }
  });
});
