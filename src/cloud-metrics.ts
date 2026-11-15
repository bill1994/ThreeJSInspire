/**
 * src/cloud-metrics.ts — bg-cumulus 验收用的纯度量函数（无 DOM，node 下可测）。
 *
 * 这是"建尺子再动画面"计划（docs/superpowers/plans/2026-11-14-bg-cumulus-visibility-and-variants.md
 * Task 1）的度量底座：探针（scripts/cloud-probe.mjs）在页面内解码两张截图后用这里的
 * 函数差分、量包围盒、算覆盖率；后续任务的每个数字门槛都建立在这些返回值上。
 *
 * 语义约定（一次定死，同名绝不允许两种语义）：
 * - **所有矩形一律半开区间** `[x0,x1) × [y0,y1)`——输入的 region、返回的 bbox 都一样，
 *   `x1/y1` 指向最后一个有效像素的下一个。像素 (x,y) 属于区域当且仅当
 *   `x0 <= x < x1 && y0 <= y < y1`。
 * - 掩码值约定 `0 = 不变，非 0 = 差异命中`；`diffMask` 只产出 0/1。
 * - 差分取三通道最大绝对差，alpha 通道不参与（截图 alpha 恒 255）。
 * - 角换算用精确 gnomonic 式 `2·atan(tan(vFov/2)·px/H)`，**不是** `hFov·px/W`
 *   的近轴近似——224px 处近轴差 2.4%，会直接吃掉 Task 3 的 ±2° 判定余量。
 */

/** RGBA 图（如 getImageData / 解码后的截图帧）。 */
export type RgbaImage = { data: Uint8ClampedArray; width: number; height: number };

/** 半开矩形 `[x0,x1) × [y0,y1)`。 */
export type Rect = { x0: number; y0: number; x1: number; y1: number };

/** 把矩形夹进 [0,W]×[0,H] 并保证 x0<=x1、y0<=y1（探针传入的区域一律先走这里）。 */
function clampRect(r: Rect, width: number, height: number): Rect {
  return {
    x0: Math.min(Math.max(r.x0, 0), width),
    x1: Math.min(Math.max(r.x1, 0), width),
    y0: Math.min(Math.max(r.y0, 0), height),
    y1: Math.min(Math.max(r.y1, 0), height),
  };
}

/**
 * 逐像素三通道最大绝对差 `> threshold` 的二值掩码（0/1）。
 * `threshold` 为严格大于：差值恰好等于阈值不算命中。
 */
