# 云层收敛（5 类 → 2 类）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把五套云收敛成「不可达背景层 + 可穿近景层」两层，删掉体积穹顶全链，并把背景层铺成覆盖可见天区的稀疏云带。

**Architecture:** 背景层沿用 `dome-horizon.ts` 的恒定距离环（1300–1700 m，跟随相机 XZ）+ 柔边 billboard，但高度从 350–440 m 铺开到 60–650 m，总数封顶 14；可穿层保留近景 puff 场，兜底壳层 5→3 片并降 alpha；体积穹顶四个模块整体删除，删除前先把 `sunColorFor` 搬出 `dome-cloud-light.ts`、让背景层脱离 `DOME_SLAB` 依赖。

**Tech Stack:** TypeScript 5.5 · three 0.186.0（WebGPU/TSL）· Vitest 2.1

**Spec:** [`docs/superpowers/specs/2026-11-13-cloud-layer-reduction-design.md`](../specs/2026-11-13-cloud-layer-reduction-design.md)

## Global Constraints

- three 0.186.0，WebGPU-only；禁 `ShaderMaterial` / `onBeforeCompile`；引导图禁静态 `import 'three/webgpu'`。
- **色彩单源**：两层云都吃 `sky-track.ts` 的 `cloudBands` / `cloudHaze`，禁旁路调色。
- **不追逐位不变**：删层必然改像素。只对天穹/海面保留恒等门（`sky-color-js.test.ts` 三个 protected describe 必须字节级绿）。
- 每任务 fail-first（先红后绿）；`npx tsc --noEmit` = 0 且 `npx vitest run` 全绿才 commit。
- 提交 scope：`refactor(cloud):` / `feat(cloud):` / `test(cloud):` / `docs(cloud):`。
- 采集协议：`?qa=frozen` + `qa.step()`；`http://localhost:5173`（vite IPv6-only）；Chrome 必须带 `--disable-features=CalculateNativeWinOcclusion`。
- `artifacts/` 只放证据和仪器。

## Review Focus

1. **高空时背景带落到地平线以下**（`ALT_MAX 240` 时 60 m 的云在相机之下）——玩家仍应看得到几块。Task 3 测试 + Task 9 高低两帧。
2. **`sunColorFor` 搬家后颜色漂移**——它同时供 `sky-track.ts` 的 `sunLightColorCss` 与 `main.ts` 的灯色，挪文件不许改算法。Task 1 逐位等价测试。
3. **`?bg=0` 与 `?puff=0` 同时给出时的语义**——两个开关独立，关掉背景层不许影响可穿层，反之亦然。Task 4。
4. **删除 dome 后世界降级路径**——`sky + sea + puffs` 必须仍是合法启动条，且缺 WebGPU 时仍退化到 `sky only`。Task 5。
5. **背景层跟随相机是否读得出「云跟着我跑」**——慢飘 1–3 m/s 与环随相机平移的叠加速度要可接受。Task 9 目检项。

---

### Task 1: 把 `sunColorFor` 搬出 dome 链

**Files:**
- Create: `src/sun-color.ts` + `src/sun-color.test.ts`
- Modify: `src/sky-track.ts:33`（import 改指向）、`src/main.ts:60`、`src/sky-track.test.ts:415`
- Modify: `src/dome-cloud-light.ts`（删掉 `sunColorFor` 与其专属常量，保留 HG/powder 等）

**Interfaces:**
- Produces: `export function sunColorFor(elevationDeg: number): Vec3`（线性 RGB，行为与现实现逐位等价）

- [ ] **Step 1: 写失败测试** —— `src/sun-color.test.ts`

```ts
it('逐位等价：搬家后 el ∈ [-8, 65] 每 0.5° 与旧实现同值', () => {
  // 期望值由改动前从 dome-cloud-light 导出的实现生成，固化成本表（≥4 位小数）
  expect(sunColorFor(6.9684)).toEqual([/* 旧值 */]);
  expect(sunColorFor(-8)).toEqual([/* 旧值 */]);
  expect(sunColorFor(65)).toEqual([/* 旧值 */]);
});
```

- [ ] **Step 2: 跑红** `npx vitest run src/sun-color.test.ts` —— 期望 `Failed to resolve import './sun-color'`
- [ ] **Step 3: 实现** —— 把函数体原样搬进 `src/sun-color.ts`（含它依赖的常量），三处 import 改指向，`dome-cloud-light.ts` 删掉该函数与不再被引用的常量
- [ ] **Step 4: 跑绿** + `npx tsc --noEmit` = 0 + `npx vitest run` 全绿
- [ ] **Step 5: Commit** `refactor(cloud): move sunColorFor out of the dome chain`

### Task 2: 背景层改名并自持高度常量（纯重构，输出不变）

