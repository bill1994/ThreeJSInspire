import { lerpTrackStates, srgbToLinear, type SkyTrackState, type Vec3 } from './sky-track';

/** Art direction above the original sky track, below explicit user overrides.
 * Shared by sky, cloud palettes, sea reflection/haze and aircraft lighting.
 * Keep exposure, wave geometry and scattering parameters on their existing tracks. */
interface GradeKey {
  el: number;
  sky: readonly [string,string,string,string];
  clouds: readonly [string,string,string,string];
  away: string;
  awayGain: number;
  key: readonly [string,number];
  ambient: readonly [string,string,number];
}
const KEYS: readonly GradeKey[] = [
  {el:-8,sky:['#805769','#63526c','#424b70','#303959'],clouds:['#243149','#35455e','#4a5f79','#667b94'],
    away:'#1c263d',awayGain:0.2,key:['#b5c9e3',0.75],ambient:['#a0b6d0','#455971',0.9]},
  {el:-4,sky:['#a26e72','#8b6b86','#606a8a','#414d70'],clouds:['#4e526e','#72738b','#a68f9d','#b9a0aa'],
    away:'#4c5875',awayGain:0.4,key:['#d9b8bd',0.9],ambient:['#a2a9c2','#394f65',0.8]},
  {el:0,sky:['#e7b697','#9fbbd0','#719abb','#4d80a8'],clouds:['#748499','#9aa9b9','#c7cbcb','#eddbc1'],
    away:'#6ea9ce',awayGain:0.85,key:['#ffe1bf',1.3],ambient:['#aabfd0','#42586a',0.7]},
  {el:7,sky:['#edaa80','#b690a0','#7e85a7','#596d9d'],clouds:['#766f85','#a394a4','#d0b3b6','#f0d3ad'],
    away:'#7b94ac',awayGain:0.4,key:['#ffdab0',1.65],ambient:['#a5aec9','#3c5364',0.72]},
  {el:30,sky:['#b4d3dc','#8bbfd4','#6ba6c7','#508bb3'],clouds:['#6b819a','#94aaba','#c6d2d4','#eee7d6'],
    away:'#9dbdce',awayGain:0.2,key:['#fff1d9',1.65],ambient:['#acc7da','#456176',0.65]},
  {el:65,sky:['#9ccbdc','#75b4d2','#5094bf','#387aac'],clouds:['#667c96','#8ea7b8','#c2d1d2','#ece7d8'],
    away:'#8abbd0',awayGain:0.18,key:['#fff4df',1.9],ambient:['#adc8d8','#4b6b7c',0.65]},
];
const ramp = (colors: GradeKey['sky']) => colors.map(srgbToLinear) as [Vec3,Vec3,Vec3,Vec3];
const patches = KEYS.map(k => ({
  dayStops:ramp(k.sky), cloudBands:ramp(k.clouds),
  cloudHaze:srgbToLinear(k.el===-8?'#26304f':k.sky[0]), awayColor:srgbToLinear(k.away),
  awayGain:k.awayGain,
  sunLightColorCss:k.key[0], sunLightIntensity:k.key[1],
  hemiSkyCss:k.ambient[0], hemiGroundCss:k.ambient[1], hemiIntensity:k.ambient[2],
  veilCool:srgbToLinear(k.clouds[2]), veilWarm:srgbToLinear(k.clouds[3]),
}));

export function applySceneGrade(base: SkyTrackState, elevation: number, enabled=true): SkyTrackState {
  if(!enabled)return base;
  const el=Number.isFinite(elevation)?elevation:-8;
  let i=0;
  while(i<KEYS.length-2 && el>KEYS[i+1].el)i++;
  const t=Math.min(1,Math.max(0,(el-KEYS[i].el)/(KEYS[i+1].el-KEYS[i].el)));
  return lerpTrackStates({...base,...patches[i]}, {...base,...patches[i+1]}, t*t*(3-2*t));
}
