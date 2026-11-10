# 三份文档交叉审核——修复指南

- 日期：2026-11-10
- 依据：`docs/superpowers/reviews/2026-11-10-three-docs-audit.md`（全部断言已经源码级验证 + 飞行模拟实测）
- 用途：被审核文档的撰写人**拿着本指南逐条改原文**，无需再跑验证脚本
- 修复对象：三份 markdown 文档本身，不改源码
- 分类：🟢 可直接改（纯文字/数值/逻辑修正）；🟡 需要实现前置条件或实验验证后再定稿

---

## 0. 修复对象

| 编号 | 文件 | 行号范围 |
|---|---|---|
| 调色面板 | `docs/superpowers/plans/2026-11-09-debug-color-panel.md` | 全文 182 行 |
| 穹顶云 | `docs/superpowers/plans/2026-11-10-dome-cloud-p15-p2-horizon.md` | 全文 549 行 |
| 飞行手感 | `docs/superpowers/specs/2026-11-10-flight-feel-improvement-design.md` | 全文 219 行 |

---

## 第一份：调色面板计划（4 项，全部 🟢 直接改）

### D1 （P0）`?trackpatch=` 复现通道不存在

**位置**：第 45 行 Global Constraints 第 6 条、第 99 行 `exportColorState` 返回值、第 116 行 Step 3.5、第 146 行 Step 3 人工验收、第 163 行验证清单

**问题**：原文承诺 URL 通道 `?trackpatch=...` 能复现，但 `main.ts:184` 的 `qaParams` 不读 trackpatch，`qa.ts` 7 个 parser 无 parseTrackPatch，`grep -R "trackpatch" src` 零结果。URL 通道复现必挂。

**两种修法，选一种写进文档**：

**方案 A（补实现，推荐）——改 4 处**：

1. 第 45 行 Global Constraints 第 6 条"可复现闭环"改为：

```
6. **可复现闭环**：面板调出的任何画面，一条命令能重放（`exportColorState` 导出 `?sun=`＋patch JSON＋控制台命令）；URL 通道需 `qa.ts` 新增 `parseTrackPatch(raw)` 并在 `main.ts` 启动时调用 `qa.setTrackPatch`。URL 过长时给出明确上限。
```

2. 第 82-83 行 Task 1 的 Files 列表加一项：

```
- Modify: `src/qa.ts`（新增 `parseDebugColor(raw)` 真值表 + `parseTrackPatch(raw)` JSON 解析）
```

3. 第 116 行 Step 3.5 里，`exportColorState` 的 repro 字段改为同时返回 URL 和控制台命令：

```
   `exportColorState()` 从 `sun.snapshot()` 取 az/el、
   URL：拼接 `?sun=az,el&trackpatch=encodeURIComponent(JSON.stringify(patch))`
   控制台：`qa.setSun(az, el); qa.setTrackPatch(${JSON.stringify(patch)});`
   repro 字段包含两者。
```

4. 第 146 行 Step 3 人工验收清单最后一条 + 第 163 行验证清单第 3 条，改为：

```
  复制命令新开无痕窗口粘贴（**URL 和控制台各一遍**）画面一致（两条路径都能复现）
```

**方案 B（删 URL 通道，更简单）——改 3 处**：

1. 第 45 行 Global Constraints 第 6 条改为：

```
6. **可复现闭环**：面板调出的任何画面，一条控制台命令能重放（`exportColorState` 只返回 `qa.setSun(az, el); qa.setTrackPatch(patch)` 控制台命令）。不承诺 URL 通道——patch JSON 可能超过 URL 长度限制。
```

2. 第 116 行 Step 3.5 删除 `?sun=az,el&trackpatch=...` 拼接描述，只保留控制台命令。

3. 第 146 行、第 163 行的"URL＋控制台各一遍"改为"控制台命令能重放"。

---

### D2 （P1）Task 0 基线过时

**位置**：第 70-71 行

**原文**：

```
- [ ] `git status` 对账：工作树干净（`353abdf` 等 6 提交已落库），结果记进度段。
- [ ] `npx vitest run` 全绿基线（47 文件 / 405 用例）＋`npx tsc --noEmit` 干净。
```

**改后**：

```
- [ ] `git status` 对账：记录未跟踪项（当前工作树含 `.dsh-dev.log`、`.trae-html-share-packages/`、`.video_agent/`、`.workbuddy/`、`.zcode/`、`docs/superpowers/specs/2026-11-10-flight-feel-improvement-design.md`、本审核报告），确认都不影响构建后开工。
- [ ] `npx vitest run` 全绿基线（**52 文件 / 470 用例**）＋`npx tsc --noEmit` 干净。
```

**同时改**：第 118 行、第 162 行出现的 `405 用例` 全部改成 `470 用例`。

---

### D3 （P2）行号漂移

**位置**：第 74 行

**原文**：

```
- [ ] 对行号：`main.ts` syncSun（~260-296）、qa 挂载（~352-399）、`qa.ts` 解析器现状；漂移则以现状为准。
```

**改后**（**实际行号**，来自 `main.ts` 当前版本）：

```
- [ ] 对行号：`main.ts` syncSun 门控 `let lastSunVersion = -1`（**L267**）、`const syncSun` 定义（**L275**）、门控条件 `if (sun.version === lastSunVersion) return;`（**L276**）、qa 对象挂载（**L370**）、`setSun`（**L399**）、`getSun`（**L407**）、`selfCheck`（**L412**）；`qa.ts` 当前 7 个 parser：parsePos / parsePuffVisible / parseDomeVisible / parseSeaVisible / parseSeaDebug / parseSeaNoChop / parseSunSpin；漂移以 grep 为准。
```

---

### D4 （P2）`linearToSrgbCss` 没有直接单测

**位置**：Task 1 全段（约 L76-L119）

**问题**：Task 1 说"新增并导出 `linearToByte`，让 `linearToSrgbCss` 复用它"。但 `src/sky-track.ts:93` 的 `linearToSrgbCss` 当前是未导出函数、内部自己算 `Math.round(clamp(s)*255)`，现有测试只 pin `srgbToLinear` 的往返，没 pin `linearToSrgbCss` 的输出字符串。如果重构时舍入/钳制行为变了，会悄悄改变天空 CSS 颜色。

**修法——在 Task 1 Step 1（写失败测试）里加一条**：

