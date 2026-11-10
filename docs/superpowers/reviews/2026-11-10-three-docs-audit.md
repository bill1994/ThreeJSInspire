# 三份文档交叉审核报告

- 日期：2026-11-10
- 仓库：`G:\DSHProject\ThreeJSInspire`
- 分支：`feat/dome-cloud-volumetric`
- HEAD：`41f1945`
- 审核对象：
  - `docs/superpowers/plans/2026-11-09-debug-color-panel.md`
  - `docs/superpowers/plans/2026-11-10-dome-cloud-p15-p2-horizon.md`
  - `docs/superpowers/specs/2026-11-10-flight-feel-improvement-design.md`
- 审核方式：源码逐行核对、`grep` 交叉验证、`npx vitest run` 基线、无头飞行模拟、P1 现有帧像素量测。未打开浏览器（三份对应的功能均未落地，网页里没有可测对象）。

## 0. 基线

| 项 | 结果 |
|---|---|
| `npx vitest run` | 52 个测试文件 / 470 个用例全绿（约 5.86 s） |
| `git status` | 仅有未跟踪项：`.dsh-dev.log`、`.trae-html-share-packages/`、`.video_agent/`、`.workbuddy/`、`.zcode/`、`docs/superpowers/specs/2026-11-10-flight-feel-improvement-design.md` |
| `353abdf` | 存在，且是 HEAD 的祖先 |
| 工作树 | **不干净**；调色面板计划 Task 0 的“工作树干净”不成立 |

## 1. 总览

| 文档 | 结论 | 阻断项 |
|---|---|---|
| 调色面板计划 | 可执行，但有一个验收断点 | `?trackpatch=` 无消费者，Task 2 的 URL 复现验收必挂 |
| 穹顶云 P1.5/P2 计划 | **不可照现状执行** | 雾、Task 7、Task 9 三处硬伤；另有量具时序与接口问题 |
| 飞行手感设计 | **核心基线不成立** | “满杆上拉 2.9–3.4 s、30–50 m”实为压杆数据；持续上拉在任何高度都不空中改出 |

---

## 2. 调色面板计划

文件：`docs/superpowers/plans/2026-11-09-debug-color-panel.md`

### D1（P0）`?trackpatch=` 复现通道不存在

**文档断言**

- 第 99 行：`exportColorState()` 返回可直接执行的复现命令，含 `?sun=az,el` 与 patch JSON。
- 第 116 行：拼接 `?sun=az,el&trackpatch=JSON.stringify(patch)` 作为 `repro` 字符串。
- 第 146 行：人工验收要求“复制命令新开无痕窗口粘贴（URL＋控制台各一遍）画面一致”。
- 第 163 行：验收标准写“复现命令双通道（URL／控制台）一致”。

**证据**

- `grep -R "trackpatch" src` 无结果；`qa.ts` 现有的 7 个 parser 中没有 `parseTrackPatch`；`main.ts` 只解析 `sun`、`pos`、`dome` 等参数，没有读取 `trackpatch`。
- 因此 `?trackpatch=...` 会被 URLSearchParams 原样忽略，画面只应用 `?sun=`，与控制台 `qa.setTrackPatch(...)` 的结果不可能一致。

**影响**

- Task 2 Step 3 的 URL 通道必失败；验收标准第 6 条“一条命令能重放”只兑现了控制台一半。
- 这不是实现细节问题，是验收口径与代码能力不匹配。

**修法（二选一）**

1. 增加 `parseTrackPatch(raw: string | null): DebugTrackPatch | null`，在 `main.ts` 启动时解析并调用 `qa.setTrackPatch`；URL 过长时给出明确上限与失败提示。
2. 删掉 URL 通道，`repro` 只返回 `qa.setTrackPatch(...)` 控制台命令；同时改掉第 146、163 行的双通道验收。

### D2（P1）Task 0 基线过时

**文档断言**

- 第 71 行：`npx vitest run` 全绿基线“47 文件 / 405 用例”。
- 第 70 行：`git status` 对账“工作树干净”。
- 第 118 行、第 162 行继续引用 405 用例作为回归网。

**证据**

- 实测 52 文件 / 470 用例。
- `git status` 有 6 个未跟踪项（见第 0 节）。
- 405 → 470 的增量意味着“空 patch 下现有用例即默认路径回归网”的覆盖范围已经变化，不能沿用旧数字。

**修法**

- 更新为 52 / 470，并把未跟踪项写进 Task 0 的现状，而不是“干净”。

### D3（P2）行号漂移

**文档断言**

