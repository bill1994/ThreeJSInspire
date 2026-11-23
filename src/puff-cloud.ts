import { puffScaleRole } from './cloud-composition';
import { HEADLIGHT, headlightFieldTsl, type HeadlightUniforms } from './headlight';
/**
 * src/puff-cloud.ts — 近景同层云的材质与场景装配。
 *
 * 身边飞过的云不用 slab（slab 是远景穹顶做法，调不出单朵体积），也不用 billboard
 * （billboard 永远朝向相机，侧看没视差、穿进去像纸片）。这里是真 3D：一朵云 =
 * 竖直主轴上 5~10 个大瓣 + 若干肩瓣，合并成一个 mesh。造型在 `puff-shape.ts`，
 * 散布在 `puff-field.ts`，本文件只管着色与装配。
 *
 * 2026-11-06（`rebuild/sea-dome-reset`）：穹顶云与海面一起删了，本模块现在是仓库里
 * 唯一的云。空气透视的 `PUFF_HAZE` 因此自带一份，不再向 `horizon.ts` 借穹顶的
 * `CLOUD_HAZE`。
 *
 * 风格锚点（吉卜力档）：
 * - 配色读 `PUFF_BAND_COLORS`（按渲染色反解的四档，见该常量注释）。
 * - 受光照影响：太阳方向是每帧 `update(t, sunDir)` 灌进来的 uniform，转太阳、
 *   色带跟着转；场景 DirectionalLight 请和同一份 sunDir 对齐。
 * - 分档纯函数可测（`puffBandIndex`），阈值单源 `PUFF_BAND_THRESHOLDS`。
 *
 * 可穿：不透明排序地狱的解法是片元级距离淡出（TSL opacityNode，`three/tsl` 全后端
 * 编译）。相机钻进云芯时近处片元先淡到 0，远处云的整屏 whiteout（`WHITEOUT_MAX`）
 * 正好接管，不穿帮。
 */

import * as THREE from 'three';

import { HAZE_COLOR, PUFF_BAND_COLORS, SUN_DIRECTION } from './palettes';
import type { Vec3 } from './sky-track';

/** Palette single source (day-night Task 5): the band colours moved to `palettes.ts`;
 *  re-exported so existing imports keep resolving to the same bytes. */
export { PUFF_BAND_COLORS };
import {
  PUFF_FADE_FAR,
  PUFF_FADE_NEAR,
  PUFF_NEAR_FLOOR,
  PUFF_SCATTER,
  puffEdgeFade,
  puffScatter,
  composePuffBanks,
} from './puff-field';
import { FLIGHT } from './game';
import type { CloudBlob } from './in-cloud';
import { interiorOpacity01 } from './in-cloud';
import type { PuffLook } from './qa';
import { dayNightLightDirection } from './daylight';
import {
  PUFF_DEFAULT_DETAIL,
  PUFF_LOBE_ATTRIBUTE,
  PUFF_VARIANT_ORDER,
  PUFF_VARIANTS,
  PuffVariantName,
  buildPuffGeometry,
  mulberry32,
} from './puff-shape';

/** 高/低档的云朵数。低档直接藏一半，不重建。 */
export const PUFF_COUNT_HIGH = 25;
export const PUFF_COUNT_LOW = 12;

/**
 * 空气透视雾的起点、饱和距离与上限，puff 自带一份。
 *
 * 此处只做云色的空气透视；远端显隐由 puff-field 的 1000–1400 m 淡出负责。
 * 未来的场景雾可以覆盖同一远端距离带。MAX 保留云自身的颜色层次。
 *
 * 这组数原来住在 `horizon.ts` 的 `CLOUD_HAZE` 里，和 780 m 穹顶共用一个渐近值。
 * 穹顶删掉后，只对球壳成立的 `DOME_MAX` / `CROWN_LO` / `CROWN_HI` 一起作废，剩下
 * 近景云真正需要的这三个。
 */
export const PUFF_HAZE = {
  /** 雾从这里开始抬；近场保持锐利。 */
  NEAR: 400,
  /** 色彩空气透视在这里饱和；不是全不透明的场景雾。 */
  FAR: 1200,
  /** 渐近上限。云还是得读成云。 */
  MAX: 0.5,
} as const;

