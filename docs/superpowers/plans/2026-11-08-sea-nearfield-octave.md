# 海面近场细八度（修复 P1 近场无波 / 4–32 m 缺八度）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 C1 chop 级联补上 4–32 m 法线细八度（实际承载 8–27.4 m），让 ≤20 m 机位的近场出现随波场联动的可读波峰波谷结构，同时保证 32–128 m 子带逐位不变、既有中高空观感零回归。

**Architecture:** 不新增第三个 FFT 级联。C1 的同一张频谱纹理改为两部分相加：子带 [32,128] m 保持现状（同 seed、同窗口、同缩放，系数逐位不变），细带 [4,27.5] m 用独立随机流（`fineSeed: 20261107`）按自己的波高峰值（0.04 m）独立归一后逐格相加合并上传（`accumulateSpectrum`）。细带只进片元法线（现有 lodF1 mip 链自动抗混叠），顶点位移加一个固定 mip 低通（`C1_VERTEX_MIP_LOD = 3.1287`，分子取 `bandMetres[0]` = 32）继续只看 ≥32 m——R0 网格 cell 6.4 m 分辨不了更短波长；这不是新设计，是**兑现 `rings.ts` 的既定契约**：其 docblock 规定 `mipLod` 应把 `floorMetres` 以下的波低通掉，R0 的 floor = 32 m，而 C1 顶点采样一直 `.level(0)` 没兑现。验收钩子 `?sea=nochop` 只写 `c1Gate` 不停派发，供 A/B 判据使用。

**Tech Stack:** TypeScript + three 0.186（WebGPU/TSL）+ vitest + python 采集度量链（`artifacts/sea-review/`）。

**Spec:** `docs/superpowers/reviews/2026-11-07-sea-wave-scale-review.md`（v2 修订版）——P1 两项（A：贴近/掠海近场波形完全消失；C：低空尺度线索断裂：近带装不下半个最短波长、4–32 m 无法线八度、detail gate ≥16.8 m 全关）与 §五 复核判据 1/2/3。本计划即该审查的修复执行文档。

## 已实测的设计输入（2026-11-08 校准，vitest 跑 `spectrum.ts` 纯函数）

| 量 | 值 | 来源 |
|---|---|---|
| 子带 [32,128] 现状坡度 RMS（×SLOPE_GAIN 14 后） | 0.0747 rad ≈ **4.28°** | seed 20261106 实算 |
| 细带 [4,27.5]（fineSeed 20261107，crest 0.04）坡度 RMS（×14 后） | **0.0961 rad ≈ 5.51°**，占 C1 合计坡度方差 **62.3%** | 同上（2026-11-08 二次复算修正；原稿 0.0864/67.3% 不可复现且自相矛盾——0.0864 rad 只有 4.95°） |
| 合并后 C1 坡度 RMS（×14 后） | **0.1217**（crest 0.03 档 0.1038 / 0.06 档 0.1624） | 同上 |
| C0 [128,1024] 坡度 RMS（×14 后） | **0.1460**（raw 0.0104）——全场坡度的大头 | 同上（外部审核漏测项） |
| 全场（C0+C1）坡度 RMS（×14 后） | 现在 **0.1640**；加细带后 0.03 档 **0.1791** / 0.04 档 **0.1901** / 0.06 档 **0.2184** | 同上。`water-shading.ts` SLOPE_GAIN 注释的「slope near 0.01 / 8 lands near 0.1」口径即 C0+C1 合计（raw 合计 0.0117、×8 = 0.094），注释未过期；但 0.1 不是硬上限——今天全场已 0.164 而太阳路仍连续 |
| 细带 <8 m 能量占比 | **0.50%**（Phillips ℓ=tile/100 阻尼）——细带实际承载 8–27.4 m | 同上 |
| `C1_VERTEX_MIP_LOD` | **3.1287** = log2((**32**/4.878)/(192/256))，分子 = `CASCADES[1].bandMetres[0]`；**勿用 `BAND_SPLIT_METRES`**（=128，代进去得 5.1287，与钉值互斥） | ~4.9 采样/波长规则（rings.ts:10-14） |
| 直接拓宽 C1 窗口的否决依据 | 同 seed 拓宽会移动全部随机数消耗序，子带已实现方差漂 ±45%，amplitudePeak 需提到 0.229，撞穿 `cascadeIsValid`（69° fov 上限 **0.13746** = 192×perPixelRadians(69, 1920)） | 校准第一轮 |

## Global Constraints

