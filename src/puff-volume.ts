/** Opt-in density renderer: the existing lobe layout remains the shape source.
 * RGB stores a smooth macro normal; A stores density. No animated noise or shell walls.
 * All colours arrive from the existing day/night palette uniforms.
 */
import * as THREE from 'three';
import type { PuffLobe } from './puff-shape';
import { PAINT_CONSTANTS as PAINT, mapPalette, paintMixJs } from './bg-cumulus-paint';

export const PUFF_VOLUME = {
  resolution: 48, stepsHigh: 64, stepsLow: 40,
  feather: 0.055,
  extinction: 0.13, exteriorExtinction: 0.42,
  // Art-directed palette tint, separate from opacity: approximate the warmth of the distant bg clouds.
  paintAtmosphere: 0.28,
} as const;

/** Beer–Lambert opacity mirror. Keep the accepted cloud-core mean free path unchanged. */
export function puffOpticalAlpha(density: number, metres: number, cameraDensity: number): number {
  const inside = Math.min(1, Math.max(0, cameraDensity));
  const extinction = PUFF_VOLUME.exteriorExtinction * (1-inside) + PUFF_VOLUME.extinction * inside;
  return 1 - Math.exp(-Math.max(0,density) * Math.max(0,metres) * extinction);
}

/** Same paint mapping as bg-cloud's clean/form look, with a palette-derived atmospheric tint. */
export function puffPaintJs(light: number, broad: number, open: number, h: number,
  bands: readonly (readonly [number,number,number])[], haze: readonly [number,number,number]) {
  const colour = paintMixJs(light,broad,0,open,h,mapPalette(bands,haze),0.5,0);
  return colour.map((c,i)=>c+(haze[i]-c)*PUFF_VOLUME.paintAtmosphere);
}

/** Same radial displacement as buildPuffGeometry, evaluated before its lobe transform.
 * Smooth density feathers the triangulated surface slightly; this is not a mesh voxel copy.
 */
export function puffDensitySample(x: number, y: number, z: number, lobes: readonly PuffLobe[], out = [0,0,0,0,0]): number[] {
  let density = 0, nx = 0, ny = 0, nz = 0;
  let nearest = Infinity;
  for (const lobe of lobes) {
    const e = lobe.inverse, r = lobe.radius, i = lobe.index;
    const px = e[0]*x + e[4]*y + e[8]*z + e[12];
    const py = e[1]*x + e[5]*y + e[9]*z + e[13];
    const pz = e[2]*x + e[6]*y + e[10]*z + e[14];
    const len = Math.max(Math.hypot(px, py, pz), 1e-6);
    const sx = px*r/len, sy = py*r/len, sz = pz*r/len;
    const lump = 1 + 0.10*Math.sin(sx*0.55+i*2.3)*Math.sin(sy*0.75+i)*Math.sin(sz*0.62+i*0.7);
    const d = len / r - 1;
    const t = Math.max(0, Math.min(1, (lump - len/r) / PUFF_VOLUME.feather));
    density = Math.max(density, t*t*(3-2*t));
    // Online soft-min weights avoid allocating an array per lobe per voxel at startup.
    if(d < nearest) {
      const rescale = Math.exp(-(nearest-d)/.24);
      nx*=rescale; ny*=rescale; nz*=rescale;
      nearest=d;
    }
    const weight = Math.exp(-(d-nearest)/.24);
    // Inverse transpose carries the sphere gradient into cloud-local coordinates.
    nx += (e[0]*px+e[1]*py+e[2]*pz)/len*weight;
    ny += (e[4]*px+e[5]*py+e[6]*pz)/len*weight;
    nz += (e[8]*px+e[9]*py+e[10]*pz)/len*weight;
  }
  const length = Math.hypot(nx, ny, nz);
  out[0]=length>1e-6?nx/length:0;
  out[1]=length>1e-6?ny/length:1;
  out[2]=length>1e-6?nz/length:0;
  out[3]=density;
  // Broad, undisplaced density for lighting only. Fine silhouette bumps must not cut up the paint edge.
  const macroT=Math.min(1,Math.max(0,-nearest/.3));
  out[4]=macroT*macroT*(3-2*macroT);
  return out;
}

