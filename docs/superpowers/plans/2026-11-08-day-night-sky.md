# 昼夜天空第一步（黄昏↔夜）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「单一黄昏快照」的天空升级为「物理能量场 × 调色板轨道」混合模型，第一版覆盖黄昏↔夜过渡与夜档，海面/云/灯光随太阳联动。

**Architecture:** `skyColorTsl` 签名不变，内部改为三层合成：(1) 调色板轨道——按太阳仰角插值的关键帧（纯 JS、可不开浏览器测试），色相与绝对明度由轨道决定；(2) Preetham 比率能量场——从 three 0.186 `SkyMesh.js` 移植的 TSL 数学，输出对参考太阳归一，参考档恒等于 1，只负责**漫射项**的空间亮度分布——日盘/晖光是直射项，在能量场之外直加（太阳仰角低于 −2.31° 后 Preetham 的 vSunE 恒 0，直射项放进 E 会被一并乘没，过渡档余晖出不来）；(3) 夜档独立 navy ramp 按 `nightWeight` 混入，不被能量场乘黑。海面反射走同一个函数自动联动；海面霾目标色从烘焙常量改为轨道 uniform。参考档必须与现有实现数值恒等（`audit.py --parity` 兜底）。

**Tech Stack:** TypeScript + three 0.186（WebGPU/TSL，WebGL2 回退已删）+ vitest + python 采集验收链（`artifacts/cloud-audit/`）。

**Spec:** 无独立 spec，本计划自含。背景与基线：`docs/superpowers/plans/2026-10-31-sky-technical-note.md`（天空现状审核）、`docs/superpowers/plans/2026-11-06-stylized-fft-ocean.md`（Task 7 现状：GLOW_POW 120、风格化日盘、DUSK_BAND 钳制）。

## Global Constraints

1. **参考档恒等**：太阳处于默认方向（`SUN_DIRECTION`，代码口径 `asin(SUN_DIRECTION[1]) ≈ 6.97°`）时，新 `skyColorTsl` 输出与现实现一致；`python artifacts/cloud-audit/audit.py --parity` 现有 **3 个 ref pair（A-cruise/B-dive/C-bankdive，共 102 pin；D-skim 无参考图不进 parity）**必须 PASS。**显式例外（有意修复，不算回归）**：海面向阳霾端点自 Task 5 起按约束⑤由 `skyColorJs` 派生，参考档该端点 Δ≈[+0.173,+0.135,+0.090]（glow 项补齐海天同源），sea 块 pin 会因此 FAIL——属预期，按 Task 8 Step 2 的「整份重生成」流程换新基线并记录；**没有「逐 pin 重钉」这条路**：`parity()` 只读、比较是 1e-6 全等，「漂 1 个 LSB 重钉」在量纲与工具上都不成立。
2. **调色单源**：轨道参考档的一切数值必须 import 自 `SKY_STOPS` / `HORIZON` / `SKY_PALETTE`，禁止抄写数字副本。
3. **签名不变**：`skyColorTsl(tsl, dirNode, sunDirNode, includeDisc = true)`（`sea/material.test.ts:90` pin 死了海面的调用形态）。
4. **输出管线不动**：`TONE_MAPPING = { mode: 'neutral', exposure: 1.0 }`（`renderer.ts:17-20`）；不在 `post.ts` 加天空专用 pass；链保持 bloom → dof → smaa。
5. **霾同源**：海面霾端点与天穹边缘色必须来自同一份 JS 计算。Task 5 起端点**由 `skyColorJs` 在两个标准地平方向（正对太阳方位 / 背对太阳方位）求值派生**，不再手写颜色——因为能量场 E 本身带方位变化，端点若另编一份就会在过渡档双重建模方位、裂出海天接缝。Task 1 阶段 `hazeLinear = dayStops[0]` 只是参考档恒等的临时形态，Task 5 将其取代。这是旧技术说明 Global Constraints 1/5 的轨道化版本。
6. **bloom 预算**：每个轨道档的**非盘区**（`includeDisc=false`，等价剔除太阳方向 ±2.5° 锥）全天空峰值线性 Rec709 亮度 < 该档 `bloomThreshold`；日盘区单独上界 ≤ 1.10（日盘有意越阈开花是 `post.ts:45-64` 写明的既有设计，参考档实测 ≈1.03，不纳入该断言；vitest 钉住；阈值本身第一步保持 0.82 不动）。
7. **WebGPU-only**：不得引入 `forceWebGL`（`renderer.test.ts:42` pin）。
8. **TSL 函数形式**：r186 的 `.mix()` 方法形式有 bug，一律用 `mix(a, b, t)` 函数形式（`sea/material.ts:425-427` 注释）。
9. **颜色空间**：新颜色一律先 sRGB→线性 再进 TSL；所有插值在线性空间做。纯函数模块（sky-track / sky-preetham / sky-color-js）不 import THREE，自带上采样率 decode，并用测试对照 `THREE.Color` 的转换结果。

## Review Focus

1. **过渡带海天接缝色带**（太阳 0°/−4° 时海的霾目标与天穹边缘色不同源）——合理预期：任何仰角下海平线两侧逐像素同色。→ Task 5 的同源性测试钉住。
2. **比率场在太阳过零附近的 NaN/极端值**——合理预期：任何仰角任何方向输出有限且在 [0,2]。→ Task 2 的采样测试钉住。
3. **夜档整屏进 bloom**（夜 ramp + 星点过亮）——合理预期：夜档只有星点核可能越过阈值。→ Task 4 的每档亮度预算测试钉住。
4. **插值做在 sRGB 空间导致中间档发灰**——合理预期：插值在线性空间，测试用已知两端验证中点。→ Task 1 钉住。
5. **现有状态 pin 漂移超容差**——合理预期：漂移必须能指出原因并记录，不允许静默重定基线。→ Task 8 的 parity 步骤把关。
6. **夜档云变「黄昏云」**——云的向阳方向本来就每帧跟随活太阳，但四档带色与空气透视色是写死的黄昏暖色（`puff-cloud.ts:143` / `HAZE_COLOR`）。合理预期：云色随轨道变暗变冷，不明显亮于夜空地平带。→ Task 5 的云调色 uniform 化 + Task 8 目检⑤钉住。

---

### Task 0: 开工对账

**Files:** 无（只读检查）

- [ ] `git status` 对账：确认工作树干净或已知未跟踪文件与本计划无关（并行会话可能改过仓库），把对账结果记进本文档进度段。
- [ ] `npx vitest run` 确认当前全绿，作为基线。
- [ ] `python artifacts/cloud-audit/color_sample.py` 跑一次，把参考档（默认太阳）暖天带的 C\*med 与 L\*med 记进进度段——这是 Task 8 「不得劣化」判定的基线，不引用旧文档里的历史值。

### Task 1: 调色板轨道 `sky-track.ts`

**Files:**
- Create: `src/sky-track.ts`
- Modify: `src/palettes.ts`（新增 `export const SUN_TINT_LINEAR = [1.0, 0.78, 0.52]`——把 `sky-webgpu.ts:55` 的模块私有 `SUN_TINT` 升进调色单源，注释写明「multiplier, already linear：线性乘子而非 sRGB 颜色，约束⑨的 sRGB 解码不适用于它」；sky-webgpu 本任务不动，Task 3 改为 import。同时把 `puff-cloud.ts:143` 的 `PUFF_BAND_COLORS` 四档色升进 palettes 导出（sRGB 十六进制，走约束⑨解码），puff-cloud 本任务不动、Task 5 改 import）
- Test: `src/sky-track.test.ts`