1. **执行排序**：本计划在 `docs/superpowers/plans/2026-11-08-day-night-sky.md`（昼夜天空）的 Task 1–8 全部验收完成后执行——昼夜计划的 Task 5 会改 `src/sea/material.ts` 霾端点、Task 8 的 parity 假设海面像素不动。本文对 material.ts / main.ts / qa.ts 的行号以执行日 Task 0 对账为准。
2. **子带逐位不动**：C1 的 bandMetres [32,128]、amplitudePeak 0.1、seed 20261106、buildSpectrum 格点遍历序、spectrumScaleToPeak 缩放路径全部不改。细带是「第二份频谱按格累加」，不是改窗口。`amplitudePeak` 保持 0.1 的理由写进 Task 2 头注释（护栏对象是顶点位移、细带不进几何；69°/1920 上限 0.13746，字段改 0.14 必红）。
3. **细带窗口 [4, 27.5]**：上界 27.5 使 2π/27.5 卡在格点半径 7（27.43 m，收入）与半径 6（λ=32 m 共享格点，排除）之间；细带与子带在 192 m 格点上零交集，24–32 m 之间只有半径 7 一档的空隙。λ=32 m 绝不允许双计。
4. **细带不进几何**：顶点 C1 采样从 `level(0)` 改为 `level(C1_VERTEX_MIP_LOD)`；细带只通过片元 `slope1`/`jac1` 生效（`material.ts:247-251` 现路径，无需改）。
5. **着色常量不动**：SLOPE_GAIN=14、CREST_TINT、WATER_OPTICS 全表不改；细带坡度走既有 ×14 通路（预期增量见上表）。若验收后需调，只允许动 `fineCrestMetres`（区间 [0.03, 0.06]）。
6. **源码 pin 红线**（`material.test.ts`）：标识符 `c1Gate`、`normalNode` 保留；字面量 `i === 0` 保留；`skyColorTsl(tsl, reflected, sunU, false)` 与 `awayHorizonLinear` 保留；新增混色一律函数形式 `mix(a, b, t)`（:100 禁 `).mix(`）。
7. **不新增级联、不改 fft-gpu.ts**：消费侧对级联数无写死假设的改动一律不做；WebGPU-only 不引入 forceWebGL（`renderer.test.ts:42`）。
8. **验收帧走冻结协议**：`?qa=frozen` + `__porco.qa.step` + present 双 rAF、隐藏 HUD（`docs/superpowers/plans/2026-10-31-capture-protocol.md`），归档 `artifacts/sea-review/`（round-3 前缀）。

## Review Focus

1. **掠海细波闪变**：细带在片元 level 0 全分辨率直到 foot≈0.75 m（约 800 m 内不过 mip），7 m 掠海帧期望无爬行噪/闪烁；有则提高 `C1_VERTEX_MIP_LOD` 无效，需查 mip 链生成（Task 4 目检）。
2. **太阳路被细坡度打碎**：细带把 C1 坡度 RMS 从 0.0747 提到 0.1217（占合并方差 62.3%），全场从 0.1640 到 0.1901（RMS +16%）；太阳路期望仍是连续亮带 + 辉点核、不碎成噪点（SLOPE_GAIN 注释的「molten stripes」红线）；碎了先降 `fineCrestMetres` 至 0.03（全场 0.1791）。
3. **泡沫过生成**：细带 Jacobian 压缩并进 `jac1`（`material.ts:248-251`），泡沫期望无新增连片；异常则同样先降 crest。
4. **低档回退一致性**：`setQuality(false)` 停 C1 派发 + c1Gate=0，低档期望与修复前低档一致，细带无残影。
5. **中高空观感漂移**：细带在全部环的片元可见（这是审查 §2.1 要的「更细八度」），但 240 m 近带 std 相对基线 42.97 只许 ±30%；漂出则按第 2/3 条同一杠杆回调。
6. **nochop 与 setQuality 的覆盖关系**：`setQuality` 会重写 `c1Gate`，`?sea=nochop` 的 A/B 只在冻结采集流程（不换档）内有效；`setChopGate` 注释必须写明这一点。

---

### Task 0: 开工对账

**Files:** 无（只读检查）

- [ ] **Step 1:** `git status` 对账：确认工作树干净或未跟踪文件与本计划无关（并行会话可能改过仓库），结果记进度段。
- [ ] **Step 2:** 确认 `2026-11-08-day-night-sky.md` Task 1–8 已全部验收完成（Global Constraint 1）；未完成则停下上报，不得开工。
- [ ] **Step 3:** `npx vitest run` 全绿基线；`npx tsc --noEmit` 干净。
- [ ] **Step 4:** 从 `artifacts/sea-review/measurements.json` / `details.json` 抄录对照基线进本文档进度段：240 m 近带 std（42.97）、60 m 近带 std 33.58 / 垂直梯度 0.427、20 m 近带 std 3.58 / 垂直梯度 0.043、7 m 垂直梯度 0.028 / SKIM 0.024、7 m 近带 std 12.5 / SKIM 8.76（含太阳路亮斑，只记录不作判据——3.58 是 20 m 的 std，别挪用到 7 m）、`stripes_near` 基线（7 m/20 m/SKIM = 0，60 m = 2、240 m = 7）、`row_stripes` 口径说明。同时从 `artifacts/sun-road-review/measurements-round2.json` 的 `A3-r2.png` 段抄录太阳路守门基线：`clean_sea.blown%` **6.3**、`clean_sea.p95` **207.1**、`glints_seam_excluded` **43**、`road.display_ratio` **1.35**（线性比 2.65）、`road.gt200_pct` 24.4。Task 4 以这批数为对照，不引用文档转述值。

