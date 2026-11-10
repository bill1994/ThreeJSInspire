# 调色 Debug 面板（`?debug=color`）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给日夜轮换与海天调色一套 dev-only 屏上调色板：太阳仰角 scrub＋关键帧一键跳＋sunspin 播放、
轨道字段覆盖、海霾端点锁定＋快捷按钮、当前状态一键导出为可复现命令。默认出货路径零变化。

**Architecture:** 三层。① `qa` 层（`__porco.qa`，无 DOM，可 pin 可测）：
`setTrackPatch(patch|null)`、`lockHaze(on)`、`exportColorState()`、`setChopGate(on)`、`setHazeEndpoints(haze, awayEdge)`、`clearChopGate()`；
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
   与既有 `linearToSrgbCss`（`:93`，返 hex 串；Task 1 一并 `export` 以便钉输出）同公式——`linearToSrgbCss` 改为复用它；
   `in-cloud` 的局部 `toByte`（`:62-66`，闭包内 lambda）不导出、不复用）。禁止线性 Vec3 直灌 DOM／面板。
5. **禁区不暴露**：bloom 阈值 0.82 只读展示＋警告；`amplitudePeak`（存在于 `CASCADES[0].amplitudePeak`，非顶层 export）不进面板；
   海常量只读展示（不放滑杆）：`SUN_ROAD`（`src/sea/sun-road.ts`，对象含 WIDTH_DEG/ROAD_FLOOR/ROAD_PEAK/BASE 等）、
   `CREST_REFERENCE_METRES`（`src/sea/water-shading.ts`）、`CHOPPINESS`（`src/sea/fft-gpu.ts`）、
   `K4_MARGIN`（`src/sea/sun-road.ts`，与 bloom 阈值有契约）、`CASCADES`（`src/sea/cascades.ts`）、
   `RINGS`（`src/sea/rings.ts`）、`SEA_BAND_THRESHOLDS`（`src/sea/bands.ts`）、
   `SEA_FOAM_THRESHOLD`（`src/sea/foam.ts`）、`WATER_OPTICS`（`src/sea/water-shading.ts`）。
   不存在的常量（原文档 SLOPE_GAIN / fineCrestMetres）已替换为上述真实 export 项。
6. **可复现闭环**：面板调出的任何画面，一条命令能重放（`exportColorState` 导出 `?sun=`＋patch JSON＋控制台命令）；
   URL 通道需 `qa.ts` 新增 `parseTrackPatch(raw)` 并在 `main.ts` 启动时调用 `qa.setTrackPatch`。URL 过长时给出明确上限。
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
   且 `exportColorState` 必须包含锁状态**与锁定态端点值**（复审 R14：只导出布尔锁，锁定+改端点调出的画面重放必不一致）。
4. **动态 import 失败白屏**：import 失败必须 catch＋console.error＋面板不建，游戏本身不受影响。
5. **sRGB/线性双重转换**：颜色拾取→解码→uniform→回显 byte，任一环节错位都会偏色——用往返测试钉（hex→linear→byte＝原值，落 `src/sky-track.test.ts`，走 `linearToByte`）。
6. **出货包体积**：`npm run build` 后确认面板 chunk 独立、默认入口不含面板代码（构建日志抽查）。

---

### Task 0: 开工对账

**Files:** Create `artifacts/debug-color/before.png`（只读检查＋一张基线帧）

- [ ] `git status` 对账：记录未跟踪项（以 `git status --short` 实测为准；当前为 `.workbuddy/`、`artifacts/sea-audit/`），确认都不影响构建后开工。
- [ ] `npx vitest run` 全绿基线（**以开工实测为准并记入本行**；写计划时为 52 文件 / 470 用例——先执行的穹顶云计划会加测试文件，勿沿用旧数，R15）＋`npx tsc --noEmit` 干净。
- [ ] 读 `module-graph.test.ts` 确认扫描范围：`src/debug/` 是否在禁区内、动态 `import()` 是否豁免；结论记进度段，
  决定面板文件放 `src/debug/color-panel.ts` 还是其它豁免路径。