export interface PuffHandle {
  readonly kind: 'puff';
  /** 每朵云的世界包围体，随环面回收实时变化——in-cloud 靠它算白雾。 */
  readonly blobs: readonly CloudBlob[];
  /** 抓帧开关：?puff=0 整场藏掉，用来做 paired on/off。 */
  setVisible(visible: boolean): void;
  update(t: number, sunDir: THREE.Vector3): void;
  setQuality(high: boolean): void;
  /**
   * 灌轨道调色（day-night Task 5）：四档带色 + 空气透视雾色，线性 RGB。
   * uniform 建一次、这里原地写值 —— 不重建材质，所有云同时换色。
   * 参考档值 = `palettes.PUFF_BAND_COLORS` / `SKY_PALETTE.horizon` 的线性解码。
   */
  setCloudPalette(bands: readonly Vec3[], haze: Vec3): void;
  /** 兜底瓣驱动：进云度 0..1 + 相机位（世界系）。 */
  setInterior(inCloud01: number, cam: { x: number; y: number; z: number }): void;
  dispose(): void;
}

const _sun = new THREE.Vector3(SUN_DIRECTION[0], SUN_DIRECTION[1], SUN_DIRECTION[2]).normalize();

/**
 * 分档阈值单源：`puffBandIndex`（JS 镜像/单测）与 `initPuffClouds` 的 TSL colorNode
 * 都读这一份。常数不是等分，而是按**两半球都要读得出层**反解出来的：
 *
 * - 太阳在 -Z、相机也看 -Z，可见的永远是背光半球，wrap ∈ [0, 0.5]。要让这一段
 *   跨过三档，前两个阈值必须都落在 0.5 以下（`0.2` / `0.4`）。
 * - 灯转到侧面/正面时 wrap 铺到 [0.5, 1]，第三档 `0.68` 保证受光侧仍有 pink→gold
 *   的层次，而不是整片顶到奶白。
 * - 每一档的宽度都不小于 0.15，否则某一档在曲面上会窄成一条缝，四档读成三档。
 *
 * **为什么不是 ghibli 原样的 [0.6, 0.35, 0.001]**：那组数是给「正面受光的树」调的，
 * 终止线落在 NdotL=0。照搬过来背光半球会整块压进暗档——实拍验证过，云读成一团死紫；
 * 反过来为了救背光把色阶整体上推（试过 gain 1.35 / bias 0.19），灯一转到侧面整个
 * 受光半球又会顶到 gold，糊成一片奶白——也实拍验证过。色阶必须锚在本场景真正的
 * 光照统计上，平涂硬切的 ghibli 结构则原样保留。
 */
export const PUFF_BAND_THRESHOLDS = [0.2, 0.4, 0.68] as const;

/**
 * 逐瓣法线的权重。**0.28 → 0.10 → 0.04**。
 *
 * 0.28 时每颗球都有自己的亮面暗底，十几个暗底叠成同心弧，整朵云读成一堆气球（spec §1）。
 * 压到 0.10 后明暗主要来自云心 `radial`，但**四档硬切一上来问题就暴露了**：法线在
 * 每颗瓣的轮廓处转向，正好把自己那一档推过阈值，于是每颗球镶一圈硬边——650 m 实拍
 * 量出 581 个碎边组件、最大环才 111 px，云的剪影被切成一串泡泡。
 *
 * 再压到 0.04：球边界的触发量减到 2/5，明暗差异改由 `PUFF_LOBE_SHADE_GAIN` 承担。
 * 团与团之间的层次还在（那是逐瓣常量），但不再沿每颗球的轮廓开硬缝。
 */
export const PUFF_NORMAL_WEIGHT = 0.04;

/**
 * 逐瓣常量对分档的推动量。团与团之间的深浅差靠它，不靠团内渐变。
 *
 * 0.18 → 0.22：法线权重压到 0.04 之后，逐瓣之间的明暗差要有人接盘。常量是**整颗瓣
 * 一起平移**，不会像法线那样沿球的轮廓切线走，所以它加层次而不加球边。
 * 上限是实测卡住的：0.26 会把太多瓣推进最亮档，档 1 只剩 16.7%，四档读成三档。
 */
export const PUFF_LOBE_SHADE_GAIN = 0.22;