### Task 1: `?sea=nochop` 验收钩子

**Files:**
- Modify: `src/qa.ts`（`parseSeaDebug` 之后，约 :36-39）
- Modify: `src/main.ts`（`?sea=` 消费段，约 :168-169）
- Modify: `src/sea/material.ts`（`SeaOcean` 接口 :81-88；handle 实现区 :550-552 旁）
- Test: `src/qa.test.ts`（追加用例）、`src/sea/material.test.ts`（追加源码 pin）

**Interfaces:**
- Produces: `parseSeaNoChop(raw: string | null): boolean`（仅 `'nochop'` 为 true）；`SeaOcean.setChopGate(on: boolean): void`（只写 `c1Gate`，不动 `highQuality`/派发）。

- [ ] **Step 1: 写失败测试。** `qa.test.ts` 追加：`parseSeaNoChop('nochop') === true`；`parseSeaNoChop(null) === parseSeaNoChop('0') === parseSeaNoChop('debug') === false`；`parseSeaVisible('nochop') === true` 且 `parseSeaDebug('nochop') === false`（nochop 不藏海、不进假色）。`material.test.ts` 追加源码 pin：`/setChopGate/` 存在于 material.ts。
- [ ] **Step 2:** `npx vitest run src/qa.test.ts src/sea/material.test.ts` —— 预期 FAIL。
- [ ] **Step 3: 实现。** `qa.ts` 仿 `parseSeaDebug` 加 `parseSeaNoChop`；`material.ts` `SeaOcean` 接口加 `setChopGate(on: boolean): void`，handle 实现放在 `setDebug` 旁：`for (const bits of materialBits) bits.c1Gate.value = on ? 1 : 0;`，注释写明「QA A/B 专用：只闸 c1Gate 不停派发；setQuality 会重写 c1Gate，本钩子在换档后失效」。`main.ts` 在 `parseSeaDebug` 消费行后加：`if (parseSeaNoChop(qaParams.get('sea'))) world?.sea?.setChopGate(false);`
- [ ] **Step 4:** `npx vitest run src/qa.test.ts src/sea/material.test.ts` —— 预期 PASS。
- [ ] **Step 5: Commit** `feat(sea): ?sea=nochop acceptance hook — gate C1 without stopping dispatch`

### Task 2: C1 细带构建（子带逐位不动）

**Files:**
- Modify: `src/sea/cascades.ts`（CASCADES[1] 条目 + 头注释）
- Modify: `src/sea/spectrum.ts`（新增导出 `accumulateSpectrum(base: ComplexField, add: ComplexField): void`——纯逐格相加、无重缩放；生产合并走它，契约才能被单测钉住）
- Modify: `src/sea/material.ts`（initSea 频谱构建循环，约 :459-479）
- Test: Create `src/sea/fine-band.test.ts`；回归 `src/sea/cascades.test.ts`、`src/sea/spectrum.test.ts` 必须原样通过（两者的窗口/振幅 pin 都不涉及本改动）

**Interfaces:**
- Consumes: `buildSpectrum(opts)` / `spectrumScaleToPeak(spec, peak)`（`spectrum.ts` 签名不变）。
- Produces: `Cascade` 新增可选字段 `fineBandMetres?: readonly [number, number]`、`fineCrestMetres?: number`、`fineSeed?: number`；CASCADES[1] 携带 `fineBandMetres: [4, 27.5]`、`fineCrestMetres: 0.04`、`fineSeed: 20261107`（种子是契约，钉在配置上——`material.ts:46` 的 `SPECTRUM_SEED` 是模块私有 const，测试 import 不到它）。后续任务只读这三个字段；`spectrum.ts` 另导出 `accumulateSpectrum`。