**Files:**
- Rename: `src/dome-horizon.ts` → `src/bg-cloud.ts`（`git mv`），同步 `src/dome-horizon.test.ts` → `src/bg-cloud.test.ts`
- Modify: `src/bg-cloud.ts:34`（删 `import { DOME_SLAB }`）、`:68-69`、`src/world.ts`、`src/main.ts`、`src/world.test.ts`

**Interfaces:**
- Produces: `export const BG_Y_MIN = 350;` / `export const BG_Y_MAX = 440;`（**本任务保持现世界值**，Task 3 才改）

- [ ] **Step 1: 写失败测试** —— `src/bg-cloud.test.ts` 追加

```ts
it('背景层不再依赖 dome 链：模块内无 DOME_SLAB 引用，高度常量自持', async () => {
  const src = await readFile('src/bg-cloud.ts', 'utf8');
  expect(src).not.toMatch(/DOME_SLAB/);
  expect(BG_Y_MIN).toBe(350);
  expect(BG_Y_MAX).toBe(440);
});
```

- [ ] **Step 2: 跑红** `npx vitest run src/bg-cloud.test.ts` —— 期望模块不存在/常量未定义
- [ ] **Step 3: 实现** —— `git mv` 两个文件，全仓 import 改指向，`PATCH_Y_MIN/MAX` 改为本地 `BG_Y_MIN/MAX`（值不变）
- [ ] **Step 4: 跑绿** + tsc + 全量（`patchesFor` 输出须与改动前一致，既有 describe 全过）
- [ ] **Step 5: Commit** `refactor(cloud): rename dome-horizon to bg-cloud, own the band constants`

### Task 3: 背景带铺开到 60–650 m，总数封顶 14

**Files:**
- Modify: `src/bg-cloud.ts`（`BG_Y_MIN/MAX`、`PATCH_COUNT_MIN/MAX`、总数封顶）
- Test: `src/bg-cloud.test.ts`

**Interfaces:**
- Produces: `BG_Y_MIN = 60` / `BG_Y_MAX = 650`；`PATCH_VISIBLE_MAX = 14`

- [ ] **Step 1: 写失败测试**

```ts
it('铺满可见天区：相机 66.8 m 时仰角覆盖 0°..≥18°', () => {
  const camY = 66.8;
  const els = [1, 7, 13, 21, 33].flatMap((b) =>
    patchesFor(11, b).map((p) => (Math.atan2(p.yMetres - camY, p.distanceMetres) * 180) / Math.PI));
  expect(Math.min(...els)).toBeLessThan(1);
  expect(Math.max(...els)).toBeGreaterThan(18);
});

it('稀疏：任一时刻可见块数在 8..14', () => {
  const merged = mergeHeadingPatches([], 3, 0);
  expect(merged.length).toBeGreaterThanOrEqual(8);
  expect(merged.length).toBeLessThanOrEqual(14);
});
```

- [ ] **Step 2: 跑红** `npx vitest run src/bg-cloud.test.ts`
- [ ] **Step 3: 实现** —— `yMetres` 在 `[BG_Y_MIN, BG_Y_MAX]` 内取自现有 `rand()` 序列；`PATCH_VISIBLE_MAX = 14` 用现成的「离视轴远→近丢」排序截断
- [ ] **Step 4: 跑绿** + tsc + 全量
- [ ] **Step 5: Commit** `feat(cloud): spread background patches across the visible sky band`

### Task 4: 开关改名 `?dome=0` → `?bg=0`

**Files:**
- Modify: `src/qa.ts:41`（`parseDomeVisible` → `parseBgVisible`）、`src/main.ts:227`、`src/world.ts:283`（`setDomeVisible` → `setBgVisible`）
- Test: `src/qa.test.ts:95-110`、`src/world.test.ts:190-200`

**Interfaces:**
- Produces: `parseBgVisible(raw: string | null | undefined): boolean`（`'0'` → false，其余 true）；`?dome=` 继续被接受做兼容映射，`?bg=` 优先

- [ ] **Step 1: 写失败测试** —— `parseBgVisible('0') === false`、`parseBgVisible(null) === true`、`?bg=0&dome=1` 时 `bg` 胜
- [ ] **Step 2: 跑红** → **Step 3: 实现**（保留旧名兼容）→ **Step 4: 跑绿** + tsc + 全量
- [ ] **Step 5: Commit** `feat(cloud): bg visibility lever (dome name kept as alias)`

### Task 5: 删除体积穹顶全链

**Files:**
- Delete: `src/dome-cloud.ts`、`dome-cloud-field.ts`、`dome-cloud-noise.ts`、`dome-cloud-light.ts` 及四个单测
- Modify: `src/world.ts`（`initDomeCloud` 挂载与句柄）、`src/main.ts`（dome 装配、`syncSun` 的 dome 扇出、启动条 `dome` 段）

