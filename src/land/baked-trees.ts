import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import * as T from 'three/tsl';
import type { IslandTree } from './vegetation';

const names = ['wide', 'lean', 'twin'];

export function oakVariant(tree: IslandTree) {
  const hash = Math.imul(Math.round(tree.x * 17), 73856093) ^ Math.imul(Math.round(tree.z * 17), 19349663);
  return (hash >>> 0) % names.length;
}

export async function loadOakLibrary() {
  const [model, mask, views] = await Promise.all([
    new GLTFLoader().loadAsync(new URL('../../assets/island-trees/oaks.glb', import.meta.url).href),
    new THREE.TextureLoader().loadAsync(new URL('../../assets/island-trees/oak-mask.png', import.meta.url).href),
    new THREE.TextureLoader().loadAsync(new URL('../../assets/island-trees/oak-views.png', import.meta.url).href),
  ]);
  function geometry(name: string) {
    const object = model.scene.getObjectByName(name);
    if (!(object instanceof THREE.Mesh)) throw new Error('Missing island oak ' + name);
    const geo = object.geometry as THREE.BufferGeometry;
    const p = geo.getAttribute('position');
    const weight = Float32Array.from({length:p.count}, (_, i) => Math.min(1, Math.max(0,p.getY(i)/16)) ** 2);
    geo.setAttribute('bend', new THREE.BufferAttribute(weight, 1));
    return geo;
  }
  views.colorSpace = THREE.SRGBColorSpace;
  return {mask, views, near:names.map(n => geometry(n+'_near'))};
}

function pixelThreshold(offset = 0) {
  const pixel = T.screenCoordinate.xy.floor().add(offset);
  return pixel.dot(T.vec2(.06711056,.00583715)).fract().mul(52.9829189).fract();
}

export function oakLodMask() {
  return pixelThreshold().lessThan(T.attribute('oakNearCoverage','float'));
}

export function oakCoverage(geometry: THREE.BufferGeometry, capacity: number) {
  const attr = new THREE.InstancedBufferAttribute(new Float32Array(capacity),1);
  attr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('oakNearCoverage',attr);
  return attr;
}

export function oakBillboard(views: THREE.Texture, horizon: THREE.Color, sun?: THREE.Vector3, fade = false) {
  const geometry = new THREE.PlaneGeometry(1,1);
  const positions = geometry.getAttribute('position');
  for (let i=0;i<positions.count;i++) positions.setXYZ(i,0,10,0);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0,10,0),26);
  const tileUV = T.varyingProperty('vec2','oakTileUV');
  const viewWeights = T.varyingProperty('vec2','oakViewWeights');
  const visibility = T.varyingProperty('vec2','oakVisibility');
  const clock = T.uniform(0);
  const residentSince = T.uniform(-2).onObjectUpdate(({object}) => object!.userData.oakResidentSince ?? -2);
  const atlasGrid = T.vec2(8,6);
  const mat = new MeshBasicNodeMaterial({fog:false,transparent:fade});
  mat.positionNode = T.Fn(() => {
    // The instance matrix places the centre; size, yaw and species travel in the instance colour.
    const centre = T.positionLocal.toVar();
    const dir = T.cameraPosition.sub(centre).normalize().toVar();
    const right = T.vec3(dir.z,0,dir.x.negate()).normalize();
    const up = dir.cross(right);
    const params = T.instanceColor;
    const yaw = T.atan(dir.x,dir.z).sub(params.y);
    const sector = yaw.div(Math.PI/4).add(16);
    if (fade) {
      // Finish fading before the far clip plane crosses a crown. At a few
      // pixels across, filtered alpha is smoother than a binary leaf mask.
      const distance = centre.distance(T.cameraPosition);
      const limit = T.cameraFar.min(2350);
      const horizonOpacity = T.smoothstep(limit.mul(.72),limit.mul(.975),distance).oneMinus();
      const arrival = T.smoothstep(0,1.2,clock.sub(residentSince));
      visibility.assign(T.vec2(horizonOpacity.mul(arrival),T.smoothstep(520,900,distance)));
      // The baker captures each crown at elevations of 12 and 48 degrees.
      const elevation = T.smoothstep(Math.sin(12*Math.PI/180),Math.sin(48*Math.PI/180),dir.y);
      const upperOnly = T.step(1,elevation);
      tileUV.assign(T.vec2(sector.floor().mod(8),T.float(5).sub(params.z.mul(2)).sub(upperOnly)));
      viewWeights.assign(T.vec2(T.smoothstep(0,1,sector.fract()),elevation.sub(upperOnly)));
    } else {
      const col = sector.add(.5).floor().mod(8);
      const row = params.z.mul(2).add(T.step(.5,dir.y));
      tileUV.assign(T.vec2(col,T.float(5).sub(row)));
    }
    const offset = T.uv().sub(.5).mul(params.x.mul(36));
    return centre.add(right.mul(offset.x)).add(up.mul(offset.y));
  })();
  const daylight = sun ? T.smoothstep(-.13,.23,T.uniform(sun).y) : T.float(1);
  const tint = T.mix(T.vec3(.1,.16,.31),T.vec3(1.04,1.02,.95),daylight);
  const mist = T.smoothstep(100,1600,T.positionWorld.distance(T.cameraPosition)).mul(.32);
  mat.fragmentNode = T.Fn(() => {
    const uv = T.uv().div(atlasGrid);
    const dx = T.dFdx(uv).toVar(), dy = T.dFdy(uv).toVar();
    if (fade) oakLodMask().discard();
    const uv0 = tileUV.div(atlasGrid).add(uv);
    if (!fade) {
      const pixel = T.texture(views,uv0);
      pixel.a.lessThan(.24).discard();
      return T.vec4(T.mix(pixel.rgb.mul(tint),T.uniform(horizon),mist),1);
    }
    const uv1 = T.vec2(tileUV.x.add(1).mod(8),tileUV.y).div(atlasGrid).add(uv);
    function sampleView(coords: typeof uv0) {
      const pixel = T.texture(views,coords).grad(dx,dy).toVar();
      const coverage = T.mix(T.smoothstep(.18,.30,pixel.a),pixel.a,visibility.y);
      return T.vec4(pixel.rgb.mul(coverage),coverage);
    }
    const crown = T.mix(sampleView(uv0),sampleView(uv1),viewWeights.x).toVar();
    // At shallow and steep angles only one row is needed.
    T.If(viewWeights.y.greaterThan(0), () => {
      const row = T.vec2(0,1/6);
      const upper = T.mix(sampleView(uv0.sub(row)),sampleView(uv1.sub(row)),viewWeights.x);
      crown.assign(T.mix(crown,upper,viewWeights.y));
    });
    const cutout = T.float(crown.a.greaterThan(pixelThreshold(17)));
    const opacity = T.mix(cutout,crown.a,visibility.y).mul(visibility.x);
    opacity.lessThanEqual(1/255).discard();
    const pigment = crown.rgb.div(crown.a.max(.0001));
    return T.vec4(T.mix(pigment.mul(tint),T.uniform(horizon),mist),opacity);
  })();
  return {geometry,material:mat,clock};
}
