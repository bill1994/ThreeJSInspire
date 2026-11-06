/**
 * The stylized sea material: world-anchored FFT displacement, four-band flat
 * colour, and a reflection that is LITERALLY the sky's own TSL function.
 *
 * Vertex: `mod(worldXZ, tileMetres)` anchors the displacement to the world, so
 * the rings can tow continuously with the camera and nothing slides. Each ring
 * samples at its own `mipLod` (a trilinear low-pass that removes every wave the
 * ring's vertex spacing cannot resolve) and blends towards the next ring's mip
 * inside the one-cell overlap, so LOD transitions never show as content seams.
 * R0 additionally samples the chop cascade; R1–R3 are swell-only.
 *
 * Fragment: bands from the C0 swell height (identical判定 on every ring), the
 * normal from the slope textures plus a footprint-gated procedural detail
 * normal, and the reflected ray fed through `skyColorTsl` — the same function
 * the dome uses, so sea and sky cannot disagree.
 *
 * `?sea=debug` (debugUniform) swaps the shading for flat band colours so Task
 * 12 can measure each band's screen coverage and reverse-solve the palette.
 *
 * CHOPPINESS is already baked into the chop/Jacobian textures by the GPU IFFT
 * chain, so the material consumes displacement as-is.
 */
import * as THREE from 'three';

import { detailWeight, SEA_BAND_THRESHOLDS } from './bands';
import { CASCADES } from './cascades';
import { SEA_FOAM_THRESHOLD } from './foam';
import { createIfft, type IfftHandle } from './fft-gpu';
import { buildSpectrum } from './spectrum';
import { RINGS, type Ring } from './rings';
import { buildRingGeometry, holeInset } from './rings-mesh';
import { SEA_PALETTE } from '../palettes';
import { SUN_ROAD } from './sun-road';
import { skyColorTsl } from '../sky-webgpu';

/** Spectrum production values (plan Global Constraints). */
const SPECTRUM_WIND_SPEED = 9;
const SPECTRUM_WIND_DIR_RAD = 0.212;
const SPECTRUM_SEED = 20261106;

/** Detail normal map: 4 m repeat over 256² texels = 1.6 cm per texel. */
const DETAIL_REPEAT_METRES = 4;
const DETAIL_SIZE = 256;
const DETAIL_TEXEL_METRES = DETAIL_REPEAT_METRES / DETAIL_SIZE;

/** How much of the final colour is the sky reflection (rest is the band colour). */
const REFLECT_MIX = 0.45;

/**
 * Band colours read from the single-source `SEA_PALETTE` (Task 12). The
 * thresholds live in `bands.ts`; the pair moves together via this module.
 */
const SEA_BAND_COLORS: readonly [string, string, string, string] = [
  hex(SEA_PALETTE.deep),
  hex(SEA_PALETTE.mid),
  hex(SEA_PALETTE.lit),
  hex(SEA_PALETTE.crest),
];

/** False-colour palette for `?sea=debug` coverage measurement. */
const DEBUG_BAND_COLORS: readonly [string, string, string, string] = [
  '#003366',
  '#0066cc',
  '#66ccff',
  '#ffffff',
];

const FOAM_COLOR = hex(SEA_PALETTE.foam);

/** numeric hex → css string for `THREE.Color`. */
function hex(value: number): string {
  return '#' + value.toString(16).padStart(6, '0');
}

export interface SeaOcean {
  readonly time: number;
  update(camera: THREE.Vector3, radPerPixel: number, t: number): void;
  setQuality(high: boolean): void;
  setVisible(visible: boolean): void;
  setDebug(on: boolean): void;
  dispose(): void;
}

export interface SeaMaterialOpts {
  ring: Ring;
  /** The next ring outward, for the LOD blend in the overlap band. */
  nextRing?: Ring;
  height0: unknown;
  chop0: unknown;
  slope0: unknown;
  jac0: unknown;
  tile0: number;
  height1?: unknown;
  chop1?: unknown;
  slope1?: unknown;
  jac1?: unknown;
  tile1?: number;
  sunDirection: THREE.Vector3;
}

