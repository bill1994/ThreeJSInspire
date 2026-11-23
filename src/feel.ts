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
import { WAKE_FOAM } from './palettes';
import { cloudTraumaTarget } from './director';
import {trailProfile,wakeProfile,TRAIL_LIFE,WAKE_LIFE} from './trail-motion';

/** Trauma lost per second (a full-strength hit is gone in under a second). */
export const TRAUMA_DECAY = 1.15;

/** Peak camera offset in world units at trauma = 1. */
export const SHAKE_MAX = 0.85;

/** Idle airframe rumble at full speed, added to trauma before sampling. */
export const SPEED_RUMBLE = 0.07;

/** Bank (rad) past which contrails pour off the wingtips. */
export const CONTRAIL_BANK = 0.42;

/** Normalised speed past which contrails pour off the wingtips. P0-4: 0.55. */
export const CONTRAIL_SPEED = 0.55;

/** P0-4 Q3-7 idle lane: above this speed01 cruise keeps a whisper trail. */
export const CONTRAIL_IDLE_MIN = 0.15;

/** P0-4 Q3-7 idle strength; head alpha 0.55*0.15 ≈ 0.08 pre-fray. */
export const CONTRAIL_IDLE = 0.15;

/** Samples held per wingtip ribbon (fixed pool — never grows). */
export const TRAIL_SAMPLES = 48;

/** Seconds between contrail samples. */
export const TRAIL_SPAWN_DT = 0.035;

/** Deck-skim amount past which the aircraft throws a foam wake. */
export const SKIM_WAKE = 0.25;

/**
 * P0-2 sea rumble: continuous deck chop on the camera, never trauma. Gated by
 * the skim amount so it vanishes with altitude; the smooth noise only breathes
 * the amplitude inside 0.10..0.16 x SHAKE_MAX. 13 Hz vertical, 17 Hz lateral —
 * both under the 30 Hz Nyquist of a 60 fps sample, like the 29.7 Hz buffet.
 */
export const RUMBLE_Y_HZ = 13;
export const RUMBLE_X_HZ = 17;
/** Peak rumble amplitude as a fraction of SHAKE_MAX (the noise dips it to 0.10). */
export const RUMBLE_AMP = 0.16;
/** Floor of the noise mix: amplitude never drops below 0.625 x RUMBLE_AMP. */
export const RUMBLE_MIN_MIX = 0.625;
/** Foam-wake width pulse: skim x (WAKE_BASE .. WAKE_BASE + WAKE_PULSE). */
export const WAKE_BASE = 0.45;
export const WAKE_PULSE = 0.25;

/**
 * P0-3 in-cloud chop. The entry knock is director's HIT_CLOUD; everything after
 * is continuous: a 23 Hz small buffet under the shake plus a ±0.06 rad visual
 * bank sway at 0.7 Hz. Tracking rate 3/s toward cloudTraumaTarget.
 */
export const CLOUD_BUFFET_HZ = 23;
export const CLOUD_BUFFET01 = 0.12;
export const CLOUD_SWAY_RAD = 0.06;
export const CLOUD_SWAY_HZ = 0.7;
export const CLOUD_TRACK_RATE = 3;

const TAU = Math.PI * 2;
/** Randomised once per session so the chop never phase-locks to the buffet. */
const RUMBLE_PHASE = Math.random() * TAU;

/**
 * Smooth deterministic chop driver, 0..1. A slow two-sine breathe — never
 * per-frame random, which would buzz like static on the camera.
 */
export function rumbleNoise01(t: number): number {
  if (!Number.isFinite(t)) return 0.5;
  const n = 0.5 + 0.28 * Math.sin(t * TAU * 0.9) + 0.22 * Math.sin(t * TAU * 1.7 + 1.3);
  return Math.min(Math.max(n, 0), 1);
}

/**
 * Sea-rumble gate, 0..1 of RUMBLE_AMP. The skim carries the altitude AND the
 * level gating (a steep dive is spray, not chop); the noise only moves the
 * amplitude inside [RUMBLE_MIN_MIX, 1].
 *
 * Note on the spec formula (skim*0.5 + noise*0.5): read literally it rumbles at
 * cruise altitude, so the gate multiplies instead of adding — silence up high,
 * 0.10..0.16 x SHAKE_MAX on the deck.
 */
export function seaRumble01(skim: number, t: number): number {
  const gate = Number.isFinite(skim) ? Math.min(Math.max(skim, 0), 1) : 0;
  return gate * (RUMBLE_MIN_MIX + (1 - RUMBLE_MIN_MIX) * rumbleNoise01(t));
}

/** Foam-wake ribbon strength: skim x (0.45 .. 0.70), pulsing with the chop. */
export function wakeStrength(skim: number, t: number): number {
  const gate = Number.isFinite(skim) ? Math.min(Math.max(skim, 0), 1) : 0;
  return gate * (WAKE_BASE + WAKE_PULSE * (RUMBLE_MIN_MIX + (1 - RUMBLE_MIN_MIX) * rumbleNoise01(t)));
}

