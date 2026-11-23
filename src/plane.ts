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

// v002 is the S.21-influenced airframe (Batch E). v001's GLB stays in assets/ as the
// archived predecessor; only the current build is served from public/.
const GLB_URL = '/assets/porco-fighter-v002.glb';

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
  setCloudLight?(gain:number):void;
  /** World container: set position/yaw on this. */
  group: THREE.Group;
  /** + = right wing down. */
  setBank(a: number): void;
  /** + = nose up. */
  setPitch(a: number): void;
  /** 0 = facing -Z (toward the sun). */
  setYaw(a: number): void;
  /**
   * P1-2: throttle-driven prop presence — the blur disc breathes with the
   * throttle and the blades spin faster. A GLB swap without a `prop_spin`
   * node gets a pivot synthesized from the asset's own prop nodes (FLT-01);
   * an asset with no prop nodes at all degrades to a warn-once no-op, never
   * a throw.
   */
  setProp(throttle01: number, dt: number): void;
  dispose(): void;
}

/** P1-2 prop anchors: idle ghost disc -> full-throttle smear. */
export const PROP_OPACITY_MIN = 0.1;
export const PROP_OPACITY_MAX = 0.35;
/** Blade spin rate in rad/s: idle crawl -> full-throttle strobe. */
export const PROP_SPIN_IDLE = 6;
export const PROP_SPIN_FULL = 46;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(Math.max(v, 0), 1);
}

/** Blur-disc opacity follows the throttle: a ghost at idle, a smear at full. */
export function propOpacity01(throttle01: number): number {
  return PROP_OPACITY_MIN + (PROP_OPACITY_MAX - PROP_OPACITY_MIN) * clamp01(throttle01);
}

/** Blade spin rate follows the throttle: idle crawl rising to a strobe. */
export function propSpinRate(throttle01: number): number {
  return PROP_SPIN_IDLE + (PROP_SPIN_FULL - PROP_SPIN_IDLE) * clamp01(throttle01);
}

function isNearWhite(c: THREE.Color): boolean {
  return c.r > 0.95 && c.g > 0.95 && c.b > 0.95;
}

/** Tint by material name, but only when the author left the material uncoloured,
 *  then hand the whole tree the toon gradient map. */