- [ ] 对行号：`main.ts` syncSun 门控 `let lastSunVersion = -1`（**L267**）、`const syncSun` 定义（**L275**）、
  门控条件 `if (sun.version === lastSunVersion) return;`（**L276**）、qa 对象挂载（**L370**）、`setSun`（**L399**）、
  `getSun`（**L407**）、`selfCheck`（**L412**）；`qa.ts` 当前 7 个 parser：parsePos / parsePuffVisible /
  parseDomeVisible / parseSeaVisible / parseSeaDebug / parseSeaNoChop / parseSunSpin；**本计划新增**：
  `parseDebugColor` / `parseTrackPatch` / `parseHazeLock` / `parseLinearVec3`（S4：URL 端点通道）；漂移以 grep 为准。
- [ ] **before 帧现抓（R15/S12）**：`?qa=frozen` + `qa.step(0)` 同机位抓 `artifacts/debug-color/before.png`，
  记录 step 数、canvas 尺寸与 SHA；这是整体验收 1"逐像素一致"的唯一基准，不引用历史 commit。

### Task 1: qa 层六个无 DOM 函数（复审 R13/S5 增补 setChopGate／setHazeEndpoints／clearChopGate 透传）

**Files:**
- Modify: `src/sky-track.ts`（新增 `DebugTrackPatch` 类型＋`applyTrackPatch` 纯函数＋`linearToByte` 导出，并把 `linearToSrgbCss` 一并 `export` 供 D4 钉输出）
- Modify: `src/main.ts`（qa 对象加 `setTrackPatch/lockHaze/exportColorState/setChopGate/setHazeEndpoints/clearChopGate` 六函数，syncSun 加两处 merge 点——
  patch 合并放 Task 2，此任务只加函数骨架与状态位？不：一次做完，测试一次钉死）
- Modify: `src/qa.ts`（新增 `parseDebugColor(raw)`：`?debug=color` 真值表 + `parseTrackPatch(raw)`：patch JSON 解析 +
  `parseHazeLock(raw)`：`?hazelock=1` + `parseLinearVec3(raw)`：`?haze/away` 的线性三分量解析）
- Test: `src/qa.test.ts`（`parseDebugColor`／`parseTrackPatch`／`parseHazeLock`／`parseLinearVec3`）、`src/sky-track.test.ts`（`applyTrackPatch`）＋ main 源码 pin（`sky-sun-sea-linkage.test.ts` 追加）

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
  `exportColorState(): { sun: {az, el}, patch: DebugTrackPatch | null, hazeLocked: boolean, haze: Vec3 | null, awayEdge: Vec3 | null, repro: string }`
  （`haze/awayEdge` 读闭包缓存 `hazeNow/awayEdgeNow`——**不是重算**：重算只代表“若未锁定本该推送的值”，锁定后改过端点就对不上（S5）。
  `repro` 同时含 URL 与控制台两条：`?sun=az,el&trackpatch=<encodeURIComponent(JSON)>&hazelock=<0|1>&haze=<r,g,b>&away=<r,g,b>`
  （线性浮点 **≥4 位小数**，`toFixed(4)`；`haze/awayEdge` 为 null 时省掉 `haze/away` 两段）与
  `qa.setSun(az,el); qa.setTrackPatch(...); qa.lockHaze(...);`（非 null 时再追加 `qa.setHazeEndpoints(...)`）（R14/S4））、
  `setChopGate(on: boolean): void`（透传 `world?.sea?.setChopGate(on)`；R13——nochop 按钮的写入口，面板不得直调 world 句柄）、
  `setHazeEndpoints(haze: Vec3, awayEdge: Vec3): void`（透传 `world?.setHazeTargets(haze, awayEdge)`，两参为线性 Vec3；同时写 `hazeNow/awayEdgeNow`；R13/S5）、
  `clearChopGate(): void`（透传 `world?.sea?.clearChopGate()`；小项 i——nochop 必须可恢复）。
- `qa.ts` 新增 parser：`parseHazeLock(raw): boolean`（`'1'` → true）、`parseLinearVec3(raw): Vec3 | null`（`r,g,b` 三分量有限数，其它 null；S4）。

