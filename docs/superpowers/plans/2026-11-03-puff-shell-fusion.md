# 近景云壳融合（puff shell fusion）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把一朵近景云的几何从「一堆各自完整的球拼进同一个 mesh」换成「一张连续的闭合曲面，交界处用 log-sum-exp 平滑成扇贝边」，让剪影不再读成球堆。

**Architecture:** 新增 `src/puff-shell.ts` 作为纯几何模块：`IcosahedronGeometry` → `mergeVertices` → 逐顶点从质心做射线-球解析求交 → log-sum-exp 融合半径 → 位置哈希絮状位移 → `computeVertexNormals`。`src/puff-shape.ts` 保留现有 lobes 布局，末尾改为调用它；`lobeShade` 从「逐瓣离散值」变成「连续混合权重」，量化搬到 `src/puff-cloud.ts` 的 TSL 片元里。

**Tech Stack:** three 0.186 / WebGPURenderer / TSL / TypeScript / vitest

**Spec:** `docs/superpowers/specs/2026-11-03-puff-shell-fusion-design.md`

## Global Constraints

- three 0.186.0，`WebGPURenderer`；WebGL2 走同一套 TSL，**不许写后端分支**。
- 25 朵云 / 25 份 material（用户已签字，不许减）。
- 帧间隔 ≤ 33.3 ms。
- 壳细分 `detail` 起步 10，**上限 11**（1.45× 面数门）；`k` 起步 0.75，区间 0.5~1.5。
- `PUFF_BAND_THRESHOLDS`、`PUFF_BAND_COLORS`、`CLOUD_PALETTE`、`palettes.test.ts` 的 ΔL* ≥ 15：**一个字都不许改**。
- `puff-cloud.ts` 三件套（`DoubleSide` / `alphaTest = 0.02` / `depthWrite = true`）：不许拆。
- 壳细分与求交**不消耗 `rand()`**；`lobes[]` 的布局代码原样保留。
- 允许修改的既有断言仅限 spec §8.1 列出的四条，其余冻结。

## Review Focus

按 spec 隐含但没有任何测试覆盖、且最可能咬人的输入排序：

1. **某个射线方向打不到任何球**（非星形、或 lobes 退化）。预期：不产生 `NaN`、不塌成 0，用最近球的半径兜底。
2. **`shades.length` 与 `position.count` 不相等**（属性错位）。预期：长度恒等，且逐顶点对应同一方向。
3. **片元量化阈值与 JS 镜像漂移**。预期：两边读同一份阈值常量，镜像测试钉住。
4. **`blobs` 忘加 bbox 中心偏移**，导致白雾椭球与云错位。预期：blob 中心 = 几何 bbox 中心的世界坐标。
5. **构建耗时随 detail 超预算**，首屏卡顿。预期：25 朵构建 ≤ 500 ms，超了必须先优化求交再谈 detail。

---

### Task 1: 壳几何生成（`buildPuffShell`）

**Files:**
- Create: `src/puff-shell.ts`
- Test: `src/puff-shell.test.ts`

**Interfaces:**
- Consumes: `THREE.IcosahedronGeometry`、`mergeVertices`（`three/addons/utils/BufferGeometryUtils.js`，动态 import）
- Produces:
  ```ts
  export interface PuffLobe { x: number; y: number; z: number; r: number; shade: number }
  export interface PuffShellResult {
    geometry: THREE.BufferGeometry;  // 索引几何，原点在 r³ 加权质心
    shades: Float32Array;            // 每顶点连续 shade，与 geometry 顶点顺序一致
    centerOffset: THREE.Vector3;     // bbox 中心相对质心的偏移
  }
  export const PUFF_SHELL_DETAIL = 10;
  export const PUFF_FUSION_K = 0.75;
  export const PUFF_SHADE_SIGMA_RATIO = 0.3;
  export const PUFF_FLUFF_AMPLITUDE = 0.04;
  export async function buildPuffShell(
    lobes: readonly PuffLobe[],
    detail?: number,
    k?: number,
  ): Promise<PuffShellResult>;
  ```

- [ ] **Step 1: 写失败测试——闭合流形**

在 `src/puff-shell.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildPuffShell, type PuffLobe } from './puff-shell';

const LOBES: PuffLobe[] = [
  { x: 0, y: -6, z: 0, r: 7, shade: -0.4 },
  { x: 1, y: 0, z: 0, r: 8, shade: 0.2 },
  { x: -1, y: 6, z: 0, r: 7, shade: 0.6 },
  { x: 9, y: 0, z: 1, r: 5, shade: -0.1 },
  { x: -9, y: 2, z: -1, r: 5, shade: 0.3 },
];

function edgeCounts(geo: THREE.BufferGeometry): number[] {
  const idx = geo.getIndex();
  if (!idx) return [];
  const counts = new Map<string, number>();
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i);
    const b = idx.getX(i + 1);
    const c = idx.getX(i + 2);
    for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
      const key = u < v ? `${u}_${v}` : `${v}_${u}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.values()];
}