- 第 74 行：`syncSun`（约 260–296）、qa 挂载（约 352–399）。

**实际**

- `let lastSunVersion = -1`：`main.ts:267`
- `const syncSun`：`main.ts:275`
- 门控 `if (sun.version === lastSunVersion) return;`：`main.ts:276`
- qa 对象 `Object.assign(..., { qa: {`：`main.ts:370`
- `setSun`：`main.ts:399`；`getSun`：`main.ts:407`；`selfCheck`：`main.ts:412`

计划自己写了“漂移则以现状为准”，所以不阻塞；但既然要交叉审核，建议直接改成实际行号。

### D4（P2）`linearToSrgbCss` 没有直接单测

**文档断言**

- Task 1 要新增并导出 `linearToByte`，并让 `linearToSrgbCss` 复用它（第 79、87 行附近）。

**证据**

- `src/sky-track.ts:93` 的 `linearToSrgbCss` 当前是未导出函数，内部自己做 `Math.round(clamp(s)*255)`。
- 现有 `sky-track.test.ts` 只 pin `srgbToLinear`，没有直接 pin `linearToSrgbCss` 的输出字符串。

**影响**

- 若 `linearToByte` 的舍入/钳制与现实现不同，会悄悄改变天空 CSS 颜色；现有测试未必抓得到。

**修法**

- 重构前先加一条 `linearToSrgbCss` 输出 pin（至少覆盖 0、1、中间值、超界值），再抽 `linearToByte`。

### 已核对正确

- `sun.snapshot()` 存在（`src/sun-state.ts:139`），返回 `azimuthDeg/elevationDeg/version`。
- `?pos` 经 `main.ts:214` 的 `game.setPose(qaPos.x, qaPos.y, qaPos.z)` 生效；`qaPos` 在 `main.ts:188` 解析。
- `linearToSrgbCss` 未导出、`in-cloud.ts:62-66` 的 `toByte` 是闭包箭头，均属实。
- `src/debug/` 不在 `module-graph.test.ts` 的 `./*.ts` 扫描范围；面板动态 import 不会触发 `three/webgpu` 静态断言。
- 三计数器门控与现有 `sun.version` 门控兼容；`lastSunVersion = -1` 保证首帧同步。
- `?sunoff=1` 启动时 world 已创建（`main.ts:175` 早于 `qaParams` 的 `main.ts:184`），`world?.setSunColor([0,0,0])` 有对象可写。
- `SUN_ROAD` 已导出（`src/sea/sun-road.ts:20`）；`docs/PORTRAIT_QA.md` 与 `docs/superpowers/INDEX.md` 都存在。

---

## 3. 穹顶云 P1.5/P2 计划

文件：`docs/superpowers/plans/2026-11-10-dome-cloud-p15-p2-horizon.md`

### B1（P0）雾会把 1200–1800 m 的 patch 全糊成雾色

**文档断言**

- 第 369、377、379、423 行：地平线 patch 放在 1200–1800 m 的 fade 带，与 deck 同带交接，验收要求“海平面有云”“1200 m 交接无断线/双影”。
- 第 427 行：`?pos=0,60,-300` 低空平视检查。

**证据**

- `src/main.ts:73`：`scene.fog = new THREE.Fog('#c96a7a', 60, 700);`
- `src/dome-cloud.ts:325-330`：`new NodeMaterial()` 只设置 `colorNode/transparent/side/depthWrite/depthTest`，**没有 `material.fog = false`**。
- `node_modules/three/src/materials/nodes/NodeMaterial.js:77`：`this.fog = true;` 默认值。
- 对照：`src/puff-cloud.ts:279`、`src/puff-cloud.ts:360`、`src/sky-webgpu.ts:302`、`src/sea/material.ts:472` 都显式关雾。
- 雾的 `rangeFogFactor` 是 `smoothstep(near, far, viewZ)`；60–700 m 之外饱和到 1，RGB 变为雾色 `#c96a7a`，alpha 保留。
- P1 现有帧的差值掩码内平均 RGB 实测为 `(175.4, 87.2, 97.0)`，正好落在雾色 `(201, 106, 122)` 经 tonemap 的区间。

**影响**

- 1200–1800 m 的 patch 会渲染成一块纯雾色哑光带，L427 的“海平面有云”“无断线/双影”物理上不可能通过。
- 现有 P1 的“薄纱”观感也主要来自这层雾；Task 3 的分层门、Task 4 的暗底亮顶、Task 9 的 `tone_span` 都是在雾色上量。
- 关闭雾后 P1 的颜色/覆盖率基线会变，必须重新抓帧、重新标定。

