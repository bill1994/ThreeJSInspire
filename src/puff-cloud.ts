/**
 * src/puff-cloud.ts — 近景同层云的材质与场景装配。
 *
 * 远景/顶层继续走 `clouds-compute.ts` 的 dome slab；身边飞过的云不用 slab
 * （slab 是远景穹顶做法，调不出单朵体积），也不用 billboard（billboard 永远
 * 朝向相机，侧看没视差、穿进去像纸片）。这里是真 3D：一朵云 = 竖直主轴上
 * 5~10 个大瓣 + 若干肩瓣，合并成一个 mesh。造型在 `puff-shape.ts`，散布在
 * `puff-field.ts`，本文件只管着色与装配。
 *
 * 风格锚点（和 dome 同一套，不许漂）：
 * - 配色只读 `CLOUD_PALETTE`：背光整块深紫、受光跳粉/金、云顶提奶白、肚皮压紫。
 *   太阳是静态日落（`SUN_DIRECTION` 单源），所以 toon 直接烘进顶点色运行时零
 *   光照计算，还天然双后端可跑。
 * - 分档纯函数可测（`puffBandIndex`），阈值单源 `PUFF_BAND_THRESHOLDS`。
 *
 * 可穿：不透明排序地狱的解法是片元级距离淡出（TSL opacityNode，和 dome
 * 同一写法，`three/tsl` 全后端编译）。相机钻进云芯时近处片元先淡到 0，
 * 远处 dome 的整屏 whiteout（`WHITEOUT_MAX`）正好接管，不穿帮。
 */

import * as THREE from 'three';

import { CLOUD_BAND } from './clouds-compute';
import { CLOUD_HAZE } from './horizon';
import { CLOUD_PALETTE, HAZE_COLOR, SKY_STOPS, SUN_DIRECTION } from './palettes';
import { PUFF_FADE_FAR, PUFF_FADE_NEAR, PUFF_SCATTER, puffScatter } from './puff-field';
import { FLIGHT } from './game';
import type { CloudBlob } from './in-cloud';
import {
  PUFF_DEFAULT_DETAIL,
  PUFF_LOBE_ATTRIBUTE,
  PUFF_VARIANT_ORDER,
  PUFF_VARIANTS,
  PuffVariantName,
  buildPuffGeometry,
  mulberry32,
} from './puff-shape';

/** 高/低档的云朵数。低档直接藏一半，不重建，和 dome 的 setQuality 同思路。 */
export const PUFF_COUNT_HIGH = 25;
export const PUFF_COUNT_LOW = 12;

export interface PuffHandle {
  readonly kind: 'puff';
  /** 每朵云的世界包围体，随环面回收实时变化——in-cloud 靠它算白雾。 */
  readonly blobs: readonly CloudBlob[];
  update(t: number, sunDir: THREE.Vector3): void;
  setQuality(high: boolean): void;
  dispose(): void;
}

const _sun = new THREE.Vector3(SUN_DIRECTION[0], SUN_DIRECTION[1], SUN_DIRECTION[2]).normalize();

/**
 * 分档阈值单源：`puffBandIndex`（JS 镜像/单测）与 `initPuffClouds` 的 TSL colorNode
 * 都读这一份。挪进片元着色后阈值漂移就是两边色阶对不上，所以必须导出钉住。
 */
export const PUFF_BAND_THRESHOLDS = [0.2, 0.5, 0.76] as const;

/**
 * 逐瓣法线的权重。原来是 0.28——那是「每颗球都有自己的亮面和暗底」的根源，
 * 十几个暗底叠成同心弧，整朵云读成一堆气球（spec §1）。压到 0.10 之后明暗
 * 主要来自云心 `radial`，而来它逐片元插值、和三角面无关。
 */
export const PUFF_NORMAL_WEIGHT = 0.1;

/** 逐瓣常量对分档的推动量。团与团之间的深浅差靠它，不靠团内渐变。 */
export const PUFF_LOBE_SHADE_GAIN = 0.18;

