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
- Modify: `src/dome-cloud-light.ts`（删掉 `sunColorFor`；它是纯算术、无外部常量依赖，HG/powder 等保留）
- Modify: `src/dome-cloud-light.test.ts:8`（import 改指向）与 `:98-118` 起的两个 describe（「钳制」「I1」迁入 `sun-color.test.ts`，覆盖要活过 Task 5 的删除）

**Interfaces:**
- Consumes: 无——`sunColorFor` 是纯函数（`clamp(el, 0, 90)` 后 `t = min(1, e/45)`，返回 `[1.0, 0.62+0.34t, 0.42+0.5t]`）
- Produces: `export function sunColorFor(elevationDeg: number): Vec3`（线性 RGB，行为与现实现逐位等价）

- [ ] **Step 1: 写失败测试** —— `src/sun-color.test.ts`（含从 `dome-cloud-light.test.ts` 迁来的两个 describe）

```ts
it('逐位等价：搬家后 el ∈ [-8, 65] 每 0.5° 与旧实现同值', () => {
  // 期望值由改动前从 dome-cloud-light 导出的实现生成，固化成本表（≥4 位小数）。
  // 实现把负仰角钳到 0：-8..0 段与 sunColorFor(0) 同值，表内相邻重复属预期。
  expect(sunColorFor(6.9684)).toEqual([/* 旧值 */]);
  expect(sunColorFor(-8)).toEqual([1.0, 0.62, 0.42]); // 钳制段 == sunColorFor(0)
  expect(sunColorFor(65)).toEqual([/* 旧值 */]);
});
```

- [ ] **Step 2: 跑红** `npx vitest run src/sun-color.test.ts` —— 期望 `Failed to resolve import './sun-color'`
- [ ] **Step 3: 实现** —— 函数体原样搬进 `src/sun-color.ts`，**四处** import 改指向（sky-track / main / sky-track.test / dome-cloud-light.test），`dome-cloud-light.ts` 删掉该函数
- [ ] **Step 4: 跑绿** + `npx tsc --noEmit` = 0 + `npx vitest run` 全绿
- [ ] **Step 5: Commit** `refactor(cloud): move sunColorFor out of the dome chain`

### Task 2: 背景层改名并自持高度常量（纯重构，输出不变）

**Files:**
- Rename: `src/dome-horizon.ts` → `src/bg-cloud.ts`（`git mv`），同步 `src/dome-horizon.test.ts` → `src/bg-cloud.test.ts`
- Modify: `src/bg-cloud.ts:33-34`（**两条** dome import 全拆：`:34` 的 `DOME_SLAB` 与 `:33` 的 `FALLBACK_BANDS/FALLBACK_HAZE`）、`:68-69`、头注释（deck/DOME_SLAB 参照系表述重写，设计先决条件③）
- Modify: `src/bg-cloud.test.ts:4,54-55`（`DOME_SLAB` import 与 y 带断言改用本地 `BG_Y_MIN/MAX`，值不变）
- Modify: `src/world.ts:233`（动态 import 改指向；全仓仅此一处消费方）

**Interfaces:**
- Produces: `export const BG_Y_MIN = 350;` / `export const BG_Y_MAX = 440;`（**本任务保持现世界值**，Task 3 才改）；`FALLBACK_BANDS/FALLBACK_HAZE` 常量本体自持进 `bg-cloud.ts`（Task 5 删 `dome-cloud.ts` 时不再牵连本层）

- [ ] **Step 1: 先 `git mv`** —— 重命名两个文件，`world.ts:233` 动态 import 与测试文件内部 import 改指向；dome 链未动，FALLBACK 暂留原 import（测试文件此时不存在撞名问题）
- [ ] **Step 2: 写失败测试** —— `src/bg-cloud.test.ts` 追加

```ts
it('背景层不再依赖 dome 链：模块内无 dome-cloud/DOME_SLAB 引用，高度常量自持', async () => {
  const src = await readFile('src/bg-cloud.ts', 'utf8');
  expect(src).not.toMatch(/dome-cloud|DOME_SLAB/); // 同时盖住两条 import 与头注释残留
  expect(BG_Y_MIN).toBe(350);
  expect(BG_Y_MAX).toBe(440);
});
```

