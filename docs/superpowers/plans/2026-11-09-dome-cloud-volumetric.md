# 穹顶云（体积云层）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在相机上方的 380–1150 m 空域里做出一层真正的 raymarched 体积云，极慢翻涌，旗舰 Android Chrome 上 low 档稳定 30 fps。

**Architecture:** 三层密度场（512² 天气图 + 128³ 基础形状 + 32³ 侵蚀细节）在 CPU 端确定性生成一次并上传；片元着色器在 slab∩盒 的联合区间内做步长递增的射线行进，每像素用 `interleavedGradientNoise` 抖动起点；光照走 4 步朝太阳的 light march + Beer-Lambert + 两瓣 HG + powder。云模块自持一个 `BackSide` 盒 mesh，随相机平移，按世界距离淡出到地平线霾。

**Tech Stack:** TypeScript 5.5 · three 0.186.0 (`three/webgpu` + `three/tsl`) · Vitest 2.1 · Vite 6

**Spec:** `docs/superpowers/specs/2026-11-09-dome-cloud-volumetric-design.md`

> **修订（2026-11-09）：** 外部复审指出 7 处问题，已全部修入本版 —— ① `boxHalfExtentFor` 的 Step 3 与测试自相矛盾，**整条删除**，改成钉死的 `boxScale()`；② `driftOffset` 用一个偏移装不下两层不同速度，改为带 `layer` 参数；③ 五处「Expected: PASS（N 个用例）」的 N 全部重数；④ spec §5.3 的「12 m 起、60 m 封顶」不可行（28 步上限 1680 m < 1800 m 射程），已同步改成覆盖率契约；⑤ Task 9 补上门 2、门 6 桌面半、以及**把云带 ROI 钉进计划**；⑥ weather 图是 `DataTexture` 不是 `Data3DTexture`；⑦ spec §3 的 `traa`/`RaymarchingBox` 可用性改为「在 addons，不在核心 TSL」。

## Global Constraints

- **three 0.186.0**，**WebGPU-only**：`src/renderer.ts:36-50` 在非 WebGPU 后端抛错，**任何任务都不得引入 WebGL 回退**。
- 竖屏 **9:16**，fov **60°**，**`camera.far = 2000`**（`src/main.ts:65`）。云的水平半宽 **1800 m**，不得改 far。
- **DPR 上限 1.5**（`src/main.ts:221`）；典型 buffer ≈ 717×1275。
- 飞行 **ALT_MIN 6 / ALT_MAX 240**（`src/game.ts:99-100`）。云底 **380 m**、云顶 **1150 m**。
- 距离淡出 **1200 m → 1800 m**，且 **`fadeEnd == halfExtent == 1800`**——盒壁处云必须已经全透明，这是「看不见盒子边」的唯一保证。
- 步数 **high 28 / low 16**；light march **high 4 / low 2**；detail octave **high 2 / low 1**。**只烘一套 128³，`setQuality` 里绝不重烘。**
- 步长**不是固定序列**：按单调递增权重曲线归一化到射程，契约是「首步 ≤ 20 m · 单调不减 · 总和精确等于射程」。
- `SLOW_FRAME_MS = 24`（`src/world.ts:63`）。档位只降不升。
- **单一太阳**：只吃 `SUN_DIRECTION` / 活的 `DirectionalLight`，不得新造光源。
- **调色单源**：只读 `src/sky-track.ts` 的 `cloudBands: Vec3[4]` 与 `cloudHaze: Vec3`；**不得在云模块里写死十六进制颜色**。
- 模块挂载必须 **try/catch**，失败只丢自己（照 `src/world.ts:145-164`）。
- 漂移速度：detail **0.35 m/s**（tile 400 m）、weather **0.40 m/s**（tile 8000 m）——**两层速度不同，偏移必须分别计算**。
- 所有时间取 **`elapsed`（累加 dt）**，**不得用 `Date.now()` / `performance.now()`**。
- 纹理类型：**128³ / 32³ 用 `Data3DTexture`；512² weather 用 `DataTexture` + `RepeatWrapping`**。
- 单测文件与被测模块同名：`src/foo.ts` ↔ `src/foo.test.ts`。提交信息用 `feat(dome):` / `test(dome):` 作用域。

## Review Focus

1. **相机贴到 ALT_MAX 240 m 且抬头**：云底 380 m 只剩 140 m 余量。真正的兜底不是纯 slab 求交，而是 shader 里 **slab ∩ 盒壁** 的联合区间——只算 slab 会在水平出盒后继续 march 一段空域。→ Task 1 用 `slabSpan` + `boxExit` 两个纯函数分别钉住。
2. **`?dome=0` 与 `?puff=0` 同时给**：两套云全关，画面只剩天穹。开/关帧做差是门 1 的唯一量法。→ Task 5。
3. **冻结抓帧（`?qa=frozen` + `qa.step()`）下云的漂移**：必须只随 `elapsed` 推进，否则同一 `step(n)` 两次跑出不同的云。→ Task 2。
4. **盒子尺寸不得来自窗口尺寸**：若有人「顺手」按 `innerWidth/innerHeight` 或 fov 推导盒子半宽，窄窗口下会溢出或铺不满。尺寸必须是 `DOME_SLAB` 的常量函数。→ Task 6 的 `boxScale()` 测试。
5. **太阳仰角极低（夜档）时 `cloudBands` 的取值**：夜档带比黄昏暗一个量级，公式里任何未 clamp 的除法都会把它变成 NaN 黑块。→ Task 3。

