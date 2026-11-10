# 调色 Debug 面板（`?debug=color`）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给日夜轮换与海天调色一套 dev-only 屏上调色板：太阳仰角 scrub＋关键帧一键跳＋sunspin 播放、
轨道字段覆盖、海霾端点锁定＋快捷按钮、当前状态一键导出为可复现命令。默认出货路径零变化。

**Architecture:** 三层。① `qa` 层（`__porco.qa`，无 DOM，可 pin 可测）：
`setTrackPatch(patch|null)`、`lockHaze(on)`、`exportColorState()`；
② `syncSun` 两个 merge 点（`main.ts` 内 `syncSun` 函数，闭包 `let lastSunVersion` 约 L267，以 `grep 'let lastSunVersion' main.ts` 定位）：`skyTrackAt(el)` 后合 patch、
`setHazeTargets` 前检查 haze 锁；③ 表现层 `src/debug/color-panel.ts`，
只在 `?debug=color` 时动态 `import()`，面板每个动作调用 qa 层函数并回显等价控制台命令。

**Tech Stack:** TypeScript + 裸 DOM＋内联样式（不引入第三方，不用 lil-gui）+
vitest（源码 pin 延续仓库既有 tripwire 风格）+ 浏览器人工目检。

**Spec:** 调研 [`2026-11-09-debug-color-ui-research.md`](2026-11-09-debug-color-ui-research.md)
（§2 参数清单、§5 红线）。背景：昼夜计划
[`2026-11-08-day-night-sky.md`](2026-11-08-day-night-sky.md)、
`syncSun` 管线、qa 杠杆（均在 `main.ts` 内，行号漂移，以 Task 0 对账为准；`qa.ts`）。

## Global Constraints

1. **默认路径逐位一致**：无 `?debug=color` 时不 import、不建 DOM；空 patch（null）与未锁定 haze 时
   `syncSun` 行为与今天完全一致。`applyTrackPatch(state, null) === state`（引用相等）钉死。
   **版本门控绕过方案**：`syncSun` 门控 `if (sun.version === lastSunVersion) return` 会吞掉不碰 sun 对象的 patch 变更——
   需在 main.ts 闭包层新增 `patchVersion/lastPatchVersion` 与 `hazeLockVersion/lastHazeLockVersion` 两组计数器，门控改为
   `if (sun.version === lastSunVersion && patchVersion === lastPatchVersion && hazeLockVersion === lastHazeLockVersion) return;`
   三条件同时满足才跳过。`setTrackPatch` 递增 `patchVersion`，`lockHaze` 递增 `hazeLockVersion`。
   原 `sun.version` 逻辑不变，patch/haze 两计数器并行——这是 `setSun`（先 `sun.setAzEl` 间接 bump 版本）与
   patch 路径（不碰 sun 对象）之间的对称性补全。
2. **参考档恒等不容碰**：patch 只改非参考档外观；现有恒等/parity/bloom 测试原样全绿。
3. **不新增依赖**：`package.json` 不动；面板只用 DOM＋现有模块（`srgbToLinear`、`skyTrackAt` 类型）。
4. **颜色空间**：面板拾取的 sRGB hex 进 TSL 前走 `srgbToLinear` 线性解码（约束⑨）；
   回显 byte 走共享 `linearToByte(v: Vec3): [number, number, number]`（Task 1 在 `sky-track.ts` 新增并导出，
   与既有 `linearToSrgbCss`（`:93`，未导出、返 hex 串）同公式——`linearToSrgbCss` 改为复用它；
   `in-cloud` 的局部 `toByte`（`:62-66`，闭包内 lambda）不导出、不复用）。禁止线性 Vec3 直灌 DOM／面板。
