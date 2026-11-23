/** Static composition controls, never animated randomness. Large clouds are
 * accents; smaller companions share a slowly varying condensation level. */
export function puffScaleRole(index: number, seed: number): number {
  const variation=(Math.sin(index*2.37+seed*.81)+1)*.5;
  return index%7===0 ? .92+variation*.08 : index%3===0 ? .68+variation*.1 : .30+variation*.24;
}

const BANK_LEVEL=54, BANK_SWELL=23, BANK_CROSS_SWELL=14;
export const PUFF_BANK_MAX_BASE=BANK_LEVEL+BANK_SWELL+BANK_CROSS_SWELL;

export function puffBankBase(x: number,z: number,seed: number): number {
  return BANK_LEVEL+BANK_SWELL*Math.sin(x/1100+seed*.17)+BANK_CROSS_SWELL*Math.sin(z/850-seed*.31);
}

// Unequal intervals and widths, with a bounded maximum gap. The far bank
// provides low horizon coverage; it should not read as identical hero clouds.
export const DISTANT_BANK_COUNT=24;
const GAPS=[12,19,10,17,13,18,11,16,21,12,14,17,10,18,13,16,12,20,11,17,13,16,12,18];
export function distantBankPlacement(index: number) {
  const total=GAPS.reduce((a,b)=>a+b,0),i=index%GAPS.length;
  const degrees=GAPS.slice(0,i).reduce((a,b)=>a+b,0)*360/total;
  const v=(Math.sin(i*2.17+1)+1)*.5;
  return {
    azimuth:(degrees+4)*Math.PI/180,
    elevation:(1.5+5.5*(Math.sin(i*2.83+.9)+1)*.5)*Math.PI/180,
    halfAngle:(5.5+v*5)*Math.PI/180,
    heightScale:.72+.25*(Math.sin(i*1.31)+1)*.5,
    opacity:.34+.14*v,
  };
}

/** Sparse upper sky, separate from the low horizon bank and fly-through puffs.
 * Uneven bearings/heights avoid a ceiling ring; all positions are world anchored.
 */
const UPPER_SKY = [
  [-12,32,5500,19], [43,45,6200,19], [101,35,6000,22],
  [151,49,5700,20], [208,40,6400,22], [256,34,6100,20], [305,44,5800,21],
  [62,73,4700,18], [188,76,5100,19], [310,71,4900,17],
] as const;
export const UPPER_CLOUD_COUNT = UPPER_SKY.length;
export function upperCloudPlacement(index:number) {
  const [az,el,distance,halfAngle]=UPPER_SKY[index%UPPER_SKY.length];
  const azimuth=az*Math.PI/180,elevation=el*Math.PI/180;
  return {x:Math.sin(azimuth)*Math.cos(elevation)*distance,
    y:70+Math.sin(elevation)*distance,
    z:-Math.cos(azimuth)*Math.cos(elevation)*distance,
    halfWidth:Math.tan(halfAngle*Math.PI/180)*distance};
}