- [ ] **Step 3: 跑红** `npx vitest run src/bg-cloud.test.ts` —— 期望 dome-cloud/DOME_SLAB 引用命中
- [ ] **Step 4: 实现** —— `PATCH_Y_MIN/MAX` 改为本地 `BG_Y_MIN/MAX`（值不变）；从 `dome-cloud.ts` 把 `FALLBACK_BANDS/FALLBACK_HAZE` 常量本体（连注释）抄进 `bg-cloud.ts` 自持；头注释按「背景层」新身份重写
- [ ] **Step 5: 跑绿** + tsc + 全量（`patchesFor` 输出须与改动前一致，既有 describe 全过）
- [ ] **Step 6: Commit** `refactor(cloud): rename dome-horizon to bg-cloud, own band constants and fallback palette`

### Task 3: 背景带铺开到 60–650 m，总数封顶 14

**Files:**
- Modify: `src/bg-cloud.ts`（`BG_Y_MIN/MAX`、每 bin 数带 `PATCH_COUNT_MIN/MAX`、总数封顶）
- Test: `src/bg-cloud.test.ts`（既有钉 5–9 / 350–440 的断言同步改钉）

**Interfaces:**
- Produces: `BG_Y_MIN = 60` / `BG_Y_MAX = 650`；每 bin 首窗 8–14；`PATCH_VISIBLE_MAX = 14`（合并封顶，`MAX_PATCHES` 几何预留同源）

- [ ] **Step 1: 写失败测试**

```ts
it('背景带铺满可见天区：y ∈ [60,650]，距离仍 1300–1700', () => {
  const specs = [7, 11, 23].flatMap((seed) => [-9, 0, 8].flatMap((bin) => patchesFor(seed, bin)));
  for (const p of specs) {
    expect(p.yMetres).toBeGreaterThanOrEqual(BG_Y_MIN);
    expect(p.yMetres).toBeLessThanOrEqual(BG_Y_MAX);
    expect(p.distanceMetres).toBeGreaterThanOrEqual(PATCH_DISTANCE_MIN);
    expect(p.distanceMetres).toBeLessThanOrEqual(PATCH_DISTANCE_MAX);
  }
  // 覆盖性由带边界保证（设计 §5-A；相机 66.8 m = START_Y 60 + camera-rig CAM_HEIGHT 6.8）：
  // atan((60−66.8)/1500)≈−0.26° 到 atan((650−66.8)/1300)≈24.2°，盖住 0°..21.6° 可见天区。
  // 不对抽样值断言仰角门——那是种子运气，不是实现性质。
});

it('稀疏：首窗扇区 8..14，跨 bin 合并封顶 14', () => {
  for (const seed of [7, 11, 23]) {
    for (const bin of [-9, 0, 8]) {
      expect(patchesFor(seed, bin).length).toBeGreaterThanOrEqual(8);
      expect(patchesFor(seed, bin).length).toBeLessThanOrEqual(14);
    }
    // 相邻 bin 扇区重叠：保留 + 补生可超封顶，按「离视轴远→近丢」截断（签名五参）
    const merged = mergeHeadingPatches(1, patchesFor(seed, 1), 0, seed, 0);
    expect(merged.length).toBeLessThanOrEqual(14);
  }
});
```

- [ ] **Step 2: 跑红** `npx vitest run src/bg-cloud.test.ts` —— 期望 y 带仍 350–440、首窗 5–9
- [ ] **Step 3: 实现** —— `yMetres` 在 `[BG_Y_MIN, BG_Y_MAX]` 内取自现有 `rand()` 序列（调用顺序不动）；每 bin 数带抬到 8–14；`PATCH_VISIBLE_MAX = 14` 接管「离视轴远→近丢」截断与 `MAX_PATCHES` 预留；合并后为 0 时走既有整扇区重铺兜底
- [ ] **Step 4: 跑绿** + tsc + 全量
- [ ] **Step 5: Commit** `feat(cloud): spread background patches across the visible sky band`

### Task 4: 开关改名 `?dome=0` → `?bg=0`

**Files:**
- Modify: `src/qa.ts:41`（`parseDomeVisible` → `parseBgVisible`，并新增 `resolveBgVisible`）、`src/main.ts:227`、`src/world.ts:283`（`setDomeVisible` → `setBgVisible`）
- Test: `src/qa.test.ts:95-110`、`src/world.test.ts:185-200`（`exposes the dome handles` 与级联 it 都被改名波及）

**Interfaces:**
- Produces: `parseBgVisible(raw: string | null | undefined): boolean`（`'0'` → false，其余 true）；`resolveBgVisible(bgRaw, domeRaw): boolean`（`bg` 有值用 `bg`，否则回落 `dome`——`?dome=` 兼容别名由此实现，`?bg=` 优先）
- 过渡约定：`world.setBgVisible` 本任务**保留对 dome 的级联**（`dome?.setVisible` 行不动）——dome 到 Task 5 才删，改名瞬间不能让 dome 本体失去开关，否则 A/B 门 1 断供