5. **禁区不暴露**：bloom 阈值 0.82 只读展示＋警告；`amplitudePeak`（存在于 `CASCADES[0].amplitudePeak`，非顶层 export）不进面板；
   海常量只读展示（不放滑杆）：`SUN_ROAD`（`src/sea/sun-road.ts`，对象含 WIDTH_DEG/ROAD_FLOOR/ROAD_PEAK/BASE 等）、
   `CREST_REFERENCE_METRES`（`src/sea/water-shading.ts`）、`CHOPPINESS`（`src/sea/fft-gpu.ts`）、
   `K4_MARGIN`（`src/sea/sun-road.ts`，与 bloom 阈值有契约）、`CASCADES`（`src/sea/cascades.ts`）、
   `RINGS`（`src/sea/rings.ts`）、`SEA_BAND_THRESHOLDS`（`src/sea/bands.ts`）、
   `SEA_FOAM_THRESHOLD`（`src/sea/foam.ts`）、`WATER_OPTICS`（`src/sea/water-shading.ts`）。
   不存在的常量（原文档 SLOPE_GAIN / fineCrestMetres）已替换为上述真实 export 项。
6. **可复现闭环**：面板调出的任何画面，一条命令能重放（`exportColorState` 导出 `?sun=`＋patch JSON＋控制台命令）。
7. **模块图纪律**：`module-graph.test.ts:13` 的 `import.meta.glob('./*.ts')` **只扫 src 根目录**，
   子目录（`src/debug/`、`src/sea/`）天然豁免——面板放 `src/debug/color-panel.ts` 不会被扫到。
   启动块（main.ts，src 根）里的动态 `await import('./debug/color-panel')` 不是 three/webgpu import，
   完全合规。Task 0 仍需确认扫描边界以防未来 glob 模式变化。
8. **仰角 scrub 范围 −8°…＋15°**：轨道只定义到参考 6.97°，超出段按 `skyTrackAt` 现有钳制语义（段外钳端点），
   面板注明"＞6.97°＝参考档"，不扩展轨道。

## Review Focus

1. **空 patch 非恒等**：merge 实现若深拷贝／重算导致浮点漂移，参考档恒等测试会红——用引用相等＋非 null patch 逐字段 ≤1e-6 双钉。
2. **patchVersion 门控不被吞**：`setTrackPatch` 调后画面必须立即更新，不能被 `syncSun` 的 sun.version 门控跳过——
   源码 pin：main.ts syncSun 开头必须出现三条件门控 `sun.version === lastSunVersion && patchVersion === lastPatchVersion && hazeLockVersion === lastHazeLockVersion`。
3. **haze 锁忘解锁**：锁定时太阳再转海霾不跟，画面出现"天转海不转"——面板锁定时必须有可见指示（按钮高亮＋console.warn），
   且 `exportColorState` 必须包含锁状态。
4. **动态 import 失败白屏**：import 失败必须 catch＋console.error＋面板不建，游戏本身不受影响。
5. **sRGB/线性双重转换**：颜色拾取→解码→uniform→回显 byte，任一环节错位都会偏色——用往返测试钉（hex→linear→byte＝原值，落 `src/sky-track.test.ts`，走 `linearToByte`）。
6. **出货包体积**：`npm run build` 后确认面板 chunk 独立、默认入口不含面板代码（构建日志抽查）。

---

### Task 0: 开工对账

**Files:** 无（只读检查）

- [ ] `git status` 对账：工作树干净（`353abdf` 等 6 提交已落库），结果记进度段。
- [ ] `npx vitest run` 全绿基线（47 文件 / 405 用例）＋`npx tsc --noEmit` 干净。
- [ ] 读 `module-graph.test.ts` 确认扫描范围：`src/debug/` 是否在禁区内、动态 `import()` 是否豁免；结论记进度段，
  决定面板文件放 `src/debug/color-panel.ts` 还是其它豁免路径。
- [ ] 对行号：`main.ts` syncSun（~260-296）、qa 挂载（~352-399）、`qa.ts` 解析器现状；漂移则以现状为准。