export function diffMask(a: RgbaImage, b: RgbaImage, threshold: number): Uint8Array {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`diffMask: size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  const n = a.width * a.height;
  const mask = new Uint8Array(n);
  const da = a.data;
  const db = b.data;
  for (let i = 0; i < n; i += 1) {
    const o = i * 4;
    const dr = Math.abs(da[o] - db[o]);
    const dg = Math.abs(da[o + 1] - db[o + 1]);
    const dbl = Math.abs(da[o + 2] - db[o + 2]);
    const max = dr > dg ? (dr > dbl ? dr : dbl) : dg > dbl ? dg : dbl;
    mask[i] = max > threshold ? 1 : 0;
  }
  return mask;
}

/**
 * 区域内命中像素的紧包围盒（半开边界）与像素数；空掩码返回 null。
 * 掩码值按"非 0 即命中"读，兼容任何 0/1 之外的标注值。
 */
export function bbox(
  mask: Uint8Array,
  width: number,
  height: number,
  region: Rect,
): (Rect & { count: number }) | null {
  const r = clampRect(region, width, height);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let y = r.y0; y < r.y1; y += 1) {
    const row = y * width;
    for (let x = r.x0; x < r.x1; x += 1) {
      if (mask[row + x] !== 0) {
        count += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1, count };
}

/** 精确 gnomonic 角量：`2·atan(tan(vFov/2)·px/H)`（度）。px、H 同单位（像素）。 */
function gnomonicDeg(px: number, canvasHeight: number, vFovDeg: number): number {
  const halfTan = Math.tan((vFovDeg * Math.PI) / 360);
  return (2 * Math.atan(halfTan * (px / canvasHeight)) * 180) / Math.PI;
}

/**
 * 横向像素跨度 → 渲染角宽（度）。gnomonic 精确式，等价于先算水平 FOV 再按像素
 * 比例取角；`canvasWidth` 在式中不出现（API 保留它以对齐调用方的量纲习惯）。
 */
export function angularWidthDeg(
  pixelWidth: number,
  canvasWidth: number,
  canvasHeight: number,
  vFovDeg: number,
): number {
  void canvasWidth;
  return gnomonicDeg(pixelWidth, canvasHeight, vFovDeg);
}

/** 纵向像素跨度 → 渲染角高（度）。同一 gnomonic 式；整幅跨度时回到 vFov 本身。 */
export function angularHeightDeg(
  pixelHeight: number,
  canvasHeight: number,
  vFovDeg: number,
): number {
  return gnomonicDeg(pixelHeight, canvasHeight, vFovDeg);
}

/** 区域内命中像素占区域像素数的比例；区域为空时返回 0。 */
export function coverageFraction(mask: Uint8Array, width: number, region: Rect): number {
  // 签名只收 width；行数由掩码长度反推（掩码恒为 width×height 的稠密数组）。
  const height = width > 0 ? Math.ceil(mask.length / width) : 0;
  const r = clampRect(region, width, height);
  const area = (r.x1 - r.x0) * (r.y1 - r.y0);
  if (area <= 0) return 0;
  let count = 0;
  for (let y = r.y0; y < r.y1; y += 1) {
    const row = y * width;
    for (let x = r.x0; x < r.x1; x += 1) {
      if (mask[row + x] !== 0) count += 1;
    }
  }
  return count / area;
}

/**
 * 掩码内的**带尺度**局部差分能量（0..255）：对每个中心与两个邻居（右侧/下方
 * `step` 像素）**都在掩码内**的像素，取邻居的三通道最大绝对差，再取两向最大，
 * 最后对样本求平均。无样本返回 0。
 *
 * 邻居也在掩码内是硬要求：掩码边界（云缘 vs 天空，差值上百）不属于「云内部的结构」，
 * 否则一条 1px 云缘会把整幅能量抬成噪声。
 *
 * 用途（bg-cumulus Task 5）：云底深色在 billow 颠簸面上画的「等高线状蠕虫」是
 * 4–8px 尺度的结构，step=4 正好落在它的尺度上；把云底色调改成低频驱动后，
 * 这个数应显著下降，而整幅覆盖率几乎不动（证明降的是结构噪声，不是云本身）。
 * 只测局部差分、不做 FFT：探针在页面里跑，够用且没有依赖。
 */
export function bandEnergyInMask(
  img: RgbaImage,
  mask: Uint8Array,
  width: number,
  height: number,
  step: number,
): number {
  if (width <= 0 || height <= 0) return 0;
  if (img.width !== width || img.height !== height) {
    throw new Error(`bandEnergyInMask: size mismatch ${img.width}x${img.height} vs ${width}x${height}`);
  }
  const s = Math.max(1, Math.floor(step));
  if (s >= height || s >= width) return 0;
  const d = img.data;
  let sum = 0;
  let n = 0;
  for (let y = 0; y < height - s; y += 1) {
    const row = y * width;
    for (let x = 0; x < width - s; x += 1) {
      if (mask[row + x] === 0) continue;
      if (mask[row + x + s] === 0 || mask[row + width * s + x] === 0) continue;
      const o = (row + x) * 4;
      const ox = o + s * 4;
      const oy = o + s * width * 4;
      const dx = Math.max(
        Math.abs(d[o] - d[ox]),
        Math.abs(d[o + 1] - d[ox + 1]),
        Math.abs(d[o + 2] - d[ox + 2]),
      );
      const dy = Math.max(
        Math.abs(d[o] - d[oy]),
        Math.abs(d[o + 1] - d[oy + 1]),
        Math.abs(d[o + 2] - d[oy + 2]),
      );
      sum += dx > dy ? dx : dy;
      n += 1;
    }
  }
  return n === 0 ? 0 : sum / n;
}