**Interfaces:**
- Consumes: `SKY_STOPS`（`src/palettes.ts:71-76`）、`HORIZON`（`src/horizon.ts:19-85`）、`SKY_PALETTE`、`SUN_DIRECTION`（`src/palettes.ts:34-38`）。
- Produces（后续任务按这些名字用）:
  - `type Vec3 = readonly [number, number, number]`（线性 RGB）
  - `export const REFERENCE_ELEVATION_DEG: number`（= `asin(SUN_DIRECTION[1]) * 180 / Math.PI` ≈ 6.97）
  - `export interface SkyTrackState`，字段（颜色字段全部线性 Vec3）：`dayStops: [Vec3, Vec3, Vec3, Vec3]`、`nightStops: [Vec3, Vec3, Vec3, Vec3]`、`nightWeight: number`、`awayColor: Vec3`、`awayGain: number`、`awayHeight: number`、`glowPow: number`、`glowGain: number`、`sunTint: Vec3`、`discGain: number`、`cloudBands: [Vec3, Vec3, Vec3, Vec3]`、`cloudHaze: Vec3`、`hazeLinear: Vec3`、`awayEdgeLinear: Vec3`、`floorLinear: Vec3`、`preetham: { turbidity: number; rayleigh: number; mieCoefficient: number; mieDirectionalG: number }`、`sunLightColorCss: string`、`sunLightIntensity: number`、`hemiSkyCss: string`、`hemiGroundCss: string`、`hemiIntensity: number`、`veilCool: Vec3`、`veilWarm: Vec3`、`starOpacity: number`、`bloomThreshold: number`
  - `export function skyTrackAt(sunElevationDeg: number): SkyTrackState`——四个关键帧 `[-8, -4, 0, REFERENCE_ELEVATION_DEG]`（度），段内对每字段 smoothstep 插值，段外钳到端点。
  - `export function lerpTrackStates(a: SkyTrackState, b: SkyTrackState, t: number): SkyTrackState`——`skyTrackAt` 内部使用的段内插值，单独导出以便用合成 state 测插值空间。
  - `export function rampColorJs(dirY: number, stops: readonly [Vec3, Vec3, Vec3, Vec3]): Vec3`——现 `sky-webgpu.ts:74-79` stop 链式 mix 的 JS 镜像（含 `t = smoothstep(-0.02, 0.55, dirY)`、固定锚点 0/0.42/0.72/1，**段内 mix 因子同样是 smoothstep**——`smoothstep(stops[i-1].at, stops[i].at, t)`，不是线性插值）。
  - `export function srgbToLinear(css: string): Vec3`——纯 decode（照 `horizon.ts:101-118` 的写法），不 import THREE。

- [ ] **Step 1: 写失败测试** `src/sky-track.test.ts`，断言：
  - 参考档恒等来源：`skyTrackAt(REFERENCE_ELEVATION_DEG)` 的 `dayStops` 逐通道等于 `srgbToLinear(SKY_STOPS[i].color)`；`awayGain === HORIZON.AWAY_GAIN`；`awayHeight === HORIZON.AWAY_HEIGHT`；`glowPow === HORIZON.GLOW_POW`；`glowGain === HORIZON.GLOW_GAIN`；`discGain === HORIZON.DISK_GAIN`；`sunTint` 等于新增的 `SUN_TINT_LINEAR`（palettes.ts，值 `[1.0, 0.78, 0.52]`——单源，不抄第二份）；`nightWeight === 0`；`floorLinear === [0,0,0]`；参考档 `cloudBands` 逐档等于 `srgbToLinear(PUFF_BAND_COLORS[i])`（自 palettes import）、`cloudHaze` 等于 `srgbToLinear(SKY_PALETTE.horizon)`（即 `HAZE_COLOR #ff9a5a`）；`hazeLinear` 等于 `srgbToLinear(SKY_PALETTE.horizon)`；`awayEdgeLinear` 等于现 `awayHorizonLinear()` 的返回值。
  - `srgbToLinear` 与 `new THREE.Color(css).r/g/b` 一致（对 `#ff9a5a`、`#4a2f74`、`#5a3f60` 三色，容差 1e-9）。
  - 插值在**线性**空间：用 `lerpTrackStates` 传两个合成端点 state（颜色字段一个全 `[0,0,0]` 一个全 `[1,1,1]`），取 `t=0.5`，断言颜色字段输出 ≈ `[0.5,0.5,0.5]`（sRGB 空间插值会得到别的东西，这条钉死空间）。
  - 段外钳制：`skyTrackAt(-20)` 深等于 `skyTrackAt(-8)`；`skyTrackAt(30)` 深等于参考档。
  - `rampColorJs` 断言：`dirY` 使 `t=0` 时返回 `stops[0]`，`t≥1`（dirY ≥ 0.55）返回 `stops[3]`；**段内四分点断言**（防线性插值冒充——端点断言抓不到中段漂移）：用合成 stops `[[0,0,0], [1,1,1], [0,0,0], [0,0,0]]`，取使外层 t 落在第一段 25% 处的 dirY（测试里数值反解 `smoothstep(-0.02, 0.55, ·)`），断言输出逐通道 = smoothstep 四分点 0.15625（线性插值会得 0.25）。
- [ ] **Step 2:** `npx vitest run src/sky-track.test.ts` —— 预期 FAIL（模块不存在）。
- [ ] **Step 3: 实现。** 关键帧表如下（`dayStops`/夜档色/云带色为**初始艺术值**，Task 8 验收时允许按 `color_sample.py` 与目检调整，调整必须记录在进度段；参考档列禁止改动）：

| 字段 | 参考 ≈6.97° | 0° | −4° | −8°（夜） |
|---|---|---|---|---|
| nightWeight | 0 | 0.15 | 0.7 | 1 |
| dayStops[0..3] | = SKY_STOPS | horizon `#e07040`，rose `#a4557d`，top `#57417f`，end `#3a2860` | horizon `#8f4a52`，rose `#5f3a5e`，top `#33305a`，end `#1e1a40` | （不参与） |
| nightStops[0..3] | 全 `[0,0,0]` | 同 −8 键 ×0.3 亮度 | horizon `#26304f`，`#1b2340`，`#101630`，`#080d1e` | 同 −4 键 |
| awayColor / awayGain / awayHeight | `#5a3f60` / 0.75 / 0.42 | `#5a3f60` / 0.8 / 0.42 | `#3a2f45` / 0.5 / 0.42 | `#1c1c2e` / 0.2 / 0.42 |
| glowPow / glowGain | 120 / 0.42 | 120 / 0.5 | 150 / 0.45 | 180 / 0.06 |
| sunTint | `[1.0,0.78,0.52]` | `[1.0,0.62,0.34]` | `[0.9,0.45,0.25]` | `[0.5,0.35,0.30]` |
| cloudBands / cloudHaze | = `PUFF_BAND_COLORS` 四档 / `#ff9a5a` | `#5f5a84` / `#6f62a0` / `#9c688e` / `#a08088`，haze `#e07040` | `#45406b` / `#554a80` / `#6d4a68` / `#75606a`，haze `#8f4a52` | `#232845` / `#2c3055` / `#3a3050` / `#453a4a`，haze `#26304f` |
| discGain | 0.3 | 0.35 | 0 | 0 |
| hazeLinear | = dayStops[0] | = dayStops[0] | = dayStops[0] | = nightStops[0] |
| awayEdgeLinear | 现公式派生 | 同公式派生 | 同 | 同 |
| floorLinear | `[0,0,0]` | `[0.002,0.002,0.005]` | `[0.004,0.005,0.012]` | `[0.006,0.008,0.018]` |
| preetham (turb/ray/mie/mieG) | 2 / 1 / 0.005 / 0.8 | 3 / 2.5 / 0.008 / 0.8 | 3.5 / 3.5 / 0.006 / 0.82 | 4 / 4 / 0.004 / 0.85 |
| sunLight | `#ffd9a0` / 2.2 | `#ff8a50` / 1.4 | `#d05a40` / 0.6 | `#304060` / 0.15 |
| hemi sky/ground/int | `#8a6fd0`/`#2a1a3a`/0.7 | `#6a55b0`/`#201430`/0.5 | `#3a3060`/`#101020`/0.3 | `#1a2040`/`#080a14`/0.12 |
| veilCool / veilWarm | `#cfc6da` / `#ffe9c4`（= `in-cloud.ts:48-50` 现值） | 同参考 | `#a8a2c0` / `#d8a880` | `#8085a8` / `#b08860` |
| starOpacity | 0 | 0 | 0.35 | 1 |
| bloomThreshold | 0.82 | 0.82 | 0.82 | 0.82 |

  `hazeLinear` 与 `awayEdgeLinear` 在本任务里不是独立 authored 值：haze = `dayStops[0]`（参考档恒等形态），awayEdge = `(1−k)·haze + k·awayColor`（k = awayGain，即现 `awayHorizonLinear()` 公式对轨道值的推广）。**Task 5 会把这两个字段的来源改成 `skyColorJs` 镜像派生**（见 Global Constraint 5），本任务的形态只为让恒等测试先行成立。
