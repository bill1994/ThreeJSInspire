import { Vector3 } from 'three';
import type * as TSL from 'three/tsl';
import { surfaceEffect } from './surface-interaction';

// Both receivers see the same pose for the entire render, including reflection passes.
const center = new Vector3(0, 1e6, 0);
const orientation = new Vector3(1, 0, 1);

export function updateAircraftShadow(p: {x:number; y:number; z:number; yaw?:number; bank?:number}) {
  center.set(p.x, p.y, p.z);
  const yaw = p.yaw ?? 0;
  orientation.set(Math.cos(yaw), Math.sin(yaw), 0.55 + 0.45 * Math.abs(Math.cos(p.bank ?? 0)));
}

export function aircraftShadow(T: typeof TSL, sun: ReturnType<typeof TSL.uniform<'vec3', Vector3>>,
  receiverY = T.positionWorld.y) {
  if (!surfaceEffect('shadow')) return T.float(0);
  const plane = T.uniform(center), axes = T.uniform(orientation);
  const gap = plane.y.sub(receiverY).max(0);
  const offset = gap.div(sun.y.max(.23)).min(23);
  const rel = T.positionWorld.xz.sub(plane.xz).add(sun.xz.mul(offset));
  const lateral = rel.x.mul(axes.x).sub(rel.y.mul(axes.y));
  const along = rel.x.mul(axes.y).add(rel.y.mul(axes.x));
  const wing = T.vec2(lateral.div(axes.z.mul(5.2)), along.add(.65)).length();
  const hull = T.vec2(lateral.div(.83), along.div(3.9)).length();
  const tail = T.vec2(lateral.div(2), along.sub(2.7).div(.68)).length();
  const blur = gap.mul(.022).add(.18);
  return T.smoothstep(blur.oneMinus(), blur.add(1), wing.min(hull).min(tail)).oneMinus()
    .mul(T.smoothstep(8,33,gap).oneMinus()).mul(T.smoothstep(.02,.25,sun.y)).mul(.52);
}
