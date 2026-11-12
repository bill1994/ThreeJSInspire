# 三渲二 Look 开关期 1（uToon 总闸 + 天海档位化 + dome 量化 + 调色层）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> 状态：**已出计划待执行（2026-11-12）**。开工前置：主人评审本计划头部「定案记录」段（D1 载体修订 + 基准色初值）。

**Goal:** 落地 [`specs/2026-11-12-toon-look-toggle-design.md`](../specs/2026-11-12-toon-look-toggle-design.md) 期 1：`uToon` 0–1 总闸切海+天+云整体三渲二观感（T1/T2/T3/T4/T6/T7）；默认 `uToon=0` 逐位不变。

**Architecture:** 档位化只落在 `skyColorTsl` **出口**（海反射 `sea/material.ts:366` 吃同一出口自动一致——海天铁律）+ `skyColorJs` **同 commit 同步**（双镜像，源码 pin 守卫）；dome 光照量化只动颜色输出行（uLook 先例纪律）；调色层走 `applyToonLook` state→state 纯函数插在 syncSun 扇出链（见定案 D1，非 setTrackPatch 快照）；bloom 预算表先行加 toon 行（量具先行）。

**Tech Stack:** TypeScript 5.5 · three 0.186.0（WebGPU/TSL）· Vitest 2.1 · Vite 6 · Python/mjs 采集量具

**Spec:** [`specs/2026-11-12-toon-look-toggle-design.md`](../specs/2026-11-12-toon-look-toggle-design.md)（T1–T7 全文）＋ 审核报告（2026-11-12 chat）：13 项架构事实已核验，A1/A2/A3 三发现已吸收为下方定案。

## 定案记录（DOME-02 三要素格式：改哪条 / 谁批 / 何时）

- **N = 6 档**：设计稿 §9 my call；主人 2026-11-12 chat 无异议生效（§9 原文「不同意现在说，否则按 6 走」）。标定后可搬，搬须走抓帧标定流程并同步更新钉值测试。
- **D1 调色层载体修订（T4）**：从「`setTrackPatch` 快照」改为 **`applyToonLook(state, amount): SkyTrackState` 纯函数**，插在 syncSun 扇出链 `skyTrackAt(el)` → **applyToonLook** → `applyTrackPatch(·, trackPatch)`（toon 底层、用户 patch 顶层——与设计稿 T4 合成顺序 my call 一致）。**理由（审核发现 A1）**：`setTrackPatch` 整字段替换（sky-track.ts:79-86 WHOLESALE 语义）会把 cloudBands 短路成全仰角恒定色——轨道联动死、与昼夜 planB 时间轴直接冲突；state 变换保留每档联动且零新增推送管线。改哪条 = 设计稿 T4 载体；谁批 = 主人评审本计划；何时 = 2026-11-12。
- **D2 海霾端点快照缓做（T5 之一）**：`seaHazeEndpoints`（sky-color-js.ts:100-113）内部调 `skyColorJs`——T2 出口量化后端点自动 toon 化；「海霾端点 toon 硬化快照」移入期 2 开工前复评项（端点观感不足再补），期 1 不做。依据审核发现 A2。
- **D3 组合正交事实（T3×uLook）**：`uLook=1`（flat）时 dome 颜色输出完全取 flatCol（dome-cloud.ts:392 mix）——T3 光照量化在 flat 下逐位无影响；T4 调色作用于 cloudBands 数据层，两种 look 下都生效。断言拆两条独立 pin（见 Task 3），「flat×量化」行为级组合免测。

## Global Constraints