- [ ] **Step 1: 写失败测试**：`applyTrackPatch(state, null) === state`（`toBe` 引用相等）；
  `linearToByte(srgbToLinear('#ff0000'))` ＝ `[255, 0, 0]`，`linearToByte(srgbToLinear('#808080'))` 与 `[128, 128, 128]` 每通道差 ≤ 1；
  非 null 逐字段覆盖、未提字段保持引用、preetham 对象被整替而非嵌套合并；`parseDebugColor('color')===true`，其它 falsy；
  main 源码 pin：`setTrackPatch`／`lockHaze`／`exportColorState`／`setChopGate`／`setHazeEndpoints`／`clearChopGate` 存在、`syncSun` 内出现 `applyTrackPatch` 与 `hazeLocked` 分支、
  `syncSun` 开头门控改为三条件 `sun.version === lastSunVersion && patchVersion === lastPatchVersion && hazeLockVersion === lastHazeLockVersion`、
  闭包层有 `patchVersion` 和 `hazeLockVersion` 计数器、`setTrackPatch` 内有 `patchVersion` 递增、`lockHaze` 内有 `hazeLockVersion` 递增；
  `parseTrackPatch('{"nightWeight":0.5}')` 深等于该对象、`parseTrackPatch('not json')===null`、`parseTrackPatch(null)===null`；
  `parseHazeLock('1')===true`、`parseHazeLock(null)===false`、`parseHazeLock('true')===false`；
  `parseLinearVec3('0.0296,0.1100,0.2000')` 深等于三分量、`parseLinearVec3('1,2')===null`、`parseLinearVec3('a,b,c')===null`；
  `exportColorState()` 在「`lockHaze(true)` → `setHazeEndpoints([0.1,0.2,0.3],[0.4,0.5,0.6])` → 再导出」后 `haze/awayEdge` 等于新值、`repro` 的 URL 含 `hazelock=1` 且小数 ≥4 位；
  main 源码 pin 出现 `parseTrackPatch(qaParams.get('trackpatch'))` 与 `parseLinearVec3(qaParams.get('haze'))`（URL 通道真接了线，不是文档里写写）。
- [ ] **Step 1b: 重构前先钉死 `linearToSrgbCss` 现有输出（D4）。** `linearToSrgbCss` 目前是 `sky-track.ts:93` 的
  未导出函数、内部自算 `Math.round(clamp(s)*255)`；现有测试只 pin `srgbToLinear` 的往返，没 pin 它的输出串。
  Task 1 一并 `export` 它，然后在 `src/sky-track.test.ts` 加（注意入参是 `Vec3`，不是标量）：

  ```ts
  it('pins current linearToSrgbCss output before refactor (must NOT regress sky CSS)', () => {
    expect(linearToSrgbCss([0, 0, 0])).toBe('#000000');
    expect(linearToSrgbCss([1, 1, 1])).toBe('#ffffff');
    expect(linearToSrgbCss([0.5, 0.5, 0.5])).toBe('#bcbcbc'); // 1.055·0.5^(1/2.4)−0.055 = 0.7354 → round 188
    expect(linearToSrgbCss([-0.1, -0.1, -0.1])).toBe('#000000'); // 超下界钳制
    expect(linearToSrgbCss([1.5, 1.5, 1.5])).toBe('#ffffff');  // 超上界钳制
  });
  ```

  这条要先跑绿（当前实现必须能过），再重构 `linearToSrgbCss` 为复用 `linearToByte`，跑完再确认还是绿。