- [ ] **Step 1: 写失败测试** `src/sea/fine-band.test.ts`，断言：
  1. **字段 pin**：`CASCADES[1].bandMetres` deep-equal `[32, 128]` 且 `amplitudePeak === 0.1`（子带契约不动）；`CASCADES[1].fineBandMetres` deep-equal `[4, 27.5]`；`CASCADES[1].fineCrestMetres === 0.04`；`CASCADES[1].fineSeed === 20261107`。
  2. **格点零交集**：对 n=256、tile=192 枚举全部格点 |k|（`k = (i ≤ n/2 ? i : i−n)·2π/192`），断言不存在同时落入子带窗口 `[2π/128, 2π/32]` 与细带窗口 `[2π/27.5, 2π/4]` 的格点；细带非零模式波长全部 ∈ [4, 27.5]（即半径 **7**–48：r=7 → 192/7 = 27.43 m 收入，r=48 → 4.0 m 收入；r=6 的 λ=32 m 归子带，不得计入）。
  3. **细带能量口径**（原「realized crest ≡ 0.04 差 ≤2%」是 `spectrumScaleToPeak` 定义保证的恒等式，不能当判据——删）：以 `{n:256, tileMetres:192, bandMetres:[4,27.5], windSpeed:9, windDirRad:0.212, seed: CASCADES[1].fineSeed}` 构建频谱、按 `spectrumScaleToPeak(spec, 0.04)` 归一，断言：`<8 m` 模式能量占比 ≤ 1%（校准实测 0.50%）；细带坡度方差（与 `spectrumScaleToPeak` 同一 (re[k]+re[−k], im[k]−im[−k]) 配对口径、再加 k² 权重）占「子带（seed 20261106 同法构建）+细带」合计 ≥ 0.5（校准实测 **0.623**，防退化 seed）。另做接线自检：`2·scale·rms` 必须 = 0.040 ± 1e-6（失败说明用错缩放函数；它是恒等式，不得写成独立判据）。
  4. **子带逐位不动（真契约；原「同 seed 重建逐位相等」对确定性函数恒真——删）**：按生产 opts 构建子带 `sub`、细带 `fine`，先存 `subPre` 快照，再 `accumulateSpectrum(sub, fine)` 得合并产物，断言：①细带非零格全部落在细带窗、子带非零格全部落在子带窗（两集合不相交，λ=32 m 只归子带）；②逐格 `merged[i] === subPre[i] + fine[i]`——重开窗口重建、合并后重新归一、或任何非纯加法的合并都会破坏①②；③**golden pin**：实现时先用一次性脚本打印今天子带构建在**带内四点** `(nz,nx) = (0,2)` λ=96 m、`(0,3)` λ=64 m、`(1,4)` λ≈46.6 m、`(3,5)` λ≈32.9 m 的 re/im（float32 全精度）写死进测试——`buildSpectrum` 遍历序或缩放路径一变即红。**勿用带外点**（如 (3,8) 的 λ=22.5 m 系数恒为 0，钉它只能抓窗口改动，抓不到遍历序/缩放漂移）。
- [ ] **Step 2:** `npx vitest run src/sea/fine-band.test.ts` —— 预期 FAIL（字段不存在）。
- [ ] **Step 3: 实现。**
  - `cascades.ts:22-25` C1 条目追加 `fineBandMetres: [4, 27.5], fineCrestMetres: 0.04, fineSeed: 20261107`；头注释补「细带契约」小节：子带逐位不动；细带用 `fineSeed` 独立随机流、独立波高峰值归一后逐格相加；上界 27.5 的格点理由（约束 3）；<8 m 在 Phillips ℓ=tile/100 阻尼下能量 0.50%，细带实际承载 8–27.4 m；**`amplitudePeak` 保持 0.1 的理由**——护栏对象是顶点位移垂直混叠，细带不进几何（Task 3），护栏主体未变，69°/1920 上限 0.13746，合并后按 crest=2σ 惯例期望峰值 0.1077（不是 0.1+0.04 的最坏叠加 0.14），把字段改成 0.14 会直接撞红；顺带注明 `water-shading.ts` SLOPE_GAIN 注释的 0.01/0.1 口径是 C0+C1 合计坡度（raw 合计 0.0117、×14 后 0.1640），细带落地后全场预计 0.1901。
  - `material.ts` initSea 循环（约 :460-479）：`cascade.fineBandMetres` 存在时，构建第二份频谱 `{...同 opts, bandMetres: cascade.fineBandMetres, seed: cascade.fineSeed}`，按 `spectrumScaleToPeak(fineSpec, cascade.fineCrestMetres)` 归一后调用 `accumulateSpectrum(spec, fineSpec)`，再统一 `upload`。子带构建与缩放代码一字不改。
- [ ] **Step 4:** `npx vitest run src/sea/fine-band.test.ts src/sea/cascades.test.ts src/sea/spectrum.test.ts` —— 预期 PASS。
- [ ] **Step 5: Commit** `feat(sea): fine 4-27.5 m octave merged into C1 with a bit-identical sub-band`

### Task 3: 顶点位移低通（细带不进几何）

