/**
 * src/feel.ts — game feel: trauma-driven camera shake and pooled contrail ribbons.
 *
 * Shake rides an *additive offset* that the camera rig adds on top of its smoothed
 * follow, so follow and shake never fight. Shake is sampled from smooth sines (never
 * per-frame Math.random, which buzzes like static) and decays back to rest.
 *
 * Contrails are two fixed-size ribbon pools — buffers allocated once, zero growth,
 * zero per-frame allocation. WebGPU-safe: MeshBasicMaterial + vertex colors only.
 */
import * as THREE from 'three';
import type { Vec3 } from './camera-rig';
import { STALL } from './stall';
import { SEA_PALETTE } from './palettes';

/** Trauma lost per second (a full-strength hit is gone in under a second). */
export const TRAUMA_DECAY = 1.15;

/** Peak camera offset in world units at trauma = 1. */
export const SHAKE_MAX = 0.85;

/** Idle airframe rumble at full speed, added to trauma before sampling. */
export const SPEED_RUMBLE = 0.07;

/** Bank (rad) past which contrails pour off the wingtips. */
export const CONTRAIL_BANK = 0.42;

/** Normalised speed past which contrails pour off the wingtips. */
export const CONTRAIL_SPEED = 0.72;

/** Samples held per wingtip ribbon (fixed pool — never grows). */
export const TRAIL_SAMPLES = 48;

/** Seconds between contrail samples. */
export const TRAIL_SPAWN_DT = 0.035;

/** Deck-skim amount past which the aircraft throws a foam wake. */
export const SKIM_WAKE = 0.25;

/**
 * Altitude the foam wake is laid at. The sea surface is y = 0, and the skim itself
 * rides at FLIGHT.ALT_MIN + 1 (7 m), so the wake belongs on the water under the
 * aircraft — not at the aircraft's own altitude, which floated a slab in mid-air.
 */
export const SEA_WAKE_Y = 0.6;

/** Contrail tint, and the foam tint the skim wake uses (both from the palette). */
const CONTRAIL_TINT = [0.97, 0.94, 0.9] as const;
const FOAM_TINT = [
  ((SEA_PALETTE.foam >> 16) & 255) / 255,
  ((SEA_PALETTE.foam >> 8) & 255) / 255,
  (SEA_PALETTE.foam & 255) / 255,
] as const;

/**
 * Decay trauma toward rest. Clamped to 0..1 on the way in so stacked hits cannot
 * exceed full shake. NaN trauma reads as rest; a NaN dt simply skips the decay.
 */
export function updateTrauma(trauma: number, dt: number, decay: number = TRAUMA_DECAY): number {
  const t = Number.isFinite(trauma) ? Math.min(Math.max(trauma, 0), 1) : 0;
  if (!Number.isFinite(dt) || dt <= 0) return t;
  const step = Number.isFinite(decay) && decay > 0 ? decay : TRAUMA_DECAY;
  // Linear decay is unconditionally stable, so a huge dt just fully releases the shake.
  const next = t - step * dt;
  return next < 0 ? 0 : next;
}

/**
 * Sample the shake offset for a trauma value. Amplitude is quadratic (trauma^2) so a
 * small scrape barely moves the camera while a big hit punches. The components are
 * normalised so the *magnitude* never exceeds trauma^2 * SHAKE_MAX.
 */
export function shakeSample(trauma: number, t: number, out: Vec3): Vec3 {
  const amp = Number.isFinite(trauma) ? Math.min(Math.max(trauma, 0), 1) : 0;
  const time = Number.isFinite(t) ? t : 0;
  if (amp <= 0) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    return out;
  }
  const k = amp * amp * SHAKE_MAX;
  // 0.7^2 + 0.7^2 + 0.1^2 = 0.99, so the vector magnitude stays inside SHAKE_MAX.
  out.x = k * 0.7 * Math.sin(time * 17.3);
  out.y = k * 0.7 * Math.sin(time * 23.1 + 1.13);
  out.z = k * 0.1 * Math.sin(time * 11.7 + 2.37);
  return out;
}

export interface FeelContext {
  /** 0..1 speed normalisation. */
  speed01: number;
  /** Signed bank in radians. */
  bank: number;
  /** 0..1 stylised stall intensity; absent or NaN reads as no buffet. */
  stall01?: number;
  /** 0..1 deck skim (see skim.ts); past SKIM_WAKE the plane throws a foam wake. */
  skim01?: number;
  /** World-space wingtip positions for the two contrail emitters. */
  leftTip: Vec3;
  rightTip: Vec3;
}

export interface FeelHandle {
  /** Live shake offset (world units); read after `update()`. */
  readonly shake: Vec3;
  addTrauma(amount: number): void;
  /** Current trauma 0..1. */
  trauma01(): number;
  update(dt: number, ctx: FeelContext): void;
  dispose(): void;
}

interface Ribbon {
  mesh: THREE.Mesh;
  positions: Float32Array;
  colors: Float32Array;
  /** xyz per sample, newest first. */
  samples: Float32Array;
  widths: Float32Array;
  count: number;
  sinceSpawn: number;
  /** Linear rgb written into the vertex colours. */
  tint: readonly [number, number, number];
}