```ts
// 新增：重构前先钉死现有 linearToSrgbCss 输出，再抽 linearToByte
it('pins current linearToSrgbCss output before refactor (must NOT regress sky CSS)', () => {
  expect(linearToSrgbCss(0)).toBe('#000000');
  expect(linearToSrgbCss(1)).toBe('#ffffff');
  expect(linearToSrgbCss(0.5)).toBe('#bcbcbc'); // 0.5 sRGB ≈ 0.5^(1/2.2) ≈ 0.73 → round 186
  expect(linearToSrgbCss(-0.1)).toBe('#000000'); // 超下界钳制
  expect(linearToSrgbCss(1.5)).toBe('#ffffff');  // 超上界钳制
});
```

这条测试要先跑绿（当前实现必须能过），然后再重构 `linearToSrgbCss` 为复用 `linearToByte`，跑完再确认还是绿。

---

## 第二份：穹顶云 P1.5/P2 计划（11 项，9 项 🟢 + 2 项 🟡）

### B1 （P0，🟡 需实现前置）雾会把 1200–1800 m 的 horizon patch 全糊成雾色

**位置**：Task 7 全文（约 L369-438）、Task 3/4/5/9 的参数标定描述

**问题**：`main.ts:73` 设置了 `scene.fog = new THREE.Fog('#c96a7a', 60, 700)`，`dome-cloud.ts:325-330` 新建 `NodeMaterial` 时没设 `material.fog = false`，而 `NodeMaterial.js:77` 默认 `this.fog = true`。700m 开外雾饱和到 1，1200-1800m 的 patch 会渲染成纯雾色哑光带，L427 的验收条件"海平面有云""无断线/双影"物理上不可能通过。

**修法——重排任务顺序 + 在 Task 1 之前插入一个雾开关**：

1. 在 Task 1 之前插入 **Task 0.5：关雾**（放在 Task 0 开工对账之后、Task 1 之前）：

```markdown
### Task 0.5: 穹顶云材质关雾（P0 前置，否则 Task 3/4/5/9 的参数标定全无效）

**Files:**
- Modify: `src/dome-cloud.ts`（`NodeMaterial` 构造处加一行）

**Interfaces:**
- dome-cloud.ts 现有 `material.fog` 未设置，NodeMaterial 默认 true。
- 对照：`puff-cloud.ts:279/360`、`sky-webgpu.ts:302`、`sea/material.ts:472` 都显式关雾。

- [ ] **Step 1: 一行修改**

在 `const material = new NodeMaterial();` 之后立即加：
```ts
material.fog = false; // 否则 scene.fog('#c96a7a', 60, 700) 会把 700m 外的云全糊成雾色
```

- [ ] **Step 2: 全量回归**

Run: `npx vitest run` → 全绿（52 文件）；`npx tsc --noEmit` → 0 错误

- [ ] **Step 3: 关雾后重抓 P1 基线帧**（重要：关雾后颜色/覆盖率基线会变，Task 9 的量测基准需要重新标定）

Run: `?qa=frozen & qa.step(1800)` 同机位，抓新的 `p1-on.png` / `p1-off.png`；跑 `measure.py` 得到新的 P1 基线 coverage / tone_span / drift / banding_flips。

- [ ] **Step 4: Commit**

```bash
git add src/dome-cloud.ts
git commit -m "fix(dome): disable fog on dome material so 700m+ renders are not all fog color"
```
```

2. 在 Task 3 Step 3、Task 4 Step 4、Task 5 Step 3、Task 9 Step 2 里，把所有"抓帧标定"改成：

```
关雾后抓帧（Task 0.5 已先跑），用新的 P1 基线作参照。
```

---

### B2 （P0）Task 9 验收命令引用不存在的文件

**位置**：第 502 行

**原文**：

```
Run: `python artifacts/dome-audit/measure.py artifacts/dome-audit/p1-on.png artifacts/dome-audit/p1-off.png --rect 474.875,0,434.25,772 --t0 artifacts/dome-audit/t0.png --t30 artifacts/dome-audit/t30.png`
```

**问题**：`artifacts/dome-audit/` 目录里只有 `p1-t0.png` / `p1-t30.png`，没有裸名 `t0.png` / `t30.png`。`measure.py:50` 允许 `t0 = t30 = None`（不传 flag 即跳过时序量测）。

**改后**（二选一）：

**选项 A（改路径）**：

```
Run: `python artifacts/dome-audit/measure.py artifacts/dome-audit/p1-on.png artifacts/dome-audit/p1-off.png --rect 474.875,0,434.25,772 --t0 artifacts/dome-audit/p1-t0.png --t30 artifacts/dome-audit/p1-t30.png`
```

**选项 B（删 flag，更简洁）**：

```
Run: `python artifacts/dome-audit/measure.py artifacts/dome-audit/p1-on.png artifacts/dome-audit/p1-off.png --rect 474.875,0,434.25,772`
```

**同时改**：第 507 行（Step 3）"共 8 帧（high/low 各 4）"的描述修正为：

```
固定 `?pos=` 与 `?qa=frozen`：`?dome=1/0` 各一份 × high/low 两档 × 前后帧（qa.step(0) / qa.step(1800)）= **8 对 16 帧**。命名统一为 `p15-high-on-t0.png / p15-high-on-t30.png / p15-high-off-t0.png / p15-high-off-t30.png` 等。
```

---

### B3 （P0）验收指标早于量具

**位置**：Task 3 Step 3、Task 4 Step 4、Task 5 Step 3、Task 6 Step 4 里出现 `blob_count` / `edge_grad_p95` / `row_peaks` 的门控描述

**问题**：这三个指标只在 Task 9 升级 `measure.py` 后才存在（Task 9 Step 1），Task 3/5/6/7 执行时现有量具只有 coverage / tone_span / row_stripes / banding_flips / drift 五项。执行者到时只能目测或跳门。

**修法——统一加一行前置说明**：

在 Task 3/4/5/6 的"Step 3/4 抓帧标定/验证"开头加：

```
**前置说明**：`blob_count` / `edge_grad_p95` / `row_peaks` 三项量具在 Task 9 才升级。本任务执行时只有 P1 版量具（coverage / tone_span / drift / banding_flips / row_stripes），**blob_count 门先目测 blob 数落 3–8，edge_grad 先目测边缘锐度高于 P1，row_peaks 先目测行剖面 ≥ 2 峰**。Task 9 升级量具后回跑本步骤重新判门。
```