/** 环境光混入量：整体抬亮，保住背光面不塌成近黑（spec §8.1 环境填充）。 */
export const PUFF_AMBIENT_AMOUNT = 0.12;

/** 逆光边：`pow(1 - radial·toCamera, power) * gain`，只作用在最亮两档。 */
export const PUFF_RIM = { gain: 0.35, power: 2.5 } as const;

/**
 * 天空的玫瑰带，当作云的环境光颜色。**只读派生，不改 CLOUD_PALETTE**——
 * `CLOUD_PALETTE` 与 dome 共用，且 `palettes.test.ts` 锁着 base 与 skyTop 的
 * ΔL* ≥ 15（B5），动它就是拆 dome 的分离度。
 */
export function puffAmbientColor(): THREE.Color {
  return new THREE.Color(SKY_STOPS[1].color);
}

/**
 * 暗档在环境光之后的颜色——就是 `initPuffClouds` 里 band0 的落点，
 * 给单测钉住「抬亮了但没翻到 base 之上」。
 */
export function puffShadowBandColor(): THREE.Color {
  return new THREE.Color(CLOUD_PALETTE.shadow).lerp(puffAmbientColor(), PUFF_AMBIENT_AMOUNT);
}

/**
 * 把 wrap 光照系数分到 4 档平涂色阶，对应 `CLOUD_PALETTE` 的四色。
 *
 * **JS 镜像**：真正的分档现在跑在 `initPuffClouds` 的 TSL colorNode 里（逐片元算
 * radial+normal，终结线是曲面连续的——顶点色分档的硬边界只能沿三角面拓扑走，
 * 近距离出多边形色阶）。这个纯函数读同一份 `PUFF_BAND_THRESHOLDS`，给单测和
 * 调参对照用，与 `horizon.ts` / `sun-road.ts` 一个写法。
 */
export function puffBandIndex(sunW: number): 0 | 1 | 2 | 3 {
  if (!Number.isFinite(sunW)) return 0;
  const v = sunW < 0 ? 0 : sunW > 1 ? 1 : sunW;
  const [t0, t1, t2] = PUFF_BAND_THRESHOLDS;
  if (v < t0) return 0; // shadow：背光边缘（最窄——参考图里纯暗部不多）
  if (v < t1) return 1; // base：云体主色（最宽，云身主要落在这档）
  if (v < t2) return 2; // pink：受光侧
  return 3; // gold/奶白：向光面 + 云顶
}

/** 边界淡出的逐朵 uniform（far-field 每帧写它，0 = 已出窗口）。 */
interface EdgeFade {
  value: number;
}

/** 按权重抽一个变体：体量大的稀少，bank 是主力。 */
function pickVariant(rand: () => number): PuffVariantName {
  const total = PUFF_VARIANT_ORDER.reduce((sum, n) => sum + PUFF_VARIANTS[n].weight, 0);
  let r = rand() * total;
  for (const name of PUFF_VARIANT_ORDER) {
    r -= PUFF_VARIANTS[name].weight;
    if (r <= 0) return name;
  }
  return 'bank';
}