- **默认逐位不变**（设计稿反目标 #1）：`uToon=0` 全链路无操作；Task 2 起每任务收尾跑 Task 0 基准帧 A/B 字节级回归。
- **海天铁律**：档位化只落 `skyColorTsl` 出口；禁止单独动海（`sea/material.ts:16` 「sea and sky cannot disagree」）。
- **双镜像纪律**：`skyColorTsl`/`skyColorJs` 的 toon 数学同 commit 同步；源码 pin 测试是守卫（红 = 忘改一侧）。
- **toon 不 reshape**：alpha/密度/步数/几何一行不碰（dome-cloud.ts:379 uLook 纪律原文精神）；设计稿反目标 #3。
- **调色单源**：一切颜色流经 `SkyTrackState` 或其纯函数派生；禁第二调色源（反目标 #4）。
- **参考档恒等**：既有测试一行不碰（门 4）；`applyToonLook` 不碰 preetham/灯光/bloomThreshold 字段。
- three 0.186.0，WebGPU-only；每任务 fail-first（先红后绿）；`npx tsc --noEmit` = 0 + `npx vitest run` 全绿才 commit。提交 scope：`feat(toon):` / `test(toon):`。
- 浏览器协议：`?qa=frozen` + `qa.step(n)`；dev server `http://[::1]:5173`（vite IPv6-only，Chrome localhost 竞速失败——porco 配方已知坑）；竖屏 434×772。
- TSL 懒编译坑：Fn 体结构断言走源码 pin（`import.meta.glob('./x.ts', { query: '?raw' })` + `toMatch`），不信运行时反射。
- `artifacts/` 只放证据和仪器；证据帧随代码 commit。
- bloom 预算 0.82：post.ts:45-69 预算块 + sky-color-js.test.ts:130 describe 是守卫；toon 行全档 <0.82，**不许**为过门改阈值或动参考档。

## Review Focus

1. **uToon 中间值（0<x<1）**：出口量化与调色层均为 `mix(c, c', amount)` 过渡——过渡帧不得出现半档色阶结构或 NaN，且 amount=0.5 时天区仍可量到 ≥2 档（不是糊回连续渐变）。→ Task 2 的 amount=0.5 性质测试 + Task 6 过渡帧采集。
2. **夜档（−8°）toon**：夜档非盘峰值本就 0.034 量级（post.ts:55 预算表首行）——量化不得把夜空压成死黑、夜云 toon 色不得顶预算。→ Task 5 toon 预算行含 −8 档 + Task 6 夜机位采集对。
3. **海天接缝翻转**：天穹 `includeDisc=true`、海反射 `includeDisc=false` 共用出口——量化后地平线行若「海亮过天」即撕裂。→ Task 6 门 2 按地平线行分带检查。**量具纪律用 `artifacts/dome-audit/analyze_horizon_isolation.py` 的隔离口径**（HUD 隐藏 + 显式 render flush + 隔离带 + 控制帧）——旧 `analyze_horizon.py` 已在 DOME-01 调查中被证伪（rect 偏 69px、探针带掺 HUD、地平线锁错 100px 等七处缺陷，见 repair-phase1 Task 4 Step 9），勿再引用。
4. **flat 组合漏测**：flat×toon 的正确语义是「量化无效、调色生效」，两条断言混写会漏。→ Task 3 的 pin-B/pin-C 拆分。
5. **复现链断裂**：`exportColorState` 漏 toon 态 → `?qa=frozen` 复现拍不出 toon 帧、QA 白跑。→ Task 4 repro 单测 + Task 6 门 6 双通道重放。

---

### Task 0: 基准帧抓取（量具先行，门 1 的基准）

**Files:**
- Create: `artifacts/toon-audit/capture-baseline.mjs`（仿 `artifacts/dome-audit/capture_*.mjs` 结构）
- Create: `artifacts/toon-audit/baseline/`（PNG + sidecar json：URL + `describe()` 快照）

**Interfaces:**
- Produces: 三机位基准帧（参考档平视 / 海平线低角 / 夜档 `?sun=0,-8` 或对应参数），供 Task 2/3/4/6 的 `?toon=0` 字节级回归比对。