---

### B4 （P0，🟡 需确认 WorldView 影响）Task 7 四硬伤

**位置**：Task 7 全文（L369-438）

**四问题 + 四修法——全部改 Interfaces 段**：

#### 问题 1：没有 `horizon.update(...)` 挂载调用

**原文**：第 205 行（审核报告证据）"`world.ts:277` 只调用 `dome?.update(time, sunDir, lastView)`；全计划没有 `horizon.update(...)` 的挂载调用"

**修法——Task 7 Step 3 实现段追加**：

```
world.update 内新增调用链（参照 dome?.update 的模式）：
  horizonHandles?.update?.(t, sunDir, view);
（如果 DomeHorizonHandles 有 update 方法的话）
```

#### 问题 2：朝向（正前方 ±40° vs 世界固定）

**原文**：第 379 行 `patchesFor(seed)` 说"正前方 ±40°"，但第 423 行 Step 3 实现段写"patch 摆在相机前方固定方位/距离"——前者是相机相对，后者是世界固定。`WorldView`（`world.ts:23-26`）只有 `{ camera, radPerPixel }`，没有相机朝向。

**两种选择，写清楚**：

```markdown
**patch 散布方向二选一**（必须在 Step 3 开头拍板）：
A. **相机相对 ±40°**：需要把 `WorldView` 加朝向字段 `forwardAzimuthDeg`。
   代价：会波及 puff-cloud、sea 等消费 WorldView 的地方。
B. **世界固定方位 ±40°**（推荐）：删掉"正前方"描述，写成"patch 散布在世界坐标系 ±40° 的扇区"，只跟随相机平移，不跟随相机旋转。
   好处：不改 WorldView 接口；patch 不会晃得头晕。
**选 B，重写 Step 3 实现段**：
```

**改后 Step 3 实现段**：

```
面片用 puff 同款四档色（`cloudBands`），只读调色单源；
**update 只做相机跟随平移，patch 朝向在 initDomeHorizon 时根据 seed 在世界坐标系 ±40° 扇区内一次性定死**（不跟随相机旋转，避免 patch 随视角晃）；
远近淡出复用 fadeAt 的 1200→1800 口径。
patch y 区间 = `DOME_SLAB.base - 30 ~ DOME_SLAB.base + 60`（即 350~440 m），贴海平面上方，避免与 deck（380~1150 m）的低部重叠——**Task 0.5 关雾后此区间不会被 fog 糊**。
验收机位俯仰角 = 0°（纯平视），避免俯角看到 patch 顶或仰角看到 patch 底。
```

#### 问题 3：`initDomeHorizon` 签名无 seed/sunDir/palette

**原文**：第 380 行 `initDomeHorizon(scene)` 无参

**改后 Interfaces 段 Produces**：

```
  - `initDomeHorizon(scene, { seed, bands, sunDir }): DomeHorizonHandles`
    seed 决定 patch 散布确定性、bands 决定 patch 颜色（`cloudBands`）、sunDir 决定 patch 亮度偏移；
    world.ts 挂载点从 DomeCloud 初始化链路拿到这些参数，透传进去。
```

#### 问题 4：patch y 未定义

已在问题 2 的修法里一并解决（写死 y 区间 350~440m，验收机位 0° 俯仰）。

---

### B5 （P1）Task 1 的"省第二个 octave、改善 p95"因果错误

**位置**：Task 1 全文 + 第 52 行设计注

**问题**：`dome-cloud.ts:234` 的 `detailFine = texture3D(detailTex).sample(...)` 是无条件求值，改 `uOctaves` 省不掉一次采样，low 档每步仍是 4 次 3D 取数。真实效果是视觉一致性修复（low 现在能看到第二 octave 细节，不是省采样）。

**修法——Task 1 Step 5 Commit message 和设计注**：

第 52 行设计注原文：

```
设计 §11.5：low 档一直在付第二个 detail octave（每步 4 次 3D 取数）。本轮第一件事修掉，否则后面所有性能数都量在漏水的桶上。
```

**改后**：

```
设计 §11.5：`setQuality` 漏写 `uOctaves.value`，导致 low 档 `uOctaves` 永远保持 high 档初始值 2。
修完后 low 的 `mix(detailBase, blended, uOctaves.sub(1))` 权重变为 0，回到纯 detailBase——**是视觉一致性修复，不是性能修复**（detailFine 采样无条件执行，改 uniform 不省采样）。
commit message 写"视觉修复"，不写"性能修复"；不要把 low 的 p95 改善归因于此。
```

Task 1 Step 5 的 commit message：

**原文**：`fix(dome): setQuality writes uOctaves so low stops paying the second octave`

**改后**：`fix(dome): setQuality writes uOctaves so low octave matches visual (uniform fix, not perf fix)`

---

### B6 （P1）Task 4 的"调用纯函数"不可能，low 分支判据缺失

**位置**：Task 4 Interfaces + Step 3

**问题**：第 210 行说"dome-cloud.ts 以 DENSITY_SCALE 调用 marchTransmittance"——TSL shader 内不能调用 TS 函数。low 档"走原单次探针"的分支判据没写。

**修法——重写 Interfaces 段**：

```markdown
- Produces:
  - `marchTransmittance(densities: readonly number[], deltaMetres: number, sigmaPerDensity: number): number`（**dome-cloud-light.ts 的 TS 纯函数**，用于测试和文档注释；**dome-cloud.ts 的 TSL shader 内不调用它**，而是在 `colorNode` 里用 `Fn(...)` **内联复刻同式**，注释注明"与 marchTransmittance 同式"。shader 结构断言改成"dome-cloud.ts 内出现 3 次 `densityAt` + 3 次 `exp`"）
  - march 内 `density > 0.12` 才沿 `uSunDir` 取 k=1..3（`Δ = LIGHT_MARCH_DELTA_METRES = 40`）求和；
    **low 档分支判据**：`If(uOctaves.lessThan(1.5), 单探针 original, 三采样)`（复用现有 `uOctaves` uniform，不新增）。
    单探针路径保留 `LIGHT_PROBE_METRES` 原实现不变。
```

---

### B7 （P1）Task 5 的 `ceiling(y)` 未定义，且缺 `sin` import

**位置**：Task 5 Interfaces Produces 段 + Step 3 实现段