- [ ] **Step 1: 写失败测试** —— `src/bg-cloud.test.ts` 追加

```ts
it('dome 链已不存在，且世界降级路径仍是合法组合', async () => {
  await expect(import('./dome-cloud')).rejects.toThrow();
  expect(['sky + sea + puffs', 'sky + sea + puffs + dome']).not.toContain(
    bootLabelFor({ sky: true, sea: true, puffs: true }));
});
```

- [ ] **Step 2: 跑红** → **Step 3: 实现**（`grep -n "dome-cloud" src/` 必须零命中）→ **Step 4: tsc 0 + 全量绿**
- [ ] **Step 5: Commit** `feat(cloud): delete the volumetric dome chain`

### Task 6: 兜底壳层 5 → 3 片

**Files:** `src/puff-cloud.ts:365-376`、`src/in-cloud.test.ts`

**Interfaces:** `SHELL_COUNT = 3`；`makeShellMaterial(0.07 + (i % 3) * 0.05)`；`scale = 0.28 + rand() * 0.12`

- [ ] **Step 1: 写失败测试** —— 断言壳层数 3、base alpha 落在 0.07–0.12、单瓣包围盒变小
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿** + tsc + 全量
- [ ] **Step 5: Commit** `feat(cloud): three finer interior shells instead of five large ones`

### Task 7: 近景淡出可调 + 专属闸门

**Files:** `src/puff-field.ts:54-56`、`src/puff-field.test.ts`、`src/in-cloud.test.ts`

**Interfaces:** `PUFF_FADE_NEAR` / `PUFF_NEAR_FLOOR` 保持导出；`fadeForDistance(5)` 目标 ≤ 0.40

- [ ] **Step 1: 写失败测试** —— `fadeForDistance(5) <= 0.40` **且** `fadeForDistance(0.5) >= 0.15`（穿云可读性下限，防「云里什么都没有」）
- [ ] **Step 2: 跑红** → **Step 3: 实现**（先动 `PUFF_FADE_NEAR`，`FLOOR` 只在不破下限时动）→ **Step 4: 跑绿** + tsc + 全量
- [ ] **Step 5: Commit** `feat(cloud): soften the near-field puff fade with a readability floor`

### Task 8: 对齐研究四处定点修订（docs）

**Files:** `docs/superpowers/specs/2026-11-13-painted-valley-style-alignment.md`、`docs/superpowers/INDEX.md`

- [ ] **Step 1** §5.2 整节改为「已作废：dome 模块已删（见云层收敛设计）」
- [ ] **Step 2** §3 现状表删除 dome 行、puff 行补「兜底壳层 5→3」
- [ ] **Step 3** §6 分期表 P1/P2 改为指向本设计与云风格文档；§5.4 里 `dome-horizon` 的距离带按 60–650 m 重写
- [ ] **Step 4** INDEX 的 planB/painted-valley 行加指针
- [ ] **Step 5: Commit** `docs(cloud): retire the dome section, repoint the alignment study`

### Task 9: 采集矩阵 + 验收 + INDEX 登记

**Files:** Create `artifacts/cloud-layers/capture.mjs` + `matrix/`；Modify `docs/superpowers/INDEX.md`

- [ ] **Step 1** 抓帧：默认 6.97° / 黄昏 / 夜 / `?tod=12`，每档配 `?puff=0`、`?bg=0`；另加 360° 扫一圈（每 45°）与 `?alt=` 高低两帧
- [ ] **Step 2** 目检：任意朝向 8–14 块、不连成片；穿云三件套（白包围 / 飞机可见 / 有厚度）；
      **`?tod=12` 硬边消失**（含只关 bg 的隔离帧）；**白纱进云是否出现硬切断层**（主人 2026-11-13 从
      「独立手飞」并入本步验收的项——若断层，放宽 `VEIL_INNER` 0.96→0.93 量级再验一次）
- [ ] **Step 3** 性能：同会话 p50/p95 对基线（20.8 / 27.9）
- [ ] **Step 4** INDEX 登记本计划与设计文档状态
- [ ] **Step 5: Commit** `test(cloud): two-layer capture matrix and acceptance gate`

## Self-Review

- 设计 §5-A→Task 2/3/4、§5-B→Task 6/7、删除清单与先决条件→Task 1/5、§6 隔离验证→Task 9 Step 2、§10 文档关系→Task 8。无遗漏。
- Review Focus 五条各落 owning task（1→T3/T9、2→T1、3→T4、4→T5、5→T9）。
- 类型一致：`BG_Y_MIN/MAX`、`PATCH_VISIBLE_MAX`、`parseBgVisible`、`setBgVisible` 全篇同名。
- 比例：任务步骤以「测试就红、实现就绿、提交」为主，未转写实现体。