### Task 1: qa 层三个无 DOM 函数

**Files:**
- Modify: `src/sky-track.ts`（新增 `DebugTrackPatch` 类型＋`applyTrackPatch` 纯函数＋`linearToByte` 导出）
- Modify: `src/main.ts`（qa 对象加 `setTrackPatch/lockHaze/exportColorState`，syncSun 加两处 merge 点——
  patch 合并放 Task 2，此任务只加函数骨架与状态位？不：一次做完，测试一次钉死）
- Modify: `src/qa.ts`（新增 `parseDebugColor(raw)`：`?debug=color` 真值表）
- Test: `src/qa.test.ts`（`parseDebugColor`）、`src/sky-track.test.ts`（`applyTrackPatch`）＋ main 源码 pin（`sky-sun-sea-linkage.test.ts` 追加）

**Interfaces:**
- `export type DebugTrackPatch = Partial<SkyTrackState>`（`sky-track.ts`；字段全数据，无函数，Partial 替换整字段语义）。
- `export function applyTrackPatch(base: SkyTrackState, patch: DebugTrackPatch | null): SkyTrackState`——
  null 返回 `base` 本人（引用相等）；否则 `{...base, ...patch}` 浅合并（数组字段整替，不逐元合并；
  `preetham` 对象也是整替语义，patch 若只改 turbidity 会整体替换 preetham，面板一次给完整 preetham 避开问题）。
- `export function linearToByte(v: Vec3): [number, number, number]`——线性→sRGB byte（0–255 取整），
  与 `linearToSrgbCss` 同钳制/伽马；面板回显与往返测试（Review Focus 5）都走它。
- **syncSun 版本门控改造**（main.ts 闭包层）：现有 `let lastSunVersion = -1` 基础上新增
  `let patchVersion = -1`、`let lastPatchVersion = -1`、`let hazeLockVersion = -1`、`let lastHazeLockVersion = -1`。
  门控条件改为 `if (sun.version === lastSunVersion && patchVersion === lastPatchVersion && hazeLockVersion === lastHazeLockVersion) return;`
  三条件同时满足才跳过。原 sun.version 逻辑不变，新增的 patch/haze 两个计数器并行。
- qa 新增：`setTrackPatch(p|null): void`（写闭包 `trackPatch`＋递增 `patchVersion`）、
  `lockHaze(on: boolean): void`（写闭包 `hazeLocked`＋递增 `hazeLockVersion`＋首次锁定→解锁打一次 warn，逐帧 warn 禁止）、
  `exportColorState(): { sun: {az, el}, patch: DebugTrackPatch | null, hazeLocked: boolean, repro: string }`
  （`repro` 是可直接执行的复现命令字符串，含 `?sun=az,el` 与 patch JSON）。

- [ ] **Step 1: 写失败测试**：`applyTrackPatch(state, null) === state`（`toBe` 引用相等）；
  `linearToByte(srgbToLinear('#ff0000'))` ＝ `[255, 0, 0]`，`linearToByte(srgbToLinear('#808080'))` 与 `[128, 128, 128]` 每通道差 ≤ 1；
  非 null 逐字段覆盖、未提字段保持引用、preetham 对象被整替而非嵌套合并；`parseDebugColor('color')===true`，其它 falsy；
  main 源码 pin：`setTrackPatch`／`lockHaze`／`exportColorState` 存在、`syncSun` 内出现 `applyTrackPatch` 与 `hazeLocked` 分支、
  `syncSun` 开头门控改为三条件 `sun.version === lastSunVersion && patchVersion === lastPatchVersion && hazeLockVersion === lastHazeLockVersion`、
  闭包层有 `patchVersion` 和 `hazeLockVersion` 计数器、`setTrackPatch` 内有 `patchVersion` 递增、`lockHaze` 内有 `hazeLockVersion` 递增。