**问题**：`ceiling(y)` 全计划只出现一次，无处可寻；TSL 里没有 `sin` import 会 ReferenceError；乘积乘在最终 den 上同时改光学厚度和自阴影，污染 Task 4。

**修法——重写**：

```markdown
- Produces: `profile(y): number`（**内联定义**，不是外部函数）
  ```
  const ceiling = smoothstep(DOME_SLAB.base + 20, DOME_SLAB.base + 100, y);
  // ceiling 在云底部从 0 平滑升到 1，上界之后恒为 1
  ```
  完整调制式：`profile = ceiling.mul(float(0.72).add(float(0.28).mul(sin(mul(PI, mul(2, add(mul(3, y), phi))))));`
  - `sin` 需从 `three/tsl` import（加进 dome-cloud.ts 顶部解构）
  - 乘积落在 **body**（`dome-cloud.ts:241` erosion 之前），只改几何，不改 `den` / 光学厚度 / Task 4 的 τ。
  - φ = 与 puff cloud 不同的 seed（避免同相位条纹）。
```

Step 1 测试也需相应修改（把 `expect(src).toMatch(/sin\(/)` 改成断言 TSL `sin` 解构和 ceiling 定义）。

---

### B8 （P1）Task 6 的 Files 漏了 `world.ts`，alpha 测试太弱

**位置**：Task 6 Files + Step 1 测试

**问题**：Files 只列 dome-cloud.ts + main.ts，但实际 world.ts 需改 3 处（`DomeLike` 加 `setCloudLook?`、`WorldHandles` 透传、启动灌入调用时机）。alpha 测试只 grep 方法名，撑不起"alpha 直通有真单测"。

**修法**：

1. **Files 段补 world.ts**：

```
**Files:**
- Modify: `src/dome-cloud.ts`（`uLook` uniform + 输出分支）、`src/main.ts`（`?cloudlook` 接线）、**`src/world.ts`**（`DomeLike` 加 `setCloudLook?` 可选接口、`WorldHandles.setCloudLook` 透传给 `dome?.setCloudLook`）
- Test: `src/dome-cloud.test.ts`（分支存在 + alpha 直通断言）
```

2. **Step 1 测试——把 alpha 断言改强**：

```ts
// 原有
it('flat cannot reshape the cloud: alpha accumulation ignores uLook', () => {
  const src = readFileSync(new URL('./dome-cloud.ts', import.meta.url), 'utf8');
  const alphaLines = src.split('\n').filter((l) => l.includes('accA'));
  expect(alphaLines.length).toBeGreaterThan(0);
  for (const l of alphaLines) expect(l).not.toMatch(/uLook/);
});

// 新增：断言 flat 分支的输出 vec4 形状
it('flat path preserves existing alpha exactly (vec4 colorPart, unchangedAccA)', () => {
  const src = readFileSync(new URL('./dome-cloud.ts', import.meta.url), 'utf8');
  // flat 分支应出现类似 vec4(quantizedColor, originalAccA) 的结构
  // alpha 直通的标志：最后一次 accA 被赋值后，没有再被 uLook 或任何 flat 相关变量乘/加
  const afterFinalAccA = src.match(/accA.*=/g);
  const lastAccAIndex = src.lastIndexOf('accA');
  const tailAfterLastAccA = src.slice(lastAccAIndex);
  expect(tailAfterLastAccA).not.toMatch(/uLook.*accA|accA.*uLook/);
});
```

---

### B9 （P1，🟡 spike 后定稿）Task 8 的"天空/云区 CoC 钳制"按区域不可实现

**位置**：Task 8 全文

**问题**：post 阶段只有 viewZ 和颜色，没有云 mask；云 depthWrite=false，云/天空/1200m 外海在深度缓冲里共用远平面值，无法按区域区分。"区域钳制"等于"全局关远景 DOF"。钳制方向易写反。`DepthOfFieldNode` 源码不在 `src/nodes/display/` 而在 `examples/jsm/tsl/display/`。

**修法——Task 8 Step 1 spike 文档模板**：

```markdown
# DOF 云糊修复 spike

## 实测前提（Task 0.5 已先关 dome 雾）
关雾后 dome 的 NodeMaterial.fog=false 已落地，云的真实颜色/coverage 不再被雾色污染。

## 结论（先在代码里 spike 验证，再决定是否合入）
**本 spike 是"全局关远景 DOF"，不可能做到"只云不关海"**（云 depthWrite=false，深度缓冲共用远平面值，post 阶段无法按区域 mask）。

## 钳制方向（避免写反）
DepthOfFieldNode 内部（`node_modules/three/examples/jsm/tsl/display/DepthOfFieldNode.js:375`）：
  signedDist = viewZNode.negate().sub(focusDistanceNode);
viewZ 是负值，远的 viewZ 更负。
- 要钳制"远距离过大的 CoC"，需给传进去的 viewZ 加一个下限：
  viewZ.clamp(largeNegative, 0)
  或者等价写法：viewZ.max(largeNegative)
  这样太远（更负）的点会被"夹回"到 largeNegative 对应的 CoC。
- 不要写成 `.min(positiveClamp)`——方向完全错。
- 不要写成 `.min(-largeNegative)`——虽然数值上同义，但容易被误读为"全图最大 CoC"。

## 验证方法
spike 后抓 `?post=1` vs `?post=0` 同机位帧：
- 云的边缘是否还被 DOF 糊得看不清分层？
- 海面远景是否也被"牺牲"掉了？（预期：是，全局关）
- banding_flips 是否劣化？

## 源码路径
dof Node 的源码位置：`node_modules/three/examples/jsm/tsl/display/DepthOfFieldNode.js`，
不是 `src/nodes/display/`。参考时别找错目录。
```

spike 完成后再回到 Step 2 送审阶段合并或否决。

---

### B10 （P2）Task 1 测试窗口 600 字跨进 `update()`

**位置**：Task 1 Step 1 测试代码块

**原文**：

```ts
const anchor = src.indexOf('const setQuality'); // 箭头函数，无 function 关键字
const body = src.slice(anchor, anchor + 600);
```

**问题**：`setQuality` 在 `dome-cloud.ts:344`，600 字窗口跨到第 364 行，已进入 `update()` 体。将来把 `uOctaves.value` 写进 `update()`（每帧写也合法）测试会假通过。

**改后**：

```ts
const anchor = src.indexOf('const setQuality'); // 箭头函数，无 function 关键字
// 从 anchor 往后找函数体结束位置（箭头函数的 `};` 在 setQuality 末尾）
const endMarker = src.indexOf('\n  };', anchor);
const body = src.slice(anchor, endMarker);
expect(body).toMatch(/uSteps\.value/);
expect(body).toMatch(/uOctaves\.value/);
// 断言 uSteps 出现在 uOctaves 之前（都在 setQuality 体内，不跨到 update()）
expect(body.indexOf('uSteps.value')).toBeLessThan(body.indexOf('uOctaves.value'));
```

