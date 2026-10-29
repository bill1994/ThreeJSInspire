/**
 * src/plane.ts — the player aircraft.
 *
 * Orientation contract: the GLB (and the primitive placeholder) is authored Y-up with
 * the nose along +Z. The flight model's forward is -Z (it flies toward the sunset sun
 * at -Z, matching main.ts's camera), so the asset is dropped into an inner container
 * with `rotation.y = Math.PI`. The asset itself is never re-authored; only wrappers
 * move:
 *
 *   root   position + yaw (rotation.y)
 *   body   pitch (rotation.x)
 *   roll   bank  (rotation.z)
 *   model  constant PI yaw to convert nose +Z -> world -Z
 *
 * WebGPU-safe by construction: node materials only (the aircraft wears
 * MeshToonNodeMaterial via toon.ts), no ShaderMaterial and no onBeforeCompile
 * anywhere in this file.
 */
import * as THREE from 'three';
import { PLANE_PALETTE } from './palettes';
import { makeGradientMap, toonify, TOON_RAMP } from './toon';

const GLB_URL = '/assets/porco-fighter.glb';

/** Fallback colours, only applied when a livery material ships with an unset base colour. */
const LIVERY: Record<string, string> = {
  livery_white: PLANE_PALETTE.liveryWhite,
  livery_green: PLANE_PALETTE.liveryGreen,
  livery_red: PLANE_PALETTE.liveryRed,
  dark_trim: PLANE_PALETTE.darkTrim,
  glass_canopy: PLANE_PALETTE.glassCanopy,
  metal_prop: PLANE_PALETTE.metalProp,
};

export interface PlaneHandle {
  /** World container: set position/yaw on this. */
  group: THREE.Group;
  /** + = right wing down. */
  setBank(a: number): void;
  /** + = nose up. */
  setPitch(a: number): void;
  /** 0 = facing -Z (toward the sun). */
  setYaw(a: number): void;
  dispose(): void;
}

function isNearWhite(c: THREE.Color): boolean {
  return c.r > 0.95 && c.g > 0.95 && c.b > 0.95;
}

/** Tint by material name, but only when the author left the material uncoloured,
 *  then hand the whole tree the toon gradient map. */
function applyLivery(root: THREE.Object3D, ramp: THREE.DataTexture): void {
  root.traverse((obj: THREE.Object3D) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats: THREE.Material[] = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (!mat) continue;
      const key = mat.name.toLowerCase();
      const livery = LIVERY[key];
      const std = mat as THREE.MeshStandardMaterial;
      if (livery && std.color && isNearWhite(std.color)) {
        std.color = new THREE.Color(livery);
      }
      // Everything else about the material — including the author's doubleSided —
      // is left exactly as exported.
    }
  });
  toonify(THREE, root, ramp);
}

function buildPlaceholder(ramp: THREE.DataTexture): THREE.Group {
  const g = new THREE.Group();
  g.name = 'porco_placeholder';

  const white = new THREE.MeshStandardMaterial({ name: 'livery_white', color: '#efeadb', roughness: 0.58, metalness: 0 });
  const green = new THREE.MeshStandardMaterial({ name: 'livery_green', color: '#2f6b4e', roughness: 0.55, metalness: 0 });
  const red = new THREE.MeshStandardMaterial({ name: 'livery_red', color: '#b63629', roughness: 0.52, metalness: 0 });
  const dark = new THREE.MeshStandardMaterial({ name: 'dark_trim', color: '#3a3a3e', roughness: 0.6, metalness: 0.2 });
  const glass = new THREE.MeshStandardMaterial({
    name: 'glass_canopy',
    color: '#22242c',
    roughness: 0.18,
    metalness: 0.1,
    transparent: true,
    opacity: 0.85,
  });

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, name: string, x = 0, y = 0, z = 0): void => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.position.set(x, y, z);
    g.add(mesh);
  };

  // fuselage: capsule along +Z (nose at +Z, matching the GLB convention)
  const fus = new THREE.CapsuleGeometry(0.62, 3.6, 8, 16);
  fus.rotateX(Math.PI / 2);
  add(fus, white, 'fuselage_body', 0, 0, 0);

  // red nose cowl
  const cowl = new THREE.CylinderGeometry(0.58, 0.66, 0.7, 20);
  cowl.rotateX(Math.PI / 2);
  add(cowl, red, 'nose_cowl', 0, 0, 2.15);

  // green fuselage band
  const band = new THREE.CylinderGeometry(0.635, 0.635, 0.44, 20);
  band.rotateX(Math.PI / 2);
  add(band, green, 'band_green', 0, 0, 0.35);

  // low wing
  add(new THREE.BoxGeometry(9.6, 0.16, 1.9), white, 'wing_main', 0, -0.3, -0.15);
  add(new THREE.BoxGeometry(0.7, 0.18, 1.7), green, 'wing_tip_l', -4.6, -0.3, -0.15);
  add(new THREE.BoxGeometry(0.7, 0.18, 1.7), green, 'wing_tip_r', 4.6, -0.3, -0.15);

  // tail: fin + stabiliser
  add(new THREE.BoxGeometry(0.14, 1.15, 1.05), green, 'fin_main', 0, 0.62, -1.85);
  add(new THREE.BoxGeometry(0.16, 0.28, 0.98), red, 'fin_stripe', 0, 0.1, -1.85);
  add(new THREE.BoxGeometry(3.3, 0.14, 0.85), white, 'stab_main', 0, 0.05, -1.95);

  // two floats
  const floatGeo = new THREE.CapsuleGeometry(0.3, 2.3, 6, 12);
  floatGeo.rotateX(Math.PI / 2);
  add(floatGeo, white, 'float_l', -1.55, -1.45, 0.1);
  add(floatGeo, white, 'float_r', 1.55, -1.45, 0.1);

  // canopy
  const canopy = new THREE.SphereGeometry(0.52, 16, 12);
  canopy.scale(1, 0.85, 1.9);
  add(canopy, glass, 'canopy', 0, 0.5, 0.55);

  // propeller disc
  const prop = new THREE.CylinderGeometry(0.92, 0.92, 0.05, 20);
  prop.rotateX(Math.PI / 2);
  add(prop, dark, 'prop_blade_0', 0, 0, 2.55);

  toonify(THREE, g, ramp);

  return g;
}