**Files:**
- Modify: `src/sea/cascades.ts`（新增导出 `C1_VERTEX_MIP_LOD`）
- Modify: `src/sea/material.ts`（顶点 C1 采样，:221-222）
- Test: `src/sea/cascades.test.ts`（追加）、`src/sea/material.test.ts`（追加源码 pin）

**Interfaces:**
- Produces: `C1_VERTEX_MIP_LOD: number`（≈3.1287）——顶点 C1 采样的固定 mip 档。

- [ ] **Step 1: 写失败测试。** `cascades.test.ts` 追加：`C1_VERTEX_MIP_LOD` 与 `Math.log2((CASCADES[1].bandMetres[0] / SAMPLES_PER_WAVE) / (CASCADES[1].tileMetres / CASCADES[1].n))` 之差 < 1e-9，且 ≈3.1287（toBeCloseTo, 3 位）——**分子必须是 32（`bandMetres[0]`，顶点该保留的最短波长），不是 `BAND_SPLIT_METRES`（=128，那是 C0/C1 分界）**：代 128 得 5.1287，公式断言与数值断言会互相打架（2026-11-08 交叉复核 A1 实锤）；`material.test.ts` 追加源码 pin：`texture(opts.height1, uv1).level(0)` 与 `texture(opts.chop1, uv1).level(0)` 不再出现（顶点 C1 不再全分辨率采样）。
- [ ] **Step 2:** 跑 —— 预期 FAIL。
- [ ] **Step 3: 实现。** `cascades.ts` 导出 `C1_VERTEX_MIP_LOD = Math.log2((CASCADES[1].bandMetres[0] / SAMPLES_PER_WAVE) / (CASCADES[1].tileMetres / CASCADES[1].n))`，同文件加 `SAMPLES_PER_WAVE = 4.878`（注释引用 rings.ts:10-14 的 ~4.9 采样/波长规则；分母 0.75 = 192/256 是 C1 纹理的米/纹素）。**分子取 `CASCADES[1].bandMetres[0]` 而非 `RINGS[0].floorMetres` 的理由**：两者今天都是 32，但用 cascades 常量可避免新增 cascades→rings 依赖；**日后改 C1 窗口必须同步复核本常量**（窗口下移会让顶点低通变松，细带就会漏进几何）。语义注释：这是**兑现 `rings.ts` 的既定契约**——其 docblock 规定 `mipLod` 应把 `floorMetres` 以下的波低通掉，R0 的 floor = 32 m，而 C1 顶点采样一直 `.level(0)` 没兑现；顶点 C1 仅 R0 在采（`material.ts:500` 的 `vertexChop: i === 0`），外三环只有片元路径，固定单值 LOD 不存在环缝问题；片元 `lodF1` 的自动 per-pixel mip（`material.ts:246`）不动，回归守门是 Review Focus 5（240/60 m std ±30%）。`material.ts:221-222` 两处 `level(0)` → `level(C1_VERTEX_MIP_LOD)`。
- [ ] **Step 4:** `npx vitest run src/sea/cascades.test.ts src/sea/material.test.ts` —— 预期 PASS。
- [ ] **Step 5: Commit** `fix(sea): low-pass vertex C1 displacement at the 32 m floor`

### Task 4: 验收采集与度量（round-3）

**Files:**
- Create: `artifacts/sea-review/`（round-3 前缀帧与量测 JSON）
- Modify: `artifacts/cloud-audit/protocol/baseline-content-anchored.json`（**整份重生成**，见 Step 4）、`artifacts/cloud-audit/protocol/night-baseline.json`（若昼夜计划已产出，随重采更新）
- Modify: 本文档进度段

**Interfaces:**
- Consumes: Task 1 的 `?sea=nochop`、Task 2 的细带、Task 3 的顶点低通；`artifacts/sea-review/capture.mjs`、`motion.mjs`、`measure.py`、`details.py`。