- [ ] **Step 2:** `npx vitest run` —— 预期 FAIL（函数不存在）。
- [ ] **Step 3: 实现（按以下顺序，每步 pin 源码）。**
  1. main.ts 闭包层新增：`let trackPatch: DebugTrackPatch | null = null`、`let hazeLocked = false`、
     `let hazeNow: Vec3 | null = null`、`let awayEdgeNow: Vec3 | null = null`、
     `let patchVersion = -1`、`let lastPatchVersion = -1`、`let hazeLockVersion = -1`、`let lastHazeLockVersion = -1`。
  2. `syncSun` 门控从单条件改为三条件：`if (sun.version === lastSunVersion && patchVersion === lastPatchVersion && hazeLockVersion === lastHazeLockVersion) return;`
     然后 `lastSunVersion = sun.version; lastPatchVersion = patchVersion; lastHazeLockVersion = hazeLockVersion;`
  3. `syncSun` 内 patch merge：`const state = applyTrackPatch(skyTrackAt(el), trackPatch);`（替换原 `skyTrackAt(el)` 调用行，约 L282，以 `grep 'skyTrackAt(el)' main.ts` 定位）。
  4. `syncSun` 内 haze guard：`if (!hazeLocked) { const { haze, awayEdge } = seaHazeEndpoints(...); hazeNow = haze; awayEdgeNow = awayEdge; world?.setHazeTargets(haze, awayEdge); }`
     （调用约 L298，以 `grep 'seaHazeEndpoints' main.ts` 定位）；锁定跳过推送，**但缓存保留最后推送值**，首次 false→true / true→false 打一次 `console.warn`（S5）。
  5. qa 对象新增六函数：`setTrackPatch(p)` 写闭包＋`patchVersion++`、`lockHaze(on)` 写闭包＋`hazeLockVersion++`＋warn 节流、
     `exportColorState()` 从 `sun.snapshot()` 取 az/el、从 `hazeNow/awayEdgeNow` 取端点；repro 同时返回两条：
     URL：`?sun=az,el&trackpatch=<encodeURIComponent(JSON)>&hazelock=<0|1>&haze=<r,g,b>&away=<r,g,b>`（数值 `toFixed(4)`；null 时省掉 haze/away）；
     控制台：`qa.setSun(az, el); qa.setTrackPatch(${JSON.stringify(patch)}); qa.lockHaze(${hazeLocked});`，端点非 null 时追加 `qa.setHazeEndpoints(...)`（R14/S4）；
     `setChopGate(on)` 透传 `world?.sea?.setChopGate(on)`、`setHazeEndpoints(haze, awayEdge)` 透传 `world?.setHazeTargets(...)` 并写缓存、`clearChopGate()` 透传 `world?.sea?.clearChopGate()`（R13/小项 i）。
  6. `sky-track.ts` 新增导出 `linearToByte`，`linearToSrgbCss` 内部改调它（输出不变，既有测试守住）。
  7. `main.ts` 在 **qa 对象创建之后**（约 L463，`Object.assign(__porco, { qa })` 之后、`setAnimationLoop` 之前）接 URL 通道，**顺序固定：先端点、后锁**——
     **不能放在 `qaParams` 那段（L184-195）**：那时 `qa` 还没定义，`qa.setTrackPatch` 会 TDZ/undefined（S13）。
     `const urlPatch = parseTrackPatch(qaParams.get('trackpatch')); if (urlPatch) qa.setTrackPatch(urlPatch);`
     `const haze = parseLinearVec3(qaParams.get('haze')); const away = parseLinearVec3(qaParams.get('away')); if (haze && away) qa.setHazeEndpoints(haze, away);`
     `if (parseHazeLock(qaParams.get('hazelock'))) qa.lockHaze(true);`
     ——先写端点再锁，否则首帧 `syncSun` 被锁挡掉、海面拿的是模块默认端点（S4）；解析失败一律 `null` + `console.warn`，**不得抛错中断启动**。
  8. 顺手改两处陈旧注释（R17）：`main.ts:17-18` 删"海已删除／不再 tow 水面"两句（L174-194、L276-281、L297-304 都在用海）；
     `qa.ts:50-56` 把"`setQuality` 换档后本钩子失效"改成"`chopOverride` 已保证换档后仍生效"。
- [ ] **Step 4:** 全量绿＋tsc 干净；空 patch 下既有用例即"默认路径一致"回归网。
- [ ] **Step 5: Commit** `feat(debug): qa-layer track patch, haze lock and color export`

### Task 2: 面板表现层（动态 import＋四组控件）

**Files:**
- Create: `src/debug/color-panel.ts`（`export function mountColorPanel(qa): { dispose(): void }`，裸 DOM＋内联样式）
- Modify: `src/main.ts`（qa 对象创建之后约 L463：`?debug=color` 真时 `await import('./debug/color-panel')`＋mount，失败 catch 不影响游戏——**同样不能放在 L184-195，qa 还没定义**）
- Test: 面板无单测（DOM 交互）；qa 层已由 Task 1 覆盖。回归：全量＋module-graph 必须绿。