/** Seeded value-noise detail normal map — no binary asset, repeats every 4 m. */
function makeDetailNormalTexture(): THREE.DataTexture {
  const size = DETAIL_SIZE;
  const grid = 16;
  const rand = ((): (() => number) => {
    let a = 987654321;
    return () => {
      a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
      return a / 4294967296;
    };
  })();
  const lattice = new Float32Array(grid * grid);
  for (let i = 0; i < lattice.length; i += 1) lattice[i] = rand();

  const noise = (x: number, y: number): number => {
    const gx = (x * grid) % grid;
    const gy = (y * grid) % grid;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const q = (ix: number, iy: number): number =>
      lattice[((iy % grid) + grid) % grid * grid + (((ix % grid) + grid) % grid)];
    const top = q(x0, y0) * (1 - sx) + q(x0 + 1, y0) * sx;
    const bot = q(x0, y0 + 1) * (1 - sx) + q(x0 + 1, y0 + 1) * sx;
    return top * (1 - sy) + bot * sy;
  };

  const data = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      height[y * size + x] =
        noise(u, v) * 0.7 + noise(u * 2.3, v * 2.3) * 0.2 + noise(u * 5.1, v * 5.1) * 0.1;
    }
  }
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const l = height[y * size + ((x - 1 + size) % size)];
      const r = height[y * size + ((x + 1) % size)];
      const u = height[((y - 1 + size) % size) * size + x];
      const d = height[((y + 1) % size) * size + x];
      const nx = (l - r) * 8;
      const ny = (u - d) * 8;
      const len = Math.hypot(nx, ny, 1);
      const i = (y * size + x) * 4;
      data[i] = Math.round(((nx / len) * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((1 / len) * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Build one ring's node material. Async only because the TSL build is dynamic. */
export async function buildSeaMaterial(opts: SeaMaterialOpts): Promise<any> {
  const webgpu = (await import('three/webgpu')) as any;
  const tsl = (await import('three/tsl')) as any;
  const { positionLocal, positionWorld, texture, uniform, varying } = tsl;
  const { float, max, mix, normalize, reflect, smoothstep, step, vec2, vec3, cameraPosition } = tsl;

  const { ring, nextRing } = opts;
  const debugUniform = uniform(0);
  const radPerPixel = uniform(6.014e-4);
  const tierGain = uniform(SUN_ROAD.lowTierGain);

  // --- vertex: world-mod displacement at this ring's mip level --------------
  const worldXZ = positionWorld.xz;
  const squareRadius = max(worldXZ.x.abs(), worldXZ.y.abs());

  let lod = float(ring.mipLod);
  if (nextRing) {
    // Blend towards the next ring's coarser mip inside the one-cell overlap.
    const blendStart = holeInset(nextRing);
    lod = mix(
      float(ring.mipLod),
      float(nextRing.mipLod),
      smoothstep(blendStart, ring.outer, squareRadius),
    );
  }

  const uv0 = worldXZ.mod(opts.tile0).div(opts.tile0);
  const h0 = texture(opts.height0, uv0).level(lod).x;
  const chop0 = texture(opts.chop0, uv0).level(lod).xy;
  const slope0 = texture(opts.slope0, uv0).level(lod).xy;
  const jac0 = texture(opts.jac0, uv0).level(lod).xyz; // (dxx, dzz, dxz)
  let heightSum = h0;
  let dispSum = chop0;
  let slopeSum = slope0;
  let dxxSum = jac0.x;
  let dzzSum = jac0.y;
  let dxzSum = jac0.z;
  if (opts.height1 && opts.chop1 && opts.slope1 && opts.jac1 && opts.tile1) {
    const uv1 = worldXZ.mod(opts.tile1).div(opts.tile1);
    heightSum = heightSum.add(texture(opts.height1, uv1).level(0).x);
    dispSum = dispSum.add(texture(opts.chop1, uv1).level(0).xy);
    slopeSum = slopeSum.add(texture(opts.slope1, uv1).level(0).xy);
    const jac1 = texture(opts.jac1, uv1).level(0).xyz;
    dxxSum = dxxSum.add(jac1.x);
    dzzSum = dzzSum.add(jac1.y);
    dxzSum = dxzSum.add(jac1.z);
  }

  const positionNode = positionLocal.add(vec3(dispSum.x, heightSum, dispSum.y));

  // --- fragment: bands, normals, sky-matched reflection ---------------------
  const heightVarying = varying(heightSum);
  const slopeVarying = varying(slopeSum);

  // Four flat bands, stepped (not smoothed) — the hard edges ARE the style.
  const bandCol = (() => {
    let col = vec3(...cssToLinear(SEA_BAND_COLORS[0]));
    for (let i = 0; i < SEA_BAND_THRESHOLDS.length; i += 1) {
      col = mix(
        col,
        vec3(...cssToLinear(SEA_BAND_COLORS[i + 1])),
        step(SEA_BAND_THRESHOLDS[i], heightVarying),
      );
    }
    return col;
  })();

  const normalBase = normalize(
    vec3(slopeVarying.x.negate(), float(1.0), slopeVarying.y.negate()),
  );

  // Detail normal, gated by its screen footprint (see bands.detailWeight).
  const distance = positionWorld.sub(cameraPosition).length();
  const detailPx = float(DETAIL_TEXEL_METRES).div(distance.mul(radPerPixel));
  const detailGate = smoothstep(1.0, 2.0, detailPx);
  const detailUv = worldXZ.mod(DETAIL_REPEAT_METRES).div(DETAIL_REPEAT_METRES);
  const detailNormal = texture(makeDetailNormalTextureShared(), detailUv).xy.mul(2.0).sub(1.0);
  const normalNode = normalize(
    vec3(
      normalBase.x.add(detailNormal.x.mul(detailGate)),
      float(1.0),
      normalBase.z.add(detailNormal.y.mul(detailGate)),
    ),
  );

  const viewDir = normalize(positionWorld.sub(cameraPosition));
  const reflected = reflect(viewDir, normalNode);
  // The live sun vector arrives by reference from main; one uniform, many readers.
  const sunU = uniform(opts.sunDirection);
  const skyColor = skyColorTsl(tsl, reflected, sunU);

  const shaded = mix(bandCol, skyColor, float(REFLECT_MIX));

  // Jacobian foam: partials are summed ACROSS cascades above; the determinant
  // comes once, at the end (the per-cascade-product bug is in foam.test.ts).
  const jacobian = dxxSum.add(1.0).mul(dzzSum.add(1.0)).sub(dxzSum.mul(dxzSum));
  const foamMask = smoothstep(
    SEA_FOAM_THRESHOLD,
    SEA_FOAM_THRESHOLD + 0.15,
    float(1.0).sub(jacobian),
  );
  const withFoam = mix(shaded, vec3(...cssToLinear(FOAM_COLOR)), foamMask);

  // Sun road: narrow glint × azimuth gate × near fade (math in sun-road.ts).
  // 96 is the exponent the deleted FFT sea tuned — 170 shattered into speckle.
  const glintDir = reflect(sunU.negate(), normalNode);
  const spec = glintDir.dot(viewDir).max(0.0).pow(96.0);
  const sunXZ = normalize(vec2(sunU.x, sunU.y));
  const viewXZ = normalize(vec2(viewDir.x, viewDir.z));
  const cosEdge = Math.cos((SUN_ROAD.WIDTH_DEG * Math.PI) / 180);
  const mask = smoothstep(cosEdge, 1.0, sunXZ.dot(viewXZ));
  const gate = float(SUN_ROAD.ROAD_FLOOR).add(
    float(SUN_ROAD.ROAD_PEAK - SUN_ROAD.ROAD_FLOOR).mul(mask),
  );
  const nearFade = smoothstep(SUN_ROAD.NEAR_FADE_START, SUN_ROAD.NEAR_FADE_END, distance);
  const glint = spec.mul(SUN_ROAD.BASE * tierGain.value).mul(nearFade).mul(gate);
  // Grazing Fresnel warm-up toward the sky colour — a tint, not a second light.
  const fres = float(SUN_ROAD.F0)
    .add(float(1 - SUN_ROAD.F0).mul(float(1.0).sub(viewDir.dot(normalNode)).pow(5.0)))
    .mul(SUN_ROAD.FRESNEL_GAIN);
  const glintLinear = new THREE.Color(hex(SEA_PALETTE.glitter));
  const withRoad = withFoam.add(vec3(glintLinear.r, glintLinear.g, glintLinear.b).mul(glint)).add(
    skyColor.mul(fres),
  );

  // ?sea=debug: flat false-colour bands for coverage measurement.
  const debugCol = (() => {
    let col = vec3(...cssToLinear(DEBUG_BAND_COLORS[0]));
    for (let i = 0; i < SEA_BAND_THRESHOLDS.length; i += 1) {
      col = mix(
        col,
        vec3(...cssToLinear(DEBUG_BAND_COLORS[i + 1])),
        step(SEA_BAND_THRESHOLDS[i], heightVarying),
      );
    }
    return col;
  })();

  const material = new webgpu.MeshBasicNodeMaterial();
  material.positionNode = positionNode;
  material.colorNode = withRoad.mix(
    mix(debugCol, vec3(1.0, 0.0, 1.0), foamMask),
    debugUniform,
  );
  material.fog = false; // scene.fog is purple; the far sea must converge on haze instead
  return { material, debugUniform, radPerPixel, tierGain };
}

let detailNormalShared: THREE.DataTexture | null = null;
function makeDetailNormalTextureShared(): THREE.DataTexture {
  if (!detailNormalShared) detailNormalShared = makeDetailNormalTexture();
  return detailNormalShared;
}

function cssToLinear(css: string): [number, number, number] {
  const c = new THREE.Color(css);
  return [c.r, c.g, c.b];
}

/**
 * Build the sea: two FFT cascades, four ring meshes (`sea-r0..sea-r3`), one
 * material per ring. `renderer` is the live WebGPURenderer (the IFFT chain
 * dispatches through it); `sunDir` is main's live sun vector BY REFERENCE, so
 * the material's uniform and the sky/lights always read the same object.
 */
export async function initSea(
  scene: THREE.Scene,
  renderer: any,
  sunDir: THREE.Vector3,
): Promise<SeaOcean> {
  const handles: IfftHandle[] = [];
  for (const cascade of CASCADES) {
    const handle = await createIfft(renderer, { n: cascade.n, tileMetres: cascade.tileMetres });
    const spec = buildSpectrum({
      n: cascade.n,
      tileMetres: cascade.tileMetres,
      bandMetres: cascade.bandMetres,
      windSpeed: SPECTRUM_WIND_SPEED,
      windDirRad: SPECTRUM_WIND_DIR_RAD,
      seed: SPECTRUM_SEED,
    });
    await handle.upload(spec);
    handles.push(handle);
  }

  const meshes: THREE.Mesh[] = [];
  const materialBits: { debugUniform: any; radPerPixel: any; tierGain: any }[] = [];
  for (let i = 0; i < RINGS.length; i += 1) {
    const ring = RINGS[i];
    const built = await buildSeaMaterial({
      ring,
      nextRing: RINGS[i + 1],
      height0: handles[0].sampledHeight,
      chop0: handles[0].sampledChop,
      slope0: handles[0].sampledSlope,
      jac0: handles[0].sampledJacobian,
      tile0: CASCADES[0].tileMetres,
      height1: handles[1].sampledHeight,
      chop1: handles[1].sampledChop,
      slope1: handles[1].sampledSlope,
      jac1: handles[1].sampledJacobian,
      tile1: CASCADES[1].tileMetres,
      sunDirection: sunDir,
    });
    const mesh = new THREE.Mesh(
      buildRingGeometry(ring),
      built.material as unknown as THREE.Material,
    );
    mesh.name = `sea-r${ring.index}`;
    mesh.frustumCulled = false;
    scene.add(mesh);
    meshes.push(mesh);
    materialBits.push({
      debugUniform: built.debugUniform,
      radPerPixel: built.radPerPixel,
      tierGain: built.tierGain,
    });
  }

  let time = 0;
  let highQuality = true;

  return {
    get time(): number {
      return time;
    },
    update(camera: THREE.Vector3, radPerPixel: number, t: number): void {
      time = t;
      for (const bits of materialBits) bits.radPerPixel.value = radPerPixel;
      // Without a renderer (node tests) the clock still advances; the GPU
      // dispatch and the mip blit need the live WebGPURenderer.
      if (renderer) {
        handles[0].compute(t);
        if (highQuality) handles[1].compute(t);
      }
      for (const mesh of meshes) mesh.position.set(camera.x, 0, camera.z);
    },
    setQuality(high: boolean): void {
      // Low tier drops the chop cascade (fewer dispatches, a calmer sea) and
      // applies the road's per-tier gain once measurement pins one.
      highQuality = high;
      const gain = high ? 1.0 : SUN_ROAD.lowTierGain;
      for (const bits of materialBits) bits.tierGain.value = gain;
    },
    setVisible(v: boolean): void {
      for (const mesh of meshes) mesh.visible = v;
    },
    setDebug(on: boolean): void {
      for (const bits of materialBits) bits.debugUniform.value = on ? 1 : 0;
    },
    dispose(): void {
      for (const mesh of meshes) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as unknown as { dispose?: () => void }).dispose?.();
      }
      for (const handle of handles) handle.dispose();
      if (detailNormalShared) {
        detailNormalShared.dispose();
        detailNormalShared = null;
      }
    },
  };
}
