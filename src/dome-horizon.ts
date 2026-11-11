/**
 * src/dome-horizon.ts — 地平线远云 patch 层：1200–1800 m 淡出带里的廉价背景云
 * （P1.5/horizon 计划 Task 7，2026-11-10）。
 *
 * deck 是有限距离的体积层，在 `DOME_SLAB.fadeStart..fadeEnd`（1200..1800）淡出；
 * 这一层用几张**平涂面片**把「海天线上永远有云」接住：距离/方位/尺寸/alpha 在
 * 朝向 bin 内恒定、随相机平移、不随 yaw 旋转——按「无穷远背景」处理。两层运动
 * 逻辑不同是明示取舍（patch 不随接近变大），不是 bug。
 *
 * 硬约束（设计 §11 / 用户裁定 R8/R9/S2/S10）：
 * - **散布方向**：正前方 = 玩家朝向。朝向量化滑窗 `HEADING_BIN_DEG 20°`，扇区 =
 *   bin 中心 ±40°；定位 `位置 = 相机 + d × (−sin θ, 0, −cos θ)`（0 = −Z、右转为负，
 *   与 `game.ts` 的 yaw 同约定——写成 (sin, cos) 会镜像到身后）。
 * - **alpha per-patch 固定 0.5–0.8**，没有距离淡出曲线（距离恒定后曲线只会让近端
 *   patch 永远半透明）；spec 数 = 可见数。唯一的淡入是补生 `PATCH_FADE_IN_S 0.15`
 *   （满舵 71.6°/s 下新楔形离视轴 ≥30°，0.17 s > 0.15 s，淡入在入画前走完）。
 * - **合并规则**：跨 bin 保留旧组里绝对方位落进新扇区的（原引用、azimuthDeg 原地
 *   换算），只从新组补生「新暴露楔形」；总数封顶 8，超了按离视轴远→近丢；
 *   `headingBinHysteresis` 带 2° 滞回防边界抖动。
 * - **模块图纪律**：本文件在 src 根，被 `module-graph.test.ts` 扫描——**禁止静态
 *   `import ... from 'three/webgpu' / 'three/tsl'`**。平涂面片根本不需要 TSL：
 *   纯 `three` 材质 + 顶点色（四档带色、per-patch alpha、柔边贴图）单材质单
 *   draw call 搞定。
 * - y 带 = `DOME_SLAB.base − 30 .. + 60`（350–440 m），跨在 deck 底缘上、海天线
 *   高度；60 m 机位平视时落在水平线上方 9.7–16.3°。Task 0.5 关雾后不被 fog 糊。
 *
 * 命名是 `domeHorizon`——`src/horizon.ts` 已被天空地平线占用。
 */

import * as THREE from 'three';

// FALLBACK 色与 deck 同源（首帧一致，正式色由 main.syncSun 单源灌入）。
import { FALLBACK_BANDS, FALLBACK_HAZE } from './dome-cloud';
import { DOME_SLAB } from './dome-cloud-field';
import { mulberry32 } from './puff-shape';
import type { Vec3 } from './sky-track';
import type { WorldView } from './world';

/** 朝向量化档距（度）：18 个 bin 覆盖 ±180°，±180° 共用 bin −9。 */
export const HEADING_BIN_DEG = 20;
/** 跨 bin 边界的滞回（度）：yaw 抖动不超过它就不换 bin，不补生不回收。 */
export const HEADING_BIN_HYST_DEG = 2;
/** 补生 patch 的淡入时长（秒）：满舵 12° 余量 = 0.17 s，入画前走完。 */
export const PATCH_FADE_IN_S = 0.15;