/**
 * P2-3 近场流速暗示：wake 上的 foam streak 行波深度与频率。
 * ribbon 几何没有 uv（只有 position + color），新开纹理通道换不来可读增益，
 * 所以条纹走顶点 alpha 行波——和 fray 同一通道，原生 WebGPU-safe。
 * 速度只调「流得多快」（相速 1x..4x），不调「有多亮」（值域恒 [0.8,1]）。
 */
export const WAKE_STREAK_DEPTH = 0.2;
export const WAKE_STREAK_K = 0.9;
export const WAKE_STREAK_OMEGA = Math.PI;
export function wakeStreak(i: number, t: number, speed01: number): number {
  if (!Number.isFinite(i) || !Number.isFinite(t)) return 1;
  // NaN 速度 = 垃圾输入 → 中性（无条纹）；合法 0 仍有最慢行波。
  if (!Number.isFinite(speed01)) return 1;
  const s = Math.min(Math.max(speed01, 0), 1);
  const phase = i * WAKE_STREAK_K - t * WAKE_STREAK_OMEGA * (1 + 3 * s);
  return 1 - WAKE_STREAK_DEPTH * (0.5 - 0.5 * Math.sin(phase));
}

/** SC6: seconds the skim splash ring lives before it disappears. */
export const SKIM_RING_LIFE = 0.55;

// ---- P1-1 sea particles (design §Q4): L2 spray / L3 mist / L4 second + tip rings.
// All pooled, zero per-frame allocation, WebGPU-safe. Colours come from WAKE_FOAM
// (0xd8b896, luminance ~0.72) so the bloom threshold 0.82 never fires on foam.

/** L2 spray pool size — one draw call whatever the tier. */
export const SPRAY_COUNT = 400;
/** L2 spray emission while skimmed (particles per second). */
export const SPRAY_BURST = 60;
/** L2 spray particle lifetime in seconds. */
export const SPRAY_LIFE = 0.7;
/** L2 spray launch: upward m/s band + backward slip (SPRAY_BACK, world space). */
export const SPRAY_UP_MIN = 3;
export const SPRAY_UP_MAX = 7;
export const SPRAY_BACK = 5;
/** L3 mist: soft sprites cycling on a staggered loop. */
export const MIST_COUNT = 8;
export const MIST_LIFE = 1.2;
export const MIST_ALPHA = 0.18;
export const MIST_SIZE_MIN = 2;
export const MIST_SIZE_MAX = 6;
export const MIST_Y = 0.3;
/** L4: the second centre ring lags 0.15 s, grows 1.6x, fades at half alpha. */
export const RING2_DELAY = 0.15;
export const RING2_GROWTH = 1.6;
export const RING2_ALPHA = 0.5;
/** |bank| past this while skimming throws the wingtip vortex rings. */
export const TIP_BANK = 0.5;

/**
 * Altitude the foam wake is laid at. The skim itself rides at FLIGHT.ALT_MIN + 1 (7 m),
 * so the spray belongs under the aircraft — not at the aircraft's own altitude, which
 * floated a slab in mid-air.
 *
 * The sea surface (y = 0) that used to define this plane is gone as of
 * `rebuild/sea-dome-reset`; the wake keeps its height so the spray still hangs below the
 * wing instead of strobing through it.
 */
export const SEA_WAKE_Y = 0.6;

/** Contrail tint, and the foam tint the skim wake uses (both from the palette). */
const CONTRAIL_TINT = [0.97, 0.94, 0.9] as const;
const FOAM_TINT = [
  ((WAKE_FOAM >> 16) & 255) / 255,
  ((WAKE_FOAM >> 8) & 255) / 255,
  (WAKE_FOAM & 255) / 255,
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
  floats?: import('./surface-interaction').FloatPair;
  daylight01?: number;
  /** 0..1 speed normalisation. */
  speed01: number;
  /** Signed bank in radians. */
  bank: number;
  /** 0..1 stylised stall intensity; absent or NaN reads as no buffet. */
  stall01?: number;
  /** 0..1 deck skim (see skim.ts); past SKIM_WAKE the plane throws a foam wake. */
  skim01?: number;
  /** 0..1 in-cloud proximity AFTER the whiteout hysteresis (cloudProx, never raw prox). */
  cloud01?: number;
  /** World-space wingtip positions for the two contrail emitters. */
  leftTip: Vec3;
  rightTip: Vec3;
  /**
   * P1-1 Q4: world-space horizontal drift the spray is born with (the slipstream
   * pushing the plume backward, e.g. -forward * SPRAY_BACK). Absent reads as
   * still air; the upward launch is untouched either way.
   */
  backwash?: { x: number; z: number };
}

