/**
 * src/toon.ts — 3-step gradient-map toon shading for the aircraft only.
 *
 * The sea and the clouds are deliberately left alone: the sea bands wave-height × ndl
 * with three hand-written smoothstep tiers and the clouds integrate a volume density —
 * neither is a lighting term, so another global quantisation pass would only draw
 * contour lines across them. `MeshToonNodeMaterial` also never reaches their unlit
 * `MeshBasicNodeMaterial`.
 *
 * `MeshToonNodeMaterial` ships only in the `three/webgpu` build, not the classic
 * `three` entry — so the toon class is imported directly, while the `THREE` parameter
 * stays `typeof import('three')` and provides the texture constants.
 */
import * as THREE from 'three';

import { PLANE_PALETTE } from './palettes';

export const TOON_BANDS = 3;

/** Shadow → midtone → light, verbatim from the livery the aircraft already wears.
 *  `ToonLightingModel` samples only `gradientMap.r`, so the stepped brightness comes
 *  from the red channel; the livery hue itself stays on each material's `color`. */
export const TOON_RAMP: readonly [string, string, string] = [
  PLANE_PALETTE.darkTrim,
  PLANE_PALETTE.liveryRed,
  PLANE_PALETTE.liveryWhite,
];

/** `clamp(floor(v * bands), 0, bands - 1)`; any non-finite input collapses to band 0. */
export function bandIndex(v: number, bands: number): number {
  if (!Number.isFinite(v)) return 0;
  const i = Math.floor(v * bands);
  if (!Number.isFinite(i)) return 0;
  return Math.min(Math.max(i, 0), Math.max(0, bands - 1));
}

function hexToRgba(hex: string): [number, number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return [255, 255, 255, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

/**
 * One texel per band, nearest-filtered, no mipmaps, `NoColorSpace` so the bytes are
 * sampled raw — the exact shape three's toon lighting requires from a `gradientMap`.
 */
export function makeGradientMap(
  THREE: typeof import('three'),
  colors: readonly string[],
): THREE.DataTexture {
  const data = new Uint8Array(colors.length * 4);
  for (let i = 0; i < colors.length; i += 1) {
    const [r, g, b, a] = hexToRgba(colors[i]);
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  }
  const tex = new THREE.DataTexture(data, colors.length, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Swap every `MeshStandardMaterial` under `root` for a `MeshToonNodeMaterial` carrying
 * `ramp`, copying the settings a livery mesh actually uses. Shared source materials are
 * swapped once and reused, so the aircraft keeps sharing one white across fuselage,
 * wings and floats. Returns the number of material slots replaced; a second pass over
 * the same tree swaps nothing.
 */
export async function toonify(
  THREE: typeof import('three'),
  root: THREE.Object3D,
  ramp: THREE.DataTexture,
): Promise<number> {
  // Loaded at call time, never at module load: a static `three/webgpu` import here would fail
  // module linking (main → game → plane → toon) before `createRenderer` can fall back to the
  // classic WebGLRenderer, turning the "never a black page" net into exactly that.
  const { MeshToonNodeMaterial } = await import('three/webgpu');
  let swapped = 0;
  const cache = new Map<THREE.Material, THREE.Material>();
  root.traverse((obj: THREE.Object3D) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const next = mats.map((mat) => {
      if (!mat) return mat;
      const cached = cache.get(mat);
      if (cached) return cached;
      const std = mat as THREE.MeshStandardMaterial;
      if (!(std as { isMeshStandardMaterial?: boolean }).isMeshStandardMaterial) return mat;
      const toon = new MeshToonNodeMaterial({
        color: std.color.clone(),
        map: std.map ?? null,
        transparent: std.transparent,
        opacity: std.opacity,
        side: std.side,
        name: std.name,
      });
      toon.gradientMap = ramp;
      cache.set(mat, toon);
      swapped += 1;
      return toon;
    });
    mesh.material = Array.isArray(mesh.material) ? next : next[0];
  });
  return swapped;
}
