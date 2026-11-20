import { initObjectReflection } from './object-reflection';
/**
 * World-anchored FFT sea with legacy water optics and an opt-in painted look.
 * Both paths sample the sky's own TSL reflection function.
 *
 * Vertex: `mod(worldXZ, tileMetres)` anchors the displacement to the world, so
 * the rings can tow continuously with the camera and nothing slides. Each ring
 * samples at its own `mipLod` (a trilinear low-pass that removes every wave the
 * ring's vertex spacing cannot resolve) and blends towards the next ring's mip
 * inside the one-cell overlap, so LOD transitions never show as content seams.
 * Every ring samples the chop cascade in the fragment, where it carries half the
 * surface slope; only R0 carries it in the vertex displacement, since the outer
 * rings cannot resolve 32-128 m waves per vertex.
 *
 * Legacy fragment: the body colour is a continuous Fresnel-weighted composition of the
 * sky's own colour (`skyColorTsl` — the same function the dome uses, so sea and
 * sky cannot disagree), a view-angle body scatter, Beer-Lambert crest tinting
 * and a backlit-crest term. The old four flat `step()` bands are gone: they were
 * why every swell read as a hard-edged patch of one colour.
 * Painted fragments use cloud-style light/shadow transitions, crest whitecaps,
 * sparse shoulder strokes and bounded sun-road patches with footprint AA.
 *
 * `?sea=debug` (debugUniform) swaps the shading for flat band colours so Task
 * 12 can measure each band's screen coverage and reverse-solve the palette.
 * The height bands now exist ONLY in that debug path.
 *
 * CHOPPINESS is already baked into the chop/Jacobian textures by the GPU IFFT
 * chain, so the material consumes displacement as-is.
 */
import * as THREE from 'three';

import { SEA_BAND_THRESHOLDS } from './bands';
import { C1_VERTEX_MIP_LOD, CASCADES } from './cascades';
import { SEA_FOAM_THRESHOLD } from './foam';
import { createIfft, type IfftHandle } from './fft-gpu';
import { accumulateSpectrum, buildSpectrum, spectrumScaleToPeak } from './spectrum';
import { RINGS, type Ring } from './rings';
import { buildRingGeometry, holeInset } from './rings-mesh';
import { HAZE_COLOR, SEA_PALETTE } from '../palettes';
import { HORIZON, awayHorizonLinear } from '../horizon';
import type { Vec3 } from '../sky-track';
import { SUN_ROAD } from './sun-road';
import { CREST_REFERENCE_METRES, HAZE_CONVERGE_END, HAZE_CONVERGE_START, WATER_OPTICS } from './water-shading';
import { skyColorTsl } from '../sky-webgpu';
import { PAINTED_SEA, SEA_REFINEMENT, seaLookSettings, type SeaLook, type SeaDiagnostic } from './look';
import { PAINT_CONSTANTS } from '../bg-cumulus-paint';
import { DAYLIGHT } from '../daylight';
import { HEADLIGHT, headlightFieldTsl, type HeadlightUniforms } from '../headlight';
import { CLOUD_REFLECTION, initCloudReflection } from './cloud-reflection';

/** Spectrum production values (plan Global Constraints). */
const SPECTRUM_WIND_SPEED = 9;
const SPECTRUM_WIND_DIR_RAD = 0.212;
const SPECTRUM_SEED = 20261106;

/** Detail normal map: 4 m repeat over 256² texels = 1.6 cm per texel. */
const DETAIL_REPEAT_METRES = 4;
const DETAIL_SIZE = 256;
const DETAIL_TEXEL_METRES = DETAIL_REPEAT_METRES / DETAIL_SIZE;

/**
 * Metres per texel of each cascade's field texture. The fragment samples the
 * wave field at the mip whose texel is closest to one pixel (see `lodF0`), so
 * these two numbers are the scale the mip index is measured in.
 */
const TEXEL0_METRES = CASCADES[0].tileMetres / CASCADES[0].n;
const TEXEL1_METRES = CASCADES[1].tileMetres / CASCADES[1].n;

/**
 * Body scatter, crest tint, subsurface and foam read from the single-source
 * `SEA_PALETTE`. The thresholds, extinctions and gains live in
 * `water-shading.ts`; the pair moves together via this module.
 */
const FOAM_COLOR = hex(SEA_PALETTE.foam);

/** False-colour palette for `?sea=debug` coverage measurement. */
const DEBUG_BAND_COLORS: readonly [string, string, string, string] = [
  '#003366',
  '#0066cc',
  '#66ccff',
  '#ffffff',
];

/** numeric hex → css string for `THREE.Color`. */
function hex(value: number): string {
  return '#' + value.toString(16).padStart(6, '0');
}

export interface SeaOcean {
  readonly time: number;
  update(camera: THREE.Vector3, radPerPixel: number, t: number, speed01?: number): void;
  /**
   * Tell all four ring materials the sun (and therefore the sky) moved.
   * `sunU` is bound to `SunState.direction` by reference, so this is an
   * explicit, testable sync path rather than a hidden alias — if a caller ever
   * rebinds the vector, the reflection still follows the sky.
   */
  setSunDirection(dir: THREE.Vector3): void;
  /**
   * Push the track-derived haze endpoints (day-night Task 5, from
   * `sky-color-js.seaHazeEndpoints`) into every ring WITHOUT rebuilding the
   * material — all four rings share one uniform pair, so this is one write.
   * Linear RGB, matching `skyColorJs` output.
   */
  setHazeTargets(hazeLinear: Vec3, awayEdgeLinear: Vec3): void;
  setQuality(high: boolean): void;
  setVisible(visible: boolean): void;
  setDebug(on: boolean): void;
  setLook(look: SeaLook, diagnostic?: SeaDiagnostic, refined?: boolean): void;
  setCloudReflection(on: boolean): void;
  setNightCloudReflection(on: boolean): void;
  setObjectReflection(on: boolean): void;
  setPuffReflectionSoft(on: boolean): void;
  updateObjectReflection(scene: THREE.Scene, camera: THREE.PerspectiveCamera, time: number): void;
  readonly objectReflectionCaptures: number;
  readonly objectReflectionResolution: number[];
  updateCloudReflection(scene: THREE.Scene, camera: THREE.Vector3, time: number): void;
  readonly reflectionCaptures: number;
  /**
   * QA A/B 专用（`?sea=nochop`，细八度计划 Task 1）：只闸 `c1Gate` 不停派发，
   * 证明「近场结构来自 C1 波场」。一旦设置就钉住 c1Gate 不让 setQuality 的
   * 自动降档/回升改写。`clearChopGate()` 显式解除覆盖。
   */
  setChopGate(on: boolean): void;
  /** 解除 setChopGate 设置的 chopOverride，c1Gate 立即同步为当前画质档隐含值。 */
  clearChopGate(): void;
  dispose(): void;
}

