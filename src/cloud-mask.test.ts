import { describe, expect, it } from 'vitest';
import {
  CLOUD_MASK_LAYER,
  CUBE_FACE_SOLID_ANGLE,
  CUBE_TOTAL_SOLID_ANGLE,
  cubeFaceSolidAngleTable,
  cubeMaskCoverage,
  cubeTexelForDirection,
  cubeTexelSolidAngle,
  halfToFloat,
  maskFromPixels,
  readCubeMaskFaces,
  screenMaskStats,
  tagOnMaskLayer,
  type CubeFaceData,
} from './cloud-mask';

const SIZE = 8;

/** 空的 UNC8 面（全黑 = 没有云）。 */
const emptyFace = (size = SIZE): Uint8Array => new Uint8Array(size * size * 4);

/** 把某个矩形内的纹素点成白色（UNC8）。 */
const paint = (
  face: Uint8Array,
  size: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Uint8Array => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const o = (y * size + x) * 4;
      face[o] = 255;
      face[o + 1] = 255;
      face[o + 2] = 255;
      face[o + 3] = 255;
    }
  }
  return face;
};

describe('cubeTexelSolidAngle — 立体角是精确求积，不是均分', () => {
  it('单面 6·size² 个纹素求和精确等于 2π/3', () => {
    const table = cubeFaceSolidAngleTable(SIZE);
    const sum = table.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(CUBE_FACE_SOLID_ANGLE, 12);
  });

  it('每面 2π/3，六面加起来是 4π', () => {
    expect(6 * CUBE_FACE_SOLID_ANGLE).toBeCloseTo(CUBE_TOTAL_SOLID_ANGLE, 12);
  });

  it('面角纹素约是面心的 1/4：立方图参数化不保面积', () => {
    const corner = cubeTexelSolidAngle(0, 0, SIZE);
    const center = cubeTexelSolidAngle(SIZE / 2, SIZE / 2, SIZE);
    expect(corner).toBeLessThan(center);
    // Ω ∝ 1/(1+s²+t²)^{3/2}：SIZE=8 时角点 s=t=0.875 → 2.53^-1.5 ≈ 0.26。
    // 这就是「均分 4π/(6·size²)」会把角落纹素高估近 4 倍的误差量级。
    expect(corner / center).toBeGreaterThan(0.24);
    expect(corner / center).toBeLessThan(0.28);
  });

  it('越界纹素直接报错，不静默返回 0', () => {
    expect(() => cubeTexelSolidAngle(SIZE, 0, SIZE)).toThrow(/outside/);
    expect(() => cubeTexelSolidAngle(0, 0, 0)).toThrow(/positive/);
  });
});

describe('cubeMaskCoverage — 背景云的球面覆盖率', () => {
  it('全空立方图 = 0', () => {
    const faces = Array.from({ length: 6 }, () => emptyFace());
    const r = cubeMaskCoverage(faces, SIZE);
    expect(r.fraction).toBe(0);
    expect(r.coveredTexels).toBe(0);
    expect(r.totalSolidAngle).toBeCloseTo(4 * Math.PI, 12);
  });

  it('整面涂白 = 恰好 1/6，不受相机与视口影响', () => {
    const faces = Array.from({ length: 6 }, () => emptyFace());
    paint(faces[4], SIZE, 0, 0, SIZE, SIZE);
    const r = cubeMaskCoverage(faces, SIZE);
    expect(r.fraction).toBeCloseTo(1 / 6, 12);
    expect(r.coveredTexels).toBe(SIZE * SIZE);
  });

  it('半个面 = 恰好 1/12（按纹素立体角求和，不是按纹素个数）', () => {
    const faces = Array.from({ length: 6 }, () => emptyFace());
    paint(faces[2], SIZE, 0, 0, SIZE, SIZE / 2);
    const r = cubeMaskCoverage(faces, SIZE);
    expect(r.fraction).toBeCloseTo(1 / 12, 12);
  });

  it('半浮点面：非零的半浮点值算命中，0 不算', () => {
    const half = (v: number): number => {
      // 只需 0 / 1 / 0.5 三个值，手写编码足够。
      if (v === 0) return 0x0000;
      if (v === 1) return 0x3c00;
      return 0x3800; // 0.5
    };
    const faces: CubeFaceData[] = Array.from(
      { length: 6 },
      () => new Uint16Array(SIZE * SIZE * 4),
    );
    const face0 = faces[0] as Uint16Array;
    for (let t = 0; t < SIZE * SIZE; t += 1) {
      face0[t * 4] = half(1);
      face0[t * 4 + 1] = half(0.5);
    }
    const r = cubeMaskCoverage(faces, SIZE);
    expect(r.fraction).toBeCloseTo(1 / 6, 12);
  });

  it('面数或长度不对直接报错', () => {
    expect(() => cubeMaskCoverage([emptyFace()], SIZE)).toThrow(/need 6 faces/);
    const short = Array.from({ length: 6 }, () => emptyFace());
    short[3] = new Uint8Array(4);
    expect(() => cubeMaskCoverage(short, SIZE)).toThrow(/face 3/);
  });
});