function makeRibbon(
  scene: THREE.Scene,
  name: string,
  side: THREE.Vector3,
  tint: readonly [number, number, number] = CONTRAIL_TINT,
): Ribbon {
  const positions = new Float32Array(TRAIL_SAMPLES * 2 * 3);
  const colors = new Float32Array(TRAIL_SAMPLES * 2 * 4);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  const indices = new Uint16Array((TRAIL_SAMPLES - 1) * 6);
  for (let i = 0; i < TRAIL_SAMPLES - 1; i += 1) {
    const a = i * 2;
    const o = i * 6;
    indices[o] = a;
    indices[o + 1] = a + 1;
    indices[o + 2] = a + 3;
    indices[o + 3] = a;
    indices[o + 4] = a + 3;
    indices[o + 5] = a + 2;
  }
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.setDrawRange(0, 0);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9); // never cull a trail

  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  scene.add(mesh);
  void side;

  return {
    mesh,
    positions,
    colors,
    samples: new Float32Array(TRAIL_SAMPLES * 3),
    widths: new Float32Array(TRAIL_SAMPLES),
    count: 0,
    sinceSpawn: 0,
    tint,
  };
}

/** Push one sample and rebuild the ribbon buffers in place. */
function pushSample(r: Ribbon, tip: Vec3, width: number): void {
  const keep = Math.min(r.count, TRAIL_SAMPLES - 1);
  if (keep > 0) {
    r.samples.copyWithin(3, 0, keep * 3);
    r.widths.copyWithin(1, 0, keep);
  }
  r.samples[0] = Number.isFinite(tip.x) ? tip.x : 0;
  r.samples[1] = Number.isFinite(tip.y) ? tip.y : 0;
  r.samples[2] = Number.isFinite(tip.z) ? tip.z : 0;
  r.widths[0] = width;
  r.count = Math.min(r.count + 1, TRAIL_SAMPLES);
}

/** Shift the oldest sample off the tail (trail thins out when the emitters stop). */
function popTail(r: Ribbon): void {
  if (r.count <= 1) {
    r.count = 0;
    return;
  }
  const keep = r.count - 1;
  r.samples.copyWithin(0, 3, (keep + 1) * 3);
  r.widths.copyWithin(0, 1, keep + 1);
  r.count = keep;
}

const _dir = new THREE.Vector3();
const _side = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
/** Fuselage-centreline anchor for the skim wake (midpoint of the wingtips). */
const _wakeAnchor: Vec3 = { x: 0, y: 0, z: 0 };

