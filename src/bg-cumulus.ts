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
 * 纹理化 + toVar 快照根治，见 packPuffField 与 bgMap 注释）。
 * 参考 clouds.js:218-364 逐式移植；差异点全在计划 §裁定：尺度带布局派生
 * （uSlabStartY/tEnd 禁抄 520/14500/56000）、64 步预算、霾长 12000、
 * Discard 条带（参考的 8 条带/面分帧语义保留）、premultiplied 输出。
 */

import * as THREE from 'three';

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
  lightBlend,
  mapPalette,
} from './bg-cumulus-paint';
import type { Vec3 } from './sky-track';

/** march 步数（§裁定 4：布局派生尺度的重推预算，spike 验证余量）。 */
export const STEPS = 64;
/** 霾长（米，§裁定 4：7 km 处 ≈44% 混入，远景沉进天色）。 */
export const BG_HAZE_METRES = 12000;
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

/**
 * 相机锚定重烘阈值（米）。立方图必须从相机位置烘焙：云带在 3–7 km，相机飞 5 km
 * 后同一张图的云方向会整体偏掉十几度。位移超过这个值就搬原点 + 全量重烘
 * （40 条带 / 8 条带每帧 = 5 帧收敛，160 km/h 下约每 5.6 s 一次）。
 */
export const REBAKE_METRES = 250;

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
 * - **偏移而非绝对坐标**：puff 世界位 = uClouds.xyz + 偏移。recentre 只平移
 *   uClouds，打包结果对整场平移逐位不变（单测钉）——纹理一次上传后永不重打包。
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
   * 每帧泵：算 bakeBudget、烘 N 条带、推 uLightDir；`cameraPos` 给了就做
   * 「相机锚定重烘」（位移超 REBAKE_METRES 时把烘焙原点搬到相机并全量重烘）。
   */
  update(t: number, sunDir: THREE.Vector3, cameraPos?: THREE.Vector3): void;
  /** 调色板推送（cloudBands/cloudHaze → 五色 uniform，paletteVersion 递增）。 */
  setLight(p: { bands: readonly Vec3[]; haze: Vec3 }): void;
  /** 全量重烘：仅 init/loading 路径（运行时禁用——§裁定 6）。 */
  drawAll(): void;
  /** 开关：关时停止烘焙（天空侧 uCloudOn 由 world 回调链处理）。 */
  setVisible(visible: boolean): void;
  /** 假色调试（0 关 1 方向场 2 覆盖率）。 */
  debugMode(n: number): void;
  dispose(): void;
  readonly count: number;
  readonly texture: THREE.Texture;
}

/**
 * 挂载。renderer 由 world 转发（main.ts initWorld 已持有）；opts.quality 来自
 * ?bgq=（Task 5 qa.ts 解析，clamp 512..2048 并受 device 上限约束）；
 * opts.forceLayout 是标定台夹具（Task 2：?bgforce=single → main 构造
 * singleCloudLayout → world.bgForceLayout 透传），给了就整个换掉 seed 环排布。
 */
