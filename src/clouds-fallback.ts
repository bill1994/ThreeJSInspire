/**
 * WebGL2 clouds — 12 camera-facing sprite puffs, no raymarch.
 *
 * Mobile WebGL2 is the primary target here, so this path is fully art-directed:
 * purple base, pink sun-side tops, gold fresnel rim, soft noise-broken edges.
 * Billboarding happens in the vertex shader off `viewMatrix`, so no per-frame
 * CPU work and no per-frame allocation.
 */
import * as THREE from 'three';

import { CLOUD_PALETTE } from './palettes';
import type { CloudHandle } from './clouds-compute';

export type Backend = 'webgpu' | 'webgl2';

interface PuffDef {
  x: number;
  y: number;
  z: number;
  size: number;
  opacity: number;
}

/** Hand-placed so the sky reads as a deliberate Ghibli backdrop, not a scatter. */
const PUFFS: PuffDef[] = [
  { x: -430, y: 150, z: -560, size: 250, opacity: 0.92 },
  { x: -250, y: 205, z: -610, size: 205, opacity: 0.86 },
  { x: -95, y: 128, z: -520, size: 175, opacity: 0.8 },
  { x: 90, y: 190, z: -640, size: 235, opacity: 0.9 },
  { x: 285, y: 145, z: -575, size: 195, opacity: 0.84 },
  { x: 455, y: 212, z: -660, size: 225, opacity: 0.88 },
  { x: -520, y: 240, z: -700, size: 270, opacity: 0.78 },
  { x: 200, y: 262, z: -720, size: 285, opacity: 0.8 },
  { x: -330, y: 275, z: -740, size: 300, opacity: 0.74 },
  { x: 20, y: 300, z: -760, size: 320, opacity: 0.7 },
  { x: 560, y: 168, z: -600, size: 180, opacity: 0.82 },
  { x: -640, y: 175, z: -590, size: 190, opacity: 0.8 },
];

/** Low tier hides this many of the smallest puffs (12 -> 8 draws). */
const LOW_RANK_DROP = 4;

const VERTEX = `
uniform float uSize;
varying vec2 vUv;
varying vec3 vWorldCenter;

void main() {
  vUv = uv;
  vec4 center = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vWorldCenter = center.xyz;

  // Camera right/up straight out of the view matrix: billboard without CPU work.
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 p = center.xyz + camRight * (position.x * uSize) + camUp * (position.y * uSize * 0.62);

  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const FRAGMENT = `
uniform float uTime;
uniform float uSeed;
uniform float uOpacity;
uniform vec3 uSunDir;
varying vec2 vUv;
varying vec3 vWorldCenter;