- [ ] **Step 1: 写采集脚本**——三机位各抓一帧：`?qa=frozen` 冻结、`qa.step` 推进后截 PNG，sidecar 记复现 URL
- [ ] **Step 2: 跑采集入库**
- [ ] **Step 3: 采集稳定性自检**——同 URL 二次抓帧与首次字节级一致（调色面板计划验收①协议）；不一致先修采集再继续
- [ ] **Step 4: Commit** `test(toon): baseline frames for uToon=0 identity gate`

### Task 1: uToon 总闸 + 入口三件套

**Files:**
- Modify: `src/sky-webgpu.ts:91-131`（共享 uniform 组加 `uToon` float——:76 注释确认该组被 dome 与每条海环共享，一处注入三处可读）
- Modify: `src/qa.ts`（`parseToon`，仿 `parseCloudLook`:169 字面量纪律）
- Modify: `src/main.ts`（URL 解析接线 + qa 运行时对象挂 `setToon`，沿 `parseCloudLook` 同一路径）
- Modify: `src/debug/color-panel.ts`（新「风格」组 + 0–1 滑杆，`addSlider`:112 模式）
- Test: `src/qa.test.ts`

**Interfaces:**
- Produces: `parseToon(raw: string | null | undefined): number`；qa 运行时 `setToon(x: number): void`（clamp 0..1 后经 sky-webgpu 导出的 uniform setter 推 `uToon`——沿 `setSunDirection` 同款导出模式，不走 applySkyTrack，因 uToon 不是 SkyTrackState 字段）；uniform 组字段 `uToon`（默认 0）。本任务**不接任何下游消费**。

- [ ] **Step 1: 写失败测试**（qa.test.ts 新 describe）

```ts
describe('parseToon', () => {
  it.each([
    ['0', 0], ['1', 1], ['0.35', 0.35], ['0.5', 0.5],
  ])('?toon=%s → %s', (raw, v) => expect(parseToon(raw)).toBe(v));
  it('defaults and rejects', () => {
    expect(parseToon(null)).toBe(0);
    expect(parseToon(undefined)).toBe(0);
    expect(parseToon('')).toBe(0);
    expect(parseToon('abc')).toBe(0);
    expect(parseToon('1.5')).toBe(1);   // clamp 上界
    expect(parseToon('-0.2')).toBe(0);  // clamp 下界
  });
});
```

- [ ] **Step 2: 跑红** `npx vitest run src/qa.test.ts` → FAIL（parseToon not exported）
- [ ] **Step 3: 实现** parseToon + main.ts 接线 + 面板「风格」组滑杆（滑动只改 uniform 值，本任务无画面效果）
- [ ] **Step 4: 跑绿** + `npx tsc --noEmit` = 0 + 全量 `npx vitest run`
- [ ] **Step 5: Commit** `feat(toon): uToon master switch plumbing (?toon=, qa.setToon, panel slider)`

### Task 2: 天+海出口档位化（双镜像核心，T2）

fail-first 顺序：**JS 侧先行 → 镜像 pin 红（TSL 未补）→ TSL 补齐 → 绿**。

**Files:**
- Create: `src/toon-look.ts`（常量 + JS 纯函数：`TOON_STEPS`、hue-shift 曲线参数、`toonQuantizeJs`）
- Modify: `src/sky-color-js.ts`（`skyColorJs` 加尾参 `toonAmount = 0`，默认恒等；出口接 `toonQuantizeJs`）
- Modify: `src/sky-webgpu.ts:213-260`（`skyColorTsl` 出口同一阶梯 TSL 图，消费共享 `uToon`）
- Create: `artifacts/toon-audit/calibrate-steps.mjs`（参考档天穹亮度剖面采集 → `steps.json`）
- Test: `src/sky-color-js.test.ts` + 源码 pin