/** 每个朝向 bin 的 patch 数下限。 */
export const PATCH_COUNT_MIN = 3;
/** patch 总数封顶（滑窗合并后也 ≤ 此数；超了按离视轴远→近丢）。 */
export const PATCH_COUNT_MAX = 8;
/** patch 距离带（米）：落在 deck 淡出带 1200–1800 的中段。 */
export const PATCH_DISTANCE_MIN = 1300;
export const PATCH_DISTANCE_MAX = 1700;
/** patch 相对 bin 中心的最大方位角（度）：扇区 = 中心 ±40°。 */
export const PATCH_AZIMUTH_MAX_DEG = 40;
/** patch 宽度带（米）：1500 m 处 100 m ≈ 3.8°。 */
export const PATCH_SIZE_MIN = 80;
export const PATCH_SIZE_MAX = 200;
/** per-patch alpha 带：全部 ≥ 可见门 0.5（spec 数 = 可见数），≤ 0.8。 */
export const PATCH_ALPHA_MIN = 0.5;
export const PATCH_ALPHA_MAX = 0.8;
/** y 带下限/上限（米）：跨在 deck 底缘（`DOME_SLAB.base` 380）上。 */
export const PATCH_Y_MIN = DOME_SLAB.base - 30;
export const PATCH_Y_MAX = DOME_SLAB.base + 60;
/** patch 身高的宽高比：远积云比高，宽:高 2:1。 */
export const PATCH_ASPECT = 0.5;
/** 空气透视：patch 常驻 1300–1700 m 淡出带，向霾色靠这么多（0..1）。 */
export const PATCH_HAZE_MIX = 0.45;
/** 柔边 blob 贴图边长（px）。 */
const BLOB_TEXTURE_SIZE = 128;

/** 一个 patch 的静态散布 spec。`azimuthDeg` 相对 bin 中心；绝对方位 = bin 中心角 + azimuthDeg。 */
export interface PatchSpec {
  distanceMetres: number;
  azimuthDeg: number;
  yMetres: number;
  sizeMetres: number;
  alpha: number;
  /** patch 自身的小种子：挑贴图 UV 变体，避免同一窗口里几张脸完全一样。 */
  seed: number;
}

/** 对外句柄。`update` 做两件事：相机跟随平移 ＋ 朝向滑窗维护。 */
export interface DomeHorizonHandles {
  update(t: number, sunDir: THREE.Vector3, view?: WorldView): void;
  setCloudPalette(bands: readonly Vec3[], haze: Vec3): void;
  setSunColor(color: Vec3): void;
  setVisible(visible: boolean): void;
  dispose(): void;
  /** 当前存活的 patch 数（spec 数 = 可见数）。 */
  readonly count: number;
}

// ---- 纯函数：量化 / 散布 / 合并 / 定位 -------------------------------------------------

function wrap180(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/** 两绝对方位（度）的最小夹角 [0, 180]。 */
function angularDistanceDeg(a: number, b: number): number {
  return Math.abs(wrap180(a - b));
}

/**
 * yaw（度）→ 朝向 bin 序号 −9..8：`((round(yaw/20) + 9) mod 18) − 9`。
 * 0 = −Z、右转为负（与 `game.ts` 同约定）。±180° 共用 bin −9；
 * 输入超出 ±180（不该发生）也经双取模兜回 −9..8。
 */
export function headingBinIndex(yawDeg: number): number {
  if (!Number.isFinite(yawDeg)) return 0;
  const r = Math.round(yawDeg / HEADING_BIN_DEG);
  return ((((r + 9) % 18) + 18) % 18) - 9;
}

/**
 * 带滞回的 bin 选择：距当前 bin 中心超过半档 + 滞回（12°）才重新量化。
 * 换过去之后以新中心量距离，往回抖不出滞回带。currentBin 非有限（首帧）时
 * 直接量化。
 */
export function headingBinHysteresis(yawDeg: number, currentBin: number): number {
  if (!Number.isFinite(yawDeg)) return Number.isFinite(currentBin) ? currentBin : 0;
  if (Number.isFinite(currentBin)) {
    const d = angularDistanceDeg(yawDeg, currentBin * HEADING_BIN_DEG);
    if (d <= HEADING_BIN_DEG / 2 + HEADING_BIN_HYST_DEG) return currentBin;
  }
  return headingBinIndex(yawDeg);
}

/**
 * 一个 (seed, bin) 的确定性散布：3–8 团，距离 1300–1700 m、方位 ±40°、
 * y 350–440 m、宽 80–200 m、alpha 0.5–0.8（全部 ≥ 可见门）。同输入恒等，
 * 不同 bin 散布不同（滑窗补生的来源）。
 */
export function patchesFor(seed: number, binIndex: number): PatchSpec[] {
  const rand = mulberry32(((seed & 0xffff) * 0x9e37 + ((binIndex + 9) & 0xffff) * 0x85eb + 0x5eed) >>> 0);
  const count = PATCH_COUNT_MIN + Math.floor(rand() * (PATCH_COUNT_MAX - PATCH_COUNT_MIN + 1));
  const out: PatchSpec[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      distanceMetres: PATCH_DISTANCE_MIN + rand() * (PATCH_DISTANCE_MAX - PATCH_DISTANCE_MIN),
      azimuthDeg: (rand() * 2 - 1) * PATCH_AZIMUTH_MAX_DEG,
      yMetres: PATCH_Y_MIN + rand() * (PATCH_Y_MAX - PATCH_Y_MIN),
      sizeMetres: PATCH_SIZE_MIN + rand() * (PATCH_SIZE_MAX - PATCH_SIZE_MIN),
      alpha: PATCH_ALPHA_MIN + rand() * (PATCH_ALPHA_MAX - PATCH_ALPHA_MIN),
      seed: (((seed & 0xffff) * 131 + (binIndex + 9) * 61 + i * 17) >>> 0) % 1024,
    });
  }
  return out;
}