- [ ] **Step 4:** `npx vitest run src/sky-track.test.ts` —— 预期 PASS。
- [ ] **Step 5: Commit** `feat(sky): keyframed palette track with a reference-key identity guarantee`

### Task 2: Preetham 移植 `sky-preetham.ts`

**Files:**
- Create: `src/sky-preetham.ts`
- Test: `src/sky-preetham.test.ts`

**Interfaces:**
- Consumes: 仅类型导入 `Vec3`（`import type { Vec3 } from './sky-track'`，无运行时依赖）。**`tsl` 由调用方传参**（与 `skyColorTsl` 同模式），本文件不得静态 import `three/tsl`——`module-graph.test.ts:28` 禁止 src 根目录文件静态 import three/webgpu|tsl，新建的 sky-preetham.ts 恰在扫描范围。数学源：`node_modules/three/examples/jsm/objects/SkyMesh.js` 156–278 行（vertex 阶段的 vSunE/vBetaR/vBetaM 预计算改为逐像素从 sun uniform 重算，代价可忽略）。**必须剥离**：280–379 行的 fbm 云块，以及 275 行的 `sundisc` 项（它落在 156–278 区间内，移植时按区间原样搬会把盘带进比率场）——P() 的输出取 `(Lin + L0) × 0.04`，显式不含 sundisc；278 行的蓝底常数 `vec3(0.0, 0.0003, 0.00075)` **一并保留**（它加在 0.04 之后，顺带保证 P>0、消掉暗方向 0/0 隐患）：参考档分子分母同函数同输入，E 仍严格等于 1；非参考档暗区（P<0.05）蓝通道比值有 1%–15% 偏置，已知并接受，实现注释写明——勿写「比率会消掉常数」，它只在参考档消掉。
- Produces:
  - `export interface PreethamParams { turbidity: number; rayleigh: number; mieCoefficient: number; mieDirectionalG: number }`
  - `export function preethamRadianceJs(dir: Vec3, sun: Vec3, p: PreethamParams): Vec3`——忠实移植（保留 SkyMesh 的地影 hack cutoffAngle/steepness/EE 与 ×0.04 曝光因子与 278 行蓝底常数——常数在比率里不严格消掉，口径见 Interfaces 注；保留只为 transcription 对照）。
  - `export function energyRatioJs(dir: Vec3, sun: Vec3, p: PreethamParams, refSun: Vec3, refP: PreethamParams): Vec3`——逐通道 `clamp(P(dir,sun,p)/P(dir,refSun,refP), 0, 2)`，除零/NaN → 0。
  - `export function preethamRadianceTsl(tsl, dirNode, sunDirNode, paramsU): any`——TSL 版同数学；`paramsU` 是四个 `uniform()` 节点（轨道每帧改 value，不重编译）。

- [ ] **Step 1: 写失败测试**：① `sun === refSun` 且 `p === refP` 时 `energyRatioJs` 逐通道 === 1（采样 20+ 方向：地平线向阳/背阳、天顶、±30° 仰角）；② 仰角从参考档扫到 −8°、方位 ±90°，所有采样点无 NaN/Inf 且比值在 [0,2]；③ 地平线向阳方向的亮度在参考档 > −4° 档 > −8° 档（粗粒度单调；0° 档允许物理回弹不设断言，实测值记录进进度段。2026-11-08 数值复算：两档 vSunE 同为 0，但各档 preetham 参数不同使消光不同，P(−4°)≈1.44e−6 > P(−8°)≈6.12e−7——**此断言会通过，勿因审核报告 B1 的相反判断改弱它**）；④ 天顶方向亮度同样参考档 > −4° 档 > −8° 档；⑤ `preethamRadianceTsl` 用真 `three/tsl` 调用不抛异常且返回对象。
- [ ] **Step 2:** `npx vitest run src/sky-preetham.test.ts` —— 预期 FAIL。
- [ ] **Step 3: 实现**（JS 版先行，TSL 版照搬同一公式树，两边共用常量表）。
- [ ] **Step 4:** `npx vitest run src/sky-preetham.test.ts` —— 预期 PASS。
- [ ] **Step 5: Commit** `feat(sky): preetham energy field, normalized to the reference sun`

### Task 3: `skyColorTsl` v2 与 JS 总镜像

**Files:**
- Modify: `src/sky-webgpu.ts`（`skyColorTsl` 72–102 行内部重写；`initSunsetSkyTSL` 不变；新增 `applySkyTrack`）
- Create: `src/sky-color-js.ts`（JS 总镜像，供测试与 bloom 预算用）
- Test: `src/sky-color-js.test.ts`（新）；回归：`src/sea/material.test.ts` 必须原样通过。