**修法**

- 先给 dome 与 horizon 材质 `material.fog = false`，淡出与大气混色自己按距离/高度算。
- 这条必须排在 Task 3 之前；否则后续所有色调与量测都不可信。

### B2（P0）Task 9 唯一验收命令引用不存在的文件

**文档断言**

- 第 502 行：`python artifacts/dome-audit/measure.py ... --t0 artifacts/dome-audit/t0.png --t30 artifacts/dome-audit/t30.png`

**证据**

- `artifacts/dome-audit/` 只有 `measure.py`、`p1-on.png`、`p1-off.png`、`p1-t0.png`、`p1-t30.png`、`p1b-on.png`、`p1b-off.png`。
- 没有 `t0.png` / `t30.png`；`measure.py:45` 的 `load()` 直接 `Image.open`，会抛 `FileNotFoundError`。

**修法**

- 改成 `--t0 artifacts/dome-audit/p1-t0.png --t30 artifacts/dome-audit/p1-t30.png`，或直接省掉这两个 flag（`measure.py:50` 允许 `t0 = t30 = None`）。
- 顺带核对第 507 行的“共 8 帧（high/low 各 4）”：dome/cloudlook/sunoff × high/low × 前后帧的组合与 8 对不上，产物命名也要统一。

### B3（P0）验收指标早于量具

**文档断言**

- Task 3/5/6/7 的验收门使用 `blob_count`、`edge_grad_p95`、`row_peaks`。
- Task 9 才升级 `measure.py` 增加这三项（第 496 行）。

**证据**

- `artifacts/dome-audit/measure.py` 当前只输出 `coverage_pct`、`tone_span`、`row_stripes`、`banding_flips`、`drift_mean_abs`、`drift_max_abs`。
- 没有 `blob_count`、`edge_grad_p95`、`row_peaks`；Task 3 的“Task 9 量具先行可用 P1 版”与事实不符。

**影响**

- Task 3/5/6/7 在 Task 9 之前无法判门；执行者只能目测或跳门，验收记录会失真。

**修法**

- 把三项量具的实现前移到 Task 1 之前（或 Task 0），并先用 P1 旧帧回归；或者把对应门明确标成“Task 9 前只记录、不判门”。

### B4（P0）Task 7 不可执行：没有 update 调用、朝向、seed、y 区间

**文档断言**

- 第 377 行：`WorldView`（patch 跟随相机）。
- 第 379 行：`patchesFor(seed)`，正前方 ±40°、距离 1200–1800 m、3–8 团。
- 第 380 行：`initDomeHorizon(scene)`。
- 第 381 行：挂载 + `setDomeVisible` 级联。
- 第 423 行：`update` 只做相机跟随，patch 摆在相机前方固定方位/距离，随相机平移。

**证据**

- `src/world.ts:23-26` 的 `WorldView` 只有 `{ camera, radPerPixel }`，没有相机朝向；±40° 无法计算。
- `src/world.ts:277` 只调用 `dome?.update(time, sunDir, lastView)`；全计划没有 `horizon.update(...)` 的挂载调用，patch 不会跟随。
- `initDomeHorizon(scene)` 没有 seed/sunDir/palette 入参；`patchesFor(seed)` 拿不到 seed，挂载点也没有 seed 变量可传。
- 第 423 行“固定方位/距离”与第 379 行“正前方 ±40°”自相矛盾：前者是世界固定，后者是相机相对。
- patch 的 y 从未定义；平视时 1200 m 外、y≈380 的 patch 在 +15° 仰角内可见，但会落在 B1 的雾里。

**修法**

- `world.update` 内显式调用 `horizon?.update(t, sunDir, view)`。
- 朝向二选一并写死：扩 `WorldView` 加朝向（会波及 sea/puff 的消费方），或删掉 ±40° 只做固定世界方位。
- 签名改为 `initDomeHorizon(scene, { seed, bands, sunDir })`。
- 写明 patch 的 y 区间与验收机位的俯仰角。

### B5（P1）Task 1 的“省第二个 octave、改善 p95”因果错误

**文档断言**

- 第 42、49、86、536 行附近：修 `uOctaves` 漏写后，low 档“stops paying the second octave”，性能会改善。

**证据**

