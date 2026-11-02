/**
 * src/puff-shape.ts — 近景云簇的几何：一朵云 = 竖直主轴上若干大瓣 + 若干肩瓣，合并成一个 mesh。
 *
 * 形状取自参考图实测（`artifacts/cloud-audit/ref_probe.py`），不是凭手感：
 * 单瓣直径占云宽 0.6~0.8、轮廓是 5~6 段浅圆弧、整朵只有 4~6 个平涂色阶。
 *
 * 参考图里两种体型同时占着画面——左边横摊的一坨、中间竖立的柱子——所以「高宽比」
 * 不是一个数，而是一组变体：`PUFF_VARIANTS`。四种变体共用同一套骨架代码，只换配方。
 */

import * as THREE from 'three';

/**
 * 每瓣一个常量的顶点属性名。分档在片元里算，这个属性只负责「这一瓣是谁」——
 * 没有它，逐瓣法线压平之后整簇会变成一块没有层次的色板（spec §8.1）。
 */
export const PUFF_LOBE_ATTRIBUTE = 'lobeShade';

/** 默认的二十面体细分级（LOD 的 L0 档）。 */
export const PUFF_DEFAULT_DETAIL = 2;

export type PuffVariantName = 'bank' | 'tower' | 'scraps' | 'leviathan';

export interface PuffVariant {
  /** 单朵云的世界宽度（米），缩放前。 */
  width: number;
  /** 高 / 宽。参考图左边那团 ≈ 1.0、中间那根柱子 ≈ 1.95。 */
  aspect: number;
  /** 单瓣直径 / 云宽。参考图实测 0.6~0.8。 */
  lobeDiameter: number;
  /** 主轴瓣占总数比：spine = round(n × spineFrac)，其余挂成肩瓣（菜花边）。 */
  spineFrac: number;
  /** 散布时抽中这个变体的相对权重。 */
  weight: number;
}

/**
 * 四种体型。数值是可调的起点，性格来自 spec §7：
 * - bank：横摊，最常见，主力；
 * - tower：竖立，地标，远看就知道那边有东西；
 * - scraps：矮小、贴海，做纵深；
 * - leviathan：体量远超其余，罕见，一片区域最多一个。
 */
export const PUFF_VARIANTS: Record<PuffVariantName, PuffVariant> = {
  bank: { width: 30, aspect: 0.85, lobeDiameter: 0.62, spineFrac: 0.6, weight: 5 },
  tower: { width: 22, aspect: 1.95, lobeDiameter: 0.62, spineFrac: 0.62, weight: 2 },
  scraps: { width: 24, aspect: 0.55, lobeDiameter: 0.62, spineFrac: 0.5, weight: 3 },
  leviathan: { width: 48, aspect: 1.15, lobeDiameter: 0.62, spineFrac: 0.6, weight: 1 },
};

export const PUFF_VARIANT_ORDER: readonly PuffVariantName[] = ['bank', 'tower', 'scraps', 'leviathan'];

/** 确定性 RNG：布局和造型可测同值 debug 可复现。 */
export function mulberry32(seed: number): () => number {
  let a = Math.imul(Math.floor(seed) || 1, 0x6d2b79f5) >>> 0;
  return () => {
    a = (Math.imul(a ^ (a >>> 15), a | 1) >>> 0) + 0x6d2b79f5;
    let t = Math.imul(a ^ (a >>> 7), a | 61) ^ a;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 稳定的 [0,1) 哈希，给逐瓣常量用；不占 RNG 序列，也不依赖调用顺序。 */
function hash01(n: number): number {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
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
  variant: PuffVariantName = 'bank',
  detail: number = PUFF_DEFAULT_DETAIL,
): Promise<THREE.BufferGeometry> {
  const { mergeGeometries } = await import('three/addons/utils/BufferGeometryUtils.js');
  const parts: THREE.BufferGeometry[] = [];
  const lobeShades: number[] = [];
  const lobeVertexCounts: number[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const v = new THREE.Vector3();
  const sc = new THREE.Vector3();

  const spec = PUFF_VARIANTS[variant] ?? PUFF_VARIANTS.bank;
  const d = Math.max(0, Math.min(3, Math.round(detail)));

  const halfW = spec.width / 2;
  const height = spec.width * spec.aspect;
  const halfH = height / 2;
  const lobeR = (spec.lobeDiameter * spec.width) / 2;

  /** 这一朵的瓣数：同一变体也各有各的胖瘦，别让玩家看出同一条曲线的平移。 */
  const n = Math.max(7, Math.round(9 + (rand() - 0.5) * 4));
  /** 主轴瓣：沿 Y 排列，中上部略胖。 */
  const spine = Math.max(3, Math.round(n * spec.spineFrac));
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
    parts.push(g);

    // 逐瓣常量：一半来自哈希（团与团的深浅差），一半来自高度（下面沉、上面亮）。
    // **量化成三档**——参考图整朵只有 4~6 个平涂色阶，逐瓣连续取值会把级数推上去，
    // 又回到「渐变气球」。三档 × 四段分档，观感和色阶数两头都站得住。
    const raw = (hash01(i + 1) - 0.5) * 1.6 + (lobe.y / halfH) * -0.35;
    lobeShades.push(Math.max(-1, Math.min(1, Math.round(raw))));
    lobeVertexCounts.push(g.attributes.position.count);
  }
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error('[puff] mergeGeometries returned null');

  // Centre on the cloud's own middle so the fragment-stage "radial" (from positionLocal)
  // means what it says.
  merged.center();

  // 逐瓣常量必须在合并之后按同样的拼接顺序摊回去——mergeGeometries 是顺序拼接。
  const mergedPos = merged.attributes.position as THREE.BufferAttribute;
  const shadeArr = new Float32Array(mergedPos.count);
  let offset = 0;
  for (let i = 0; i < lobeShades.length; i += 1) {
    const count = lobeVertexCounts[i];
    for (let k = 0; k < count; k += 1) shadeArr[offset + k] = lobeShades[i];
    offset += count;
  }
  merged.setAttribute(PUFF_LOBE_ATTRIBUTE, new THREE.BufferAttribute(shadeArr, 1));

  const colors = new Float32Array(mergedPos.count * 3);
  for (let k = 0; k < mergedPos.count; k += 1) {
    // 分档已挪进片元（colorNode 按 radial+normal 算），顶点色只留破平涂塑料感的
    // 极轻灰阶抖动——三通道同值，片元侧乘回去。
    const shade = 0.985 + rand() * 0.03;
    colors[k * 3] = shade;
    colors[k * 3 + 1] = shade;
    colors[k * 3 + 2] = shade;
  }
  merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  merged.computeBoundingSphere();
  return merged;
}