export interface SeaMaterialOpts {
  headlight?: HeadlightUniforms;
  ring: Ring;
  /** The next ring outward, for the LOD blend in the overlap band. */
  nextRing?: Ring;
  height0: unknown;
  chop0: unknown;
  slope0: unknown;
  jac0: unknown;
  tile0: number;
  /**
   * Add the chop cascade to the VERTEX displacement (R0 only: the outer rings'
   * vertices cannot resolve 32-128 m waves). The fragment always samples it —
   * choking the chop off at a ring edge is a hard shading seam, because the
   * chop supplies half the surface slope.
   */
  vertexChop?: boolean;
  height1?: unknown;
  chop1?: unknown;
  slope1?: unknown;
  jac1?: unknown;
  tile1?: number;
  sunDirection: THREE.Vector3;
  /**
   * Shared sea-haze endpoint uniforms (day-night Task 5): ONE pair created by
   * `initSea` and passed to every ring, so `setHazeTargets` moves all four rings
   * at once and the endpoints track the sky. Omitted → the material creates its
   * own pair seeded from today's constants (same default graph state).
   */
  hazeU?: { haze: unknown; awayEdge: unknown };
  cloudReflection?: Awaited<ReturnType<typeof initCloudReflection>>;
  objectReflection?: Awaited<ReturnType<typeof initObjectReflection>>;
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
      // Keep the source height in alpha for broad, world-anchored foam gaps.
      data[i + 3] = Math.round(height[y * size + x] * 255);
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
  const { positionLocal, positionWorld, texture, uniform } = tsl;
  const { float, max, mix, normalize, reflect, smoothstep, step, vec2, vec3, cameraPosition } = tsl;
  const { exp, saturate, clamp, log2 } = tsl;

  const { ring, nextRing } = opts;
  const debugUniform = uniform(0);
  const radPerPixel = uniform(6.014e-4);
  const tierGain = uniform(SUN_ROAD.lowTierGain);
  // Quality gate for the chop cascade: on the low tier the C1 dispatches stop,
  // and this uniform removes its (then frozen) contribution inside the graph.
  const c1Gate = uniform(1);
  // P2-3: the plane's speed, pushed per frame by update() (default 0 =
  // today's look). Lifts the sun-road sparkle cores 15% at full speed.
  const speedU = uniform(0);
  const lookU = Object.fromEntries(Object.entries(seaLookSettings('legacy'))
    .map(([key, value]) => [key, uniform(value)]));

  // --- vertex: world-mod displacement at this ring's mip level --------------
  const worldXZ = positionWorld.xz;
  // LOD blending measures RING-LOCAL radius: the mesh is towed with the camera,
  // so world coordinates would saturate the blend the moment it flies.
  const localXZ = positionLocal.xz;
  const squareRadius = max(localXZ.x.abs(), localXZ.y.abs());

  let lod = float(ring.mipLod);
  let edgeBlend = float(0);
  if (nextRing) {
    // Blend towards the next ring's coarser mip inside the one-cell overlap.
    const blendStart = holeInset(nextRing);
    edgeBlend = smoothstep(blendStart, ring.outer, squareRadius);
    lod = mix(
      float(ring.mipLod),
      float(nextRing.mipLod),
      edgeBlend,
    );
  }

  const uv0 = worldXZ.mod(opts.tile0).div(opts.tile0);
  const h0 = texture(opts.height0, uv0).level(lod).x;
  const chop0 = texture(opts.chop0, uv0).level(lod).xy;
  let heightSum = h0;
  let dispSum = chop0;
  if (opts.vertexChop && opts.height1 && opts.chop1 && opts.tile1) {
    const uv1 = worldXZ.mod(opts.tile1).div(opts.tile1);
    // Vertex C1 low-passed at the 32 m floor (C1_VERTEX_MIP_LOD ≈ 3.1287): the
    // rings.ts contract says `mipLod` must cut waves below the ring floor, and
    // the fine 4–27.5 m octave (Task 2) lives in this same texture — it reaches
    // the FRAGMENT path only, never the 6.4 m-cell vertex grid.
    // The next ring has no vertex C1. Fade both vertical and horizontal
    // displacement over the overlap; fragment wave detail remains intact.
    const vertexC1Weight = c1Gate.mul(edgeBlend.oneMinus());
    heightSum = heightSum.add(texture(opts.height1, uv1).level(C1_VERTEX_MIP_LOD).x.mul(vertexC1Weight));
    dispSum = dispSum.add(texture(opts.chop1, uv1).level(C1_VERTEX_MIP_LOD).xy.mul(vertexC1Weight));
  }

  const positionNode = positionLocal.add(vec3(dispSum.x, heightSum, dispSum.y));

  // --- fragment: continuous water optics (src/sea/water-shading.ts) --------
  // The wave field is sampled AT FRAGMENT RATE, at the mip whose texel matches
  // one pixel's footprint. Per-vertex sampling (the first version) interpolated
  // the slopes across 25-128 m ring cells, which is what made every swell read
  // as a flat facet creased at the triangle edge.
  const distance = positionWorld.sub(cameraPosition).length();
  const footMetres = distance.mul(radPerPixel);
  const fragUv0 = worldXZ.mod(opts.tile0).div(opts.tile0);
  const lodF0 = clamp(log2(footMetres.div(TEXEL0_METRES)), 0.0, 8.0);
  // Legacy crest tint stays C0-only. Painted brush fields below sample the
  // same fragment wave data on every ring, independently of vertex density.
  const hFrag = texture(opts.height0, fragUv0).level(lodF0).x;
  const swellSlope = texture(opts.slope0, fragUv0).level(lodF0).xy;
  let slopeSum = swellSlope;
  const jacF0 = texture(opts.jac0, fragUv0).level(lodF0).xyz; // (dxx, dzz, dxz)
  // Broad swells support the surface; the smaller wind waves carry brush shapes.
  // Low quality falls back to the live swell field when C1 simulation stops.
  let paintHeight = hFrag.mul(0.25);
  let paintSlope = swellSlope.mul(0.25);
  let paintCurvature = jacF0.x.add(jacF0.y).mul(0.25);
  let dxxSum = jacF0.x;
  let dzzSum = jacF0.y;
  let dxzSum = jacF0.z;
  if (opts.height1 && opts.chop1 && opts.slope1 && opts.jac1 && opts.tile1) {
    const fragUv1 = worldXZ.mod(opts.tile1).div(opts.tile1);
    const lodF1 = clamp(log2(footMetres.div(TEXEL1_METRES)), 0.0, 8.0);
    const slope1 = texture(opts.slope1, fragUv1).level(max(lodF1, lookU.c1MinLod)).xy;
    slopeSum = slopeSum.add(slope1.mul(c1Gate));
    const brushLod = max(lodF1, PAINTED_SEA.c1MinLod);
    const brushHeight = texture(opts.height1, fragUv1).level(brushLod).x;
    const brushJac = texture(opts.jac1, fragUv1).level(brushLod).xyz;
    paintHeight = mix(paintHeight, brushHeight, c1Gate);
    paintSlope = mix(paintSlope, slope1, c1Gate);
    paintCurvature = mix(paintCurvature, brushJac.x.add(brushJac.y), c1Gate);
    const jac1 = texture(opts.jac1, fragUv1).level(lodF1).xyz;
    dxxSum = dxxSum.add(jac1.x.mul(c1Gate));
    dzzSum = dzzSum.add(jac1.y.mul(c1Gate));
    dxzSum = dxzSum.add(jac1.z.mul(c1Gate));
  }