- [ ] **Step 2:** `npx vitest run` —— 预期 FAIL（函数不存在）。
- [ ] **Step 3: 实现（按以下顺序，每步 pin 源码）。**
  1. main.ts 闭包层新增：`let trackPatch: DebugTrackPatch | null = null`、`let hazeLocked = false`、
     `let patchVersion = -1`、`let lastPatchVersion = -1`、`let hazeLockVersion = -1`、`let lastHazeLockVersion = -1`。
  2. `syncSun` 门控从单条件改为三条件：`if (sun.version === lastSunVersion && patchVersion === lastPatchVersion && hazeLockVersion === lastHazeLockVersion) return;`
     然后 `lastSunVersion = sun.version; lastPatchVersion = patchVersion; lastHazeLockVersion = hazeLockVersion;`
  3. `syncSun` 内 patch merge：`const state = applyTrackPatch(skyTrackAt(el), trackPatch);`（替换原 `skyTrackAt(el)` 调用行，约 L282，以 `grep 'skyTrackAt(el)' main.ts` 定位）。
  4. `syncSun` 内 haze guard：`if (!hazeLocked)` 包裹 `seaHazeEndpoints` + `setHazeTargets` 段（调用约 L298，以 `grep 'seaHazeEndpoints' main.ts` 定位）；锁定跳过，首次从 false→true 或 true→false 打一次 `console.warn`。
  5. qa 对象新增三函数：`setTrackPatch(p)` 写闭包＋`patchVersion++`、`lockHaze(on)` 写闭包＋`hazeLockVersion++`＋warn 节流、
     `exportColorState()` 从 `sun.snapshot()` 取 az/el、拼接 `?sun=az,el&trackpatch=JSON.stringify(patch)` 作为 repro 字符串。
   6. `sky-track.ts` 新增导出 `linearToByte`，`linearToSrgbCss` 内部改调它（输出不变，既有测试守住）。
- [ ] **Step 4:** 全量绿＋tsc 干净；空 patch 下现有 405 用例即"默认路径一致"回归网。
- [ ] **Step 5: Commit** `feat(debug): qa-layer track patch, haze lock and color export`

### Task 2: 面板表现层（动态 import＋四组控件）

**Files:**
- Create: `src/debug/color-panel.ts`（`export function mountColorPanel(qa): { dispose(): void }`，裸 DOM＋内联样式）
- Modify: `src/main.ts`（启动块：`?debug=color` 真时 `await import('./debug/color-panel')`＋mount，失败 catch 不影响游戏）
- Test: 面板无单测（DOM 交互）；qa 层已由 Task 1 覆盖。回归：全量＋module-graph 必须绿。

**Interfaces:** 面板只调 Task 1 的 qa 函数＋读 `exportColorState`，不直碰 uniform（纪律：表现层不绕过 qa 层）。

- [ ] **Step 1: 实现（无预写失败测试——DOM 面板，验收走 Step 3 人工清单；若硬要 TDD，等价物是 Task 1 已落地的 qa 函数测试）。**
  - 太阳组：仰角滑杆（−8…＋15，step 0.1，拖动调 `qa.setSun(az, el)`，方位保持当前值）＋方位滑杆（0…360）＋
    关键帧按钮（6.97°／0°／−4°／−8°，方位不变）＋sunspin 播放/暂停＋速度滑杆（0…60°/s，复用 `?sunspin` 语义，面板内状态机启停）。
  - 轨道组（子集滑杆＋颜色拾取）：`nightWeight [0,1]`／`glowGain [0,1]`／`glowPow [60,200]`／`awayGain [0,1]`／
    `discGain [0,1]`／`starOpacity [0,1]`／`floorLinear` 三通道微调；`awayColor/sunTint/cloudHaze` 颜色拾取
    （hex→`srgbToLinear`→patch，约束④）。每个控件 `oninput` 即调 `qa.setTrackPatch({...current, field})`（面板本地持有当前 patch 副本）。
  - 海面组：haze 锁开关（高亮指示＋warn）＋两端点颜色拾取（锁定时才启用，未锁定禁用并注明"被 syncSun 重算"）＋
    快捷按钮（`?sea=nochop` 等价 `setChopGate(false)`／`setQuality` 高低档／`?sea=debug` 提示需重载）＋
    海常量只读表（从各 sea 模块 import 真实 export：`SUN_ROAD`／`CREST_REFERENCE_METRES`／`CHOPPINESS`／
    `K4_MARGIN`／`CASCADES`／`RINGS`／`SEA_BAND_THRESHOLDS`／`SEA_FOAM_THRESHOLD`／`WATER_OPTICS`；
    原文档 SLOPE_GAIN / fineCrestMetres 不存在，已移除）。
  - 导出组："复制复现命令"按钮（`exportColorState().repro` 写剪贴板＋console.info 回显）；面板挂载／每个动作 console.info 等价命令。
  - `dispose()` 移除 DOM＋解绑监听（import 失败路径：catch＋console.error，游戏继续）。
