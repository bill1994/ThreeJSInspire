/**
 * src/bg-cumulus.ts — 背景积云：cubemap 烘焙 raymarch（bg-cumulus Task 3）。
 *
 * 架构（计划 §裁定 1/4/6）：每朵云是球堆 SDF（puff 球 + billow 3D 噪声推面），
 * TSL 光线步进把全部云烘进 CubeRenderTarget——每帧限速 1–8 条带（shader 侧
 * Discard 掩码 + autoClear=false，Task 0 证伪 scissor/viewport 后的既定机制），
 * 太阳静止且调色板不变时停烘。天空侧一次 cubeTexture 采样（Task 4）。
 * 颜色单源 cloudBands/cloudHaze → 五色 uniform（§裁定 5）；月亮 = −sunDir
 * 内部派生（§裁定 8）。puff 几何数据走 DataTexture texel 直读（Task 3.5：
 * 嵌套 Loop 的循环变量名遮蔽让一切外层索引塌成内层号、每朵云只渲染 puff0——
 * 纹理化 + toVar 快照根治，见 packPuffField 与 bgMap 注释）。软边 alpha 收尾
 * veilAlpha 只在 owning cloud 包围球内成立（Task 4：bgMap 第 4 分量 inside +
 * march any-pass 累积——结构护栏；取证备注见 veilAlpha 注释）。
 * 参考 clouds.js:218-364 逐式移植；差异点全在计划 §裁定：尺度带布局派生
 * （uSlabStartY/tEnd 禁抄 520/14500/56000）、64 步预算、霾长 12000、
 * Discard 条带（参考的 8 条带/面分帧语义保留）、premultiplied 输出。
 */

import * as THREE from 'three';
import { cloudProjection, type CloudProjection } from './bg-cloud-field';

import {
  billowField,
  layoutAzToXz,
  layoutClouds,
  layoutWindow,
  type CloudLayout,
  type Puff,
} from './bg-cumulus-layout';
import {
  PAINT_CONSTANTS,
  BG_DISPLACEMENT,
  FORM_HIGHLIGHT,
  type BgLook,
  type BgShape,
  lightBlend,
  mapPalette,
} from './bg-cumulus-paint';
import type { Vec3 } from './sky-track';

/** march 步数（§裁定 4：布局派生尺度的重推预算，spike 验证余量）。 */
export const STEPS = 64;
/** 基础霾长（米）；实际混合再乘强度增益和仰角衰减。 */
export const BG_HAZE_METRES = 12000;
// 云面距离的雾强度增益，越大霾越强。
export const HAZE_NEAR_GAIN = 0.7;
// Task5 v4 Step2 调参旋钮：base/scale 软锚定的距离衰减尺度（米）
export const PAINT_ANCHOR_TAU = 170;
/** 每面条带数 / 烘焙面数 / 总条带（§裁定 6：40 帧一圈）。 */
export const STRIPS_PER_FACE = 8;
export const FACES_BAKED = 5;
export const TOTAL_STRIPS = STRIPS_PER_FACE * FACES_BAKED;
/** 单帧烘带硬顶（§裁定 6）。 */
export const MAX_STRIPS_PER_FRAME = 8;
/**
 * 烘焙面清单（终审 C1，2026-11-14）：GPU 立方面序 0=+X、1=−X、2=+Y、3=−Y（底面）、
 * 4=+Z、5=−Z。底面（3）永不烘（rd.y 门会全弃，白烧 8 条带），−Z（5）是游戏正前
 * 方向（azimuth 0）必烘——按清单映射，禁止 cursor 直除。
 */
export const BAKE_FACES = [0, 1, 2, 4, 5] as const;
/** 默认烘焙分辨率（?bgq 可调，clamp 512..2048）。 */
export const BG_BAKE_SIZE_DEFAULT = 1024;
/**
 * 编译预算（2026-11-14 本机实测：单卡 NVIDIA RTX 3060，Task 6 前诊断；初记
 * "AMD RX 5700" 系归因笔误，本机无 AMD 硬件，挂死发生在 3060 上）：
 * 全量图（14 云 × 44 puff 循环 + fine 探针 11 次 bgMap）让驱动着色器编译器挂起
 * (>25 s 无返回)；砍到 9 云 × 16 puff 后全量首烘 3.2 s。这两个常量是编译规模
 * 上限——云数据超限时超出的云/球不参与烘焙（layout 层 puff 产能已对齐 16）。
 */
export const BG_CLOUD_LOOP_MAX = 9;
export const BG_PUFF_LOOP_MAX = 16;
/**
 * 云容量（uniform 数组行数与 puff 场纹理行数共用；参考 createClouds MAX_CLOUDS=14）。
 * puff 场纹理的行数读它（packPuffField 缺省 caps → DataTexture 声明同源，
 * C1 billow 分辨率脱节同款的结构性防再脱节）。
 */
export const BG_MAX_CLOUDS = 14;
/** billow 3D 噪声场分辨率（参考 clouds.js billowTexture 默认 64）。 */
export const BG_BILLOW_RES = 64;

/**
 * 面分量的取值来源：`u` = +st.x、`-u` = −st.x、`v` = +st.y、`-v` = −st.y、
 * `one`/`-one` = 主轴 ±1。FACE_AXIS 表的原子项，纯函数与 TSL 烘焙链共用。
 */
export type FaceComponent = 'u' | '-u' | 'v' | '-v' | 'one' | '-one';

/**
 * 面→方向表（GL 立方图采样约定 + RT 行序取反的**净约定**，bg-cumulus Task 3）。
 * 每面给出 rd 的三个分量 (x, y, z) 如何由面内坐标 st（∈ [−1,1]²）推出。
 * 纯函数 bakeFaceDirection 与 TSL 烘焙链都读这张表——禁止两处各写一份数字。
 *
 * 行序取证（2026-11-14，6dc9dab）：立方面在 RT 里的行序与 cubemap 采样约定相反，
 * 侧面（tc 映射 y）与顶/底面（tc 映射 z）的 t 轴取反——侧面竖直轴净符号为正
 * （rd.y = +st.y），本表已吸收该符号，不得翻回（翻回去云全烘在地平线以下）。
 */
export const FACE_AXIS: readonly [FaceComponent, FaceComponent, FaceComponent][] = [
  ['one', 'v', '-u'], // 0: +X — GL 采样约定 (1, −t, −s) 经 t 取反
  ['-one', 'v', 'u'], // 1: −X — GL (−1, −t, s) 经 t 取反
  ['u', 'one', '-v'], // 2: +Y — GL (s, 1, t)，tc = z → 取反成 −v（顶面）
  ['u', '-one', 'v'], // 3: −Y — GL (s, −1, −t)，tc = z → 取反成 +v（底面，永不烘焙）
  ['u', 'v', 'one'], // 4: +Z — GL (s, −t, 1) 经 t 取反
  ['-u', 'v', '-one'], // 5: −Z — GL (−s, −t, −1) 经 t 取反
];

/**
 * 面→方向的纯函数（bg-cumulus Task 3）：texel (face, st) 在立方图内容约定里
 * 代表的方向。面中心：+X→(1,0,0)、+Y→(0,1,0)、+Z→(0,0,1) 等；侧面竖直轴
 * rd.y 与 st.y 同号（见 FACE_AXIS 的行序取证注释）。
 */
export function bakeFaceDirection(
  face: number,
  st: { x: number; y: number },
): { x: number; y: number; z: number } {
  const comps = FACE_AXIS[face];
  if (!comps) throw new Error(`bg-cumulus: face ${face} 不在 0..5`);
  // 取反归一：st 分量为 0 时 −0 会挂在 toEqual 的 Object.is 上，归成 +0
  const neg = (v: number): number => (v === 0 ? 0 : -v);
  const pick = (c: FaceComponent): number => {
    switch (c) {
      case 'u':
        return st.x;
      case '-u':
        return neg(st.x);
      case 'v':
        return st.y;
      case '-v':
        return neg(st.y);
      case 'one':
        return 1;
      case '-one':
        return -1;
    }
  };
  return { x: pick(comps[0]), y: pick(comps[1]), z: pick(comps[2]) };
}

/** Canonical origin of the camera-relative distant cloud layout. */
export const BG_LAYOUT_ORIGIN = [0, 70, 0] as const;

/** 光照状态（重烘调度的输入）：太阳方位/仰角 + 调色板版本。 */
export interface LightState {
  azDeg: number;
  elDeg: number;
  paletteVersion: number;
}