/**
 * 定位公式（S2 定案，符号别写反）：`offset = d × (−sin θ, −cos θ)`。
 * θ = 0 是正前（−Z），θ 为正是左（−X）——与 `game.ts` 的「右转为负」同约定；
 * (sin, cos) 是镜像到身后的错误写法。
 */
export function patchOffsetXZ(
  distanceMetres: number,
  absoluteAzimuthDeg: number,
): { x: number; z: number } {
  const t = (absoluteAzimuthDeg * Math.PI) / 180;
  return { x: -Math.sin(t) * distanceMetres, z: -Math.cos(t) * distanceMetres };
}

/**
 * 跨 bin 合并（S10）：旧组里绝对方位落进新扇区的**原引用保留**（azimuthDeg 原地
 * 换算成相对新 bin——滑窗滑的是坐标系，不是云，淡入状态跟着引用走）；新组只取
 * 「新暴露楔形」（在新扇区、且不在旧扇区）；总数封顶 8，超了按**离视轴远→近**丢。
 * 输入 oldSpecs 会被原地改写（本模块自己的存活列表，属约定内）。
 */
export function mergeHeadingPatches(
  oldBin: number,
  oldSpecs: readonly PatchSpec[],
  newBin: number,
  seed: number,
  viewAxisDeg: number,
): PatchSpec[] {
  const newCenter = newBin * HEADING_BIN_DEG;
  const oldCenter = oldBin * HEADING_BIN_DEG;

  const kept: PatchSpec[] = [];
  for (const s of oldSpecs) {
    const abs = oldCenter + s.azimuthDeg;
    if (angularDistanceDeg(abs, newCenter) <= PATCH_AZIMUTH_MAX_DEG) {
      s.azimuthDeg = wrap180(abs - newCenter);
      kept.push(s);
    }
  }

  const spawned: PatchSpec[] = [];
  for (const s of patchesFor(seed, newBin)) {
    const abs = newCenter + s.azimuthDeg;
    if (
      angularDistanceDeg(abs, newCenter) <= PATCH_AZIMUTH_MAX_DEG &&
      angularDistanceDeg(abs, oldCenter) > PATCH_AZIMUTH_MAX_DEG
    ) {
      spawned.push(s);
    }
  }

  const merged = [...kept, ...spawned];
  if (merged.length > PATCH_COUNT_MAX) {
    merged.sort(
      (a, b) =>
        angularDistanceDeg(viewAxisDeg, newCenter + a.azimuthDeg) -
        angularDistanceDeg(viewAxisDeg, newCenter + b.azimuthDeg),
    );
    merged.length = PATCH_COUNT_MAX;
  }
  return merged;
}

