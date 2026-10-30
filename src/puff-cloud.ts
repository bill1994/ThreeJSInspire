/**
 * src/puff-cloud.ts — 近景同层云：大瓣球体堆叠 + 烘焙 toon，造型对标 ref-01。
 *
 * 远景/顶层继续走 `clouds-compute.ts` 的 dome slab；身边飞过的云不用 slab
 * （slab 是远景穹顶做法，调不出单朵体积），也不用 billboard（billboard 永远
 * 朝向相机，侧看没视差、穿进去像纸片）。这里是真 3D：一朵云 = 竖直主轴上
 * 5~10 个大瓣 + 若干肩瓣，合并成一个 mesh，14 朵共 14 个 draw call。
 *
 * 形状取自参考图实测（`artifacts/cloud-audit/ref_probe.py`），不是凭手感：
 * 单瓣直径占云宽 0.6~0.8、轮廓是 5~6 段浅圆弧、整朵只有 4~6 个平涂色阶。
 * 比例全部集中在 `PUFF_SHAPE` 里，改"银行还是柱子"只动 `aspect` 一个数。
 *
 * 风格锚点（和 dome 同一套，不许漂）：
 * - 配色只读 `CLOUD_PALETTE`：背光整块深紫、受光跳粉/金、云顶提奶白、肚皮压紫。
 *   太阳是静态日落（`SUN_DIRECTION` 单源），所以 toon 直接烘进顶点色运行时零
 *   光照计算，还天然双后端可跑。
 * - 三档分档（`puffBandIndex`，纯函数可测）：太阳仰角只有 6.97°，所以明暗
 *   分界线接近竖直——参考图那根云柱左亮右暗就是这个，不需要假法线。
 *
 * 可穿：不透明排序地狱的解法是片元级距离淡出（TSL opacityNode，和 dome
 * 同一写法，`three/tsl` 全后端编译）。相机钻进云芯时近处片元先淡到 0，
 * 远处 dome 的整屏 whiteout（`WHITEOUT_MAX`）正好接管，不穿帮。
 * wisp slab 当前不承担造型（评审 §8 逐层隔离已实测确认）。
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
const _base = new THREE.Color(CLOUD_PALETTE.base);
const _cream = new THREE.Color(0xfff6ea);
const _pink = new THREE.Color(CLOUD_PALETTE.pink);
const _gold = new THREE.Color(CLOUD_PALETTE.gold);

/**
 * 一朵云的骨架比例，取自 `ref-01-sunset-glide.png` 的实测，不是凭手感。
 *
 * 参考图里的云是**大瓣圆球的并集**：单瓣直径占云宽的 0.6~0.8，轮廓是 5~6 段浅
 * 圆弧串起来的菜花边，整朵只有 4~6 个平涂色阶、零高频细节。
 * 这跟老实现正好相反——老实现把 10~13 个小球沿 X 摊开、Y 压到 0.62、每球 80 个
 * 三角面，合出来是一块带棱面的横向土豆（详见评审 §7.2 / §8）。
 *
 * 实测数据（`artifacts/cloud-audit/ref_probe.py`）：
 * - 中央云柱 52×101 px → 高宽比 **1.95**
 * - 左侧云团高宽比 ≈ 1.0，6 个平涂色阶
 * - 云体均色 (124,75,141) 紫，受光侧到 255 的奶白/粉
 */
export const PUFF_SHAPE = {
  /** 单朵云的世界宽度（米），缩放前。 */
  width: 22,
  /**
   * 高 / 宽。参考图左边那团是 ~1.0、中间那根柱子是 ~1.95。
   * 默认 1.45 = 有垂直发育的积云，但不是"擎天柱"（spec 拍板：只要 bank＋碎棉花）。
   * 想改口到柱子就动这一个数。
   */
  aspect: 1.45,
  /** 单瓣直径 / 云宽。参考图实测 0.6~0.8。 */
  lobeDiameter: 0.62,
  /**
   * 每瓣的二十面体细分级。three 的细分是每面切 (detail+1)²：detail 1 → 80 面，
   * detail 2 → 180 面。1 在近距离能数出三角面（实拍确认过），2 在最近投影像素下
   * 边长已到 ~4 px 以下。14 朵 × 约 10 瓣 ≈ 5 万顶点，可以接受。
   */
  detail: 2,
} as const;