  // C1 already includes 4–27.5 m waves. Painted low-passes only its reflection
  // slope using existing mips; displacement/Jacobians retain the original field.
  const slopeScale = lookU.slopeGain;
  const normalBase = normalize(
    vec3(
      slopeSum.x.negate().mul(slopeScale),
      float(1.0),
      slopeSum.y.negate().mul(slopeScale),
    ),
  );

  // Detail normal, gated by its screen footprint (see bands.detailWeight).
  const detailPx = float(DETAIL_TEXEL_METRES).div(footMetres);
  const detailGate = smoothstep(1.0, 2.0, detailPx).mul(lookU.detail);
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
  // The live sun vector arrives by reference from main; one uniform, many readers.
  const sunU = uniform(opts.sunDirection);
  const daylight = smoothstep(DAYLIGHT.water[0], DAYLIGHT.water[1], sunU.y);
  const directSun = smoothstep(DAYLIGHT.direct[0], DAYLIGHT.direct[1], sunU.y);
  const waterIllumination = mix(vec3(...DAYLIGHT.waterNight), vec3(1), daylight);
  const foamIllumination = mix(vec3(...DAYLIGHT.foamNight), vec3(1), daylight);

  // Body scatter: v = |dot(V, N)| is 1 looking straight down, 0 at grazing. The
  // (deep, grazing) pair is the references' cos-lerp — NOT a depth or height
  // ramp, which is what the four flat bands were pretending to be.
  const v = saturate(viewDir.dot(normalNode).abs());
  const bodyCol = mix(
    vec3(...cssToLinear(hex(SEA_PALETTE.grazing))),
    vec3(...cssToLinear(hex(SEA_PALETTE.deep))),
    v,
  );

  // Thin water at a crest picks up the shallow tint: Beer-Lambert over the
  // column above the sample, continuous by construction — there is no threshold
  // anywhere, so no band edge can appear.
  const column = float(CREST_REFERENCE_METRES).sub(hFrag).max(0.0);
  const transmittance = exp(column.mul(-WATER_OPTICS.EXTINCTION_PER_METRE));
  const crestAA = tsl.fwidth(hFrag);
  const crestPaint = smoothstep(float(PAINTED_SEA.crestLow).sub(crestAA),
    float(PAINTED_SEA.crestHigh).add(crestAA), hFrag);
  const bodyTinted = mix(
    bodyCol,
    vec3(...cssToLinear(hex(SEA_PALETTE.shallow))),
    mix(transmittance.mul(WATER_OPTICS.CREST_TINT), crestPaint.mul(PAINTED_SEA.crestTint), lookU.painted),
  );
  const nDotL = saturate(normalNode.dot(sunU));
  const bodyLit = bodyTinted.mul(
    float(WATER_OPTICS.BODY_AMBIENT).add(nDotL.mul(mix(WATER_OPTICS.BODY_SUN, PAINTED_SEA.bodySun, lookU.painted))),
  );

  // Backlit crest (Crest's SSS term): sunlight through thin water toward the
  // eye, so the eye must look INTO the sun — viewDir runs camera→surface, that
  // is dot(viewDir, sunU). The shipped negate fired it on the front-lit side
  // (QA round 1, B frame: the away sea carried ghost glow).
  const towardSun = saturate(viewDir.dot(sunU));
  const crestMask = towardSun
    .pow(WATER_OPTICS.CREST_POW)
    .mul(transmittance)
    .mul(float(1.0).sub(v.mul(v)));
  const crestGlowCol = vec3(...cssToLinear(hex(SEA_PALETTE.subsurface)))
    .mul(crestMask)
    .mul(mix(WATER_OPTICS.CREST_GAIN, PAINTED_SEA.crestGlow, lookU.painted));