**Interfaces:**
- Consumes: Task 1 的 `SkyTrackState`/`rampColorJs`，Task 2 的 `energyRatioJs`/`preethamRadianceTsl`，`horizon.ts` 的 `horizonGlow`/`sunDisc`/`antiSolarCool`（**两个函数本任务都加可选参数**：`antiSolarCool` 加 `opts?: { awayGain: number; awayHeight: number }`、`horizonGlow` 加 `opts?: { pow: number; gain: number }`，默认取 `HORIZON`，现有调用与测试不动——轨道的 glowPow/glowGain 逐档变（120/0.42 → 150/0.45 → 180/0.06），只改 antiSolarCool 会让 glow 继续吃旧常量、镜像与 TSL 图失配；`horizon.test.ts:62-68` 的 FWHM 断言读模块常量，不受影响）。
- Produces:
  - `export function applySkyTrack(state: SkyTrackState): void`——把轨道状态写入 `sky-webgpu.ts` 模块级单例 uniform 节点组（dayStops/nightStops 各 4 个 vec3、away 色/增益/高度、glow pow/gain、sunTint、discGain、floor、preetham 4 参数、nightWeight、参考太阳方向与参考参数）。单例是刻意的：穹顶与海面两次调用 `skyColorTsl` 必须读到同一组 uniform，否则两侧漂移。
  - `skyColorTsl` v2 内部合成（签名不变）：

    ```text
    E     = P(dir, sun, pLive) / P(dir, sunRef, pRef)      // energyRatio，钳 [0,2]，只乘漫射项
    diff  = ramp(dayStops) → awayCool(轨道参数)            // 漫射项（ramp + 背阳降温）
    day   = diff · E + sunTint · (glow + disc)             // 直射项在 E 之外：vSunE 在 −2.31° 以下恒 0，
                                                           // 放进 E 会把过渡档余晖乘成 ≈1e−8（视觉为零）
    night = ramp(nightStops)
    C     = mix(day, night, nightWeight) + floorLinear
    ```

    参考档恒等的来源：nightWeight=0、E=1、轨道参数=现常量 → 与现实现逐通道一致。直射项移出 E 不破坏恒等：现实现本就是 `base + SUN_TINT·sunLight` 的相加形态（`sky-webgpu.ts:101`），参考档 E=1 时两种写法同值。
  - `src/sky-color-js.ts`: `export function skyColorJs(dir: Vec3, sun: Vec3, state: SkyTrackState, refSun: Vec3, refP: PreethamParams, includeDisc = true): Vec3`——上面合成的纯 JS 版（rampColorJs + antiSolarCool + horizonGlow/sunDisc + energyRatioJs 逐项对应 TSL 图；两边形状必须一致，这是防漂移的镜像契约，同 `horizon.ts` 现有约定）。第 6 参与 `skyColorTsl` 同名同义——日盘是天空专属特征，海面路径与 Task 5 的端点派生都传 `false`（否则 0° 档正对太阳的水平方向盘权重=1，0.35 的盘全额进海面端点，接缝反向翻亮）。

- [ ] **Step 1: 写失败测试** `src/sky-color-js.test.ts`：
  - **恒等测试**：内联重建旧公式（`rampColorJs(dirY, SKY_STOPS 线性值)` + `mix(base, AWAY_COLOR, antiSolarCool(cosAz, dirY, { awayGain, awayHeight }))` + `horizonGlow`/`sunDisc`/`sunTint` 相加——`AWAY_COLOR`/`SKY_STOPS` 直接 import，**禁止经过 `awayHorizonLinear()`**：那是海面端点、自带一次 AWAY_GAIN，`antiSolarCool` 权重里已含增益，混它等于 g²（`horizon.ts:124-127` docblock 警告的正是这个；端点差 ≈0.19·|HAZE−AWAY| ≈ 43 个 8bit 步长）），在 20+ 采样方向上与 `skyColorJs(dir, SUN_DIRECTION, skyTrackAt(REFERENCE_ELEVATION_DEG), SUN_DIRECTION, 参考参数)` 逐通道差 ≤ 1e-6。
  - **夜档形态**：`skyTrackAt(-8)` 下天顶亮度显著低于参考档天顶（比值 < 0.2），且**向阳与背阳地平线逐通道相等**（−8° 是纯夜：nightWeight=1 把 day 支路整支丢弃，输出恒等于 night ramp + floor——把「无方位残留」钉成断言，防将来把余晖断言错挂在这档）；**余晖（afterglow）断言挂 −4° 档**：`skyTrackAt(-4)` 下地平线向阳显著亮于背阳（直射项已移出 E，glow≈0.45·cos^150·sunTint 可测；nightWeight=0.7 只部分混入夜 ramp）。
  - **海面路径**：镜像按 `includeDisc=false` 调用与 true 只差 disc 项。
- [ ] **Step 2:** `npx vitest run src/sky-color-js.test.ts` —— 预期 FAIL。
- [ ] **Step 3: 实现** `applySkyTrack` + `skyColorTsl` v2 + `sky-color-js.ts` + `antiSolarCool` 可选参数；把 `sky-webgpu.ts:55` 的模块私有 `SUN_TINT` 删除，改为 import Task 1 加进 `palettes.ts` 的 `SUN_TINT_LINEAR`（顺手清掉旧技术说明 K2(c) 欠的「调色板之外的第二份太阳色」账）。
  - [ ] **Step 4:** `npx vitest run src/sky-color-js.test.ts src/sea/material.test.ts src/horizon.test.ts` —— 预期全 PASS（material 的签名 pin、horizon 的常量 pin 都不该动）。若此时可跑浏览器：拍参考档 before/after 冻结帧各一张，跑 max channel Δ ≤ 1（「参考档恒等」的像素门——镜像恒等测试只能证明两个 JS 函数一致，证明不了 GPU 前后一致）；跑不了则由 Task 8 Step 2 ③ 统一补。
- [ ] **Step 5: Commit** `feat(sky): skyColorTsl v2 — palette track over a reference-normalized preetham ratio`

### Task 4: bloom 预算测试 + `post.ts` 注释更新

**Files:**
- Test: `src/sky-color-js.test.ts`（追加用例）
- Modify: `src/post.ts:45-64`（仅注释与亮度表）

**Interfaces:**
- Consumes: Task 3 的 `skyColorJs`、Task 1 的 `skyTrackAt`、`horizon.ts` 的 `sunDirectionFromAzEl`。
- Produces: 无运行时接口；产出的是「换轨道参数前必须重跑」的预算测试。

- [ ] **Step 1: 写失败测试**（追加到 `sky-color-js.test.ts`）：对四个关键帧仰角加段内采样 3°、−2°，太阳取默认方位角（方位 = `atan2(SUN_POSITION[0], -SUN_POSITION[2])` 化成度，测试里由代码算出，不写字面量；`sun = sunDirectionFromAzEl(azDeg, el)`），在仰角 −2…40°、相对太阳方位 ±90° 网格（步长 2°/5°）上取 `skyColorJs` 的 Rec709 亮度（0.2126/0.7152/0.0722），**分两个量测**：① 非盘区（`includeDisc=false` 求值）峰值 < `state.bloomThreshold`；② 盘区（`includeDisc=true`，或直接取太阳方向 ±2.5° 锥内）峰值上界 ≤ 1.10——日盘有意越阈是 `post.ts` 既有设计（参考档实测 ≈1.03、网格点 el=6°/8° 方位 0° 处 ≈0.98–1.03），混在一个断言里必然逼着把参考档 glowGain 调暗、破坏恒等。
- [ ] **Step 2:** 跑测试 —— 预期非盘区断言可能 FAIL（夜档 floor 或 0° 档 glow 过亮），按失败档位回调该档 `glowGain`/`floorLinear`（只动 0°/−4°/−8° 档的轨道艺术值；**参考档列禁调**——`glowGain === HORIZON.GLOW_GAIN` 被 Task 1 测试与约束②双钉），直到 PASS；把最终值记录进进度段。
- [ ] **Step 3: 更新** `post.ts:45-64` 注释：写入新表（每档峰值），保留「动 GLOW_GAIN/DISK_GAIN/SKY_PALETTE.horizon 前必须重测」的警告，并加一句「轨道参数改动重跑 `sky-color-js.test.ts` 的预算用例即可」。
- [ ] **Step 4:** `npx vitest run` 全量 —— 预期 PASS。
- [ ] **Step 5: Commit** `test(sky): per-keyframe bloom budget pinned by the JS mirror`

### Task 5: 灯光、海面霾与云调色轨道化

