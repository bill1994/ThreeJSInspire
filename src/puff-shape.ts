/**
 * src/puff-shape.ts — 近景云簇的几何：一朵云 = 竖直主轴上 5~10 个大瓣 + 若干肩瓣，
 * 合并成一个 mesh。
 *
 * 形状取自参考图实测（`artifacts/cloud-audit/ref_probe.py`），不是凭手感：
 * 单瓣直径占云宽 0.6~0.8、轮廓是 5~6 段浅圆弧、整朵只有 4~6 个平涂色阶。
 * 比例全部集中在 `PUFF_SHAPE` 里，改"银行还是柱子"只动 `aspect` 一个数。
 */

import * as THREE from 'three';

/** 确定性 RNG：布局和造型可测同值 debug 可复现。 */
export function mulberry32(seed: number): () => number {
  let a = Math.imul(Math.floor(seed) || 1, 0x6d2b79f5) >>> 0;
  return () => {
    a = (Math.imul(a ^ (a >>> 15), a | 1) >>> 0) + 0x6d2b79f5;
    let t = Math.imul(a ^ (a >>> 7), a | 61) ^ a;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
    parts.push(g);
  }
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error('[puff] mergeGeometries returned null');

  // Centre on the cloud's own middle so the fragment-stage "radial" (from positionLocal)
  // means what it says.
  merged.center();

  const mPos = merged.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(mPos.count * 3);
  for (let k = 0; k < mPos.count; k += 1) {
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