function wrap180(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/**
 * 限速条带预算（§裁定 6）：跳变当帧 strips = clamp(ceil(Δangle/0.05°), 1, 8)
 * 并把全部 40 条带标记 stale；此后静止也按 8/帧追平到 0。慢转每帧 dirty
 * 恒 1 条带（全圈 40 帧自刷新）。paletteVersion 变化视同 dirty。
 */
export function bakeBudget(
  prev: LightState,
  next: LightState,
  staleStrips: number,
): { strips: number; staleStrips: number } {
  const dAz = wrap180(next.azDeg - prev.azDeg);
  const dEl = next.elDeg - prev.elDeg;
  const delta = Math.hypot(dAz, dEl);
  const dirty = next.paletteVersion !== prev.paletteVersion || delta > 1e-9;
  let stale = dirty ? TOTAL_STRIPS : staleStrips;
  let strips = 0;
  if (dirty) {
    strips = Math.min(MAX_STRIPS_PER_FRAME, Math.max(1, Math.ceil(delta / 0.05)));
  } else if (stale > 0) {
    strips = Math.min(MAX_STRIPS_PER_FRAME, stale);
  }
  stale = Math.max(0, stale - strips);
  return { strips, staleStrips: stale };
}

/**
 * 软边 alpha 收尾（bg-cumulus Task 4 纯函数）：march 未命中云体但近距离擦过时，
 * 参考用「1 − near/texel」给出贴着轮廓的软边。plan §Task 4 的裁定：这条软边只在
 * 射线**进过 owning cloud 的包围球**时才成立，球外恒 0——内联表达式本身对任何
 * 擦过方向都放行，是结构上的泄漏口。
 *
 * Task 4 取证备注（2026-11-15，见 task-4-report.md）：当前 march 数学下远场
 * d ≥ 150 → near = d/t ≥ 150/tEnd ≈ 0.022 ≫ uTexel ≈ 0.00293，内联软边**实际**
 * 从未在球外触发过（直读烘焙 cubemap 证实：新旧着色器远场 alpha/rgb 全零，探针
 * spawn 对差分逐位相同）；plan 把「天空区 5–10 级泛白」归因于软边泄漏的假设被
 * 证伪——那层图案是抓帧对之间（相机 rig 残余运动 + 世界动画）的逐帧渲染差。
 * 本函数保留为**结构护栏**：语义正确、对现有内容零行为变化；若未来远场 SDF
 * 出现能压出 near < uTexel 的改动（如去掉远场 +150 余量），球外仍恒 0。
 *
 * 两个入参都是**无量纲的角量**（名字里带 Metres 会骗人，故不这么叫，plan 评审采纳）：
 * - `nearSlack` = nearDistance / tHit：擦过距离与命中距离之比（小角近似下的
 *   「差几个 texel 的角距」）。
 * - `texelSlack` = 3 / size：三个烘焙 texel 的角宽（uTexel）。
 * `insideBound === false` 时恒为 0；`nearSlack >= texelSlack`（超出软边带宽）也是 0。
 * TSL 侧等价式见 initBgCumulus 的 veilAlphaTsl（代数恒等：调用点外层 If 已保证
 * nearSlack < texelSlack，insideBound ∈ {0,1} → insideBound × (1 − nearSlack/texelSlack)）。
 */
export function veilAlpha(nearSlack: number, texelSlack: number, insideBound: boolean): number {
  if (!insideBound) return 0;
  if (!(nearSlack < texelSlack)) return 0;
  return 1 - nearSlack / texelSlack;
}

/**
 * 单云标定台夹具（bg-cumulus Task 2）：一朵方位/仰角/距离/尺寸全部已知的云。
 * `?bgforce=single` 时 main 构造它 → `initWorld` 的 `bgForceLayout` → 本模块的
 * `forceLayout`，整个换掉 seed 环排布；探针在这朵「已知答案」上标定烘焙层的
 * 方位与角宽。标定字面量在 main.ts（90, 10, 5000, 2000, 600），探针匹配侧
 * （scripts/cloud-probe.mjs）用同一组——两处必须同步改。
 *
 * 坐标约定与测量系一致（az = atan2(x, −z)，0 = −Z，与探针 azOf / 游戏航向同一
 * 约定；中心经 bg-cumulus-layout.ts 的 layoutAzToXz 唯一出口换算）。layoutClouds
 * 曾用 (−sin, −cos) 的镜像约定，与采样链的镜像恰好抵消——两层在 Task 3 一并归位
 * 到测量系后，夹具与生产布局同约定。
 * 仰角从布局原点（烘焙起点 (0,70,0)，相机出生同高）量起。
 *
 * puff 并集宽度贴在**切向**（垂直于视线）~0.99×width（竖向贴满 height）：billow
 * 噪声对 SDF 是双向扰动（lump ∈ [−1.08, +1.32]·scale ≈ ∓151/+185 m），渲染角宽比
 * 的摆动由此而来——并集跨度按「噪声双向满摆后仍落在 [0.8, 1.2] 闸内」反推。Task 3
 * 取证：宽度轴沿世界 X 硬摆会让 az 90 的云被端着看（角宽比 0.43）；billow 场 32³
 * 分辨率下噪声被抹平成纯侵蚀，并集被啃成单 puff 残块（角宽比 0.37，见 billowData
 * 注释）。无随机流，完全确定性；
 * 16 个 puff 恰好贴住 BG_PUFF_LOOP_MAX=16 编译预算。kind 取 'mid'：宽度带一致，
 * 该字段只进探针输出的 layoutMatch，不进任何分支。
 */
export function singleCloudLayout(
  azDeg: number,
  elevDeg: number,
  distMetres: number,
  widthMetres: number,
  heightMetres: number,
): CloudLayout[] {
  const az = (azDeg * Math.PI) / 180;
  // 仰角钳 ±89°：cos(el) 是水平半径的因子，±90° 会把云压到原点正上/正下方。
  const el = (Math.max(-89, Math.min(89, elevDeg)) * Math.PI) / 180;
  const dist = Math.max(1, distMetres);
  const width = Math.max(1, widthMetres);
  const height = Math.max(1, heightMetres);
  const horiz = dist * Math.cos(el);
  // 中心走测量系唯一出口（Task 3 镜像修复后的同一约定）
  const { x: cx, z: cz } = layoutAzToXz(azDeg, horiz);
  // 宽度轴 = 切向（垂直于视线），深度轴 = 径向（指向云）——见文件头注释的 Task 3 取证
  const tx = Math.cos(az);
  const tz = Math.sin(az);
  const rx = Math.sin(az);
  const rz = -Math.cos(az);
  const centerY = 70 + dist * Math.sin(el);
  // scale = width·0.035（生产布局走 0.07 既有约定）：billow 侵蚀上限 2.068·scale
  // （基础 lump 1.32 + fine 两档 0.55/0.198，n1→0 时全侵蚀）必须 < puff 半径 171 m，
  // 否则噪声实现可以逐个抹掉 puff、渲染轮廓变成噪声彩票（Task 3 取证：0.07 时
  // 16 球并集被啃成单 puff 残块，角宽比 0.34）。0.035 → 侵蚀 ≤ 145 m < 171 m ✓。
  const scale = width * 0.035;
  const base = centerY - height / 2;

  // 中排 6 球占满切向，上/下排错半格，深度再补 2 球 = 16 puff；相邻球距
  // 0.33·(w/2) ≤ 2r 保证 smin 熔成一坨（标定要的是实心轮廓，不是碎棉）。
  // 中排取 6 球（Task 3 取证）：billow 噪声 lump 可达 +1.32·scale ≈ 185 m 侵蚀
  // （n1→0 的稀疏场），与 puff 半径 171 同量级——5 球（±831 m）会被 carved 成
  // ~9° 的不规则小团，角宽比闸 [0.8, 1.2] 进不去；6 球并集 ±996 m，噪声双向摆动
  // 下渲染角宽比落在 [0.81, 1.18]，任意噪声实现都过闸。
  const halfW = width / 2;
  const halfH = height / 2;
  const r = Math.min(halfH * 0.57, halfW * 0.22);
  const puffs: Puff[] = [];
  for (const f of [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5]) {
    puffs.push([cx + tx * f * (halfW * 0.33), centerY, cz + tz * f * (halfW * 0.33), r]);
  }
  for (const f of [-1.5, -0.5, 0.5, 1.5]) {
    puffs.push([cx + tx * f * (halfW * 0.33), centerY - (halfH - r), cz + tz * f * (halfW * 0.33), r]);
    puffs.push([cx + tx * f * (halfW * 0.33), centerY + (halfH - r), cz + tz * f * (halfW * 0.33), r]);
  }
  puffs.push([cx + rx * (halfW * 0.18), centerY, cz + rz * (halfW * 0.18), r]);
  puffs.push([cx - rx * (halfW * 0.18), centerY, cz - rz * (halfW * 0.18), r]);

  // 包围球与 layoutClouds 同一算法：puff AABB → 球 + scale×4 外推余量。
  const box = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (const [px, py, pz, pr] of puffs) {
    box.minX = Math.min(box.minX, px - pr); box.maxX = Math.max(box.maxX, px + pr);
    box.minY = Math.min(box.minY, py - pr); box.maxY = Math.max(box.maxY, py + pr);
    box.minZ = Math.min(box.minZ, pz - pr); box.maxZ = Math.max(box.maxZ, pz + pr);
  }
  return [
    {
      kind: 'mid',
      puffs,
      base,
      scale,
      widthMetres: width,
      heightMetres: height,
      distanceMetres: horiz,
      azimuthDeg: azDeg,
      bounds: {
        cx: (box.minX + box.maxX) / 2,
        cy: (box.minY + box.maxY) / 2,
        cz: (box.minZ + box.maxZ) / 2,
        r: Math.hypot(box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ) / 2 + scale * 4,
      },
    },
  ];
}

/**
 * puff 场 → 2D DataTexture 的 CPU 打包（Task 3.5，纯函数）。
 *
 * 布局：width 列 = puff 号（单云上限 BG_PUFF_LOOP_MAX）、height 行 = 云号（容量
 * BG_MAX_CLOUDS）；texel RGBA = (puff 相对云包围心的偏移 xyz（米）, 半径（米））。
 * GPU 侧用 textureLoad(tex, uvec2(puff 号, 云号)) 直读 texel——索引走 texel 坐标，
 * 不走 uniformArray 下标（嵌套 Loop 的循环变量名遮蔽会让一切外层索引塌成内层号，
 * 见 bgMap 注释的取证；每朵云自 6dc9dab 起只渲染一个球即此因）。
 *
 * 语义约定：
 * - **偏移而非绝对坐标**：puff 烘焙位置 = uClouds.xyz + 偏移。
 *   打包结果对整场平移逐位不变（单测钉）——纹理一次上传后永不重打包。
 * - **零填充**：nP 之外的 texel 恰为 (0,0,0,0)。GPU 守卫 i < nP 保证 s.w=0 的
 *   零球永不被 smin 读到（0/0=NaN 污染教训，Task 3 report 取证 #3）。
 * - **裁剪**：单云 puff 超过 maxPuffs（缺省 BG_PUFF_LOOP_MAX）或云数超过
 *   maxClouds（缺省 BG_MAX_CLOUDS）的部分不打包——GPU 循环预算同源，超出部分
 *   本来就不会被读（layout 层 puff 产能已对齐 16，见 BG_PUFF_LOOP_MAX 注释）。
 * - **NaN 防御**：待打包 puff 出现非有限值直接抛 Error（fail-fast）。放行上 GPU
 *   会污染整条 SDF（Task 3 report 的 0/0=NaN 链）。
 */
export function packPuffField(
  layouts: CloudLayout[],
  caps?: { maxClouds?: number; maxPuffs?: number },
): { data: Float32Array; width: number; height: number } {
  const width = caps?.maxPuffs ?? BG_PUFF_LOOP_MAX;
  const height = caps?.maxClouds ?? BG_MAX_CLOUDS;
  const data = new Float32Array(width * height * 4);
  const clouds = Math.min(layouts.length, height);
  for (let c = 0; c < clouds; c += 1) {
    const cloud = layouts[c];
    const { cx, cy, cz } = cloud.bounds;
    const puffs = Math.min(cloud.puffs.length, width);
    for (let j = 0; j < puffs; j += 1) {
      const [px, py, pz, pr] = cloud.puffs[j];
      if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz) || !Number.isFinite(pr)) {
        throw new Error(
          `bg-cumulus: puff 非有限数据（云 ${c} 球 ${j}）: (${px}, ${py}, ${pz}, ${pr}) — 拒绝上 GPU`,
        );
      }
      const k = (c * width + j) * 4;
      data[k] = px - cx;
      data[k + 1] = py - cy;
      data[k + 2] = pz - cz;
      data[k + 3] = pr;
    }
  }
  return { data, width, height };
}