**Interfaces:**
- Produces: `TOON_STEPS: readonly number[]`（6 档亮度锚，标定产物）；`toonQuantizeJs(c: Vec3, amount: number): Vec3`；`skyColorJs(dir, sun, state, refSun, refP, includeDisc, toonAmount = 0)`
- 两侧同式（TSL 手写同式，常量同源 import）：`t = luminance(c)` → 档位索引（TOON_STEPS 邻域）→ 档位代表色（锚亮度 + hue-shift：暗档向紫、亮档向暖）→ `out = mix(c, c'', amount)`。数学式明细是标定产物，落 `toon-look.ts` 文件头注释。

- [ ] **Step 1: 写失败测试**（sky-color-js.test.ts 新 describe）

```ts
describe('toonQuantizeJs (outlet posterize, N=6)', () => {
  it('amount=0 is identity', () => {
    const c: Vec3 = [0.3, 0.2, 0.1];
    expect(toonQuantizeJs(c, 0)).toEqual(c);
  });
  it('amount=1 output stays within the 6-step anchor set (monotone in luminance)', () => {
    // 对亮度单调递增的输入序列，输出亮度序列不减、且全部落在锚点亮度上
  });
  it('amount=0.5 is strictly between identity and full quantize', () => { /* 逐分量 */ });
  it('NaN input → darkest anchor, never NaN out', () => { /* NaN 归 0 档 */ });
  it('mirror pin: skyColorTsl carries the same step expression (dual mirror)', () => {
    // import.meta.glob raw: sky-webgpu.ts 必含 toon-look.ts 同式特征串 —— TSL 未补时此 pin 红
  });
});
```

- [ ] **Step 2: 跑红** —— 行为测试红（toon-look.ts 不存在）+ 镜像 pin 红
- [ ] **Step 3: 标定**——跑 `calibrate-steps.mjs` 采参考档天穹亮度剖面 → 据表定 `TOON_STEPS` 6 锚（初值 my call：[0.02, 0.08, 0.18, 0.32, 0.52, 0.75] 等感觉分档起，据 steps.json 搬）+ 实现 `toon-look.ts` + `skyColorJs` 尾参
- [ ] **Step 4: TSL 补同一阶梯** → 镜像 pin 转绿
- [ ] **Step 5: 跑绿**——既有预算 describe / 参考档恒等测试零改动仍绿（门 4 证据）+ tsc
- [ ] **Step 6: 浏览器门**——`?toon=1` 抓帧天区档位结构可量（band_count ≥ 3）；`?toon=0` vs Task 0 基准**字节级一致**
- [ ] **Step 7: Commit** `feat(toon): posterize sky/sea at outlet (dual mirror, N=6)`

### Task 3: dome 光照量化（T3）

**Files:**
- Modify: `src/dome-cloud.ts`（光照项/透射率阶梯化；`uToon` 从共享 uniform 组读；档间抖动复用既有 `interleavedGradientNoise`:332）
- Test: `src/dome-cloud.test.ts`（新 describe，沿 `:109` uLook describe 的源码 pin 先例）

**Interfaces:**
- Consumes: 共享 `uToon`（Task 1）；IGN（既有）
- Produces: 两条 pin 特征串——「toon 表达式只出现在颜色输出路径且位于 uLook mix 行**之前**」「alpha 累积/密度行不含 toon」

- [ ] **Step 1: 写失败测试**（三条独立 pin，对应 Review Focus 4）

```ts
describe('toon quantized lighting (stepped transmittance)', () => {
  it('pin-A: toon branch touches only color output lines, before the uLook mix', () => {
    // raw 源码：toon 阶梯表达式的行号 < mix(ambient.add(lit), flatCol, uLook) 行号
  });
  it('pin-B: alpha accumulation and density lines contain no toon (cannot reshape)', () => {
    // alpha/密度行文本 toMatch 反向断言
  });
  it('pin-C: stepped transmittance + IGN jitter structure present', () => {
    // 特征串：step 阶梯 + interleavedGradientNoise 复用点
  });
});
```