async function applyLivery(root: THREE.Object3D, ramp: THREE.DataTexture): Promise<void> {
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

async function buildPlaceholder(ramp: THREE.DataTexture): Promise<THREE.Group> {
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

  // Propeller: a thin translucent blur disc plus two faint blades, not a solid cylinder.
  //
  // A solid disc reads as a plate stuck on the nose, and it also swallows the sun behind it
  // (the reference short always has the prop blowing out into a soft warm smear). The disc
  // is deliberately additive-ish: low opacity, no depth write, and it keeps `dark_trim` off
  // the bloom threshold so only the rim catches the sunset.
  const propDisc = new THREE.MeshStandardMaterial({
    name: 'metal_prop',
    color: PLANE_PALETTE.metalProp,
    roughness: 0.42,
    metalness: 0.6,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
  });
  // P1-2: the disc + blades live under a `prop_spin` pivot so the frame can
  // spin them around the nose axis with the throttle. The production GLB has
  // no such node — setProp synthesizes one from the asset's prop nodes (FLT-01).
  const propGeo = new THREE.CylinderGeometry(0.92, 0.92, 0.02, 24);
  propGeo.rotateX(Math.PI / 2);
  // Two blades at 90 deg so the disc still has a readable plane when the camera is behind it.
  const bladeGeo = new THREE.BoxGeometry(0.1, 1.78, 0.04);
  const propSpin = new THREE.Group();
  propSpin.name = 'prop_spin';
  propSpin.position.set(0, 0, 2.55);
  const propDiscMesh = new THREE.Mesh(propGeo, propDisc);
  propDiscMesh.name = 'prop_blade_0';
  propSpin.add(propDiscMesh);
  const bladeMesh1 = new THREE.Mesh(bladeGeo, propDisc);
  bladeMesh1.name = 'prop_blade_1';
  bladeMesh1.position.z = 0.01;
  propSpin.add(bladeMesh1);
  const bladeGeo2 = bladeGeo.clone();
  bladeGeo2.rotateZ(Math.PI / 2);
  const bladeMesh2 = new THREE.Mesh(bladeGeo2, propDisc);
  bladeMesh2.name = 'prop_blade_2';
  bladeMesh2.position.z = 0.01;
  propSpin.add(bladeMesh2);
  g.add(propSpin);

  await toonify(THREE, g, ramp);

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

/** FLT-01 anchor names, in fallback priority order — module-level so the frame-loop
 * path (an asset with no prop nodes at all re-enters every frame) allocates nothing. */
const PROP_PIVOT_ANCHORS = ['prop_spinner', 'prop_blade_0', 'prop_blade_1'];
const PROP_BLADE_NAMES = ['prop_blade_0', 'prop_blade_1'] as const;

/**
 * FLT-01 fallback: the production GLB (porco-fighter-v002.glb, 33 nodes, 0 animations)
 * ships no `prop_spin` pivot — the placeholder's whole prop group is swallowed by the
 * GLB swap, which made setProp a silent no-op. Measured nodes (binary JSON chunk
 * parse, 2026-11-11), all parentless (asset scene root), no rotation/scale of their own:
 *
 *   prop_blade_0   mesh14  t=[0, 0.25, 4.34]
 *   prop_blade_1   mesh15  t=[0, 0.25, 4.34]
 *   prop_spinner   mesh16  t=[0, 0.25, 4.62]
 *
 * The spin axis is therefore the GLB world Z through the (0, 0.25) line. The pivot
 * anchors on the first of prop_spinner / prop_blade_0 / prop_blade_1 found, is added
 * as a sibling at the anchor's position, and adopts whichever of the three exist via
 * attach() (world transforms preserved). Returns null only when the asset has no prop
 * nodes at all — setProp then warns once and stays a true no-op.
 */
function ensurePropPivot(root: THREE.Object3D): THREE.Group | null {
  let anchor: THREE.Object3D | undefined;
  for (const name of PROP_PIVOT_ANCHORS) {
    anchor = root.getObjectByName(name);
    if (anchor) break;
  }
  if (!anchor || !anchor.parent) return null;
  const pivot = new THREE.Group();
  pivot.name = 'prop_spin';
  pivot.position.copy(anchor.position);
  anchor.parent.add(pivot);
  for (const name of PROP_PIVOT_ANCHORS) {
    const node = root.getObjectByName(name);
    if (node) pivot.attach(node);
  }
  return pivot;
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

  model.add(await buildPlaceholder(ramp)); // visible immediately, replaced if the GLB lands
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
    await applyLivery(asset, ramp);
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

  // FLT-01: an asset with no prop nodes at all says so exactly once, then the
  // frame loop keeps calling setProp into a silent no-op.
  let propWarned = false;
  const paints=new Map<THREE.MeshStandardMaterial,THREE.Color>();
  model.traverse(obj=>{
    const materials=(obj as THREE.Mesh<THREE.BufferGeometry,THREE.MeshStandardMaterial|THREE.MeshStandardMaterial[]>).material;
    for(const mat of Array.isArray(materials)?materials:[materials]){
      if(mat?.color && !paints.has(mat))paints.set(mat,mat.color.clone());
    }
  });

  return {
    group: root,
    setCloudLight(gain) { for(const [mat,base] of paints) mat.color.copy(base).multiplyScalar(gain); },
    setBank(a: number): void {
      apply('z', a);
    },
    setPitch(a: number): void {
      apply('x', a);
    },
    setYaw(a: number): void {
      root.rotation.y = Number.isFinite(a) ? a : 0;
    },
    setProp(throttle01: number, dt: number): void {
      const pivot = root.getObjectByName('prop_spin') ?? ensurePropPivot(root);
      if (!pivot) {
        if (!propWarned) {
          propWarned = true;
          console.warn('[porco] asset has no prop nodes, prop feedback disabled');
        }
        return;
      }
      const t = clamp01(Number.isFinite(throttle01) ? throttle01 : 0);
      if (Number.isFinite(dt) && dt > 0) {
        pivot.rotation.z += propSpinRate(t) * Math.min(dt, 0.1);
      }
      // FLT-01: the two blades may carry independent materials on a real GLB —
      // write both (deduped by reference, i.e. the Set semantics; the placeholder
      // blades share the one metal_prop material, so this is still a single write
      // there) or the rotor reads asymmetric while it breathes. Guard the shape —
      // a livery pass could swap it. Flat locals, no Set: setProp runs every frame.
      let mat0: THREE.MeshStandardMaterial | undefined;
      let mat1: THREE.MeshStandardMaterial | undefined;
      for (const name of PROP_BLADE_NAMES) {
        const blade = pivot.getObjectByName(name) as THREE.Mesh | undefined;
        const mat = blade?.material as THREE.MeshStandardMaterial | undefined;
        if (mat && Number.isFinite(mat.opacity)) {
          if (!mat0) mat0 = mat;
          else if (mat !== mat0) mat1 = mat;
        }
      }
      if (mat0) mat0.opacity = propOpacity01(t);
      if (mat1) mat1.opacity = propOpacity01(t);
    },
    dispose(): void {
      scene.remove(root);
      disposeTree(root);
      root.clear();
    },
  };
}
