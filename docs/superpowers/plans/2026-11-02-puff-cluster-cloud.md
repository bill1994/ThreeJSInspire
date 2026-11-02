# 近景球簇云（puff）重做 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把近景 puff 从「一堆各自带球面渐变的气球」改成「几团平涂色块凑成的云簇」，散布在视野里而非一条走廊，能撞穿，高低随机，按测量决定是否上 LOD。

**Architecture:** 拆成三个模块——`puff-shape.ts`（几何：四种变体 + per-lobe 属性）、`puff-field.ts`（散布 + 方形环面窗口 + 边界淡出）、`puff-cloud.ts`（着色 + 场景装配）。白雾从「按高度」改成「按离最近云团的接近度」，`PuffHandle` 因此多暴露一份 `blobs` 给 `game.ts` 的三个消费者。

**Tech Stack:** TypeScript + Vite + three 0.186.0（`WebGPURenderer` + `three/tsl`）+ vitest。

**Spec:** `docs/superpowers/specs/2026-11-02-puff-cluster-cloud-design.md`

## Global Constraints

- three 版本 0.186.0；WebGPU 与 WebGL2 共用同一条 TSL 路径，**不得写后端分支**。
- `material.side = DoubleSide`、`material.alphaTest = 0.02`、`material.depthWrite = true` 三条不许改（理由见 spec §5.1）。
- `CLOUD_PALETTE` 一个值都不许改；`src/palettes.test.ts` 的 `ΔL*(base, skyTop) >= 15` 必须继续通过。
- `PUFF_BAND_THRESHOLDS = [0.2, 0.5, 0.76]` 是阈值单源，JS 与 TSL 两侧都读它。
- puff 云的高度范围是 `FLIGHT.ALT_MIN..FLIGHT.ALT_MAX`（240），**不**使用 `CLOUD_BAND`。
- draw call 只许减不许增；帧间隔 ≤ 33.3 ms。
- 每朵云撞进去必须是雾，不得出现硬切边或整朵隐形。

## Review Focus

1. **贴海飞行（y ≈ ALT_MIN）**：云底净空若按旧常量算，云会插进水面——净空必须随云自身的 `halfH` 反解，不是固定 8 m。
2. **掉头 180°**：方形窗口的边界淡出会同时出现在两个方向，若窗太小或淡出带重叠，会出现一堵「云墙」横在眼前。
3. **camera 与 plane 分离**：`rig.update` 有滞后，窗口中心必须固定用**相机**位置，用飞机位置会让回收抖动。
4. **窗口 resize / DPR 变化**：LOD 的投影误差随物理视口高度变，resize 时可能整场翻档闪烁——选档必须滞回，且 resize 后不能立刻重选。
5. **切后台再回来**：`dt` 被钳到 0.1 s，但玩家可能已移动很远；窗口取模必须对任意偏移一次到位，不能靠循环步进。

---

### Task 1: 拆文件（零行为变更）

**Files:**
- Create: `src/puff-shape.ts`
- Create: `src/puff-field.ts`
- Modify: `src/puff-cloud.ts`
- Modify: `src/far-field.ts:22`
- Test: `src/puff-cloud.test.ts`（仅改 import，30 条断言一条不许动）

**Interfaces:**
- Produces: `puff-shape.ts` 导出 `PUFF_SHAPE`、`mulberry32`、`buildPuffGeometry`；`puff-field.ts` 导出 `PUFF_FIELD_DEPTH`、`PUFF_BEHIND_MARGIN`、`PUFF_X_SPAN`、`PUFF_SCATTER`、`PuffSize`、`PuffSpot`、`puffGridCells`、`puffScatter`、`wrapPuffZ`。
- Consumes: 无。

- [ ] **Step 1: 记录基线**

Run: `npx vitest run src/puff-cloud.test.ts`
Expected: PASS, 30 tests。把条数记下来，后续 Step 要与它相等。

- [ ] **Step 2: 纯搬运**

