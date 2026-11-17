/**
 * src/cloud-mask.ts — 云的**遮罩判据**（matte oracle），替代像素差分探针当正确性基准。
 *
 * 为什么另起一把尺子：`scripts/cloud-probe.mjs` 的差分法量的是「开关某层后变了多少
 * 像素」，它落在后处理（toon 阶跃、bloom、DOF、dither）之后，阈值 24/12 是手调的，
 * 且 on/off 两帧之间隔着 2 帧真步进而海面在动——它只能当整帧回归报警器，不能判
 * 「云画在对的位置」。本模块换三个前提：
 *
 * 1. **不含后处理**：判据读的是云自己的输出（背景云的 CubeRenderTarget / 近景云
 *    单独的 RT），不经过 toon/bloom/DOF，也没有 8-bit 抖动。
 * 2. **不做差分**：不做 on/off 相减，直接问「这个纹素/像素上有没有云」。分母是几何
 *    面积本身（立体角或像素数），不是另一张截图。
 * 3. **阈值只剩「有没有」**：`0` 与 `>0` 的边界，不是「差值大于 24」。剩余不确定度
 *    只有半浮点量化（1e-4 量级），比手调阈值低两个数量级。
 *
 * 两个来源各有一套量纲，不要混：
 *
 * - **背景云**（bg-cumulus，烘进 `CubeRenderTarget`）：覆盖率 = 命中纹素的**立体角
 *   之和 / 4π**。与相机、视口、FOV 全部无关，同一份烘培在任何窗口尺寸下读数相同。
 *   每个纹素的立体角用球面四边形的闭式解精确求积（见 `cubeTexelSolidAngle`），
 *   不是「均分 4π/(6·size²)」的近似——立方图参数化 (x/z, y/z) 不保面积，均分会
 *   让面心附近偏大、面角偏小。
 * - **近景云**（puff 系 mesh）：覆盖率 = 命中像素数 / 区域像素数，像素来自一张
 *   只含云的隔离 pass（调用方负责把云放上专用 layer、清屏为黑、绕开 post）。
 *
 * 用法分两步，判据与渲染解耦：
 *
 *     // ① 读一张遮罩（两种来源各一个 reader）
 *     const faces = await readCubeMaskFaces(renderer, world.cloudTexture, size);
 *     // ② 算覆盖率（纯函数，node 下可测）
 *     const { fraction } = cubeMaskCoverage(faces, size);
 *
 * 本文件不 import three：纯函数在 node/vitest 下跑，reader 只要求调用方传进来的
 * renderer 具备 `readRenderTargetPixelsAsync`（three r186 WebGPURenderer 有）。
 */

import { bbox, coverageFraction } from './cloud-metrics';
import type { Rect } from './cloud-metrics';

/** 立方图 6 面的球面总面积。 */
export const CUBE_TOTAL_SOLID_ANGLE = 4 * Math.PI;

/** 单面球面立体角的闭式值 2π/3（4π 的 1/6）。 */
export const CUBE_FACE_SOLID_ANGLE = (2 * Math.PI) / 3;

/** 判据用的最小非零阈值：只区分「没有云」与「有云」，不是可调的美学阈值。 */
export const MASK_EPSILON = 1e-4;

/** 立方图面序，与 three 的 `CubeTexture`/`CubeRenderTarget` 的 `faceIndex` 一致。 */
export const CUBE_FACE_DIRECTIONS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0], // 0 +X
  [-1, 0, 0], // 1 -X
  [0, 1, 0], // 2 +Y
  [0, -1, 0], // 3 -Y
  [0, 0, 1], // 4 +Z
  [0, 0, -1], // 5 -Z
];

/** 一张立方图面的原始纹素（半浮点用 Uint16Array，UNC8 用 Uint8Array，均 RGBA）。 */
export type CubeFaceData = Uint16Array | Uint8Array;

/** 读取遮罩的 renderer 最小契约（只用到 this one 方法）。 */
export interface RenderTargetPixelReader {
  readRenderTargetPixelsAsync: (
    target: unknown,
    x: number,
    y: number,
    width: number,
    height: number,
    textureIndex?: number,
    faceIndex?: number,
  ) => Promise<ArrayBufferView>;
}

