import * as THREE from 'three';

import { SUN_POSITION } from './palettes';

/**
 * Sunset lighting rig. Backend-agnostic: three's WebGPURenderer supports
 * DirectionalLight/HemisphereLight, so this runs on both paths.
 */
export function initSunsetLights(scene: THREE.Scene): void {
  const sun = new THREE.DirectionalLight('#ffd9a0', 2.2);
  sun.position.set(SUN_POSITION[0], SUN_POSITION[1], SUN_POSITION[2]);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight('#8a6fd0', '#2a1a3a', 0.7));
}

/**
 * GLSL gradient dome — WebGL2 only.
 *
 * `ShaderMaterial` is not rendered by WebGPURenderer, so main.ts calls this for the
 * WebGL2 backend and `sky-webgpu.ts` (TSL dome + canvas gradient) for WebGPU. Both use
 * the same palette and sun direction, so the two paths look like the same sunset.
 */
export function initSunsetSky(scene: THREE.Scene): void {
  const geo = new THREE.SphereGeometry(800, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: new THREE.Color('#6b4fa1') },
      horizonColor: { value: new THREE.Color('#ff9a5a') },
      sunDir: { value: new THREE.Vector3(0.2, 0.12, -1).normalize() },
    },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: [
      'varying vec3 vDir; uniform vec3 topColor; uniform vec3 horizonColor; uniform vec3 sunDir;',
      'void main(){',
      ' float h = clamp(vDir.y, -0.2, 1.0);',
      ' vec3 col = mix(horizonColor, topColor, smoothstep(0.0, 0.6, h));',
      ' float s = max(dot(normalize(vDir), normalize(sunDir)), 0.0);',
      ' col += vec3(1.0, 0.75, 0.45) * pow(s, 220.0) * 2.2;',
      ' col += vec3(1.0, 0.55, 0.3) * pow(s, 8.0) * 0.35;',
      ' gl_FragColor = vec4(col, 1.0);',
      '}',
    ].join('\n'),
  });
  const dome = new THREE.Mesh(geo, mat);
  dome.name = 'sky_sunset_glsl';
  dome.frustumCulled = false;
  scene.add(dome);
  initSunsetLights(scene);
}