按注释块的归属把 `puff-cloud.ts` 切成三份：几何相关（`mulberry32`、`PUFF_SHAPE`、`buildPuffGeometry`）进 `puff-shape.ts`；散布与回收（`PuffSize`、`PuffSpot`、`PUFF_SCATTER`、`puffGridCells`、`puffScatter`、`wrapPuffZ`、`fadeForDistance` 及常量）进 `puff-field.ts`；材质与 `initPuffClouds` 留在 `puff-cloud.ts`。**不写新逻辑，不改任何常量值**。`puff-cloud.ts` 从两个新文件 import。

- [ ] **Step 3: 修 import**

`far-field.ts` 的 `wrapPuffZ` / `PUFF_FIELD_DEPTH` / `PUFF_BEHIND_MARGIN` 改从 `./puff-field` 引入；`src/puff-cloud.test.ts` 按新归属改 import 路径，断言一字不动。

- [ ] **Step 4: 验证条数不变**

Run: `npx vitest run src/puff-cloud.test.ts && npx tsc --noEmit`
Expected: PASS 且仍是 30 tests；`tsc` 零错误。

- [ ] **Step 5: 全量回归**

Run: `npx vitest run`
Expected: 全绿，总数与改动前一致。

- [ ] **Step 6: Commit**

```bash
git add -A src && git commit -m "refactor(puff): split shape / field / material modules, no behaviour change"
```

---

### Task 2: 四种变体 + per-lobe 属性

**Files:**
- Modify: `src/puff-shape.ts`
- Test: `src/puff-shape.test.ts`（Create）

**Interfaces:**
- Produces: `type PuffVariantName = 'bank' | 'tower' | 'scraps' | 'leviathan'`；`interface PuffVariant { width: number; aspect: number; lobeDiameter: number; spineFrac: number; weight: number }`；`PUFF_VARIANTS: Record<PuffVariantName, PuffVariant>`；`PUFF_VARIANT_ORDER: readonly PuffVariantName[]`；`buildPuffGeometry(rand: () => number, variant?: PuffVariantName, detail?: number): Promise<THREE.BufferGeometry>`；`PUFF_LOBE_ATTRIBUTE = 'lobeShade'`。
- Consumes: Task 1 的 `mulberry32`。**`PUFF_SHAPE` 在本任务删除**，由 `PUFF_VARIANTS.bank` 取代；它原来的 `detail` 字段由新的 `PUFF_DEFAULT_DETAIL = 2` 接手。

- [ ] **Step 1: 写失败测试**

```ts
// src/puff-shape.test.ts
describe('PUFF_VARIANTS', () => {
  it('四种变体的高宽比互不相同，且 bank 横摊、tower 竖立', () => {
    expect(PUFF_VARIANTS.bank.aspect).toBeLessThan(1);
    expect(PUFF_VARIANTS.tower.aspect).toBeGreaterThan(1.8);
    expect(PUFF_VARIANTS.scraps.aspect).toBeLessThan(PUFF_VARIANTS.bank.aspect);
    const aspects = PUFF_VARIANT_ORDER.map((n) => PUFF_VARIANTS[n].aspect);
    expect(new Set(aspects).size).toBe(aspects.length);
  });
});

describe('buildPuffGeometry (per-lobe attribute)', () => {
  it('每个顶点的 lobeShade 是所属瓣的常量', async () => {
    const geo = await buildPuffGeometry(mulberry32(3), 'tower');
    const a = geo.getAttribute(PUFF_LOBE_ATTRIBUTE);
    expect(a.itemSize).toBe(1);
    expect(a.count).toBe(geo.getAttribute('position').count);
    // 同一瓣内部必须同值：相邻顶点差为 0 的比例远高于随机
    const v = Array.from({ length: a.count }, (_, i) => a.getX(i));
    expect(new Set(v).size).toBeGreaterThanOrEqual(3);   // 至少 3 团
    expect(new Set(v).size).toBeLessThanOrEqual(16);     // 不是逐顶点噪声
  });

  it('lobeShade 落在 [-1, 1] 且同种子同结果', async () => {
    const g1 = await buildPuffGeometry(mulberry32(9), 'bank');
    const g2 = await buildPuffGeometry(mulberry32(9), 'bank');
    const s1 = Array.from({ length: g1.getAttribute(PUFF_LOBE_ATTRIBUTE).count }, (_, i) =>
      g1.getAttribute(PUFF_LOBE_ATTRIBUTE).getX(i));
    expect(Math.min(...s1)).toBeGreaterThanOrEqual(-1);
    expect(Math.max(...s1)).toBeLessThanOrEqual(1);
    const s2 = Array.from({ length: g2.getAttribute(PUFF_LOBE_ATTRIBUTE).count }, (_, i) =>
      g2.getAttribute(PUFF_LOBE_ATTRIBUTE).getX(i));
    expect(s2).toEqual(s1);
  });

  it('四种变体各自能被撞穿的体积：bbox 高 < 240 m 且宽 > 20 m', async () => {
    for (const name of PUFF_VARIANT_ORDER) {
      const geo = await buildPuffGeometry(mulberry32(11), name, 1);
      geo.computeBoundingBox();
      const b = new THREE.Box3().setFromBufferAttribute(geo.getAttribute('position') as THREE.BufferAttribute);
      expect(b.max.y - b.min.y).toBeGreaterThan(15);
      expect(b.max.y - b.min.y).toBeLessThan(240);
      expect(b.max.x - b.min.x).toBeGreaterThan(20);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/puff-shape.test.ts`