**Interfaces:** 面板只调 Task 1 的 qa 函数（含 `setChopGate`/`setHazeEndpoints`/`clearChopGate` 透传，R13）＋读 `exportColorState`，不直碰 uniform、不直调 world/sea 句柄（纪律：表现层不绕过 qa 层）。

- [ ] **Step 1: 实现（无预写失败测试——DOM 面板，验收走 Step 3 人工清单；若硬要 TDD，等价物是 Task 1 已落地的 qa 函数测试）。**
  - 太阳组：仰角滑杆（−8…＋15，step 0.1，拖动调 `qa.setSun(az, el)`，方位保持当前值）＋方位滑杆（0…360）＋
    关键帧按钮（6.97°／0°／−4°／−8°，方位不变）＋sunspin 播放/暂停＋速度滑杆（0…60°/s；R16：`?sunspin` 是启动期常量、无运行时 setter——播放走每帧 `qa.rotateSun(deg)`（`main.ts:403`），只复用其单位与 ≤360 上限；面板内状态机启停）。
  - 轨道组（子集滑杆＋颜色拾取）：`nightWeight [0,1]`／`glowGain [0,1]`／`glowPow [60,200]`／`awayGain [0,1]`／
    `discGain [0,1]`／`starOpacity [0,1]`／`floorLinear` 三通道微调；`awayColor/sunTint/cloudHaze` 颜色拾取
    （hex→`srgbToLinear`→patch，约束④）。每个控件 `oninput` 即调 `qa.setTrackPatch({...current, field})`（面板本地持有当前 patch 副本）。
  - 海面组：haze 锁开关（高亮指示＋warn）＋两端点颜色拾取（锁定时才启用，未锁定禁用并注明"被 syncSun 重算"；写入走 `qa.setHazeEndpoints`，R13）＋
    快捷按钮（nochop **toggle**：开 → `qa.setChopGate(false)`、关 → `qa.clearChopGate()`，与 `?sea=nochop` 等价且**换档不失效**——`chopOverride` 已保证（R13/小项 i）／`setQuality` 高低档／`?sea=debug` 提示需重载）＋
    海常量只读表（从各 sea 模块 import 真实 export：`SUN_ROAD`／`CREST_REFERENCE_METRES`／`CHOPPINESS`／
    `K4_MARGIN`／`CASCADES`／`RINGS`／`SEA_BAND_THRESHOLDS`／`SEA_FOAM_THRESHOLD`／`WATER_OPTICS`；
    原文档 SLOPE_GAIN / fineCrestMetres 不存在，已移除）。
  - 导出组："复制复现命令"按钮（`exportColorState().repro` 写剪贴板＋console.info 回显）；面板挂载／每个动作 console.info 等价命令。
  - `dispose()` 移除 DOM＋解绑监听（import 失败路径：catch＋console.error，游戏继续）。
- [ ] **Step 2:** `npx tsc --noEmit`＋全量 vitest 绿（面板文件 `src/debug/color-panel.ts` 放子目录，module-graph.test.ts 的 glob 只扫 src 根目录，天然豁免；main.ts 的动态 `import('./debug/color-panel')` 不是 three/webgpu import，合规）。
- [ ] **Step 3: 人工验收清单**（dev 浏览器）：`?debug=color` 出面板／无参数无面板无 console 报错；
  仰角从 6.97 拖到 −8，天空/海/灯/星/纱连续跟随且与 `?sun=` 同值一致；锁 haze 后调端点海霾定住、解锁后恢复跟随；
  复制命令新开无痕窗口粘贴（**URL 和控制台各一遍**）画面一致（两条路径都能复现）；import 失败模拟（改名文件）游戏不受影响。
- [ ] **Step 4: Commit** `feat(debug): ?debug=color floating color panel`

### Task 3: 文档与收尾