function rebuildRibbon(r: Ribbon, strength: number): void {
  const n = r.count;
  if (n < 2) {
    r.mesh.geometry.setDrawRange(0, 0);
    return;
  }
  const pos = r.positions;
  const col = r.colors;
  const smp = r.samples;
  const wid = r.widths;

  for (let i = 0; i < n; i += 1) {
    const i3 = i * 3;
    _p1.set(smp[i3], smp[i3 + 1], smp[i3 + 2]);
    const j = i + 1 < n ? i + 1 : i - 1;
    const j3 = j * 3;
    _p0.set(smp[j3], smp[j3 + 1], smp[j3 + 2]);
    _dir.subVectors(_p1, _p0);
    if (_dir.lengthSq() < 1e-8) _dir.set(0, 0, 1);
    _dir.normalize();
    _side.crossVectors(_dir, _up);
    if (_side.lengthSq() < 1e-6) _side.set(1, 0, 0);
    _side.normalize();
    const w = wid[i];
    // SC5: alpha already fell along the length (the squared fade), so the "straight cut at the
    // tail" was not the problem -- the ribbon's *cross-section* was uniform, every segment the
    // same opacity, which reads as one extruded strip. A deterministic per-segment jitter
    // makes neighbouring segments differ, and that variation is what reads as a frayed edge.
    const seed = Math.sin(i * 12.9898) * 43758.5453;
    const fray = 0.70 + 0.30 * (seed - Math.floor(seed));
    const fade = 1 - i / Math.max(n - 1, 1);
    const a = 0.55 * strength * fade * fade * fray;

    const o = i * 6;
    pos[o] = _p1.x + _side.x * w;
    pos[o + 1] = _p1.y + _side.y * w;
    pos[o + 2] = _p1.z + _side.z * w;
    pos[o + 3] = _p1.x - _side.x * w;
    pos[o + 4] = _p1.y - _side.y * w;
    pos[o + 5] = _p1.z - _side.z * w;

    const c = i * 8;
    for (let k = 0; k < 2; k += 1) {
      col[c + k * 4] = r.tint[0];
      col[c + k * 4 + 1] = r.tint[1];
      col[c + k * 4 + 2] = r.tint[2];
      col[c + k * 4 + 3] = a;
    }
  }

  // collapse the unused tail onto the last sample so no stray triangles render
  const lastO = (n - 1) * 6;
  for (let i = n; i < TRAIL_SAMPLES; i += 1) {
    const o = i * 6;
    pos[o] = pos[lastO];
    pos[o + 1] = pos[lastO + 1];
    pos[o + 2] = pos[lastO + 2];
    pos[o + 3] = pos[lastO + 3];
    pos[o + 4] = pos[lastO + 4];
    pos[o + 5] = pos[lastO + 5];
  }

  const geo = r.mesh.geometry;
  (geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  (geo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  geo.setDrawRange(0, (n - 1) * 6);
}

export function initFeel(scene: THREE.Scene): FeelHandle {
  const left = makeRibbon(scene, 'porco_contrail_l', new THREE.Vector3(-1, 0, 0));
  const right = makeRibbon(scene, 'porco_contrail_r', new THREE.Vector3(1, 0, 0));
  // The skim wake is a third ribbon, wider and foam-tinted, thrown from the fuselage
  // centreline while the aircraft is riding the deck.
  const wake = makeRibbon(scene, 'porco_skim_wake', new THREE.Vector3(0, 1, 0), FOAM_TINT);
  const shake: Vec3 = { x: 0, y: 0, z: 0 };
  let trauma = 0;
  let clock = 0;

  const stepRibbon = (
    r: Ribbon,
    tip: Vec3,
    active: boolean,
    dt: number,
    firstWidth = 0.06,
    width = 0.2,
  ): void => {
    r.sinceSpawn += dt;
    if (active) {
      if (r.count === 0 || r.sinceSpawn >= TRAIL_SPAWN_DT) {
        r.sinceSpawn = 0;
        pushSample(r, tip, r.count === 0 ? firstWidth : width);
      }
    } else if (r.count > 0 && r.sinceSpawn >= TRAIL_SPAWN_DT * 2.5) {
      r.sinceSpawn = 0;
      popTail(r);
    }
  };

  return {
    shake,
    addTrauma(amount: number): void {
      trauma = updateTrauma(trauma + (Number.isFinite(amount) ? amount : 0), 0);
    },
    trauma01(): number {
      return trauma;
    },
    update(dt: number, ctx: FeelContext): void {
      const d = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
      clock += d;
      trauma = updateTrauma(trauma, d);
      const speed01 = Number.isFinite(ctx.speed01) ? Math.min(Math.max(ctx.speed01, 0), 1) : 0;
      const bank = Number.isFinite(ctx.bank) ? ctx.bank : 0;
      // Idle airframe rumble grows with speed, so fast flight still feels alive at 0 trauma.
      shakeSample(trauma + speed01 * SPEED_RUMBLE, clock, shake);
      // Stall buffet: one dedicated sine on top of the trauma shake, so a wing drop
      // trembles even while trauma itself is quiet. Amplitude is BUFFET01 at full stall.
      const stall = Number.isFinite(ctx.stall01 ?? NaN) ? Math.min(Math.max(ctx.stall01 as number, 0), 1) : 0;
      if (stall > 0) {
        shake.y += STALL.BUFFET01 * stall * SHAKE_MAX * Math.sin(clock * 29.7);
      }

      const active = Math.abs(bank) > CONTRAIL_BANK || speed01 > CONTRAIL_SPEED;
      if (active) {
        stepRibbon(left, ctx.leftTip, true, d);
        stepRibbon(right, ctx.rightTip, true, d);
      } else {
        stepRibbon(left, ctx.leftTip, false, d);
        stepRibbon(right, ctx.rightTip, false, d);
      }
      const strength = Math.min(1, Math.max(0.25, Math.abs(bank) * 1.1 + speed01 * 0.6));
      rebuildRibbon(left, strength);
      rebuildRibbon(right, strength);

      // Deck skim: a wide foam wake off the fuselage centreline, scaled by how much of
      // a skim it is. It thins out on its own once the aircraft climbs away.
      const skim = Number.isFinite(ctx.skim01 ?? NaN)
        ? Math.min(Math.max(ctx.skim01 as number, 0), 1)
        : 0;
      _wakeAnchor.x = (ctx.leftTip.x + ctx.rightTip.x) * 0.5;
      _wakeAnchor.y = Math.min((ctx.leftTip.y + ctx.rightTip.y) * 0.5 - 0.2, SEA_WAKE_Y);
      _wakeAnchor.z = (ctx.leftTip.z + ctx.rightTip.z) * 0.5;
      stepRibbon(wake, _wakeAnchor, skim > SKIM_WAKE, d, 0.25, 0.45);
      // A wake is spray, not a runway: keep it well under the contrail alpha so it
      // reads as foam on the water rather than a solid surface.
      rebuildRibbon(wake, skim * 0.45);
    },
    dispose(): void {
      for (const r of [left, right, wake]) {
        scene.remove(r.mesh);
        r.mesh.geometry.dispose();
        (r.mesh.material as THREE.Material).dispose();
        r.count = 0;
      }
      shake.x = 0;
      shake.y = 0;
      shake.z = 0;
      trauma = 0;
    },
  };
}