describe('buildPuffShell', () => {
  it('produces a closed manifold: every edge is shared by exactly two triangles', async () => {
    const { geometry } = await buildPuffShell(LOBES);
    const counts = edgeCounts(geometry);
    expect(counts.length).toBeGreaterThan(0);
    expect(counts.every((n) => n === 2)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/puff-shell.test.ts`
Expected: FAIL — `Failed to resolve import "./puff-shell"`

- [ ] **Step 3: 实现 `buildPuffShell`**

在 `src/puff-shell.ts`，按下列顺序实现（算法是测试决定不了的，所以给全）：

1. 动态 import `mergeVertices`。
2. `const base = new THREE.IcosahedronGeometry(1, detail)`，`const merged = mergeVertices(base, 1e-4)`，`base.dispose()`。
3. 质心：`w = r³`，`O = Σ(cᵢ·wᵢ) / Σwᵢ`。
4. 逐顶点：`d = normalize(position)`；对每颗球解 `|O + t·d − cᵢ| = rᵢ` 取**远根** `t = (−b + √(b²−4c)) / 2`（`b = 2(O−cᵢ)·d`，`c = |O−cᵢ|² − rᵢ²`），`t ≤ 0` 或判别式 ≤ 0 视为无交（`−∞`）。
5. 融合：`tmax = max(tᵢ)`；若 `tmax` 非有限，用最大球的半径兜底（Review Focus 1）。否则只对 `tᵢ > tmax − 5/k` 的球求和（剪枝），`r = tmax + ln(Σ exp(k(tᵢ − tmax))) / k`。
6. `position = d·r`（这一步已经减掉 O，原点即质心）。
7. 絮状：沿径向乘 `1 + PUFF_FLUFF_AMPLITUDE·sin(3.1·p.x)·sin(2.7·p.y + 1.3)·sin(3.3·p.z + 0.7)`，振幅按 `lobeR = max(lobe.r)` 归一。
8. `computeVertexNormals()`、`computeBoundingBox()`；`centerOffset = bbox 中心`（此时原点在质心，所以这个向量就是偏移）。
9. shade：对每个顶点用 `wᵢ = exp(−((tmax − tᵢ)/(σ·lobeR))²)`（`σ = PUFF_SHADE_SIGMA_RATIO`），`shade = Σwᵢ·shadeᵢ / Σwᵢ`，写进 `Float32Array`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/puff-shell.test.ts`
Expected: PASS

- [ ] **Step 5: 写失败测试——确定性、包围盒、原点、shade 契约**

追加：

```ts
it('is bit-identical for the same lobes', async () => {
  const a = await buildPuffShell(LOBES);
  const b = await buildPuffShell(LOBES);
  expect(Array.from(a.geometry.getAttribute('position').array)).toEqual(
    Array.from(b.geometry.getAttribute('position').array),
  );
});

it('keeps the bbox within 15% of the hard union', async () => {
  const { geometry } = await buildPuffShell(LOBES);
  geometry.computeBoundingBox();
  const size = new THREE.Vector3();
  geometry.boundingBox!.getSize(size);
  // 硬并集：每球 bbox 的并集
  const lo = new THREE.Vector3(Infinity, Infinity, Infinity);
  const hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (const l of LOBES) {
    lo.min(new THREE.Vector3(l.x - l.r, l.y - l.r, l.z - l.r));
    hi.max(new THREE.Vector3(l.x + l.r, l.y + l.r, l.z + l.r));
  }
  const hard = new THREE.Vector3().subVectors(hi, lo);
  for (const axis of ['x', 'y', 'z'] as const) {
    expect(size[axis]).toBeGreaterThan(hard[axis] * 0.85);
    expect(size[axis]).toBeLessThan(hard[axis] * 1.15);
  }
});

it('puts the origin near the r³-weighted centroid', async () => {
  const { centerOffset } = await buildPuffShell(LOBES);
  const maxR = Math.max(...LOBES.map((l) => l.r));
  expect(centerOffset.length()).toBeLessThan(maxR * 0.5);
});

it('writes one continuous shade per vertex in [-1, 1]', async () => {
  const { geometry, shades } = await buildPuffShell(LOBES);
  expect(shades.length).toBe(geometry.getAttribute('position').count);
  expect(Math.min(...shades)).toBeGreaterThanOrEqual(-1);
  expect(Math.max(...shades)).toBeLessThanOrEqual(1);
  expect(new Set(shades).size).toBeGreaterThan(2);
});

it('never produces NaN when a ray misses every sphere', async () => {
  const spread: PuffLobe[] = [
    { x: 0, y: 0, z: 0, r: 4, shade: 0 },
    { x: 40, y: 0, z: 0, r: 3, shade: 0 },
  ];
  const { geometry } = await buildPuffShell(spread);
  const pos = geometry.getAttribute('position');
  for (let i = 0; i < pos.count; i += 1) {
    expect(Number.isFinite(pos.getX(i))).toBe(true);
    expect(Number.isFinite(pos.getY(i))).toBe(true);
    expect(Number.isFinite(pos.getZ(i))).toBe(true);
  }
});
```

- [ ] **Step 6: 跑测试，按失败项补实现**

Run: `npx vitest run src/puff-shell.test.ts`
Expected: 全部 PASS。`never produces NaN` 若失败，说明 Step 3.5 的兜底没生效。

- [ ] **Step 7: Commit**

```bash
git add src/puff-shell.ts src/puff-shell.test.ts
git commit -m "feat(puff): add radial shell fusion geometry module"
```

---

### Task 2: 接入 `buildPuffGeometry`，保留布局

**Files:**
- Modify: `src/puff-shape.ts:109-193`
- Modify: `src/puff-shape.test.ts:22-55`

**Interfaces:**
- Consumes: Task 1 的 `buildPuffShell`、`PuffLobe`、`PUFF_SHELL_DETAIL`、`PUFF_FUSION_K`
- Produces: `buildPuffGeometry(rand, variant, detail)` 签名不变，返回的几何仍是单个 `BufferGeometry`，带 `PUFF_LOBE_ATTRIBUTE`（现在是连续值）与 `color`

- [ ] **Step 1: 改 `lobes` 生成，带上 shade**

`src/puff-shape.ts` 里 `lobes` 数组元素从 `{x,y,z,r}` 改成 `PuffLobe`（多一个 `shade`）。shade 用现在第 158 行的公式算，**但在布局循环里直接算**，不要新增 `rand()` 调用：

```ts
const raw = (hash01(i + 1) - 0.5) * 1.6 + (lobe.y / halfH) * -0.35;
shade: Math.max(-1, Math.min(1, raw)),   // 连续值，不再 round()
```

- [ ] **Step 2: 替换几何构建段**

删掉第 132-161 行（每瓣 `IcosahedronGeometry` + 位移 + 旋转 + 合并），改成：

```ts
const { geometry: merged, shades, centerOffset } = await buildPuffShell(
  lobes,
  PUFF_SHELL_DETAIL,
  PUFF_FUSION_K,
);
```

- [ ] **Step 3: 保留 `rand()` 消费与属性写入**

- 每瓣原有的 6 次 `rand()`（3 旋转 + 3 缩放）**保留**：加一个 `for (const _ of lobes) { rand(); rand(); rand(); rand(); rand(); rand(); }` 的空转循环，注释写明「保持 A/B 布局对照，见 spec §5.3」。
- `PUFF_LOBE_ATTRIBUTE` 改成写 `shades`。
- `color` 属性照旧生成（每顶点一次 `rand()`），注释写明它仍是死数据。
- `merged.setAttribute(PUFF_LOBE_ATTRIBUTE, new THREE.BufferAttribute(shades, 1))`。
- 把 `centerOffset` 写进 `merged.userData.centerOffset`（Task 4 要用）。

- [ ] **Step 4: 改 `puff-shape.test.ts` 的断言（spec §8.1）**

- 删掉「lobeShade 是所属瓣的常量」（runs 3~16）那条。
- 「量化成三档」改成：

```ts
it('lobeShade is a continuous mix in [-1, 1]', async () => {
  const geo = await buildPuffGeometry(mulberry32(3), 'tower');
  const a = geo.getAttribute(PUFF_LOBE_ATTRIBUTE);
  const v = Array.from({ length: a.count }, (_, i) => a.getX(i));
  expect(Math.min(...v)).toBeGreaterThanOrEqual(-1);
  expect(Math.max(...v)).toBeLessThanOrEqual(1);
  expect(new Set(v).size).toBeGreaterThan(2);
});
```

- 「同种子同结果」那条保留（它测的是整体确定性，仍成立）。

- [ ] **Step 5: 跑测试**

Run: `npx vitest run src/puff-shape.test.ts src/puff-shell.test.ts`
Expected: PASS。若 bbox 那条（`高 < 240 且宽 > 20`）失败，先记录实测值再判断——spec §8.1 说它**应当仍然通过**。

- [ ] **Step 6: Commit**

```bash
git add src/puff-shape.ts src/puff-shape.test.ts
git commit -m "feat(puff): build puff geometry from a fused shell"
```

---

### Task 3: `lobeShade` 的片元量化

**Files:**
- Modify: `src/puff-cloud.ts:207-227`
- Modify: `src/puff-cloud.test.ts`

**Interfaces:**
- Consumes: `PUFF_LOBE_ATTRIBUTE`（连续值）
- Produces: `export function puffShadeQuantized(shade: number): -1 | 0 | 1`（JS 镜像，给单测）；TSL 侧读同一份阈值

- [ ] **Step 1: 写失败测试**

```ts
it('quantizes the continuous shade into three steps at ±1/3', () => {
  expect(puffShadeQuantized(-1)).toBe(-1);
  expect(puffShadeQuantized(-0.34)).toBe(-1);
  expect(puffShadeQuantized(-0.33)).toBe(0);
  expect(puffShadeQuantized(0)).toBe(0);
  expect(puffShadeQuantized(0.33)).toBe(0);
  expect(puffShadeQuantized(0.34)).toBe(1);
  expect(puffShadeQuantized(1)).toBe(1);
  expect(puffShadeQuantized(Number.NaN)).toBe(0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/puff-cloud.test.ts -t quantizes`
Expected: FAIL — `puffShadeQuantized is not a function`

- [ ] **Step 3: 实现镜像 + TSL 侧**

- `src/puff-cloud.ts` 导出 `PUFF_SHADE_THRESHOLDS = [-1 / 3, 1 / 3] as const` 与 `puffShadeQuantized`。
- 在 `makeMaterial` 的 `colorNode` 里，把 `lobeShade.mul(GAIN)` 换成 `quantize(lobeShade).mul(GAIN)`，其中 `quantize` 用两个 `step()` 拼：

```ts
const q = TSL.step(PUFF_SHADE_THRESHOLDS[0], lobeShade)     // -1/3
  .add(TSL.step(PUFF_SHADE_THRESHOLDS[1], lobeShade));       // +1/3
const shadeStep = q.sub(1);                                  // → -1 / 0 / +1
```

- [ ] **Step 4: 跑测试**

Run: `npx vitest run src/puff-cloud.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/puff-cloud.ts src/puff-cloud.test.ts
git commit -m "feat(puff): quantize lobe shade per fragment instead of per vertex"
```

---

### Task 4: `blobs` 原点补偿

**Files:**
- Modify: `src/puff-cloud.ts:287-304`
- Modify: `src/puff-cloud.test.ts`

**Interfaces:**
- Consumes: `geometry.userData.centerOffset`（Task 2 写入）
- Produces:
  ```ts
  export interface PuffBlobSize { halfW: number; halfH: number }
  export function puffBlobCentre(
    meshPosition: THREE.Vector3,
    centerOffset: THREE.Vector3,
    size: PuffBlobSize,
  ): { x: number; y: number; z: number; halfW: number; halfH: number };
  ```

**为什么抽成纯函数**：`initPuffClouds` 依赖 `three/webgpu` 的 `MeshBasicNodeMaterial`，在 vitest 环境里跑不起来。把「mesh 位置 + 原点偏移 → blob 中心」这一段抽出来，就能在不启动渲染器的前提下钉住它。

- [ ] **Step 1: 写失败测试**

```ts
it('offsets the blob centre by the shell origin shift', () => {
  const c = puffBlobCentre(
    new THREE.Vector3(100, 50, -200),
    new THREE.Vector3(0, 1.5, 0),
    { halfW: 15, halfH: 12 },
  );
  expect(c.x).toBeCloseTo(100, 6);
  expect(c.y).toBeCloseTo(51.5, 6);
  expect(c.z).toBeCloseTo(-200, 6);
  expect(c.halfW).toBe(15);
  expect(c.halfH).toBe(12);
});

it('is a no-op when the shell has no origin shift', () => {
  const c = puffBlobCentre(new THREE.Vector3(1, 2, 3), new THREE.Vector3(), {
    halfW: 1,
    halfH: 1,
  });
  expect([c.x, c.y, c.z]).toEqual([1, 2, 3]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/puff-cloud.test.ts -t "blob centre"`
Expected: FAIL — `puffBlobCentre is not a function`

- [ ] **Step 3: 实现纯函数，并在 `blobs` getter 里调用**

```ts
export function puffBlobCentre(meshPosition, centerOffset, size) {
  return {
    x: meshPosition.x + centerOffset.x,
    y: meshPosition.y + centerOffset.y,
    z: meshPosition.z + centerOffset.z,
    halfW: size.halfW,
    halfH: size.halfH,
  };
}
```

`blobs` getter 里把 `out.push({ x: child.position.x, ... })` 换成读 `child.geometry.userData.centerOffset` 后调用它。

- [ ] **Step 4: 跑测试**

Run: `npx vitest run src/puff-cloud.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/puff-cloud.ts src/puff-cloud.test.ts
git commit -m "fix(puff): offset blob centres by the shell origin shift"
```

---

### Task 5: 视觉验收与调参

**Files:**
- Modify: `src/puff-shape.ts`（仅常量：`PUFF_SHELL_DETAIL`、`PUFF_FUSION_K`、`PUFF_FLUFF_AMPLITUDE`）
- Modify: `src/puff-cloud.ts`（仅 `PUFF_LOBE_SHADE_GAIN`、`PUFF_NORMAL_WEIGHT`）

**Interfaces:**
- Consumes: Task 1~4 的成品
- Produces: 通过 spec §8 验收 1、3、6 的参数组合

- [ ] **Step 1: 抓帧（同机位、同种子）**

按 `artifacts/cloud-audit/protocol-2026-11-01/` 的机位与状态抓一组帧，存 `artifacts/ghibli-audit/live/shell-a.png`。

- [ ] **Step 2: 量碎边组件数与硬边密度**

Run: `python artifacts/ghibli-audit/edge-loops.py --image artifacts/ghibli-audit/live/shell-a.png`
Expected: `fragmented-edge components` ≤ 20（现状 320）**且** `hard-edge density` ≤ 0.3%（现状 1.3%）。任一超门，进 Step 3。

- [ ] **Step 3: 按顺序调三个旋钮（一次只动一个）**

1. `PUFF_FUSION_K`：0.75 → 0.6（更圆滑，包围盒 +2.6%）→ 0.5（+9.5%，接近 15% 门）。
2. `PUFF_SHELL_DETAIL`：10 → 11（面数 1.45×，构建约 430 ms）。
3. `PUFF_LOBE_SHADE_GAIN`：0.22 → 0.26（团块边界变软后需要更大推力；上限受「档 1 ≥ 16.7%」约束）。

每调一次重抓帧、重量一次，记录数字。

- [ ] **Step 4: 瓣可数复核**

同机位截图，人眼确认单朵云能数出 ≥ 3 个色块边界，且**没有一条边界与球轮廓重合**。

- [ ] **Step 5: 记录结果并 Commit**

把最终参数与三组数字写进 `docs/superpowers/reviews/2026-11-03-puff-shell-fusion-review.md`。

```bash
git add src/puff-shape.ts src/puff-cloud.ts docs/superpowers/reviews/
git commit -m "feat(puff): tune shell fusion constants against edge-loop measurements"
```

---

### Task 6: 全量回归

**Files:**
- 无新增；跑既有检查

- [ ] **Step 1: 类型检查**

Run: `npx tsc --noEmit`
Expected: 退出码 0

- [ ] **Step 2: 全量测试**

Run: `npx vitest run`
Expected: 全绿

- [ ] **Step 3: 构建耗时**

Run: `node artifacts/archive/puff-shell-fusion/shell-bench.mjs 10 0.75`
Expected: `totalMs` ≤ 500

- [ ] **Step 4: 帧预算**

按 `puff-budget-2026-11-02.json` 的方法重跑 paired on/off。
Expected: 帧间隔 ≤ 33.3 ms；视锥内三角形 ≤ 1.5× 现状

- [ ] **Step 5: 最终 Commit**

```bash
git add -A
git commit -m "test(puff): verify shell fusion against spec acceptance"
```

---

## 自检记录

- **spec 覆盖**：§6.1/6.2（Task 1）、§6.3（Task 5 调参）、§6.4（已完成的探针，不占任务）、§6.5 絮状（Task 1 Step 3.7）、§6.6 权重（Task 1 Step 3.9）、§7 量化层级（Task 3）、§6.1 原点（Task 1 + Task 4）、§5.3 RNG（Task 2 Step 3）、§8.1 断言清单（Task 2 Step 4 + Task 3）。
- **Review Focus 落点**：1→Task 1 最后一条测试；2→Task 1 shade 长度断言；3→Task 3 镜像测试；4→Task 4；5→Task 6 Step 3。
- **未覆盖**：spec §8 验收 2（拓扑）由 Task 1 流形测试覆盖；验收 5（确定性）由 Task 1 第二条覆盖；验收 7（回归）由 Task 6 覆盖。