---

### B11 （P2）杂项引用与命名

**逐项修正**：

| 文档写法 | 改成 | 位置 |
|---|---|---|
| world try/catch `src/world.ts:189-195` | `src/world.ts:190-196` | Task 7 Interfaces |
| P1 报告 "§3.4" | 删掉 §3.4 引用（P1 review 的 §3 是 4 条列表，无 3.4 小节），改成"P1 review 的 DOF 云糊问题" | Task 8 Interfaces |
| hgPhase 4π 在 `src/dome-cloud.ts:248-251` | 248-251 是 `phaseAt` 定义，真正乘 4π 在 `:288`。改成 `src/dome-cloud.ts:288` | Task 4 Interfaces |
| "计划约 420 行" | 实际 549 行。改成"本计划约 549 行" | Self-Review 第 5 条 |
| 测试用 `PatchSpec.distanceMetres` | 全计划没有定义此字段。在 Task 7 Interfaces Produces 段追加 `PatchSpec` 完整定义：`{ distanceMetres: number, azimuthDeg: number, yMetres: number, sizeMetres: number, seed: number }` | Task 7 |
| 新模块 `src/dome-horizon.ts` | 追加一句：**受 `module-graph.test.ts:20` 约束，非 test 文件不得静态 import `three/webgpu` / `three/tsl`，必须 `await import()`** | Task 7 头部 |
| 命名 `horizon?.setVisible` | `src/horizon.ts` 已存在（天空地平线），建议改成 `domeHorizon?.setVisible`，避免重名 | Task 7 Interfaces + world.ts 挂载处 |

---

## 第三份：飞行手感设计（10 项，全部 🟢 直接改）

**注意**：我用与文档完全相同的参数（`createFlightState(60)` 起手、满杆上拉 `sy=-1`、`dt=1/60`）跑了实测，文档里"满杆上拉"和"压杆"的数据**完全对调了**——文档写的 2.87s / 46.9m 正是压杆数据，不是满杆上拉。下面的修正**每一个数值都来自实测**。

---

### F1 （P0）核心基线反了

**位置**：第 37 行、第 45 行、第 47 行

**原文**：

```
hover 罚站 0.58s + fall 约 2.3~2.8s = 全程约 2.9~3.4s 才回到 cruise，掉高约 30~50m
```

**问题**：这是压杆（sy=+1）的数据。满杆上拉（sy=-1）在任何高度都不空中改出，直接触海。

**改后（整段重写）**：

```markdown
**真实数据（createFlightState(startY) + stepFlight(state, dt=1/60, {y: sy}) 实测）：**

| startY | sy=-1 满杆上拉 | sy=+1 满杆压杆 | sy=+0.5 | sy=-0.5 |
|---|---|---|---|---|
| 60 | 5.25 s / 127.17 m，**触海强制 cruise** | 2.87 s / 46.89 m，**空中改出** | 3.63 s / 74.95 m | 5.20 s / 127.26 m，**触海强制 cruise** |
| 120 | 6.85 s / 187.17 m，**触海强制 cruise** | （未单独采样） | | |
| 240 | 8.08 s / 233.39 m，**触海强制 cruise** | （未单独采样） | | |

**关键结论（修正原文三处错误）**：
1. **"持续满杆上拉"必触海，任何高度都不空中改出**——原文写的 2.9-3.4s / 30-50m 是压杆数据。
2. 能空中改出的是压杆/松杆，不是拉杆。
3. 满杆上拉的机制原因：`stepFall`（game.ts:311-315）
   ```
   authority = smoothstep01((speed - 13.2) / 8.8)   // 13.2 = 0.6*STALL_SPEED, 8.8 = 0.4*STALL_SPEED
   pitchTarget = FALL_PITCH(-1.1) + (playerPitch(+1.2) - (-1.1)) * authority
   ```
   满杆上拉时 playerPitch=+1.2，speed 低速 authority≈0→pitchTarget≈-1.1 俯冲；
   但 speed 升高 authority 增大→pitchTarget 被拉向 +1.2 上仰→俯冲角变浅→`speedTarget = 6 + (-vy)*max(0,-sin(pitch))` 被压在约 16.6→**永远达不到 STALL_SPEED=22**→永不切 cruise。
   只有 `integrate`（game.ts:373-376）触海分支强制切 cruise 才得救。

**修法影响**：
- 原文 Q1 的恢复时间预算、掉高预算全部建立在错误输入上——Q1 的"恢复到 cruise 的目标时间 1.2s"本身没问题，但它要修的前提（满杆上拉 pin 住）比文档想象的严重得多。
- 原文 F1-F3 的 pushover / hard cap / 松杆门逻辑方向不受影响，但具体数值需以正确前提重算。
```

---

### F2 （P0）fallback 与松杆门会把 bug 打回去

**位置**：第 67 行

**原文**：

```
- 只有玩家在 pushover 全程仍满杆上拉（`sy<-0.85` 不松杆），才 fallback 进现有 `fall`（nose -1.1）。另建议 hover 准入加"松杆门"：上一次 pushover 后未检测到 `sy>-0.3` 则不进下一次 hover，治 pin 杆打摆子。
```

**问题**：`sy<-0.85` 恰好把这类 bug（持续上拉 pin 住）送回现有 fall，而现有 fall 在满杆上拉时永不改出（见 F1）。松杆门 `sy>-0.3` 不对称：`sy=-0.4` 这种"还拉着"被判为未松杆，`sy=+1` 这种"满压"反而满足条件。

**改后**：

