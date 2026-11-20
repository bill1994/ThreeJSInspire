import * as THREE from 'three';

/** Stagger visibility, not world positions. Existing visible clouds never move
 * or disappear to make room for a newcomer. Clock is simulation time. */
export class CloudArrivalGate {
  private states = new Map<object, { active: boolean; opacity: number }>();
  private next = -Infinity;
  private time = 0;
  begin(dt: number) { this.time += Math.max(0, Math.min(0.1, dt)); }
  active(key: object) { return this.states.get(key)?.active ?? false; }
  reset(key: object) { this.states.delete(key); }
  update(key: object, target: number, dt: number, clear: boolean): number {
    let state = this.states.get(key);
    if (!state) { state = { active: false, opacity: 0 }; this.states.set(key, state); }
    if (target < 0.001) { state.active = false; state.opacity = 0; return 0; }
    if (!state.active) {
      if (!clear || this.time < this.next) return 0;
      state.active = true; this.next = this.time + 0.9;
    }
    state.opacity = Math.min(target, state.opacity + Math.max(0, Math.min(0.1, dt)) / 4);
    return state.opacity;
  }
}

export interface CloudFootprint { x: number; z: number; radius: number }
/** Conservative horizontal angular clearance for newly visible silhouettes.
 * Depth ordering is allowed to change naturally during subsequent flight. */
export function cloudArrivalClear(a: CloudFootprint, others: readonly CloudFootprint[], eyeX: number, eyeZ: number): boolean {
  const ax = a.x - eyeX, az = a.z - eyeZ, ad = Math.max(1, Math.hypot(ax, az));
  const angle = Math.atan2(ax, az), half = Math.atan2(a.radius, ad);
  return others.every(b => {
    if (Math.hypot(a.x-b.x, a.z-b.z) < a.radius+b.radius+20) return false;
    const bx = b.x-eyeX, bz = b.z-eyeZ;
    const diff = Math.abs(Math.atan2(Math.sin(angle-Math.atan2(bx,bz)), Math.cos(angle-Math.atan2(bx,bz))));
    // Allow a small amount of natural depth overlap now that cloud cores
    // occlude correctly. Reject coincident silhouettes and physical collisions.
    return diff > (half + Math.atan2(b.radius, Math.max(1, Math.hypot(bx,bz)))) * 0.85 + 0.01;
  });
}

/** Readiness is established off screen, not by overlapping timed fades.
 * A prepared cloud remains anchored and may later enter the view naturally. */
export class OffscreenCloudGate {
  private prepared = new Set<object>();
  active(key: object) { return this.prepared.has(key); }
  reset(key: object) { this.prepared.delete(key); }
  update(key: object, target: number, clear: boolean, outside: boolean, initial = false) {
    if (!this.active(key) && clear && (outside || initial)) this.prepared.add(key);
    return this.active(key) ? target : 0;
  }
}

/** Ignore the far clipping plane: bg world positions are projected onto a shell.
 * Include a generous silhouette margin so partly visible clouds never count as outside. */
export function cloudViewTest(camera: THREE.PerspectiveCamera, includeWaterReflection = false) {
  camera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse), camera.coordinateSystem);
  const sphere = new THREE.Sphere();
  const mirrored = new THREE.Vector3();
  const outside = (center: THREE.Vector3) => [0,1,2,3,5].some(i => frustum.planes[i].distanceToPoint(center) < -sphere.radius);
  return (center: THREE.Vector3, radius: number) => {
    sphere.set(center, radius * 1.15 + 20);
    // Reflecting the bound across y=0 tests its water image in the real view.
    // This also works when the camera banks or pitches: no horizontal-only cone.
    mirrored.set(center.x,-center.y,center.z);
    return outside(center) && (!includeWaterReflection || outside(mirrored));
  };
}
