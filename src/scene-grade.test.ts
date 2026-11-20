import {describe,it,expect} from 'vitest';
import {applySceneGrade} from './scene-grade';
import {applyTrackPatch,skyTrackAt,REFERENCE_ELEVATION_DEG} from './sky-track';
import {skyColorJs} from './sky-color-js';
import {sunDirectionFromAzEl} from './horizon';
import {SUN_DIRECTION} from './palettes';

describe('shared scene grade',()=>{
  it('keeps the graded sky outside the sun disc below the existing bloom budget',()=>{
    const reference=skyTrackAt(REFERENCE_ELEVATION_DEG).preetham;
    for(const el of [-8,-4,-2,0,3,7,15,30,45,65]){
      const state=applySceneGrade(skyTrackAt(el),el),sun=sunDirectionFromAzEl(12,el);
      for(let az=0;az<360;az+=10)for(let up=0;up<=80;up+=5){
        const rgb=skyColorJs(sunDirectionFromAzEl(az,up),sun,state,SUN_DIRECTION,reference,false);
        expect(rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722).toBeLessThan(state.bloomThreshold);
      }
    }
  });
  it('keeps comparison exact and leaves explicit color overrides in control',()=>{
    const base=skyTrackAt(65),snapshot=structuredClone(base);
    expect(applySceneGrade(base,65,false)).toBe(base);
    const graded=applySceneGrade(base,65);
    expect(base).toEqual(snapshot);
    const override=applyTrackPatch(graded,{sunLightIntensity:2,cloudHaze:[0.1,0.2,0.3]});
    expect(override.sunLightIntensity).toBe(2);
    expect(override.cloudHaze).toEqual([0.1,0.2,0.3]);
    expect(override.cloudBands).toEqual(graded.cloudBands);
  });
  it('preserves scattering, exposure, stars, moon/night blending and the night sky',()=>{
    for(const el of [-90,-8,-4,0,7,15,30,45,65,90]){
      const base=skyTrackAt(el),graded=applySceneGrade(base,el);
      for(const key of ['preetham','floorLinear','bloomThreshold','starOpacity','nightWeight','nightStops','discGain','sunTint'] as const)
        expect(graded[key]).toEqual(base[key]);
    }
  });
  it('keeps cloud tonal ordering and continuous color at every grade key',()=>{
    const luminance=(c:readonly number[])=>c[0]*.2126+c[1]*.7152+c[2]*.0722;
    for(let el=-90;el<=90;el+=.5){
      const s=applySceneGrade(skyTrackAt(el),el);
      for(let i=1;i<4;i++)expect(luminance(s.cloudBands[i])).toBeGreaterThan(luminance(s.cloudBands[i-1]));
      for(const c of [...s.dayStops,...s.cloudBands,s.cloudHaze])for(const v of c){
        expect(Number.isFinite(v)).toBe(true);expect(v).toBeGreaterThanOrEqual(0);expect(v).toBeLessThanOrEqual(1);
      }
    }
    for(const el of [-8,-4,0,7,30,65]){
      const a=applySceneGrade(skyTrackAt(el-1e-4),el-1e-4),b=applySceneGrade(skyTrackAt(el+1e-4),el+1e-4);
      for(let i=0;i<4;i++)for(let k=0;k<3;k++){
        expect(Math.abs(a.dayStops[i][k]-b.dayStops[i][k])).toBeLessThan(1e-6);
        expect(Math.abs(a.cloudBands[i][k]-b.cloudBands[i][k])).toBeLessThan(1e-6);
      }
    }
  });
});