/**
 * 四档平涂色，由暗到亮。穹顶那组色（明度跨度 63 L*、中段一道 41 L* 的断崖）用在这里
 * 就是「紫团镶白边」，已随穹顶一起删掉；这一组跨度 22.3 L*、步长 7.5。
 *
 * 这一组是按**渲染后的明度**反解出来的：
 *
 * 1. 链条：材质线性色 → bloom(只吃 >0.82) → DOF → `NeutralToneMapping` → sRGB 编码。
 * 2. `NeutralToneMapping`（three r186）在 `max < 0.76` 时不压缩，只减一个
 *    `offset = min < 0.08 ? min - 6.25*min² : 0.04` 的偏移。反解因此是个不动点：
 *    `min(材质) = min(目标) + offset`，迭代求解（暗端走二次分支，直接用 +0.04 会偏几 L*）。
 * 3. 目标明度按 ghibli 参考的**规则**来：参考四绿等差 5.9/7.8/8.9（均值 7.53），
 *    跨度 22.6。这里取等距 7.5，锚在「海 19 < 云 < 地平线辉光 70」这个窗口里：
 *    最亮 60（比辉光暗 10，仍是剪影）、最暗 37.5（比海亮 18.7，不塌成黑洞）。
 *
 * 实测结果：渲染后 L* = 37.7 / 45.0 / 52.6 / 60.0，步长 7.3/7.6/7.4，跨度 22.3，
 * 往返误差平均 0.09 L*，四档峰值 0.27~0.53 全在高光压缩膝盖以下。
 * 复算脚本原在 `artifacts/ghibli-audit/solve-ramp.py`，随 `artifacts/` 于 2026-11-16 清除；
 * 上面的读数由单测 `puffBandColors` 钉住间距，不再靠脚本复算。
 *
 * （2026-11-08 day-night Task 5：四档色升进 `palettes.PUFF_BAND_COLORS` 单源，
 * 本文件改 import 并在文首 re-export；本地数值副本已删。）
 */

/**
 * 把 wrap 光照系数分到 4 档平涂色阶，对应 `PUFF_BAND_COLORS` 的四色。
 *
 * **JS 镜像**：真正的分档现在跑在 `initPuffClouds` 的 TSL colorNode 里（逐片元算
 * radial+normal，终结线是曲面连续的——顶点色分档的硬边界只能沿三角面拓扑走，
 * 近距离出多边形色阶）。这个纯函数读同一份 `PUFF_BAND_THRESHOLDS`，给单测和
 * 调参对照用，与 `horizon.ts` 的 `horizonGlow` 一个写法。
 */