- `src/dome-cloud.ts:234` 的 `detailFine = texture3D(detailTex).sample(...)` 是**无条件求值**；第 237 行 `mix(detailBase, blended, uOctaves.sub(1))` 只是加权。
- 改 `uOctaves` 一次采样都省不掉；low 每步仍是 4 次 3D 取数 + 2 次 weather。
- 真实后果：low 的 detail 权重从 0 变 1（等价 `(detailBase + detailFine)/2`），细节变多，是视觉一致性修复，不是性能修复。
- `dome-cloud.ts:344-348` 的 `setQuality` 只写 `uSteps.value`，漏写 `uOctaves.value`，bug 本身属实。

**修法**

- 改 commit message 与 spec 叙事：“low 现在能看到第二 octave 的细节”，不要承诺 p95 改善。
- 真要省采样，另开任务，把 `detailFine` 包进 `If(uOctaves.greaterThan(1.5), ...)`，并接受 uniform 分支的成本。

### B6（P1）Task 4 的“调用纯函数”不可能，low 分支判据缺失

**文档断言**

- 第 210、252、545 行：`marchTransmittance(densities, deltaMetres, sigmaPerDensity)`，dome-cloud.ts 以 `DENSITY_SCALE` 调用；low 档走原单次探针。

**证据**

- `marchTransmittance` 是 TS 纯函数，TSL shader 内不能调用 TS 函数；第 252 行自己也写“与 marchTransmittance 同式”，说明是结构复制。
- `DENSITY_SCALE = 0.038`（`dome-cloud.ts:39`）、`LIGHT_PROBE_METRES = 120`（`:41`）、`transmittance`（`dome-cloud-light.ts:40`）素材本身对得上。
- low 档“走原单次探针”的分支判据没写；`uSteps`/`uOctaves` 都是 uniform 浮点，`If` 的条件必须落在某个 uniform 上。

**修法**

- 改成“在 `colorNode` 内以 `Fn` 内联复刻同式”，注释注明与 `marchTransmittance` 同式。
- 显式指定分支判据：`If(uOctaves.lessThan(1.5), 单探针, 3 采样)` 或新增 `uLightSamples`。
- 结构断言改成“出现 3 次 `densityAt` + `exp`”，不要数行数。

### B7（P1）Task 5 的 `ceiling(y)` 未定义，且缺 `sin` import

**文档断言**

- 第 279 行：`profile(y) = ceiling(y)·(0.72 + 0.28·sin(2π·(3y + φ)))`。

**证据**

- `ceiling(y)` 全计划只出现这一次，没有 Produces 定义，代码里也没有同名函数。
- `src/dome-cloud.ts` 当前全文 0 处 `sin(`，TSL 解构里没有 `sin`，照抄会 `ReferenceError`；需要从 `three/tsl` 补 import。
- 若把乘积乘在最终 `den` 上，会同时改光学厚度与 Task 4 的 τ/自阴影，两个任务互相污染。

**修法**

- 定义 `ceiling = smoothstep(slabBottom, slabTop, y)` 一类。
- 乘积落在 `dome-cloud.ts:241` 的 `body`（erosion 之前），只改几何不改吸收。

### B8（P1）Task 6 的 Files 漏了 `world.ts`，alpha 测试太弱

**文档断言**

- 第 317-318 行 Files 只列 `dome-cloud.ts` + `main.ts`。
- 第 363 行 Step 6 `git add src/dome-cloud.ts src/dome-cloud.test.ts src/main.ts src/world.ts`。
- 第 333 行测试 `expect(src).toMatch(/setCloudLook/)`。

**证据**

- `world.ts` 实际要改三处：`DomeLike` 加 `setCloudLook?`（`:148-156`）、`WorldHandles` 透传（照 `:250-252` 的 `setSunColor`）、启动灌入调用时机。
- 只 grep 方法名，撑不起“alpha 直通有真单测”；flat 分支的 `vec4(量化 vec3, alpha)` 形态没有被断言。

**修法**

- Files 补 `world.ts`。
- 测试至少断言 flat 分支的形状，或断言 `alpha` 不出现在量化表达式的参数里。

### B9（P1）Task 8 的“天空/云区钳制”按区域不可实现，符号易写反

**文档断言**

- 第 451 行：天空/云区 CoC 钳制；第 457 行：spike 定钳制阈值/区域。

**证据**

- post 阶段只有 `scenePass.getViewZNode()`（`src/post.ts:208`）与颜色，没有云 mask。
- 云 `depthWrite = false`（`src/dome-cloud.ts:329`），云、天空、1200 m 外的海在深度缓冲里共用背景值，无法按区域区分。
- 因此“区域钳制”实际等于“全局关掉远景 DOF”。
- `node_modules/three/examples/jsm/tsl/display/DepthOfFieldNode.js:375`：`const signedDist = this.viewZNode.negate().sub(this.focusDistanceNode);`。传进去的 `viewZ` 是负值，钳制远距离要 `viewZ.max(-farClamp)`；写成 `.min(positiveClamp)` 不会生效，写成 `.min(-farClamp)` 才是同义，但容易被误读为“全图最大 CoC”。