const vec3 C_SHADOW = vec3(SHADOW_COLOR);
const vec3 C_BASE = vec3(BASE_COLOR);
const vec3 C_PINK = vec3(PINK_COLOR);
const vec3 C_GOLD = vec3(GOLD_COLOR);

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
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
  vec2 c = vUv - 0.5;
  c.x *= 1.18;
  float r = length(c) * 2.0;

  vec2 seed = vec2(uSeed * 13.7, uSeed * 7.3);
  float n = vnoise(vUv * 3.4 + seed + vec2(uTime * 0.03, -uTime * 0.02));
  float n2 = vnoise(vUv * 9.0 + seed * 1.9 + vec2(uTime * 0.05, 0.0));

  float shape = 1.0 - smoothstep(0.22, 1.0, r + (n - 0.5) * 0.44 + (n2 - 0.5) * 0.16);
  if (shape <= 0.004) discard;

  vec3 toCam = normalize(cameraPosition - vWorldCenter);
  float sunAlign = pow(max(dot(-toCam, uSunDir), 0.0), 2.0);
  float topLit = smoothstep(0.15, 0.95, vUv.y);

  vec3 col = mix(C_SHADOW, C_BASE, smoothstep(0.05, 0.9, vUv.y * 0.65 + shape * 0.35));
  col = mix(col, C_PINK, clamp(sunAlign * 0.65 + topLit * 0.5, 0.0, 1.0));

  float rim = smoothstep(0.52, 1.0, r) * shape;
  col += C_GOLD * rim * (0.30 + sunAlign * 0.55);

  gl_FragColor = vec4(col, clamp(shape * uOpacity, 0.0, 1.0));
}
`;

function glslColor(hex: number): string {
  const c = new THREE.Color(hex);
  return `${c.r.toFixed(5)}, ${c.g.toFixed(5)}, ${c.b.toFixed(5)}`;
}

function buildFragment(): string {
  return FRAGMENT.replace('SHADOW_COLOR', glslColor(CLOUD_PALETTE.shadow))
    .replace('BASE_COLOR', glslColor(CLOUD_PALETTE.base))
    .replace('PINK_COLOR', glslColor(CLOUD_PALETTE.pink))
    .replace('GOLD_COLOR', glslColor(CLOUD_PALETTE.gold));
}

export function initClouds(scene: THREE.Scene, _backend: Backend): CloudHandle {
  const shared = {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0.28, 0.14, -1).normalize() },
  };

  const geometry = new THREE.PlaneGeometry(1, 1);
  const group = new THREE.Group();
  group.name = 'clouds-sprites';

  interface Puff {
    mesh: THREE.Mesh;
    material: THREE.ShaderMaterial;
    base: THREE.Vector3;
    size: number;
    drift: number;
    phase: number;
    /** 0 = largest puff; low tier hides the highest ranks. */
    rank: number;
  }

  const fragment = buildFragment();
  const order = PUFFS.map((d, i) => ({ i, size: d.size })).sort((a, b) => b.size - a.size);
  const rankOf = (index: number): number => order.findIndex((o) => o.i === index);
  const puffs: Puff[] = PUFFS.map((def, i) => {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        ...shared,
        uSize: { value: def.size },
        uSeed: { value: (i + 1) * 0.137 },
        uOpacity: { value: def.opacity },
      },
      vertexShader: VERTEX,
      fragmentShader: fragment,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      fog: false,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `cloud-puff-${i}`;
    mesh.position.set(def.x, def.y, def.z);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    group.add(mesh);

    return {
      mesh,
      material,
      base: new THREE.Vector3(def.x, def.y, def.z),
      size: def.size,
      drift: 1.1 + (i % 5) * 0.35,
      phase: i * 1.7,
      rank: rankOf(i),
    };
  });

  scene.add(group);

  let disposed = false;
  let high = true;

  return {
    kind: 'sprite',
    update(t: number, sunDir: THREE.Vector3): void {
      if (disposed) return;
      const time = Number.isFinite(t) ? t : 0;
      shared.uTime.value = time;

      if (
        sunDir &&
        Number.isFinite(sunDir.x) &&
        Number.isFinite(sunDir.y) &&
        Number.isFinite(sunDir.z) &&
        sunDir.lengthSq() > 1e-6
      ) {
        shared.uSunDir.value.copy(sunDir).normalize();
      }

      // Slow parallax drift; writes into existing objects (no allocation).
      for (let i = 0; i < puffs.length; i++) {
        const p = puffs[i];
        const s = Math.sin(time * 0.05 * p.drift + p.phase);
        p.mesh.position.set(p.base.x + s * 26, p.base.y + Math.cos(time * 0.037 + p.phase) * 9, p.base.z);
      }
    },
    setQuality(next: boolean): void {
      if (disposed || next === high) return;
      high = next;
      // Cheap tier drops the LOW_RANK_COUNT smallest puffs (least area each) and
      // leaves the volume of the backdrop intact.
      for (const p of puffs) {
        p.mesh.visible = next || p.rank < PUFFS.length - LOW_RANK_DROP;
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      scene.remove(group);
      for (const p of puffs) p.material.dispose();
      geometry.dispose();
    },
  };
}

export const CLOUD_SPRITE_COUNT = PUFFS.length;