export async function initBgCumulus(
  renderer: unknown,
  opts: { seed: number; sunDir?: THREE.Vector3; quality?: number; bands?: readonly [number, number, number][]; haze?: [number, number, number]; forceLayout?: CloudLayout[] },
): Promise<BgCumulusHandles> {
  const r = renderer as {
    setRenderTarget: (t: unknown, face?: number) => void;
    render: (s: THREE.Scene, c: THREE.Camera) => void;
    autoClear: boolean;
    setClearColor: (c: number, a: number) => void;
    setViewport: (x: number, y: number, w: number, h: number) => void;
    getViewport?: (t: THREE.Vector4) => THREE.Vector4;
    compileAsync: (s: THREE.Scene, c: THREE.Camera) => Promise<unknown>;
    backend?: { device?: { limits?: { maxTextureDimension2D?: number } } };
  };

  const webgpu = (await import('three/webgpu')) as any;
  const tsl = (await import('three/tsl')) as any;
  const { Fn, If, Loop, Discard, uniform, uniformArray, texture3D, textureLoad, uvec2, uv, vec2, vec3, vec4, float, int } = tsl;
  const { abs, max, min, mix, normalize, dot, exp, sin, smoothstep, clamp, length } = tsl;

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
  // recentre 只平移 uClouds，纹理一次上传后永不重打包（packPuffField 平移不变性有单测钉）。
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
    2048,
    Number.isFinite(deviceLimit) ? (deviceLimit as number) : 2048,
  );

  // ---- 烘焙目标 ----
  const crt = new webgpu.CubeRenderTarget(size, { format: THREE.RGBAFormat, type: THREE.HalfFloatType });

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

  // ---- 云场跟着相机走 ----
  // 布局是「绕世界原点一圈 3–7 km 的远云」。相机航线能到 20 km 外，云若钉死不重排，
  // 飞过云环之后天空就是空的（2026-11-14 实测：z=−18.8 km 处一朵都没有）。这里保留
  // 布局的**相对**几何，每次搬原点把云整体平移到相机周围，于是永远是 3–7 km 外的背景。
  const boundBase = boundVals.map((v) => v.clone());
  const baseYs = layouts.map((c) => c.base);
  /** 布局坐标系的原点（生成云场时用的视点高度）。 */
  const LAYOUT_ORIGIN = new THREE.Vector3(0, 70, 0);
  const recentre = (dx: number, dy: number, dz: number): void => {
    for (let i = 0; i < boundBase.length; i += 1) {
      const b = boundBase[i];
      boundVals[i].set(b.x + dx, b.y + dy, b.z + dz, b.w);
    }
    // uCloudInfo = (first, nP, base, scale)：base 在 .z，nP 在 .y。曾误写 .y——
    // nP 被云底高度覆盖后，内层 puff 守卫放行零填充球（s.w=0 → smin 的 k=0 →
    // 0/0=NaN 污染整条 SDF），recentre 之后的每一条带都烘成空，autoClear=false
    // 的条带机制把 init 烘焙的旧内容永久留在天上（2026-11-15 探针取证：云方位
    // 随相机漂移 −5.8°、角宽冻结）。
    for (let i = 0; i < baseYs.length; i += 1) infoVals[i].z = baseYs[i] + dy;
    // puff 几何随云包围心平移自动跟随：纹理存的是相对偏移（对整场平移逐位不变，
    // packPuffField 平移不变性有单测钉），puff 世界位 = uClouds.xyz + 偏移——
    // recentre 不触碰纹理（Task 3.5 起该链路只剩 uniform 路径）。
  };

  const uClouds = uniformArray(boundVals, 'vec4');
  const uCloudInfo = uniformArray(infoVals, 'vec4');
  const uCount = uniform(layouts.length);
  const uFace = uniform(0);
  const uStripIndex = uniform(0);
  const uTexel = uniform(3 / size);
  // 烘焙原点：**相机位置**。立方图是一张从某个点看出去的天空，相机在这个 app 里
  // 飞 3–11 km，若固定在 (0,70,0) 烘焙，云的方向会随相机位移整体打歪（2026-11-14
  // 取证：相机 (0,66.8,−6053) 时视野内只剩一张静态穹顶的画面）。update() 收到
  // 相机位移超阈值时把原点搬过去并全量重烘。
  const uOrigin = uniform(new THREE.Vector3(0, 70, 0));
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

  // ---- TSL：billow 采样 / smin / bgMap（out 参数重组为 vec3 返回，§裁定 2） ----
  const billow = (q: any): any => texture3D(tex3d, q);
  const sminTsl = (a: any, b: any, k: any): any => {
    const h = max(k.sub(abs(a.sub(b))), 0).div(k);
    return min(a, b).sub(h.mul(h).mul(k).mul(0.25));
  };

  const bgMap = Fn(([pImp, fineImp]: [any, any]) => {
    const p = pImp as any;
    const fine = fineImp as any;
    const d = float(1e9).toVar();
    const outBase = float(1200).toVar();
    const outScale = float(300).toVar();
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
      If(float(i).lessThan(uCount), () => {
        If(db.greaterThan(0), () => {
          d.assign(min(d, db.add(150)));
        }).Else(() => {
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
            // puff 世界位 = 云包围心（uClouds.xyz，recentre 平移它）+ 纹理偏移
            dc.assign(sminTsl(dc, length(p.sub(cl.xyz.add(s.xyz))).sub(s.w), s.w.mul(0.55)));
          });
        });
        const sc = info.w;
        const q = p.div(sc.mul(7.5)).add(vec3(cloudIdx.mul(0.37)));
        const n1 = billow(q);
        const lump = float(0.55).sub(n1.r).mul(2.4);
        If(fine.greaterThan(0), () => {
          lump.addAssign(float(0.55).sub(billow(q.mul(2.7).add(0.3)).r));
          lump.addAssign(float(0.55).sub(billow(q.mul(7.3).add(0.7)).r).mul(0.36));
        });
        const dcB = dc.add(sc.mul(lump));
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
          outBase.assign(info.z);
          outScale.assign(sc);
        });
        });
      });
    });
    return vec3(d, outBase, outScale);
  });

  // ---- TSL：paint（参考 clouds.js:279-310；结构常数来自 PAINT_CONSTANTS） ----
  const k1c = vec3(1, -1, -1);
  const k2c = vec3(-1, -1, 1);
  const k3c = vec3(-1, 1, -1);
  const k4c = vec3(1, 1, 1);
  const paintTsl = Fn(([pImp, baseImp, scaleImp]: [any, any, any]) => {
    const p = pImp as any;
    const base = baseImp as any;
    const scale = scaleImp as any;
    const eN = scale.mul(1.2);
    const dN1 = bgMap(p.add(k1c.mul(eN)), float(0)).x;
    const dN2 = bgMap(p.add(k2c.mul(eN)), float(0)).x;
    const dN3 = bgMap(p.add(k3c.mul(eN)), float(0)).x;
    const dN4 = bgMap(p.add(k4c.mul(eN)), float(0)).x;
    const Ns = normalize(k1c.mul(dN1).add(k2c.mul(dN2)).add(k3c.mul(dN3)).add(k4c.mul(dN4)));
    const eF = scale.mul(0.65);
    const dF1 = bgMap(p.add(k1c.mul(eF)), float(1)).x;
    const dF2 = bgMap(p.add(k2c.mul(eF)), float(1)).x;
    const dF3 = bgMap(p.add(k3c.mul(eF)), float(1)).x;
    const dF4 = bgMap(p.add(k4c.mul(eF)), float(1)).x;
    const Nf = normalize(k1c.mul(dF1).add(k2c.mul(dF2)).add(k3c.mul(dF3)).add(k4c.mul(dF4)));
    const N = normalize(Ns.mul(0.8).add(Nf));
    // L = normalize(lightDir + (0, liftY, 0) − radial·pull)（参考 clouds.js:293 + §裁定 8 的兜底语义）
    const L = normalize(
      uLightDir.add(vec3(0, PAINT_CONSTANTS.liftY, 0)).sub(
        normalize(vec3(p.x, 0, p.z)).mul(PAINT_CONSTANTS.radialPull),
      ),
    );
    const shNear = clamp(
      bgMap(p.add(L.mul(scale.mul(PAINT_CONSTANTS.shadowNear))), float(0)).x
        .negate().div(scale.mul(0.8)),
      0,
      1,
    ).mul(PAINT_CONSTANTS.shadowNearW);
    const shFar = clamp(
      bgMap(p.add(L.mul(scale.mul(PAINT_CONSTANTS.shadowFar))), float(0)).x
        .negate().div(scale.mul(1.4)),
      0,
      1,
    ).mul(PAINT_CONSTANTS.shadowFarW);
    const shadow = shNear.add(shFar);
    const open = clamp(
      bgMap(p.add(Nf.mul(scale.mul(1.2))), float(1)).x.div(scale.mul(1.2)),
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
      .add(billow(p.div(scale.mul(16)).add(0.3)).b.sub(0.5).mul(PAINT_CONSTANTS.broadBillow));
    // inShade *= 1 − 0.07·(1 − smoothstep(0.1, 0.18, open))（fold 加深，参考 clouds.js:307）
    const deepen = float(1).sub(smoothstep(PAINT_CONSTANTS.foldRange[0], PAINT_CONSTANTS.foldRange[1], open))
      .mul(PAINT_CONSTANTS.foldDeepen);
    const inShade = mix(uShade, uMid, smoothstep(PAINT_CONSTANTS.shadeMix[0], PAINT_CONSTANTS.shadeMix[1], broad))
      .mul(float(1).sub(deepen));
    const col = mix(inShade, uLit, smoothstep(PAINT_CONSTANTS.hardEdge[0], PAINT_CONSTANTS.hardEdge[1], light));
    const hgt = p.y.sub(base).div(scale.mul(PAINT_CONSTANTS.underScale));
    return mix(uUnder, col, smoothstep(PAINT_CONSTANTS.underMix[0], PAINT_CONSTANTS.underMix[1], hgt.add(light)));
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
    rd.assign(vec3(comps[0].negate(), comps[1], comps[2]));
    // 条带掩码（Task 0：Discard + autoClear=false）+ 水平线以下门（§裁定 4 的 0.002 防除零）。
    // 注意：Discard 必须用链式 .discard() 形式——If(cond, () => { Discard(); }) 会把
    // 整个片元输出吞掉（2026-11-14 输出级二分 P2/P4 实证，probe4 的链式形式则正常）。
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
    Loop(STEPS, () => {
      If(t.lessThan(tEnd).and(hit.equal(0)), () => {
        const d = bgMap(ro.add(rdN.mul(t)), float(1)).x;
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
        const mid = lo.add(hi).mul(0.5);
        If(bgMap(ro.add(rdN.mul(mid)), float(1)).x.greaterThan(0), () => {
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
        alpha.assign(float(1).sub(near.div(uTexel)));
      });
    });
    // 假色 2：覆盖率（alpha 直出）
    If(uDebug.equal(2), () => {
      outC.assign(vec4(alpha, alpha, alpha, 1));
    });
    If(uDebug.equal(0), () => {
      // 空像素显式 alpha=0，且必须整面都写：材质是 transparent + premultipliedAlpha
      // （不透明材质在 WebGPU 管线里会把片元 alpha 强制成 1，空 texel 就是「满覆盖」，
      // 天空合成 rgb + sky·(1−a) 被压成纯黑——2026-11-14 取证）。
      outC.assign(vec4(0, 0, 0, 0));
      If(alpha.greaterThan(0), () => {
        const p = ro.add(rdN.mul(tHit));
        const info = bgMap(p, float(1));
        const col = paintTsl(p, info.y, info.z);
        // 霾（§裁定 4：BG_HAZE_METRES=12000；参考 clouds.js:362 的形状）
        const haze = float(1).sub(exp(tHit.negate().div(BG_HAZE_METRES)))
          .mul(mix(1, 0.45, smoothstep(0.03, 0.35, rdN.y)));
        outC.assign(vec4(mix(col, uHaze, haze).mul(alpha), alpha));
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
    r.setRenderTarget(crt, f);
    // 视口必须是面尺寸：渲染器当前视口属于游戏主循环（竖屏列坐标），在
    // 立方面上完全出界 → 零片元（2026-11-14 数值取证定位的真凶）。
    r.setViewport(0, 0, size, size);
    r.autoClear = true;
    r.setClearColor(0x000000, 0);
    r.render(emptyScene, bakeCam);
  };

  // ---- 条带调度状态 ----
  let disposed = false;
  let visible = true;
  let cursor = 0; // 0..39，循环推进
  let stale = 0;
  let paletteVersion = 0;
  let lastPaletteFp = Number.NaN;
  const prevLight: LightState = { azDeg: 0, elDeg: 0, paletteVersion: 0 };
  let haveLight = false;

  const bakeStrip = (face: number, strip: number): void => {
    uFace.value = face;
    uStripIndex.value = strip;
    r.setRenderTarget(crt, face);
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
    for (let f = 0; f < 6; f += 1) clearFace(f);
    for (let i = 0; i < TOTAL_STRIPS; i += 1) {
      bakeStrip(BAKE_FACES[Math.floor(cursor / STRIPS_PER_FACE)], cursor % STRIPS_PER_FACE);
      cursor = (cursor + 1) % TOTAL_STRIPS;
    }
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

  // ---- 全量首烘（首帧即有云，抓帧契约） ----
  bakeAll();
  r.setRenderTarget(null);
  r.setClearColor(0x000000, 1); // 恢复中性 clear（主循环由 post 管线管理目标）

  // 编译预热（init 期一次，运行时零编译）
  try {
    await r.compileAsync(bakeScene, bakeCam);
  } catch {
    // compileAsync 失败不阻断（首 render 仍会编译）
  }

  const handles: BgCumulusHandles = {
    get count(): number {
      return layouts.length;
    },
    get texture(): THREE.Texture {
      return crt.texture;
    },

    update(_t: number, sunDir: THREE.Vector3, cameraPos?: THREE.Vector3): void {
      if (disposed) return;
      if (sunDir && Number.isFinite(sunDir.x) && sunDir.lengthSq() > 1e-9) sunDirLive.copy(sunDir);
      // uLightDir：未归一混合向量（§裁定 8；shader 加 lift 后归一）
      const el = (Math.asin(Math.max(-1, Math.min(1, sunDirLive.y))) * 180) / Math.PI;
      const blend = lightBlend([sunDirLive.x, sunDirLive.y, sunDirLive.z], el);
      uLightDir.value.set(blend.dir[0], blend.dir[1], blend.dir[2]);
      if (!visible) return; // 关云时停烘
      // 相机锚定：立方图是「从某点看出去的天空」，相机飞远后不重烘就是一张贴错位置的
      // 静态穹顶（§裁定 1 的有限半径视差）。位移超 REBAKE_METRES 时搬原点并全量重烘。
      if (cameraPos && Number.isFinite(cameraPos.x)) {
        const moved = (uOrigin.value as THREE.Vector3).distanceTo(cameraPos);
        if (moved > REBAKE_METRES) {
          const o = uOrigin.value as THREE.Vector3;
          // 用「相对布局原点的绝对位移」重算，不用增量：增量式重定心在第二次搬原点时
          // 会把之前的位移丢掉，云会一点点爬回世界原点（2026-11-14 实测）。
          recentre(cameraPos.x - LAYOUT_ORIGIN.x, cameraPos.y - LAYOUT_ORIGIN.y, cameraPos.z - LAYOUT_ORIGIN.z);
          o.copy(cameraPos);
          stale = TOTAL_STRIPS;
        }
      }
      const az = wrap180((Math.atan2(-sunDirLive.x, -sunDirLive.z) * 180) / Math.PI);
      const next: LightState = { azDeg: az, elDeg: el, paletteVersion };
      if (!haveLight) {
        prevLight.azDeg = az;
        prevLight.elDeg = el;
        prevLight.paletteVersion = paletteVersion;
        haveLight = true;
        // 首帧登记按 dirty 处理（终审 C4）：init 烘焙用 fallback 色板，正式轨道色
        // 由首帧 syncSun 灌入后需全量追平——标记 stale 让后续帧 8 条带/帧收敛。
        stale = TOTAL_STRIPS;
        return;
      }
      const bb = bakeBudget(prevLight, next, stale);
      stale = bb.staleStrips;
      prevLight.azDeg = next.azDeg;
      prevLight.elDeg = next.elDeg;
      prevLight.paletteVersion = next.paletteVersion;
      if (bb.strips > 0) {
        const saved = new THREE.Vector4(0, 0, 1280, 720);
        if (r.getViewport) r.getViewport(saved);
        for (let i = 0; i < bb.strips; i += 1) {
          bakeStrip(BAKE_FACES[Math.floor(cursor / STRIPS_PER_FACE)], cursor % STRIPS_PER_FACE);
          cursor = (cursor + 1) % TOTAL_STRIPS;
        }
        r.setRenderTarget(null);
        r.setViewport(saved.x, saved.y, saved.z, saved.w); // 还原主循环视口
        r.autoClear = true;
      }
    },

    setLight(p: { bands: readonly Vec3[]; haze: Vec3 }): void {
      if (disposed) return;
      const c = mapPalette(p.bands, p.haze);
      // 色值指纹：syncSun 逐帧灌同值时不递增 paletteVersion（否则 idle-stop 永远
      // 不生效——每帧 1 条带 1024² 重烘 = 1 fps 的根因，2026-11-14 取证）。
      const fp = [c.lit, c.mid, c.shade, c.under, c.haze].flat().reduce((a, v) => a + v, 0);
      if (Math.abs(fp - lastPaletteFp) < 1e-4) return;
      lastPaletteFp = fp;
      (uLit.value as THREE.Vector3).set(c.lit[0], c.lit[1], c.lit[2]);
      (uMid.value as THREE.Vector3).set(c.mid[0], c.mid[1], c.mid[2]);
      (uShade.value as THREE.Vector3).set(c.shade[0], c.shade[1], c.shade[2]);
      (uUnder.value as THREE.Vector3).set(c.under[0], c.under[1], c.under[2]);
      (uHaze.value as THREE.Vector3).set(c.haze[0], c.haze[1], c.haze[2]);
      paletteVersion += 1;
    },

    drawAll(): void {
      bakeAll();
    },

    setVisible(v: boolean): void {
      if (disposed) return;
      visible = v;
    },

    /** 假色调试（Task 3 冒烟 / Task 6 目检）：0 关、1 方向场、2 覆盖率。 */
    debugMode(n: number): void {
      uDebug.value = n;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      bakeGeo.dispose();
      bakeMat.dispose();
      crt.dispose();
      tex3d.dispose();
      puffTex.dispose();
    },
  };
  return handles;
}