/**
 * 半浮点 → 浮点（IEEE 754 binary16 解包）。`CubeRenderTarget` 用的是
 * `HalfFloatType`，读回来的是 Uint16Array，必须先解包再判 0。
 */
export function halfToFloat(h: number): number {
  const sign = (h & 0x8000) !== 0 ? -1 : 1;
  const exponent = (h & 0x7c00) >> 10;
  const fraction = h & 0x03ff;
  if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024);
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : NaN;
  return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
}

/**
 * 一个纹素在单位球面上的精确立体角。
 *
 * 立方图第 `i` 个纹素在 `z=1` 平面上覆盖矩形 `[x1,x2]×[y1,y2]`（角点取纹素边界，
 * 参数 `s,t ∈ [-1,1]`），该矩形对原点的立体角有闭式球面盈余解：
 *
 *     Ω = atan2(x2·y2, √(x2²+y2²+1)) − atan2(x2·y1, √(x2²+y1²+1))
 *       − atan2(x1·y2, √(x1²+y2²+1)) + atan2(x1·y1, √(x1²+y1²+1))
 *
 * 整面求和精确等于 `2π/3`（六面 4π），不是采样近似——单测钉住这条恒等式。
 */
export function cubeTexelSolidAngle(i: number, j: number, size: number): number {
  if (size <= 0) throw new Error('cubeTexelSolidAngle: size must be positive');
  if (i < 0 || j < 0 || i >= size || j >= size) {
    throw new Error(`cubeTexelSolidAngle: texel (${i},${j}) outside ${size}x${size}`);
  }
  const x1 = (2 * i) / size - 1;
  const x2 = (2 * (i + 1)) / size - 1;
  const y1 = (2 * j) / size - 1;
  const y2 = (2 * (j + 1)) / size - 1;
  const at = (x: number, y: number): number => Math.atan2(x * y, Math.sqrt(x * x + y * y + 1));
  return at(x2, y2) - at(x2, y1) - at(x1, y2) + at(x1, y1);
}

/** 单面 `size×size` 纹素的立体角表（行主序，与 readback 的排列一致）。 */
export function cubeFaceSolidAngleTable(size: number): Float64Array {
  const table = new Float64Array(size * size);
  for (let j = 0; j < size; j += 1) {
    for (let i = 0; i < size; i += 1) {
      table[j * size + i] = cubeTexelSolidAngle(i, j, size);
    }
  }
  return table;
}

/** 纹素是否「有云」。半浮点解包后取三通道最大；UNC8 直接比 0。 */
function texelHasContent(data: CubeFaceData, offset: number): boolean {
  if (data instanceof Uint16Array) {
    // 半浮点：任一非零通道即命中。清屏是 0，云的贡献必然 > 0。
    const r = halfToFloat(data[offset]);
    const g = halfToFloat(data[offset + 1]);
    const b = halfToFloat(data[offset + 2]);
    return r > MASK_EPSILON || g > MASK_EPSILON || b > MASK_EPSILON;
  }
  return data[offset] > 0 || data[offset + 1] > 0 || data[offset + 2] > 0;
}

export interface CubeCoverage {
  /** 命中立体角 / 4π，0..1。 */
  fraction: number;
  /** 命中立体角（球面度）。 */
  coveredSolidAngle: number;
  /** 恒定 4π，写进读数便于对账。 */
  totalSolidAngle: number;
  /** 命中的纹素个数（6 面合计，仅作交叉核对，不参与 fraction）。 */
  coveredTexels: number;
  /** 纹素总数 6·size²。 */
  totalTexels: number;
}

/**
 * 立方图遮罩 → 球面覆盖率。`faces` 必须是 6 张、每张 `size²·4` 的 RGBA 数组
 * （半浮点 Uint16Array 或 UNC8 Uint8Array，两者可混用）。
 *
 * 这是背景云的**正确性判据**：分母是 4π 的球面积，与相机/视口/FOV 无关；同一份
 * 烘培在任何窗口尺寸下都读同一个数。
 */