**Files:**
- Modify: `src/lights.ts`、`src/sea/material.ts`（`seaHazeTsl` 约 388–408 行的端点）、`src/horizon.ts`（`seaHazeTargetLinear` 加可选端点参数）、`src/sky-color-js.ts`（新增端点派生函数）、`src/puff-cloud.ts`（`PUFF_BAND_COLORS` 四档带色与 `HAZE_COLOR` 空气透视色改 uniform 并 import palettes 单源——修「夜档黄昏云」：方向本来就每帧跟随活太阳，颜色却是写死的黄昏暖色）
- Test: Create `src/lights.test.ts`（`initSunsetLights` 现在从未被测过，此文件不存在）；`src/sea/material.test.ts`（回归 + 追加同源性断言）；`src/puff-cloud.test.ts` 追加调色 setter 用例（若该文件不存在则新建）

**Interfaces:**
- Consumes: Task 1 的 `SkyTrackState`（灯光字段），Task 3 的 `skyColorJs`。
- Produces:
  - `lights.ts` 返回值增加 `setSunLook(colorCss: string, intensity: number): void` 与 `setAmbience(skyCss: string, groundCss: string, intensity: number): void`（改现有 DirectionalLight/HemisphereLight 对象，不新建）。
  - `sea/material.ts`：`seaHazeTsl` 的两个端点（`cssToLinear(HAZE_COLOR)` 与 `awayHorizonLinear()`）改为 uniform 节点，默认值 = 现常量（图默认状态与今天一致）；海面 handle 增加 `setHazeTargets(hazeLinear: Vec3, awayEdgeLinear: Vec3): void`。
  - `horizon.ts`：`seaHazeTargetLinear(cosAz: number, endpoints?: { haze: Vec3; awayEdge: Vec3 })`——可选参数缺省走现路径，现有测试不动。
  - `sky-color-js.ts`：`export function seaHazeEndpoints(state: SkyTrackState, sun: Vec3, refSun: Vec3, refP: PreethamParams): { haze: Vec3; awayEdge: Vec3 }`——在两个标准地平方向上求值 `skyColorJs`（`dirY = 0`：一个正对太阳水平方位，一个背对；**两处都传 `includeDisc=false`**——0° 档太阳嵌在地平线上，正对太阳的水平方向盘权重=1，0.35 的盘全额进端点会让海天接缝反向翻亮），返回作为海的霾端点。**这是 Global Constraint 5 的落地**：端点来自镜像本身，能量场的方位变化自动包含在内，不会与 away 权重双重建模。（Task 1 的 `state.hazeLinear`/`awayEdgeLinear` 自本任务起只作参考档恒等的遗留字段，运行时改用本函数；接口注释写死这一条。）
  - `puff-cloud.ts`：handle 增加 `setCloudPalette(bands: readonly Vec3[], haze: Vec3): void`——四档带色与空气透视色各改 uniform（建一次、默认值 = 现常量，图默认状态与今天一致）；Task 7 每帧随轨道灌入。

- [ ] **Step 1: 写失败测试**：lights 两个 setter 改值生效（新建的 lights.test.ts）；**同源性测试**（Review Focus 1）：对 `state = skyTrackAt(el)`、el ∈ {6.97, 0, −4, −8}，断言 `seaHazeEndpoints` 的两个端点与 `skyColorJs` 在对应标准方向的输出逐通道相等（≤1e-6，构造上恒真，钉住的是「谁派生谁」）；再断言中间方位（相对太阳 90°）上 `seaHazeTargetLinear(cosAz, endpoints)` 与镜像边缘色的 Rec709 亮度差 ≤ 实测值 + 0.01（2 端点线性 mix 对物理方位曲线是已知近似，实测差记入进度段并 pin 住，不许无声放大）；material.test.ts 现有 pin 回归——注意它有**两条**源码 pin：90 行的调用签名、91 行要求 material.ts 保留 `awayHorizonLinear` 标识符、130 行禁止 `HORIZON.AWAY_GAIN` 字面量——端点改 uniform 时默认值表达式必须原样保留 `awayHorizonLinear()` 调用，不要内联混色；**云调色 setter**：`setCloudPalette` 写 uniform 后 TSL 采样用新色，默认值与现常量恒等。
- [ ] **Step 2:** 跑测试 —— 预期 FAIL（setter/端点不存在）。
- [ ] **Step 3: 实现。** TSL 侧注意 Constraint 8（函数形式 mix）；uniform 命名沿用文件内现有风格。**端点 uniform 建一次、四个 ring 共享**：在 `initSea` 里创建两个共享 uniform（与 `sunU` 同一传参位置随 opts 传进 4 次 `buildSeaMaterial`），`setHazeTargets` 原地写值即四个 ring 同时生效，不为每环各建一份。**且必须每帧真的调**：`sunU = uniform(opts.sunDirection)`（`material.ts:282`）今天靠「太阳不动」才显得正确（`lights.setSunDirection` 是 copy 出去、`world.ts:201-202` 归一化的是另一个局部向量），不要复制这个隐性假设——Task 7 Step 3 第 5 步每帧写端点；测试钉法：改端点 uniform 后不重建材质，采样路径读到新值。
- [ ] **Step 4:** `npx vitest run src/lights.test.ts src/sea/material.test.ts src/horizon.test.ts` —— 预期 PASS。
- [ ] **Step 5: Commit** `feat(sky): haze, light rig and cloud palette follow the sky track`

### Task 6: 星点层 `stars.ts`

**Files:**
- Create: `src/stars.ts`
- Modify: `src/far-field.ts`（拖动结构从单对象改多对象：`SKY_NAMES` 扩为 `['sky_sunset_tsl', 'sky_stars']` 且 `update()` 对名单里**每个命中的对象各搬一次**——现在的 `findFirst` 命中即返回、`update` 只搬一个对象，往名单加名字不会让星点被搬；`followed` 汇报改数组形如 `{ towed: string[] }`；`far-field.test.ts:27` 的深等断言同步改为「穹顶与星点两个对象的 position 都等于相机 x/z」）
- Test: `src/stars.test.ts`

**Interfaces:**
- Produces: `export function initStars(scene: import('three').Scene): { setOpacity(o: number): void; dispose(): void }`。实现要点：`THREE.Points`，约 900 个点均匀撒在半径 780 的上半球（`y > 0.03·r`，穹顶 800 之内），`PointsMaterial({ size: 1.8, sizeAttenuation: false, color: '#b9c6ff', transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, fog: false })`，`renderOrder = -999`（穹顶 −1000 之后、云之前），`frustumCulled = false`，mesh name 取 `'sky_stars'`。几何用种子化随机（mulberry32 或等价），保证采集协议可复现。星色压到 `#b9c6ff`（线性 Rec709 ≈0.578，对 0.82 余量充足；原拟 `#dfe6ff` 是 0.795、余量仅 3.2%，AdditiveBlending 下星点相互重叠再叠夜空 floor 必越阈——压色、size 提到 1.8 补回感知亮度；`sky-color-js.test.ts` 的预算用例不含星点，由本任务测试单独钉住）。**`fog: false` 必须显式写**：r186 线性雾是 smoothstep，780 m 处雾因子满格，不关会把 900 个点整层染成 `#c96a7a`（仓库其余背景材质全关了雾，星点是唯一漏网）。**必须随 far-field 拖动**：飞机是无限直线飞行，穹顶靠 far-field 每帧重新对齐相机才不脱世界；星点同量级半径（780 对 800），不拖同样约十秒后留在身后消失。实现按本任务 Files 的结构改造（名单扩容 + 遍历搬动）——只把名字塞进 `SKY_NAMES` 而不改 `findFirst` 命中即返回的结构，星点永远轮不上被搬，而现有测试照旧全绿（2026-11-08 元核查 B4 实锤的假绿路径）。

  - [ ] **Step 1: 写失败测试**：setOpacity 钳制 [0,1]；init 后 scene 里多一个 Points、dispose 后移除且几何/材质 dispose 被调；两次 init 的顶点位置逐位一致（种子化）；`(points.material as THREE.PointsMaterial).fog === false`；`srgbToLinear('#b9c6ff')` 的 Rec709 亮度 < 0.72；far-field 行为断言：init 星点后跑 `update()`，穹顶与星点**两个对象**的 position.x/z 都等于相机（B4 的结构改法，不是「源码含字面量」的 pin）。