  // Sky reflection, Fresnel-weighted. F runs F0 (0.0204) head-on → 1 at
  // grazing, so the far water dissolves into the sky's own warm horizon with no
  // distance fog and no hard horizon line. The old constant 0.45 mix was the
  // stand-in for this term — and the reason the near sea was neither water nor
  // sky. `false` drops the sun DISC (double-sun dedup): the specular road below
  // already paints the mirror image of the sun from the same normals.
  const reflected = reflect(viewDir, normalNode);
  const skyColor = skyColorTsl(tsl, reflected, sunU, false);
  let cloudSky = skyColor;
  let nightCloudContrast = vec3(0);
  const reflectionStage = opts.cloudReflection?.stage ?? float(0);
  if (opts.cloudReflection) {
    const nightGain = float(1).sub(daylight).mul(opts.cloudReflection.night);
    // Broader normal response keeps cloud reflections as soft broken patches.
    const cloudNormal = normalize(vec3(normalBase.x.mul(mix(0.65,0.35,nightGain)), 1, normalBase.z.mul(mix(0.65,0.35,nightGain))));
    const cloudRay = reflect(viewDir, cloudNormal);
    const cloud = tsl.cubeTexture(opts.cloudReflection.texture, cloudRay).level(mix(CLOUD_REFLECTION.lod, 1.0, nightGain));
    const gate = opts.cloudReflection.enabled.mul(smoothstep(0, 0.04, cloudRay.y));
    // Render-target RGB is premultiplied. Never divide by near-zero cloud alpha.
    cloudSky = cloud.rgb.mul(gate).add(skyColor.mul(float(1).sub(cloud.a.mul(gate))));
    // Cloud-only contrast: exact zero in clear sky texels. A smooth knee bounds
    // added radiance without lifting the sea's body or empty-sky reflection.
    const signal = cloud.rgb.max(vec3(0)).mul(2.8);
    nightCloudContrast = signal.mul(0.055).div(signal.add(0.055)).mul(gate).mul(nightGain);
  }
  const fres = float(SUN_ROAD.F0).add(
    float(1 - SUN_ROAD.F0).mul(float(1.0).add(viewDir.dot(normalNode)).pow(5.0)),
  );
  const reflectionWeight = fres.mul(lookU.reflection);
  const waterOptics = bodyLit.add(crestGlowCol).mul(float(1.0).sub(reflectionWeight)).add(skyColor.mul(reflectionWeight));
  // The cloud's soft shadow ramp and short lit transition also organise the sea.
  // Bias with broad height so the colour shapes describe waves at grazing views.
  // Smoothly hand the painted faces to the moon, with a zenith fill at dusk.
  // Unlike an abrupt sign switch, this direction never collapses to zero.
  const lightHandOff = smoothstep(DAYLIGHT.water[0], 0, sunU.y).mul(2).sub(1);
  const nightFaceDir = normalize(vec3(sunU.x.mul(lightHandOff),
    sunU.y.mul(lightHandOff).max(0.035).add(float(1).sub(lightHandOff.abs()).mul(0.5)),
    sunU.z.mul(lightHandOff)));
  const faceDir = mix(sunU, nightFaceDir, lookU.refined);
  const paintLight = saturate(normalBase.dot(faceDir).sub(faceDir.y.mul(0.85))
    .mul(1.5).add(0.42).add(hFrag.mul(0.7)));
  const paintAA = tsl.fwidth(paintLight);
  const litFace = smoothstep(float(PAINT_CONSTANTS.hardEdge[0]).sub(paintAA),
    float(PAINT_CONSTANTS.hardEdge[1]).add(paintAA), paintLight);
  const softShade = smoothstep(PAINT_CONSTANTS.shadeMix[0], PAINT_CONSTANTS.shadeMix[1], paintLight);
  // Keep the body in one water hue family. Sky tint enters once through the
  // bounded reflection weight, so moving normals cannot recolour the lit face.
  const shadePaint = mix(vec3(...cssToLinear(hex(SEA_PALETTE.deep))),
    vec3(...cssToLinear(hex(SEA_PALETTE.shallow))),
    mix(PAINTED_SEA.bodyShadeLift[0], PAINTED_SEA.bodyShadeLift[1], softShade));
  const lightPaint = mix(vec3(...cssToLinear(hex(SEA_PALETTE.shallow))),
    vec3(...cssToLinear(hex(SEA_PALETTE.subsurface))), PAINTED_SEA.bodyLightLift);
  // Narrow wind-wave shoulders draw elongated strokes. Swell illumination
  // only modulates the quiet body, avoiding cloud-sized dark islands.
  const waveAA = tsl.fwidth(paintHeight);
  const windSlope = paintSlope.dot(vec2(Math.sin(SPECTRUM_WIND_DIR_RAD), -Math.cos(SPECTRUM_WIND_DIR_RAD)));
  const windSlopeAA = tsl.fwidth(windSlope);
  const shoulder = float(1).sub(smoothstep(float(PAINTED_SEA.rippleSlope[0]).sub(windSlopeAA),
    float(PAINTED_SEA.rippleSlope[1]).add(windSlopeAA), windSlope.abs()));
  const rippleFade = float(1).sub(smoothstep(PAINTED_SEA.rippleFade[0], PAINTED_SEA.rippleFade[1], distance));
  const rippleCoverage = float(PAINTED_SEA.rippleHeight[1] - PAINTED_SEA.rippleHeight[0])
    .div(waveAA.max(PAINTED_SEA.rippleHeight[1] - PAINTED_SEA.rippleHeight[0]));
  const lightStroke = smoothstep(float(PAINTED_SEA.rippleHeight[0]).sub(waveAA),
    float(PAINTED_SEA.rippleHeight[1]).add(waveAA), paintHeight).mul(shoulder).mul(rippleFade).mul(rippleCoverage);
  const darkStroke = smoothstep(float(PAINTED_SEA.rippleHeight[0]).sub(waveAA),
    float(PAINTED_SEA.rippleHeight[1]).add(waveAA), paintHeight.negate())
    .mul(shoulder).mul(rippleFade).mul(rippleCoverage).mul(PAINTED_SEA.rippleShadow);
  const calmBody = mix(shadePaint, vec3(...cssToLinear(hex(SEA_PALETTE.shallow))), 0.55);
  const waveBody = mix(calmBody, shadePaint, darkStroke);
  const paintedBody = mix(waveBody, lightPaint, lightStroke.mul(litFace.mul(0.35).add(0.65)));
  const paintedWater = mix(paintedBody, skyColor, reflectionWeight.mul(0.65));
  const shaded = mix(waterOptics, paintedWater, lookU.painted);

  // Broad, softly separated wave faces: a restrained ambient shape term that
  // works on side/back views too, without adding a second specular highlight.
  const formSignal = paintHeight.mul(SEA_REFINEMENT.formHeight)
    .add(windSlope.mul(SEA_REFINEMENT.formSlope)).add(hFrag.mul(SEA_REFINEMENT.formSwell));
  const formAA = tsl.fwidth(formSignal);
  const formFace = smoothstep(float(SEA_REFINEMENT.formEdge[0]).sub(formAA),
    float(SEA_REFINEMENT.formEdge[1]).add(formAA), formSignal);
  const formFade = float(1).sub(smoothstep(...SEA_REFINEMENT.formFade, distance));
  const formBody = mix(shadePaint.mul(0.82), calmBody.mul(1.08), formFace);
  const refinedBody = mix(paintedBody, formBody, formFade.mul(SEA_REFINEMENT.formStrength));
  const refinedIllumination = mix(vec3(...SEA_REFINEMENT.waterNight), vec3(1), daylight);
  // The sky already carries night exposure. Attenuate the water body only,
  // then combine the reflection once instead of darkening it a second time.
  const reflectedEnvironment = mix(skyColor, cloudSky, reflectionStage);
  const previousReflectionWeight = reflectionWeight.mul(0.65);
  const environmentWeight = mix(previousReflectionWeight,
    previousReflectionWeight.mul(CLOUD_REFLECTION.gain).min(CLOUD_REFLECTION.maxWeight), reflectionStage);
  const refinedWater = mix(refinedBody.mul(refinedIllumination), reflectedEnvironment, environmentWeight)
    .add(nightCloudContrast.mul(reflectionStage).mul(lookU.reflection.div(PAINTED_SEA.reflection))
      .mul(fres.clamp(0,1).mul(0.55).add(0.45)));