- [ ] **Step 2:** `npx tsc --noEmit`＋全量 vitest 绿（面板文件 `src/debug/color-panel.ts` 放子目录，module-graph.test.ts 的 glob 只扫 src 根目录，天然豁免；main.ts 的动态 `import('./debug/color-panel')` 不是 three/webgpu import，合规）。
- [ ] **Step 3: 人工验收清单**（dev 浏览器）：`?debug=color` 出面板／无参数无面板无 console 报错；
  仰角从 6.97 拖到 −8，天空/海/灯/星/纱连续跟随且与 `?sun=` 同值一致；锁 haze 后调端点海霾定住、解锁后恢复跟随；
  复制命令新开无痕窗口粘贴（URL＋控制台各一遍）画面一致；import 失败模拟（改名文件）游戏不受影响。
- [ ] **Step 4: Commit** `feat(debug): ?debug=color floating color panel`

### Task 3: 文档与收尾

**Files:**
- Modify: `docs/PORTRAIT_QA.md`（加调色板用例：开面板→拖仰角→锁 haze→导出复现）
- Modify: 本计划进度段（记录 Task 1–2 验收＋艺术值无关声明：本计划不改任何调色数值）
- Modify: `docs/superpowers/INDEX.md`（登记本计划；状态 LIVE→已执行，待验收后改）

- [ ] **Step 1:** 写"面板动作↔复现命令"对照表进本计划（每个按钮／滑杆一行：动作→等价命令）。
- [ ] **Step 2: Commit** `docs(debug): color panel usage and repro table`

## 验证（整体验收）

1. 无参默认画面与 `353abdf` 逐像素一致（冻结帧 before/after max channel Δ＝0，天空只走 `?qa=frozen` 现有协议）。
2. 空 patch 恒等测试＋405 既有用例全绿。
3. 人工清单（Task 2 Step 3）全过；复现命令双通道（URL／控制台）一致。
4. `npm run build` 通过，面板 chunk 独立。

## 明确不做（第二步另立计划）

- 海常量滑杆化（`SUN_ROAD`／`CREST_REFERENCE_METRES`／`CHOPPINESS` 的 uniform 化评估，见调研 §6-Q1）。
- 白天档扩展（＞15° 无轨道定义，不在本轮）。
- lil-gui 或任何第三方面板库；HUD 内调色区（已否决）。
- bloom 0.82／`amplitudePeak` 的任何可调入口。
- 面板样式打磨（dev 工具，裸 DOM 够用）。

---

## 进度与批次记录

| 日期 | 批次 | 结果 | 提交 |
|---|---|---|---|
| 2026-11-09 | 计划写成（基于调研 `2026-11-09-debug-color-ui-research.md`，B 方案落地为 3 Task） | 待用户审 | 未提交 |

（每完成一个 Task 追加一行。）