```markdown
- **fallback 触发条件**（修正原文）：只有在 pushover 已经执行了 **0.8s 以上**（不是"全程"）、且玩家仍持续满杆上拉（`sy<-0.85`）、且 pushover 确实没有让 speed 升到 RECOVERY_SPEED 18 时，才 fallback 进现有 fall。
  （fallback 本身就是"给 bug 留的后门"，不是正常路径）
- **hover 准入松杆门**（修正原文）：上一次 pushover 结束后，**未检测到 `abs(sy) < 0.3`**（即杆在中位附近，既不明显拉也不明显压），则不进下一次 hover。
  - `sy=-0.4`：还在拉 → 不触发松杆 → 不进 hover ✓
  - `sy=+1`：满压杆 → 不是松杆 → 不进 hover ✓
  - `sy=0.1`：中位附近 → 触发松杆 → 允许进 hover ✓
- **持续上拉的正确修法**（不是 fallback）：直接在 pushover 里处理——pushover 期间玩家继续满杆上拉，不回退到旧 fall，而是把 pushover 延长 0.3s 且强制 pitch 上限 -0.05（保持平飞），**让玩家一直上拉杆也能改出**，而不是打回必触海的旧 fall。
  旧 fall（nose -1.1）只留给"真 bug 修不完"时的最后兜底。
```

---

### F3 （P0）1.8 s / <15 m 的硬保证自相矛盾

**位置**：第 66 行 + 第 59 行 FALL_HARD_CAP 定义

**原文**：

```
FALL_HARD_CAP: 1.6
...
失控总时长锁死在 `0.58+1.2=1.8s` 以内，掉高 `<15m`；`fall` 超过 `FALL_HARD_CAP 1.6s` 无论速度多少强制进 pushover。
```

**三个算术矛盾**：
1. 如果 fall 能跑满 1.6s，再进 1.2s pushover：0.58 + 1.6 + 1.2 = **3.38s**，不是 1.8s。
2. fall 1.6s 的掉高：按压杆实测 fall+1.0s vy=-4.09/speed=4.1、+2.0s vy=-13.9/speed=14.05、+2.5s vy=-18.8/speed=16.65 推算，fall 1.6s 约掉 **~21.6m**，已超过 15m。pushover 段即使不再掉，总掉高 > 21.6m。
3. 第 64 行说"速度从 0 用 FALL_SPEED_ATTACK 重建"：FALL_SPEED_ATTACK 假设是 2.2，1.2s 只到 `1 - e^(-2.2*1.2) = 92.9%` 目标；目标 18 时约 16.7，仍低于 RECOVERY_SPEED 18——除非直接 snap。

**修法（二选一，写进文档）**：

**选项 A（紧目标，改 FALL_HARD_CAP 数值）**：

```ts
FALL_HARD_CAP: 0.8,     // fall 只给 0.8s 就强制 pushover
PUSHOVER_T: 1.0,         // pushover 压缩到 1.0s
RECOVERY_SPEED: 18,      // pushover 结束时直接 snap 到 18
// 总时长：0.58 + 0.8 + 1.0 = 2.38s；总掉高约 0.8s fall ≈ 5-6m + pushover 不显著掉高 ≈ 6-8m
// （实测 fall 0.8s ≈ vy -3m/s, 掉高 ≈ (0+3)/2 * 0.8 = 1.2m；实际含初始俯冲更快约 4-5m）
// 改后硬保证：总时长 ≤ 2.4s，掉高 ≤ 15m。把原文"1.8s"和"<15m"同步改成新数。
```

**选项 B（宽目标，保持现有常量重算保证）**：

```ts
// 保持 FALL_HARD_CAP: 1.6, PUSHOVER_T: 1.2, RECOVERY_SPEED: 18（pushover 结束时 snap）
// 重算保证：总时长 0.58 + 1.6 + 1.2 = 3.38s；掉高 fall 1.6s ≈ 21.6m + pushover snap 不掉 ≈ 21.6m
// 把原文"1.8s"改成 "3.4s 以内"、"<15m"改成 "<25m"。
```

**同时改**：第 64 行把"速度从 0 用 FALL_SPEED_ATTACK 重建"改成"速度从 0 **snap 到 RECOVERY_SPEED 18**（或用 FALL_SPEED_ATTACK 重建但保证 pushover 结束时已到 18）——不能同时承诺'1.2s 到 18'和'指数重建'，指数重建 1.2s 只能到 16.7"。

---

### F4 （P1）机制描述错误

**位置**：第 35 行 + 第 39-44 行 authority 表

**原文**（第 35 行）：

```
stepFall 一头把 pitch 按到 -1.1，authority 要到 STALL_SPEED*0.6→1.0 才线性回来。
```

**问题**：`game.ts:314-326` 是**指数逼近**（`pitch += (target - pitch) * attack(d, PITCH_ATTACK*0.6)`），不是瞬间按到 -1.1；满杆上拉时 pitch 最低约 -1.082（永远碰不到 -1.1，因为指数逼近要无限时间才收敛），随后被 authority 拉回 -0.337。`authority = smoothstep01((speed-13.2)/8.8)` 是 smoothstep，不是线性。

**改后**：

```
stepFall 内部：pitch 通过指数逼近 `pitch += (target - pitch) * attack(d, PITCH_ATTACK*0.6)` 收敛到 pitchTarget，
不是瞬间按到 -1.1。authority 用 smoothstep01((speed-13.2)/8.8) 映射（不是线性）：
  - speed 15 → authority 0.108 → pitchTarget ≈ FALL_PITCH(-1.1) + (playerPitch - (-1.1))*0.108
                               满杆上拉(playerPitch=+1.2)时 pitchTarget ≈ -1.1 + 2.3*0.108 ≈ -0.85
  - speed 18 → authority 0.568 → pitchTarget ≈ -1.1 + 2.3*0.568 ≈ +0.21（已在抬头上仰！）
  - speed 20 → authority 0.869 → pitchTarget ≈ -1.1 + 2.3*0.869 ≈ +0.90
  - 满杆上拉时速度约 16.6，authority ≈ smoothstep01((16.6-13.2)/8.8) = smoothstep01(0.386) ≈ 0.285
    → pitchTarget ≈ -1.1 + 2.3*0.285 ≈ -0.45 → pitch 最低约 -1.082，随后被拉回，永不碰 -1.1。
```

authority 表里的数值**换成 smoothstep 实际值**：

| speed | authority 原文（错） | authority smoothstep 实际值 |
|---|---|---|
| 15 | 0.2 | **0.108** |
| 18 | 0.545 | **0.568** |
| 20 | 0.773 | **0.869** |

---

### F5 （P1）vy 表偏乐观

**位置**：第 42-44 行（紧跟 F1 表格后面）

**原文**：