- [ ] **Step 1: 写失败测试** —— `parseBgVisible('0') === false`、`parseBgVisible(null) === true`、`resolveBgVisible('0', '1') === false`（bg 胜）、`resolveBgVisible(null, '0') === false`（回落）
- [ ] **Step 2: 跑红** → **Step 3: 实现**（旧名保留，main.ts 改调 `resolveBgVisible`）→ **Step 4: 跑绿** + tsc + 全量
- [ ] **Step 5: Commit** `feat(cloud): bg visibility lever (dome name kept as alias)`

### Task 5: 删除体积穹顶全链

**Files:**
- Delete: `src/dome-cloud.ts`、`dome-cloud-field.ts`、`dome-cloud-noise.ts`、`dome-cloud-light.ts` 及四个单测
- Modify: `src/world.ts`（`initDomeCloud` 挂载与句柄、`setBgVisible` 摘掉 dome 级联、`bootLabelFor` 抽出）
- Modify: `src/main.ts`（dome 装配段、`syncSun` 的 dome 扇出、`:558` 四层消费端注释、启动条改调 `bootLabelFor`）
- Modify: `src/sky-track.ts:606`（注释里的 dome-cloud/deck 字样——grep 门会扫到）
- Modify: `src/world.test.ts`（`exposes the dome handles` it 随 dome 句柄删除改写）

**Interfaces:**
- Produces: `export function bootLabelFor(mounted: { sky: boolean; sea: boolean; puffs: boolean }): string`（落 `world.ts`——main.ts 不可单测，world.ts 是既有单测挂点；`['sky', ...].join(' + ')`）

- [ ] **Step 1: 写失败测试** —— `src/bg-cloud.test.ts` 追加

```ts
it('dome 链已不存在，启动条不再有 dome 段', async () => {
  await expect(import('./dome-cloud')).rejects.toThrow();
  expect(bootLabelFor({ sky: true, sea: true, puffs: true })).toBe('sky + sea + puffs');
  expect(bootLabelFor({ sky: false, sea: true, puffs: false })).toBe('sky + sea');
});
```

- [ ] **Step 2: 跑红** → **Step 3: 实现** —— main.ts:258-262 的 `labelParts` 内联拼接抽成 `world.ts` 的 `bootLabelFor` 并让 main 改调；摘 `setBgVisible` 里的 `dome?.setVisible` 行；`grep -n "dome-cloud" src/` 与 `grep -n "world?.dome" src/main.ts` 均零命中 → **Step 4: tsc 0 + 全量绿**
- [ ] **Step 5: Commit** `feat(cloud): delete the volumetric dome chain`

### Task 6: 兜底壳层 5 → 3 片

**Files:** `src/puff-cloud.ts:365-376`、`src/in-cloud.test.ts`

**Interfaces:** `SHELL_COUNT = 3`；`makeShellMaterial(0.07 + (i % 3) * 0.025)`（0.07/0.095/0.12，落在设计 §5-B 的 0.07–0.12 带；现状 `0.1 + (i % 3) * 0.04` = 0.10–0.18）；`scale = 0.28 + rand() * 0.12`（0.28–0.40）

- [ ] **Step 1: 写失败测试** —— 断言壳层数 3、base alpha 落在 0.07–0.12、单瓣包围盒变小
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿** + tsc + 全量
- [ ] **Step 5: Commit** `feat(cloud): three finer interior shells instead of five large ones`

### Task 7: 近景淡出可调 + 专属闸门

**Files:** `src/puff-field.ts:54-56`、`src/puff-field.test.ts`、`src/in-cloud.test.ts`

**Interfaces:** `PUFF_FADE_NEAR` / `PUFF_NEAR_FLOOR` 保持导出；`fadeForDistance(5)` 目标 ≤ 0.40（现状 ≈0.58：`0.3 + 0.7·smoothstep((5−1.2)/8.8)`）

