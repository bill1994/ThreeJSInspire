/**
 * src/dome-cloud-noise.ts — 穹顶云的密度场生成（纯 TS，node 下可测）。
 *
 * 三张图，全部确定性生成（同 seed 同字节），运行时不重烘：
 *
 * - `generateShapeVolume`：128³ 的骨架。低中频，决定云块的大瓣与「天花板」形状。
 * - `generateDetailVolume` ：32³ 的侵蚀细节。Worley，负责把边缘啃成毛边。
 * - `generateWeatherMap`   ：512² 的天气图。2D，决定云块在哪儿、覆盖度多少。
 *
 * **形状层不叠 Worley**：128³ × 27 邻域的 Worley 在启动时要几秒，而 128³ 的
 * 花椰菜轮廓其实来自 32³ detail 的侵蚀。Worley 只放在便宜的层上。
 *
 * 所有噪声都在格子坐标上取模，因此**可平铺**——3D 纹理平铺时不会出现接缝。
 *
 * 2026-11-09 首版。设计见
 * `docs/superpowers/specs/2026-11-09-dome-cloud-volumetric-design.md` §5.2。
 */

/** 32 位整数哈希（`Math.imul` 保证不溢出成 double）。 */
function hash3(ix: number, iy: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 374761393);
  h = Math.imul(h ^ Math.imul(iy, 668265263), 1274126177);
  h = Math.imul(h ^ Math.imul(iz, 2147483647), 1274126177);
  h = Math.imul(h ^ seed, 2246822519);
  h ^= h >>> 13;
  h = Math.imul(h, 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 32 位种子化 PRNG（mulberry32）。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

function wrap(v: number, p: number): number {
  const m = v % p;
  return m < 0 ? m + p : m;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * 可平铺的三维值噪声，`period` 是格子周期。
 *
 * @returns `[0, 1)`
 */
function valueNoise3(x: number, y: number, z: number, period: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = fade(x - ix);
  const fy = fade(y - iy);
  const fz = fade(z - iz);

  const x0 = wrap(ix, period);
  const y0 = wrap(iy, period);
  const z0 = wrap(iz, period);
  const x1 = wrap(ix + 1, period);
  const y1 = wrap(iy + 1, period);
  const z1 = wrap(iz + 1, period);

  const c000 = hash3(x0, y0, z0, seed);
  const c100 = hash3(x1, y0, z0, seed);
  const c010 = hash3(x0, y1, z0, seed);
  const c110 = hash3(x1, y1, z0, seed);
  const c001 = hash3(x0, y0, z1, seed);
  const c101 = hash3(x1, y0, z1, seed);
  const c011 = hash3(x0, y1, z1, seed);
  const c111 = hash3(x1, y1, z1, seed);

  const x00 = lerp(c000, c100, fx);
  const x10 = lerp(c010, c110, fx);
  const x01 = lerp(c001, c101, fx);
  const x11 = lerp(c011, c111, fx);

  return lerp(lerp(x00, x10, fy), lerp(x01, x11, fy), fz);
}

/** 可平铺的三维 Worley：返回最近特征点的距离，归一到约 `[0, 1]`。 */
export function worley3(x: number, y: number, z: number, cells: number, seed: number): number {
  const px = x * cells;
  const py = y * cells;
  const pz = z * cells;
  const cx = Math.floor(px);
  const cy = Math.floor(py);
  const cz = Math.floor(pz);

  let best = Infinity;
  for (let dz = -1; dz <= 1; dz += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        // 特征点必须用**未回绕**的格号定位、只用回绕格号去哈希：
        // 否则跨缝那一格的邻居被摆到 cells 倍远的位置，接缝处距离跳变。
        const ux = cx + dx;
        const uy = cy + dy;
        const uz = cz + dz;
        const gx = wrap(ux, cells);
        const gy = wrap(uy, cells);
        const gz = wrap(uz, cells);
        const fx = ux + hash3(gx, gy, gz, seed);
        const fy = uy + hash3(gx, gy, gz, seed + 17);
        const fz = uz + hash3(gx, gy, gz, seed + 31);
        const ddx = fx - px;
        const ddy = fy - py;
        const ddz = fz - pz;
        const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
        if (d2 < best) best = d2;
      }
    }
  }

  // 单个格子里最远的可能距离约 sqrt(3)/2，据此归一。
  return Math.min(1, Math.sqrt(best) / 0.866);
}

/** 形状/天气层的噪声周期。必须整除生成尺寸，否则格点回绕处会留缝。 */
const SCALE0 = 2;
const SCALE1 = 4;
const SCALE2 = 8;

