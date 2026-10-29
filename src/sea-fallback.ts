/**
 * WebGL2 sea — 4-wave Gerstner displacement in a plain GLSL ShaderMaterial.
 *
 * This is the primary path for devices without WebGPU (most mobile Chrome), so
 * it is a finished look, not a placeholder: directional swell + choppy crests,
 * toon bands, crest foam, sun glitter path and a horizon haze that matches the
 * TSL path colour for colour.
 */
import * as THREE from 'three';
import type { SeaHandle } from './sea-fft';
import { SEA_PALETTE } from './palettes';

export type Backend = 'webgpu' | 'webgl2';

const SEA_PATCH_SIZE = 1200;
const SEA_SEGMENTS = 150;

interface Wave {
  dir: [number, number];
  wavelength: number;
  amplitude: number;
  steepness: number;
}

const WAVES: Wave[] = [
  { dir: [0.82, -0.57], wavelength: 51, amplitude: 0.42, steepness: 0.72 },
  { dir: [0.45, 0.89], wavelength: 27, amplitude: 0.2, steepness: 0.6 },
  { dir: [-0.62, 0.78], wavelength: 14, amplitude: 0.09, steepness: 0.5 },
  { dir: [0.95, 0.31], wavelength: 8.5, amplitude: 0.042, steepness: 0.4 },
];