- [ ] **Step 2: 跑红** `npx vitest run src/dome-cloud.test.ts`
- [ ] **Step 3: 实现**（只动颜色行；flat 下经 uLook mix 自动无影响 = D3，无需额外代码）
- [ ] **Step 4: 跑绿** + tsc + 全量
- [ ] **Step 5: 浏览器门**——`?toon=1` 云区档位结构可见；多帧目检档间无静态带纹（IGN 抖动生效）；`?toon=0` 字节级回归
- [ ] **Step 6: Commit** `feat(toon): quantized dome lighting (stepped transmittance, IGN dither)`

### Task 4: applyToonLook 调色硬化层（T4，D1 载体）

**Files:**
- Modify: `src/sky-track.ts`（`TOON_BANDS_REF` 等 toon 基准常量 + `applyToonLook(state, amount)` + `deriveToonBands` 派生纯函数）
- Modify: `src/main.ts:327`（syncSun 插入：`applyTrackPatch(applyToonLook(skyTrackAt(el), toonAmount), trackPatch)`；toonAmount 由 setToon 维持）
- Modify: `src/qa.ts:133-156`（`exportColorState` repro 追加 toon 段——amount≠0 时 URL 加 `&toon=`、控制台加 `qa.setToon(...)`，照 haze null 省略先例）
- Test: `src/sky-track.test.ts` + `src/qa.test.ts`

**Interfaces:**
- Produces: `applyToonLook(state: SkyTrackState, amount: number): SkyTrackState`——amount=0 返回深拷贝恒等；**只动 `cloudBands`/`cloudHaze`**（端点自动 toon 化归 D2；不碰 preetham/灯光/bloomThreshold = 参考档恒等的前提）；`deriveToonBands(bands, amount): [Vec3, Vec3, Vec3, Vec3]`
- **影响面（DOME-01 后实测，复核注记 2026-11-12）**：`cloudBands` 的消费方是**四层**——puff（world.setCloudPalette, main.ts:358）、dome-cloud（:65/:377 四档硬切）、dome-horizon 的 **deck 层**与 **patch 剪影环**（dome-horizon.ts:445-449 band mix；:78 注释「deck 用的是同一组色带，改它等于全场景改色」）。T4 生效时 deck/patch 环跟着档位化是**预期行为**（云家族共享单源，整体 look 语义），A/B 对比时**勿判为回归**；Task 6 地平线机位顺带覆盖这两层。
- 人工基准初值（my call，Task 6 抓帧复评后钉死）：参考档 `PUFF_BAND_COLORS` `['#5f5a84','#6f62a0','#9c688e','#a08088']` → toon 建议 `['#4a3d78','#6355a0','#b06a80','#d09a70']`（暗两档 hue 向 ~270° 收敛 + 饱和抬、亮两档向暖橙移 + 档间亮度差拉开——hue-shifted ramp 标准手法）；`cloudHaze`/`veilCool`/`veilWarm` 同法微移，初值在实现时按同规则给出。

- [ ] **Step 1: 写失败测试**（sky-track.test.ts 新 describe）

```ts
describe('applyToonLook (palette hardening, track-aware)', () => {
  it('amount=0 returns a deep-copy identity', () => { /* 逐字段 deepEqual + 引用不等 */ });
  it('reference-key bands map to TOON_BANDS_REF exactly (human-picked anchor)', () => { /* toEqual */ });
  it('non-reference keys derive via hue-shift: dark keys shift toward purple, lit keys toward warm', () => {
    // hue 方向断言：暗档 hue 差为正（向紫）、亮档为负（向暖）
  });
  it('touches only cloudBands/cloudHaze — preetham/lights/bloomThreshold fields reference-identical', () => { /*toBe*/ });
});
```

qa.test.ts 追加：`exportColorState` repro 在 toonAmount≠0 时两行命令均含 toon 段、amount=0 时省略（照 haze 先例）。

- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现** applyToonLook + deriveToonBands + syncSun 插入 + repro
- [ ] **Step 4: 跑绿** + tsc
- [ ] **Step 5: A/B 回归**——`?toon=0` 字节级 = Task 0 基准（syncSun 动过的直接证据）
- [ ] **Step 6: Commit** `feat(toon): hue-shifted palette layer via applyToonLook (track-aware, repro intact)`

### Task 5: bloom 预算 toon 行 + banding 口径留痕（T7 + T6）

**Files:**
- Modify: `src/sky-color-js.test.ts:130` describe（追加 toon 模式 it）
- Modify: `src/post.ts:45-69`（预算注释块追加 toon 行说明）
- Create: `artifacts/toon-audit/README.md`（banding_flips toon 口径留痕）

- [ ] **Step 1: 写失败测试**

```ts
it('toon mode (toonAmount=1) non-disc peak < bloomThreshold at EVERY budget key', () => {
  // 沿既有 BUDGET_KEYS 网格全档扫，amount=1；红 = toon 曲线顶爆预算，回 Task 2 压档内曲线
});
```

- [ ] **Step 2: 跑红→修→绿**——若红：压 `TOON_STEPS` 档内亮度（**不许**改 0.82、**不许**动参考档列）再绿
- [ ] **Step 3: 留痕**——README 写明三要素：改哪条 = banding_flips 在 toon 采集不作验收门（toon 模式色带是特性），改用 band_count + 目检；谁批 = 设计稿 T6 已批（主人 2026-11-12 定稿）；何时 = 2026-11-12。post.ts 注释块同步补 toon 行数值
- [ ] **Step 4: Commit** `test(toon): bloom budget row for toon mode + banding reinterpretation ledger`

### Task 6: 采集验收矩阵 + 六门收口

**Files:**
- Create: `artifacts/toon-audit/capture-toon-matrix.mjs`
- Create: `artifacts/toon-audit/matrix/`（采集对 + 过渡帧 + sidecar）
- Modify: `docs/superpowers/INDEX.md`（§1 设计稿行 →「执行中/已落地」；§2 登记本计划行）

- [ ] **Step 1: 采集矩阵**——`?toon=0/1` × 三机位（参考档 / 海平线 / 夜档）采集对 + `?toon=0.5` 过渡帧，全部入库
- [ ] **Step 2: 门 1**——`?toon=0` 基准字节级（复跑 Task 0 协议）
- [ ] **Step 3: 门 2**——band_count 三区量测（天/海/云各 ≥3 档）+ 地平线行「海亮过天」翻转检查（Review Focus 3）
- [ ] **Step 4: 门 3/4/5**——镜像 pin 绿；`git diff --stat` 确认参考档恒等测试文件零改动 + 全量 vitest 绿；预算 toon 行绿
- [ ] **Step 5: 门 6**——`exportColorState` 的 URL 与 console 双通道各重放一帧，字节级与原帧一致
- [ ] **Step 6: INDEX 登记 + Commit** `test(toon): acceptance matrix, six gates closed`

---

## Self-Review（写计划时已跑）

- **Spec coverage**：T1→Task 1、T2→Task 2、T3→Task 3、T4→Task 4（D1 载体）、T6→Task 5 Step 3 + Task 6 门 2、T7→Task 5；门 1–6 →Task 0/2/5/6 逐条有主。期 2 项（T5 太阳路/浪花/端点复评）不在本计划，与设计稿分期一致。
- **Step scan**：每步一个动作；标定/基准色等主观产物均写明「初值 my call + 抓帧复评后钉」，不留 TBD。
- **Type consistency**：`parseToon`/`setToon`/`uToon`/`TOON_STEPS`/`toonQuantizeJs`/`applyToonLook`/`deriveToonBands` 各任务引用同名同签名。
- **Review Focus**：五条各落到 owning task 的测试（见各行 → 指向）。
- **Proportion**：本计划 ≈ 设计稿 3 倍长度，密度对齐 repair-phase1 先例；无代码转写（测试块只写断言意图与关键 pin）。