export function cubeMaskCoverage(faces: readonly CubeFaceData[], size: number): CubeCoverage {
  if (faces.length !== 6) {
    throw new Error(`cubeMaskCoverage: need 6 faces, got ${faces.length}`);
  }
  const table = cubeFaceSolidAngleTable(size);
  const expected = size * size * 4;
  let coveredSolidAngle = 0;
  let coveredTexels = 0;
  for (let f = 0; f < 6; f += 1) {
    const face = faces[f];
    if (!face || face.length !== expected) {
      throw new Error(
        `cubeMaskCoverage: face ${f} has ${face?.length ?? 0} values, expected ${expected}`,
      );
    }
    for (let t = 0; t < size * size; t += 1) {
      if (texelHasContent(face, t * 4)) {
        coveredSolidAngle += table[t];
        coveredTexels += 1;
      }
    }
  }
  return {
    fraction: coveredSolidAngle / CUBE_TOTAL_SOLID_ANGLE,
    coveredSolidAngle,
    totalSolidAngle: CUBE_TOTAL_SOLID_ANGLE,
    coveredTexels,
    totalTexels: 6 * size * size,
  };
}

/**
 * 方向 → 立方图纹素坐标（最近邻），按 OpenGL/three 的标准立方图面映射：
 *
 *     +X: sc=-z, tc=-y   -X: sc=+z, tc=-y
 *     +Y: sc=+x, tc=+z   -Y: sc=+x, tc=-z
 *     +Z: sc=+x, tc=-y   -Z: sc=-x, tc=-y
 *     u = (sc/ma + 1)/2,  v = (tc/ma + 1)/2,  ma = max(|x|,|y|,|z|)
 *
 * ⚠️ 这是**标准映射**，不是本项目的烘焙映射。背景云的烘焙侧对内容做了
 * mirrorX 预补偿（见 `bg-cumulus.ts` 的 FACE_AXIS 注释与 `rd.x.negate()`），
 * 所以拿它做「az=90 的夹具云落在哪个纹素」的判定前，必须先用 `?bgforce=single`
 * 跑一次符号对账；对不上就翻这里，别去改烘焙。
 *
 * 另：`readRenderTargetPixelsAsync` 的行序是 GL 自下而上，与本函数 v 轴方向相反；
 * 但 Ω 对 t → -t 对称，所以 `cubeMaskCoverage` 的总立体角与这个翻转无关。
 */
export function cubeTexelForDirection(
  dir: readonly [number, number, number],
  size: number,
): { face: number; x: number; y: number } {
  const [dx, dy, dz] = dir;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const az = Math.abs(dz);
  const ma = Math.max(ax, ay, az);
  if (ma === 0) throw new Error('cubeTexelForDirection: zero direction');
  let face: number;
  let sc: number;
  let tc: number;
  if (ma === ax) {
    if (dx >= 0) {
      face = 0;
      sc = -dz;
    } else {
      face = 1;
      sc = dz;
    }
    tc = -dy;
  } else if (ma === ay) {
    if (dy >= 0) {
      face = 2;
      sc = dx;
      tc = dz;
    } else {
      face = 3;
      sc = dx;
      tc = -dz;
    }
  } else {
    if (dz >= 0) {
      face = 4;
      sc = dx;
    } else {
      face = 5;
      sc = -dx;
    }
    tc = -dy;
  }
  const x = Math.min(size - 1, Math.max(0, Math.floor(((sc / ma + 1) / 2) * size)));
  const y = Math.min(size - 1, Math.max(0, Math.floor(((tc / ma + 1) / 2) * size)));
  return { face, x, y };
}

/**
 * 逐面读回立方图遮罩（半浮点用 Uint16Array 缓冲，`readRenderTargetPixelsAsync`
 * 要求缓冲类型与目标纹理类型一致）。
 *
 * 注意：`textureIndex` 是附件序号，`faceIndex` 是立方面序号——两者顺序写反是最
 * 常见的踩坑（r186 签名见 three 的 `Renderer.readRenderTargetPixelsAsync`）。
 */
