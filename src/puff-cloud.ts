/**
 * src/puff-cloud.ts — 近景同层碎棉花：mesh 球体簇 + 烘焙 toon。
 *
 * 远景/顶层继续走 `clouds-compute.ts` 的 dome slab；身边飞过的碎云不用 slab
 * （slab 是远景穹顶做法，调不出单朵体积），也不用 billboard（billboard 永远
 * 朝向相机，侧看没视差、穿进去像纸片）。这里是真 3D：一朵云 = 8~11 个
 * Icosahedron 合并成一个 mesh，14 朵共 14 个 draw call，三角面 1 万出头。
 *
 * 风格锚点（和 dome 同一套，不许漂）：
 * - 配色只读 `CLOUD_PALETTE`暖白顶 / 粉背光 / 金向光 / 紫肚皮。太阳是静态
 *   日落（`SUN_DIRECTION` 单源），所以 toon 直接烘进顶点色运行时零光照计算，
 *   还天然双后端可跑。顶部永远亮、只有朝下的面才压紫（Ghibli 画法）。
 * - 双轴分档：wrap 光照轴 + 肚皮 AO 轴，近看不断层、远看和 dome 同构。
 *
 * 可穿：不透明排序地狱的解法是片元级距离淡出（TSL opacityNode，和 dome
 * 同一写法，`three/tsl` 全后端编译）。相机钻进云芯时近处片元先淡到 0，
 * 远处 dome wisp 层的整屏 whiteout（`WHITEOUT_MAX`）正好接管，不穿帮。
 * wisp slab 保留——它现在退化成雾气/whiteout 载体，不再承担造型。
 */

import * as THREE from 'three';

import { CLOUD_PALETTE, SUN_DIRECTION } from './palettes';

/** 高/低档的云朵数。低档直接藏一半，不重建，和 dome 的 setQuality 同思路。 */
export const PUFF_COUNT_HIGH = 14;
export const PUFF_COUNT_LOW = 7;
/** 回收走廊：飞机沿 -Z 飞，身后 +BEHIND 的云搬回前方 -DEPTH 处。 */
export const PUFF_FIELD_DEPTH = 1000;
export const PUFF_BEHIND_MARGIN = 120;
/**
 * TSL 距离淡出：3m 内全透（钻进去不糊脸）12m 外全显。
 *
 * 之前是 8~30m：云本身才 30m 宽，老远就开始透整朵没了看着像“没靠近就消失”。
 * 淡出带必须远小于云体半径穿云才成立。
 */
export const PUFF_FADE_NEAR = 3;
export const PUFF_FADE_FAR = 12;
/**
 * 布局走廊：x ±130m（竖屏横向 FOV 窄±200 全飞出画外了）
 * y 38~75m（wisp 带正中间巡航 60m 一头撞上）。
 *
 * 之前半径才 14~26m：在 160m 外只有几个像素参考图里是几百米的塔云。
 * 现在 blob 9~18m + 整朵 scale 1.6~2.6 → 半径 45~70m150m 外占竖向 FOV 约 1/3。
 */
export const PUFF_X_SPAN = 130;
export const PUFF_Y_MIN = 38;
export const PUFF_Y_MAX = 75;

export interface PuffHandle {
  readonly kind: 'puff';
  update(t: number, sunDir: THREE.Vector3): void;
  setQuality(high: boolean): void;
  dispose(): void;
}

