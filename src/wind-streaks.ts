/**
 * src/wind-streaks.ts — P0-4 3D 风絮粒子（Q3-1，速度感主力）。
 *
 * 后期放射速度线已删（ref-02: 过密、过硬、横穿飞机），替代品是真 3D 视差：
 * 相机前方 40m 盒子里 200 个 pooled 点，以 -(forward * speed * 0.6) 往后拉，
 * 透明度 ∝ speed01。只在画面边缘 30% 可见、中心留空——视差只许出现在余光里。
 *
 * 零分配：固定 Float32Array + seeded PRNG（stars.ts 同款 capture 契约）；
 * 一 draw call；depthTest 开着所以永远不横穿飞机和云。
 */
import * as THREE from 'three';

/** Pooled streak count — one draw call, trivial for any tier. */
export const WIND_STREAKS = 200;
/**
 * P2-4 低档裁剪：low tier 只画前 100（drawRange）。200 点本就一个 draw call，
 * 裁的是弱 GPU 的顶点+片元，不是调用次数——对称恢复，高档不受影响。
 */
export const WIND_STREAKS_LOW = 100;
/** Box depth ahead of the camera in metres. */
export const STREAK_DEPTH = 40;
/** Slip factor: streaks stream back at 0.6x the airspeed (camera adds the rest). */
export const STREAK_SLIP = 0.6;
/** Global opacity scale; the material reads STREAK_OPACITY * speed01. */
export const STREAK_OPACITY = 0.65;
/** Half-width of the box at unit depth (≈ tan 30°, matches the 60° cruise FOV). */
export const STREAK_SPREAD = 0.55;
/** Inner edge of the visible band in 0..1 (centre 70% stays hollow). */
export const STREAK_INNER = 0.7;
/** Recycle once this close to (or behind) the camera plane. */
export const STREAK_NEAR = 1;

/** Fixed seed — reproducibility is a capture-protocol contract, not a style choice. */
const STREAK_SEED = 20261111;
const smooth=(lo:number,hi:number,v:number):number=>{const t=Math.max(0,Math.min(1,(v-lo)/(hi-lo)));return t*t*(3-2*t);};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface StreakInput {
  right?: {x:number;y:number;z:number};
  up?: {x:number;y:number;z:number};
  halfHeight?:number;
  aspect?:number;
  daylight01?:number;
  cloud01?:number;
  origin: { x: number; y: number; z: number };
  forward: { x: number; y: number; z: number };
  speed: number;
  speed01: number;
}

interface Basis {
  right: { x: number; y: number; z: number };
  up: { x: number; y: number; z: number };
}

const _rel = { x: 0, y: 0, z: 0 };

/** Camera-space edge metric 0..1 for a world offset; needs a normalised forward. */
export function streakEdge(rel: { x: number; y: number; z: number }, fwd: { x: number; y: number; z: number }, basis: Basis): number {
  const zc = rel.x * fwd.x + rel.y * fwd.y + rel.z * fwd.z;
  if (zc <= 0) return 2; // behind the camera: always "outside", recycle it
  const xc = rel.x * basis.right.x + rel.y * basis.right.y + rel.z * basis.right.z;
  const yc = rel.x * basis.up.x + rel.y * basis.up.y + rel.z * basis.up.z;
  return Math.max(Math.abs(xc), Math.abs(yc)) / (zc * STREAK_SPREAD);
}

export function streakBasis(fwd: { x: number; y: number; z: number }): Basis {
  // right = fwd × worldUp = (fz, 0, -fx); degenerate only for a straight-up
  // nose, which the pitch clamp (-MAX_PITCH..) never reaches — guard anyway.
  const right = { x: fwd.z, y: 0, z: -fwd.x };
  const rl = Math.hypot(right.x, right.z) || 1;
  right.x /= rl;
  right.z /= rl;
  // up = right × fwd.
  const up = {
    x: right.y * fwd.z - right.z * fwd.y,
    y: right.z * fwd.x - right.x * fwd.z,
    z: right.x * fwd.y - right.y * fwd.x,
  };
  return { right, up };
}