/** 对外句柄（Task 4/5 消费）。 */
export interface BgCumulusHandles {
  /**
   * Pump a complete lighting snapshot into a private bake target. Camera
   * translation leaves the camera-relative cloud layout unchanged.
   */
  update(t: number, sunDir: THREE.Vector3, cameraPos?: THREE.Vector3): void;
  /** 调色板推送（cloudBands/cloudHaze → 五色 uniform，paletteVersion 递增）。 */
  setLight(p: { bands: readonly Vec3[]; haze: Vec3 }): void;
  /** 全量重烘：仅 init/loading 路径（运行时禁用——§裁定 6）。 */
  drawAll(): void;
  /** 开关：关时停止烘焙（天空侧 uCloudOn 由 world 回调链处理）。 */
  setVisible(visible: boolean): void;
  /** 0 正常；1 方向；2 覆盖；3 实际命中点；4 粗场；5 深度；6 法线；7 阴影。 */
  debugMode(n: number): void;
  dispose(): void;
  readonly count: number;
  readonly texture: THREE.Texture;
  readonly tiles?: readonly (CloudProjection & { texture: THREE.Texture })[];
}

/**
 * 挂载。renderer 由 world 转发（main.ts initWorld 已持有）；opts.quality 来自
 * ?bgq=（Task 5 qa.ts 解析，clamp 512..2048 并受 device 上限约束）；
 * opts.forceLayout 是标定台夹具（Task 2：?bgforce=single → main 构造
 * singleCloudLayout → world.bgForceLayout 透传），给了就整个换掉 seed 环排布。
 */