  // Jacobian foam: partials are summed ACROSS cascades above; the determinant
  // comes once, at the end (the per-cascade-product bug is in foam.test.ts).
  const jacobian = dxxSum.add(1.0).mul(dzzSum.add(1.0)).sub(dxzSum.mul(dxzSum));
  const foamMask = smoothstep(
    SEA_FOAM_THRESHOLD,
    SEA_FOAM_THRESHOLD + WATER_OPTICS.FOAM_SOFTNESS,
    float(1.0).sub(jacobian),
  );
  // Short whitecaps follow filtered wave ridges and the live curvature field.
  // World-anchored wave samples give them coherent motion and natural gaps.
  const ridgeSlope = windSlope.abs();
  const ridgeAA = tsl.fwidth(ridgeSlope);
  const ridgeWidth = mix(1, SEA_REFINEMENT.foamSlopeGain, lookU.refined);
  const ridge = float(1).sub(smoothstep(float(PAINTED_SEA.foamSlope[0]).mul(ridgeWidth).sub(ridgeAA),
    float(PAINTED_SEA.foamSlope[1]).mul(ridgeWidth).add(ridgeAA), ridgeSlope));
  // The IFFT stores +chi*kx²/|k|*h and +chi*kz²/|k|*h. Their trace is
  // positive at crests; 1-J from this displacement convention selects troughs.
  const curvature = paintCurvature;
  const curvatureAA = tsl.fwidth(curvature);
  const crestActivity = smoothstep(float(PAINTED_SEA.foamCurvature[0]).sub(curvatureAA),
    float(PAINTED_SEA.foamCurvature[1]).add(curvatureAA), curvature);
  const crestTop = smoothstep(float(PAINTED_SEA.foamHeight[0]).sub(waveAA),
    float(PAINTED_SEA.foamHeight[1]).add(waveAA), paintHeight);
  const markFade = float(1).sub(smoothstep(mix(PAINTED_SEA.markFade[0], SEA_REFINEMENT.foamFade[0], lookU.refined),
    mix(PAINTED_SEA.markFade[1], SEA_REFINEMENT.foamFade[1], lookU.refined), distance));
  const crestFoam = crestTop.mul(ridge).mul(crestActivity).mul(markFade);
  // Sparse lower-contrast water strokes sit on wave shoulders. Pixel coverage
  // suppresses thin contours before they can sparkle in the distance.
  const accent = float(1).sub(smoothstep(PAINTED_SEA.accentWidth,
    float(PAINTED_SEA.accentWidth).add(waveAA.max(0.003)), paintHeight.sub(PAINTED_SEA.accentHeight).abs()))
    .mul(float(PAINTED_SEA.accentWidth).div(waveAA.max(PAINTED_SEA.accentWidth)))
    .mul(crestActivity).mul(markFade).mul(PAINTED_SEA.accentStrength).mul(mix(1, 0.25, lookU.refined));
  // Reuse the normal texture's source noise at a much larger, elongated scale.
  // Both periods divide the world-rebase quantum, preserving marks on rebases.
  const breakup = texture(makeDetailNormalTextureShared(), worldXZ.div(
    mix(vec2(512, 128), vec2(...SEA_REFINEMENT.foamPeriod), lookU.refined))).a;
  const breakupAA = tsl.fwidth(breakup);
  const broken = smoothstep(mix(PAINTED_SEA.foamBreak[0], SEA_REFINEMENT.foamBreak[0], lookU.refined).sub(breakupAA),
    mix(PAINTED_SEA.foamBreak[1], SEA_REFINEMENT.foamBreak[1], lookU.refined).add(breakupAA), breakup);
  const ridgeCoverage = float(PAINTED_SEA.foamSlope[1]).mul(ridgeWidth)
    .div(ridgeAA.max(float(PAINTED_SEA.foamSlope[1]).mul(ridgeWidth)));
  // With C1 disabled, C0 crests are much wider. Keep those fallback caps quiet
  // instead of turning a low-altitude view into large white foam islands.
  const fallbackFoam = mix(SEA_REFINEMENT.lowTierFoam, 1, c1Gate);
  const paintFoam = max(crestFoam, accent).mul(broken).mul(mix(1, ridgeCoverage.mul(fallbackFoam), lookU.refined));
  const visibleFoam = mix(foamMask, paintFoam, lookU.painted).mul(lookU.foam);
  const refinedFoamColor = mix(vec3(...cssToLinear(FOAM_COLOR)), vec3(...cssToLinear(hex(SEA_PALETTE.shallow))), 0.22)
    .mul(mix(vec3(...SEA_REFINEMENT.foamNight), vec3(1), daylight));
  const withFoam = mix(mix(shaded.mul(waterIllumination), refinedWater, lookU.refined),
    mix(vec3(...cssToLinear(FOAM_COLOR)).mul(foamIllumination), refinedFoamColor, lookU.refined), visibleFoam);