**修法**

- 按计划先 spike：`viewZ.max(-farClamp)` 再进 `dof`，抓 `?post=1/0` 看海面/云同时被牺牲多少。
- spike 文档里写明“这是全局关远景 DOF”；要真正分区，只能给云单开 mask（MRT/额外 pass），已超出“钳制”范畴。
- 注意 `DepthOfFieldNode` 的源码路径是 `examples/jsm/tsl/display/`，不是 `src/nodes/display/`。

### B10（P2）Task 1 测试窗口 600 字跨进 `update()`

**文档断言**

- 第 61-64 行：`src.indexOf('const setQuality')` 后 `slice(anchor, anchor + 600)`，断言体内出现 `uSteps.value` 与 `uOctaves.value`。

**证据**

- `const setQuality` 在 `dome-cloud.ts:344`，600 字窗口实测跨到第 364 行，已进入 `update()` 体。
- 将来把 `uOctaves.value` 写进 `update()`（每帧写也合法）测试会假通过。

**修法**

- 切到 `src.indexOf('\n  };', anchor)`；或窗口收到 400 字以内，并要求 `uSteps.value` 出现在 `uOctaves.value` 之前。

### B11（P2）杂项引用与命名

| 项 | 文档写法 | 实际 |
|---|---|---|
| world try/catch | `src/world.ts:189-195` | `:190-196` |
| P1 报告小节 | “§3.4” | review 的 §3 是 4 条列表项，没有 3.4 |
| hgPhase 的 4π | `src/dome-cloud.ts:248-251` | `:248-251` 是 `phaseAt` 定义，真正乘 4π 在 `:288` |
| 计划行数 | “约 420 行” | 549 行 |
| `PatchSpec` | 测试用 `p.distanceMetres` | 全计划没有定义字段 |
| 新模块 | `src/dome-horizon.ts` | 受 `module-graph.test.ts:20` 约束，非 test 文件不得静态 import `three/webgpu`/`three/tsl`，必须 `await import` |
| 命名 | `horizon?.setVisible` | `src/horizon.ts` 已存在（天空地平线），建议改 `domeHorizon`/`patchLayer` |

### 已核对正确

- `DOME_SLAB` base 380 / top 1150 / halfExtent 1800 / fadeStart 1200 / fadeEnd 1800（`dome-cloud-field.ts:17-27`）；`fadeEnd === halfExtent` 测试在 `dome-cloud-field.test.ts:26`。
- `SLOW_FRAME_MS = 24`（`world.ts:69`）；`DOME_DRIFT`（`dome-cloud-field.ts:109-120`）。
- `STEP_CURVE_POWER = 2.2`（`:43`）、`LIGHT_PROBE_METRES = 120`（`:41`）、`DENSITY_SCALE = 0.038`（`:39`）、`qualityParams`（`:57`，high 28/2、low 16/1）。
- `uSteps`/`uOctaves`（`:191-192`）、`mix`（`:237`）、`smoothstep(0.30, 0.46)`（`:239`）、`.mul(0.32)`（`:241`）、`FALLBACK_BANDS`（`:85-90`）、`uBand0-3`（`:187-190`）、`depthWrite = false`（`:329`）。
- `setQuality` 漏写 `uOctaves.value` 属实（`:344-348`）。
- `PUFF_BAND_THRESHOLDS = [0.2, 0.4, 0.68]`（`puff-cloud.ts:112`）、`puffBandIndex`（`:166`）、`cloudBands`（`sky-track.ts:58`）。
- `post.ts`：管线注释 `:6`、`POST_HIGH.dof = true` `:76`、`POST_LOW.dof = false` `:88`、`getViewZNode()` `:208`、`dof(...)` `:225`。
- P1 基线（coverage 29.78%、tone_span 0.327、drift 3.16/255、桌面 p95 20.9 ms）与 `docs/superpowers/reviews/2026-11-09-dome-cloud-p1-review.md` 一致。
- Task 3/4 的 fail-first 前提成立：`dome-cloud.ts` 当前不含 `0.12/0.22/0.34/0.72`，也不含 `marchTransmittance`。

---

## 4. 飞行手感设计

文件：`docs/superpowers/specs/2026-11-10-flight-feel-improvement-design.md`

