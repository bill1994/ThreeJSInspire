import * as THREE from 'three';
import { LAYER } from './render-layers';
import { daylightWeight } from './daylight';

export type HeadlightMode = 'auto' | 'on' | 'off';
export const parseHeadlightMode = (raw: string | null): HeadlightMode => raw === 'on' || raw === 'off' ? raw : 'auto';
export const HEADLIGHT = {
  range: 170, slope: Math.tan(14 * Math.PI / 180), radius: 0.22,
  tilt: -6 * Math.PI / 180, tint: [1, 0.84, 0.62] as const,
  position: [-1.8, -0.4, -0.9] as const,
  stepsHigh: 20, stepsLow: 12,
} as const;
const BEAM_THRESHOLD = 0.001;

export function headlightStrength(mode: HeadlightMode, sunY: number): number {
  if (mode === 'off') return 0;
  if (mode === 'on') return 1;
  return Number.isFinite(sunY) ? 1 - daylightWeight(sunY, [Math.sin(-6 * Math.PI / 180), Math.sin(1 * Math.PI / 180)]) : 0;
}

function headlightFalloffTsl(T: any, z: any, radial2: any): any {
  const radius = z.max(0).mul(HEADLIGHT.slope).add(HEADLIGHT.radius);
  const edge = T.float(1).sub(T.smoothstep(0.16, 1, radial2.div(radius.mul(radius))));
  return edge.mul(edge).mul(T.smoothstep(0, 1.5, z))
    .mul(T.float(1).sub(T.smoothstep(HEADLIGHT.range * 0.55, HEADLIGHT.range, z)))
    .div(T.float(1).add(z.max(0).div(55).pow(2)));
}

/** One finite, soft cone for cloud paint, sea lighting and airborne scattering. */
export function headlightFieldTsl(T: any, p: any, u: HeadlightUniforms): any {
  const delta = p.sub(u.position);
  const z = delta.dot(u.direction);
  const radial2 = delta.dot(delta).sub(z.mul(z)).max(0);
  return headlightFalloffTsl(T, z, radial2).mul(u.strength);
}

export interface HeadlightUniforms { position: any; direction: any; strength: any }