/** 生成尺寸的合法条件：整数、够大、能被所有噪声周期整除（否则格点回绕处会留缝）。 */
function assertVolumeSize(size: number, fn: string): void {
  if (!Number.isInteger(size) || size < 8 || size % SCALE2 !== 0) {
    throw new Error(`${fn}: size must be an integer >= 8 and divisible by ${SCALE2}, got ${size}`);
  }
}

/** 统计一张灰度缓冲的 min / max / mean。 */
export function volumeStats(data: Uint8Array): { min: number; max: number; mean: number } {
  if (data.length === 0) return { min: 0, max: 0, mean: 0 };
  let min = 255;
  let max = 0;
  let sum = 0;
  for (let i = 0; i < data.length; i += 1) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { min, max, mean: sum / data.length };
}

/** 把浮点缓冲归一化到 0–255。 */
function toBytes(values: Float64Array): Uint8Array {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] < min) min = values[i];
    if (values[i] > max) max = values[i];
  }
  const span = max - min || 1;
  const out = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    out[i] = Math.round(((values[i] - min) / span) * 255);
  }
  return out;
}

/**
 * 128³ 的骨架体积。
 *
 * 三层值噪声叠加，再乘一个随高度递减的 profile——顶部变薄，云层才有「天花板」，
 * 底部保持厚实（相机在下面，看见的主要是云底）。
 *
 * 索引约定：`y = 0` 是云底，`y = size - 1` 是云顶。
 */
export function generateShapeVolume(size: number, seed: number): Uint8Array {
  assertVolumeSize(size, 'generateShapeVolume');

  const values = new Float64Array(size * size * size);
  const inv = 1 / size;
  const base = seed >>> 0;
  let i = 0;

  for (let y = 0; y < size; y += 1) {
    const h = y * inv;
    // 顶部渐薄；底部再叠一个低频起伏，云底才不会是一块平灰板。
    const ceiling = 1 - fade(Math.min(1, Math.max(0, (h - 0.45) / 0.55)));
    for (let z = 0; z < size; z += 1) {
      for (let x = 0; x < size; x += 1) {
        const fx = x * inv;
        const fy = y * inv;
        const fz = z * inv;

        const n0 = valueNoise3(fx * SCALE0, fy * SCALE0, fz * SCALE0, SCALE0, base);
        const n1 = valueNoise3(fx * SCALE1, fy * SCALE1, fz * SCALE1, SCALE1, base + 101);
        const n2 = valueNoise3(fx * SCALE2, fy * SCALE2, fz * SCALE2, SCALE2, base + 211);
        const fbm = 0.55 * n0 + 0.3 * n1 + 0.15 * n2;

        // 垂直低频：让云层在高度上分成几段，而不是一根均匀的柱子。
        const band = 0.7 + 0.3 * valueNoise3(0.5, fy * SCALE1, 0.5, SCALE1, base + 307);

        values[i] = fbm * ceiling * band;
        i += 1;
      }
    }
  }

  return toBytes(values);
}

/**
 * 32³ 的侵蚀细节：高频 Worley，负责把边缘啃出毛边与「瓣」。
 *
 * 纹理平铺使用，所以坐标取模，接缝处连续。
 */
export function generateDetailVolume(size: number, seed: number): Uint8Array {
  assertVolumeSize(size, 'generateDetailVolume');

  const values = new Float64Array(size * size * size);
  const inv = 1 / size;
  const base = seed >>> 0;
  let i = 0;

  for (let y = 0; y < size; y += 1) {
    for (let z = 0; z < size; z += 1) {
      for (let x = 0; x < size; x += 1) {
        const w = worley3(x * inv, y * inv, z * inv, 4, base + 991);
        values[i] = 1 - w;
        i += 1;
      }
    }
  }

  return toBytes(values);
}

/**
 * 512² 的天气图：低频二维噪声，决定云块位置与覆盖度。
 *
 * **长度是 `size²`，不是 `size³`**——按体积尺寸分配会多出 size 倍内存。
 */
export function generateWeatherMap(size: number, seed: number): Uint8Array {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`generateWeatherMap: size must be a positive integer, got ${size}`);
  }

  const values = new Float64Array(size * size);
  const inv = 1 / size;
  const base = seed >>> 0;
  let i = 0;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const fx = x * inv;
      const fy = y * inv;
      const n0 = valueNoise3(fx * SCALE0, 0.5, fy * SCALE0, SCALE0, base + 7);
      const n1 = valueNoise3(fx * SCALE1, 0.5, fy * SCALE1, SCALE1, base + 53);
      values[i] = 0.7 * n0 + 0.3 * n1;
      i += 1;
    }
  }

  return toBytes(values);
}