### 复现口径

直接调用 `src/game.ts` 的 `createFlightState(startY)` 与 `stepFlight(state, dt, { x, y })`，`dt = 1/60`，`y = -1` 表示满杆上拉（`pitchTarget = -MAX_PITCH * sy`，负 sy 抬头），`y = +1` 表示压杆。从进入 hover 后开始计时。

| startY | sy=-1 时间 / 掉高 | sy=+1 时间 / 掉高 |
|---|---|---|
| 60 | 5.25 s / 127.17 m（触海） | 2.87 s / 46.9 m |
| 120 | 6.85 s / 187.17 m（触海） | 未单独采样 |
| 240 | 8.08 s / 233.39 m（触海） | 未单独采样 |

补充：`sy=0` 与 `sy=-0.5` 在 60/120/240 也全部不空中改出，靠触海；`sy=+0.5` 为 3.63 s / 75 m。

### F1（P0）核心基线反了

**文档断言**

- 第 37 行：“一直仰飞 pin 住的 worst case：hover 0.58 s + fall 约 2.3–2.8 s = 全程约 2.9–3.4 s，掉高约 30–50 m。”
- 第 45 行：2.3–2.8 s 后“切回 cruise，vy 清零”。

**证据**

- 满杆上拉（`sy=-1`）从 hover 起：60 m 需 5.25 s、掉 127.17 m；120 m 需 6.85 s、掉 187.17 m；240 m 需 8.08 s、掉 233.39 m；全部由 `integrate` 的触海分支强制 cruise（`game.ts:373-376`），不是空中改出。
- 文档的 2.87 s / 46.9 m 正好是压杆（`sy=+1`）的数据。
- 机制原因：`stepFall` 的 `pitchTarget = FALL_PITCH + (playerPitch - FALL_PITCH) * authority`；满杆上拉时 `playerPitch=+1.2`，`authority` 随速度升高把目标从 -1.1 拉向 +1.2，俯冲角变浅，`speedTarget = 6 + (-vy)*max(0,-sin(pitch))` 被压在约 16.6，永远达不到 `STALL_SPEED=22`，于是永不切 cruise。

**影响**

- Q1 的现状判断、时间预算、掉高预算全部建立在错误输入上；后续 pushover 的 1.2 s/15 m 目标也随之失真。
- 这不是“数值偏乐观”，是“拉杆/压杆输入反了”。

**修法**

- 重写第 37–47 行：把“满杆上拉”和“压杆”分成两行数据；明确“持续上拉 = 必触海”。
- 若目标是修复“持续上拉”，方案必须直接改 `stepFall` 的 authority/pitchTarget 反馈，而不是只加 pushover。

### F2（P0）fallback 与松杆门会把 bug 打回去

**文档断言**

- 第 67 行：“只有玩家在 pushover 全程仍满杆上拉（`sy<-0.85` 不松杆），才 fallback 进现有 fall（nose -1.1）。”
- 同段：“hover 准入加松杆门：上一次 pushover 后未检测到 `sy>-0.3` 则不进下一次 hover。”

**证据**

- 用户报告的正是“一直仰飞 pin 住”；`sy<-0.85` 恰好把这类输入送回现有 fall，而现有 fall 在满杆上拉时永不改出（见 F1）。
- 松杆门不对称：抬头是 `sy<0`；`sy=-0.4` 这种“还拉着”被判为未松杆，`sy=+1` 这种“满压”反而满足 `sy>-0.3`，会被当成松杆。

**修法**

- 松杆门改 `abs(sy) < 0.3`。
- fallback 只在“确实松杆后仍失速”时触发；持续上拉应进入新的 pushover/强制改出，而不是旧 fall。

### F3（P0）1.8 s / <15 m 的硬保证自相矛盾

**文档断言**

- 第 66 行：“失控总时长锁死在 `0.58+1.2=1.8s` 以内，掉高 `<15m`；fall 超过 `FALL_HARD_CAP 1.6s` 无论速度多少强制进 pushover。”

**证据**

- 若 fall 先跑满 1.6 s，再进 1.2 s pushover，最坏是 `0.58 + 1.6 + 1.2 = 3.38 s`，不是 1.8 s。
- 实测 fall 1.6 s 的掉高约 21.6 m，已经超过 15 m；pushover 段即使不再掉高，总掉高也 >15 m。
- 第 64 行“速度从 0 用 `FALL_SPEED_ATTACK` 重建”：1.2 s 只到 `1 - e^(-2.2*1.2) = 92.9%` 的目标；目标 18 时约 16.7，仍低于 `RECOVERY_SPEED 18`，除非直接 snap。