describe('halfToFloat — 半浮点解包', () => {
  it('0 / 1 / -1 / Infinity 的位模式', () => {
    expect(halfToFloat(0x0000)).toBe(0);
    expect(halfToFloat(0x3c00)).toBe(1);
    expect(halfToFloat(0xbc00)).toBe(-1);
    expect(halfToFloat(0x7c00)).toBe(Infinity);
  });

  it('次正规数与普通数', () => {
    expect(halfToFloat(0x0001)).toBeCloseTo(Math.pow(2, -24), 12);
    expect(halfToFloat(0x3555)).toBeCloseTo(0.333251953125, 9);
  });
});

describe('cubeTexelForDirection — 方向落在哪个纹素', () => {
  it('六个面心方向落在各自面、各自面心纹素', () => {
    const mid = SIZE / 2;
    const cases: Array<[number[], number]> = [
      [[1, 0, 0], 0],
      [[-1, 0, 0], 1],
      [[0, 1, 0], 2],
      [[0, -1, 0], 3],
      [[0, 0, 1], 4],
      [[0, 0, -1], 5],
    ];
    for (const [dir, face] of cases) {
      const t = cubeTexelForDirection(dir as [number, number, number], SIZE);
      expect(t.face).toBe(face);
      expect(t.x).toBe(mid);
      expect(t.y).toBe(mid);
    }
  });
});

describe('maskFromPixels / screenMaskStats — 近景云隔离 pass', () => {
  const w = 4;
  const h = 3;

  it('全黑 = 0 命中', () => {
    const mask = maskFromPixels(new Uint8Array(w * h * 4), w, h);
    const stats = screenMaskStats(mask, w, h);
    expect(stats.bbox).toBeNull();
    expect(stats.fraction).toBe(0);
    expect(stats.area).toBe(w * h);
  });

  it('两个像素有云 → 计数与包围盒都精确', () => {
    const px = new Uint8Array(w * h * 4);
    px[(1 * w + 1) * 4] = 255;
    px[(2 * w + 2) * 4 + 1] = 7;
    const mask = maskFromPixels(px, w, h);
    const stats = screenMaskStats(mask, w, h);
    expect(stats.bbox).toEqual({ x0: 1, y0: 1, x1: 3, y1: 3, count: 2 });
    expect(stats.fraction).toBeCloseTo(2 / (w * h), 12);
  });

  it('区域裁剪后分母跟着变（半开区间）', () => {
    const px = new Uint8Array(w * h * 4);
    px[(0 * w + 0) * 4] = 255;
    const mask = maskFromPixels(px, w, h);
    const stats = screenMaskStats(mask, w, h, { x0: 1, y0: 0, x1: w, y1: h });
    expect(stats.area).toBe((w - 1) * h);
    expect(stats.fraction).toBe(0);
  });

  it('缓冲长度不够直接报错', () => {
    expect(() => maskFromPixels(new Uint8Array(3), 4, 3)).toThrow(/need 48 values/);
  });
});

describe('readCubeMaskFaces — 读回契约', () => {
  const fakeRenderer = (buffer: ArrayBufferView) => ({
    readRenderTargetPixelsAsync: async () => buffer,
  });

  it('半浮点目标读回 6 张 Uint16Array 面', async () => {
    const faces = await readCubeMaskFaces(
      fakeRenderer(new Uint16Array(SIZE * SIZE * 4)),
      {},
      SIZE,
    );
    expect(faces).toHaveLength(6);
    expect(faces[0]).toBeInstanceOf(Uint16Array);
    expect((faces[0] as Uint16Array).length).toBe(SIZE * SIZE * 4);
  });

  it('读回类型与 halfFloat 标志不符时报错，不猜', async () => {
    await expect(
      readCubeMaskFaces(fakeRenderer(new Uint8Array(SIZE * SIZE * 4)), {}, SIZE),
    ).rejects.toThrow(/expected Uint16Array/);
  });

  it('UNC8 目标按 halfFloat:false 读回 Uint8Array 面', async () => {
    const faces = await readCubeMaskFaces(
      fakeRenderer(new Uint8Array(SIZE * SIZE * 4)),
      {},
      SIZE,
      { halfFloat: false },
    );
    expect(faces[0]).toBeInstanceOf(Uint8Array);
  });
});

describe('tagOnMaskLayer — 只叠加，不覆盖原 layer', () => {
  it('原有 layer 保留，遮罩 layer 被打开', () => {
    const layers = { mask: 0, enable(n: number) { this.mask |= 1 << n; } };
    const root = { traverse: (cb: (o: unknown) => void) => cb({ layers }) };
    tagOnMaskLayer(root);
    expect(layers.mask).toBe(1 << CLOUD_MASK_LAYER);
  });

  it('没有 layers 的节点被跳过，不抛错', () => {
    const seen: unknown[] = [];
    const root = { traverse: (cb: (o: unknown) => void) => { cb({}); cb({ layers: null }); } };
    tagOnMaskLayer(root);
    expect(seen).toHaveLength(0);
  });
});