export async function initBgCumulus(
  renderer: unknown,
  opts: { seed: number; look?: BgLook; shape?: BgShape; replaceStrips?: boolean; sunDir?: THREE.Vector3; quality?: number; bands?: readonly [number, number, number][]; haze?: [number, number, number]; forceLayout?: CloudLayout[]; tiles?: boolean },
): Promise<BgCumulusHandles> {
  const r = renderer as {
    setRenderTarget: (t: unknown, face?: number) => void;
    render: (s: THREE.Scene, c: THREE.Camera) => void;
    autoClear: boolean;
    setClearColor: (c: number | THREE.Color, a: number) => void;
    getClearColor: (color: THREE.Color) => THREE.Color;
    getClearAlpha: () => number;
    setViewport: (x: number, y: number, w: number, h: number) => void;
    getViewport?: (t: THREE.Vector4) => THREE.Vector4;
    compileAsync: (s: THREE.Scene, c: THREE.Camera) => Promise<unknown>;
    initRenderTarget: (target: unknown) => void;
    copyTextureToTexture: (source: THREE.Texture, target: THREE.Texture, region: THREE.Box3) => void;
    backend?: { device?: { limits?: { maxTextureDimension2D?: number } } };
  };

  const webgpu = (await import('three/webgpu')) as any;
  const tsl = (await import('three/tsl')) as any;
  const { Fn, If, Loop, Discard, uniform, uniformArray, texture3D, textureLoad, uvec2, uv, vec2, vec3, vec4, float, int } = tsl;
  const { abs, max, min, mix, normalize, dot, exp, sin, smoothstep, clamp, length } = tsl;
  const formPaint = opts.look === 'form';
  const cleanPaint = opts.look === 'clean' || formPaint;
  const displacement = BG_DISPLACEMENT[opts.shape ?? 'legacy'];

  // ---- 布局与 billow 场（纯函数层） ----
  // 标定台（Task 2）：forceLayout 给了就整个换掉 seed 环排布（缺省 = 生产布局）。
  const layouts: CloudLayout[] = opts.forceLayout ?? layoutClouds(opts.seed);
  const win = layoutWindow(layouts);
  // billow 场 64³（参考 clouds.js billowTexture 的默认分辨率）。曾用 32³——稀疏
  // 尖峰场在 32³ 线性过滤下被抹平，n1 系统性偏低 → lump 侵蚀（≤1.32·scale）压倒
  // 膨胀，puff 并集被啃成孤立小团（2026-11-15 探针取证：夹具云只剩单 puff 的
  // ~8.5° 残块）。64³ 让尖峰可解析，噪声恢复「膨胀为主」的参考语义。
  // 分辨率唯一常量：Data3DTexture 的三维声明必须与 billowField 的产出同步
  // （评审 C1：曾出现 64³ 数据配 32³ 声明，GPU 采样到打乱的前缀）。
  const billowData = billowField(BG_BILLOW_RES);
  const tex3d = new THREE.Data3DTexture(billowData, BG_BILLOW_RES, BG_BILLOW_RES, BG_BILLOW_RES);
  tex3d.format = THREE.RGBAFormat;
  tex3d.type = THREE.HalfFloatType;
  tex3d.minFilter = THREE.LinearFilter;
  tex3d.magFilter = THREE.LinearFilter;
  tex3d.wrapS = THREE.RepeatWrapping;
  tex3d.wrapT = THREE.RepeatWrapping;
  tex3d.wrapR = THREE.RepeatWrapping;
  tex3d.unpackAlignment = 1;
  tex3d.needsUpdate = true;

  // ---- puff 场纹理（Task 3.5）：puff 几何的取数路径 = DataTexture 的 texel 直读 ----
  // 旧路径 uniformArray + element(first+i)：索引片段在内层 Loop 体内被循环变量名
  // 遮蔽塌成内层号（真因取证见 bgMap 注释；Task 3 报告的「动态索引不绑定」假设
  // 不成立）→ 每朵云只渲染一个球；纹理化后索引 = 循环计数 → texel 坐标
  // （uvec2(列=puff 号, 行=云号)），行坐标用 toVar 快照，不再经过名字解析。
  // RGBA32Float 保精度（偏移量级 ±1000 m、半径 ≤200 m，unorm 打包不够）；
  // textureLoad 无采样器参与，无过滤/回绕语义可错。偏移存「相对云包围心」：
  // 云场固定在烘焙坐标系，纹理一次上传后永不重打包。
  // 维度单源：DataTexture 声明读 packPuffField 的 width/height（BG_PUFF_LOOP_MAX ×
  // BG_MAX_CLOUDS），与 GPU 循环预算/uv 索引域结构性绑定（C1 billow 同款防脱节）。
  const puffField = packPuffField(layouts);
  const puffTex = new THREE.DataTexture(
    puffField.data,
    puffField.width,
    puffField.height,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  puffTex.needsUpdate = true;

  // ---- 烘焙分辨率（?bgq → quality；clamp 512..2048 且受 device 上限） ----
  const deviceLimit = r.backend?.device?.limits?.maxTextureDimension2D;
  const size = Math.min(
    Math.max(opts.quality ?? BG_BAKE_SIZE_DEFAULT, 512),
    opts.tiles ? 1024 : 2048,
    Number.isFinite(deviceLimit) ? (deviceLimit as number) : 2048,
  );

  // ---- 烘焙目标 ----
  const crt = new webgpu.CubeRenderTarget(opts.tiles ? 1 : size, { format: THREE.RGBAFormat, type: THREE.HalfFloatType });
  const staging = new webgpu.CubeRenderTarget(opts.tiles ? 1 : size, { format: THREE.RGBAFormat, type: THREE.HalfFloatType });
  const projections = opts.tiles ? layouts.map(cloudProjection) : [];
  const tileTargets = projections.map(() => new webgpu.RenderTarget(size,size,{format:THREE.RGBAFormat,type:THREE.HalfFloatType}));
  const tileStaging = projections.map(() => new webgpu.RenderTarget(size,size,{format:THREE.RGBAFormat,type:THREE.HalfFloatType}));
  tileTargets.forEach((target,i)=>{target.texture.name=`bg_cloud_tile_${i}`;});
  r.initRenderTarget(crt);
  tileTargets.forEach(target=>r.initRenderTarget(target));
  const cubeRegion = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(size, size, 6));
  const tileRegion = new THREE.Box3(new THREE.Vector3(),new THREE.Vector3(size,size,1));
  const publish = (): void => {
    if(opts.tiles)tileTargets.forEach((target,i)=>r.copyTextureToTexture(tileStaging[i].texture,target.texture,tileRegion));
    else r.copyTextureToTexture(staging.texture, crt.texture, cubeRegion);
  };
  const totalStrips = opts.tiles ? layouts.length*STRIPS_PER_FACE : TOTAL_STRIPS;
  const clearCount = opts.tiles ? layouts.length : 6;
  const faceAt = (index:number):number => opts.tiles ? Math.floor(index/STRIPS_PER_FACE) : BAKE_FACES[Math.floor(index/STRIPS_PER_FACE)];

  // ---- uniforms：云场数据（容量 = BG_MAX_CLOUDS；puff 几何已迁往 puffTex，见上） ----
  // uCloudInfo = (first, nP, base, scale) 语义原样（Task 3 修复轮钉死）：first 是旧
  // 平坦 puff 数组的跨云累计下标，纹理化后 GPU 不再消费（纹理按云号=行寻址），
  // 打包口径保留作对账基准。
  const boundVals: THREE.Vector4[] = [];
  const infoVals: THREE.Vector4[] = [];
  let firstPuff = 0;
  layouts.forEach((c) => {
    boundVals.push(new THREE.Vector4(c.bounds.cx, c.bounds.cy, c.bounds.cz, c.bounds.r));
    infoVals.push(new THREE.Vector4(firstPuff, c.puffs.length, c.base, c.scale));
    firstPuff += c.puffs.length;
  });
  while (boundVals.length < BG_MAX_CLOUDS) boundVals.push(new THREE.Vector4(0, 0, 0, 0));
  while (infoVals.length < BG_MAX_CLOUDS) infoVals.push(new THREE.Vector4(0, 0, 0, 0));

  // Bake the entire camera-relative layout in its original local frame. This
  // keeps sphere positions, billow noise, cloud bases and radial light aligned,
  // and avoids precision loss and redundant rebakes during long flights.
  const uClouds = uniformArray(boundVals, 'vec4');
  const uCloudInfo = uniformArray(infoVals, 'vec4');
  const uCount = uniform(layouts.length);
  const uFace = uniform(0);
  const uTileIndex = uniform(-1);
  const uTileForward=uniform(new THREE.Vector3(0,0,-1));
  const uTileRight=uniform(new THREE.Vector3(1,0,0));
  const uTileUp=uniform(new THREE.Vector3(0,1,0));
  const uTileHalf=uniform(new THREE.Vector2(1,1));
  const activeCloud = (i:number):any => opts.tiles
    ? float(i).lessThan(uCount).and(float(i).equal(uTileIndex)) : float(i).lessThan(uCount);
  const uStripIndex = uniform(0);
  const uTexel = uniform(3 / size);
  const uOrigin = uniform(new THREE.Vector3(...BG_LAYOUT_ORIGIN));
  const uDebug = uniform(0); // 假色调试通道：1=方向场 2=覆盖率（0 正常出图）
  // march 窗口（§裁定 4）：全部由布局派生，禁抄参考字面量
  // minBase 可能低于相机高度（塔的 billow 下推）→ t 起点必须为正，钳到 90 m
  const uSlabStartY = uniform(Math.max(win.minBase - 200, 90));
  const uTend = uniform(win.maxDistance + 1000);
  // 光照与调色（§裁定 5/8）
  const uLightDir = uniform(new THREE.Vector3(0, 0.2, -1));
  const initial = mapPalette(opts.bands ?? [[0.14, 0.16, 0.27], [0.17, 0.19, 0.33], [0.23, 0.19, 0.31], [0.27, 0.23, 0.29]], opts.haze ?? [0.15, 0.19, 0.31]);
  const uLit = uniform(new THREE.Vector3(...initial.lit));
  const uMid = uniform(new THREE.Vector3(...initial.mid));
  const uShade = uniform(new THREE.Vector3(...initial.shade));
  const uUnder = uniform(new THREE.Vector3(...initial.under));
  const uHaze = uniform(new THREE.Vector3(...initial.haze));

  // ---- TSL：billow 采样 / smin / bgMap（out 参数重组为 vec4 返回：d/base/scale + 包围球标志，§裁定 2 + Task 4） ----
  const billow = (q: any): any => texture3D(tex3d, q);
  const sminTsl = (a: any, b: any, k: any): any => {
    const h = max(k.sub(abs(a.sub(b))), 0).div(k);
    return min(a, b).sub(h.mul(h).mul(k).mul(0.25));
  };
  // 软边 alpha 的 TSL 形态（Task 4）：与纯函数 veilAlpha 同一语义（见其注释）。
  // 纯函数在 insideBound=false 或 nearSlack ≥ texelSlack 时为 0；TSL 版的调用点
  // 外层已有 If(near < uTexel) 守卫、insideBound ∈ {0,1}，代数上恒等于
  // insideBound × (1 − near/uTexel)——包围球外乘 0 归零，球内维持原表达式。
  const veilAlphaTsl = (nearSlack: any, texelSlack: any, insideBoundN: any): any =>
    insideBoundN.mul(float(1).sub(nearSlack.div(texelSlack)));

  const bgMap = Fn(([pImp, fineImp]: [any, any]) => {
    const p = pImp as any;
    const fine = fineImp as any;
    const d = float(1e9).toVar();
    // ROOTFIX：outBase/outScale 是「min 竞争胜者的属性」，9 云×16 puff 的胜者逐像素跳选
    // 才是 paint 侧噪声的真正来源。paint 已改用射线几何低频量，这两项不再计算也不再返回。
    // 第 4 分量 = p 是否落在某朵云的包围球内（Task 4）。**any 语义：出球不清零**——
    // p 可以同时落在多朵云的重叠球里；若按「球内分支 assign 1、外部分支 assign 0」
    // 的字面写法，后检查的云（含守卫外直接跳过）会把先前云置的 1 覆盖回 0（后者
    // 胜出），穿重叠球区的 grazing 射线整段被误报成球外，软边被切成硬边。初值 0
    // 恰好就是「球外」的取值，球内分支置 1，任意云包含即 1。
    const inside = float(0).toVar();
    // 固定圈数 + 守卫（零填充云 bounds.r=0 → db=|p|>0 恒走 early-out，无害）。
    // 历史取证（2026-11-15 Task 3 探针 → Task 3.5 bake.wgsl 复盘根治）：真因是
    // **WGSL 循环变量名遮蔽**——TSL 的 LoopNode 给每层循环的变量都命名为 `i`
    // （getVarName(0) 恒 'i'，getVar 不去重），而外层作用域构建的节点（element(i)、
    // float(i)）是惰性表达式，片段按「变量名 i」内联到使用点。凡在**内层 Loop 体内**
    // 引用的外层派生节点（云 bounds、uCloudInfo、捕获的云号）全部解析到内层计数器：
    // 守卫变成 i_inner < info[i_inner].y（夹具行 ≥1 零填充 nP=0 → 只有 i=0 放行），
    // 取数索引塌成内层号——Task 3 六种索引形态「恒读 puff0」与本任务首版纹理路径
    // 「texel(i, i)」都是这一个机制。修复 = 外层派生节点一律 .toVar() 快照成变量，
    // 内层体引用变量名，不再经过 i 的名字解析（bake.wgsl 复核：textureLoad 的行
    // 坐标是独立 var，守卫读 var.y）。march 数学、smin 组合、billow/fine 噪声采样
    // 逻辑原样未动；puff 数据源 = DataTexture texel 直读（索引 = 循环计数 → texel
    // 坐标，不经 uniformArray 下标）。
    // 详见 .superpowers/sdd/2026-11-14-bg-cumulus-visibility-and-variants/task-3.5-report.md。
    Loop(BG_CLOUD_LOOP_MAX, ({ i }: { i: number }) => {
      // 快照纪律：内层 Loop 体内要用的外层派生节点必须 toVar（见上「名遮蔽」取证）
      const cl = uClouds.element(int(i)).toVar();
      const db = length(p.sub(cl.xyz)).sub(cl.w);
      If(activeCloud(i), () => {
        // Marching can use the bounding sphere as a conservative step. Lighting
        // cannot differentiate that proxy: db + 150 jumps to the real cloud SDF
        // at the sphere boundary, producing vertical slabs in form-mode normals.
        // For macro lighting, skip only bounds already farther than the best
        // exact distance. The padded bounds enclose the smooth sphere union.
        const skipBound = db.greaterThan(0).and(fine.greaterThanEqual(0).or(db.greaterThan(d)));
        If(skipBound, () => {
          d.assign(min(d, db.add(150)));
        }).Else(() => {
        inside.assign(1); // march 分支必在球内；macro lighting 只消费返回值 x。
        const info = uCloudInfo.element(int(i)).toVar();
        const nP = info.y;
        const cloudIdx = float(i).toVar(); // 外层云号快照成变量——float(i) 片段在内层会被遮蔽
        const dc = float(1e9).toVar();
        // puff 几何 texel 直读：(u=列=puff 号, v=行=云号)——与 packPuffField 的打包
        // 布局同一约定（width=BG_PUFF_LOOP_MAX）。texel = (相对云包围心偏移 xyz, 半径)。
        // 列坐标 float(i) 是内层 puff 号（内层变量 i 本尊，正确目标）；行坐标 cloudIdx
        // 是外层云号快照（var）。uvec2=width 列优先：WGSL textureLoad 坐标 (x=列, y=行)。
        Loop(BG_PUFF_LOOP_MAX, ({ i }: { i: number }) => {
          If(float(i).lessThan(nP), () => {
            const s = textureLoad(puffTex, uvec2(float(i), cloudIdx));
            // puff 烘焙位置 = 云包围心（uClouds.xyz）+ 纹理偏移
            dc.assign(sminTsl(dc, length(p.sub(cl.xyz.add(s.xyz))).sub(s.w), s.w.mul(0.55)));
          });
        });
        const sc = info.w;
        const q = p.div(sc.mul(7.5)).add(vec3(cloudIdx.mul(0.37)));
        const n1 = billow(q);
        const lump = float(0.55).sub(n1.r).mul(2.4);
        If(fine.greaterThan(0), () => {
          lump.addAssign(float(0.55).sub(billow(q.mul(displacement.freq1).add(0.3)).r).mul(displacement.amp1));
          lump.addAssign(float(0.55).sub(billow(q.mul(displacement.freq2).add(0.7)).r).mul(displacement.amp2));
        });
        // 只压波动、补回均值：位移幅值减半（266→133m < puffR 171m，恢复 Lipschitz），
        // 用 +0.3 补偿 lump 均值的损失，避免云整体缩水。
        const dcB = dc.add(sc.mul(lump.mul(displacement.gain).add(displacement.shift))).toVar();
        // Negative detail selects the smooth sphere union for macro lighting.
        // The visible surface is still marched with its original detail.
        If(fine.lessThan(0), () => { dcB.assign(dc); });
        const under = info.z.sub(p.y).add(
          sc.mul(
            float(0.55)
              .mul(sin(p.x.div(sc.mul(2.3)).add(float(i))))
              .mul(sin(p.z.div(sc.mul(1.9)).add(1.7)))
              .add(float(0.3).mul(sin(p.x.div(sc.mul(0.9)).add(p.z.div(sc.mul(1.2)))))),
          ),
        );
        const kk = sc.mul(1.3);
        const hh = max(kk.sub(abs(dcB.sub(under))), 0).div(kk);
        const dcC = max(dcB, under).add(hh.mul(hh).mul(kk).mul(0.25));
        If(dcC.lessThan(d), () => {
          d.assign(dcC);
        });
        });
      });
    });
    return vec4(d, 0, 0, inside);
  });

  // ---- TSL：paint（参考 clouds.js:279-310；结构常数来自 PAINT_CONSTANTS） ----
  const k1c = vec3(1, -1, -1);
  const k2c = vec3(-1, -1, 1);
  const k3c = vec3(-1, 1, -1);
  const k4c = vec3(1, 1, 1);
  const paintTsl = Fn(([pImp, baseImp, scaleImp, pSImp]: [any, any, any, any]) => {
    const p = pImp as any;
    const pS = pSImp as any;
    // Task5 v4 Step2：base/scale 由 bakeFrag 的**射线几何软权重**给出（见 ancBase/ancScale）
    const base = baseImp as any;
    const scale = scaleImp as any;
    // 法线采样半径。⚠️ 这是**缓解**不是修复：把 1200m→400m 只压低了 Ns 的噪声幅度
    // （dot(Ns,L) 的 band4 从 29.85 降到 13.00），最终颜色里看起来干净是因为
    // smoothstep 压平了对比度。场本身仍然脏——根因是 SDF 位移 266m > puff 半径 171m。
    const eN = scale.mul(0.4);
    const lightDetail = float(formPaint ? -1 : 0);
    const dN1 = bgMap(pS.add(k1c.mul(eN)), lightDetail).x;
    const dN2 = bgMap(pS.add(k2c.mul(eN)), lightDetail).x;
    const dN3 = bgMap(pS.add(k3c.mul(eN)), lightDetail).x;
    const dN4 = bgMap(pS.add(k4c.mul(eN)), lightDetail).x;
    const Ns = normalize(k1c.mul(dN1).add(k2c.mul(dN2)).add(k3c.mul(dN3)).add(k4c.mul(dN4)));
    const eF = scale.mul(0.22);
    const dF1 = bgMap(pS.add(k1c.mul(eF)), float(1)).x;
    const dF2 = bgMap(pS.add(k2c.mul(eF)), float(1)).x;
    const dF3 = bgMap(pS.add(k3c.mul(eF)), float(1)).x;
    const dF4 = bgMap(pS.add(k4c.mul(eF)), float(1)).x;
    const Nf = formPaint ? Ns : normalize(k1c.mul(dF1).add(k2c.mul(dF2)).add(k3c.mul(dF3)).add(k4c.mul(dF4)));
    const N = normalize(Ns.mul(0.8).add(Nf));
    // L 径向项：原先吃抖的 p，现吃稳的 pS——entry 与 hit 在同一射线上，
    // 径向夹角差 <1°（实测 A/B 翻色的是 hgt/法线不是它），只去抖不改形。
    const L = normalize(
      uLightDir.add(vec3(0, PAINT_CONSTANTS.liftY, 0)).sub(
        normalize(vec3(pS.x, 0, pS.z)).mul(PAINT_CONSTANTS.radialPull),
      ),
    );
    const shNear = clamp(
      bgMap(pS.add(L.mul(scale.mul(PAINT_CONSTANTS.shadowNear))), lightDetail).x
        .negate().div(scale.mul(0.8)),
      0,
      1,
    ).mul(PAINT_CONSTANTS.shadowNearW);
    const shFar = clamp(
      bgMap(pS.add(L.mul(scale.mul(PAINT_CONSTANTS.shadowFar))), lightDetail).x
        .negate().div(scale.mul(1.4)),
      0,
      1,
    ).mul(PAINT_CONSTANTS.shadowFarW);
    const shadow = shNear.add(shFar);
    const open = clamp(
      bgMap(pS.add(Nf.mul(scale.mul(1.2))), float(formPaint ? -1 : 1)).x.div(scale.mul(1.2)),
      0,
      1,
    );
    const up = smoothstep(0, scale.mul(7), p.y.sub(base));
    const light = dot(N, L).mul(0.5).add(0.5).mul(exp(shadow.negate().mul(PAINT_CONSTANTS.lightExpo)))
      .add(up.mul(PAINT_CONSTANTS.litUp))
      .add(open.sub(0.5).mul(PAINT_CONSTANTS.litOpen))
      .add(N.y.mul(PAINT_CONSTANTS.litNy));
    const broad = dot(Ns, L).mul(0.5).add(0.5).mul(exp(shadow.negate()))
      .add(up.mul(PAINT_CONSTANTS.broadUp))
      .add(Ns.y.mul(PAINT_CONSTANTS.broadNy))
      // broadBillow 吃稳的 pS：billow 尺度 scale*16（~2700m），p 千米级抖动
      // 正好半个 cell——A/B 证明这是残留纹的主源之一；低频项换 pS 只去抖不改形。
      // 第二层 scale*5 取 g 通道（与第一层 b 通道去相关）：给纯色云补回画师式的
      // 柔和内部流动，但坐标仍是稳的 pS，抖不起来。
      .add(cleanPaint ? float(0) : billow(pS.div(scale.mul(16)).add(0.3)).b.sub(0.5).mul(PAINT_CONSTANTS.broadBillow))
      .add(cleanPaint ? float(0) : billow(pS.div(scale.mul(5)).add(0.7)).g.sub(0.5).mul(PAINT_CONSTANTS.broadBillowFine));
    // inShade *= 1 − 0.07·(1 − smoothstep(0.1, 0.18, open))（fold 加深，参考 clouds.js:307）
    const deepen = float(1).sub(smoothstep(PAINT_CONSTANTS.foldRange[0], PAINT_CONSTANTS.foldRange[1], open))
      .mul(PAINT_CONSTANTS.foldDeepen);
    const inShade = mix(uShade, uMid, smoothstep(PAINT_CONSTANTS.shadeMix[0], PAINT_CONSTANTS.shadeMix[1], broad))
      .mul(float(1).sub(deepen));
    // 暗部画师纹（稳坐标 pS，g 通道去相关）：broad 的两层 billow 在背光面会被
    // shadeMix（0.25~0.85）整段压平——上面的 Fine 层白加了。直接在 inShade 上做
    // ±10% 的乘性起伏，暗部终于有流动感；迎光面走 light 硬边不受影响。
    const shadeVar = cleanPaint ? float(0.5) : billow(pS.div(scale.mul(3)).add(1.3)).g;
    const inShadeV = inShade.mul(float(1).add(shadeVar.mul(0.2).sub(0.1)));
    // Keep the clean light/shade grouping, but do not flatten the entire lit
    // side to uLit. Reuse smooth shape normals and broad shadow probes, with
    // a wide, low-contrast ramp inside that band. No billow colour texture or
    // fine-detail normals: those were the source of the old marble pattern.
    const litForm = smoothstep(FORM_HIGHLIGHT.range[0], FORM_HIGHLIGHT.range[1], light);
    const litColor = formPaint
      ? mix(uMid, uLit, float(1).sub(litForm.oneMinus().mul(FORM_HIGHLIGHT.midBlend)))
        .mul(mix(FORM_HIGHLIGHT.minGain, 1, litForm))
      : uLit;
    const col = mix(inShadeV, litColor, smoothstep(PAINT_CONSTANTS.hardEdge[0], PAINT_CONSTANTS.hardEdge[1], light));
    const hgt = p.y.sub(base).div(scale.mul(PAINT_CONSTANTS.underScale));
    const result = mix(uUnder, col, smoothstep(PAINT_CONSTANTS.underMix[0], PAINT_CONSTANTS.underMix[1], hgt.add(light))).toVar();
    // Diagnostic values, not authored colours: bypass cloud haze below.
    If(uDebug.equal(6), () => { result.assign(Ns.mul(0.5).add(0.5)); });
    If(uDebug.equal(7), () => { result.assign(vec3(exp(shadow.negate()))); });
    return result;
  });

  // ---- TSL：烘焙 fragment（march + 描边 + 霾 + premultiplied；Discard 条带掩码） ----
  const bakeFrag = Fn(() => {
    const st = vec2(uv().x.mul(2).sub(1), uv().y.mul(2).sub(1));
    const rd = vec3(0, 0, 1).toVar();
    const outC = vec4(0, 0, 0, 0).toVar();
    // 面 → 方向（2026-11-14 取证改写：原 If/ElseIf×5 + Else 链在 uFace=4/5 时全链不赋值，
    // rd 停回 (0,0,1) → rd.y=0 被地平线门整面弃掉，±Z 两面永远烘不进去。改成无分支掩码。）
    // Task 3：分量常量改由 FACE_AXIS 表驱动（与 bakeFaceDirection 同一份，禁止复制数字）。
    const fIdx = uFace.toFloat();
    const mOf = (k: number) => float(1).sub(abs(fIdx.sub(k)).min(1));
    const pickNode = (c: FaceComponent): any => {
      switch (c) {
        case 'u':
          return st.x;
        case '-u':
          return st.x.negate();
        case 'v':
          return st.y;
        case '-v':
          return st.y.negate();
        case 'one':
          return float(1);
        case '-one':
          return float(-1);
      }
    };
    // 逐分量 mix 链：掩码互斥（uFace 恒为整数面号），整面上恰一项生效——
    // 与旧的手写链逐值等价，只是常量改读 FACE_AXIS。
    const comps = [0, 1, 2].map((axis) => {
      let acc = pickNode(FACE_AXIS[0][axis]);
      for (let f = 1; f < 6; f += 1) acc = mix(acc, pickNode(FACE_AXIS[f][axis]), mOf(f));
      return acc;
    });
    // MIRROR_X_COMPENSATION：three.js 的 WebGPU cubeTexture 在采样前把方向 x 取反
    // （three.webgpu.js CubeTextureNode.setupUV：coordinateSystem === WebGPU 分支的
    // uvNode.x.negate()，对 isRenderTargetTexture 也生效）。烘焙侧按 GL 约定写内容的
    // 话，az 90 的云会显示在 az 270——2026-11-15 探针实测（夹具云质心 271.5°）。
    // 烘焙射线 = 内容方向的 mirrorX 预补偿：只翻 x 分量，竖直轴符号不动
    // （rd.y = +st.y 是 6dc9dab 取证修好的链路，见 FACE_AXIS 行序注释）。
    if(opts.tiles) rd.assign(normalize(uTileForward.add(uTileRight.mul(st.x.mul(uTileHalf.x))).add(uTileUp.mul(st.y.mul(uTileHalf.y)))));
    else rd.assign(vec3(comps[0].negate(), comps[1], comps[2]));
    // 条带掩码（Task 0：Discard + autoClear=false）+ 水平线以下门（§裁定 4 的 0.002 防除零）。
    // 注意：Discard 必须用链式 .discard() 形式——If(cond, () => { Discard(); }) 会把
    // 整个片元输出吞掉（2026-11-14 输出级二分实证：链式形式正常，If 包装则整片被吞）。
    const v = uv().y;
    v.lessThan(uStripIndex.div(STRIPS_PER_FACE)).discard();
    v.greaterThanEqual(uStripIndex.add(1).div(STRIPS_PER_FACE)).discard();
    rd.y.lessThan(0.002).discard();
    const ro = uOrigin;
    const rdNpre = normalize(rd).toVar();
    // 假色 1：方向场（验证面/掩码/uv 指向）—— TSL 无提前 return，全部走 out 赋值
    If(uDebug.equal(1), () => {
      outC.assign(vec4(rdNpre.y.mul(0.5).add(0.5), rdNpre.x.mul(0.5).add(0.5), rdNpre.z.mul(0.5).add(0.5), 1));
    });
    // ---- march（假色模式下也照跑：调试路径不做性能优化，省得两套分支各自过期） ----
    // 起点钳到 [0, 2000]：参考的「从 slab 底面起飞」在这里是 t = (uSlabStartY − ro.y)/rd.y
    // （滑动太阳下约 20/rd.y），掠射视线（rd.y 只被门钳到 0.002）会算出 10 km —— 直接越过
    // 3–7 km 云带，那片像素永远采不到云。钳住上限后交给 SDF 自己推进。
    const t = clamp(uSlabStartY.sub(ro.y).div(rd.y), 0, 2000).toVar();
    const tEnd = uTend.toVar();
    const near = float(1e9).toVar();
    const tNear = t.toVar();
    const hit = float(0).toVar();
    const before = t.toVar();
    const rdN = normalize(rd).toVar();
    // Legacy paint's sphere-entry anchor (historical name hazeDepth). This can
    // jump at bounding-sphere tangencies: form paint uses the refined hit point,
    // and fog below must also use tHit rather than this acceleration proxy.
    const hazeDepth = float(tEnd).toVar();
    Loop(BG_CLOUD_LOOP_MAX, ({ i }: { i: number }) => {
      If(activeCloud(i), () => {
        const clH = uClouds.element(int(i)).toVar();
        const ocH = ro.sub(clH.xyz);
        const bH = dot(ocH, rdN);
        const cH = dot(ocH, ocH).sub(clH.w.mul(clH.w));
        const discH = bH.mul(bH).sub(cH);
        // 霾深度：球入射距离 tEnter（物理量，平滑；base/scale 由下方 anc* 软权重给）
        If(discH.greaterThan(0), () => {
          const tEnterH = bH.negate().sub(discH.max(0).sqrt());
          If(tEnterH.greaterThan(0), () => { hazeDepth.assign(min(hazeDepth, tEnterH)); });
        });
      });
    });
    // Task5 v4 Step2：base/scale 软锚定——权重 = exp(−closest/tau)，
    // closest 是**射线到球面的最近距离**（纯 ro/rdN 解析量），完全不含命中点 p 的撕裂噪声。
    // 硬选（outBase/outScale）会在重叠球间逐像素跳；吃 p 的软选同样跳（实测无效）。
    const ancBase = float(0).toVar();
    const ancScale = float(0).toVar();
    const ancW = float(0).toVar();
    Loop(BG_CLOUD_LOOP_MAX, ({ i }: { i: number }) => {
      If(activeCloud(i), () => {
        const clA = uClouds.element(int(i)).toVar();
        const infoA = uCloudInfo.element(int(i)).toVar();
        const tStarA = dot(clA.xyz.sub(ro), rdN);
        const closestA = length(ro.add(rdN.mul(tStarA)).sub(clA.xyz)).sub(clA.w);
        const wA = exp(closestA.div(PAINT_ANCHOR_TAU).negate());
        ancW.addAssign(wA);
        ancBase.addAssign(wA.mul(infoA.z));
        // scale：实测在本仓 puff 半径（171m）下，billow 尺度 140m 会让 hgt/up 归一化过紧
        // （p.y 的 SDF 撕裂被放大），反而比包围球半径更脏。沿用已验证的 bounds.r。
        ancScale.addAssign(wA.mul(formPaint ? infoA.w : clA.w));
      });
    });
    const ancWn = max(ancW, float(1e-4));
    const ancBaseN = ancBase.div(ancWn);
    const ancScaleN = ancScale.div(ancWn);

    // 是否进过任何包围球（Task 4）：march 每步 any-pass 累积，**不能用「最后一步
    // 胜出」**——球内出球（穿球而过但没命中云体）也是合法软边来源，最后一步会把它
    // 切成硬边（plan 评审采纳 any-pass：字面上更保守、更容易产生微量 alpha，但配合
    // 「背后云 coverageSky = 0」的探针验收，泄漏不会回来）。
    const insideBound = float(0).toVar();
    // P对照与A实验（Task5 Marble取证）：3=原P着色（pS取p，锚定不变，隔离pSmooth收益）；
    // 4=A粗march（march+二分fine=1→0，着色不变，测粗场命中是否更稳）。0=正常。
    const marchFine = float(1).toVar();
    If(uDebug.equal(4), () => { marchFine.assign(0); });
    Loop(STEPS, () => {
      If(t.lessThan(tEnd).and(hit.equal(0)), () => {
        const info = bgMap(ro.add(rdN.mul(t)), marchFine);
        insideBound.assign(max(insideBound, info.w));
        const d = info.x;
        If(d.lessThanEqual(0), () => {
          hit.assign(1);
        }).Else(() => {
          If(d.lessThan(near.mul(t)), () => {
            near.assign(d.div(t));
            tNear.assign(t);
          });
          before.assign(t);
          t.addAssign(max(d.mul(0.5), 30));
        });
      });
    });
    const alpha = float(0).toVar();
    const tHit = t.toVar();
    If(hit.equal(1), () => {
      const lo = before.toVar();
      const hi = t.toVar();
      Loop(9, () => {
        // Snapshot before either branch. Without toVar(), r186 emits the
        // shared expression's temporary INSIDE the positive branch only;
        // the negative branch then reads zero/the previous iteration's mid.
        // That sends hi outside [lo, hi], producing rings even on smooth SDFs.
        const mid = lo.add(hi).mul(0.5).toVar();
        If(bgMap(ro.add(rdN.mul(mid)), marchFine).x.greaterThan(0), () => {
          lo.assign(mid);
        }).Else(() => {
          hi.assign(mid);
        });
      });
      tHit.assign(hi);
      alpha.assign(1);
    }).Else(() => {
      If(near.lessThan(uTexel), () => {
        tHit.assign(tNear);
        // 软边 alpha 收尾（Task 4）：veilAlpha 的 TSL 等价式——只在射线进过
        // owning cloud 包围球时成立，球外恒 0（结构护栏；取证备注见 veilAlpha
        // 注释——当前 march 数学下球外 near ≥ 0.022 本就触发不了软边）。
        alpha.assign(veilAlphaTsl(near, uTexel, insideBound));
      });
    });
    // 假色 2：覆盖率（alpha 直出）
    If(uDebug.equal(2), () => {
      outC.assign(vec4(alpha, alpha, alpha, 1));
    });
    // 着色分支对 0/3/4 都要执行：原先嵌在 equal(0) 里，uDebug=3/4 时整支不跑，
    // 而增量重烘的 premultiplied 混合对 rgb=0/a=0 是 no-op——画布留下 init 期
    // fallback 色板的旧内容，3/4 两个取证开关形同虚设（2026-11-16 识图实测发现）。
    If(uDebug.equal(0).or(uDebug.greaterThanEqual(3)), () => {
      // 空像素显式 alpha=0，且必须整面都写：材质是 transparent + premultipliedAlpha
      // （不透明材质在 WebGPU 管线里会把片元 alpha 强制成 1，空 texel 就是「满覆盖」，
      // 天空合成 rgb + sky·(1−a) 被压成纯黑——2026-11-14 取证）。
      outC.assign(vec4(0, 0, 0, 0));
      If(alpha.greaterThan(0), () => {
        const p = ro.add(rdN.mul(tHit));
        const pSmooth = ro.add(rdN.mul(hazeDepth));
        // uDebug=3：原P着色对照——pS取p（锚定/haze保持新链路，只换差分输入）。
        const pS = (formPaint ? p : pSmooth).toVar();
        If(uDebug.equal(3), () => { pS.assign(p); });
        const col = paintTsl(p, ancBaseN, ancScaleN, pS);
        // Use the refined visible surface for fog. The nearest bounding-sphere
        // entry jumps when a ray grazes an unrelated cloud's empty padding,
        // leaving a second colour seam even after the normal field is fixed.
        const haze = float(1).sub(exp(tHit.negate().mul(HAZE_NEAR_GAIN).div(BG_HAZE_METRES)))
          .mul(mix(1, 0.45, smoothstep(0.03, 0.35, rdN.y)));
        outC.assign(vec4(mix(col, uHaze, haze).mul(alpha), alpha));
        If(uDebug.equal(5), () => {
          outC.assign(vec4(vec3(clamp(tHit.div(tEnd), 0, 1)).mul(alpha), alpha));
        });
        If(uDebug.equal(6).or(uDebug.equal(7)), () => {
          outC.assign(vec4(col.mul(alpha), alpha));
        });
      });
    });
    return outC;
  });

  // ---- 烘焙场景（全屏正交四边形；与主场景无关） ----
  // 烘焙材质必须能写 alpha：不透明材质在 WebGPU 管线里把片元 alpha 强制成 1
  // （2026-11-14 取证：assign 0 读回仍为 1，导致空 texel 也是"满覆盖"，天空被压成
  // 纯黑）。这里开 transparent + premultipliedAlpha：输出 rgb 已预乘 alpha，混合
  // 因子 One / OneMinusSrcAlpha 恰好把覆盖度累加到 alpha，空 texel 保留 clear 的 0。
  const bakeMat = new webgpu.MeshBasicNodeMaterial();
  bakeMat.transparent = true;
  bakeMat.premultipliedAlpha = true;
  // The target stores premultiplied RGBA; each strip replaces its previous
  // values, including zero-alpha texels. Transparency preserves shader alpha,
  // NoBlending prevents repeated edge coverage from accumulating.
  if (opts.replaceStrips || opts.tiles) {
    bakeMat.blending = THREE.NoBlending;
    // bakeFrag already premultiplies RGB. NodeMaterial would otherwise apply
    // alpha a second time in setupOutput(), darkening partially covered edges.
    bakeMat.premultipliedAlpha = false;
  }
  bakeMat.colorNode = bakeFrag();
  const bakeGeo = new THREE.PlaneGeometry(2, 2);
  const bakeScene = new THREE.Scene();
  bakeScene.add(new THREE.Mesh(bakeGeo, bakeMat));
  const bakeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const emptyScene = new THREE.Scene();
  // 空像素靠 clear 写 alpha=0：烘焙材质自己 assign 0 会被不透明管线强制成 1，
  // 只有 clear 路径真正保留 alpha（2026-11-14 取证）。材质已开 transparent +
  // premultipliedAlpha，写入的覆盖度会正确累加到 alpha 上。
  const clearFace = (f: number): void => {
    const previousColor = r.getClearColor(new THREE.Color());
    const previousAlpha = r.getClearAlpha();
    r.setRenderTarget(opts.tiles ? tileStaging[f] : staging, opts.tiles ? 0 : f);
    // 视口必须是面尺寸：渲染器当前视口属于游戏主循环（竖屏列坐标），在
    // 立方面上完全出界 → 零片元（2026-11-14 数值取证定位的真凶）。
    r.setViewport(0, 0, size, size);
    r.autoClear = true;
    r.setClearColor(0x000000, 0);
    r.render(emptyScene, bakeCam);
    r.setClearColor(previousColor, previousAlpha);
  };

  // ---- 条带调度状态 ----
  let disposed = false;
  let visible = true;
  let cursor = 0; // 0..39，循环推进
  let stale = 0;
  let cycleStrips = MAX_STRIPS_PER_FRAME;
  let paletteVersion = 0;
  let pendingPalette = initial;
  let pendingDebug = 0;
  let lastPaletteValues = [initial.lit, initial.mid, initial.shade, initial.under, initial.haze].flat();
  const prevLight: LightState = { azDeg: 0, elDeg: 0, paletteVersion: 0 };
  let haveLight = false;

  const bakeStrip = (face: number, strip: number): void => {
    uFace.value = face;
    if(opts.tiles) {
      const projection=projections[face];uTileIndex.value=face;
      uTileForward.value.copy(projection.forward);uTileRight.value.copy(projection.right);uTileUp.value.copy(projection.up);
      uTileHalf.value.set(projection.halfWidth/projection.distance,projection.halfHeight/projection.distance);
    }
    uStripIndex.value = strip;
    r.setRenderTarget(opts.tiles ? tileStaging[face] : staging, opts.tiles ? 0 : face);
    // 视口 = 面尺寸（同 clearFace 注释——不设则继承游戏竖屏视口，全出界）
    r.setViewport(0, 0, size, size);
    r.autoClear = false; // 带外内容保留（Task 0 机制）
    r.render(bakeScene, bakeCam);
  };

  const bakeAll = (): void => {
    if (disposed) return;
    // 先存下渲染器当前视口（主循环的竖屏列），烘完原样还回去——写死 1280×720 只是
    // 「大多数时候对了」，画布一变就把主画面挤出屏幕。
    const saved = new THREE.Vector4(0, 0, 1280, 720);
    if (r.getViewport) r.getViewport(saved);
    applySnapshot();
    cursor = 0;
    for (let f = 0; f < clearCount; f += 1) clearFace(f);
    for (let i = 0; i < totalStrips; i += 1) {
      bakeStrip(faceAt(cursor), cursor % STRIPS_PER_FACE);
      cursor = (cursor + 1) % totalStrips;
    }
    publish();
    stale = 0;
    r.setRenderTarget(null);
    r.setViewport(saved.x, saved.y, saved.z, saved.w);
    r.autoClear = true;
  };

  // ---- 初始化：光照先行（终审 C4：首烘必须用真实太阳方向，不能用默认光向） ----
  const sunDirLive = new THREE.Vector3(0, 0.2, -1);
  if (opts.sunDir) sunDirLive.copy(opts.sunDir);
  const el0 = (Math.asin(Math.max(-1, Math.min(1, sunDirLive.y))) * 180) / Math.PI;
  const blend0 = lightBlend([sunDirLive.x, sunDirLive.y, sunDirLive.z], el0);
  uLightDir.value.set(blend0.dir[0], blend0.dir[1], blend0.dir[2]);

  const applySnapshot = (): void => {
    const el = (Math.asin(Math.max(-1, Math.min(1, sunDirLive.y))) * 180) / Math.PI;
    const blend = lightBlend([sunDirLive.x, sunDirLive.y, sunDirLive.z], el);
    uLightDir.value.set(...blend.dir);
    const c = pendingPalette;
    uLit.value.set(...c.lit);
    uMid.value.set(...c.mid);
    uShade.value.set(...c.shade);
    uUnder.value.set(...c.under);
    uHaze.value.set(...c.haze);
    uDebug.value = pendingDebug;
    prevLight.azDeg = wrap180((Math.atan2(-sunDirLive.x, -sunDirLive.z) * 180) / Math.PI);
    prevLight.elDeg = el;
    prevLight.paletteVersion = paletteVersion;
    haveLight = true;
  };

  // ---- 全量首烘（首帧即有云，抓帧契约） ----
  bakeAll();
  const previousInputLight: LightState = { ...prevLight };
  r.setRenderTarget(null);
  r.setClearColor(0x000000, 1); // 恢复中性 clear（主循环由 post 管线管理目标）

  // 编译预热（init 期一次，运行时零编译）
  try {
    await r.compileAsync(bakeScene, bakeCam);
  } catch {
    // compileAsync 失败不阻断（首 render 仍会编译）
  }

  const handles: BgCumulusHandles = {
    tiles: opts.tiles ? projections.map((p,i)=>({...p,texture:tileTargets[i].texture})) : undefined,
    get count(): number {
      return layouts.length;
    },
    get texture(): THREE.Texture {
      return crt.texture;
    },

    update(_t: number, sunDir: THREE.Vector3, _cameraPos?: THREE.Vector3): void {
      if (disposed) return;
      if (sunDir && [sunDir.x, sunDir.y, sunDir.z].every(Number.isFinite) && sunDir.lengthSq() > 1e-9) {
        sunDirLive.copy(sunDir).normalize();
      }
      if (!visible) return;
      const next: LightState = {
        azDeg: wrap180((Math.atan2(-sunDirLive.x, -sunDirLive.z) * 180) / Math.PI),
        elDeg: (Math.asin(Math.max(-1, Math.min(1, sunDirLive.y))) * 180) / Math.PI,
        paletteVersion,
      };
      // Budget from consecutive inputs, not the older frozen bake snapshot.
      // Slow day/night motion keeps its one-strip budget across whole cycles.
      const movingLight = next.azDeg !== previousInputLight.azDeg || next.elDeg !== previousInputLight.elDeg;
      const incomingBudget = bakeBudget(previousInputLight, next, 0).strips;
      Object.assign(previousInputLight, next);
      // A manual time jump must not wait behind a 40-frame slow-daylight cycle.
      // Finish the current snapshot faster, then pick up the latest input.
      if (stale > 0) cycleStrips = Math.max(cycleStrips, incomingBudget);
      // Finish the frozen snapshot even if newer light/palette values arrive.
      // The next cycle picks those up; continuous changes cannot starve publish.
      if (stale === 0 && haveLight && bakeBudget(prevLight, next, 0).strips === 0) return;
      const saved = new THREE.Vector4(0, 0, 1280, 720);
      if (r.getViewport) r.getViewport(saved);
      const savedAutoClear = r.autoClear;
      try {
        if (stale === 0) {
          cycleStrips = movingLight ? Math.max(1, incomingBudget) : MAX_STRIPS_PER_FRAME;
          applySnapshot();
          cursor = 0;
          for (let f = 0; f < clearCount; f += 1) clearFace(f);
          stale = totalStrips;
        }
        const strips = Math.min(cycleStrips, stale);
        for (let i = 0; i < strips; i += 1) {
          bakeStrip(faceAt(cursor), cursor % STRIPS_PER_FACE);
          cursor = (cursor + 1) % totalStrips;
        }
        stale -= strips;
        if (stale === 0) publish();
      } finally {
        r.setRenderTarget(null);
        r.setViewport(saved.x, saved.y, saved.z, saved.w);
        r.autoClear = savedAutoClear;
      }
    },

    setLight(p: { bands: readonly Vec3[]; haze: Vec3 }): void {
      if (disposed) return;
      const c = mapPalette(p.bands, p.haze);
      const values = [c.lit, c.mid, c.shade, c.under, c.haze].flat();
      if (values.every((v, i) => Math.abs(v - lastPaletteValues[i]) < 1e-6)) return;
      lastPaletteValues = values;
      pendingPalette = c;
      paletteVersion += 1;
    },

    drawAll(): void {
      bakeAll();
    },

    setVisible(v: boolean): void {
      if (disposed) return;
      visible = v;
    },

    /** Switch diagnostics and invalidate all strips even when the light is stationary. */
    debugMode(n: number): void {
      const next = Number.isInteger(n) && n >= 0 && n <= 7 ? n : 0;
      if (disposed || pendingDebug === next) return;
      pendingDebug = next;
      paletteVersion += 1;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      bakeGeo.dispose();
      bakeMat.dispose();
      crt.dispose();
      staging.dispose();
      tileTargets.forEach(target=>target.dispose());
      tileStaging.forEach(target=>target.dispose());
      tex3d.dispose();
      puffTex.dispose();
    },
  };
  return handles;
}