**修法**

- 二选一：把 hard cap 算进总时长（3.38 s），或把 hard cap 压到 0.8 s 左右并重新算掉高。
- 明确 pushover 结束时是 snap 到 18 还是继续加速；不要同时承诺“1.2 s 到 18”和“指数重建”。

### F4（P1）机制描述错误：不是“一头按到 -1.1”，authority 也不是线性

**文档断言**

- 第 35 行：“`stepFall` 一头把 pitch 按到 -1.1，authority 要到 `STALL_SPEED*0.6→1.0` 才线性回来。”
- 第 39–44 行：authority 0.2 / 0.545 / 0.773（speed 15/18/20）。

**证据**

- `game.ts:314-326`：`pitch += (target - pitch) * attack(d, PITCH_ATTACK*0.6)`，是指数逼近，不是瞬间按到 -1.1；满杆上拉时 pitch 最低约 -1.082，随后被 authority 拉回 -0.337。
- `authority = smoothstep01((speed - 13.2) / 8.8)`，不是线性；speed 15/18/20 实际为 0.108 / 0.568 / 0.869。

**修法**

- 按代码重写机制段；表里的 authority 用 smoothstep 值，并注明“满杆上拉时 target 会被拉回，不会停在 -1.1”。

### F5（P1）vy 表偏乐观

**文档断言**

- 第 42–44 行：1.0 s vy -9.8、speed ~11；1.5 s -14.7 / ~15；2.0 s -19.6 / ~19。

**证据**

- 实测：1.0 s vy -4.09 / speed 4.1；1.5 s -8.99 / 9.13；2.0 s -13.9 / 14.05；2.5 s -18.8 / 16.65。

**修法**

- 用实测表替换；同时说明“speed 到 16.6 就平台，不再涨”。

### F6（P1）“高空 40 m 能回来”不成立

**文档断言**

- 第 47 行：“高空 zoom 顶掉 40m 能回来；40m 以下仰飞失速，速度还没回到 22 就先拍地板，全靠 `integrate:373-376` 捞回来。”

**证据**

- 满杆上拉在 60/120/240 m 全部靠触海；40 m 不是分界。
- 只有压杆/松杆才可能空中改出。

**修法**

- 改成“持续上拉必触海；能否空中改出取决于杆量，不取决于高度”。

### F7（P1）Q3 的 FOV 现状算错

**文档断言**

- 第 111 行：“现在只有 dive 给 +3（`DIRECTOR.FOV_DIVE`）。改成 `base 60 + speed01*4 + dive01*3`。”

**证据**

- `camera-rig.ts:205/213`：`fov = baseFov + tuningNow.fovKick * speed01`。
- `game.ts:590`：`fovKick = Math.min(CAM_FOV_KICK, DIRECTOR.FOV_BASE + directed.fovExtra)`；`DIRECTOR.FOV_BASE = 6`、`FOV_DIVE = 3`、`directed.fovExtra = 3*dive01`。
- 所以实际是 `fovKick = 6 + 3*dive01`，平飞满速 66°、俯冲满速 69°。
- 文档“只有 dive 给 +3”漏了基线 +6；提议的 `4 + 3` 最多 67°，反而比现在低 2°。

**修法**

- 先确认目标：要更广还是更稳；若加 FOV，不能把基线 6 降到 4。
- 若想增强速度感，考虑 `base 60 + 6 + 3` 的现有上限内做曲线重分配，而不是降低总量。

### F8（P1）Q5 的 trauma 衰减写反了

**文档断言**

- 第 148 行：“出云：0.4s 指数松开（trauma 自然衰减即可，`TRAUMA_DECAY 1.15` 约 0.8s 回零，刚好）。”

**证据**

- `feel.ts:66-72`：`updateTrauma` 是线性 `t - step*dt`，注释明确写“Linear decay”。
- 0.22 trauma 约 0.19 s 回零；0.9 才约 0.78 s。
- “0.4 s 指数松开”与“0.8 s 回零”互相矛盾。

**修法**

- 改成线性衰减，并按目标 trauma 重算时间；若确实要指数，改代码并重新验证。

### F9（P1）Q2 的“仍能继续顶杆下探”不准确，分层不一致

**文档断言**

- 第 76 行：“现在俯冲到海面仍能继续顶杆下探。”
- 第 82–90 行：`SEA_CUSHION_Y=18`、`SEA_RUMBLE_Y=12`，分层用 10<y<18、y<10。