---

### Task 1: 云层几何——slab 区间、盒壁、距离淡出

**Files:**
- Create: `src/dome-cloud-field.ts`
- Test: `src/dome-cloud-field.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `DOME_SLAB: { base: 380; top: 1150; halfExtent: 1800; fadeStart: 1200; fadeEnd: 1800 }`
  - `interface SlabSpan { t0: number; t1: number }`
  - `slabSpan(originY: number, dirY: number): SlabSpan | null`
  - `boxExit(horizontalPerUnitT: number, halfExtent: number): number`
  - `fadeAt(distanceMetres: number): number`

- [ ] **Step 1: 写失败的测试**

```ts
// src/dome-cloud-field.test.ts
import { describe, expect, it } from 'vitest';
import { DOME_SLAB, boxExit, fadeAt, slabSpan } from './dome-cloud-field';

describe('DOME_SLAB', () => {
  it('keeps the deck above the flight ceiling with a 140 m margin', () => {
    expect(DOME_SLAB.base).toBe(380);
    expect(DOME_SLAB.top).toBe(1150);
    expect(DOME_SLAB.base).toBeGreaterThan(240);
  });
  it('stays inside the camera far plane', () => {
    expect(DOME_SLAB.halfExtent).toBeLessThan(2000);
  });
  it('fades to nothing exactly at the box wall', () => {
    // 盒壁不可见的前提：到墙时 alpha 已经是 0。
    expect(DOME_SLAB.fadeEnd).toBe(DOME_SLAB.halfExtent);
  });
});

describe('slabSpan', () => {
  it('enters from below on an upward ray', () => {
    const span = slabSpan(60, 0.9);
    expect(span).not.toBeNull();
    expect(span!.t0).toBeGreaterThan(0);
    expect(span!.t1).toBeGreaterThan(span!.t0);
  });

  it('still hits when the camera is pinned at ALT_MAX and looking slightly up', () => {
    const span = slabSpan(240, 0.05);
    expect(span).not.toBeNull();
    expect(span!.t0).toBeGreaterThan(0);
    expect(span!.t1).toBeGreaterThan(span!.t0);
  });

  it('returns null for a horizontal ray below the deck', () => {
    expect(slabSpan(60, 0)).toBeNull();
  });

  it('returns null for a downward ray below the deck', () => {
    expect(slabSpan(60, -0.5)).toBeNull();
  });

  it('starts at zero when the camera is inside the slab', () => {
    expect(slabSpan(600, 1)!.t0).toBe(0);
  });

  it('exits at the slab floor when looking down from inside', () => {
    const span = slabSpan(600, -1);
    expect(span!.t0).toBe(0);
    expect(span!.t1).toBeCloseTo(600 - DOME_SLAB.base, 6);
  });
});