export function buildPuffVolumeData(geometry: THREE.BufferGeometry, resolution: number = PUFF_VOLUME.resolution) {
  geometry.computeBoundingBox();
  // Include the continuous lobe displacement between coarse mesh vertices and a zero border.
  const size = geometry.boundingBox!.getSize(new THREE.Vector3()).multiplyScalar(1.15);
  const lobes = geometry.userData.puffLobes as PuffLobe[];
  if (!lobes?.length) throw new Error('[puff-volume] missing original lobe transforms');
  const data = new Uint8Array(resolution ** 3 * 4);
  const lightData = new Uint8Array(resolution ** 3);
  const sample = [0,0,0,0,0];
  let offset = 0;
  for (let z=0; z<resolution; z++) for (let y=0; y<resolution; y++) for (let x=0; x<resolution; x++) {
    const s = puffDensitySample(((x+.5)/resolution-.5)*size.x, ((y+.5)/resolution-.5)*size.y, ((z+.5)/resolution-.5)*size.z, lobes, sample);
    data[offset++] = Math.round((s[0]*.5+.5)*255);
    data[offset++] = Math.round((s[1]*.5+.5)*255);
    data[offset++] = Math.round((s[2]*.5+.5)*255);
    const border = x===0 || y===0 || z===0 || x===resolution-1 || y===resolution-1 || z===resolution-1;
    data[offset++] = border ? 0 : Math.round(s[3]*255);
    lightData[offset/4-1] = border ? 0 : Math.round(s[4]*255);
  }
  return { data, lightData, size, resolution };
}