/**
 * 把 wrap 光照系数分到 4 档平涂色阶，对应 `CLOUD_PALETTE` 的四色。
 *
 * 三档不够用：参考图云体的平均色是 (124,75,141)，最接近 `base`（#7a5ba8），
 * 而不是 `shadow`（#4a3370）。只给 shadow/pink/gold 三档，云身就整块掉进最暗的
 * 紫里，实拍成了深紫团子。补回 `base` 当主体色，`shadow` 只留给背光边缘。
 *
 * 纯函数，给单测和 `bakeColor` 共用——和 `horizon.ts` / `sun-road.ts` / `toon.ts`
 * 一个写法，shader 常数和 JS 镜像不许各写一份。
 */
export function puffBandIndex(sunW: number): 0 | 1 | 2 | 3 {
  if (!Number.isFinite(sunW)) return 0;
  const v = sunW < 0 ? 0 : sunW > 1 ? 1 : sunW;
  if (v < 0.20) return 0; // shadow：背光边缘（最窄——参考图里纯暗部不多）
  if (v < 0.50) return 1; // base：云体主色（最宽，云身主要落在这档）
  if (v < 0.76) return 2; // pink：受光侧
  return 3; // gold/奶白：向光面 + 云顶
}

/**
 * Ghibli 烘焙：三档平涂 + 肚皮压紫 + 顶光提奶白。
 *
 * 关键在 `radial` 那一项。**逐顶点法线着色会让每一个瓣各长一道明暗分界**，一整
 * 朵云就变成十几道亮月牙夹着深折痕——实拍里读成"一串珠子"而不是一朵云。
 * 参考图的整朵云只有**一道**分界线，所以这里按「从云心指向该顶点的方向」着色：
 * 太阳侧的顶点无论自己朝哪都判为受光，整团共享一个终结线；再掺 28% 的表面法线，
 * 让分界不完全是一根直线。
 *
 * 太阳仰角只有 6.97°，radial 的 y 权重很小，所以分界线接近竖直——正是参考图
 * 中间那根云柱左亮右暗的成因，不需要假法线。
 */
function bakeColor(
  px: number,
  py: number,
  pz: number,
  nx: number,
  ny: number,
  nz: number,
  out: THREE.Color,
): THREE.Color {
  const len = Math.hypot(px, py, pz) || 1;
  const radial = ((px / len) * _sun.x + (py / len) * _sun.y + (pz / len) * _sun.z);
  const surface = nx * _sun.x + ny * _sun.y + nz * _sun.z;
  const lit = radial * 0.72 + surface * 0.28;
  const sunW = THREE.MathUtils.clamp(lit * 0.5 + 0.5, 0, 1);
  const band = puffBandIndex(sunW);

  if (band === 0) out.copy(_shadow);
  else if (band === 1) out.copy(_base);
  else if (band === 2) out.copy(_pink);
  else out.copy(_gold);

  // 肚皮：朝下的面再往紫里压一档。参考图的云底和背光侧同一个紫，不是另一个色相。
  const belly = THREE.MathUtils.clamp(-ny, 0, 1);
  if (belly > 0.5) {
    const amt = Math.min(1, (belly - 0.5) * 1.6) * (band <= 1 ? 0.3 : 0.75);
    out.lerp(_shadow, amt);
  }

  // 顶光：只有最亮那档往奶白提，云顶有个亮盖，云身不被冲白。
  if (band === 3) out.lerp(_cream, THREE.MathUtils.clamp(ny, 0, 1) * 0.45);
  return out;
}

/**
 * 一朵云：**竖直方向的大瓣堆叠**，不是沿 X 摊开的葡萄串。
 *
 * 结构：一条竖直主轴放 `spine` 个大瓣（半径随高度轻微胀缩，参考图的云柱在中上部
 * 最胖），再从主轴两侧挂 `flanks` 个半尺寸的肩瓣——菜花边就是这些肩瓣撑出来的。
 * 相邻主轴瓣的间距小于半径，所以并集是连续的、只有浅弧度的起伏，正面看不到接缝。
 *
 * 同一个种子出同一朵云（位移只看局部位置，非索引几何也不会裂）。
 */