export async function initPuffClouds(
  scene: THREE.Scene,
  seed = 7,
  count: number = PUFF_COUNT_HIGH,
): Promise<PuffHandle> {
  const TSL = await import('three/tsl');
  const { MeshBasicNodeMaterial } = await import('three/webgpu');

  /**
   * 一朵云的材质。**每朵一份**——边界淡出是逐朵的 uniform，共用一份材质就写不了。
   * 着色图完全相同，three 只编译一个 program。
   */
  const makeMaterial = (edgeFade: EdgeFade) => {
    const material = new MeshBasicNodeMaterial();
    // vertexColors 只负责把 color 属性绑进着色器（TSL.vertexColor 才读得到）；
    // 实际的相乘只在下面的 colorNode 里显式做一次。
    material.vertexColors = true;
    material.transparent = true;
    material.depthWrite = true;
    // 透明片元不许写深度。opacityNode 把远处片元淡到 0，但它们仍按整片 puff 轮廓写深度，
    // 于是背后的云塔被挖出一个洞——挖洞的那片自己已经看不见了。alphaTest 让 NodeMaterial 在
    // a<=0.02 时直接 discard，深度不再留洞。
    material.alphaTest = 0.02;
    // DoubleSide：unlit 分档色不吃法线双面零代价；FrontSide 在机头钻进云里那一刻
    // 远端内壁全是背面被剔除 + 近端又被淡出整朵云当场隐形——这就是“没靠近就消失”。
    material.side = THREE.DoubleSide;
    material.fog = false;
    // 穿云不糊脸：近处片元先淡掉远处 dome 的 whiteout 再接管。
    const dist = TSL.length(TSL.cameraPosition.sub(TSL.positionWorld));
    material.opacityNode = TSL.smoothstep(
      TSL.float(PUFF_FADE_NEAR),
      TSL.float(PUFF_FADE_FAR),
      dist,
    )
      .mul(0.96)
      .mul(edgeFade as any);

    // 分档进片元：明暗主要来自云心 radial（逐片元插值，与三角面无关），逐瓣法线只剩
    // PUFF_NORMAL_WEIGHT 那一点点；团与团之间的深浅差由逐瓣常量 lobeShade 承担。
    const sunDir = TSL.vec3(_sun.x, _sun.y, _sun.z);
    const radial = TSL.normalize(TSL.positionLocal);
    const surface = TSL.normalLocal;
    const lobeShade = TSL.attribute(PUFF_LOBE_ATTRIBUTE, 'float');
    const lit = radial
      .dot(sunDir)
      .mul(1 - PUFF_NORMAL_WEIGHT)
      .add(surface.dot(sunDir).mul(PUFF_NORMAL_WEIGHT));
    const sunW = TSL.clamp(lit.mul(0.5).add(0.5).add(lobeShade.mul(PUFF_LOBE_SHADE_GAIN)), 0, 1);
    const [t0, t1, t2] = PUFF_BAND_THRESHOLDS;
    const b1 = TSL.step(t0, sunW);
    const b2 = TSL.step(t1, sunW);
    const b3 = TSL.step(t2, sunW);
    const shadowC = TSL.color(new THREE.Color(CLOUD_PALETTE.shadow));
    const baseC = TSL.color(new THREE.Color(CLOUD_PALETTE.base));
    const pinkC = TSL.color(new THREE.Color(CLOUD_PALETTE.pink));
    const goldC = TSL.color(new THREE.Color(CLOUD_PALETTE.gold));
    const creamC = TSL.color(new THREE.Color(0xfff6ea));
    let bandCol: any = TSL.mix(TSL.mix(TSL.mix(shadowC, baseC, b1), pinkC, b2), goldC, b3);
    // 肚皮：朝下的面往紫里压一档；输入是**云心** radial 的 y，不是逐瓣法线。
    const band = b1.add(b2).add(b3);
    const belly = TSL.clamp(radial.y.negate(), 0, 1);
    const bellyAmt = TSL.clamp(belly.sub(0.5).mul(1.6), 0, 1).mul(TSL.mix(0.3, 0.75, TSL.step(2, band)));
    bandCol = TSL.mix(bandCol, shadowC, bellyAmt);
    // 顶光：只有最亮那档往奶白提，云顶有个亮盖，云身不被冲白。
    bandCol = TSL.mix(bandCol, creamC, b3.mul(TSL.clamp(radial.y, 0, 1)).mul(0.45));
    // 环境光：整条色带一起往天空玫瑰带抬，背光面不再塌成近黑。
    const ambientC = TSL.color(puffAmbientColor());
    bandCol = TSL.mix(bandCol, ambientC, PUFF_AMBIENT_AMOUNT);
    // 逆光边：视线与云心 radial 越垂直越亮，只加在最亮两档上。
    const toCam = TSL.normalize(TSL.cameraPosition.sub(TSL.positionWorld));
    const rimBase = TSL.clamp(TSL.float(1).sub(radial.dot(toCam)), 0, 1);
    const rimAmt = TSL.pow(rimBase, TSL.float(PUFF_RIM.power)).mul(PUFF_RIM.gain);
    bandCol = TSL.mix(bandCol, goldC, rimAmt.mul(b2));
    // 空气透视：雾饱和距离必须小于半窗口（1000），越界跳变才藏在雾里。
    const hazeC = TSL.color(new THREE.Color(HAZE_COLOR));
    const hazeAmt = TSL.smoothstep(TSL.float(CLOUD_HAZE.NEAR), TSL.float(CLOUD_HAZE.FAR), dist).mul(
      CLOUD_HAZE.MAX,
    );
    material.colorNode = TSL.mix(bandCol.mul(TSL.vertexColor()), hazeC, hazeAmt);
    material.userData.edgeFade = edgeFade;
    return material;
  };

  const group = new THREE.Group();
  group.name = 'puff-field';
  // 先把几何全部造出来拿到真实 bbox，再按尺寸散点——y 带是从每朵云自己的 halfH 反解的，
  // 先散点后建模时尺寸根本还不存在。
  const rand = mulberry32(seed * 1000 + 11);
  const built: {
    geo: THREE.BufferGeometry;
    size: { halfW: number; halfH: number; s: number };
    variant: PuffVariantName;
  }[] = [];
  const band = FLIGHT.ALT_MAX - FLIGHT.ALT_MIN - PUFF_SCATTER.SEA_CLEAR - PUFF_SCATTER.BAND_MARGIN;
  for (let i = 0; i < count; i += 1) {
    const variant = pickVariant(rand);
    // eslint-disable-next-line no-await-in-loop
    const geo = await buildPuffGeometry(rand, variant, PUFF_DEFAULT_DETAIL);
    geo.computeBoundingBox();
    const box = new THREE.Vector3();
    geo.boundingBox!.getSize(box);
    // 缩放按竖直带反解上限：塞不进去的体量会压扁云底/云顶的净空感，压上限比硬夹好。
    const fitMax = band / Math.max(box.y, 1e-3);
    const s = Math.min(1.6 + rand() * 1.0, fitMax);
    built.push({ geo, size: { halfW: (box.x * 0.5) * s, halfH: (box.y * 0.5) * s, s }, variant });
  }
  const spots = puffScatter(seed, built.map((b) => b.size));
  // count 的语义是「目标数」不是「必须数」：净空剔除是剔除不是平移，少一朵可接受。
  const placed = Math.min(built.length, spots.length);
  const materials: THREE.Material[] = [];
  for (let i = 0; i < placed; i += 1) {
    const material = makeMaterial(TSL.uniform(1) as unknown as EdgeFade);
    materials.push(material);
    const mesh = new THREE.Mesh(built[i].geo, material);
    mesh.name = `puff-${String(i).padStart(2, '0')}`;
    mesh.userData.variant = built[i].variant;
    mesh.userData.blobSize = built[i].size;
    mesh.position.set(spots[i].x, spots[i].y, spots[i].z);
    mesh.scale.setScalar(spots[i].s);
    mesh.frustumCulled = true;
    group.add(mesh);
  }
  scene.add(group);

  let disposed = false;
  return {
    kind: 'puff',
    get blobs(): readonly CloudBlob[] {
      return group.children.map((child) => {
        const size = (child.userData.blobSize ?? { halfW: 1, halfH: 1 }) as { halfW: number; halfH: number };
        return {
          x: child.position.x,
          y: child.position.y,
          z: child.position.z,
          halfW: size.halfW,
          halfH: size.halfH,
        };
      });
    },
    update(): void {
      if (disposed) return;
      // 造型静态；位置由 far-field 的环面回收驱动。
    },
    setQuality(high: boolean): void {
      if (disposed) return;
      // 低档藏一半：不重建、不改程序，和 dome 的 setQuality 同策略。
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
      for (const m of materials) m.dispose();
    },
  };
}