/** Shared uniforms and depth node keep all cloud materials on the same render state. */
export async function createPuffVolumeFactory(bands: any[], haze: any, sun: any,
  hazeRange: { NEAR: number; FAR: number; MAX: number }) {
  const T: any = await import('three/tsl');
  const { MeshBasicNodeMaterial } = await import('three/webgpu');
  const steps = T.uniform(PUFF_VOLUME.stepsHigh);
  const depth = T.viewportDepthTexture();
  const resources: THREE.Data3DTexture[] = [];
  return {
    setQuality(high: boolean) { steps.value = high ? PUFF_VOLUME.stepsHigh : PUFF_VOLUME.stepsLow; },
    dispose() { for (const texture of resources) texture.dispose(); },
    create(source: THREE.BufferGeometry, edgeFade: any) {
      const { data, lightData, size, resolution } = buildPuffVolumeData(source);
      const texture = new THREE.Data3DTexture(data, resolution, resolution, resolution);
      texture.format = THREE.RGBAFormat;
      texture.minFilter = texture.magFilter = THREE.LinearFilter;
      texture.unpackAlignment = 1;
      texture.needsUpdate = true;
      const lightTexture = new THREE.Data3DTexture(lightData, resolution, resolution, resolution);
      lightTexture.format = THREE.RedFormat;
      lightTexture.minFilter = lightTexture.magFilter = THREE.LinearFilter;
      lightTexture.unpackAlignment = 1;
      lightTexture.needsUpdate = true;
      const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
      resources.push(texture,lightTexture);
      const sizeN = T.vec3(size.x, size.y, size.z);
      const half = sizeN.mul(.5);
      const origin = T.varying(T.modelWorldMatrixInverse.mul(T.vec4(T.cameraPosition, 1)).xyz);
      const material = new MeshBasicNodeMaterial();
      material.transparent = true;
      material.side = THREE.BackSide;
      material.depthWrite = false;
      // Clip the integration against scene depth, not the proxy box's back face.
      material.depthTest = false;
      material.fog = false;
      material.userData.edgeFade = edgeFade;
      material.fragmentNode = T.Fn(() => {
        edgeFade.lessThan(.001).discard();
        const rd = T.normalize(T.positionGeometry.sub(origin)).toVar();
        const safe = T.select(T.abs(rd).lessThan(T.vec3(1e-6)), T.vec3(1e-6), rd);
        const t0 = half.negate().sub(origin).div(safe);
        const t1 = half.sub(origin).div(safe);
        const lo = T.min(t0,t1), hi = T.max(t0,t1);
        const start = T.max(T.max(lo.x, T.max(lo.y,lo.z)), 0).toVar();
        const worldDir = T.modelWorldMatrix.mul(T.vec4(rd,0)).xyz.toVar();
        const worldPerLocal = T.length(worldDir).toVar();
        const viewDir = T.cameraViewMatrix.mul(T.vec4(T.normalize(worldDir),0)).xyz;
        const sceneZ = T.perspectiveDepthToViewZ(depth, T.cameraNear, T.cameraFar).negate();
        const sceneT = sceneZ.div(T.max(viewDir.z.negate(), .0001)).div(worldPerLocal);
        const end = T.min(T.min(hi.x, T.min(hi.y,hi.z)), sceneT).toVar();
        const dt = T.max(end.sub(start),0).div(steps).toVar();
        const sunLocal = T.normalize(T.modelWorldMatrixInverse.mul(T.vec4(sun,0)).xyz).toVar();
        const cameraDensity = T.texture3D(texture,origin.div(sizeN).add(.5)).level(0).a.toVar();
        const extinction = T.mix(PUFF_VOLUME.exteriorExtinction,PUFF_VOLUME.extinction,cameraDensity).toVar();
        const normalSum = T.vec3(0).toVar(), positionSum = T.vec3(0).toVar();
        const colour = T.vec3(0).toVar(), alpha = T.float(0).toVar();
        T.If(end.greaterThan(start), () => {
          T.Loop({ start: 0, end: steps, type: 'int' }, ({ i }: any) => {
            const p = origin.add(rd.mul(start.add(T.float(i).add(.5).mul(dt)))).toVar();
            const voxel = T.texture3D(texture, p.div(sizeN).add(.5)).level(0).toVar();
            T.If(voxel.a.greaterThan(.002), () => {
              const a = T.float(1).sub(T.exp(voxel.a.mul(dt).mul(worldPerLocal).mul(extinction).negate())).toVar();
              const contribution = alpha.oneMinus().mul(a).toVar();
              normalSum.addAssign(voxel.rgb.mul(2).sub(1).mul(contribution));
              positionSum.addAssign(p.mul(contribution));
              alpha.addAssign(contribution);
              T.If(alpha.greaterThan(.995), () => { T.Break(); });
            });
          });
        });
        T.If(alpha.greaterThan(.0001), () => {
          // Shade once after integrating density. Quantizing per sample washed out the paint bands
          // and repeated three shadow fetches at every march step.
          const p = positionSum.div(alpha).toVar();
          const normal = T.normalize(normalSum.add(T.vec3(0,1e-5,0))).toVar();
          const upLocal = T.normalize(T.modelWorldMatrixInverse.mul(T.vec4(0,1,0,0)).xyz);
          const radial = T.normalize(T.vec3(p.x,0,p.z).add(T.vec3(1e-5,0,0)));
          const L = T.normalize(sunLocal.add(upLocal.mul(PAINT.liftY)).sub(radial.mul(PAINT.radialPull))).toVar();
          const reach = Math.min(size.x,size.y,size.z)*.23;
          const shadow = T.float(0).toVar();
          for (const [offset,weight] of [[.25,.45],[.6,.35],[1,.2]]) {
            shadow.addAssign(T.texture3D(lightTexture,p.add(L.mul(reach*offset)).div(sizeN).add(.5)).level(0).r.mul(weight));
          }
          const up = T.smoothstep(half.y.negate(),half.y,p.y);
          const ny = normal.dot(upLocal);
          const facing = normal.dot(L).mul(.5).add(.5);
          const open = shadow.oneMinus();
          const light = facing.mul(T.exp(shadow.mul(-PAINT.lightExpo)))
            .add(up.mul(PAINT.litUp)).add(open.sub(.5).mul(PAINT.litOpen)).add(ny.mul(PAINT.litNy)).toVar();
          const broad = facing.mul(T.exp(shadow.negate()))
            .add(up.mul(PAINT.broadUp)).add(ny.mul(PAINT.broadNy));
          // TSL mirror of paintMixJs (clean/form); thresholds and colour ordering are shared with bg.
          const deepen = T.float(1).sub(T.float(1).sub(T.smoothstep(...PAINT.foldRange,open)).mul(PAINT.foldDeepen));
          const shade = T.mix(bands[1],bands[2],T.smoothstep(...PAINT.shadeMix,broad)).mul(deepen);
          const lit = T.mix(shade,bands[3],T.smoothstep(...PAINT.hardEdge,light));
          const h = p.y.add(half.y).div(Math.min(size.x,size.y,size.z)*.25*PAINT.underScale);
          const painted = T.mix(bands[0],lit,T.smoothstep(...PAINT.underMix,h.add(light)));
          const tinted = T.mix(painted,haze,PUFF_VOLUME.paintAtmosphere);
          const distance = T.length(p.sub(origin)).mul(worldPerLocal);
          colour.assign(T.mix(tinted,haze,T.smoothstep(hazeRange.NEAR,hazeRange.FAR,distance).mul(hazeRange.MAX)));
        });
        // Density alone controls opacity; painting never adds another alpha multiplication.
        return T.vec4(colour, alpha.mul(edgeFade));
      })();
      return { geometry, material };
    },
  };
}