- [ ] **Step 1: 写失败测试** —— `fadeForDistance(5) <= 0.40` **且** `fadeForDistance(0.5) >= 0.2`（穿云可读性下限取模块注释钉死的 0.2——「低于 0.2 软墙就近乎消失」，puff-field.ts:46-53；要压 FLOOR 必须连注释一起改写，防「云里什么都没有」）
- [ ] **Step 2: 跑红** → **Step 3: 实现**（先动 `PUFF_FADE_NEAR`：FLOOR=0.3 不动时压到 0.40 需 NEAR ≥ ≈3.5，smoothstep 反解；`FLOOR` 只在不破 0.2 下限时动）→ **Step 4: 跑绿** + tsc + 全量
- [ ] **Step 5: Commit** `feat(cloud): soften the near-field puff fade with a readability floor`

### Task 8: 对齐研究四处定点修订（docs）

**Files:** `docs/superpowers/specs/2026-11-13-painted-valley-style-alignment.md`、`docs/superpowers/INDEX.md`

- [ ] **Step 1** §5.2 整节改为「已作废：dome 模块已删（见云层收敛设计）」
- [ ] **Step 2** §3 现状表删除 dome 行、puff 行补「兜底壳层 5→3」
- [ ] **Step 3** §6 分期表 P2 行改为指向本设计（P1 行指向云风格文档）；§5.4 改口两处——`:265` 表格行保留「1200–1800m 淡出带」（**距离带不变**，60–650 m 是高度带，别混写）、`:267`「应该扩成远景条带」按设计 §6.1 Q4 改为「单用途，远景条带另立模块、不在本设计范围」
- [ ] **Step 4** INDEX 四处：`planB`/`painted-valley` 行加指针；dome 设计两行（`:85-86`）与 dome 计划两行（`:105-106`）标注「已被云层收敛取代（模块删除），归档 HISTORY」（设计 §10）
- [ ] **Step 5: Commit** `docs(cloud): retire the dome section, repoint the alignment study`

### Task 9: 采集矩阵 + 验收 + INDEX 登记

**Files:** Create `artifacts/cloud-layers/capture.mjs` + `matrix/`；Modify `docs/superpowers/INDEX.md`

- [ ] **Step 1** 抓帧：默认 6.97° / 黄昏 / 夜 / `?tod=12`，每档配 `?puff=0`、`?bg=0`；另加 360° 扫一圈（每 45°）与 `?alt=` 高低两帧
- [ ] **Step 2** 目检：任意朝向 8–14 块、不连成片；穿云三件套（白包围 / 飞机可见 / 有厚度）；
      **`?tod=12` 硬边消失**（含只关 bg 的隔离帧）；**白纱进云是否出现硬切断层**（主人 2026-11-13 从
      「独立手飞」并入本步验收的项——若断层，放宽 `VEIL_INNER` 0.96→0.93 量级再验一次）
- [ ] **Step 3** 性能：同会话 p50/p95 对基线（20.8 / 27.9），判据按设计 G6：**high 档 p95 ≤ 27.9** 即过；超了先查背景层 draw call/overdraw（设计 §9 第二条）再议
- [ ] **Step 4** INDEX 登记本计划与设计文档状态
- [ ] **Step 5: Commit** `test(cloud): two-layer capture matrix and acceptance gate`

## Self-Review

- 设计 §5-A→Task 2/3/4、§5-B→Task 6/7、删除清单与先决条件→Task 1/5、§6 隔离验证→Task 9 Step 2、§10 文档关系→Task 8。无遗漏。
- Review Focus 五条各落 owning task（1→T3/T9、2→T1、3→T4、4→T5、5→T9）。
- 类型一致：`BG_Y_MIN/MAX`、`PATCH_VISIBLE_MAX`、`parseBgVisible`、`resolveBgVisible`、`setBgVisible`、`bootLabelFor` 全篇同名。
- 比例：任务步骤以「测试就红、实现就绿、提交」为主，未转写实现体。
- 2026-11-13 审核修正回填：T1 补第四处 import（dome-cloud-light.test.ts，describe 迁移 + 钳制段说明）；T2 拆 FALLBACK 两条 import + 先 mv 后测的步序 + 测试文件 DOME_SLAB 改钉；T3 测试签名/语义纠正（五参 merge、bin 合法域 −9..8）+ 判据改带边界确定性断言（不赌种子）；T4 新增 `resolveBgVisible` + world.test 波及面扩到 :185 + dome 级联过渡约定；T5 `bootLabelFor` 抽出（断言方向反转修正）+ main/sky-track 残留字样 grep 门；T6 alpha 公式改 `*0.025`（守住 0.07–0.12 带）；T7 下限统一 0.2 + NEAR 反解提示（≈3.5）；T8 §5.4 数量纲改口 + Q4 冲突句 + INDEX dome 四行归档；T9 p95 判据补写。