**证据**

- `integrate` 触底会强制 `pitch≥0.12`、`speed≥22`、进 cruise（`game.ts:373-376`），不会让位置继续下探；触底前仍可压杆，但“继续下探”不成立。
- `SEA_RUMBLE_Y=12` 没有在分层逻辑里使用；6→18 与 10/18 的边界不一致。

**修法**

- 改成“触底会强制托举，但触底前仍可压杆”；统一 6/12/18 三层。

### F10（P2）锚点与文字

- 第 13 行 `:75-77` 偏一行：`THRUST` 在 76、`DRAG_K` 在 78。
- 第 23 行有高棉字符“ជាមួយ”；第 120 行“按.Visibility”排版错。
- `stepFlight` 的 `freeze` 只停 airframe，不停游戏时钟；hover 的 0.08 s 是机架 hit-stop，不是世界暂停。文档没有区分。

### 已核对正确

- hover 0.58 s = `HOVER_HOLD 0.5 + HOVER_FREEZE 0.08`。
- `game.ts:285-339,349-378`、`SKIM 7/14`、`29.7Hz`、`CAM_FOV_KICK 9`、HIT 值、ENTER/EXIT、速度线删除注释均属实。
- 云 25 朵（`puff-cloud.ts:53`）、ring cell 6.4（`src/sea/rings.ts:28`）、CONTRAIL 阈值 `0.42/0.72`（`game.ts:677`）、音频 intensity `game.ts:668-672`。
- `feel.ts:295-313` 单 ring、`SKIM_RING_LIFE 0.55`、wake `skim*0.45`（`feel.ts:386`）。
- `HIT_CLOUD 0.9` 是边沿单次（`director.ts:39/77-82`）；`IN_CLOUD.ENTER/EXIT 0.999/0.985`（`in-cloud.ts:32`）；`whiteoutHold`（`game.ts:577-579`）。

---

## 5. 复现命令

### 5.1 基线

```bash
npx vitest run
git status --short
git merge-base --is-ancestor 353abdf HEAD && echo ancestor
```

### 5.2 飞行模拟（最小脚本）

```ts
import { describe, it } from 'vitest';
import { createFlightState, stepFlight } from '../src/game';

describe('flight audit', () => {
  it('full back-stick from hover', () => {
    let s = createFlightState(60);
    let hoverAt = -1;
    let cruiseAt = -1;
    let yAtHover = 0;
    for (let i = 0; i < 60 * 30; i++) {
      s = stepFlight(s, 1 / 60, { x: 0, y: -1 });
      const t = i / 60;
      if (hoverAt < 0 && s.phase === 'hover') { hoverAt = t; yAtHover = s.pos.y; }
      if (hoverAt >= 0 && cruiseAt < 0 && s.phase === 'cruise') {
        cruiseAt = t;
        console.log({ hoverAt, cruiseAt, yAtHover, y: s.pos.y, waterHit: s.waterHit });
      }
    }
  });
});
```

### 5.3 雾的像素证据

```python
import numpy as np
from PIL import Image
on = np.asarray(Image.open('artifacts/dome-audit/p1-on.png').convert('RGB')).astype(np.int16)
off = np.asarray(Image.open('artifacts/dome-audit/p1-off.png').convert('RGB')).astype(np.int16)
m = np.abs(on - off).max(axis=2) > 8
print(int(m.sum()), [round(float(on[..., i][m].mean()), 1) for i in range(3)])
# 99779 [175.4, 87.2, 97.0]
```

### 5.4 Task 9 文件检查

```bash
ls artifacts/dome-audit
# 只有 measure.py / p1-on / p1-off / p1-t0 / p1-t30 / p1b-on / p1b-off
# 没有 t0.png / t30.png
```

## 6. 限制与未覆盖

- 未打开浏览器：调色面板、P1.5/P2、horizon patch 均未实现，网页没有可测对象；飞行用无头模拟替代手飞。
- 飞行模拟覆盖 60/120/240 m、`sy=-1/-0.5/0/+0.5/+1`；未覆盖风、bank、鼠标抖动等耦合输入。
- 穹顶的雾结论是源码级（`NodeMaterial.fog` 默认 true + 场景雾 60–700）加现有帧像素统计；未在关闭雾后重新抓帧（因为代码还没改）。
- 文中标注“计划行号”的条目，以当前文档版本为准；文档若有改动需重新对行。
- 两个并行子审计通道（调色面板、飞行）在本轮网络中断中失败；本报告中的对应结论均由主审独立复核，未采用未验证的子审计结论。