- [ ] **Step 2:** 跑 —— FAIL。
- [ ] **Step 3: 实现**（含 far-field 多对象拖动改造，见 Files 一节的写法）。
- [ ] **Step 4:** `npx vitest run src/stars.test.ts src/far-field.test.ts` —— PASS。
- [ ] **Step 5: Commit** `feat(sky): seeded star dome with track-driven opacity`

### Task 7: 接线：main / DUSK_BAND 解除 / in-cloud 纱色 / puff 太阳对账

**Files:**
- Modify: `src/main.ts`（141–152 的 `?sun` 解析与 stepFrame 240–260 段）、`src/horizon.ts`（`clampSunElevation` 停用路径）、`src/in-cloud.ts`（48–62 纱色端点）、`src/game.ts`（纱色端点透传，走现有 sunDir opts 通路）、`src/world.ts`（把 `puffs.setCloudPalette` 句柄转发给 main，若 puff 句柄未直出）
- Test: `src/in-cloud.test.ts`、`src/game.test.ts`、`src/horizon.test.ts`（按实际 pin 更新，更新必须注明「DUSK_BAND 被轨道取代」）

**Interfaces:**
- Consumes: Task 1 `skyTrackAt`、Task 3 `applySkyTrack`、Task 5 灯光 setter、海面 `setHazeTargets` 与 `sky-color-js.ts` 的 `seaHazeEndpoints`、Task 6 `initStars`。
- Produces: 无新接口；本任务把每帧管线接起来。

- [ ] **Step 1: 写失败测试**（能测的部分）：`in-cloud` 纱色端点可注入（不再只读本地常量），注入后 `veilTintCss` 用新端点插值。
- [ ] **Step 2:** 跑 —— FAIL。
- [ ] **Step 3: 实现**，每帧顺序（`stepFrame` 内、现有 `lights.setSunDirection`/`skyTsl.setSunDirection` 之后）：
  1. `el = asin(clamp(liveSunDir.y, -1, 1)) * 180 / Math.PI`；
  2. `state = skyTrackAt(el)`；
  3. `applySkyTrack(state)`（穹顶与海面共用单例）；
  4. `lights.setSunDirection(liveSunDir)`（现句保留，**灯的仰角单独钳 ≥ +2°**：`?sun` 不再走 `clampSunElevation` 后 −8° 直接生效，`lights.ts:30` 的 `position = dir × 288.5` 会把灯压到地平线下约 40 m、方向光从下往上打；钳位后颜色强度交给轨道 `sunLight` 字段）+ `setSunLook/setAmbience(state)`；
  5. `{ haze, awayEdge } = seaHazeEndpoints(state, liveSunDir, 参考方向, 参考参数)`；`sea?.setHazeTargets(haze, awayEdge)`；
  6. `stars.setOpacity(state.starOpacity)`；
  7. in-cloud 纱色端点在**启动时**随轨道注入（game 的 opts 是 init 快照不是逐帧通路：`game.ts:409` 只在构造时把 sunDir 归一快照一次；本计划内太阳不在会话中移动，启动注入够用。若改调用形态，`game.test.ts:17` 用正则钉死了 `hud?.setWhiteout(whiteout01(camCloud01), veilTintCss(fwdDotSun))` 原文，必须同步更新该 pin 并注明原因）。注入前做**线性转 sRGB 字节回转**（或轨道直接存 CSS 字符串给 DOM）：`veilTintCss`（`in-cloud.ts:53-66`）在 sRGB 字节空间 floor 插值并按 1/64 量化——线性 Vec3 直灌会偏暗约 48/255，不缩放直接灌会被 `Math.floor` 截成全黑；非有限回退色 `#e7d7cf` 一并换轨道值。
  8. `puffs.setCloudPalette(state.cloudBands, state.cloudHaze)`（句柄经 `world` 转发；参考档值 = 现常量，恒等不受影响）。

  `?sun=az,el` 不再调 `clampSunElevation`（函数保留导出，注释标明被轨道取代；`horizon.test.ts` 里 pin 它行为的用例改为 pin「主路径不再调用」或删除，注明原因）。`puff-cloud.ts:83` 静态 `_sun` 已对账定性：只作 `sunUniform` 初始种子，活方向由 `world.ts:200` 每帧从灯光位置反推、经 204 行 `puffs.update(time, sunDir)` 灌入（`puff-cloud.ts:383-387` copy 进 uniform）——云的向阳**方向**本来就跟随活太阳；**颜色**自 Task 5 起由轨道灌入（修 M4「夜档黄昏云」），结论记进度段。
- [ ] **Step 4:** `npx tsc --noEmit` + `npx vitest run` —— 全 PASS。
- [ ] **Step 5: Commit** `feat(sky): wire the day-night track through sun, lights, sea haze, stars and veil`

### Task 8: 采集验收与新基线

**Files:**
- Modify: `artifacts/cloud-audit/audit.py`：① 接受 `--baseline <path>`（默认现路径 `protocol/baseline-content-anchored.json`，行为不变）；② `parity()` 重写——按 `pair` 名匹配，先断言两侧 pair 数与键集合相等（现实现 zip 按位配对 + 只遍历新键：pair 增删静默截断、基线多出的键被跳过、新 pair 永不进闸门），数值阈值按量纲分组（L\*/C\* 类 |Δ| ≤ 0.5、比值类 ≤ 0.01、布尔/行数全等），不再拿 1e-6 全等冒充「LSB」；③ 新增 `--night-baseline` 门，对 `night-baseline.json` 走同样比较——否则新基线文件没有任何工具会去校验
- Modify: `artifacts/cloud-audit/states.py`（纳入三个夜间状态；**注册状态只改这一个文件**——`color_sample.py:40-41` 的 CASES 由它派生）、`artifacts/cloud-audit/color_sample.py`（只**新增**冷带/全天 L\*/C\* 指标，不动 CASES 逻辑）
- Create: `artifacts/cloud-audit/protocol/night-baseline.json`（新状态 pin）
- Modify: 本文档进度段、`2026-10-31-sky-technical-note.md`（追加「2026-11-08 混合模型」小节）