**Files:**
- Modify: `docs/PORTRAIT_QA.md`（加调色板用例：开面板→拖仰角→锁 haze→导出复现）
- Modify: 本计划进度段（记录 Task 1–2 验收＋艺术值无关声明：本计划不改任何调色数值）
- Modify: `docs/superpowers/INDEX.md`（登记本计划；状态 LIVE→已执行，待验收后改）

- [ ] **Step 1:** 写"面板动作↔复现命令"对照表进本计划（每个按钮／滑杆一行：动作→等价命令）。
- [ ] **Step 2: Commit** `docs(debug): color panel usage and repro table`

## 验证（整体验收）

1. 无参默认画面与本计划**开工前 HEAD 现抓的 before 帧**逐像素一致（冻结帧 before/after max channel Δ＝0，天空只走 `?qa=frozen` 现有协议；before 帧在 Task 0 现抓，不引用历史 commit——R15：穹顶云 Task 0.5 关雾会改默认画面，钉死 `353abdf` 之类必过期）。
2. 空 patch 恒等测试＋既有用例全绿（以开工实测数为准）。
3. 人工清单（Task 2 Step 3）全过；复现命令双通道（URL／控制台）**各跑一遍**画面一致（两条路径都能复现）。
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
| 2026-11-10 | Task 0 开工对账（git status／vitest 52 文件 470 用例全绿／tsc 干净／module-graph 豁免确认／行号零漂移） | 完成；before 帧现抓 SHA `02f6b13b…8870`（233,637 bytes，448×797） | 无提交（纯对账；产物 `artifacts/debug-color/` 留工作区不提交） |
| 2026-11-11 | Task 1 qa 层六函数 + syncSun 三条件门控 + URL 通道（先端点后锁） | 完成；`applyTrackPatch` 引用恒等／线性往返／源码 pin 全绿 | `0b8b1f2` |
| 2026-11-11 | Task 2 面板表现层（动态 import + 四组控件） | 完成；浏览器验收 11/11（`artifacts/debug-color/verify-task2.json`，含 URL/console 双通道复现一致、import 失败恢复） | `ffdb101` |
| 2026-11-11 | Task 3 文档与收尾 + 整体验收 ①④ | 完成；①「默认画面不改」同会话 A/B 字节级一致（见下实测记录）；④ build 通过、面板 chunk 独立（入口零面板字符串） | 本提交 |

（每完成一个 Task 追加一行。）

**艺术值无关声明**：本计划不改任何调色数值。全部改动（qa 层六函数、syncSun 三条件门控、URL 通道、面板）都是无渲染的杠杆与展示层；参考档恒等由 `applyTrackPatch(state, null) === state` 引用相等钉死，默认画面由验收 ① 的同会话 A/B 字节级一致证实。

### 整体验收 ①「无参默认画面逐像素一致」实测记录（2026-11-11，Task 3）

- 基准：`artifacts/debug-color/before.png`（Task 0，2026-11-10 23:54，HEAD `80ec08d`），SHA-256 `02f6b13b…8870`，233,637 bytes。
- HEAD（`ffdb101`）同协议复抓（`capture_before_head.mjs`，与 Task 0 脚本逐字同协议：`http://[::1]:5173/?qa=frozen` IPv6 + `location.href` 校验 + boot-status 淡出等完 + `qa.step(0)` + present 链）：SHA-256 `bde064f4…9674`，233,950 bytes —— **与 before.png 字节不同**，触发根因定位。
- 定位结论（环境漂移，非代码差异）：
  1. 差异像素 3,230／1,103,048（0.29%；分母为视口 1384×797 的整幅像素，画布 CSS 尺寸 448×797——权威数字见 `artifacts/debug-color/capture-before.json` sidecar），max channel Δ56，**全部**落在 DOM HUD 元素框内（速度表弧线／音频混音面板／字幕；`hud.ts` 的 `.porco-arc__fill` 带 `transition: stroke-dashoffset .08s linear` 等墙钟驱动样式，`?qa=frozen` 冻不住 DOM 层）；**3D 画布区差异像素 = 0（max Δ=0）**。
  2. HEAD 侧跨会话稳定：Task 2 验收会话（11-11 01:18 的 `import-fail.png`）与 Task 3 的两次新会话（含 present 后加 500 ms settle 的变体）四帧字节级一致。
  3. **同会话 A/B 定案**：把 `80ec08d` 检出到临时 worktree、同一 Chrome 会话同协议复抓 → SHA 与 HEAD 今日帧完全相同（`bde064f4…`），不再产出 before.png 的 SHA。即 `80ec08d ↔ ffdb101` 默认画面字节级零差异；before.png 的 SHA 属 23:54 冷启动会话的 HUD 栅格化环境漂移，任何 commit 在今日会话都复现不出它。
