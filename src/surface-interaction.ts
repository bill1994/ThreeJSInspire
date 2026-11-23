import { MathUtils, Vector3 } from 'three';

// QA can isolate any one treatment on the same flight.
const selection = new URLSearchParams(typeof location === 'undefined' ? '' : location.search).get('surfacefx');
export function surfaceEffect(name: string) {
  return selection === null || selection === 'all' || selection.split(',').includes(name);
}

export class FloatContact extends Vector3 {
  strength = 0;
  sampleWater(time: number, skim: number, ground?: (x: number, z: number) => number) {
    // Approximate short chop. The simulation's protected skim altitude is 7 m.
    const water = .24 * Math.sin(this.x * .13 + this.z * .09 - time * 1.8);
    this.strength = skim * (1 - MathUtils.smoothstep(this.y - water, 4.65, 7.1));
    if (this.strength > 0 && ground && ground(this.x, this.z) > 0) this.strength = 0;
    this.y = water + .55;
  }
}
export type FloatPair = readonly [FloatContact, FloatContact];