- [ ] **Step 1:** 全矩阵：`npx tsc --noEmit`、`npx vitest run`、`node scripts/smoke.mjs`。
- [ ] **Step 2:** **先重采现有状态，再跑 parity**——parity 量的是磁盘 PNG（ref-\*.png vs protocol/\*-alt\*.png），改完天空代码后不重采就跑只是在给旧截图验尸。按序执行：① 重采前先把当前 4 个状态各存一张 `protocol/before-daysky-*.png`（照 `A-cruise-alt60.before-palette.png` 先例）；② 按采集协议（`?qa=frozen` + `qa.step` 定步、隐藏 HUD、present 双 rAF）重采 4 个现有状态（默认太阳 = 参考档）；③ **参考档恒等的像素门**：用 `compare_repeats.py` 同款脚本对 before/after 跑 max channel Δ——除海面向阳霾端点的有意 Δ（约束①例外）外，其余像素差 ≤ 1，超出的区域打印 mask 存档；④ `python artifacts/cloud-audit/audit.py --parity`：覆盖 **3 个 ref pair（A-cruise/B-dive/C-bankdive，共 102 pin；D-skim 无参考图不进 parity）**——sea 块因约束①例外预期 FAIL，属预期：用 `audit.py --json` 的 pairs 段**整份重生成**基线并 `--baseline` 指过去（没有「逐 pin 重钉」的工具路径），before/after Δ 与重生成 diff 记进度段；重生成后再跑一次必须全 PASS，仍 FAIL 停下查 TSL 图与镜像是否失配；⑤ Step 4 生成夜间基线后过 `--night-baseline` 门。
- [ ] **Step 3:** 新夜间冻结状态按采集协议（`docs/superpowers/plans/2026-10-31-capture-protocol.md`：`?qa=frozen` + `qa.step` 定步、隐藏 HUD、present 双 rAF）采集三档：`?sun=<默认方位角>,0`、`?sun=<默认方位角>,-4`、`?sun=<默认方位角>,-8`（方位角代码里从 `SUN_POSITION` 算出，不写字面量）。每档独立加载两次 PNG 逐字节一致后才测指标。
- [ ] **Step 4:** 夜档指标与基线：`color_sample.py` **新增**冷带/全天 L\*/C\* 指标——现有 warm_sky 过滤（hue 5–70 & s>0.10 & v>0.45，`color_sample.py:55-57`）对夜档 navy 全部返回 None，拿不到 L\*/C\*；注册状态走 `states.py`（CASES 自动跟上）。参考档暖带 C\*med 不得劣化（≥ Task 0 记录的基线 − 0.5）；夜档 sky/海带中位 L\*/C\* 与颜色写入 `night-baseline.json`，并过 `audit.py --night-baseline` 门（必须可跑且 PASS——否则夜间 pin 没有任何闸门）。
- [ ] **Step 5:** 目检五项：① 太阳 7°→−8° 扫过时海面反射同步变暗、太阳光路消失、霾转夜色；② 0°/−4° 过渡带海天接缝无横向色带（已知非本次范围：外环 1900 m 以外的穹顶窄条是几何残差）；③ 夜档无全屏 bloom（只有星点核闪）；④ 星点仅在太阳低于约 −3° 后可见；⑤ 夜档云不得明显亮于夜空地平带（近云带 vs 夜空地平带的 Rec709 亮度对比给出实测值；参考档海面向阳端点的变化属约束①例外，一并目检确认无色带）。
- [ ] **Step 6:** Commit `docs(sky): night acceptance baselines and the hybrid-model note`

## 验证（整体验收 = Task 8 的 Step 1–5）

跑不了浏览器时的最低替代：Task 1–4 的纯 JS 测试（恒等、预算、夜档形态）+ `tsc` 全绿即可交付审查；浏览器采集与目检在下次可跑环境时补。

## 明确不做（第二步另立计划）

白天/黎明档关键帧、月亮与月相、canvas 回退的轨道化（保持参考档静态）、puff 云模型/形状改动（调色已并入 Task 5：方向本来就活，颜色自 Task 5 起随轨道）、tone mapping 调整、比率场预烘 LUT 优化（每像素两次 Preetham 求值若帧计时超标再议）。已知残留：`main.ts:57-58` 的兜底背景 `#a86a86` 与 `scene.fog = Fog('#c96a7a', 60, 700)` 保持 dusk 值（海/天穹/云材质都 `fog = false`，fog 主要波及开着 fog 的飞机材质）——夜里这两处不变是已接受的残留，第二步收编。

---

## 进度与批次记录