export async function buildPuffGeometry(
  rand: () => number,
  blobCount = 9,
  detail: number = PUFF_SHAPE.detail,
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
  const d = Math.max(0, Math.min(3, Math.round(detail)));

  const halfW = PUFF_SHAPE.width / 2;
  const height = PUFF_SHAPE.width * PUFF_SHAPE.aspect;
  const halfH = height / 2;
  const lobeR = (PUFF_SHAPE.lobeDiameter * PUFF_SHAPE.width) / 2;

  /** 主轴瓣：沿 Y 排列，中上部略胖。 */
  const spine = Math.max(3, Math.round(n * 0.6));
  /** 肩瓣：挂在主轴两侧，撑出菜花边。 */
  const flanks = Math.max(1, n - spine);
  const step = Math.max(lobeR * 0.55, (height - lobeR * 2) / Math.max(1, spine - 1));

  const lobes: { x: number; y: number; z: number; r: number }[] = [];
  for (let i = 0; i < spine; i += 1) {
    const u = spine === 1 ? 0.5 : i / (spine - 1);
    // 胀缩剖面：u=0（云底）0.86，u≈0.6 最胖 1.10，云顶回落到 ~0.9
    const swell = 0.86 + 0.24 * Math.sin(Math.PI * Math.pow(u, 0.8));
    lobes.push({
      x: (rand() - 0.5) * lobeR * 0.7,
      y: -halfH + lobeR + i * step + (rand() - 0.5) * step * 0.22,
      z: (rand() - 0.5) * lobeR * 0.9,
      r: lobeR * swell * (0.92 + rand() * 0.16),
    });
  }
  for (let i = 0; i < flanks; i += 1) {
    const u = (i + 0.5) / flanks;
    const side = rand() < 0.5 ? -1 : 1;
    lobes.push({
      x: side * halfW * (0.40 + rand() * 0.28),
      y: -halfH * 0.78 + u * height * 0.82 + (rand() - 0.5) * height * 0.16,
      z: (rand() - 0.5) * halfW * 0.5,
      r: lobeR * (0.52 + rand() * 0.26),
    });
  }

  for (let i = 0; i < lobes.length; i += 1) {
    const lobe = lobes[i];
    const g = new THREE.IcosahedronGeometry(lobe.r, d);
    // 确定性絮状：位移只看局部位置（同位置同值，非索引也不裂）。
    const pos = g.attributes.position as THREE.BufferAttribute;
    const nor = g.attributes.normal as THREE.BufferAttribute;
    for (let k = 0; k < pos.count; k += 1) {
      const px = pos.getX(k);
      const py = pos.getY(k);
      const pz = pos.getZ(k);
      const lump =
        1 +
        0.10 * Math.sin(px * 0.55 + i * 2.3) * Math.sin(py * 0.75 + i) * Math.sin(pz * 0.62 + i * 0.7);
      pos.setXYZ(k, px * lump, py * lump, pz * lump);
    }
    // 圆瓣：不再压 Y。旧的 0.62 把每瓣拍成扁饼，是"葡萄感"的来源之一。
    e.set(rand() * 0.3 - 0.15, rand() * Math.PI * 2, rand() * 0.3 - 0.15);
    q.setFromEuler(e);
    v.set(lobe.x, lobe.y, lobe.z);
    sc.set(0.94 + rand() * 0.14, 0.94 + rand() * 0.14, 0.94 + rand() * 0.14);
    m.compose(v, q, sc);
    g.applyMatrix4(m);
    // Colour comes after the merge — see bakeColor: it needs the direction from the
    // cloud's centre, which does not exist until all lobes are one geometry.
    parts.push(g);
  }
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error('[puff] mergeGeometries returned null');

  // Centre on the cloud's own middle so "radial" in bakeColor means what it says.
  merged.center();

  const mPos = merged.attributes.position as THREE.BufferAttribute;
  const mNor = merged.attributes.normal as THREE.BufferAttribute;
  const colors = new Float32Array(mPos.count * 3);
  for (let k = 0; k < mPos.count; k += 1) {
    bakeColor(
      mPos.getX(k),
      mPos.getY(k),
      mPos.getZ(k),
      mNor.getX(k),
      mNor.getY(k),
      mNor.getZ(k),
      col,
    );
    const shade = 0.985 + rand() * 0.03; // 极轻抖动，只是破掉完美平涂的塑料感
    colors[k * 3] = Math.min(1, col.r * shade);
    colors[k * 3 + 1] = Math.min(1, col.g * shade);
    colors[k * 3 + 2] = Math.min(1, col.b * shade);
  }
  merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));

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
    const geo = await buildPuffGeometry(rand, 10 + Math.floor(rand() * 4), PUFF_SHAPE.detail);
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