  // Sun road (mirrors in sun-road.ts): the continuous sheen runs through a knee
  // capped at ROAD_CEILING — the old gloss × BASE × ROAD_PEAK chain reached
  // 3.0 and blew its budget 4x — and sparkle cores lift it only where the real
  // facet normal lands inside GLINT_COS_THRESHOLD of the mirror direction
  // (Cox-Munk: density rides the slope field, no noise texture). reflect(sunU, N)
  // (NO negate): viewDir runs camera→surface, so the negate would flip the glint
  // dot negative and clamp the road to zero.
  const glintDir = reflect(sunU, normalNode);
  const specDot = glintDir.dot(viewDir).max(0.0);
  // Straight-down view rays (FALL poses) make the XZ bearing degenerate; clamp
  // the length like skyColorTsl does instead of feeding NaN into the azimuths.
  const sunXZ = vec2(sunU.x, sunU.z).div(vec2(sunU.x, sunU.z).length().max(1e-4));
  const viewXZ = vec2(viewDir.x, viewDir.z).div(vec2(viewDir.x, viewDir.z).length().max(1e-4));
  const cosEdge = Math.cos((SUN_ROAD.WIDTH_DEG * Math.PI) / 180);
  const mask = smoothstep(cosEdge, 1.0, sunXZ.dot(viewXZ));
  const gate = float(SUN_ROAD.ROAD_FLOOR).add(
    float(SUN_ROAD.ROAD_PEAK - SUN_ROAD.ROAD_FLOOR).mul(mask),
  );
  const nearFade = smoothstep(SUN_ROAD.NEAR_FADE_START, SUN_ROAD.NEAR_FADE_END, distance);
  const skimRoad = smoothstep(...SEA_REFINEMENT.roadHeight, cameraPosition.y).oneMinus()
    .mul(smoothstep(...SEA_REFINEMENT.roadDistance, distance).oneMinus()).mul(lookU.refined);
  const roadGloss = mix(mix(SUN_ROAD.GLOSS_POW, PAINTED_SEA.gloss, lookU.painted),
    SEA_REFINEMENT.roadNearGloss, skimRoad);
  const drive = specDot
    .pow(roadGloss)
    .mul(SUN_ROAD.BASE)
    .mul(tierGain)
    .mul(nearFade)
    .mul(gate);
  const roadSpecKneeTsl = (x: any, k: number): any => float(1.0).sub(exp(x.mul(-k)));
  const roadKnee = roadSpecKneeTsl(drive, SUN_ROAD.KNEE_K);
  const roadAA = tsl.fwidth(roadKnee);
  const roadPatch = smoothstep(float(PAINTED_SEA.roadEdge[0]).sub(roadAA),
    float(PAINTED_SEA.roadEdge[1]).add(roadAA), roadKnee).mul(PAINTED_SEA.roadPlateau)
    .mul(mix(SUN_ROAD.ROAD_FLOOR, 1.0, mask)).mul(nearFade);
  const cont = mix(roadKnee, roadKnee.mul(0.25).add(roadPatch.mul(0.75)), lookU.painted)
    .mul(SUN_ROAD.ROAD_CEILING);
  // Widen the candidate's tiny core edge to at least a pixel footprint.
  // Legacy remains identical; the continuous lobe needs no threshold AA.
  const glintAA = tsl.fwidth(specDot).mul(lookU.painted);
  const sparkleGlintTsl = (c: any, dotV: any, gate01: any): any =>
    c.mul(
      float(1.0).add(
        // P2-3 speed lift (mirrors sun-road.ts sparkleGlint): the core term
        // grows 15% with speedU. Continuous road untouched — still knee-capped.
        mix(SUN_ROAD.SPARKLE_BOOST - 1, PAINTED_SEA.sparkle, lookU.painted).mul(
          smoothstep(
            float(SUN_ROAD.GLINT_COS_THRESHOLD).sub(glintAA),
            float(SUN_ROAD.GLINT_COS_THRESHOLD + SUN_ROAD.GLINT_COS_BAND).add(glintAA),
            dotV,
          ).mul(gate01),
        ).mul(float(1.0).add(speedU.mul(SUN_ROAD.ROAD_SPEED_LIFT))),
      ),
    );
  const glint = sparkleGlintTsl(cont, specDot, mask).mul(lookU.road).mul(directSun)
    .mul(mix(1, SEA_REFINEMENT.roadNearGain, skimRoad));
  const glintLinear = new THREE.Color(hex(SEA_PALETTE.glitter));
  // Moon is the sky's antipodal sun. A quiet cool reflection follows its actual
  // direction; it never reuses the warm sun road below the horizon.
  const moonDirection = sunU.negate();
  const moonSpec = reflect(moonDirection, normalNode).dot(viewDir).max(0).pow(48)
    .mul(float(1).sub(daylight)).mul(nearFade).mul(DAYLIGHT.moonGain)
    .mul(lookU.road.div(mix(1, PAINTED_SEA.road, lookU.painted)));
  const withRoad = withFoam.add(vec3(glintLinear.r, glintLinear.g, glintLinear.b)
    .mul(glint).mul(float(1).sub(visibleFoam.mul(lookU.painted))))
    .add(vec3(...DAYLIGHT.moonTint).mul(moonSpec));