/** 确定性 RNG：布局和造型可测同值 debug 可复现。 */
export function mulberry32(seed: number): () => number {
  let a = Math.imul(Math.floor(seed) || 1, 0x6d2b79f5) >>> 0;
  return () => {
    a = (Math.imul(a ^ (a >>> 15), a | 1) >>> 0) + 0x6d2b79f5;
    let t = Math.imul(a ^ (a >>> 7), a | 61) ^ a;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PuffSpot {
  x: number;
  y: number;
  z: number;
  /** 整朵的体量缩放 0.8~1.4。 */
  s: number;
}

/** 同种子同布局；前半铺出生点前方 80~350m 近带（竖屏一眼能见）后半撒满走廊。 */
export function puffLayout(seed: number, count: number): PuffSpot[] {
  const rand = mulberry32(seed);
  const spots: PuffSpot[] = [];
  for (let i = 0; i < count; i += 1) {
    let x: number;
    let z: number;
    if (i < Math.ceil(count / 2)) {
      x = (rand() * 2 - 1) * 70; // 近带收窄：竖屏横向 FOV 窄±130 全飞出画外
      z = -(80 + rand() * 270);
    } else {
      x = (rand() * 2 - 1) * PUFF_X_SPAN;
      z = -rand() * PUFF_FIELD_DEPTH;
    }
    const y = PUFF_Y_MIN + rand() * (PUFF_Y_MAX - PUFF_Y_MIN);
    // 出生点走廊：飞机在原点出生自带一段净空，别开局就糊一脸。
    if (Math.abs(x) < 45 && Math.abs(z) < 150) z -= 150;
    spots.push({ x, y, z, s: 1.6 + rand() * 1.0 });
  }
  return spots;
}

/**
 * 回收：云被甩到身后就搬回前面。纯函数给单测和 far-field 共用；
 * 非有限输入直接回原值不炸帧循环。
 *
 * 直接取模进走廊（一步到位）：之前的 guard-8 循环在大偏移下一帧跳 8000m，
 * 会越过 1000m 走廊来回乒乓，云就被甩到几公里外再也回不来。
 */
export function wrapPuffZ(
  z: number,
  planeZ: number,
  depth: number = PUFF_FIELD_DEPTH,
  behind: number = PUFF_BEHIND_MARGIN,
): number {
  if (!Number.isFinite(z) || !Number.isFinite(planeZ)) return z;
  const d = Number.isFinite(depth) && depth > 0 ? depth : PUFF_FIELD_DEPTH;
  const b = Number.isFinite(behind) && behind >= 0 ? behind : PUFF_BEHIND_MARGIN;
  const lo = planeZ - d + b; // 走廊前端（含），长度 d
  let rel = (z - lo) % d;
  if (rel < 0) rel += d;
  return lo + rel;
}

/**
 * CPU 版距离淡出的 JS 镜像（shader 里是同一条 smoothstep），单测钉住它；
 * 非有限距离按全显处理不挡画面。
 */
export function fadeForDistance(
  d: number,
  near: number = PUFF_FADE_NEAR,
  far: number = PUFF_FADE_FAR,
): number {
  if (!Number.isFinite(d)) return 1;
  if (!(near < far)) return 1;
  if (d <= near) return 0;
  if (d >= far) return 1;
  const t = (d - near) / (far - near);
  return t * t * (3 - 2 * t);
}

const _sun = new THREE.Vector3(SUN_DIRECTION[0], SUN_DIRECTION[1], SUN_DIRECTION[2]).normalize();
const _shadow = new THREE.Color(CLOUD_PALETTE.shadow);
const _white = new THREE.Color(0xfff6ea);
const _pink = new THREE.Color(CLOUD_PALETTE.pink);
const _gold = new THREE.Color(CLOUD_PALETTE.gold);

/**
 * Ghibli 烘焙：顶部永远亮（逆光也是粉白）只有肚皮压紫。
 * 裸 NdotL 分档会让逆光面整片掉进 shadow近黑——截图里云坨发黑就是它。
 * 两条独立轴：sunW（wrap 光照向光染金 ↔ 背光染粉都不掉黑）
 * belly（朝下程度底部才往紫里压）。
 */
function bakeColor(nx: number, ny: number, nz: number, out: THREE.Color): THREE.Color {
  const ndl = nx * _sun.x + ny * _sun.y + nz * _sun.z;
  const sunW = THREE.MathUtils.clamp(ndl * 0.5 + 0.5, 0, 1);
  const sunBand = Math.min(2, Math.floor(sunW * 3)) / 2; // 0 / 0.5 / 1
  const bellyBand = Math.min(2, Math.floor(THREE.MathUtils.clamp(-ny, 0, 1) * 3)) / 2;
  out.copy(_white);
  out.lerp(_pink, (1 - sunBand) * 0.55); // 背光面染粉不掉黑
  out.lerp(_gold, sunBand * sunBand * 0.65); // 向光面染金
  out.lerp(_white, THREE.MathUtils.clamp(ny, 0, 1) * 0.35 * sunBand); // 顶部加亮
  out.lerp(_shadow, bellyBand * 0.8); // 只有肚皮压紫
  return out;
}

/**
 * 一朵云：8~11 个挤扁的球沿 X 拉长、Y 压扁，葡萄感就死在这一步。
 * 同位置复用同位移（sin 哈希只看位置）非索引几何也不会裂。
 */
export async function buildPuffGeometry(
  rand: () => number,
  blobCount = 9,
  detail = 1,
): Promise<THREE.BufferGeometry> {
  const { mergeGeometries } = await import('three/addons/utils/BufferGeometryUtils.js');
  const parts: THREE.BufferGeometry[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const v = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const col = new THREE.Color();

  const n = Math.max(5, Math.min(16, Math.round(blobCount)));
  for (let i = 0; i < n; i += 1) {
    const t = n === 1 ? 0 : i / (n - 1) - 0.5; // -0.5..0.5 沿 X 铺
    const cx = t * (26 + rand() * 14);
    const cy = (rand() - 0.45) * 7;
    const cz = (rand() - 0.5) * 14;
    const r = 9 + rand() * 9;
    const g = new THREE.IcosahedronGeometry(r, detail);
    // 确定性絮状：位移只看局部位置（同位置同值，非索引也不裂）
    // 摆放交给下面的矩阵；这里只加形变不加位移。
    const pos = g.attributes.position as THREE.BufferAttribute;
    const nor = g.attributes.normal as THREE.BufferAttribute;
    for (let k = 0; k < pos.count; k += 1) {
      const px = pos.getX(k);
      const py = pos.getY(k);
      const pz = pos.getZ(k);
      const lump =
        1 +
        0.14 * Math.sin(px * 0.55 + i * 2.3) * Math.sin(py * 0.75 + i) * Math.sin(pz * 0.62 + i * 0.7);
      pos.setXYZ(k, px * lump, py * lump, pz * lump);
    }
    e.set(rand() * 0.6 - 0.3, rand() * Math.PI * 2, rand() * 0.6 - 0.3);
    q.setFromEuler(e);
    v.set(cx, cy, cz);
    sc.set(1.15 + rand() * 0.35, 0.62 + rand() * 0.3, 0.9 + rand() * 0.35);
    m.compose(v, q, sc);
    g.applyMatrix4(m);
    // 烘焙顶点色：法线已经过 applyMatrix4 修正直接用。
    const colors = new Float32Array(pos.count * 3);
    for (let k = 0; k < pos.count; k += 1) {
      bakeColor(nor.getX(k), nor.getY(k), nor.getZ(k), col);
      const shade = 0.94 + rand() * 0.1; // 轻微每点抖动破完美渐变
      colors[k * 3] = Math.min(1, col.r * shade);
      colors[k * 3 + 1] = Math.min(1, col.g * shade);
      colors[k * 3 + 2] = Math.min(1, col.b * shade);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    // 合并要求属性一致：Icosahedron 自带 position/normal/uv + 刚加的 color。
    parts.push(g);
  }
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error('[puff] mergeGeometries returned null');
  merged.computeBoundingSphere();
  return merged;
}

export async function initPuffClouds(
  scene: THREE.Scene,
  seed = 7,
  count: number = PUFF_COUNT_HIGH,
): Promise<PuffHandle> {
  const TSL = await import('three/tsl');
  const { MeshBasicNodeMaterial } = await import('three/webgpu');

  const material = new MeshBasicNodeMaterial();
  material.vertexColors = true;
  material.transparent = true;
  material.depthWrite = true;
  // DoubleSide：unlit 烘焙色不吃法线双面零代价；FrontSide 在机头钻进云里那一刻
  // 远端内壁全是背面被剔除 + 近端又被淡出整朵云当场隐形——这就是“没靠近就消失”。
  material.side = THREE.DoubleSide;
  material.fog = false;
  // 穿云不糊脸：近处片元先淡掉远处 dome wisp 的 whiteout 再接管。
  // 和 clouds-compute 同一写法（cameraPosition/positionWorld）全后端可编译。
  const dist = TSL.length(TSL.cameraPosition.sub(TSL.positionWorld));
  material.opacityNode = TSL.smoothstep(
    TSL.float(PUFF_FADE_NEAR),
    TSL.float(PUFF_FADE_FAR),
    dist,
  ).mul(0.96);

  const group = new THREE.Group();
  group.name = 'puff-field';
  const spots = puffLayout(seed, count);
  const rand = mulberry32(seed * 1000 + 11);
  for (let i = 0; i < spots.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const geo = await buildPuffGeometry(rand, 10 + Math.floor(rand() * 4), 1);
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = `puff-${String(i).padStart(2, '0')}`;
    mesh.position.set(spots[i].x, spots[i].y, spots[i].z);
    mesh.scale.setScalar(spots[i].s);
    mesh.frustumCulled = true;
    group.add(mesh);
  }
  scene.add(group);

  let disposed = false;
  return {
    kind: 'puff',
    update(): void {
      if (disposed) return;
      // 静态造型 + TSL 距离淡出：位置不动法线烘焙才成立漂移交给远近步进。
    },
    setQuality(high: boolean): void {
      if (disposed) return;
      // 低档藏一半：不断程序不重建和 dome 的 setQuality 同策略。
      group.children.forEach((child, i) => {
        child.visible = high || i % 2 === 0;
      });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      scene.remove(group);
      group.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh) (mesh.geometry as THREE.BufferGeometry)?.dispose();
      });
      material.dispose();
    },
  };
}