```
| t | vy | speed |
|---|---|---|
| ~1.0s | -9.8 | ~11 |
| ~1.5s | -14.7 | ~15 |
| ~2.0s | -19.6 | ~19 |
```

**实测**（满杆上拉 fall 段，从 hover 结束后计时）：

| t | vy | speed | pitch |
|---|---|---|---|
| +1.0s | **-4.09** | **4.10** | -0.607 |
| +1.5s | **-8.99** | **9.13** | -1.019 |
| +2.0s | **-13.90** | **14.05** | -1.082 |
| +2.5s | **-18.80** | **16.65** | -0.612（authority 开始拉回 pitchTarget 了） |

**改后**：

```
| t | vy 实测 | speed 实测 | 说明 |
|---|---|---|---|
| +1.0s | -4.09 | 4.10 | authority 极低，pitch 还在向下收敛 |
| +1.5s | -8.99 | 9.13 | pitch 已接近 -1.08（最低值） |
| +2.0s | -13.90 | 14.05 | speed 升高 authority 拉回 pitchTarget |
| +2.5s | -18.80 | **16.65**（平台，不再涨） | pitch 被拉回 -0.6 以上；speed 被压在 16.6，永远达不到 STALL_SPEED=22 |

注：speed 到 16.6 就平台，因为满杆上拉让 pitchTarget 被 authority 拉回 +1.2 上仰，
sin(pitch)≈sin(-1.082)≈-0.88，所以重力沿机头分量 STALL.G_SINK*sin(pitch)≈-9.8*(-0.88)=+8.6（**向上抬！**），
抵消了大部分推力损失。这是满杆上拉永不切 cruise 的核心机制。
```

---

### F6 （P1）"高空 40 m 能回来"不成立

**位置**：第 47 行

**原文**：

```
高空 zoom 顶掉 40m 能回来；40m 以下仰飞失速，速度还没回到 22 就先拍地板
```

**问题**：60/120/240m 满杆上拉全部靠触海强制 cruise，40m 不是分界。只有压杆/松杆能空中改出。

**改后**：

```
"能否空中改出"不取决于高度，只取决于杆量：
- 持续满杆上拉（sy<-0.85）：任何高度都不空中改出，必靠 integrate 触海强制 cruise（game.ts:373-376）
- 压杆/松杆（sy>-0.3）：speed 能回到 STALL_SPEED=22 之前，大概率空中改出
- 介于中间（-0.85≤sy≤-0.3）：取决于 pitchTarget 拉回后的 speed 能否冲过 22

这与高度无关——40m 满杆上拉一样触海，240m 松杆一样能回来。
```

---

### F7 （P1）Q3 的 FOV 现状算错

**位置**：第 111 行

**原文**：

```
现在只有 dive 给 +3（DIRECTOR.FOV_DIVE）。改成 base 60 + speed01*4 + dive01*3
```

**问题**：
- `FOV_BASE=6, FOV_DIVE=3, CAM_FOV_KICK=9`（director.ts:31-33 + game.ts:590）
- 实际 `fovKick = min(9, 6 + 3*dive01)`：平飞满速 kick=6，总 fov=66°；俯冲满速 kick=9，总 fov=69°
- 提议的 4+3=7 → 平飞 64°，比现在的 66°**低 2°**，反而减了速度感

**改后**：

```markdown
**现状（比你以为的更广）**：
- DIRECTOR.FOV_BASE = 6, FOV_DIVE = 3, CAM_FOV_KICK = 9
- fovKick = min(9, 6 + 3*dive01)
- 平飞满速 → fovKick=6 → total fov=66°
- 俯冲满速 → fovKick=9 → total fov=69°

**问题诊断**：
- 基线已经 +6 了，原文"改成 4+3"反而把基线砍到 4，平飞 fov 从 66° 降到 64°
- 真正缺的是：speed01 从 0→1 时 fov 没明显变化，巡航和起飞几乎同 fov

**提议（修正原文）**：
不要降低基线，要在现有 6 的预算内重分配。两个候选：
A. `baseFov 60 + (6 * speed01) + 3 * dive01`：平飞满速 66°，俯冲满速 69°，与现在**总量相同但曲线更陡**（speed01 线性分配）
B. `baseFov 60 + (3 * speed01) + (3 * speed01^2)` 加 dive01*3：quadratic 让中高速段 fov 变化更剧烈（15 节时 fov 63°，22 节时 69°）

两条都不超出 CAM_FOV_KICK=9 的 cap。选 A 简单，选 B 更有"越飞越快"的体感。
```

---

### F8 （P1）Q5 的 trauma 衰减写反了

**位置**：第 148 行

**原文**：

```
出云：0.4s 指数松开（trauma 自然衰减即可，TRAUMA_DECAY 1.15 约 0.8s 回零，刚好）。
```

**三个矛盾**：
1. `feel.ts:66-72` 注释写 **"Linear decay is unconditionally stable"**，代码 `next = t - step*dt` 是**线性**，不是指数
2. `TRAUMA_DECAY=1.15`，0.22 trauma 约 0.22/1.15 = 0.19s 回零；0.9 才约 0.9/1.15 = 0.78s——原文 0.8s 只能解释成 0.9 级 trauma
3. "0.4s 指数松开" 与 "0.8s 回零" 互相矛盾（指数衰减不会"刚好"在 0.8s 回到 0，它永远趋近 0 而不到 0）

**改后**：

```
出云：trauma 自然衰减即可。`feel.ts` 用**线性衰减**：`next = t - TRAUMA_DECAY*dt`，TRAUMA_DECAY=1.15。
  - trauma 0.22 约 0.19s 回零
  - trauma 0.9 约 0.78s 回零
  如果想让出云 trauma 持续约 0.4s，需要在云内保持 traumaTarget=0.22+（进云后逐渐升），出云时 target 归零让自然线性衰减走完约 0.2s 余留。
  如果确实想要"指数松开"的非线性体感，需要改 `feel.ts` 的 updateTrauma 实现（从 `t-step*dt` 改成 `t * exp(-step*dt)`），代价是稳定性分析和现有测试可能需要更新。
```

---

### F9 （P1）Q2 的"仍能继续顶杆下探"不准确，分层不一致

**位置**：第 76 行、第 82-90 行

**原文**（第 76 行）：

```
现在俯冲到海面仍能继续顶杆下探
```

**原文**（第 82-90 行分层）：