export function initStreaks(scene: THREE.Scene, refined=false): {
  update(dt: number, input: StreakInput): void;
  setQuality(high: boolean): void;
  dispose(): void;
} {
  const rand = mulberry32(STREAK_SEED);
  const positions = new Float32Array(WIND_STREAKS * 3);
  const colors=new Float32Array(WIND_STREAKS*4);
  const ages=new Float32Array(WIND_STREAKS);
  let spreadY=STREAK_SPREAD,aspect=1;

  const place = (i: number, origin: StreakInput['origin'], fwd: StreakInput['forward'], basis: Basis, near: number, far: number): void => {
    const depth = near + rand() * (far - near);
    // Edge band only: the centre 70% stays hollow. Rejection-sample, then push
    // out along the dominant axis as an exact fallback (no loop that can spin).
    let ex = rand() * 2 - 1;
    let ey = rand() * 2 - 1;
    if (Math.max(Math.abs(ex), Math.abs(ey)) < STREAK_INNER) {
      const m = Math.max(Math.abs(ex), Math.abs(ey), 1e-6);
      const band = STREAK_INNER + rand() * (1 - STREAK_INNER);
      ex = (ex / m) * band;
      ey = (ey / m) * band;
    }
    const spread = depth * spreadY;
    ex*=aspect;
    positions[i * 3] =
      origin.x + fwd.x * depth + basis.right.x * ex * spread + basis.up.x * ey * spread;
    positions[i * 3 + 1] =
      origin.y + fwd.y * depth + basis.right.y * ex * spread + basis.up.y * ey * spread;
    positions[i * 3 + 2] =
      origin.z + fwd.z * depth + basis.right.z * ex * spread + basis.up.z * ey * spread;
    ages[i]=0;
  };

  // Initial fill needs a basis — identity look (-z) until the first update lands.
  const idFwd = { x: 0, y: 0, z: -1 };
  const idBasis = streakBasis(idFwd);
  const idOrigin = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < WIND_STREAKS; i += 1) place(i, idOrigin, idFwd, idBasis, 2, STREAK_DEPTH);

  const geometry = new THREE.BufferGeometry();
  const attr = new THREE.BufferAttribute(positions, 3);
  attr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', attr);
  const colorAttr=new THREE.BufferAttribute(colors,4);colorAttr.setUsage(THREE.DynamicDrawUsage);
  if(refined)geometry.setAttribute('color',colorAttr);
  // 出厂 = 高档全画；低档由 setQuality 切 drawRange（P2-4）。
  geometry.setDrawRange(0, WIND_STREAKS);
  const material = new THREE.PointsMaterial({
    size: refined?0.18:0.35,
    sizeAttenuation: true,
    color: '#dfe8f2',
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
  });
  let softMap:THREE.DataTexture|null=null;
  if(refined){
    const data=new Uint8Array(16*16*4);
    for(let y=0;y<16;y++)for(let x=0;x<16;x++){
      const r2=((x-7.5)/7.5)**2+((y-7.5)/7.5)**2;
      data.set([255,255,255,Math.round(255*Math.max(0,1-r2)**2)],(y*16+x)*4);
    }
    softMap=new THREE.DataTexture(data,16,16);softMap.needsUpdate=true;softMap.magFilter=THREE.LinearFilter;
    material.map=softMap;material.vertexColors=true;
  }
  const points = new THREE.Points(geometry, material);
  points.name = 'porco_streaks';
  points.frustumCulled = false;
  scene.add(points);

  return {
    /**
     * P2-4: low tier halves the drawn streaks (vertex+fragment saving on weak
     * GPUs — the call was already one). Symmetric: high restores the full pool.
     */
    setQuality(high: boolean): void {
      geometry.setDrawRange(0, high ? WIND_STREAKS : WIND_STREAKS_LOW);
    },
    update(dt: number, input: StreakInput): void {
      const d = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
      const fwd = input.forward;
      const fl = Math.hypot(fwd.x, fwd.y, fwd.z) || 1;
      const fn = { x: fwd.x / fl, y: fwd.y / fl, z: fwd.z / fl };
      const basis = refined&&input.right&&input.up ? {right:input.right,up:input.up} : streakBasis(fn);
      if(refined){spreadY=input.halfHeight??STREAK_SPREAD;aspect=input.aspect??1;}
      const speed = Number.isFinite(input.speed) ? Math.max(input.speed, 0) : 0;
      const back = speed * STREAK_SLIP * d;
      const o = input.origin;
      for (let i = 0; i < WIND_STREAKS; i += 1) {
        const i3 = i * 3;
        // Stream backward in world space; the camera's own motion adds the rest.
        positions[i3] -= fn.x * back;
        positions[i3 + 1] -= fn.y * back;
        positions[i3 + 2] -= fn.z * back;
        _rel.x = positions[i3] - o.x;
        _rel.y = positions[i3 + 1] - o.y;
        _rel.z = positions[i3 + 2] - o.z;
        const zc = _rel.x * fn.x + _rel.y * fn.y + _rel.z * fn.z;
        if (zc < STREAK_NEAR || zc > STREAK_DEPTH + 5) {
          place(i, o, fn, basis, STREAK_DEPTH - 10, STREAK_DEPTH);
        }
        if(refined){
          ages[i]+=d;
          const rx=positions[i3]-o.x,ry=positions[i3+1]-o.y,rz=positions[i3+2]-o.z;
          const depth=rx*fn.x+ry*fn.y+rz*fn.z;
          const edge=Math.max(Math.abs(rx*basis.right.x+ry*basis.right.y+rz*basis.right.z)/aspect,
            Math.abs(rx*basis.up.x+ry*basis.up.y+rz*basis.up.z))/Math.max(depth*spreadY,.001);
          const c=i*4;colors[c]=1;colors[c+1]=1;colors[c+2]=1;
          colors[c+3]=smooth(.70,.86,edge)*(1-smooth(1.05,1.3,edge))*smooth(1,6,depth)
            *(1-smooth(30,40,depth))*smooth(0,.18,ages[i]);
        }
      }
      attr.needsUpdate = true;
      const s01 = Number.isFinite(input.speed01) ? Math.min(Math.max(input.speed01, 0), 1) : 0;
      material.opacity = STREAK_OPACITY * s01;
      if(refined){
        colorAttr.needsUpdate=true;
        const day=Math.max(0,Math.min(1,input.daylight01??1));
        material.opacity=.28*Math.pow(s01,1.3)*(.35+.65*day)*(1-.9*Math.max(0,Math.min(1,input.cloud01??0)));
        material.color.setRGB(.65+.35*day,.78+.22*day,1);
      }
    },
    dispose(): void {
      scene.remove(points);
      geometry.dispose();
      material.dispose();
      softMap?.dispose();
    },
  };
}