function hexCss(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

function waveGlsl(waves: Wave[]): string {
  return waves
    .map((w, i) => {
      const k = (Math.PI * 2) / w.wavelength;
      const omega = Math.sqrt(9.81 * k);
      return `
  {
    vec2 d${i} = normalize(vec2(${w.dir[0].toFixed(4)}, ${w.dir[1].toFixed(4)}));
    float k${i} = ${k.toFixed(8)};
    float w${i} = ${omega.toFixed(8)};
    float a${i} = ${w.amplitude.toFixed(5)};
    float q${i} = ${w.steepness.toFixed(5)};
    float wa${i} = k${i} * a${i};
    float ph${i} = k${i} * dot(d${i}, p.xz) - w${i} * uTime;
    float s${i} = sin(ph${i});
    float c${i} = cos(ph${i});
    p += vec3(q${i} * a${i} * d${i}.x * c${i}, a${i} * s${i}, q${i} * a${i} * d${i}.y * c${i});
    tangent += vec3(-q${i} * wa${i} * d${i}.x * d${i}.x * s${i}, d${i}.x * wa${i} * c${i}, -q${i} * wa${i} * d${i}.x * d${i}.y * s${i});
    binormal += vec3(-q${i} * wa${i} * d${i}.x * d${i}.y * s${i}, d${i}.y * wa${i} * c${i}, -q${i} * wa${i} * d${i}.y * d${i}.y * s${i});
  }`;
    })
    .join('\n');
}

function buildVertexShader(waves: Wave[]): string {
  return `
uniform float uTime;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;

void main() {
  // Waves are evaluated in WORLD space so the mesh can be re-centred under the aircraft
  // every frame without the swell sliding along with it. The patch only ever translates
  // (no rotation/scale), so the modelMatrix inverse is not needed and normals stay valid.
  vec3 p = (modelMatrix * vec4(position, 1.0)).xyz;
  vec3 tangent = vec3(1.0, 0.0, 0.0);
  vec3 binormal = vec3(0.0, 0.0, 1.0);
${waveGlsl(waves)}
  vec3 n = normalize(cross(binormal, tangent));
  vWorldPos = p;
  vWorldNormal = normalize(mat3(modelMatrix) * n);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;
}

function buildFragmentShader(): string {
  return `
uniform float uTime;
uniform vec3 uSunDir;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;

// Cheap stable hash used for the glitter sparkle field.
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

void main() {
  vec3 N = normalize(vWorldNormal);
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 L = normalize(uSunDir);

  float ndl = clamp(dot(N, L), 0.0, 1.0);

  // Toon bands. Wide thresholds: narrow ones turn every swell into a flat plateau of a
  // single colour. Kept numerically identical to the TSL path in sea-fft.ts.
  float band = clamp(ndl * 1.18, 0.0, 1.0);
  vec3 color = mix(vec3(${glslColor(SEA_PALETTE.deep)}), vec3(${glslColor(SEA_PALETTE.mid)}), smoothstep(0.06, 0.34, band));
  color = mix(color, vec3(${glslColor(SEA_PALETTE.lit)}), smoothstep(0.42, 0.74, band));
  color = mix(color, vec3(${glslColor(SEA_PALETTE.crest)}), smoothstep(0.88, 1.0, band) * 0.45);

  // Sun glitter: a narrow specular path toward the sun, broken up by noise so it reads as
  // scattered sparkle along that path instead of a white sheet over the whole patch.
  vec3 R = reflect(-L, N);
  float spec = pow(max(dot(R, V), 0.0), 170.0);
  float sparkle = valueNoise(vWorldPos.xz * 1.7 + vec2(uTime * 0.25, uTime * -0.15));
  float glint = smoothstep(0.42, 0.78, sparkle) * spec * 1.5;
  color += vec3(${glslColor(SEA_PALETTE.glitter)}) * glint;

  // Crest foam: tips only, broken up so it cannot spread into a white sheet.
  float crest = smoothstep(0.66, 1.0, vWorldPos.y) * smoothstep(0.12, 0.5, ndl);
  float foamBreak = smoothstep(0.3, 0.72, valueNoise(vWorldPos.xz * 0.33 + vec2(uTime * 0.05, 0.0)));
  color += vec3(${glslColor(SEA_PALETTE.foam)}) * crest * foamBreak * 0.3;

  // Horizon haze. Full strength only near the patch edge: a short ramp turns the last few
  // hundred metres of water into a flat slab with a straight top edge. The added glow is the
  // GLSL sky dome's broadband horizon term (sky-sunset.ts, pow(s,8) * 0.35) on the horizontal
  // direction, so the water's far field matches the sky it dissolves into.
  float dist = length(vWorldPos - cameraPosition);
  vec2 flatView = normalize(vec2(V.x, V.z));
  vec2 flatSun = normalize(vec2(L.x, L.z));
  float horizonGlow = pow(max(dot(flatView, flatSun), 0.0), 8.0) * 0.35;
  vec3 hazeColor = vec3(${glslColor(SEA_PALETTE.haze)}) + vec3(1.0, 0.55, 0.3) * horizonGlow;
  color = mix(color, hazeColor, smoothstep(110.0, 520.0, dist));

  gl_FragColor = vec4(color, 1.0);
}
`;
}

function glslColor(hex: number): string {
  const c = new THREE.Color(hex);
  return `${c.r.toFixed(5)}, ${c.g.toFixed(5)}, ${c.b.toFixed(5)}`;
}

interface FallbackUniforms {
  uTime: { value: number };
  uSunDir: { value: THREE.Vector3 };
}

function buildMaterial(waves: Wave[], uniforms: FallbackUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexShader: buildVertexShader(waves),
    fragmentShader: buildFragmentShader(),
    side: THREE.DoubleSide,
    fog: false,
  });
}

export function initSea(scene: THREE.Scene, _backend: Backend): SeaHandle {
  const uniforms: FallbackUniforms = {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0.28, 0.14, -1).normalize() },
  };

  const geometry = new THREE.PlaneGeometry(SEA_PATCH_SIZE, SEA_PATCH_SIZE, SEA_SEGMENTS, SEA_SEGMENTS);
  geometry.rotateX(-Math.PI / 2);

  let waves = WAVES;
  let material = buildMaterial(waves, uniforms);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'sea-gerstner';
  mesh.position.y = 0;
  mesh.frustumCulled = false;
  scene.add(mesh);

  let disposed = false;
  let high = true;

  return {
    kind: 'gerstner',
    update(t: number): void {
      if (disposed) return;
      uniforms.uTime.value = Number.isFinite(t) ? t : 0;
    },
    setQuality(next: boolean): void {
      if (disposed || next === high) return;
      high = next;
      // Degrade to the two longest swell waves (cheapest possible vertex work).
      waves = next ? WAVES : WAVES.slice(0, 2);
      const rebuilt = buildMaterial(waves, uniforms);
      mesh.material = rebuilt;
      material.dispose();
      material = rebuilt;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      scene.remove(mesh);
      geometry.dispose();
      material.dispose();
    },
  };
}

export const SEA_FALLBACK_INFO = {
  patchSize: SEA_PATCH_SIZE,
  segments: SEA_SEGMENTS,
  waves: WAVES.length,
  palette: SEA_PALETTE,
  hex: hexCss,
};