export function puffBandIndex(sunW: number): 0 | 1 | 2 | 3 {
  if (!Number.isFinite(sunW)) return 0;
  const v = sunW < 0 ? 0 : sunW > 1 ? 1 : sunW;
  const [t0, t1, t2] = PUFF_BAND_THRESHOLDS;
  if (v < t0) return 0; // shadow：背光最深那块
  if (v < t1) return 1; // base：云体主色
  if (v < t2) return 2; // pink：受光侧
  return 3; // gold：贴着轮廓的亮边 / 正面受光
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
  look: PuffLook = 'legacy',
  composed = true,
  headlight?: HeadlightUniforms,
): Promise<PuffHandle> {
  const TSL = await import('three/tsl');
  const { MeshBasicNodeMaterial } = await import('three/webgpu');

  // 调色 uniform（day-night Task 5）：四档带色与空气透视雾色建一次、写值生效
  // （`setCloudPalette` 每帧灌轨道值）；默认值 = 现常量，图默认状态与今天一致。
  // uniform(Color) 的 value 就是工作空间（线性）RGB —— setRGB(linear…) 原样入库。
  const bandU = PUFF_BAND_COLORS.map((h) => TSL.uniform(new THREE.Color(h)));
  const hazeColourU = TSL.uniform(new THREE.Color(HAZE_COLOR));

  /**
   * 活的太阳：吉卜力档受光照影响就靠它。`world.ts` 每帧把太阳方向传进
   * `update(t, sunDir)`，这里 copy 进去，色带跟着光走——转太阳、四档明暗一起转。
   * 场景里的 DirectionalLight 位置请和同一份 sunDir 保持一致，否则灯和色带打架。
   */
  const sunUniform = TSL.uniform(_sun.clone());
  const volume = look === 'volume'
    ? await (await import('./puff-volume')).createPuffVolumeFactory(bandU, hazeColourU, sunUniform, PUFF_HAZE, headlight)
    : null;
  const updateSun = (dir: THREE.Vector3): void => {
    if (Number.isFinite(dir.x) && Number.isFinite(dir.y) && Number.isFinite(dir.z)) {
      const normalized = dir.clone().normalize();
      (sunUniform.value as THREE.Vector3).set(...dayNightLightDirection([normalized.x, normalized.y, normalized.z]));
    }
  };

  /**
   * 吉卜力芯：明暗只认太阳。radial（云心射线，逐片元插值）占 0.9，
   * surface（逐瓣法线）只留 0.1——纯法线会让每个瓣自带亮面暗底，
   * 十几个同心弧叠成一堆气球，所以瓣法线只能当点缀。
   * 现场瓣与兜底瓣共用这一张色带图（太阳转、两边的色带一起转）。
   */
  const bandColorNode = (): any => {
    const sunDir = TSL.vec3(sunUniform);
    const radial = TSL.normalize(TSL.positionLocal);
    const surface = TSL.normalLocal;
    const lobeShade = TSL.attribute(PUFF_LOBE_ATTRIBUTE, 'float');
    const lit = radial
      .dot(sunDir)
      .mul(1 - PUFF_NORMAL_WEIGHT)
      .add(surface.dot(sunDir).mul(PUFF_NORMAL_WEIGHT));
    // 顺序要紧：**逐瓣常量放在最后**，且只推一点点（±0.18）。
    // 如果把逐瓣常量放在任何带增益的重映射之前，增益会把它一起放大
    // （实测 ±0.18 × 2 = ±0.36），每颗瓣各翻各的档，整朵云碎成一串气球——
    // 这正是 spec §1 要压掉的那个毛病。
    const litW = TSL.clamp(lit.mul(0.5).add(0.5), 0, 1);
    const bandW = TSL.clamp(litW.add(lobeShade.mul(PUFF_LOBE_SHADE_GAIN)), 0, 1);
    const [t0, t1, t2] = PUFF_BAND_THRESHOLDS;
    const b1 = TSL.step(t0, bandW);
    const b2 = TSL.step(t1, bandW);
    const b3 = TSL.step(t2, bandW);
    const bandC = bandU;
    const bandCol: any = TSL.mix(
      TSL.mix(TSL.mix(bandC[0], bandC[1], b1), bandC[2], b2),
      bandC[3],
      b3,
    );
    // 吉卜力档到此为止：四色硬切就是最终色。肚皮/顶盖/环境/rim 不再参与。
    // 云色空气透视；远端回收由独立的 edgeFade 隐藏。
    const dist = TSL.length(TSL.cameraPosition.sub(TSL.positionWorld));
    const hazeC = hazeColourU;
    const hazeAmt = TSL.smoothstep(TSL.float(PUFF_HAZE.NEAR), TSL.float(PUFF_HAZE.FAR), dist).mul(
      PUFF_HAZE.MAX,
    );
    const localColor = headlight ? bandCol.add(TSL.vec3(...HEADLIGHT.tint)
      .mul(headlightFieldTsl(TSL, TSL.positionWorld, headlight)).mul(0.32)) : bandCol;
    return TSL.mix(localColor, hazeC, hazeAmt);
  };

  /**
   * 一朵云的材质。**每朵一份**——边界淡出是逐朵的 uniform，共用一份材质就写不了。
   * 着色图完全相同，three 只编译一个 program。
   *
   * 吉卜力档：只有四色硬切 + 雾 + 距离淡出。肚皮压紫、奶白顶盖、玫瑰环境光、
   * 逆光 rim 全部撤掉——动画平涂不要这些小点心，明暗只认太阳。
   */
  const makeMaterial = (edgeFade: EdgeFade) => {
    const material = new MeshBasicNodeMaterial();
    // 吉卜力平涂：顶点灰阶抖动不再乘回去，关闭 vertexColors，片元只剩四色硬切。
    material.vertexColors = false;
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
    // 穿云软墙：近处片元压到 PUFF_NEAR_FLOOR 而不是归零——瓣以半透明软墙
    // 包裹相机，多片叠出体积；糊脸由兜底瓣与白纱分层接管（评审第五节）。
    const dist = TSL.length(TSL.cameraPosition.sub(TSL.positionWorld));
    material.opacityNode = TSL.mix(
      TSL.float(PUFF_NEAR_FLOOR),
      TSL.float(1.0),
      TSL.smoothstep(TSL.float(PUFF_FADE_NEAR), TSL.float(PUFF_FADE_FAR), dist),
    )
      .mul(0.96)
      .mul(edgeFade as any);

    material.colorNode = bandColorNode();
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
    size: { halfW: number; halfD: number; halfH: number; s: number };
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
    // 「画面重要」：同数量下靠体量换存在感。原来 1.6~2.6 让 400 m 外的云只占几个百分点，
    // 实测同机位 puff 画面占比只有 1.24%。放大到 2.6~4.6 后单朵在 500 m 处横跨约 17°。
    const s = Math.min(2.2 + rand() * 1.2, fitMax) * puffScaleRole(i,seed);
    const aspect = variant==='bank' && i%4===0 ? 1.32 : variant==='scraps' ? .87 : 1;
    built.push({ geo, size: { halfW: box.x * 0.5 * s * aspect, halfD: box.z * 0.5 * s, halfH: (box.y * 0.5) * s, s }, variant });
  }
  const sizes = built.map(b => b.size);
  const scattered = puffScatter(seed, sizes);
  const spots = composed ? composePuffBanks(scattered, sizes) : scattered;
  // count 的语义是「目标数」不是「必须数」：净空剔除是剔除不是平移，少一朵可接受。
  const placed = Math.min(built.length, spots.length);
  const materials: THREE.Material[] = [];
  for (let i = 0; i < placed; i += 1) {
    // Let the loading UI paint between texture builds instead of blocking one long task.
    if (volume) await new Promise<void>(resolve => setTimeout(resolve, 0));
    const edgeFade = TSL.uniform(puffEdgeFade(spots[i].x, spots[i].z, 0, 0)) as unknown as EdgeFade;
    const proxy = volume?.create(built[i].geo, edgeFade);
    const material = proxy?.material ?? makeMaterial(edgeFade);
    materials.push(material);
    const mesh = new THREE.Mesh(proxy?.geometry ?? built[i].geo, material);
    mesh.name = `puff-${String(i).padStart(2, '0')}`;
    mesh.userData.variant = built[i].variant;
    mesh.userData.blobSize = built[i].size;
    mesh.userData.scatterOffset = { x: spots[i].x, z: spots[i].z };
    mesh.position.set(spots[i].x, spots[i].y, spots[i].z);
    mesh.scale.setScalar(spots[i].s);
    mesh.scale.x *= built[i].variant==='bank' && i%4===0 ? 1.32 : built[i].variant==='scraps' ? .87 : 1;
    mesh.frustumCulled = true;
    group.add(mesh);
  }
  scene.add(group);

  /**
   * 兜底瓣：相机锚定的内部壳层。穿云时现场瓣的近距淡出会在相机旁留出空洞，
   * 这组低透明大瓣把相机包住，接住「人在云里」的体积感——透明度由进云度驱动，
   * 场外整组隐藏（零 draw call）。
   *
   * 三条硬规矩（见 far-field 的历史 bug 与 blobs 契约）：
   * - 名字**不得**匹配 far-field 的回收正则 `/^puff-\d+$/`——命中即整组被拖走；
   * - **不得**进 `blobs`——兜底瓣永远贴着相机，进了 blobs 白雾就常驻；
   * - `depthWrite = false`——低透明大层写深度会把身后的云挖掉。
   */
  const interiorGroup = new THREE.Group();
  interiorGroup.name = 'puff-interior';
  interiorGroup.visible = false;
  const interiorU = TSL.uniform(interiorOpacity01(0));
  const makeShellMaterial = (base: number) => {
    const material = new MeshBasicNodeMaterial();
    material.vertexColors = false;
    material.transparent = true;
    material.depthWrite = false;
    material.alphaTest = 0.02;
    material.side = THREE.DoubleSide;
    material.fog = false;
    material.opacityNode = TSL.float(base).mul(interiorU as any);
    material.colorNode = bandColorNode();
    return material;
  };
  // 2026-11-13（cloud-layer-reduction）：5 → 3 片，更少、更精、更淡。base alpha 收进
  // 设计带 0.07–0.12（旧 0.10–0.18），单瓣 scale 压到 0.28–0.40（旧 0.45–0.70）——
  // 接住「云里有厚度」，压掉「平板糊脸」。
  const SHELL_COUNT = volume ? 0 : 3;
  for (let i = 0; i < SHELL_COUNT; i += 1) {
    const material = makeShellMaterial(0.07 + (i % 3) * 0.025);
    materials.push(material);
    const mesh = new THREE.Mesh(built[i % built.length].geo, material);
    mesh.name = `incloud-shell-${String(i).padStart(2, '0')}`;
    const az = (i / SHELL_COUNT) * Math.PI * 2 + rand() * 0.8;
    const radius = 8 + rand() * 6;
    mesh.position.set(Math.sin(az) * radius, (rand() * 2 - 1) * 4, Math.cos(az) * radius);
    mesh.scale.setScalar(0.28 + rand() * 0.12);
    interiorGroup.add(mesh);
  }
  scene.add(interiorGroup);

  let disposed = false;
  // 抓帧开关关掉时连包围体一起清空：云看不见了，白雾也不该再糊屏。
  let hidden = false;
  return {
    kind: 'puff',
    get blobs(): readonly CloudBlob[] {
      if (hidden) return [];
            const out: CloudBlob[] = [];
      for (const child of group.children) {
        // 低档藏掉的云不许再驱动白雾、相机和台词——否则手机上每隔一朵云
        // 就是在空气里「穿云」：雾满、镜头抖、台词播，屏幕什么都没有。
        if (!child.visible) continue;
        // Queued/recycled clouds must not trigger an invisible cloud encounter.
        const fade = ((child as THREE.Mesh).material as THREE.Material).userData.edgeFade as EdgeFade | undefined;
        if (fade && fade.value <= 0.001) continue;
        const size = (child.userData.blobSize ?? { halfW: 1, halfH: 1 }) as { halfW: number; halfH: number };
        out.push({
          x: child.position.x,
          y: child.position.y,
          z: child.position.z,
          halfW: size.halfW,
          halfH: size.halfH,
        });
      }
      return out;
    },
    update(_t: number, sunDir: THREE.Vector3): void {
      if (disposed) return;
      // 造型静态，位置由 far-field 的环面回收驱动；光照是活的，太阳转、色带跟着转。
      if (sunDir) updateSun(sunDir);
    },
    setCloudPalette(bands: readonly Vec3[], haze: Vec3): void {
      if (disposed) return;
      // 线性 RGB 直写工作空间（LinearSRGBColorSpace = 不再做 sRGB 解码）。
      bands.forEach((v, i) => (bandU[i].value as THREE.Color).setRGB(v[0], v[1], v[2], THREE.LinearSRGBColorSpace));
      (hazeColourU.value as THREE.Color).setRGB(haze[0], haze[1], haze[2], THREE.LinearSRGBColorSpace);
    },
    setInterior(inCloud01: number, cam: { x: number; y: number; z: number }): void {
      if (disposed) return;
      // 兜底瓣跟随**相机**（rig 有滞后，跟飞机会抖——见 far-field 同款教训）；
      // 非有限输入经 interiorOpacity01 回 0，整组隐藏。
      const v = interiorOpacity01(inCloud01);
      interiorU.value = v;
      interiorGroup.position.set(cam.x, cam.y, cam.z);
      interiorGroup.visible = !volume && v > 0.001 && !hidden;
    },
    setVisible(visible: boolean): void {
      if (disposed) return;
      group.visible = visible;
      hidden = !visible;
      // 现场云藏掉时兜底瓣必须跟着藏：白雾的 blobs 已经清空，
      // 兜底瓣留在场上就成了没有白雾的孤立体积感。
      if (hidden) interiorGroup.visible = false;
    },
    setQuality(high: boolean): void {
      if (disposed) return;
      volume?.setQuality(high);
      // 低档藏一半：不重建、不改程序，只翻 visible。兜底瓣两档都保留——
      // 低档「空气穿云」（白雾满屏但什么都没有）比费一点 fill rate 更糟。
      group.children.forEach((child, i) => {
        child.visible = high || i % 2 === 0;
      });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      volume?.dispose();
      const geometries = new Set(built.map(b => b.geo));
      scene.remove(group);
      group.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh) geometries.add(mesh.geometry as THREE.BufferGeometry);
      });
      scene.remove(interiorGroup);
      // Source meshes, proxy boxes and shared interior shells each release once.
      interiorGroup.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh) geometries.add(mesh.geometry as THREE.BufferGeometry);
      });
      for (const geometry of geometries) geometry.dispose();
      for (const m of materials) m.dispose();
    },
  };
}