export async function readCubeMaskFaces(
  renderer: RenderTargetPixelReader,
  cubeTarget: unknown,
  size: number,
  options: { halfFloat?: boolean } = {},
): Promise<CubeFaceData[]> {
  const halfFloat = options.halfFloat !== false;
  const faces: CubeFaceData[] = [];
  for (let f = 0; f < 6; f += 1) {
    const buffer = halfFloat ? new Uint16Array(size * size * 4) : new Uint8Array(size * size * 4);
    const got = await renderer.readRenderTargetPixelsAsync(cubeTarget, 0, 0, size, size, 0, f);
    const src = new Uint8Array(got.buffer, got.byteOffset, got.byteLength);
    // 缓冲类型一致时直接拷；不一致说明调用方传错了 halfFloat 标志。
    if (got instanceof Uint16Array) {
      (buffer as Uint16Array).set(got);
    } else if (got instanceof Uint8Array && !halfFloat) {
      (buffer as Uint8Array).set(got);
    } else {
      throw new Error(
        `readCubeMaskFaces: readback returned ${got.constructor.name}, expected ` +
          `${halfFloat ? 'Uint16Array (HalfFloatType target)' : 'Uint8Array (RGBA8 target)'}` +
          `${src.byteLength ? '' : ''}`,
      );
    }
    faces.push(buffer);
  }
  return faces;
}

/**
 * 隔离 pass 的 RGBA 像素 → 0/1 遮罩（1 = 该像素上有云）。
 *
 * 调用约定：调用方把云放到专用 layer、`camera.layers.set(layer)`、清屏为黑、
 * 直接 `renderer.setRenderTarget(maskRT); render(scene, camera)` 绕开 post。
 * 于是「黑 = 没有云」是构造出来的，不是猜出来的——这里只做 `>0` 的二值化。
 */
export function maskFromPixels(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array {
  const n = width * height;
  if (pixels.length < n * 4) {
    throw new Error(`maskFromPixels: need ${n * 4} values, got ${pixels.length}`);
  }
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const o = i * 4;
    mask[i] = pixels[o] > 0 || pixels[o + 1] > 0 || pixels[o + 2] > 0 ? 1 : 0;
  }
  return mask;
}

export interface ScreenMaskStats {
  /** 命中像素的紧包围盒（半开）与像素数；空遮罩为 null。 */
  bbox: (Rect & { count: number }) | null;
  /** 区域内命中比例，0..1。 */
  fraction: number;
  /** 区域的像素面积（分母），便于对账。 */
  area: number;
}

/**
 * 隔离 pass 遮罩 → 屏幕覆盖率读数。矩形与比例语义直接复用 `cloud-metrics`
 * 的单一定义（半开区间、非 0 即命中），避免两套脚注。
 */
export function screenMaskStats(
  mask: Uint8Array,
  width: number,
  height: number,
  region: Rect = { x0: 0, y0: 0, x1: width, y1: height },
): ScreenMaskStats {
  const box = bbox(mask, width, height, region);
  const x0 = Math.min(Math.max(region.x0, 0), width);
  const x1 = Math.min(Math.max(region.x1, 0), width);
  const y0 = Math.min(Math.max(region.y0, 0), height);
  const y1 = Math.min(Math.max(region.y1, 0), height);
  return {
    bbox: box,
    fraction: coverageFraction(mask, width, region),
    area: Math.max(0, x1 - x0) * Math.max(0, y1 - y0),
  };
}

/**
 * 近景云的专用 layer。取 7 是因为 0..3 常用于常规分组、`camera.layers` 只有 32 位
 * 且本项目未占用 7；改这里要同步隔离 pass 的 `camera.layers.set()`。
 */
export const CLOUD_MASK_LAYER = 7;

/**
 * 把一个对象（连同子节点）放上遮罩 layer，**保留**它原有的 layer——
 * `Object3D.layers.enable()` 是叠加，不覆盖，所以主渲染路径不受影响。
 */
export function tagOnMaskLayer(root: { traverse: (cb: (o: any) => void) => void }): void {
  root.traverse((o: any) => {
    if (o && o.layers && typeof o.layers.enable === 'function') o.layers.enable(CLOUD_MASK_LAYER);
  });
}