/** Recursively free geometries, materials and textures under a subtree. */
function disposeTree(root: THREE.Object3D): void {
  root.traverse((obj: THREE.Object3D) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = (mesh as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!mat) return;
    const mats = Array.isArray(mat) ? mat : [mat];
    for (const m of mats) {
      if (!m) continue;
      for (const value of Object.values(m as unknown as Record<string, unknown>)) {
        if (value && (value as THREE.Texture).isTexture) (value as THREE.Texture).dispose();
      }
      m.dispose();
    }
  });
}

export async function initPlane(scene: THREE.Scene): Promise<PlaneHandle> {
  const ramp = makeGradientMap(THREE, TOON_RAMP);
  const root = new THREE.Group();
  root.name = 'porco_root';
  const body = new THREE.Group();
  body.name = 'porco_body';
  const roll = new THREE.Group();
  roll.name = 'porco_roll';
  const model = new THREE.Group(); // nose +Z -> world -Z
  model.name = 'porco_model';
  model.rotation.y = Math.PI;

  model.add(buildPlaceholder(ramp)); // visible immediately, replaced if the GLB lands
  roll.add(model);
  body.add(roll);
  root.add(body);
  scene.add(root);

  try {
    // three's FileLoader registers the URL in a module-level `loading` map *before* it builds
    // the Request. In a DOM-less host (node, unit tests) `new Request('/assets/...')` throws
    // synchronously, so that map entry is never cleaned up and every later load of the same
    // URL waits forever. Skip the attempt where a relative URL cannot resolve at all.
    if (typeof window === 'undefined' || typeof window.location === 'undefined') {
      throw new Error('no document: GLB cannot be fetched');
    }
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(GLB_URL);
    const asset = gltf.scene;
    let meshCount = 0;
    asset.traverse((o: THREE.Object3D) => {
      if ((o as THREE.Mesh).isMesh) meshCount += 1;
    });
    if (meshCount === 0) throw new Error('GLB contains no meshes');
    applyLivery(asset, ramp);
    for (const child of [...model.children]) {
      model.remove(child);
      disposeTree(child);
    }
    model.add(asset);
  } catch (err) {
    // Never block boot: keep the primitive placeholder and say so once.
    console.warn('[porco] GLB missing, placeholder plane');
    void err;
  }

  const apply = (axis: 'x' | 'z', a: number): void => {
    const v = Number.isFinite(a) ? a : 0;
    if (axis === 'x') body.rotation.x = v;
    else roll.rotation.z = -v; // +bank = right wing down
  };

  return {
    group: root,
    setBank(a: number): void {
      apply('z', a);
    },
    setPitch(a: number): void {
      apply('x', a);
    },
    setYaw(a: number): void {
      root.rotation.y = Number.isFinite(a) ? a : 0;
    },
    dispose(): void {
      scene.remove(root);
      disposeTree(root);
      root.clear();
    },
  };
}