export interface FeelHandle {
  /** Live shake offset (world units); read after `update()`. */
  readonly shake: Vec3;
  /** Live visual-bank sway (radians); added to the plane's bank AFTER `update()`. */
  readonly bankSway: number;
  addTrauma(amount: number): void;
  /** Current trauma 0..1. */
  trauma01(): number;
  /**
   * P1-3 comfort: scales what reaches the camera (shake output), not the
   * simulated trauma value — decay timing is untouched, only the ride
   * softens. Low档/晕 3D 走这里（`?shake=reduced` → 0.4）。
   */
  setShakeScale(s: number): void;
  /**
   * P1-1 Q4 perf: low tier parks L2 (spray) and L3 (mist) entirely — one draw
   * call is cheap, but eight soft sprites of overdraw on a weak GPU are not.
   * L1/Ring stay: the contact never goes quiet.
   */
  setQuality(high: boolean): void;
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
  births: Float32Array;
  strengths: Float32Array;
  previousTip: Vec3;
  strength: number;
  headSide: THREE.Vector3;
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
    births: new Float32Array(TRAIL_SAMPLES),
    strengths: new Float32Array(TRAIL_SAMPLES),
    previousTip: {x:0,y:0,z:0},
    strength: 0,
    headSide:new THREE.Vector3(1,0,0),
    count: 0,
    sinceSpawn: 0,
    tint,
  };
}