export async function initHeadlight(scene: THREE.Scene) {
  const T: any = await import('three/tsl');
  const { MeshBasicNodeMaterial } = await import('three/webgpu');
  const uniforms: HeadlightUniforms = {
    position: T.uniform(new THREE.Vector3()), direction: T.uniform(new THREE.Vector3(0, 0, -1)), strength: T.uniform(0),
  };
  const steps = T.uniform(HEADLIGHT.stepsHigh);
  const group = new THREE.Group(); group.name = 'porco_headlight'; scene.add(group);
  const housingGeometry = new THREE.CylinderGeometry(0.24, 0.26, 0.32, 12);
  housingGeometry.rotateX(Math.PI / 2);
  const housingMaterial = new THREE.MeshStandardMaterial({ color: '#344149', roughness: 0.8 });
  const housing = new THREE.Mesh(housingGeometry, housingMaterial); group.add(housing);
  const lensGeometry = new THREE.SphereGeometry(0.19, 12, 8);
  lensGeometry.scale(1, 1, 0.3);
  const lensMaterial = new MeshBasicNodeMaterial();
  lensMaterial.colorNode = T.vec3(...HEADLIGHT.tint).mul(uniforms.strength.mul(0.75).add(0.04));
  const lens = new THREE.Mesh(lensGeometry, lensMaterial); lens.position.z = -0.18; group.add(lens);

  const radius = HEADLIGHT.radius + HEADLIGHT.range * HEADLIGHT.slope;
  const geometry = new THREE.BoxGeometry(radius * 2, radius * 2, HEADLIGHT.range);
  geometry.translate(0, 0, -HEADLIGHT.range / 2);
  const material = new MeshBasicNodeMaterial();
  material.transparent = true; material.blending = THREE.AdditiveBlending;
  material.depthWrite = false; material.depthTest = false; material.side = THREE.BackSide; material.fog = false;
  const depth = T.viewportDepthTexture();
  const origin = T.varying(T.modelWorldMatrixInverse.mul(T.vec4(T.cameraPosition, 1)).xyz);
  material.fragmentNode = T.Fn(() => {
    uniforms.strength.lessThanEqual(BEAM_THRESHOLD).discard();
    const ray = T.normalize(T.positionGeometry.sub(origin)).toVar();
    const safe = T.select(T.abs(ray).lessThan(T.vec3(1e-6)), T.vec3(1e-6), ray);
    const a = T.vec3(-radius, -radius, -HEADLIGHT.range).sub(origin).div(safe);
    const b = T.vec3(radius, radius, 0).sub(origin).div(safe);
    const lo = T.min(a, b), hi = T.max(a, b);
    const start = T.max(0, T.max(lo.x, T.max(lo.y, lo.z))).toVar();
    const worldRay = T.normalize(T.modelWorldMatrix.mul(T.vec4(ray, 0)).xyz);
    const viewRay = T.cameraViewMatrix.mul(T.vec4(worldRay, 0)).xyz;
    const sceneDistance = T.perspectiveDepthToViewZ(depth, T.cameraNear, T.cameraFar).negate()
      .div(viewRay.z.negate().max(0.0001));
    const end = T.min(sceneDistance, T.min(hi.x, T.min(hi.y, hi.z))).toVar();
    const dt = end.sub(start).max(0).div(steps).toVar();
    const energy = T.float(0).toVar();
    T.If(end.greaterThan(start), () => {
      T.Loop({ start: 0, end: steps, type: 'int' }, ({ i }: any) => {
        const p = origin.add(ray.mul(start.add(T.float(i).add(0.5).mul(dt))));
        // The cone points down local -Z, so each sample can stay in lamp space.
        energy.addAssign(headlightFalloffTsl(T, p.z.negate(), p.xy.dot(p.xy)).mul(dt));
      });
    });
    // Bounded radiance, including when the camera enters the cone. No hard shell.
    const light = T.float(1).sub(T.exp(energy.mul(uniforms.strength).mul(-0.025))).mul(0.05);
    return T.vec4(T.vec3(...HEADLIGHT.tint).mul(light), 1);
  })();
  const beam = new THREE.Mesh(geometry, material);
  beam.name = 'porco_headlight_beam'; beam.renderOrder = LAYER.HEADLIGHT; beam.frustumCulled = false; group.add(beam);
  const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), HEADLIGHT.tilt);
  const mount = new THREE.Vector3(...HEADLIGHT.position), q = new THREE.Quaternion();
  let mode: HeadlightMode = 'auto';
  let warmingBeam = false;
  group.visible = false;
  return {
    uniforms,
    get mode() { return mode; },
    setMode(value: HeadlightMode) { mode = parseHeadlightMode(value); },
    setQuality(high: boolean) { steps.value = high ? HEADLIGHT.stepsHigh : HEADLIGHT.stepsLow; },
    stageBeamWarmup() {
      warmingBeam = true;
      return () => {
        warmingBeam = false;
        beam.visible = uniforms.strength.value > BEAM_THRESHOLD;
      };
    },
    update(sunY: number) {
      const aircraft = scene.getObjectByName('porco_roll');
      group.visible = Boolean(aircraft);
      if (!aircraft) { uniforms.strength.value = 0; return; }
      aircraft.updateWorldMatrix(true, false);
      group.position.copy(mount).applyMatrix4(aircraft.matrixWorld);
      aircraft.getWorldQuaternion(q); group.quaternion.copy(q).multiply(tilt);
      uniforms.position.value.copy(group.position);
      uniforms.direction.value.set(0, 0, -1).applyQuaternion(group.quaternion).normalize();
      uniforms.strength.value = headlightStrength(mode, sunY);
      beam.visible = warmingBeam || uniforms.strength.value > BEAM_THRESHOLD;
    },
    dispose() {
      uniforms.strength.value = 0; scene.remove(group);
      geometry.dispose(); material.dispose(); lensGeometry.dispose(); lensMaterial.dispose();
      housingGeometry.dispose(); housingMaterial.dispose();
    },
  };
}