  // Distance haze: converge on the colour the sky paints at its own edge — per
  // azimuth. `seaHazeTsl` mirrors horizon.ts `seaHazeTargetLinear`: the away
  // edge mix carries AWAY_GAIN exactly ONCE (weighting the pre-mixed edge with
  // antiSolarCool again would land at g² and crack the seam when HAZE_MAX or
  // AWAY_GAIN is retuned — final review, Important 1). Density and ceiling are
  // untouched (review M5/M6/M7).
  const cosAz = sunXZ.dot(viewXZ);
  // Haze endpoints are UNIFORM NODES (day-night Task 5): the track pushes the
  // per-key `skyColorJs`-derived endpoints in every frame without rebuilding the
  // material. Defaults = today's constants, so the untracked graph is unchanged;
  // the `awayHorizonLinear()` call is kept literally (material.test.ts pins it).
  const hazeU = opts.hazeU ?? {
    haze: uniform(new THREE.Vector3(...cssToLinear(HAZE_COLOR))),
    awayEdge: uniform(new THREE.Vector3(...awayHorizonLinear())),
  };
  const seaHazeTsl = (cos: any): any => {
    const away01 = saturate(float(1.0).sub(cos).mul(0.5));
    const lowSky = float(1.0).sub(smoothstep(0.0, HORIZON.AWAY_HEIGHT, reflected.y));
    // At the outer edge the haze must follow the VIEW bearing, not the wave's
    // reflected elevation. Otherwise tilted normals pull the anti-solar edge
    // back toward the warm sunward endpoint, leaving a bright horizon ribbon.
    const edgeConverge = smoothstep(HAZE_CONVERGE_START, HAZE_CONVERGE_END, distance);
    const w = away01.pow(1.2).mul(mix(lowSky, 1.0, edgeConverge.mul(lookU.painted)));
    // The away-edge mix carries AWAY_GAIN exactly ONCE (inside the edge value);
    // weighting the pre-mixed edge with antiSolarCool again would land at g².
    return mix(hazeU.haze, hazeU.awayEdge, w);
  };
  const hazeCol = seaHazeTsl(cosAz);
  // 指数雾 + 远端强制收敛，与 water-shading.ts 的 `seaHazeAmount` 同式；
  // 常量同源 import，两边漂了地平线会重新裂开。900 m 以内等价于原曲线。
  const expHaze = float(1.0).sub(exp(distance.mul(-WATER_OPTICS.HAZE_DENSITY_PER_METRE)));
  const baseHaze = expHaze.mul(WATER_OPTICS.HAZE_MAX);
  const convergeT = distance.sub(HAZE_CONVERGE_START).div(HAZE_CONVERGE_END - HAZE_CONVERGE_START);
  const converge = smoothstep(0.0, 1.0, convergeT);
  const hazeAmount = baseHaze.add(float(1.0).sub(baseHaze).mul(converge));
  // Local landing light uses the same world-space cone as cloud paint and air.
  let localWater = withRoad;
  if (opts.headlight) {
    const incidence = normalBase.dot(opts.headlight.direction.negate()).max(0).mul(0.65).add(0.35);
    const localLight = headlightFieldTsl(tsl, positionWorld, opts.headlight).mul(incidence).mul(0.32);
    localWater = localWater.add(vec3(...HEADLIGHT.tint).mul(localLight));
  }
  if (opts.objectReflection) {
    const reflection=opts.objectReflection;
    const projected=(reflection.matrix as any).mul(tsl.vec4(positionWorld.x,0,positionWorld.z,1));
    const ndc=projected.xy.div(projected.w.max(0.0001));
    const uv=vec2(ndc.x.mul(0.5).add(0.5),float(0.5).sub(ndc.y.mul(0.5)));
    // Restrained wave distortion preserves the aircraft silhouette. Keep the
    // capture projection from its own frame when the low-cost pass is throttled.
    const warped=uv.add(vec2(normalBase.x,normalBase.z).mul(0.006));
    // Broad distant reflections, modest blur near the aircraft. RGBA mip
    // filtering preserves premultiplication and avoids bright cloud fringes.
    const softLod=mix(1.0,2.6,smoothstep(70,650,distance));
    const sample=tsl.texture(reflection.texture,warped.clamp(0.001,0.999))
      .level(mix(0.7,softLod,reflection.puffSoftness));
    const edge=smoothstep(0,0.025,warped.x).mul(smoothstep(0,0.025,warped.y))
      .mul(smoothstep(0,0.025,warped.x.oneMinus())).mul(smoothstep(0,0.025,warped.y.oneMinus()));
    const weight=reflection.enabled.mul(reflection.strength).mul(edge).mul(tsl.step(0.001,projected.w))
      .mul(fres.clamp(0,1).mul(0.2).add(0.46)).mul(lookU.painted);
    localWater=localWater.mul(float(1).sub(sample.a.mul(weight))).add(sample.rgb.mul(weight));
  }
  const withHaze = mix(localWater, hazeCol, hazeAmount);

  // ?sea=debug: flat false-colour bands for coverage measurement.
  const debugCol = (() => {
    let col = vec3(...cssToLinear(DEBUG_BAND_COLORS[0]));
    for (let i = 0; i < SEA_BAND_THRESHOLDS.length; i += 1) {
      col = mix(
        col,
        vec3(...cssToLinear(DEBUG_BAND_COLORS[i + 1])),
        step(SEA_BAND_THRESHOLDS[i], hFrag),
      );
    }
    return col;
  })();

  const material = new webgpu.MeshBasicNodeMaterial();
  material.positionNode = positionNode;
  // Function form, not the .mix() method: in three r186 the method form
  // resolves the factor against the wrong operand and returns the debug
  // swatch, which is why the sea wore the ?sea=debug palette.
  material.colorNode = mix(
    withHaze,
    mix(debugCol, vec3(1.0, 0.0, 1.0), foamMask),
    debugUniform,
  );
  material.fog = false; // scene.fog is purple; the far sea must converge on haze instead
  // `sunU` goes out with the other per-ring uniforms so `initSea` can expose a
  // single setSunDirection() for the whole ocean. Without it the sea had NO way
  // to be told that the sky had moved — the boot-time alias was the only link.
  // `hazeU` goes out too: shared when `opts.hazeU` was passed, else this ring's own.
  return { material, debugUniform, radPerPixel, tierGain, c1Gate, sunU, hazeU, speedU, lookU };
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
 * dispatches through it); `sunDir` is `SunState.direction` BY REFERENCE, so the
 * material's uniform and the sky dome read the same object. `setSunDirection`
 * adds the explicit sync path on top of that alias (2026-11-08 linkage fix).
 */