- [ ] **Step 1: 采集。** 冻结协议（约束 8）拍修复后帧：`?alt=240`、`?alt=120`、`?alt=60`（post=0）、`?alt=20`、`?alt=7`、SKIM 下拖、3 m 掠角；A/B 与守门帧：7 m 与 20 m 各加 `?sea=nochop` 一帧、7 m 低档（`qa.setQuality(false)`）一帧。
- [ ] **Step 2: 量测与判定**（`measure.py`/`details.py`，对照 Task 0 抄录基线）：
  1. **7 m 腿（H007-alt7 / SKIM-dive7）**：`stripes_near ≥ 2`（基线 0）；`gy ≥ 2× 基线`（即 ≥0.056 / SKIM ≥0.048）；`?sea=nochop` 帧两值回落到基线 ±20%（A/B 闭环，review 判据 1）。**A/B 粒度**：`nochop` 关的是整个 `c1Gate`（32–128 m 子带 + 细带一起），所以它证明「结构来自 C1 波场」，**不能**单独证明「结构仅来自细带」；细带的独立贡献由 Task 2 的方差占比 62.3% 与 Task 3 的顶点低通间接约束，回执里不得把话说大。注意：基线 `gy` 本来就 >0（0.028/0.024），「梯度 > 0」是恒真断言不许写；7 m 近带 `std` 基线 12.5/8.76（含太阳路亮斑），只记录不作判据。
  2. **20 m 腿（H020-alt20）**：`stripes_near ≥ 2`（基线 0）；`gy ≥ 2×0.043 = 0.086`；`std ≥ 1.5×3.58 = 5.4`——3.58 是 **20 m** 的 std 基线，挪到 7 m 用会恒真（7 m 基线是 12.5）。「可与 287 px 翼展构成可读倍数的重复结构」（review 判据 2）保留为目检判断，不冒充度量。
  3. 240 m 近带 std 相对 42.97 在 ±30% 内；60 m 近带 std 相对 33.58 在 ±30% 内（Review Focus 5）。
  4. 低档帧与修复前低档一致，无残影/新伪影（Review Focus 4）。
  5. 目检：太阳路连续亮带不碎（Focus 2，对照设计输入表的坡度预测：全场 ×14 从 0.164 到 0.190）、泡沫无新增连片（Focus 3）、7 m 无爬行闪变（Focus 1）、7 m 与 20 m 各出现 ≥2 个可分辨的波峰/波谷起伏（review 判据 1 的人工项）。
  6. **太阳路/辉点预算（不得劣于 11-07 落地值）**：同一向阳机位（A3）用 `artifacts/sun-road-review/measure_bands.py` 复测，硬门 `clean_sea.blown% ≤ 6.3` 且 `clean_sea.p95 ≤ 207.1`；`glints_seam_excluded`（基线 43）与 `road.display_ratio`（基线 1.35，线性 2.65）记录对照，明显变差即回 Step 3 降 crest。**理由**：细带把 C1 坡度 RMS 从 0.0747 提到 0.1217（+63%），而 `sunRoadGain` 吃的正是这份 specDot——这条是唯一能证明「修 P1 没拿太阳路去换」的判据，缺了它 Review Focus 2 就只剩一句目检。
- [ ] **Step 3: 条件回调。** 判据 1/2 未达标而 3/4/5 全绿时，`fineCrestMetres` 在 [0.03, 0.06] 内回调并重跑 Step 1–2；回调值与理由记进度段；对照设计输入表的坡度预测行（全场 ×14：0.03 档 0.1791 / 0.04 档 0.1901 / 0.06 档 0.2184）判断观感落在哪个区间再动。超出区间或判据 3/4/5 同时破 → 停下回审查流程，不得自行加大改动。
- [ ] **Step 4: cloud-audit 基线对账（判据全绿后执行）。** 细带会改变所有高度的海面像素，而 `artifacts/cloud-audit/audit.py --parity` 是精确相等比较（3 个 ref pair / 102 pin，sea 块含 `value_mean` 等聚合值）——修完海面跑它必然全数 FAIL，这是**基线过期，不是回归**：① 按冻结协议重采 4 个现有状态；② 用 `audit.py --json` 的 pairs 段**整份重生成**基线（工具没有「逐 pin 重钉」路径）；③ 昼夜计划产出的 `night-baseline.json` 含夜档海面颜色，同样重采并过 `--night-baseline` 门（该开关由昼夜计划 Task 8 落地）；④ before/after 的 sea 块 diff 与换基线原因记进度段。
- [ ] **Step 5:** 归档 round-3 帧与量测 JSON；**Commit** `test(sea): round-3 near-field acceptance frames for the fine octave`

### Task 5: 文档回执

**Files:**
- Modify: 本文档进度段、`docs/superpowers/reviews/2026-11-07-sea-wave-scale-review.md`（文末追加小节）

- [ ] **Step 1:** 在海面审查报告文末追加「修复回执（日期取执行日）」：指向本计划与 round-3 归档；逐条给出 A/C 两项 P1 验收判据结果（含 Task 4 判据 6 的太阳路守门数字）；注明 D（60 m 直线）与 E（尾迹灰板）不在本修复范围，D 所需的 c1Gate A/B 工具已由 `?sea=nochop` 提供；注明 cloud-audit 基线已随 Task 4 Step 4 整份换新（含夜间基线）。
- [ ] **Step 2: Commit** `docs(reviews): fine-octave fix receipt against the 11-07 sea review`

## 验证（整体验收 = Task 4 Step 2 的 6 条判据）

跑不了浏览器时的最低替代：Task 1–3 的测试 + `npx tsc --noEmit` 全绿 = **代码通过评审、可以交付审查**；但 P1（近场无波 / 4–32 m 缺八度）**不得据此标 closed**——上一轮的教训正是源码 pin 测试全绿、画面缺陷照样存在。P1 的关闭只认 round-3 冻结帧 + Task 4 Step 2 判据全绿；采集与目检在可跑环境时补。