describe('boxExit', () => {
  it('scales with the horizontal component of the ray', () => {
    expect(boxExit(1, 1800)).toBeCloseTo(1800, 6);
    expect(boxExit(0.5, 1800)).toBeCloseTo(3600, 6);
  });
  it('is infinite for a perfectly vertical ray', () => {
    expect(boxExit(0, 1800)).toBe(Infinity);
  });
  it('is finite and non-negative for degenerate input', () => {
    for (const h of [Number.NaN, -1]) {
      const v = boxExit(h, 1800);
      expect(Number.isFinite(v) || v === Infinity).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('fadeAt', () => {
  it('is fully opaque at and inside fadeStart', () => {
    expect(fadeAt(0)).toBe(1);
    expect(fadeAt(DOME_SLAB.fadeStart)).toBe(1);
  });
  it('is fully gone at and beyond fadeEnd', () => {
    expect(fadeAt(DOME_SLAB.fadeEnd)).toBe(0);
    expect(fadeAt(5000)).toBe(0);
  });
  it('decreases monotonically across the band', () => {
    const samples = [1200, 1350, 1500, 1650, 1800].map(fadeAt);
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i]).toBeLessThan(samples[i - 1]);
    }
  });
  it('returns a finite value for non-finite input', () => {
    expect(Number.isFinite(fadeAt(Number.NaN))).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/dome-cloud-field.test.ts`
Expected: FAIL — `Failed to resolve import "./dome-cloud-field"`

- [ ] **Step 3: 实现 `src/dome-cloud-field.ts`**

要点：
- `slabSpan`：`|dirY| < 1e-6` 时只有「相机已在 slab 内」才算命中（返回 `{t0: 0, t1: Infinity}`），否则 `null`。否则与两个平面求交，`t0 = max(0, 近点)`，`t1 = 远点`；`t1 <= t0` 返回 `null`。
- `boxExit`：`h <= 1e-6` 或非有限 → `Infinity`；否则 `halfExtent / h`。负数 `h` 取绝对值。**shader 里取 `min(t1, boxExit)`**。
- `fadeAt`：`[fadeStart, fadeEnd]` 上 3t²−2t³ 的 smoothstep，返回 `1 - t`；非有限输入返回 `0`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/dome-cloud-field.test.ts`
Expected: PASS（16 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/dome-cloud-field.ts src/dome-cloud-field.test.ts
git commit -m "feat(dome): slab span, box exit and distance fade for the cloud deck"
```

---

### Task 2: 步长序列与分层漂移

**Files:**
- Modify: `src/dome-cloud-field.ts`
- Test: `src/dome-cloud-field.test.ts`

**Interfaces:**
- Consumes: `SlabSpan`（Task 1）
- Produces:
  - `stepSizes(count: number, span: number): Float64Array` — 每步长度，总和严格等于 `span`
  - `DomeDriftLayer = 'detail' | 'weather'`
  - `DOME_DRIFT: { detailMetresPerSecond: 0.35; weatherMetresPerSecond: 0.4; detailTileMetres: 400; weatherTileMetres: 8000; headingRad: number }`
  - `driftOffset(elapsedSeconds: number, layer: DomeDriftLayer): { x: number; z: number }` — 世界米

- [ ] **Step 1: 写失败的测试**

```ts
// 追加到 src/dome-cloud-field.test.ts
import { DOME_DRIFT, driftOffset, stepSizes } from './dome-cloud-field';

describe('stepSizes', () => {
  it('covers exactly the span in 28 steps', () => {
    const widths = stepSizes(28, 1480);
    expect(widths).toHaveLength(28);
    const total = widths.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1480, 6);
  });

  it('keeps the first step under 20 m so the near field stays sharp', () => {
    expect(stepSizes(28, 1480)[0]).toBeLessThanOrEqual(20);
  });

  it('never shrinks a later step', () => {
    const widths = stepSizes(28, 1480);
    for (let i = 1; i < widths.length; i += 1) {
      expect(widths[i]).toBeGreaterThanOrEqual(widths[i - 1]);
    }
  });

  it('returns an empty array for a non-positive span or count', () => {
    expect(stepSizes(28, 0)).toHaveLength(0);
    expect(stepSizes(0, 100)).toHaveLength(0);
  });
});

describe('driftOffset', () => {
  it('is zero at t = 0 for both layers', () => {
    expect(driftOffset(0, 'detail')).toEqual({ x: 0, z: 0 });
    expect(driftOffset(0, 'weather')).toEqual({ x: 0, z: 0 });
  });

  it('moves the detail layer at 0.35 m/s — 30 s ≈ 10.5 m', () => {
    const o = driftOffset(30, 'detail');
    expect(Math.hypot(o.x, o.z)).toBeCloseTo(10.5, 1);
  });

  it('moves the weather layer at 0.40 m/s — 30 s ≈ 12 m', () => {
    // 两份速度不同，单偏移装不下：审阅 #2。
    const o = driftOffset(30, 'weather');
    expect(Math.hypot(o.x, o.z)).toBeCloseTo(12, 1);
    expect(DOME_DRIFT.weatherMetresPerSecond).not.toBe(DOME_DRIFT.detailMetresPerSecond);
  });

  it('advances only with elapsed time — Review Focus 3', () => {
    expect(driftOffset(12.5, 'detail')).toEqual(driftOffset(12.5, 'detail'));
  });

  it('is finite for negative and non-finite input', () => {
    expect(Number.isFinite(driftOffset(-3, 'detail').x)).toBe(true);
    expect(Number.isFinite(driftOffset(Number.NaN, 'weather').x)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/dome-cloud-field.test.ts -t stepSizes`
Expected: FAIL — `stepSizes is not a function`

- [ ] **Step 3: 实现 `stepSizes` / `DOME_DRIFT` / `driftOffset`**

要点：
- `stepSizes`：权重 `w_i = (i+1)^p - i^p`（`p ≈ 2.2`），按权重总和缩放。**浮点用最后一个元素吸收误差**，保证求和精确等于 `span`。非正输入返回空数组。
- `driftOffset`：角度固定 `DOME_DRIFT.headingRad`，速度按 `layer` 取；非有限/负数按 0。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/dome-cloud-field.test.ts`
Expected: PASS（25 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/dome-cloud-field.ts src/dome-cloud-field.test.ts
git commit -m "feat(dome): exact-coverage step sizes and per-layer drift"
```

---

### Task 3: 光照数学

**Files:**
- Create: `src/dome-cloud-light.ts`
- Test: `src/dome-cloud-light.test.ts`

**Interfaces:**
- Consumes: `srgbToLinear`、`Vec3`（`src/sky-track.ts`，测试用）
- Produces:
  - `transmittance(sigmaT: number, distanceMetres: number): number`
  - `hgPhase(cosTheta: number, g: number): number`
  - `powder(density: number, strength: number): number`
  - `shadeSunAndAmbient(input: { sunColor: Vec3; ambient: Vec3; sigmaT: number; lightDistance: number; cosTheta: number; density: number }): Vec3`

- [ ] **Step 1: 写失败的测试**

```ts
// src/dome-cloud-light.test.ts
import { describe, expect, it } from 'vitest';
import { srgbToLinear } from './sky-track';
import { hgPhase, powder, shadeSunAndAmbient, transmittance } from './dome-cloud-light';

describe('transmittance', () => {
  it('is 1 with no extinction', () => {
    expect(transmittance(0, 100)).toBe(1);
  });
  it('decays with distance', () => {
    expect(transmittance(0.1, 10)).toBeCloseTo(Math.exp(-1), 6);
    expect(transmittance(0.1, 20)).toBeLessThan(transmittance(0.1, 10));
  });
});

describe('hgPhase', () => {
  it('is isotropic 1/4π at g = 0', () => {
    expect(hgPhase(0.3, 0)).toBeCloseTo(1 / (4 * Math.PI), 6);
  });
  it('peaks in the forward lobe', () => {
    expect(hgPhase(1, 0.6)).toBeGreaterThan(hgPhase(0, 0.6));
  });
  it('is finite for every valid cosine', () => {
    for (const c of [-1, -0.5, 0, 0.5, 1]) expect(Number.isFinite(hgPhase(c, 0.6))).toBe(true);
  });
});

describe('powder', () => {
  it('is zero at zero density and approaches one when dense', () => {
    expect(powder(0, 1)).toBeCloseTo(0, 6);
    expect(powder(50, 1)).toBeGreaterThan(0.99);
  });
});

describe('shadeSunAndAmbient', () => {
  it('leaves ambient alone when the sun is fully occluded', () => {
    const out = shadeSunAndAmbient({
      sunColor: [1, 1, 1], ambient: [0.2, 0.3, 0.5],
      sigmaT: 100, lightDistance: 100, cosTheta: 1, density: 1,
    });
    expect(out[0]).toBeCloseTo(0.2, 3);
    expect(out[1]).toBeCloseTo(0.3, 3);
    expect(out[2]).toBeCloseTo(0.5, 3);
  });

  it('stays finite under the real night palette — Review Focus 5', () => {
    // 直接取 sky-track 的真值，别手算近似（审阅 P3）。
    const night = srgbToLinear('#26304f');
    const out = shadeSunAndAmbient({
      sunColor: [0, 0, 0], ambient: night,
      sigmaT: 0.4, lightDistance: 30, cosTheta: -0.2, density: 0.05,
    });
    for (const c of out) {
      expect(Number.isFinite(c)).toBe(true);
      expect(c).toBeGreaterThanOrEqual(0);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/dome-cloud-light.test.ts`
Expected: FAIL — `Failed to resolve import "./dome-cloud-light"`

- [ ] **Step 3: 实现 `src/dome-cloud-light.ts`**

要点：
- `hgPhase = (1-g²)/(4π(1+g²-2g·cosθ)^{3/2})`；两瓣在 `shadeSunAndAmbient` 里按 0.6 / −0.3 加权。
- `powder = 1 - exp(-2·density·strength)`。
- `shadeSunAndAmbient` 返回 `ambient + sunColor · transmittance(sigmaT, lightDistance) · phase · powder(density, 1)`；**逐分量 clamp 到 ≥ 0，非有限按 0**。
- 本模块**不得 import three**（保持可在 node 下裸测）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/dome-cloud-light.test.ts`
Expected: PASS（8 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/dome-cloud-light.ts src/dome-cloud-light.test.ts
git commit -m "feat(dome): beer-lambert, two-lobe hg and powder lighting math"
```

---

### Task 4: 密度体积生成

**Files:**
- Create: `src/dome-cloud-noise.ts`
- Test: `src/dome-cloud-noise.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `mulberry32(seed: number): () => number`
  - `generateShapeVolume(size: number, seed: number): Uint8Array` — 长度 `size³`，`size` 必须是 2 的幂
  - `generateDetailVolume(size: number, seed: number): Uint8Array`
  - `generateWeatherMap(size: number, seed: number): Uint8Array` — **2D**，长度 `size²`
  - `volumeStats(data: Uint8Array): { min: number; max: number; mean: number }`

- [ ] **Step 1: 写失败的测试**

```ts
// src/dome-cloud-noise.test.ts
import { describe, expect, it } from 'vitest';
import {
  generateDetailVolume, generateShapeVolume, generateWeatherMap, mulberry32, volumeStats,
} from './dome-cloud-noise';

describe('mulberry32', () => {
  it('is deterministic for a seed', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
  it('stays inside [0, 1)', () => {
    const r = mulberry32(1);
    for (let i = 0; i < 1000; i += 1) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('generateShapeVolume', () => {
  it('fills size cubed bytes', () => {
    expect(generateShapeVolume(8, 1)).toHaveLength(512);
  });
  it('is deterministic', () => {
    expect(Array.from(generateShapeVolume(8, 3))).toEqual(Array.from(generateShapeVolume(8, 3)));
  });
  it('uses the full byte range without collapsing', () => {
    const s = volumeStats(generateShapeVolume(16, 5));
    expect(s.max).toBeGreaterThan(200);
    expect(s.min).toBeLessThan(60);
    expect(s.mean).toBeGreaterThan(20);
    expect(s.mean).toBeLessThan(235);
  });
  it('thins out toward the top of the slab so the deck has a ceiling', () => {
    const size = 16;
    const data = generateShapeVolume(size, 5);
    const rowMean = (y: number) => {
      let sum = 0;
      for (let z = 0; z < size; z += 1) for (let x = 0; x < size; x += 1) sum += data[y * size * size + z * size + x];
      return sum / (size * size);
    };
    expect(rowMean(0)).toBeGreaterThan(rowMean(size - 1));
  });
  it('rejects a non power-of-two size', () => {
    expect(() => generateShapeVolume(10, 1)).toThrow();
  });
});

describe('generateDetailVolume', () => {
  it('fills size cubed bytes and is deterministic', () => {
    expect(generateDetailVolume(8, 2)).toHaveLength(512);
    expect(Array.from(generateDetailVolume(8, 2))).toEqual(Array.from(generateDetailVolume(8, 2)));
  });
  it('is not flat', () => {
    const s = volumeStats(generateDetailVolume(8, 2));
    expect(s.max - s.min).toBeGreaterThan(100);
  });
});

describe('generateWeatherMap', () => {
  it('fills size squared bytes, not cubed', () => {
    // 审阅 #6：weather 是 2D，按体积尺寸分配会多出 size 倍内存。
    expect(generateWeatherMap(16, 4)).toHaveLength(256);
  });
  it('is deterministic and not flat', () => {
    expect(Array.from(generateWeatherMap(16, 4))).toEqual(Array.from(generateWeatherMap(16, 4)));
    const s = volumeStats(generateWeatherMap(16, 4));
    expect(s.max - s.min).toBeGreaterThan(100);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/dome-cloud-noise.test.ts`
Expected: FAIL — `Failed to resolve import "./dome-cloud-noise"`

- [ ] **Step 3: 实现 `src/dome-cloud-noise.ts`**

要点：
- 纯 TS，**不 import three**。
- `generateShapeVolume`：三维值噪声叠 Worley，乘一个随 `y` 递减的垂直 profile。输出归一化到 0–255。`size` 非 2 的幂时 `throw`。
- `generateDetailVolume`：高频 Worley，同样归一化。
- `generateWeatherMap`：二维低频噪声，归一化；**长度 `size²`**。
- 性能：128³ ≈ 210 万体素，启动时 < 1.5 s。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/dome-cloud-noise.test.ts`
Expected: PASS（11 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/dome-cloud-noise.ts src/dome-cloud-noise.test.ts
git commit -m "feat(dome): deterministic shape, detail and weather field generation"
```

---

### Task 5: `?dome=0` 抓帧开关

**Files:**
- Modify: `src/qa.ts`
- Test: `src/qa.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `parseDomeVisible(raw: string | null | undefined): boolean`

- [ ] **Step 1: 写失败的测试**

```ts
// 追加到 src/qa.test.ts
import { parseDomeVisible, parsePuffVisible } from './qa';

describe('parseDomeVisible', () => {
  it('turns the deck off only for the exact string "0"', () => {
    expect(parseDomeVisible('0')).toBe(false);
  });
  it('defaults to visible', () => {
    expect(parseDomeVisible(null)).toBe(true);
    expect(parseDomeVisible(undefined)).toBe(true);
    expect(parseDomeVisible('')).toBe(true);
    expect(parseDomeVisible('1')).toBe(true);
  });
  it('coexists with the puff switch — Review Focus 2', () => {
    expect(parseDomeVisible('0')).toBe(false);
    expect(parsePuffVisible('0')).toBe(false);
    expect(parseDomeVisible('0')).not.toBe(parsePuffVisible('1'));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/qa.test.ts -t parseDomeVisible`
Expected: FAIL — `parseDomeVisible is not a function`

- [ ] **Step 3: 实现 `parseDomeVisible`**

照 `parsePuffVisible` 写：`return raw !== '0';`，加文档注释说明它是门 1 的开关。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/qa.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/qa.ts src/qa.test.ts
git commit -m "feat(dome): ?dome=0 capture switch"
```

---

### Task 6: 装配与材质

**Files:**
- Create: `src/dome-cloud.ts`
- Test: `src/dome-cloud.test.ts`

**Interfaces:**
- Consumes: `DOME_SLAB`、`fadeAt`、`slabSpan`、`boxExit`、`stepSizes`、`driftOffset`（Task 1–2）；`transmittance`、`hgPhase`、`powder`（Task 3）；`generateShapeVolume`、`generateDetailVolume`、`generateWeatherMap`（Task 4）；`WorldView`（`src/world.ts`）
- Produces:
  - `export interface DomeCloudHandles { update(t: number, sunDir: THREE.Vector3, view?: WorldView): void; setCloudPalette(bands: readonly Vec3[], haze: Vec3): void; setQuality(high: boolean): void; setVisible(visible: boolean): void; dispose(): void; readonly ready: boolean }`
  - `export function qualityParams(high: boolean): { steps: number; lightSteps: number; octaves: number }`
  - `export function boxScale(): { x: number; y: number; z: number }`
  - `export async function initDomeCloud(scene: THREE.Scene, renderer: unknown, sunDir: THREE.Vector3): Promise<DomeCloudHandles>`

- [ ] **Step 1: 写失败的测试**

```ts
// src/dome-cloud.test.ts
import { describe, expect, it } from 'vitest';
import { DOME_SLAB } from './dome-cloud-field';
import { boxScale, qualityParams } from './dome-cloud';

describe('qualityParams', () => {
  it('pins the spec step budgets', () => {
    expect(qualityParams(true)).toEqual({ steps: 28, lightSteps: 4, octaves: 2 });
    expect(qualityParams(false)).toEqual({ steps: 16, lightSteps: 2, octaves: 1 });
  });
  it('never changes the volume resolution — setQuality must not rebake', () => {
    expect(Object.keys(qualityParams(true))).toEqual(Object.keys(qualityParams(false)));
  });
});

describe('boxScale', () => {
  it('is derived only from DOME_SLAB', () => {
    // Review Focus 4：不得从窗口/fov 推导，否则窄窗口会溢出。
    const s = boxScale();
    expect(s.x).toBe(DOME_SLAB.halfExtent * 2);
    expect(s.z).toBe(DOME_SLAB.halfExtent * 2);
    expect(s.y).toBe(DOME_SLAB.top - DOME_SLAB.base);
  });
  it('takes no arguments, so nothing about the viewport can leak in', () => {
    expect(boxScale.length).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/dome-cloud.test.ts`
Expected: FAIL — `Failed to resolve import "./dome-cloud"`

- [ ] **Step 3: 实现 `src/dome-cloud.ts`**

要点：
- `qualityParams` 返回上表常量的新对象。
- `boxScale()` 只读 `DOME_SLAB`，无参数。
- **`WorldView` 必须写 `import type { WorldView } from './world';`**——`world.ts` 是动态 `import('./dome-cloud')` 的调用方，dome 若在运行时反向 import world 会形成循环；`import type` 编译后被擦除，不产生运行时依赖。
- `initDomeCloud`：
  - 懒 `import('three/webgpu')`、`import('three/tsl')`。
  - **纹理类型分两种**：128³ shape、32³ detail 包 `Data3DTexture`（`RedFormat`、`LinearFilter`、`unpackAlignment = 1`）；**512² weather 包 `DataTexture` + `RepeatWrapping`**（审阅 #6）。
  - 材质：`NodeMaterial`，`colorNode` 用 `Fn` 写 march；每像素 `interleavedGradientNoise(screenCoordinate)` 抖起始偏移；区间取 `min(slabSpan.t1, boxExit)`；密度 = shape × weather × detail 侵蚀；输出 `rgb` + `alpha`。
  - mesh：`BoxGeometry(1,1,1)` 按 `boxScale()` 缩放，`BackSide`、`transparent: true`、`depthWrite: false`、`depthTest: true`、`frustumCulled = false`。
  - `update`：盒子跟随 `view.camera` 的 x/z 平移；`elapsed` 与两层 `driftOffset` 分别灌 uniform；`sunDir` 灌 uniform。
  - `setVisible` 切 `mesh.visible`；`dispose` 释放几何/材质/三张纹理。
  - 任一步失败直接 `throw`，交给 `world.ts` 的 try/catch。

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `npx vitest run src/dome-cloud.test.ts && npx tsc --noEmit`
Expected: PASS（4 个用例）且 tsc exit 0

- [ ] **Step 5: 提交**

```bash
git add src/dome-cloud.ts src/dome-cloud.test.ts
git commit -m "feat(dome): raymarched cloud deck material and handles"
```

---

### Task 7: 接进 world 与 main

**Files:**
- Modify: `src/world.ts`（挂载 + `view` 转发 + `setCloudPalette` 转发 + `setDomeVisible` + `dome` 布尔）
- Modify: `src/main.ts:30`（导入 `parseDomeVisible`）、`:181-195`（读 `?dome=`）
- Modify: `scripts/smoke.mjs`（白名单加 `src/dome-cloud.ts`、`src/dome-cloud-field.ts`、`src/dome-cloud-light.ts`、`src/dome-cloud-noise.ts`、`src/frame-stats.ts`）
- Test: `src/world.test.ts`

**Interfaces:**
- Consumes: `initDomeCloud`、`DomeCloudHandles`（Task 6）
- Produces: `WorldHandles` 新增 `setDomeVisible(visible: boolean): void` 与 `readonly dome: boolean`

- [ ] **Step 1: 写失败的测试**

```ts
// 追加到 src/world.test.ts 里既有的 describe('initWorld', ...) 块内
it('exposes the dome handles and tolerates a failed mount', async () => {
  // 与既有 `world.clouds` 同款口径：plain node 下云模块挂不上，
  // 这里只验 API 形状与「挂了也不拖垮世界」，不验真实挂载。
  const scene = new THREE.Scene();
  const world = await initWorld(scene);
  expect(typeof world.setDomeVisible).toBe('function');
  expect(typeof world.dome).toBe('boolean');
  world.setDomeVisible(false);
  world.setDomeVisible(true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/world.test.ts -t "dome handles"`
Expected: FAIL — `world.setDomeVisible is not a function`

- [ ] **Step 3: 实现接线**

要点：
- `world.ts` 加 `interface DomeLike`，照 `PuffLike` 的位置放，`update(t, sunDir, view?)`。
- 挂载照 `sea` / `puffs` 的 try/catch，`await import('./dome-cloud')`。
- `applyQuality` 加 `dome?.setQuality?.(high)`。
- `update` 里 `dome.update(time, sunDir, lastView)`——**用 `lastView`，与 sea 同源**。
- `setCloudPalette` 同时转发给 dome。
- 新增 `setDomeVisible` 与 `get dome()`。
- `main.ts`：`parseDomeVisible(qaParams.get('dome'))` → `world?.setDomeVisible(...)`。
- `smoke.mjs` 白名单补 5 个新模块。

- [ ] **Step 4: 跑全量测试与构建**

Run: `npx vitest run && npx tsc --noEmit && node scripts/smoke.mjs`
Expected: 全绿、tsc exit 0、smoke ok

- [ ] **Step 5: 提交**

```bash
git add src/world.ts src/main.ts src/world.test.ts scripts/smoke.mjs
git commit -m "feat(dome): mount the cloud deck in the world and wire ?dome=0"
```

---

### Task 8: 性能仪器

**Files:**
- Create: `src/frame-stats.ts`
- Test: `src/frame-stats.test.ts`
- Modify: `src/main.ts`（`__porco.qa.frameStats()`）

**Interfaces:**
- Produces:
  - `createFrameStats(capacity: number): { push(ms: number): void; readonly count: number; percentile(p: number): number; readonly mean: number }`
  - `window.__porco.qa.frameStats(): { count: number; mean: number; p50: number; p95: number }`

- [ ] **Step 1: 写失败的测试**

```ts
// src/frame-stats.test.ts
import { describe, expect, it } from 'vitest';
import { createFrameStats } from './frame-stats';

describe('createFrameStats', () => {
  it('reports the mean of what was pushed', () => {
    const s = createFrameStats(4);
    [10, 20, 30, 40].forEach((ms) => s.push(ms));
    expect(s.count).toBe(4);
    expect(s.mean).toBeCloseTo(25, 6);
  });
  it('returns percentiles from the ring', () => {
    const s = createFrameStats(100);
    for (let i = 1; i <= 100; i += 1) s.push(i);
    expect(s.percentile(50)).toBeCloseTo(50, 0);
    expect(s.percentile(95)).toBeCloseTo(95, 0);
  });
  it('drops the oldest sample when full', () => {
    const s = createFrameStats(3);
    [1, 2, 3, 4].forEach((ms) => s.push(ms));
    expect(s.count).toBe(3);
    expect(s.mean).toBeCloseTo(3, 6);
  });
  it('ignores non-finite samples', () => {
    const s = createFrameStats(4);
    s.push(Number.NaN);
    expect(s.count).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/frame-stats.test.ts`
Expected: FAIL — `Failed to resolve import "./frame-stats"`

- [ ] **Step 3: 实现 `src/frame-stats.ts` 并接到 `main.ts`**

要点：定长 `Float64Array` 环形缓冲；`percentile` 排序副本后线性插值；`main.ts` 的 `stepFrame` 用 **`dt*1000`** 推入（不是 `Date.now()`），`__porco.qa.frameStats()` 返回四个数。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/frame-stats.test.ts && npx tsc --noEmit`
Expected: PASS（4 个用例）、tsc exit 0

- [ ] **Step 5: 提交**

```bash
git add src/frame-stats.ts src/frame-stats.test.ts src/main.ts
git commit -m "feat(dome): frame-time ring buffer for the performance gate"
```

---

### Task 9: 量测脚本、调参与验收

**Files:**
- Create: `artifacts/dome-audit/measure.py`
- Create: `artifacts/dome-audit/`（抓帧 PNG）
- Create: `docs/superpowers/reviews/2026-11-09-dome-cloud-p1-review.md`

**Interfaces:**
- Consumes: Task 1–8 全部产出
- Produces: 门 1–6 的可复跑量测与一份带证据的 P1 验收报告

**ROI 定义（钉死，不许再改）**：**云带区域 = `?dome=1` 与 `?dome=0` 两张同机位帧的差异掩码**（逐像素 `max|ΔRGB| > 8`）。门 2/3/4 的所有统计都只在这个掩码内做。**不按行分带**——海面那套 0.40–0.52 / 0.70–0.97 是海专用的，照搬会重演上次的坑。

- [ ] **Step 1: 写量测脚本**

`artifacts/dome-audit/measure.py`，输入 `on.png off.png t0.png t30.png`，输出：
- `coverage%`（掩码面积占比）— 门 1
- `tone_span = p92(L) − p8(L)`，`L` 为线性亮度，只在掩码内统计 — 门 2
- `drift = mean|t0 − t30|` 与 `max_single_frame_jump` — 门 3
- `row_stripes = 行均值梯度 > 3 的行数`，只在掩码内统计 — 门 4

- [ ] **Step 2: 抓帧**

Run: `npm run dev`
固定 `?pos=` 与 `?qa=frozen`，抓：`?dome=1`、`?dome=0`、以及 `qa.step(1800)` 前后的 `t0`/`t30` 各一张。
Expected: 四张帧除云外一致

- [ ] **Step 3: 跑量测，判门 1–4**

Run: `python artifacts/dome-audit/measure.py artifacts/dome-audit/{on,off,t0,t30}.png`
Expected: `coverage > 0`、`tone_span ≥ 0.2`、`2 ≤ drift ≤ 12`、`row_stripes` 不成片（门 5 另做目检：环面边界与地平线融合处不得见直线）
未过则回 Task 2（drift）或 Task 6（光照/侵蚀）调参，**调完重跑本步**

- [ ] **Step 4: 判门 6——两档都要**

- 手机 low 档（验收机：旗舰 Android Chrome）：`__porco.qa.frameStats()` 连续 300 帧，**`p95 < 33.3 ms`**。
- 桌面 high 档：同样调用，**`p95 < 24 ms`**（不触发 `SLOW_FRAME_MS`）。
Expected: 两档同时达标；任一档不达标则回 Task 6 降 octave 或步数

- [ ] **Step 5: 写验收报告并提交**

报告逐门记「通过 / 未通过 / 未测」，未过写明原因与下一步。
```bash
git add artifacts/dome-audit docs/superpowers/reviews/2026-11-09-dome-cloud-p1-review.md
git commit -m "test(dome): p1 acceptance frames, measurements and review"
```

---

## Self-Review

**1. Spec coverage**

| Spec 章节 | 落在哪个任务 |
|---|---|
| §5.1 云层几何（slab / 1800 半宽 / 淡出 / 盒壁不可见） | Task 1、Task 6 |
| §5.2 三层密度场 + 分层漂移速度 | Task 2（漂移）、Task 4（体积）、Task 6（装配） |
| §5.3 March（覆盖率契约 / 28-16 步 / IGN） | Task 2、Task 6 |
| §5.4 光照（Beer-Lambert / HG / powder / ambient） | Task 3、Task 6 |
| §5.5 合成（BackSide / depthWrite） | Task 6 |
| §5.6 质量档（只烘一套） | Task 6（`qualityParams` 测试锁定） |
| §5.7 接口（view / setCloudPalette / ?dome=0） | Task 5、Task 6、Task 7 |
| §7 门 1–6 | Task 9（1/2/3/4/5 在 Step 3，6 在 Step 4，两档都有） |
| §9 风险 2（无帧计时基线） | Task 8 |
| §6 P2 风格化 | **不在本计划范围内**，另开计划 |

**2. Step scan**：每个 Step 一个动作一个可检查结果。GPU 装配那步无法单测，用 `qualityParams` / `boxScale` 把可测边界钉住，其余靠 `tsc` + `smoke` + 抓帧门。

**3. Type consistency**：`Vec3` 与 `srgbToLinear` 取自 `sky-track.ts`；`setCloudPalette(bands: readonly Vec3[], haze: Vec3)` 与 `main.ts:300` 的现有调用一致；`DomeCloudHandles.update` 的 `view` 类型 **直接 import `WorldView`**，不写内联结构（防漂移）。

**4. Review Focus**：五条分别落在 Task 1（slab + boxExit）、Task 5（双开关）、Task 2（elapsed）、Task 6（`boxScale` 无参）、Task 3（真值夜档色）的测试里。

**5. Proportion**：代码块只有测试，没有实现体转写；计划长度约为 spec 的 2 倍，主要增量在测试与门 9 的量测契约。