| 日期 | 批次 | 结果 | 提交 |
|---|---|---|---|
| 2026-11-08 | 计划写成 + 自审（6 处修订）+ 独立代码对照审查（12 处发现全部修入） | 待用户审 | 未提交（等审核通过） |
| 2026-11-08 | 元核查修订入文：合成式直射项移出 E、恒等重建改混向 AWAY_COLOR、bloom 拆非盘区/盘区、far-field 多对象化、星点 fog:false + 压色 `#b9c6ff`/size 1.8、约束①开海面例外并改 3 pair 口径、skyColorJs 加 includeDisc、云调色并入 Task 5、parity 重写 + 夜基线门 + 像素门、灯仰角钳 ≥+2°、ramp 四分点断言、T7/T9/T10/T11 修正（详见审核报告勘误段） | 待用户审 | 未提交 |
| 2026-11-08 | **Task 0 开工对账（执行批）**：① 工作树干净——开工前两笔清桌提交 5b36e23（11-08 联动修复批次，sun-state.ts 等）/ 034bd6e（sun-road v2 计划+评审+取证帧+INDEX 登记）；仅剩 git-ignored `.workbuddy/` 与无关 untracked `artifacts/sea-audit/`（删海时代遗物，不属本计划）；注意：联动批次改过 `main.ts`/`far-field.ts`/`sea/material.ts`/`sky-webgpu.ts`/`world.ts`，Task 3/5/6/7 的行号以当前代码对账为准。② `npx vitest run` 41 文件 / 342 用例全绿（基线）。③ color_sample 参考档暖带基线（Task 8 判据用）：A-cruise L\*med 73.4 / C\*med 32.0，B-dive 68.4 / 21.3，C-bankdive 59.5 / 37.7，D-skim 75.2 / 34.4 | PASS | —（Task 0 无提交） |
| 2026-11-08 | **Task 1 sky-track**：13 新用例（参考档恒等 ×6、srgbToLinear vs THREE、lerp 线性空间中点、段外钳制 ×2、rampColorJs 端点+四分点）；全量 355/355、tsc 干净。艺术值调整：无（关键帧表按计划原样落地；0° 档 nightStops = −8 键 ×0.3 线性、−8 档 dayStops 沿用 −4 值不新造色）。执行裁定：sunLight/hemi 的 CSS 字段按「解码→线性插值→再编码」插值（纯字符串没法插值，再编码对字节值与 srgbToLinear 精确互逆，关键档逐字保留） | PASS | 2d7b1a3 |
| 2026-11-08 | **Task 2 sky-preetham**：6 新用例（恒等 25 方向 ===1、过零扫描有限性+值域、地平线向阳/天顶单调、0° 实测记录、真 three/tsl 冒烟）；全量 361/361、tsc 干净。实测记录：0° 档地平线向阳 lum 4.52e-1（rgb [1.95, 5.3e-2, 8.0e-4]，物理回弹成立、r 通道超 1 由比率钳 [0,2] 吸收）、天顶 1.60e-2；−4° 档 2.70e-4 > −8° 档 2.69e-4（单调成立，差距仅 0.3%——比计划预估的 1.44e-6/6.12e-7 大两个量级且接近，断言仍真；计划数值口径疑为原始 P 而非 Rec709 亮度，不影响判据）。防御性偏差：zenithAngle 的 acos 入参加 min(·,1) 上钳（归一化 y 可舍入到 1+ε 使 acos NaN，源码 max(0,·) 意图不变） | PASS | 9d30518 |
| 2026-11-08 | **Task 3 skyColorTsl v2 + JS 总镜像**：5 新用例（旧公式恒等 54 方向 true/false 两口径 ≤1e-6、−8° 天顶比 <0.2、−8° 无方位残留逐通道相等、−4° 余晖 >+0.02、includeDisc 差=盘项 + 盘外逐位）；material.test.ts/horizon.test.ts 既有 pin 原样通过；全量 367/367、tsc 干净。**艺术值裁定（计划自相矛盾）**：计划给的 floorLinear（0° [0.002,0.002,0.005] / −4° [0.004,0.005,0.012] / −8° [0.006,0.008,0.018]）使 −8° 夜天顶达参考档的 0.266×，破计划自己的 <0.2 断言（floor 占夜天顶亮度 66%，两处没对账）——断言是 Review Focus 契约、floor 是计划明示可调艺术值，取 floor 降为 0° [0.001,0.0015,0.003] / −4° [0.0015,0.002,0.004] / −8° [0.002,0.0025,0.005]（单调保持，夜天顶比 0.145）。执行裁定：sunTint 经轨道 uniform 进图（seed = 参考档），sky-webgpu 不再 import SUN_TINT_LINEAR（无第二副本，优于计划的「改为 import」字面）；linearFromCss 随 v1 图一并删除（canvas 兜底用 CSS 原文不受影响）。若浏览器可跑的像素门（max channel Δ≤1）由 Task 8 Step 2 ③ 统一补 | PASS | bcc5a77 |
| 2026-11-08 | **Task 4 bloom 预算**：预算用例 ×2（6 档状态 × 网格 仰角 −2…40°步 2° / 相对方位 ±90°步 5° = 814 方向）——非盘区峰值全 <0.82：−8° 0.0335 / −4° 0.0891 / −2° 0.1759 / 0° 0.3005 / 3° 0.4641 / 参考 0.7428；盘区峰值全 ≤1.10：0.0335 / 0.0891 / 0.2368 / 0.5030 / 0.6494 / 0.9515。**计划预期的「0° 档 glow 过亮」未发生**（E 比率在 0° 档未钳到 2），无需回调任何艺术值。post.ts:45-64 注释换新表 + 轨道参数改动重跑预算的警告；全量 369/369、tsc 干净 | PASS | 331d2f8 |
| 2026-11-08 | **Task 5 灯光/海霾/云调色轨道化**：7 新用例（lights 默认值 pin + setter ×2 + 行为、海霾端点同源 ×3、puff 调色 ×2）；material.test.ts 三条既有 pin（签名/awayHorizonLinear/禁 AWAY_GAIN 字面量）原样通过；全量 377/377、tsc 干净。实测钉值：**中间方位（相对太阳 90°）2 端点线性 mix 与物理方位曲线的 Rec709 亮度差** 逐档 = 参考 0.0787 / 0° 0.1663 / −4° 0.0281 / −8° 0（0° 档主导：太阳嵌在地平线上时 E 场方位变化最陡）——计划明示的已知近似，pin 在 material.test.ts（MID_AZIMUTH_MEASURED 0.167，上限 +0.01，恶化即红）。执行裁定：puff 调色的「TSL 采样用新色」在 node 无法真采样，钉法 = source pin（uniform 节点 + setCloudPalette 存在）+ 行为 no-throw，真实换色由 Task 8 目检⑤兜底 | PASS | 8435ac8 |
| 2026-11-08 | **Task 6 星点层 + far-field 多对象拖动**：6 新用例（Points 存在/dispose spy/setOpacity 钳制/种子逐位一致/材质参数+fog:false+半径与 y 下界/星色亮度 <0.72）+ far-field 行为断言（两对象同拖 + towed 数组形）；far-field.test followed 断言同步改 `{ towed: [...] }`；world.test 12 用例回归绿；全量 383/383、tsc 干净。种子 20261108（mulberry32）；星点 900 颗 r=780、y>0.03r。far-field 实测确认计划预判：findFirst 命中即返回的结构下往 SKY_NAMES 加名字确实不会让星点被搬——已按名单遍历改造 | PASS | 8285e9c |
| 2026-11-09 | **Task 8 采集验收与新基线（执行批）**：① Step 1 全过（tsc/build/smoke，vitest 385/385）。② 像素门：**10-31 老协议帧不能当 before**（混入 8 天改动，max Δ220）——改用 worktree @034bd6e（本任务开工前一刻，含联动修复）重拍真 before 帧；结果 **天空 0px 差、云 ≤1（A/D 的 17-18% 云带差异经行剖面定位为 0.38-0.42 远海霾带，非云）**；海面沿约束①例外偏移（向阳霾端点补 glow：远海 max 8 字节向相机衰减），diff mask 存档 identity-diff-*.png。**执行裁定：计划的 Step 2 ①「先把当前 4 个状态存 before-daysky-*.png」按字面执行会拿到 10-31 老帧，已按裁定换成 worktree 真 before**。③ parity：初跑响亮拦下键集漂移（10-31 基线 sea 块只有 usable/reason 两键）→ 按计划整份重生成基线（3 pair/110 钉值）→ 重跑 **PASS**；audit.py parity 按量纲分组容差重写（L*/C* ±0.5、比值 ±0.01、布尔/行数全等）+ 按对名匹配 + 键集断言 + `--baseline`/`--night-baseline` 门 + json 先于门落盘。④ 夜档三态 N-dusk/N-civil/N-night（A-cruise 机位、?sun=12.09,{0,-4,-8}）采集，**三次独立加载逐字节一致**；night-baseline.json 生成后 `--night-baseline` **PASS**（45 钉值）。⑤ color_sample 新增冷带/全天 L*/C*：夜档 L* 5.5-10.0 / C* 25.1-28.8（暗而不黑），参考档暖带 C*med 32.0 vs Task 0 基线 32.0 **无劣化**。⑥ 目检五项全过：光路 0° 有金路→−8° 消失、接缝无横向色带、夜档 blown% 0.0（昼 15.7 属有意盘区）、星点 opacity 0/0.35/1 且 −8° 帧清晰可见、夜云暗于夜空地平带 −5.4~−38.9（Rec709 p50）。 | PASS | 待提交 |
| 2026-11-09 | Task 8 附注：像素门的 5 颗 D-skim 天空散点（>1）为日盘边缘 AA，不计；`?sea=nochop` 等海面钩子与本计划无关。 | — | — |
| 2026-11-08 | **Task 7 接线**：main.syncSun（版本门控）= 仰角 → skyTrackAt → applySkyTrack → setSunLook/setAmbience → seaHazeEndpoints → setHazeTargets → stars.setOpacity → setCloudPalette；灯仰角独立钳 ≥+2°；in-cloud 纱色端点启动注入（模块级 setter + 线性→byte 回转 + 非有限回退色随端点）；world 加 setHazeTargets/setCloudPalette 透传；sun-state.setAzEl 停用 DUSK_BAND 钳制（horizon.test 的 clampSunElevation 纯函数 pin 保留、sun-state.test 钳制 pin 改写并注明「DUSK_BAND 被轨道取代」）。4 新用例（veil 注入 + world 透传 + sun-state 去钳）；全量 385/385、tsc 干净。**对账说明**：钳制实际住在 sun-state.setAzEl（联动批次迁移过），计划写的 main.ts 141–152 行号已漂移——以现状为准；game.ts 未改（纱色走模块级 setter，game.test.ts:17 的调用形态 pin 不受影响，优于计划的「透传 game opts」方案） | PASS | 0079d53 |

（每完成一个 Task 追加一行：Task 号、验收结果、提交哈希、艺术值调整记录。）