```
SEA_CUSHION_Y=18, SEA_RUMBLE_Y=12
分层用 10<y<18、y<10
```

**两个问题**：
1. `integrate` 触底（game.ts:362-378）会强制 `pitch≥0.12`、`speed≥22`、进 cruise，不会让位置继续下探。触底前仍可压杆，但"继续下探"不成立。
2. `SEA_RUMBLE_Y=12` 没有在分层逻辑里使用；6→18 与 10/18 的边界不一致（6 vs 10）。

**改后**：

第 76 行改为：

```
现在 `integrate`（game.ts:362-378）触底会强制 pitch≥0.12、speed≥22、进 cruise，不会让飞机撞海。但**触底前仍可压杆到底**，玩家没有"海就在下面不能继续压"的体感提示。缺的是"距离海面还有 20m 开始逐渐限制俯冲"的海垫层。
```

第 82-90 行分层改为（统一三层，SEA_RUMBLE_Y 纳入分层）：

```ts
SEA_CUSHION_Y: 18,   // 垫层顶
SEA_RUMBLE_Y: 12,    // 碎抖起振高度（同时是中层底）
PITCH_FLOOR_DEEP: -0.25,  // 中层 (y<18) pitch 下限
PITCH_FLOOR_FLOOR: -0.12, // 底层 (y<12) pitch 下限（"不能继续下探"的硬门）
```

```
- y > 18：现有逻辑不变，完整杆量
- 12 < y < 18：pitchTarget 下限钳到 -0.25，bank 回正率 ×1.5，skim01 驱动泡沫尾迹
- y < 12：**playerPitch 下限强制钳到 -0.12**（不是只钳 pitchTarget），实现"触底前 12m 以内禁止继续下探"
          bank 回正率 ×2.0，自动配平 pitch→+0.05~0.10
          碎抖从这里开始最明显
```

---

### F10 （P2）锚点与文字

**逐项修正**：

| 位置 | 问题 | 改后 |
|---|---|---|
| 第 13 行 | `:75-77` 偏一行（THRUST 在 76、DRAG_K 在 78） | 改成精确行号，或用 `grep 'THRUST\|DRAG_K' src/game.ts` 定位并把位置写成 `game.ts THRUST/DRAG_K 定义处` |
| 第 23 行 | 有高棉字符"ជាមួយ" | 删掉或替换成中文比喻"差的不是有没有，是顶端和低端那两口气没接住，巡航中间那口气太松" |
| 第 120 行 | "按.Visibility"排版错 | 改成 `按 Visibility 排序` 或 `按 Priority 排序` |
| 第 520 行 | freeze 只停 airframe 不停游戏时钟 | 追加注释："hover 的 0.08s freeze 是 airframe hit-stop，不是世界暂停——freeze>0 时 stepFlight 内部直接 return 上一帧 state，但 dt 仍累加" |

---

## 附录 A：飞行手感实测完整数据表（F1-F5 修正依据）

所有数据来自 `src/game.ts` 的独立脚本调用 `createFlightState(startY)` + `stepFlight(state, dt=1/60, {x:0, y:sy})`。

### A.1 满杆上拉 sy=-1

| startY | hoverAt | fallTime | 掉高 | waterHit? | 结束条件 |
|---|---|---|---|---|---|
| 60 | 2.58s | 5.25s | 127.17m | ✓ | 触海强制 cruise |
| 120 | 2.58s | 6.85s | 187.17m | ✓ | 触海强制 cruise |
| 240 | 2.58s | 8.08s | 233.39m | ✓ | 触海强制 cruise |

### A.2 满杆压杆 sy=+1

| startY | hoverAt | fallTime | 掉高 | waterHit? | 结束条件 |
|---|---|---|---|---|---|
| 60 | 2.58s | 2.87s | 46.89m | ✗ | speed≥22 空中改出 |

### A.3 sy=+0.5

| startY | hoverAt | fallTime | 掉高 | waterHit? |
|---|---|---|---|---|
| 60 | 2.58s | 3.63s | 74.95m | ✗ | 空中改出 |

### A.4 sy=-0.5

| startY | hoverAt | fallTime | 掉高 | waterHit? |
|---|---|---|---|---|
| 60 | 2.58s | 5.20s | 127.26m | ✓ | 触海强制 cruise |

### A.5 满杆上拉 fall 段速度演化（从 hover 结束后计时）

| fall+时间 | vy | speed | pitch | 说明 |
|---|---|---|---|---|
| +0.0s | -15.7 | 0 | +1.2 | hover 结束，fall 开始 |
| +1.0s | -4.09 | 4.10 | -0.607 | |
| +1.5s | -8.99 | 9.13 | -1.019 | |
| +2.0s | -13.90 | 14.05 | -1.082 | **pitch 最低值** |
| +2.5s | -18.80 | 16.65 | -0.612 | **speed 平台，不再涨** |

### A.6 authority（game.ts:311-313 smoothstep01((speed-13.2)/8.8)）

| speed | authority | 计算 |
|---|---|---|
| 13.2 (STALL_SPEED*0.6) | 0 | clamp01(smoothstep01(0)) |
| 15 | **0.108** | smoothstep01(0.2045) |
| 18 | **0.568** | smoothstep01(0.5455) |
| 20 | **0.869** | smoothstep01(0.7727) |
| 22 (STALL_SPEED) | 1 | clamp01(smoothstep01(1)) |

---

## 附录 B：修改优先级建议

| 优先级 | 文件 | 要改的问题 | 理由 |
|---|---|---|---|
| 🔴 先改 | 飞行手感 | F1、F2、F3 | P0 且全部是核心逻辑/数值错误，不改则文档无法指导实现 |
| 🔴 先改 | 穹顶云 | B1、B2、B3、B4 | P0 且 B2/B3/B4 是"计划根本不可执行"级别的硬伤 |
| 🔴 先改 | 调色面板 | D1、D2 | P0 D1 改验收口径、P1 D2 改基线数字 |
| 🟡 再改 | 穹顶云 | B5-B11 | P1/P2，改完 P0 再改 |
| 🟡 再改 | 调色面板 | D3、D4 | P2，纯文字/行号修正 |
| 🟡 再改 | 飞行手感 | F4-F10 | P1/P2，改完 P0 再改 |

修改完三份文档后，**穹顶云的 B1 关雾需要一行代码实现才能验证后续 Task 3/4/5/9 的参数标定**——那是代码层改动，不在本指南范围内。