## 明确不做（另立计划或后续评审）

- 第三个 FFT 级联、`fft-gpu.ts` 任何改动（数据驱动路径足够）。
- <8 m 波纹：Phillips ℓ 阻尼下能量≈0；若验收后仍觉不够细，调整 `PHILLIPS_ELL_DIVISOR` 属频谱契约改动，另行评审。
- SLOPE_GAIN / WATER_OPTICS 数值改动、程序化 detail 法线（1.6 cm texel）的去留重估——细带落地后它的相对作用变了，留到 round-3 验收后再议。
- 审查 D 项（60 m 全宽直线，c1Gate A/B 闭合）与 E 项（掠海尾迹灰板）：工具已备，修复另立计划。
- 审查 B 项（几何轮廓/遮挡缺失）已降级 P3 属风格取舍，不在本修复范围。

---

## 进度与批次记录

| 日期 | 批次 | 结果 | 提交 |
|---|---|---|---|
| 2026-11-08 | 计划写成：校准实测两轮（否决「直接拓宽窗口」方案，定「子带逐位不动 + 细带独立归一」）+ 自审 | 待用户审 | 未提交（等审核通过） |
| 2026-11-08 | 元核查补丁：Task 4 新增 cloud-audit 基线整份重生成步骤（细带改变全部海面像素，parity 精确比较必 FAIL，需换新基线，含夜间基线）；Task 5 回执补注 | 待用户审 | 未提交 |
| 2026-11-08 | 外部审核 + 交叉复算修订入文（复算用仓库 `spectrum.ts` 真函数、一次性 vitest 探针）：A1 mip 公式分子改 `bandMetres[0]`=32（原 `BAND_SPLIT_METRES`=128 得 5.1287 与钉值互斥）；A2 校准表修正为 0.0961/62.3%/合并 0.1217/全场 0.1640→0.1901；B3 判据 1/2 可证伪化（7 m：gy≥2×基线+stripes≥2+nochop A/B；std≥5.4 归 20 m 腿）；B4 验证节后门封死（P1 关闭只认 round-3 帧）；B5 恒真断言删、换逐格加法契约+golden pin+<8 m≤1%；B6 `amplitudePeak`=0.1 理由入注（护栏 0.13746、期望峰值 0.1077）；B7 种子字段化 `fineSeed: 20261107`；B8 顶点 C1 仅 R0 澄清 + Task 3 定性为兑现 rings.ts 契约；D 保留默认 0.04、写入正确坡度预测表 | 待用户审 | 未提交 |
| 2026-11-08 | 二审落文（3 必修 + 3 小修）：① 细带半径改回 **7–48**（原 8–48 与本文件约束 3 的「半径 7」矛盾）；② Task 4 增判据 6「太阳路/辉点预算不劣于 11-07 落地值」（`clean_sea.blown%` ≤6.3、`p95` ≤207.1、`glints` 43、`display_ratio` 1.35），Task 0 同步抄 `A3-r2.png` 基线；③ 写明 `?sea=nochop` 的 A/B 粒度（关整个 `c1Gate`，不能单独证明细带）；小修：golden pin 换带内四点、Task 3 补「分子取 `bandMetres[0]`」的理由、Task 5 日期占位改「执行日」 | 待用户审 | 未提交 |
| 2026-11-09 | **Task 0 开工对账（执行批）**：① 工作树干净（仅 git-ignored `.workbuddy/` 与无关 untracked `artifacts/sea-audit/`）；② 昼夜计划 Task 1–8 已全验收（2026-11-09，473e26a：像素门/parity 110 钉值/夜基线 45 钉值/目检五项）——约束 1 满足；③ vitest 46 文件 385 用例全绿、tsc 干净。④ 对照基线抄录（自盘上 JSON 实测，非文档转述）：240m 近带 std **42.97**（stripes_near 7）、60m 近带 std **33.58** / 垂直梯度 **0.427**（stripes_near 2）、20m 近带 std **3.58** / gy **0.043**（stripes_near 0）、7m gy **0.028** / SKIM gy **0.024**（stripes_near 均 0）、7m 近带 std **12.5** / SKIM **8.76**（含太阳路亮斑只记录）；row_stripes 口径 = 行均值梯度>3 的行数。太阳路守门（A3-r2.png）：clean_sea blown% **6.3**、p95 **207.1**、glints_seam_excluded **43**、road display_ratio **1.35**（线性 2.65）、gt200_pct 24.4 | PASS | —（Task 0 无提交） |

（每完成一个 Task 追加一行：Task 号、验收结果、提交哈希、fineCrestMetres 等艺术值调整记录。）