- **判定：验收 ① 的实质（「本计划不改默认画面」）成立**——代码零贡献由同会话 A/B 字节级一致钉死，比原判据（跨日对 before.png 比 SHA）更强；环境漂移仅触及 HUD AA 边缘（0.29% px，亚可见）。复抓与取证产物：`capture_before_head{,_settled,_80ec08d_recheck}.mjs` + 对应 PNG/JSON（工作区不提交）。

### 整体验收 ④「build 通过 + 面板 chunk 独立」实测记录（2026-11-11，Task 3）

- `npm run build`（`tsc --noEmit` + vite build）通过（66 modules，2.97s）。
- 面板独立 chunk：`dist/assets/color-panel-DYYksSK9.js`（8.92 kB／gzip 4.03 kB），由入口的动态 `import("./color-panel-…")` 引用（按需加载，非默认路径）。
- 默认入口 `dist/assets/index-BLZswRej.js`（831.83 kB）抽查**零面板字符串**：`debug-color-panel`／`[debug-panel]`／`sunspin: OFF`／`复制复现命令`／`haze-lock`／`repro-box`／`dcp`／`参考档` 均为 index=0、panel chunk ≥1。入口中出现的 `setTrackPatch` 等名字属 Task 1 的 qa 层（main.ts 本体，计划既定），不是面板泄漏。

---

## 面板动作 ↔ 复现命令对照表（Task 3 Step 1，从实现反推）

读法（先看这个）：

- **URL 通道**（启动期一次性）：参数拼进 URL 重载生效。`sun`／`trackpatch`／`hazelock`／`haze`／`away` 在 qa 对象创建后接线（main.ts，顺序先端点后锁）；`sea=nochop`／`sea=debug`／`sunspin` 是启动期参数，无运行时 setter。
- **console 通道**（运行期）：`__porco.qa.*` 直接调用，立即生效。
- 数值格式：`?sun=`/`haze`/`away` 分量一律 `toFixed(4)`；`trackpatch` 为原生浮点 JSON（`JSON.stringify` 全精度，`encodeURIComponent` 后拼入，整字段替换语义）；`haze`/`away` 两端必须同时给。面板动作只在 change 事件（一次拖动一条）以 `[debug-panel]` 前缀回显等价 console 命令，input 过程静默只更新显示。

### 太阳组

| 面板动作 | 运行时调用 | 等价复现命令（URL ／ console） |
|---|---|---|
| elevation° 滑杆（−8…15，step 0.1；方位保持当前值） | `qa.setSun(当前方位, el)` | `?sun=<az>,<el>` ／ `qa.setSun(<az>, <el>)` |
| azimuth° 滑杆（0…360，step 0.5；仰角保持当前值） | `qa.setSun(az, 当前仰角)` | 同上 |
| 关键帧 6.97°／0°／−4°／−8° 按钮 | `qa.setSun(当前方位, elDeg)` | `?sun=<az>,<elDeg>` ／ `qa.setSun(<az>, <elDeg>)` |
| sunspin: OFF→ON（播放） | 面板内状态机每帧 `qa.rotateSun(速度·dt)` | 无单条等价：启动期 `?sunspin=<deg/s>`；运行期 console 逐帧 `qa.rotateSun(<deg>)` |
| sunspin: ON→OFF（暂停） | 停状态机（cancelAnimationFrame） | console 不再发 `qa.rotateSun`（URL 无对应态） |
| sunspin °/s 滑杆（0…60，钳 ≤360） | 写面板本地速度（无 qa 调用） | 只影响播放每帧折算；启动期等价 `?sunspin=<deg/s>` |

### 轨道组（全部经 `qa.setTrackPatch`，整字段替换）

