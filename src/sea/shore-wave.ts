import type * as TSL from 'three/tsl';
import type { MeshLambertNodeMaterial, Node } from 'three/webgpu';

const WAVE_NUMBER = 2 * Math.PI / 18;
const ANGULAR_SPEED = 1.2;
const PERIOD = 2 * Math.PI / ANGULAR_SPEED;

export function shoreWave(xz: Node<'vec2'>, offshore: Node<'float'>, clock: Node<'float'>) {
  const bend = xz.x.mul(0.095).add(xz.y.mul(0.065)).sin();
  const lobe = xz.x.mul(0.23).sub(xz.y.mul(0.17)).add(bend.mul(1.6)).sin();
  const phase = offshore.add(bend.mul(2.1)).add(lobe.mul(0.85))
    .mul(WAVE_NUMBER).add(clock.mul(ANGULAR_SPEED));
  return { bend, lobe, phase };
}

export function wetSandTint(T: typeof TSL, heightAboveSea: Node<'float'>, clock: Node<'float'>, distance: Node<'float'>) {
  return T.Fn(() => {
    const tint = T.vec3(1).toVar();
    const inSwash = heightAboveSea.lessThan(1.55).and(heightAboveSea.greaterThan(-1.4));
    T.If(clock.greaterThanEqual(0).and(inSwash).and(distance.lessThan(360)), () => {
      // Phase zero is when the offshore crest reaches the waterline.
      const { phase, lobe } = shoreWave(T.positionWorld.xz, T.float(0), clock);
      const seconds = phase.div(2 * Math.PI).fract().mul(PERIOD);
      const reach = lobe.mul(0.27).add(1.19);
      const height = heightAboveSea.max(0).div(reach);
      const arrival = height.mul(1.12);
      const retreat = T.mix(2.65, 1.30, height.clamp());
      const coverage = T.smoothstep(arrival, arrival.add(0.22), seconds)
        .mul(T.smoothstep(-1.4, -0.10, heightAboveSea))
        .mul(T.smoothstep(0.76, 1.03, height).oneMinus())
        .mul(T.smoothstep(160, 360, distance).oneMinus());
      const film = coverage.mul(T.smoothstep(retreat, retreat.add(0.28), seconds).oneMinus());
      const damp = coverage.mul(T.smoothstep(retreat, retreat.add(2.35), seconds).oneMinus());
      tint.assign(T.vec3(1).sub(T.vec3(0.36, 0.32, 0.26).mul(damp))
        .add(T.vec3(0.05, 0.10, 0.16).mul(film)));
    });
    return tint;
  })();
}

/** The sea advances this uniform. An unmounted sea leaves the beach dry. */
export function attachWetSand(T: typeof TSL, ground: MeshLambertNodeMaterial) {
  const clock = T.uniform(-1);
  const surface = (ground.outputNode ?? T.output) as Node<'vec4'>;
  const wetLight = wetSandTint(T, T.positionWorld.y, clock, T.positionWorld.distance(T.cameraPosition));
  ground.outputNode = T.vec4(surface.rgb.mul(wetLight), surface.a);
  return clock;
}