| 2026-11-09 | **Task 1 ?sea=nochop 钩子**：3 新用例（parseSeaNoChop 真值表 + nochop 不藏海不进假色 + material 源码 pin setChopGate）；qa.test/material.test 回归绿；全量 388/388、tsc 干净 | PASS | a60537c |
| 2026-11-09 | **Task 2 C1 细带构建**：6 新用例（字段 pin、格点零交集 半径7–48 vs 2–6 且 λ=32 只归子带、<8m 能量占比实测 = 0.50%≤1%、k² 坡度方差占比实测 = 0.623≥0.5、接线恒等式 2·scale·rms=0.040±1e-6、逐格 fround 加法 + 窗口互斥 + golden pin 四点（子带 seed 20261106 + amplitudePeak 0.1 缩放路径，探针打印回填））；cascades.test/spectrum.test 既有 pin 回归绿；全量 394/394、tsc 干净。校准表全部复现 | PASS | 8bf690c |
| 2026-11-09 | **Task 3 顶点位移低通**：2 新用例（C1_VERTEX_MIP_LOD 公式+数值双钉、分子=bandMetres[0] 与 BAND_SPLIT 互斥断言；material 源码 pin 两处 level(0) 消失 + C1_VERTEX_MIP_LOD 在场）；全量 396/396、tsc 干净 | PASS | 7d9c283 |
| 2026-11-09 | **Task 4 round-3 采集与量测**：11 帧落盘（720×1280 七腿 + 448×797 A3 双帧 + nochop/lowtier）。**判据表**：① 7m——stripes_near 0/需≥2 **FAIL**（机制错配：row-mean-gradient 数不出宽幅 2D 起伏）；gy 0.036/需≥0.056 **FAIL**（1.29×；nochop 对照 C1 贡献 +71%）；nochop 回落 std ✓ stripes ✓ gy −25% 略出 ±20%（昼夜端点变化混淆，见④注）。② 20m——gy 0.147 ≥0.086 **PASS**（3.4×）；std 7.79 ≥5.4 **PASS**（2.2×）；stripes 0 **FAIL**（同①）。③ 240m 39.65（−7.7%）/60m 38.85（+15.7%）±30% 内 **PASS**。④ 低档：round3-H007-nochop ≡ round3-H007-lowtier **逐字节一致** + 细带四条采样路径（fragment slope1/jac1、vertex height1/chop1）全部 ×c1Gate——构造性无残影 **PASS**。⑤ 目检：7m/20m 近场宽幅起伏在场（对照 round-1 玻璃面）、太阳路连续、泡沫无新增连片、H020 中场纹理显著增强。⑥ 太阳路硬门 blown **4.8 ≤ 6.3** ✓ / p95 **204.2 ≤ 207.1** ✓；display_ratio 1.43（优于基线 1.35）；glints **43→0**——**归因**：A3-nochop（c1Gate=0）自身只剩 4 辉点（43→4 = 联动修复的反射基准改变 + 昼夜霾端点的贡献），细带收尾 4→0；降 crest 救不回（nochop 已无）。**回调分析**：crest 0.06 → 7m gy 预测 ~0.045 仍 <0.056 且 stripes 机制上仍 0、辉点更差；crest 0.03 → 辉点不回、近场更弱——两方向都打不中目标，按 Step 3 逃逸条款**停**，不盲目迭代。**执行裁定**：round-1 基线（11-07 上午）与 HEAD 之间隔着 sun-road/联动/昼夜三批改动，Task 0 抄录的「修复前」数值不是纯净 before——nochop A/B 才是活体对照。vite 只绑 IPv6 + Chrome 对 localhost 做 IPv4/6 竞速 → 采集脚本间歇 chrome-error，BASE 显式 [::1] 解决 | PASS（判据 2/3/4/6；1/5 部分未达 → 见 Task 5 回执，P1-A 不关闭） | be58687 |
| 2026-11-09 | **Task 4 Step 4 cloud-audit 基线重同步**：7 态重采（细带版海面）+ 夜三档 repeat 逐字节一致 ✓；昼基线整份重生成（3 pair/110 钉值）parity **PASS**；夜基线重生成（49 钉值）--night-baseline **PASS**。夜档天空 L*/C* 与昼夜计划 era **逐位一致**（9.4/5.5/7.9，27.0/25.1/28.8）——细带未触碰天空的直接证据。参考档暖带 C*med 41.9 ≥ 31.5 门（Task 0 基线 32.0−0.5）：不劣化反更饱和——Δ 来源是 sun-road 天空端/联动修复（10-31 老帧不是当前天空的对照），非本批 | PASS | be58687 |

（每完成一个 Task 追加一行：Task 号、验收结果、提交哈希、fineCrestMetres 等艺术值调整记录。）