Expected: FAIL — `PUFF_VARIANTS is not defined` / `buildPuffGeometry is not a function of the new signature`.

- [ ] **Step 3: 实现**

`PUFF_VARIANTS` 起始值（spec §7 的性格，数值是可调的起点）：`bank { width: 30, aspect: 0.85 }`、`tower { width: 22, aspect: 1.95 }`、`scraps { width: 16, aspect: 0.55 }`、`leviathan { width: 48, aspect: 1.15 }`；`lobeDiameter` 全部 0.62，`spineFrac` bank 0.6 / tower 0.62 / scraps 0.5 / leviathan 0.6，`weight` 5 / 2 / 3 / 1。

`buildPuffGeometry` 沿用现有骨架（主轴瓣 + 肩瓣 + 絮状位移 + `mergeGeometries`），把 `PUFF_SHAPE.width/aspect/lobeDiameter` 换成 `PUFF_VARIANTS[variant]`。**每瓣一个常量**：按瓣序号 `i` 与该瓣中心 y 算 `lobeShade = clamp((hash01(i, seed) - 0.5) * 1.6 + (lobeCenterY / halfH) * -0.35, -1, 1)`，在 `parts.push(g)` 时把它写给该瓣全部顶点，合并后作为 `Float32Array` 属性 `lobeShade`（itemSize 1）。合并后再 `merged.center()`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/puff-shape.test.ts`

Expected: PASS。

接着跑 `npx vitest run src/puff-cloud.test.ts`。**预期会红**：`PUFF_SHAPE` 已删除，且 `bank` 现在是横摊（aspect 0.85），旧断言 `size.y > PUFF_SHAPE.width * 1.15` 不再成立。把引 `PUFF_SHAPE` 的三处改成按变体断言：`width` → `PUFF_VARIANTS.bank.width`、高宽比断言改成 `<`、`PUFF_SHAPE.detail` → `PUFF_DEFAULT_DETAIL`。改完再跑一次，绿。

- [ ] **Step 5: Commit**

```bash
git add src/puff-shape.ts src/puff-shape.test.ts
git commit -m "feat(puff): four shape variants and a per-lobe shade attribute"
```

---

### Task 3: 着色压平 + 环境填充 + 逆光边

**Files:**
- Modify: `src/puff-cloud.ts`（`initPuffClouds` 的 `colorNode` 段）
- Test: `src/puff-cloud.test.ts`

**Interfaces:**
- Produces: `PUFF_NORMAL_WEIGHT = 0.10`、`PUFF_LOBE_SHADE_GAIN = 0.18`、`PUFF_RIM = { gain: 0.35, power: 2.5 }`、`puffAmbientColor(): THREE.Color`。
- Consumes: Task 2 的 `PUFF_LOBE_ATTRIBUTE`；`CLOUD_PALETTE` / `SKY_PALETTE`。

- [ ] **Step 1: 写失败测试**

```ts
describe('puff ambient fill', () => {
  it('填充色从 SKY_PALETTE 派生，比 shadow 亮至少 6 L*', () => {
    const amb = puffAmbientColor();
    expect(lstar(amb)).toBeGreaterThanOrEqual(lstar(new THREE.Color(CLOUD_PALETTE.shadow)) + 6);
  });
  it('派生不修改 CLOUD_PALETTE', () => {
    const before = JSON.stringify(CLOUD_PALETTE);
    puffAmbientColor();
    expect(JSON.stringify(CLOUD_PALETTE)).toBe(before);
  });
  it('逐瓣法线权重降到 0.10，且这组常量被导出', () => {
    expect(PUFF_NORMAL_WEIGHT).toBe(0.10);
    expect(PUFF_LOBE_SHADE_GAIN).toBeGreaterThan(0);
    expect(PUFF_RIM.power).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/puff-cloud.test.ts -t "puff ambient fill"`
Expected: FAIL — `puffAmbientColor is not a function`.

- [ ] **Step 3: 实现**

`puffAmbientColor()` = `new THREE.Color(SKY_PALETTE.top).lerp(new THREE.Color(SKY_PALETTE.horizon), 0.4)`，每次调用新建，不得缓存到 `CLOUD_PALETTE`。

`colorNode` 改动：`surface.dot(sun)` 的系数从 0.28 换成 `PUFF_NORMAL_WEIGHT`；`belly` 的输入从 `normalLocal.y` 换成 `radial.y`（云心定义，整簇连续）；`sunW` 加上 `lobeShade * PUFF_LOBE_SHADE_GAIN`（用 `TSL.attribute('lobeShade', 'float')`）后再 clamp；band0 先与 `puffAmbientColor()` 混合再进 mix 链；末尾按 `pow(1 - dot(radial, toCamera), PUFF_RIM.power) * PUFF_RIM.gain` 往 `gold` 提，**只乘在 band2/3 上**。

再给 `opacityNode` 末尾乘一个 `TSL.uniform(1)`，挂在 `material.userData.edgeFade` 上。**Task 3 阶段它恒为 1**，Task 4 才每帧驱动。

- [ ] **Step 4: 跑测试**

Run: `npx vitest run src/puff-cloud.test.ts`
Expected: PASS，含 `puffBandIndex` 镜像测试（阈值未变，应原样通过）。

- [ ] **Step 5: 抓帧对比（含暗部下限与方向中性）**

Run: `npm run dev` → `?alt=60&qa=frozen`，记录 `__porco.qa.describe()` 的 `render.calls` 与 `canvas`，截图存 `artifacts/cloud-audit/puff-v5-hero.png`。

Expected: 单朵云可数出 3~6 团，团内无球面渐变，`render.calls` 与改动前相同。

- [ ] **Step 6: 量暗部与两向可读性**

先裁出近景云块，量最暗像素的 L\*：必须 ≥ `lstar(puffAmbientColor())`，不得再落回 13 附近。
再用 `?alt=60` 起飞后掉头 180°，朝太阳与背太阳各抓一帧（同高度、同距离）。`?pos=` 钩子要到 Task 6 才有，本步先用飞行取位；Task 6 落地后用它在同一坐标复抓一次，替换这两张。
Expected: 两帧都能读出明暗分档——顺光时亮面更大，逆光时靠边缘光与抬亮的暗部站住，不允许出现「两个方向都是死黑」或「两个方向都一样平」。

- [ ] **Step 7: Commit**

```bash
git add src/puff-cloud.ts src/puff-cloud.test.ts artifacts/cloud-audit/puff-v5-hero.png
git commit -m "feat(puff): flatten per-lobe shading, sky-derived ambient fill, backlit rim"
```

---

### Task 4: 方形环面窗口 + 边界淡出

**Files:**
- Modify: `src/puff-field.ts`
- Modify: `src/far-field.ts`
- Test: `src/puff-field.test.ts`（Create）、`src/far-field.test.ts`

**Interfaces:**
- Produces: `PUFF_WINDOW = 2000`、`PUFF_EDGE_FADE = 150`、`wrapPuffAxis(v: number, centre: number, size?: number): number`、`wrapPuffWindow(x, z, camX, camZ, size?): { x: number; z: number }`、`puffEdgeFade(x, z, camX, camZ, size?, fade?): number`（0..1）、`PUFF_SPACING = 400`。
- Consumes: Task 1 的 `puffScatter` 骨架。

- [ ] **Step 1: 写失败测试**

```ts
describe('wrapPuffAxis', () => {
  it('任意偏移一次到位，不靠循环步进', () => {
    expect(wrapPuffAxis(-800, -10770)).toBeCloseTo(-1000 - 1000 + ((-800 + 800) % 2000) , 6);
    // 更直接：结果必须落在 [centre - size, centre + size) 的模空间里，且差值是 size 的整数倍
    const out = wrapPuffAxis(-800, -10770);
    expect(Math.abs((out - (-800)) % 2000)).toBeLessThan(1e-6);
  });
  it('已经是最近一格的输入原样返回', () => {
    expect(wrapPuffAxis(-800, -800)).toBe(-800);
  });
  it('非有限输入回原值', () => {
    expect(wrapPuffAxis(Number.NaN, 0)).toBeNaN();
  });
});

describe('puffEdgeFade', () => {
  it('窗口中心是 1，边界外是 0', () => {
    expect(puffEdgeFade(0, 0, 0, 0)).toBe(1);
    expect(puffEdgeFade(1000, 0, 0, 0)).toBe(0);
  });
  it('淡出带内单调不增', () => {
    const xs = [0, 700, 800, 850, 900, 950, 999];
    const v = xs.map((x) => puffEdgeFade(x, 0, 0, 0));
    for (let i = 1; i < v.length; i += 1) expect(v[i]).toBeLessThanOrEqual(v[i - 1] + 1e-9);
  });
  it('掉头扫过时淡出不跳变（含跨窗口接缝）', () => {
    let prev = puffEdgeFade(-900, 0, 0, 0);
    for (let camX = 0; camX <= 2000; camX += 20) {
      const x = wrapPuffWindow(-900, 0, camX, 0).x;
      const f = puffEdgeFade(x, 0, camX, 0);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
      expect(Math.abs(f - prev)).toBeLessThan(0.25);
      prev = f;
    }
  });
});

describe('puffScatter (window layout)', () => {
  it('400 m 间距、2000 m 窗口给出 20~30 朵', () => {
    const sizes = Array.from({ length: 30 }, () => ({ halfW: 25, halfH: 40, s: 2.1 }));
    const spots = puffScatter(7, sizes);
    expect(spots.length).toBeGreaterThanOrEqual(20);
    expect(spots.length).toBeLessThanOrEqual(30);
  });
  it('高度带落在 [ALT_MIN + SEA_CLEAR, ALT_MAX]，不再用 CLOUD_BAND', () => {
    const sizes = Array.from({ length: 30 }, () => ({ halfW: 25, halfH: 40, s: 2.1 }));
    for (const s of puffScatter(7, sizes)) {
      expect(s.y - 40).toBeGreaterThanOrEqual(FLIGHT.ALT_MIN);
      expect(s.y + 40).toBeLessThanOrEqual(FLIGHT.ALT_MAX);
    }
  });
});
```

另在 `src/far-field.test.ts` 加一条（Review Focus 3）：

```ts
it('puff 绕相机取模，不绕飞机', () => {
  // 飞机在 z=-200，相机因跟随滞后在 z=-150；同一朵云必须按相机定中心
  const cloudZ = -1200;
  const wrapped = wrapPuffWindow(0, cloudZ, 0, -150).z;
  expect(wrapped).toBeGreaterThan(-150 - PUFF_WINDOW / 2);
  expect(wrapped).toBeLessThanOrEqual(-150 + PUFF_WINDOW / 2);
  expect(wrapped).not.toBe(wrapPuffWindow(0, cloudZ, 0, -200).z);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/puff-field.test.ts src/far-field.test.ts`
Expected: FAIL — 未导出 `wrapPuffAxis` / `puffEdgeFade`；`puffScatter` 仍按 `CLOUD_BAND.bottom` 收顶。

- [ ] **Step 3: 实现 `wrapPuffAxis`**

`const half = size / 2; if (Math.abs(v - centre) <= half) return v; let rel = (v - centre) % size; rel = rel < 0 ? rel + size : rel; return centre - half + rel;`——已经在窗口内就直接返回，避免每帧浮点漂移；负数取模必须先校正。

- [ ] **Step 4: 跑 `wrapPuffAxis` 的测试**

Run: `npx vitest run src/puff-field.test.ts -t "wrapPuffAxis"`
Expected: PASS。

- [ ] **Step 5: 实现 `puffEdgeFade` 与 `wrapPuffWindow`**

`puffEdgeFade` 取两轴里更靠边的那一个：`d = max(|wrapPuffAxis(x,camX)-camX|, |wrapPuffAxis(z,camZ)-camZ|)`，`t = clamp((size/2 - d) / fade, 0, 1)`，返回 `t*t*(3-2t)`。

- [ ] **Step 6: 跑测试**

Run: `npx vitest run src/puff-field.test.ts -t "puffEdgeFade"`
Expected: PASS。

- [ ] **Step 7: 重写 `puffScatter` 的网格与高度带**

网格改为**正方形**：`cells = floor(PUFF_WINDOW / PUFF_SPACING) = 5`，`cell = 400`。高度带上下界换成 `FLIGHT.ALT_MIN + SEA_CLEAR + halfH` 与 `FLIGHT.ALT_MAX - halfH`（不再读 `CLOUD_BAND`）。种子按 `PUFF_VARIANTS[*].weight` 抽变体，同种子结果必须完全确定。

- [ ] **Step 8: 跑测试**

Run: `npx vitest run src/puff-field.test.ts`
Expected: PASS，含 20~30 朵与高度带两条。

- [ ] **Step 9: 接 `far-field.ts`**

puff 的回收从 `wrapPuffZ` 换成 `wrapPuffWindow(p.x, p.z, camX, camZ)`，**同时写 `position.x` 与 `position.z`**（窗口中心是相机，不是飞机）。每帧写 `mesh.material.userData.edgeFade.value = fade`——因为透明度是逐朵的，每朵云需要 `clone()` 一份 material（draw call 不变，仍是每朵一次），`< 0.01` 时直接 `visible = false` 省掉这次 draw。

- [ ] **Step 10: 跑测试**

Run: `npx vitest run src/puff-field.test.ts src/far-field.test.ts`
Expected: PASS。旧 `puff-cloud.test.ts` 里针对 `wrapPuffZ` 的断言若失败，说明 Task 1 搬错了归属，回 Task 1 修。

- [ ] **Step 11: 实机验证掉头**

`npm run dev` → `?alt=60` 起飞后按转向键掉头 180° 飞 20 秒，观察前方是否始终有云、且没有一朵在眼前消失。
Expected: 前方持续有云，无可见跳变。

- [ ] **Step 12: Commit**

```bash
git add src/puff-field.ts src/far-field.ts src/puff-field.test.ts src/far-field.test.ts
git commit -m "feat(puff): square wrap window in x and z with an edge fade"
```

---

### Task 5: 白雾改成按接近度

**Files:**
- Modify: `src/in-cloud.ts`
- Modify: `src/puff-cloud.ts`（`PuffHandle` 增加 `blobs`）
- Modify: `src/game.ts:556,591,596,612`
- Test: `src/in-cloud.test.ts`

**Interfaces:**
- Produces: `interface CloudBlob { x: number; y: number; z: number; halfW: number; halfH: number }`；`cloudProximity01(pos: {x:number;y:number;z:number}, blobs: readonly CloudBlob[]): number`；`whiteout01(proximity: number): number`；`PuffHandle.blobs: readonly CloudBlob[]`。
- Consumes: Task 4 的 `PuffSpot` 与尺寸。

- [ ] **Step 1: 写失败测试**

```ts
describe('cloudProximity01', () => {
  const blob = { x: 0, y: 60, z: -300, halfW: 30, halfH: 25 };
  it('云心处是 1，两倍半径外是 0', () => {
    expect(cloudProximity01({ x: 0, y: 60, z: -300 }, [blob])).toBeCloseTo(1, 6);
    expect(cloudProximity01({ x: 0, y: 60, z: -300 + 200 }, [blob])).toBe(0);
  });
  it('120 m 高空无云时是 0 —— 这条是旧实现最大的错', () => {
    expect(cloudProximity01({ x: 0, y: 120, z: -5000 }, [blob])).toBe(0);
  });
  it('60 m 贴着云是 1 —— 旧实现给 0', () => {
    expect(cloudProximity01({ x: 0, y: 60, z: -300 }, [blob])).toBeGreaterThan(0.9);
  });
  it('空数组、非有限输入都回 0', () => {
    expect(cloudProximity01({ x: 0, y: 0, z: 0 }, [])).toBe(0);
    expect(cloudProximity01({ x: Number.NaN, y: 0, z: 0 }, [blob])).toBe(0);
  });
  it('取所有云里最近的那朵，不是第一朵', () => {
    const far = { x: 900, y: 200, z: 900, halfW: 20, halfH: 20 };
    expect(cloudProximity01({ x: 0, y: 60, z: -300 }, [far, blob])).toBeCloseTo(1, 6);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/in-cloud.test.ts`
Expected: FAIL — `cloudProximity01 is not a function`。

- [ ] **Step 3: 实现 `cloudProximity01` 与 `whiteout01`**

椭球归一化距离：`d = hypot(dx/halfW, dy/halfH, dz/halfW)`，`proximity = 1 - smoothstep(1, 2, d)`，取所有 blob 的最大值。`whiteout01(p) = p * WHITEOUT_MAX`（0.6 保留）。

- [ ] **Step 4: 跑测试**

Run: `npx vitest run src/in-cloud.test.ts`
Expected: PASS。

- [ ] **Step 5: `PuffHandle` 暴露 `blobs`**

由 `initPuffClouds` 从 `spots` 与 `built[i].size` 组装 `CloudBlob[]`（世界坐标，`halfW`/`halfH` 已含 `s` 缩放）。

- [ ] **Step 6: 换掉 `game.ts` 的四个读点**

三处 `inCloud01(camera.position.y)` / `whiteout01(camera.position.y)` 改成读 `world.blobs`；**`camCloud01` 与 director 输入必须是同一个值**（spec §8.4：台词与画面不许打架）。白雾滞回：进用 `p > 0.35`、出用 `p < 0.25`，状态存在 game 内。

- [ ] **Step 7: 跑测试**

Run: `npx vitest run src/in-cloud.test.ts src/game.test.ts`
Expected: PASS。

- [ ] **Step 8: 实机验证穿云**

`?alt=60` 撞进一朵云再穿出。
Expected: 白雾进出自如，无跳变；台词「你在云里」只在真穿云时出现。

- [ ] **Step 9: Commit**

```bash
git add src/in-cloud.ts src/in-cloud.test.ts src/puff-cloud.ts src/game.ts
git commit -m "feat(puff): whiteout follows proximity to the nearest cloud, not altitude"
```

---

### Task 6: QA 钩子

**Files:**
- Modify: `src/main.ts:236-293`
- Test: `src/main.test.ts`（若无则 Create，只测纯函数部分）

**Interfaces:**
- Produces: URL 参数 `?puff=0`（隐藏整个 puff 场）与 `?pos=x,y,z`（把飞机放到该坐标并冻结）；`__porco.qa.setPuffVisible(v: boolean): void`。
- Consumes: Task 5 的 `PuffHandle`。

- [ ] **Step 1: 写失败测试**

```ts
it('parseQaPos 解析合法坐标，拒绝非法输入', () => {
  expect(parseQaPos('1,60,-300')).toEqual({ x: 1, y: 60, z: -300 });
  expect(parseQaPos('1,60')).toBeNull();
  expect(parseQaPos('a,60,-300')).toBeNull();
  expect(parseQaPos(null)).toBeNull();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main.test.ts`
Expected: FAIL — `parseQaPos is not a function`。

- [ ] **Step 3: 实现**

`parseQaPos(raw: string | null): { x: number; y: number; z: number } | null`（纯函数，三个有限数才算合法）。`?puff=0` 让 `initPuffClouds` 之后立刻 `group.visible = false` 并跳过 `blobs` 更新；`?pos=` 在 `boot` 里写 `game` 的初始状态。

- [ ] **Step 4: 跑测试**

Run: `npx vitest run src/main.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/main.ts src/main.test.ts
git commit -m "feat(qa): puff visibility toggle and an explicit placement hook"
```

---

### Task 7: 先测，再决定 LOD

**Files:**
- Modify: `src/puff-cloud.ts`（仅当 Step 3 判定为瓶颈）
- Create: `artifacts/cloud-audit/puff-budget-2026-11-02.json`

**Interfaces:**
- Produces: 一份 paired on/off 的帧时间记录；结论写进 JSON 的 `verdict` 字段（`'no-lod' | 'lod-a' | 'lod-a-plus-b'`）。
- Consumes: Task 6 的 `?puff=0`；Task 4 的 `PUFF_WINDOW`。

- [ ] **Step 1: 采集 paired 样本**

同一机位（`?alt=60&qa=frozen` + 固定 `step()` 序列），交替跑 `?puff=1` 与 `?puff=0` 各 5 次，记录 `performance.now()` 差值 60 帧的平均。**没有 GPU timestamp 就把结论标成 `unmeasurable`**，不许用「看着卡」当证据。

- [ ] **Step 2: 写判定**

```json
{ "verdict": "no-lod", "puffOnMs": 0, "puffOffMs": 0, "deltaMs": 0, "evidence": "paired x5, 60 frames each", "timestamped": false }
```

`deltaMs <= 2` → `verdict = "no-lod"`，跳到 Step 6。

- [ ] **Step 3: 若是瓶颈，先上 A 档并验证耦合假设**

给每朵云预生成 `detail: 1` 的第二份几何，按 spec §12.2 的 `e_px <= 2` 选档（用 `camera.projectionMatrix.elements[5]` 与**未抖动**矩阵），进/出阈值分开、加 dwell。抓帧验证 spec §12.3 的假设：法线压平之后 `detail 1` 的棱面是否还看得见。

- [ ] **Step 4: 验证 LOD 没有引入闪烁**

同一机位来回飞行 10 秒，云不得在高/低档之间反复切换（单帧最多换一档）。

- [ ] **Step 5: 跑测试**

Run: `npx vitest run`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add artifacts/cloud-audit/puff-budget-2026-11-02.json src/puff-cloud.ts
git commit -m "perf(puff): measured paired budget; LOD only where the measurement asks for it"
```

---

## 验收（spec §9 逐条）

| spec 条目 | 由哪个任务交付 |
|---|---|
| 1 明度级数 ≤ 6 | Task 3 |
| 2 暗部下限 | Task 3（`puffAmbientColor`） |
| 3 瓣可数 ≥ 3 团 | Task 2 + Task 3 |
| 4 穿云不穿帮 | Task 5 |
| 5 视野覆盖（角度包络） | Task 4 |
| 6 预算 | Task 7 |
| 7 回归（`palettes.test.ts` / 镜像断言） | 全局约束 |