| 面板动作 | 运行时调用 | 等价复现命令（URL ／ console） |
|---|---|---|
| nightWeight 滑杆 [0,1] step 0.01 | `qa.setTrackPatch({...patch, nightWeight: v})` | `&trackpatch=<encodeURIComponent(JSON)>` ／ `qa.setTrackPatch(<JSON>)` |
| glowGain 滑杆 [0,1] | 同上（glowGain） | 同上 |
| glowPow 滑杆 [60,200] step 1 | 同上（glowPow） | 同上 |
| awayGain 滑杆 [0,1] | 同上（awayGain） | 同上 |
| discGain 滑杆 [0,1] | 同上（discGain） | 同上 |
| starOpacity 滑杆 [0,1] | 同上（starOpacity） | 同上 |
| floor.R／G／B 滑杆 [0,0.02] step 0.0005 | `qa.setTrackPatch({...patch, floorLinear: [r,g,b]})`（三通道整组写入） | 同上 |
| awayColor 拾色器 | hex → `srgbToLinear` → `qa.setTrackPatch({...patch, awayColor})` | 同上（JSON 内为线性浮点，非 hex） |
| sunTint 拾色器 | 同上（sunTint） | 同上 |
| cloudHaze 拾色器 | 同上（cloudHaze） | 同上 |
| bloomThreshold 行 | 只读展示（禁区 0.82＝参考档） | 无动作、无入口（约束⑤） |

### 海面组

| 面板动作 | 运行时调用 | 等价复现命令（URL ／ console） |
|---|---|---|
| haze 锁（勾选） | `qa.lockHaze(true)`（翻转时 warn 一次） | `&hazelock=1` ／ `qa.lockHaze(true)` |
| haze 锁（取消） | `qa.lockHaze(false)` | `qa.lockHaze(false)`（URL 只表达锁定态，无解除段） |
| haze 端点拾色器（锁定时才启用） | `qa.setHazeEndpoints([r,g,b], [awayEdge 当前值])` | `&haze=<r,g,b>&away=<r,g,b>` ／ `qa.setHazeEndpoints([r,g,b],[r,g,b])` |
| awayEdge 端点拾色器（锁定时才启用） | `qa.setHazeEndpoints([haze 当前值], [r,g,b])` | 同上（两端必须同时给） |
| nochop toggle → ON | `qa.setChopGate(false)` | `?sea=nochop`（启动期）／`qa.setChopGate(false)`；面板 toggle 换档不失效（chopOverride，R13） |
| nochop toggle → OFF | `qa.clearChopGate()` | `qa.clearChopGate()`（URL 无解除态） |
| quality high 按钮 | `qa.setQuality(true)` | `qa.setQuality(true)`（画质档无 URL 通道） |
| quality low 按钮 | `qa.setQuality(false)` | `qa.setQuality(false)` |
| 「?sea=debug 提示」按钮 | 仅 console.info 提示 | 实际动作：URL 追加 `&sea=debug` 后重载（启动期假色模式） |
| 海常量只读表 | 无动作 | 只读展示（各 sea 模块真实 export；CASCADES 剔除 amplitudePeak，约束⑤） |

### 导出组

| 面板动作 | 运行时调用 | 等价复现命令 |
|---|---|---|
| 「复制复现命令」按钮 | 刷新文本框为 `qa.exportColorState().repro` + 写剪贴板 + console 回显 | 两行：URL `?sun=<az>,<el>&trackpatch=<JSON>&hazelock=<0\|1>[&haze=<r,g,b>&away=<r,g,b>]` ／ console `qa.setSun(<az>, <el>); qa.setTrackPatch(<JSON>); qa.lockHaze(<bool>);[ qa.setHazeEndpoints([r,g,b],[r,g,b]);]`（null 段省略） |

注：`exportColorState` 的 haze/awayEdge 读闭包缓存（最后一次 `qa.setHazeEndpoints` 写入的值），**不是重算**——锁定后改过端点的画面才能被正确导出（R14/S5）。面板本地 patch 副本初值来自 `skyTrackAt(当前仰角) + applyTrackPatch(URL 补丁)`，与海常量同一「单一来源」纪律。
