import type { Color, Vector3 } from 'three';
import type * as TSL from 'three/tsl';
import type { Node, NodeMaterial } from 'three/webgpu';

export const coastEffects = { haze: false, wind: false, drops: false };
export const SEA_WIND_ANGLE = 0.212; // Radians from -Z toward +X, shared with the wave spectrum.

export function configureCoastEffects(enabled: boolean, selection: string | null) {
  const names = new Set((selection ?? 'all').split(',').map(name => name.trim()));
  for (const name of ['haze', 'wind', 'drops'] as const) {
    coastEffects[name] = enabled && (names.has('all') || names.has(name));
  }
}

export interface CoastalLight {
  sun: Vector3;
  warm: Color;
  away: Color;
}

/** Mean density along the eye-to-surface segment through an exponential marine layer. */
export function marineHaze(T: typeof TSL, distance: Node<'float'>, sunY: Node<'float'>) {
  const eye = T.cameraPosition.y.max(0).div(13);
  const end = T.positionWorld.y.max(0).div(13);
  const span = end.sub(eye).abs().max(0.002);
  const density = eye.min(end).negate().exp().mul(span.negate().exp().oneMinus()).div(span);
  const path = distance.sub(105).max(0).mul(T.smoothstep(105, 200, distance));
  const extinction = T.mix(0.0009, 0.0027, T.smoothstep(-0.1, 0.19, sunY));
  return path.mul(density).mul(extinction).negate().exp().oneMinus().mul(0.84);
}

export function marineTint(T: typeof TSL, sun: Node<'vec3'>, warm: Node<'vec3'>, away: Node<'vec3'>) {
  const view = T.positionWorld.xz.sub(T.cameraPosition.xz);
  const cosine = view.dot(sun.xz).div(view.length().mul(sun.xz.length()).max(0.001)).clamp(-1, 1);
  const sky = T.mix(warm, away, cosine.oneMinus().mul(0.5).pow(1.2));
  // Suspended water takes the local sky hue, with a cooler, less saturated body.
  const grey = sky.dot(T.vec3(0.2126, 0.7152, 0.0722));
  return T.mix(T.vec3(grey.mul(0.82), grey.mul(0.96), grey.mul(1.10)), sky, 0.55);
}

export function hazeCoastalMaterial(T: typeof TSL, material: NodeMaterial, light: CoastalLight) {
  const sun = T.uniform(light.sun);
  const tint = marineTint(T, sun, T.uniform(light.warm).rgb, T.uniform(light.away).rgb);
  const amount = marineHaze(T, T.positionWorld.distance(T.cameraPosition), sun.y);
  const surface = (material.fragmentNode ?? material.outputNode ?? T.output) as Node<'vec4'>;
  const output = T.vec4(T.mix(surface.rgb, tint, amount), surface.a);
  if (material.fragmentNode) material.fragmentNode = output;
  else material.outputNode = output;
  material.fog = false;
}

/** Broad moving patches and small interrupted crest strokes, both in world metres. */
export function windWater(T: typeof TSL, xz: Node<'vec2'>, time: Node<'float'>, phase: number) {
  const s = Math.sin(SEA_WIND_ANGLE), c = Math.cos(SEA_WIND_ANGLE);
  const along = xz.dot(T.vec2(s, -c));
  const across = xz.dot(T.vec2(c, s));
  const turn = along.mul(0.013).add(phase).sin();
  const drift = across.mul(0.029).add(turn.mul(1.45)).add(along.mul(0.006))
    .add(phase * 0.61).sub(time.mul(0.075));
  const patch = drift.sin().add(along.mul(0.027).add(phase * 0.38).sin().mul(0.24));
  const band = T.smoothstep(0.08, 0.86, patch);
  const bend = along.mul(0.19).sub(across.mul(0.083)).add(phase).sin();
  const crest = along.mul(1.13).add(across.mul(0.22)).add(across.mul(0.45).sin().mul(0.64))
    .add(turn).add(bend.mul(1.35)).sub(time.mul(1.03));
  const gaps = across.mul(0.49).add(along.mul(0.17).sin().mul(1.8)).add(bend.mul(1.7)).add(phase).sin();
  const width = T.fwidth(crest);
  const stroke = T.smoothstep(T.float(0.80).sub(width.mul(0.18)), T.float(0.96).add(width.mul(0.12)), crest.sin())
    .mul(T.smoothstep(0.12, 0.82, gaps)).mul(T.smoothstep(0.30, 1.65, width).oneMinus());
  return {band, stroke};
}