// ---- 贴图与材质（纯 three，无 TSL） ----------------------------------------------------

function smooth01(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/**
 * 柔边 blob 贴图：几颗高斯斑叠出来的糙面剪影，矩形四边保证衰减到 0
 * （柔边，quad 轮廓永不出硬线）。DataTexture 生成，node 下同样可造。
 */
function buildSoftBlobTexture(size: number): THREE.DataTexture {
  const rand = mulberry32(0x51ab1e);
  const blobs: { x: number; y: number; r: number; w: number }[] = [];
  for (let i = 0; i < 6; i += 1) {
    blobs.push({
      x: 0.3 + rand() * 0.4,
      y: 0.32 + rand() * 0.36,
      r: 0.16 + rand() * 0.2,
      w: 0.55 + rand() * 0.6,
    });
  }
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      let acc = 0;
      for (const b of blobs) {
        const dx = (u - b.x) / b.r;
        const dy = (v - b.y) / b.r;
        acc += b.w * Math.exp(-(dx * dx + dy * dy) * 0.5);
      }
      const edge =
        smooth01(u / 0.16) * smooth01((1 - u) / 0.16) * smooth01(v / 0.16) * smooth01((1 - v) / 0.16);
      const a = Math.min(1, Math.max(0, acc * 0.7)) * edge;
      const idx = (y * size + x) * 4;
      data[idx] = 255;
      data[idx + 1] = 255;
      data[idx + 2] = 255;
      data[idx + 3] = Math.round(a * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** 同一 (seed, bin) 里每团一个 UV 变体（镜像组合），免得几张脸一模一样。 */
const UV_VARIANTS: readonly (readonly [number, number])[][] = [
  [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ], // 原样
  [
    [1, 0],
    [0, 0],
    [0, 1],
    [1, 1],
  ], // 水平镜像
  [
    [0, 1],
    [1, 1],
    [1, 0],
    [0, 0],
  ], // 垂直镜像
  [
    [1, 1],
    [0, 1],
    [0, 0],
    [1, 0],
  ], // 双镜像
];

/** 单扇区最多 8 团；几何按 8 个 quad 预留，空位收成零面积三角形。 */
const MAX_PATCHES = 8;
/** 每 quad 顶点顺序：bl, br, tr, tl。 */
const VERTS_PER_PATCH = 4;

function mix3(a: Vec3, b: Vec3, t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * 挂载：单材质（MeshBasicMaterial + 柔边贴图 + 顶点色 RGBA）单 mesh（8 quad 合批
 * → 单 draw call）。失败只丢这一层，由 world 的 try/catch 接住。
 */
export function initDomeHorizon(
  scene: THREE.Scene,
  options: { seed: number; bands?: readonly Vec3[]; sunDir?: THREE.Vector3 },
): DomeHorizonHandles {
  const seed = options.seed;
  const bands: Vec3[] = (options.bands && options.bands.length >= 4
    ? options.bands
    : FALLBACK_BANDS
  ).map((b) => [b[0], b[1], b[2]]);
  let haze: Vec3 = [FALLBACK_HAZE[0], FALLBACK_HAZE[1], FALLBACK_HAZE[2]];
  const sunColor: [number, number, number] = [1, 1, 1];
  const sunLive = new THREE.Vector3(0, 0.2, -1).normalize();
  if (options.sunDir && Number.isFinite(options.sunDir.x) && options.sunDir.lengthSq() > 1e-9) {
    sunLive.copy(options.sunDir).normalize();
  }

  // ---- 几何：8 quad 合批，位置/颜色/UV 每帧重写（约 300 个 float，可忽略） ----
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(MAX_PATCHES * VERTS_PER_PATCH * 3);
  const colors = new Float32Array(MAX_PATCHES * VERTS_PER_PATCH * 4); // RGBA：顶点级 alpha
  const uvs = new Float32Array(MAX_PATCHES * VERTS_PER_PATCH * 2);
  const indices = new Uint16Array(MAX_PATCHES * 6);
  for (let i = 0; i < MAX_PATCHES; i += 1) {
    const v = i * VERTS_PER_PATCH;
    indices.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
  }
  const posAttr = new THREE.BufferAttribute(positions, 3);
  const colAttr = new THREE.BufferAttribute(colors, 4);
  const uvAttr = new THREE.BufferAttribute(uvs, 2);
  geometry.setAttribute('position', posAttr);
  geometry.setAttribute('color', colAttr);
  geometry.setAttribute('uv', uvAttr);
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6);

  const texture = buildSoftBlobTexture(BLOB_TEXTURE_SIZE);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    vertexColors: true, // itemSize 4 → three 自动启用顶点级 alpha
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    // Task 0.5 同款教训：scene.fog(60, 700) 会把 1300–1700 m 的 patch 全糊成雾色。
    fog: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'dome-horizon';
  mesh.frustumCulled = false;
  // deck（renderOrder 1）之后画：patch 在盒内、合成是遮挡不是叠加。
  mesh.renderOrder = 2;
  scene.add(mesh);

  // ---- 朝向滑窗状态 ----
  let disposed = false;
  let currentBin = Number.NaN; // 首帧哨兵：headingBinHysteresis 对 NaN 直接量化
  let live: PatchSpec[] = [];
  let born: number[] = [];
  let camX = 0;
  let camZ = 0;
  let haveCam = false;

  const rebuildWindow = (nextBin: number, yawDeg: number, now: number): void => {
    if (!Number.isFinite(currentBin) || live.length === 0) {
      // 初次挂载：整扇区直接入场（born −∞ → 不淡入，首帧捕获必须已可见）。
      live = patchesFor(seed, nextBin);
      born = live.map(() => Number.NEGATIVE_INFINITY);
    } else {
      const bornMap = new Map<PatchSpec, number>();
      live.forEach((s, i) => bornMap.set(s, born[i]));
      const merged = mergeHeadingPatches(currentBin, live, nextBin, seed, yawDeg);
      if (merged.length === 0) {
        // 兜底（理论可能：旧组全出扇区且楔形无补生）：重铺整扇区，前方永远有云。
        live = patchesFor(seed, nextBin);
        born = live.map(() => Number.NEGATIVE_INFINITY);
      } else {
        live = merged;
        born = merged.map((s) => bornMap.get(s) ?? now); // 补生的从现在起淡入
      }
    }
    currentBin = nextBin;
  };

  const writeGeometry = (now: number): void => {
    const sunYaw = wrap180((Math.atan2(-sunLive.x, -sunLive.z) * 180) / Math.PI);
    for (let i = 0; i < MAX_PATCHES; i += 1) {
      const v = i * VERTS_PER_PATCH;
      if (i >= live.length || !haveCam) {
        // 空位/尚无相机：零面积三角形，不产生任何片元。
        for (let k = 0; k < VERTS_PER_PATCH; k += 1) {
          positions[(v + k) * 3] = 0;
          positions[(v + k) * 3 + 1] = 0;
          positions[(v + k) * 3 + 2] = 0;
          colors[(v + k) * 4] = 0;
          colors[(v + k) * 4 + 1] = 0;
          colors[(v + k) * 4 + 2] = 0;
          colors[(v + k) * 4 + 3] = 0;
        }
        continue;
      }
      const spec = live[i];
      const absDeg = currentBin * HEADING_BIN_DEG + spec.azimuthDeg;
      const off = patchOffsetXZ(spec.distanceMetres, absDeg);
      const cx = camX + off.x;
      const cz = camZ + off.z;
      const cy = spec.yMetres;

      // 竖直面片水平朝向相机（绕 Y 的 billboard；低空平视机位不做俯仰足够）。
      const fx = camX - cx;
      const fz = camZ - cz;
      const fl = Math.hypot(fx, fz) || 1;
      const rx = -fz / fl;
      const rz = fx / fl;
      const hw = spec.sizeMetres * 0.5;
      const hh = spec.sizeMetres * PATCH_ASPECT * 0.5;

      // 补生淡入（唯一的 alpha 时间项；初始扇区 born −∞ → 恒 1）。
      const age = now - born[i];
      const fadeIn = age >= PATCH_FADE_IN_S ? 1 : Math.max(0, age / PATCH_FADE_IN_S);
      const a = spec.alpha * fadeIn;

      // 色语言与 puff/deck 同款四档：背光剪影（band0 底/band1 顶）→ 迎光（band2/3）。
      const delta = wrap180(absDeg - sunYaw);
      const lit01 = 0.5 - 0.5 * Math.cos((delta * Math.PI) / 180);
      let bottom = mix3(bands[0], bands[2], lit01);
      let top = mix3(bands[1], bands[3], lit01);
      // 受光项只压在顶半（?sunoff=1 时归零——证伪开关依然亮着底色）。
      top = [top[0] + sunColor[0] * 0.35 * lit01, top[1] + sunColor[1] * 0.35 * lit01, top[2] + sunColor[2] * 0.35 * lit01];
      // 空气透视：常驻淡出带的远景向霾色靠。
      bottom = mix3(bottom, haze, PATCH_HAZE_MIX);
      top = mix3(top, haze, PATCH_HAZE_MIX);

      const uv = UV_VARIANTS[Math.abs(Math.floor(spec.seed)) % UV_VARIANTS.length];
      const px = [cx - rx * hw, cx + rx * hw, cx + rx * hw, cx - rx * hw];
      const py = [cy - hh, cy - hh, cy + hh, cy + hh];
      const pz = [cz - rz * hw, cz + rz * hw, cz + rz * hw, cz - rz * hw];
      for (let k = 0; k < VERTS_PER_PATCH; k += 1) {
        positions[(v + k) * 3] = px[k];
        positions[(v + k) * 3 + 1] = py[k];
        positions[(v + k) * 3 + 2] = pz[k];
        const isTop = k >= 2;
        const c = isTop ? top : bottom;
        colors[(v + k) * 4] = c[0];
        colors[(v + k) * 4 + 1] = c[1];
        colors[(v + k) * 4 + 2] = c[2];
        colors[(v + k) * 4 + 3] = a;
        uvs[(v + k) * 2] = uv[k][0];
        uvs[(v + k) * 2 + 1] = uv[k][1];
      }
    }
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    uvAttr.needsUpdate = true;
  };

  return {
    get count(): number {
      return live.length;
    },

    update(t: number, sunDir: THREE.Vector3, view?: WorldView): void {
      if (disposed) return;
      const now = Number.isFinite(t) ? t : 0;
      if (sunDir && Number.isFinite(sunDir.x) && Number.isFinite(sunDir.z) && sunDir.lengthSq() > 1e-9) {
        sunLive.copy(sunDir).normalize();
      }
      if (view?.camera && Number.isFinite(view.camera.x) && Number.isFinite(view.camera.z)) {
        camX = view.camera.x;
        camZ = view.camera.z;
        haveCam = true;
      }
      if (view && Number.isFinite(view?.headingRad)) {
        const yawDeg = wrap180((view.headingRad * 180) / Math.PI);
        const nextBin = headingBinHysteresis(yawDeg, currentBin);
        if (!Number.isFinite(currentBin) || nextBin !== currentBin) {
          rebuildWindow(nextBin, yawDeg, now);
        }
      }
      writeGeometry(now);
    },

    setCloudPalette(nextBands: readonly Vec3[], nextHaze: Vec3): void {
      if (disposed) return;
      if (nextBands && nextBands.length >= 4) {
        for (let i = 0; i < 4; i += 1) bands[i] = [nextBands[i][0], nextBands[i][1], nextBands[i][2]];
      }
      if (nextHaze) haze = [nextHaze[0], nextHaze[1], nextHaze[2]];
    },

    setSunColor(color: Vec3): void {
      if (disposed) return;
      if (color) {
        sunColor[0] = color[0];
        sunColor[1] = color[1];
        sunColor[2] = color[2];
      }
    },

    setVisible(visible: boolean): void {
      if (disposed) return;
      mesh.visible = visible;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      scene.remove(mesh);
      geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}