/** Push one sample and rebuild the ribbon buffers in place. */
function pushSample(r: Ribbon, tip: Vec3, width: number, born=0): void {
  const keep = Math.min(r.count, TRAIL_SAMPLES - 1);
  if (keep > 0) {
    r.samples.copyWithin(3, 0, keep * 3);
    r.widths.copyWithin(1, 0, keep);
    r.births.copyWithin(1,0,keep);
    r.strengths.copyWithin(1,0,keep);
  }
  r.samples[0] = Number.isFinite(tip.x) ? tip.x : 0;
  r.samples[1] = Number.isFinite(tip.y) ? tip.y : 0;
  r.samples[2] = Number.isFinite(tip.z) ? tip.z : 0;
  r.widths[0] = width;
  r.births[0]=born;r.strengths[0]=r.strength;
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
const _trailProfile={lateral:0,lift:0,width:1,alpha:1};
const _sampleTip:Vec3={x:0,y:0,z:0};
const _previousSide=new THREE.Vector3();

function rebuildRibbon(
  r: Ribbon,
  strength: number,
  streak: { t: number; speed01: number } | null = null,
  motionTime=-1, wing=0, lateralOrigin=1.7,
): void {
  const n = r.count;
  if (n < 2) {
    r.mesh.geometry.setDrawRange(0, 0);
    return;
  }
  const pos = r.positions;
  const col = r.colors;
  const smp = r.samples;
  const wid = r.widths;
  _previousSide.copy(r.headSide);

  for (let i = 0; i < n; i += 1) {
    const i3 = i * 3;
    _p1.set(smp[i3], smp[i3 + 1], smp[i3 + 2]);
    const j = i + 1 < n ? i + 1 : i - 1;
    const j3 = j * 3;
    _p0.set(smp[j3], smp[j3 + 1], smp[j3 + 2]);
    _dir.subVectors(_p1, _p0);
    if(motionTime>=0 && i===n-1)_dir.negate();
    if (_dir.lengthSq() < 1e-8) _dir.set(0, 0, 1);
    _dir.normalize();
    _side.crossVectors(_dir, _up);
    if (_side.lengthSq() < 1e-6) {
      if(motionTime>=0)_side.copy(_previousSide).addScaledVector(_dir,-_previousSide.dot(_dir));
      if(_side.lengthSq()<1e-6)_side.set(1,0,0);
    }
    _side.normalize();
    if(motionTime>=0){
      if(_side.dot(_previousSide)<0)_side.negate();
      if(i===0)r.headSide.copy(_side);
      _previousSide.copy(_side);
    }
    if(motionTime>=0){
      if(streak)wakeProfile(r.births[i],motionTime-r.births[i],_trailProfile);
      else trailProfile(r.births[i],motionTime-r.births[i],wing,_trailProfile);
      const expansion = streak ? wing*(lateralOrigin+6*Math.max(0,motionTime-r.births[i])) : 0;
      _p1.addScaledVector(_side,_trailProfile.lateral+expansion);_p1.y+=_trailProfile.lift;
    }
    const w = wid[i]*(motionTime>=0?_trailProfile.width:1);
    // SC5: alpha already fell along the length (the squared fade), so the "straight cut at the
    // tail" was not the problem -- the ribbon's *cross-section* was uniform, every segment the
    // same opacity, which reads as one extruded strip. A deterministic per-segment jitter
    // makes neighbouring segments differ, and that variation is what reads as a frayed edge.
    const seed = Math.sin(i * 12.9898) * 43758.5453;
    const fray = 0.70 + 0.30 * (seed - Math.floor(seed));
    const fade = 1 - i / Math.max(n - 1, 1);
    // P2-3：wake 限定的 foam streak 行波（contrail 传 null，不参与）。
    const streakAmp = streak ? wakeStreak(i, streak.t, streak.speed01) : 1;
    const a = motionTime>=0 ? .55*r.strengths[i]*_trailProfile.alpha
      : 0.55 * strength * fade * fade * fray * streakAmp;

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

export function initFeel(scene: THREE.Scene, refined=false): FeelHandle {
  const left = makeRibbon(scene, 'porco_contrail_l', new THREE.Vector3(-1, 0, 0));
  const right = makeRibbon(scene, 'porco_contrail_r', new THREE.Vector3(1, 0, 0));
  const wake = makeRibbon(scene, 'porco_skim_wake', new THREE.Vector3(0, 1, 0), FOAM_TINT);
  const wakeRight = makeRibbon(scene, 'porco_skim_wake_right', new THREE.Vector3(0,1,0), FOAM_TINT);
  let feather:THREE.DataTexture|null=null;
  if(refined){
    const data=new Uint8Array(32*4);
    for(let i=0;i<32;i++){const t=Math.abs((i/31)*2-1);data.set([255,255,255,Math.round(255*(1-t*t)**2)],i*4);}
    feather=new THREE.DataTexture(data,32,1);feather.needsUpdate=true;
    feather.magFilter=THREE.LinearFilter;feather.minFilter=THREE.LinearFilter;
    for(const r of [left,right,wake,wakeRight]){
      const uv=new Float32Array(TRAIL_SAMPLES*4);
      for(let i=0;i<TRAIL_SAMPLES;i++)uv.set([0,.5,1,.5],i*4);
      r.mesh.geometry.setAttribute('uv',new THREE.BufferAttribute(uv,2));
      (r.mesh.material as THREE.MeshBasicMaterial).map=feather;
    }
  }

  // P1-1 Q4: seeded pool noise — same capture-protocol contract as stars.ts
  // (deterministic across runs, never Math.random per frame).
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const poolRand = mulberry32(20261113);

  // P1-1 L4 ring pool. SC6's single ring becomes four sharing one geometry:
  // centre-1 keeps the name (and the exact look), centre-2 lags 0.15 s at 1.6x
  // growth and half alpha, and the tip pair fires off the wingtips when banked.
  interface Ping {
    mesh: THREE.Mesh;
    mat: THREE.MeshBasicMaterial;
    t: number; // 1 = dead; negative = delay still spending
    growth: number;
    alpha0: number;
  }
  const ringGeo = refined
    ? new THREE.RingGeometry(0.77, 1, 40, 2)
    : new THREE.RingGeometry(0.55, 1.0, 28);
  if (refined) {
    // Only the centre of the narrow ripple catches light, in broken arcs.
    const vertices = ringGeo.getAttribute('position');
    const colors = new Float32Array(vertices.count * 4);
    for (let i = 0; i < vertices.count; i++) {
      const x = vertices.getX(i), y = vertices.getY(i);
      const angle = Math.atan2(y, x);
      const mid = 1 - Math.min(1, Math.abs(Math.hypot(x, y) - 0.885) / 0.115);
      const crest = Math.max(0, 0.38 + 0.32 * Math.sin(3 * angle) + 0.28 * Math.cos(7 * angle));
      colors.set([1, 1, 1, mid * crest], i * 4);
    }
    ringGeo.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  }
  const pings: Ping[] = [];
  const addPing = (name: string, growth: number, alpha0: number): Ping => {
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(FOAM_TINT[0], FOAM_TINT[1], FOAM_TINT[2]),
      vertexColors: refined,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const mesh = new THREE.Mesh(ringGeo, mat);
    mesh.name = name;
    mesh.rotation.x = -Math.PI / 2;
    mesh.visible = false;
    mesh.renderOrder = 3;
    scene.add(mesh);
    const p: Ping = { mesh, mat, t: 1, growth, alpha0 };
    pings.push(p);
    return p;
  };
  const ringC1 = addPing('porco_skim_ring', 1, 0.5);
  const ringC2 = addPing('porco_skim_ring2', RING2_GROWTH, 0.5 * RING2_ALPHA);
  const ringL = addPing('porco_skim_ringL', 0.8, 0.4);
  const ringR = addPing('porco_skim_ringR', 0.8, 0.4);
  const spawnPing = (p: Ping, x: number, z: number, delay: number): void => {
    p.t = delay > 0 ? -delay / SKIM_RING_LIFE : 0;
    p.mesh.position.set(x, SEA_WAKE_Y + 0.04, z);
    // Delayed rings stay parked until the delay is spent — visible with
    // opacity 0 would still cost a draw call for nothing.
    p.mesh.visible = delay <= 0;
  };
  let prevSkim = 0;
  let prevBankHigh = false;

  // P1-1 L2 spray: one pooled THREE.Points, cursor overwrite (no free-list
  // search), dead particles parked at y = -50. Emission is gated on skim > 0.5
  // so a calm deck never pays for the system.
  const sprayPos = new Float32Array(SPRAY_COUNT * 3);
  const sprayVel = new Float32Array(SPRAY_COUNT * 3);
  const sprayLife = new Float32Array(SPRAY_COUNT);
  for (let i = 0; i < SPRAY_COUNT; i += 1) sprayPos[i * 3 + 1] = -50;
  let sprayCursor = 0;
  let sprayAcc = 0;
  const sprayGeo = new THREE.BufferGeometry();
  const sprayAttr = new THREE.BufferAttribute(sprayPos, 3);
  sprayAttr.setUsage(THREE.DynamicDrawUsage);
  sprayGeo.setAttribute('position', sprayAttr);
  const sprayMat = new THREE.PointsMaterial({
    size: 0.55,
    sizeAttenuation: true,
    color: new THREE.Color(FOAM_TINT[0], FOAM_TINT[1], FOAM_TINT[2]),
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    fog: false,
  });
  const spray = new THREE.Points(sprayGeo, sprayMat);
  spray.name = 'porco_spray';
  spray.frustumCulled = false;
  spray.renderOrder = 2;
  scene.add(spray);
  let sprayOn = true; // P1-1 perf: low tier parks the whole pool

  // P1-1 L3 mist: 8 soft sprites on a staggered 1.2 s loop, generated radial
  // texture (DataTexture, no DOM canvas — headless-safe). Each sprite owns its
  // material so the alphas can breathe independently; the texture is shared.
  const MIST_TEX_SIZE = 64;
  const mistData = new Uint8Array(MIST_TEX_SIZE * MIST_TEX_SIZE * 4);
  for (let yy = 0; yy < MIST_TEX_SIZE; yy += 1) {
    for (let xx = 0; xx < MIST_TEX_SIZE; xx += 1) {
      const dx = (xx + 0.5) / MIST_TEX_SIZE - 0.5;
      const dy = (yy + 0.5) / MIST_TEX_SIZE - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2;
      const fall = Math.min(Math.max(1 - r, 0), 1);
      const o = (yy * MIST_TEX_SIZE + xx) * 4;
      mistData[o] = Math.round(FOAM_TINT[0] * 255);
      mistData[o + 1] = Math.round(FOAM_TINT[1] * 255);
      mistData[o + 2] = Math.round(FOAM_TINT[2] * 255);
      mistData[o + 3] = Math.round(fall * fall * 255);
    }
  }
  const mistTex = new THREE.DataTexture(mistData, MIST_TEX_SIZE, MIST_TEX_SIZE);
  mistTex.needsUpdate = true;
  const mists: THREE.Sprite[] = [];
  // Fixed per-sprite lateral offsets so the row never collapses into one puff.
  const splashAtlas = refined && typeof document!=='undefined' ? new THREE.TextureLoader().load('/assets/skim-splash.png') : null;
  const splashFrames:THREE.Texture[]=[];
  const mistJitter: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < MIST_COUNT; i += 1) {
    mistJitter.push({ x: (poolRand() - 0.5) * 8, z: (poolRand() - 0.5) * 6 - 1 });
  }
  for (let i = 0; i < MIST_COUNT; i += 1) {
    const mat = new THREE.SpriteMaterial({
      map: mistTex,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
    });
    const sp = new THREE.Sprite(mat);
    sp.name = `porco_mist_${i}`;
    sp.visible = false;
    sp.renderOrder = 2;
    scene.add(sp);
    mists.push(sp);
  }
  let mistOn = true; // P1-1 perf: low tier parks the sprites with the spray

  // P1-3 comfort: 1 = full ride, 0.4 = reduced. Scales the shake OUTPUT at
  // the single choke point below — hits, chop, cloud buffet and stall tremble
  // all shrink together, while the trauma value keeps simulating (decay
  // timing unchanged). Bank sway is attitude, not shake, and stays.
  let shakeScale = 1;
  const shake: Vec3 = { x: 0, y: 0, z: 0 };
  let trauma = 0;
  let clock = 0;
  let sway = 0; // P0-3 visual bank sway; written by update, read after it.

  const stepRibbon = (
    r: Ribbon,
    tip: Vec3,
    active: boolean,
    dt: number,
    firstWidth = 0.06,
    width = 0.2,
  ): void => {
    if(refined){
      const jump=r.count>0 && Math.hypot(tip.x-r.previousTip.x,tip.y-r.previousTip.y,tip.z-r.previousTip.z)>150;
      if(jump){r.count=0;r.sinceSpawn=0;}
      const surfaceTrail=r===wake || r===wakeRight;
      const life=surfaceTrail?WAKE_LIFE:TRAIL_LIFE;
      while(r.count>0 && clock-r.births[r.count-1]>=life)r.count--;
      if(active){
        if(r.count===0){pushSample(r,tip,firstWidth,clock);r.sinceSpawn=0;}
        else {
          const travelled=Math.hypot(tip.x-r.previousTip.x,tip.z-r.previousTip.z);
          const interval=surfaceTrail ? 1.4 : TRAIL_SPAWN_DT;
          const increment=surfaceTrail ? travelled : dt;
          r.sinceSpawn+=increment;
          while(r.sinceSpawn>=interval){
            r.sinceSpawn-=interval;
            const f=increment>0?Math.min(1,Math.max(0,1-r.sinceSpawn/increment)):1;
            _sampleTip.x=r.previousTip.x+(tip.x-r.previousTip.x)*f;
            _sampleTip.y=r.previousTip.y+(tip.y-r.previousTip.y)*f;
            _sampleTip.z=r.previousTip.z+(tip.z-r.previousTip.z)*f;
            pushSample(r,_sampleTip,width,clock-(1-f)*dt);
          }
        }
      }else r.sinceSpawn=0;
      r.previousTip.x=tip.x;r.previousTip.y=tip.y;r.previousTip.z=tip.z;
      return;
    }
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
    get bankSway(): number {
      return sway;
    },
    addTrauma(amount: number): void {
      trauma = updateTrauma(trauma + (Number.isFinite(amount) ? amount : 0), 0);
    },
    trauma01(): number {
      return trauma;
    },
    update(dt: number, ctx: FeelContext): void {
      const d = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
      clock += d;
      // P0-3 cloud rumble: while inside, rate-3 tracking OWNS trauma (it replaces
      // the linear decay); on exit the target is zero and the decay below
      // breathes out on its own — no exponential rewrite needed.
      const cloud = Number.isFinite(ctx.cloud01 ?? NaN)
        ? Math.min(Math.max(ctx.cloud01 as number, 0), 1)
        : 0;
      const cloudTarget = cloudTraumaTarget(cloud);
      // Gate on the proximity itself: an absent/zero cloud01 must keep the old
      // linear-decay path (cloudTraumaTarget(0) is 0.15, never zero).
      if (cloud > 0) {
        trauma += (cloudTarget - trauma) * Math.min(1, d * CLOUD_TRACK_RATE);
      } else {
        trauma = updateTrauma(trauma, d);
      }
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
      // P0-4 Q3-7: idle lane. Cruise no longer flies naked — above IDLE_MIN the
      // wingtips keep a whisper-thin trail (strength IDLE reads 0.55*0.15 ≈ 0.08
      // head alpha, pre-fray) instead of popping in only past CONTRAIL_SPEED.
      const idle = !active && speed01 > CONTRAIL_IDLE_MIN;
      if(refined){
        const target=active?Math.min(1,Math.max(.25,Math.abs(bank)*1.1+speed01*.6)):idle?CONTRAIL_IDLE:0;
        const follow=1-Math.exp(-d*8);
        left.strength+=(target-left.strength)*follow;right.strength=left.strength;
        const day=Math.min(1,Math.max(0,ctx.daylight01??1));
        for(const r of [left,right]){
          const m=r.mesh.material as THREE.MeshBasicMaterial;
          m.color.setRGB(.35+.65*day,.48+.52*day,.65+.35*day);
          m.opacity=1-.8*cloud;
        }
      }
      if (active) {
        stepRibbon(left, ctx.leftTip, true, d);
        stepRibbon(right, ctx.rightTip, true, d);
      } else if (idle) {
        stepRibbon(left, ctx.leftTip, true, d, 0.06, 0.05);
        stepRibbon(right, ctx.rightTip, true, d, 0.06, 0.05);
      } else {
        stepRibbon(left, ctx.leftTip, false, d);
        stepRibbon(right, ctx.rightTip, false, d);
      }
      const strength = active
        ? Math.min(1, Math.max(0.25, Math.abs(bank) * 1.1 + speed01 * 0.6))
        : idle
          ? CONTRAIL_IDLE
          : 0.25;
      rebuildRibbon(left, strength,null,refined?clock:-1,-1);
      rebuildRibbon(right, strength,null,refined?clock:-1,1);

      // Deck skim: a wide foam wake off the fuselage centreline, scaled by how much of
      // a skim it is. It thins out on its own once the aircraft climbs away.
      const floats = ctx.floats;
      const skim = floats ? Math.max(floats[0].strength, floats[1].strength) : Number.isFinite(ctx.skim01 ?? NaN)
        ? Math.min(Math.max(ctx.skim01 as number, 0), 1)
        : 0;
      // P0-2 sea rumble: continuous deck chop, additive on the camera offset,
      // never through addTrauma, never touching the simulated transform.
      const rumble01 = seaRumble01(skim, clock);
      if (rumble01 > 0) {
        const rumbleAmp = rumble01 * RUMBLE_AMP * SHAKE_MAX;
        shake.y += rumbleAmp * Math.sin(clock * RUMBLE_Y_HZ * TAU + RUMBLE_PHASE);
        shake.x += rumbleAmp * 0.7 * Math.sin(clock * RUMBLE_X_HZ * TAU + RUMBLE_PHASE * 1.7);
      }
      // P0-3 in-cloud buffet (23 Hz, small) + visual bank sway (±0.06 @ 0.7 Hz).
      // The sway rides the visual bank only — never the simulated state.
      if (cloud > 0) {
        shake.y += CLOUD_BUFFET01 * cloud * SHAKE_MAX * Math.sin(clock * CLOUD_BUFFET_HZ * TAU);
        sway = CLOUD_SWAY_RAD * cloud * Math.sin(clock * CLOUD_SWAY_HZ * TAU);
      } else {
        sway = 0;
      }
      // P1-3 choke point: every shake source above lands here.
      if (shakeScale !== 1) {
        shake.x *= shakeScale;
        shake.y *= shakeScale;
        shake.z *= shakeScale;
      }
      _wakeAnchor.x = (ctx.leftTip.x + ctx.rightTip.x) * 0.5;
      _wakeAnchor.y = Math.min((ctx.leftTip.y + ctx.rightTip.y) * 0.5 - 0.2, SEA_WAKE_Y);
      _wakeAnchor.z = (ctx.leftTip.z + ctx.rightTip.z) * 0.5;
      wake.strength=wakeStrength(floats?.[0].strength ?? skim,clock);
      if(refined){
        const day=Math.min(1,Math.max(0,ctx.daylight01??1));
        (wake.mesh.material as THREE.MeshBasicMaterial).color.setRGB(.35+.65*day,.48+.52*day,.65+.35*day);
      }
      stepRibbon(wake, floats?.[0] ?? _wakeAnchor, (floats?.[0].strength ?? skim) > SKIM_WAKE, d, 0.25, floats ? .32 : refined ? .65 : .45);
      // Deposit each patch with its own strength and lifetime. Refined foam
      // drifts horizontally, breaks into gaps and fades before reaching the
      // chase camera; old patches remain when the plane climbs away.
      rebuildRibbon(wake, wake.strength, { t: clock, speed01 },refined?clock:-1,-1,floats ? 0 : 1.7);
      if(refined){
        wakeRight.strength=wakeStrength(floats?.[1].strength ?? skim,clock);
        (wakeRight.mesh.material as THREE.MeshBasicMaterial).color.copy((wake.mesh.material as THREE.MeshBasicMaterial).color);
        stepRibbon(wakeRight,floats?.[1] ?? _wakeAnchor,(floats?.[1].strength ?? skim)>SKIM_WAKE,d,.25,floats ? .32 : .65);
        rebuildRibbon(wakeRight,wakeRight.strength,{t:clock,speed01},clock,1,floats ? 0 : 1.7);
      }

      // P1-1 L4: the skim edge spawns centre-1 now and centre-2 after the
      // 0.15 s delay; the bank edge (while skimmed) throws the wingtip pair.
      if (prevSkim <= SKIM_WAKE && skim > SKIM_WAKE) {
        spawnPing(ringC1, _wakeAnchor.x, _wakeAnchor.z, 0);
        spawnPing(ringC2, _wakeAnchor.x, _wakeAnchor.z, RING2_DELAY);
      }
      prevSkim = skim;
      const bankHigh = Math.abs(ctx.bank) > TIP_BANK;
      if (!prevBankHigh && bankHigh && skim > SKIM_WAKE) {
        spawnPing(ringL, ctx.leftTip.x, ctx.leftTip.z, 0);
        spawnPing(ringR, ctx.rightTip.x, ctx.rightTip.z, 0);
      }
      prevBankHigh = bankHigh;
      for (const p of pings) {
        if (p.t >= 1) continue; // dead
        p.t = Math.min(1, p.t + d / SKIM_RING_LIFE);
        if (p.t < 0) continue; // delay still spending
        p.mesh.visible = true;
        p.mesh.scale.setScalar(1 + p.t * 7 * p.growth);
        p.mat.opacity = p.alpha0 * (1 - p.t) * (1 - p.t);
        if (p.t >= 1) p.mesh.visible = false;
      }

      // P1-1 L2 spray: emit while skimmed, integrate the live ones, park the
      // dead. Gravity bends the arc; the backwash carries the plume behind.
      const bw = ctx.backwash ?? { x: 0, z: 0 };
      if (sprayOn) {
        spray.visible = true;
        if (skim > 0.5 && Number.isFinite(d) && d > 0) {
          sprayAcc += SPRAY_BURST * d;
          while (sprayAcc >= 1) {
            sprayAcc -= 1;
            const i = sprayCursor;
            sprayCursor = (sprayCursor + 1) % SPRAY_COUNT;
            const source = floats ? floats[Number(poolRand() * (floats[0].strength + floats[1].strength) >= floats[0].strength)] : _wakeAnchor;
            const width = floats ? 1.3 : 6;
            sprayPos[i * 3] = source.x + (poolRand() - 0.5) * width;
            sprayPos[i * 3 + 1] = MIST_Y;
            sprayPos[i * 3 + 2] = source.z + (poolRand() - 0.5) * width;
            sprayVel[i * 3] = (Number.isFinite(bw.x) ? bw.x : 0) + (poolRand() - 0.5) * 2;
            sprayVel[i * 3 + 1] = SPRAY_UP_MIN + poolRand() * (SPRAY_UP_MAX - SPRAY_UP_MIN);
            sprayVel[i * 3 + 2] = (Number.isFinite(bw.z) ? bw.z : 0) + (poolRand() - 0.5) * 2;
            sprayLife[i] = SPRAY_LIFE;
          }
        }
        for (let i = 0; i < SPRAY_COUNT; i += 1) {
          if (sprayLife[i] <= 0) continue;
          sprayLife[i] -= d;
          if (sprayLife[i] <= 0) {
            sprayPos[i * 3 + 1] = -50; // park the dead below the world
            continue;
          }
          sprayVel[i * 3 + 1] -= 9.8 * d;
          sprayPos[i * 3] += sprayVel[i * 3] * d;
          sprayPos[i * 3 + 1] += sprayVel[i * 3 + 1] * d;
          sprayPos[i * 3 + 2] += sprayVel[i * 3 + 2] * d;
          if (sprayPos[i * 3 + 1] < 0) {
            sprayLife[i] = 0;
            sprayPos[i * 3 + 1] = -50;
          }
        }
        sprayAttr.needsUpdate = true;
      } else {
        spray.visible = false;
      }

      // P1-1 L3 mist: eight sprites on a staggered 1.2 s loop — expand 2 to
      // 6 m while fading 0.18 to 0, drifting back with the slipstream.
      if (mistOn && skim > 0.5) {
        for (let i = 0; i < MIST_COUNT; i += 1) {
          const sp = mists[i];
          sp.visible = true;
          const age = (clock + (i * MIST_LIFE) / MIST_COUNT) % MIST_LIFE;
          const f = age / MIST_LIFE;
          const size = MIST_SIZE_MIN + (MIST_SIZE_MAX - MIST_SIZE_MIN) * f;
          sp.scale.set(size, size, 1);
          (sp.material as THREE.SpriteMaterial).opacity = MIST_ALPHA * (1 - f);
          const j = mistJitter[i];
          const source = floats?.[i % 2] ?? _wakeAnchor;
          if(splashAtlas?.image){
            const mat=sp.material as THREE.SpriteMaterial;
            if(!splashFrames[i]){
              const tex=splashAtlas.clone();tex.repeat.set(1/6,1);tex.needsUpdate=true;
              splashFrames[i]=tex;mat.map=tex;mat.needsUpdate=true;
            }
            splashFrames[i].offset.x=Math.min(5,Math.floor(f*6))/6;
            mat.opacity=(1-f)*(floats?.[i % 2].strength ?? skim)*(.5+.5*speed01)*(1+Math.sin(ctx.bank)*(i%2?-.32:.32));
            mat.color.setScalar(.3+.7*(ctx.daylight01??1));
          }
          const side=i%2?1:-1;
          const len=Math.max(.001,Math.hypot(bw.x,bw.z));
          const spread=side*((floats ? 0 : 2.2)+age*2.4);
          sp.position.set(
            source.x + j.x*.12 + bw.z/len*spread + bw.x*age,
            MIST_Y,
            source.z + j.z*.12 - bw.x/len*spread + bw.z*age,
          );
        }
      } else {
        for (const sp of mists) {
          (sp.material as THREE.SpriteMaterial).opacity = 0;
          sp.visible = false;
        }
      }
    },
    setQuality(high: boolean): void {
      sprayOn = high;
      mistOn = high;
    },
    setShakeScale(s: number): void {
      shakeScale = Number.isFinite(s) ? Math.min(Math.max(s, 0), 1) : 1;
    },
    dispose(): void {
      for (const p of pings) {
        scene.remove(p.mesh);
        p.mat.dispose();
      }
      ringGeo.dispose();
      scene.remove(spray);
      sprayGeo.dispose();
      sprayMat.dispose();
      for (const sp of mists) {
        scene.remove(sp);
        (sp.material as THREE.SpriteMaterial).dispose();
      }
      mistTex.dispose();
      splashAtlas?.dispose();for(const tex of splashFrames)tex.dispose();
      feather?.dispose();
      for (const r of [left, right, wake,wakeRight]) {
        scene.remove(r.mesh);
        r.mesh.geometry.dispose();
        (r.mesh.material as THREE.Material).dispose();
        r.count = 0;
      }
      shake.x = 0;
      shake.y = 0;
      shake.z = 0;
      trauma = 0;
      sway = 0;
    },
  };
}