export async function initSea(
  scene: THREE.Scene,
  renderer: any,
  sunDir: THREE.Vector3,
  headlight?: HeadlightUniforms,
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
    // The raw Phillips amplitude is design-independent — clamp the crest to the
    // cascade's amplitudePeak (see spectrumScaleToPeak for the Hs = 4σ convention).
    const scale = spectrumScaleToPeak(spec, cascade.amplitudePeak);
    for (let i = 0; i < spec.re.length; i += 1) {
      spec.re[i] *= scale;
      spec.im[i] *= scale;
    }
    if (cascade.fineBandMetres && cascade.fineCrestMetres !== undefined && cascade.fineSeed !== undefined) {
      // Fine 4–27.5 m octave merged into the SAME lattice (fine-octave plan
      // Task 2): independent random stream, own crest target, pure per-cell add
      // AFTER both are scaled — the 32–128 m sub-band coefficients above stay
      // bit-identical (fine-band.test.ts golden pin). Sub-band build/scale code
      // untouched.
      const fineSpec = buildSpectrum({
        n: cascade.n,
        tileMetres: cascade.tileMetres,
        bandMetres: cascade.fineBandMetres,
        windSpeed: SPECTRUM_WIND_SPEED,
        windDirRad: SPECTRUM_WIND_DIR_RAD,
        seed: cascade.fineSeed,
      });
      const fineScale = spectrumScaleToPeak(fineSpec, cascade.fineCrestMetres);
      for (let i = 0; i < fineSpec.re.length; i += 1) {
        fineSpec.re[i] *= fineScale;
        fineSpec.im[i] *= fineScale;
      }
      accumulateSpectrum(spec, fineSpec);
    }
    await handle.upload(spec);
    handles.push(handle);
  }

  const meshes: THREE.Mesh[] = [];
  // ONE shared endpoint pair for all four rings (day-night Task 5): built once
  // here, passed to every `buildSeaMaterial`, written in place by setHazeTargets.
  const tsl = (await import('three/tsl')) as any;
  const sharedHaze = {
    haze: tsl.uniform(new THREE.Vector3(...cssToLinear(HAZE_COLOR))),
    awayEdge: tsl.uniform(new THREE.Vector3(...awayHorizonLinear())),
  };
  const cloudReflection = await initCloudReflection(renderer);
  const objectReflection = await initObjectReflection(renderer);
  const materialBits: { debugUniform: any; radPerPixel: any; tierGain: any; c1Gate: any; sunU: any; hazeU: { haze: any; awayEdge: any }; speedU: any; lookU: Record<string, any> }[] = [];
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
      // Chop cascade (32-128 m) reaches every ring's FRAGMENT path, where it
      // carries half the slope; only R0 can take it per vertex.
      height1: handles[1].sampledHeight,
      chop1: handles[1].sampledChop,
      slope1: handles[1].sampledSlope,
      jac1: handles[1].sampledJacobian,
      tile1: CASCADES[1].tileMetres,
      vertexChop: i === 0,
      sunDirection: sunDir,
      hazeU: sharedHaze,
      cloudReflection,
      objectReflection,
      headlight,
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
      c1Gate: built.c1Gate,
      sunU: built.sunU,
      hazeU: built.hazeU,
      speedU: built.speedU,
      lookU: built.lookU,
    });
  }

  let time = 0;
  let highQuality = true;
  // 外部（如 ?sea=nochop）显式设置过的 chop 意图，不让 setQuality 的自动
  // 降档/回升静默改写。null = 无覆盖（setQuality 自由改 c1Gate）。
  let chopOverride: boolean | null = null;

  return {
    get time(): number {
      return time;
    },
    update(camera: THREE.Vector3, radPerPixel: number, t: number, speed01: number = 0): void {
      time = t;
      // P2-3: garbage speed reads as parked (today's look), never a flash.
      const s = Number.isFinite(speed01) ? Math.min(Math.max(speed01, 0), 1) : 0;
      for (const bits of materialBits) bits.radPerPixel.value = radPerPixel;
      for (const bits of materialBits) bits.speedU.value = s;
      // Without a renderer (node tests) the clock still advances; the GPU
      // dispatch and the mip blit need the live WebGPURenderer.
      if (renderer) {
        handles[0].compute(t);
        if (highQuality) handles[1].compute(t);
      }
      for (const mesh of meshes) mesh.position.set(camera.x, 0, camera.z);
    },
    setSunDirection(dir: THREE.Vector3): void {
      // Every ring's sunU drives: body diffuse (nDotL), backlit crests, the
      // sky reflection's glow/away-cool, the sun road's bearing gate and the
      // mirror glint, and the azimuthal haze colour. One call updates the lot.
      for (const bits of materialBits) bits.sunU.value.copy(dir).normalize();
    },
    setHazeTargets(hazeLinear: Vec3, awayEdgeLinear: Vec3): void {
      // All four rings share ONE uniform pair, so this write is effectively
      // single — the loop keeps the same shape as setSunDirection. Must be fed
      // EVERY frame by the track (Task 7): the endpoints are per-key values, not
      // boot-time constants, and nothing here re-derives them.
      for (const bits of materialBits) {
        (bits.hazeU.haze.value as THREE.Vector3).set(hazeLinear[0], hazeLinear[1], hazeLinear[2]);
        (bits.hazeU.awayEdge.value as THREE.Vector3).set(awayEdgeLinear[0], awayEdgeLinear[1], awayEdgeLinear[2]);
      }
    },
    setQuality(high: boolean): void {
      // Low tier stops the chop dispatches AND gates its (then frozen) texture
      // contribution inside every graph, so nothing samples stale C1 data —
      // UNLESS an external caller (e.g. ?sea=nochop) has pinned the chop gate:
      // then we only touch tierGain and leave c1Gate alone (chopOverride 守卫).
      highQuality = high;
      cloudReflection.setQuality(high);
      objectReflection.setQuality(high);
      const gain = high ? 1.0 : SUN_ROAD.lowTierGain;
      const gate = chopOverride !== null ? chopOverride : (high ? 1 : 0);
      for (const bits of materialBits) {
        bits.tierGain.value = gain;
        bits.c1Gate.value = gate;
      }
    },
    setVisible(v: boolean): void {
      for (const mesh of meshes) mesh.visible = v;
    },
    setChopGate(on: boolean): void {
      // 外部 A/B 专用：钉住 c1Gate 不让 FrameGovernor 的降档/回升改写。
      // 如果当前 highQuality 的隐含门值与 on 冲突，打 warn 方便定位。
      chopOverride = on;
      if (on !== highQuality) {
        console.warn(`[sea] setChopGate(${on}) conflicts with quality=${highQuality ? 'high' : 'low'} (implied c1Gate=${highQuality ? 1 : 0}); override wins`);
      }
      for (const bits of materialBits) bits.c1Gate.value = on ? 1 : 0;
    },
    clearChopGate(): void {
      // 解除 setChopGate 的覆盖：chopOverride 置 null，c1Gate 立即同步为
      // 当前画质档隐含值（不等到下一次 setQuality）。解除本身不打 warn。
      chopOverride = null;
      const gate = highQuality ? 1 : 0;
      for (const bits of materialBits) bits.c1Gate.value = gate;
    },
    setDebug(on: boolean): void {
      for (const bits of materialBits) bits.debugUniform.value = on ? 1 : 0;
    },
    setLook(look: SeaLook, diagnostic: SeaDiagnostic = 'none', refined = true): void {
      const settings = seaLookSettings(look, diagnostic, refined);
      for (const bits of materialBits) {
        for (const [key, value] of Object.entries(settings)) bits.lookU[key].value = value;
      }
    },
    setPuffReflectionSoft(on: boolean): void { objectReflection.setPuffSoftness(on); },
    setObjectReflection(on: boolean): void { objectReflection.setEnabled(on); },
    updateObjectReflection(scene: THREE.Scene, camera: THREE.PerspectiveCamera, time: number): void { if (meshes.some(mesh=>mesh.visible)) objectReflection.update(scene,camera,time); },
    get objectReflectionCaptures(): number { return objectReflection.captures; },
    get objectReflectionResolution(): number[] { return objectReflection.resolution; },
    setNightCloudReflection(on: boolean): void { cloudReflection.night.value = on ? 1 : 0; },
    setCloudReflection(on: boolean): void { cloudReflection.stage.value = on ? 1 : 0; },
    updateCloudReflection(scene: THREE.Scene, camera: THREE.Vector3, time: number): void {
      cloudReflection.update(scene, camera, time);
    },
    get reflectionCaptures(): number { return cloudReflection.captures; },
    dispose(): void {
      cloudReflection.dispose();
      objectReflection.dispose();
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
