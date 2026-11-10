# Dome Cloud P1.5 + P2 + Horizon Patch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把穹顶云从“能渲染的薄纱”做成“散布的、有瓣的、有光影分层的云”，再给出 soft/flat 两套可切换看法，并补一层廉价地平线 patch 让低空平视也有云。

**Architecture:** 不动管线：仍是 TSL slab raymarch + 三层密度（96³ shape / 32³ detail / 512² weather）。P1.5 只调形状三旋钮、光照 3 采样 march、垂直分层调制；P2 只加一个 `uLook` 输出分支；地平线 patch 是独立新模块，挂在 1200–1800 m 淡出带里交接；DOF 修法先 spike 再定。

**Tech Stack:** TypeScript 5.5 · three 0.186.0 (`three/webgpu` + `three/tsl`) · Vitest 2.1 · Vite 6

**Spec:** `docs/superpowers/specs/2026-11-10-dome-cloud-p15-p2-design.md`（P1.5 §5.1–5.3、P2 §5.4、验收 §8、定案 §11；§12 三条已拍板见下），`docs/superpowers/specs/2026-11-09-dome-cloud-volumetric-design.md`（P1），`docs/superpowers/reviews/2026-11-09-dome-cloud-p1-review.md`（P1 基线）

## Global Constraints

- three 0.186.0，**WebGPU-only**：`src/renderer.ts` 的 WebGPU-only 守卫在非 WebGPU 后端抛错，任何任务不得引入 WebGL 回退。
- 竖屏 **9:16**，fov **60°**，`camera.far = 2000`。云盒半宽 **1800 m**，不得改 far。
- **DPR 上限 1.5**（`src/main.ts:225` 的 `setPixelRatio` 钳制）。
- 飞行 **ALT_MIN 6 / ALT_MAX 240**（`src/game.ts:99-100`）。云底 **380 m**、云顶 **1150 m**（`DOME_SLAB`，P1.5 不改）。
- `fadeStart = 1200`、`fadeEnd = 1800 = halfExtent`（盒壁不可见的唯一保证；`src/dome-cloud-field.test.ts:26` 已钉）。
- 步数 **high 28 / low 16**；light march high 3 采样 / low 1（单次探针保持）；detail octave high 2 / low 1。**只烘一套 96³，`setQuality` 绝不重烘。**
- 步长曲线指数 `STEP_CURVE_POWER = 2.2`（`src/dome-cloud.ts:43`），shader 累积形式与 `stepSizes()` 必须同改（I4 ruling）。
- `SLOW_FRAME_MS = 24`（`src/world.ts:69`）。档位只降不升。
- **单一太阳**：只吃 `SUN_DIRECTION` / 活 `DirectionalLight`，不得新造光源。
- **调色单源**：只读 `src/sky-track.ts` 的 `cloudBands: Vec3[4]` 与 `cloudHaze: Vec3`，太阳色只走 `sunColorFor()`（`src/dome-cloud-light.ts:116`）；**任何云模块不得写死十六进制颜色**。
- 模块挂载必须 **try/catch**，失败只丢自己（照 `src/world.ts:190-196`）。
- 漂移速度：detail **3.5 m/s**（tile 400 m）、weather **2.0 m/s**（tile 8000 m）——`DOME_DRIFT`（`src/dome-cloud-field.ts:109-120`，P1 门 3 实测反推后的值，初版 0.35 m/s 肉眼静止）；偏移按层分别计算（`driftOffset(elapsedSeconds, layer)`）。**本轮不动速度。**
- 所有时间取 **`elapsed`（累加 dt）**，不得 `Date.now()` / `performance.now()`。
- 纹理类型：96³ / 32³ 用 `Data3DTexture`；512² weather 用 `DataTexture` + `RepeatWrapping`。
- 单测文件与被测模块同名。提交信息 `feat(dome):` / `test(dome):` / `fix(dome):` 作用域。
- **用户拍板（2026-11-10，§12）：** ① 性能门手机那半用**桌面 low 档**代替真机；② 云底不降，海平面云另起 patch 层（方案 B）；③ DOF 这轮修，但修法必须过细审。散布密度先按设计门（blob 3–8）做，出效果再调。
- **用户拍板（2026-11-10，复审 R9 裁定）：④ 地平线 patch 的"正前方"＝玩家（相机）朝向**，不是世界固定方位——
  原 Task 7 的"世界固定 ±40° 扇区（B 方案）"作废，改朝向量化滑窗，详见 Task 7。

## Review Focus

1. **`?dome=0` 与 `?puff=0` 同时给**：两套云全关（含 horizon patch），画面只剩天穹——开/关帧做差是覆盖率的唯一量法。→ Task 7 的 `setVisible` 级联测试。
2. **冻结抓帧（`?qa=frozen` + `qa.step()`）下云的漂移**：必须只随 `elapsed` 推进，两次同 `step(n)` 跑出不同的云即失败。→ Task 3 的 elapsed-only 断言。
3. **夜档（太阳仰角 -8°）的真暗归 `cloudBands`**：`sunColorFor` 只做钳制（-8° ≡ 0° 的暖橙），从不断言变暗；夜档量级骤降在 `sky-track` 的 `cloudBands` 里，测试必须钉对地方。→ Task 4 的钳制断言 + cloudBands 夜档备注。
4. **`?sunoff=1` 必须真把太阳项清零**：同机位 sun-on/off 两帧差值 ≈ 太阳项贡献，差值 ~0 说明开关是假的。→ Task 2 的接线 + Task 9 的量测门。
5. **flat 档不得碰 alpha**：量化只改颜色输出，soft/flat 同机位 `coverage` 与 `blob_count` 基本不变，否则“切换像换了一朵云”。→ Task 6 的 alpha 直通单测 + Task 9 抓帧门。

---

### Task 0.5: 穹顶云材质关雾（P0 前置，否则 Task 3/4/5/9 的参数标定全无效）

> 排在 Task 1 之前：本计划从 Task 1 起编，`0.5` 表示「开工第一件事」（编号沿用审核报告的 Task 0.5）。

**Files:**
- Modify: `src/dome-cloud.ts`（`NodeMaterial` 构造处加一行）

**Interfaces:**
- `main.ts:73` 有 `scene.fog = new THREE.Fog('#c96a7a', 60, 700)`；`src/dome-cloud.ts:325` 新建 `NodeMaterial` 时**没设** `material.fog`，
  而 `NodeMaterial.js:77` 默认 `this.fog = true` → 700 m 外雾饱和到 1，1200–1800 m 的 horizon patch 与 deck 远景会被渲染成纯雾色哑光带，
  Task 7 的「海平面有云」验收物理上不可能通过。
- 对照：`puff-cloud.ts:279/360`、`sky-webgpu.ts:302`、`sea/material.ts:472` 都显式关雾。

- [ ] **Step 1: 一行修改**

在 `const material = new NodeMaterial();` 之后立即加：

```ts
material.fog = false; // 否则 scene.fog('#c96a7a', 60, 700) 会把 700m 外的云全糊成雾色
```

- [ ] **Step 2: 全量回归**

Run: `npx vitest run` → 全绿（52 文件）；`npx tsc --noEmit` → 0 错误

- [ ] **Step 3: 关雾后重抓 P1 基线帧**（关雾后颜色/覆盖率基线会变，Task 9 的量测基准要随之重标）

Run: `?qa=frozen` + `qa.step(1800)` 同机位，重抓 `p1-on.png` / `p1-off.png`，跑 `measure.py` 得到新的
coverage / tone_span / drift / banding_flips，并把这些新值回填到 Task 9 Interfaces 的「P1 基线」括注里。

**复审 R7 复测项**：检查 on/off 两帧近地平线带（竖条 rows ~330-420，仰角 ±5°）是否仍有差值瓣——
当前基线在 +1.2°~+2.2° 有 3 行全宽异常瓣（ON 帧更暗 ~10 luma；非 deck 几何、非 DOF 下抹，机制未定性）。
关雾后消失 → 报告记一句"随雾消失"；仍在 → Task 7 patch 标定前先定性，记入验收报告。

- [ ] **Step 4: Commit**

```bash
git add src/dome-cloud.ts
git commit -m "fix(dome): disable fog on dome material so 700m+ renders are not all fog color"
```

---

### Task 1: 修 P1 遗留 bug——`setQuality` 从不写 `uOctaves`

**Files:**
- Modify: `src/dome-cloud.ts`（`setQuality` 内）
- Test: `src/dome-cloud.test.ts`

**Interfaces:**
- Consumes: `qualityParams(high: boolean): DomeCloudQuality`（`src/dome-cloud.ts:57`，high `{steps:28,octaves:2}` / low `{steps:16,octaves:1}`）；`uSteps` / `uOctaves` uniforms（`src/dome-cloud.ts:191-192`）；shader 侧 `mix(detailBase, blended, uOctaves.sub(1))`（`src/dome-cloud.ts:237`）。
- Produces: `setQuality(high)` 同时写 `uSteps.value` 与 `uOctaves.value`。无新接口。

设计 §11.5：`setQuality` 漏写 `uOctaves.value`，导致 low 档 `uOctaves` 永远保持 high 档初始值 2。
修完后 low 的 `mix(detailBase, blended, uOctaves.sub(1))` 权重变为 0，回到纯 detailBase——**这是视觉一致性修复，不是性能修复**
（`src/dome-cloud.ts:234` 的 `detailFine = texture3D(detailTex).sample(...)` 是无条件求值，改 uniform 不省采样）。
commit message 写"视觉修复"，不写"性能修复"；不要把 low 的 p95 改善归因于此。

- [ ] **Step 1: 写失败的测试**

```ts
// src/dome-cloud.test.ts
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('./dome-cloud.ts', import.meta.url), 'utf8');
it('setQuality writes both uSteps and uOctaves (P1 §11.5 leak)', () => {
  const anchor = src.indexOf('const setQuality'); // 箭头函数，无 function 关键字
  // 从 anchor 往后找函数体结束位置（箭头函数的 `};` 在 setQuality 末尾，实测 L344-L348）
  const endMarker = src.indexOf('\n  };', anchor);
  const body = src.slice(anchor, endMarker);
  expect(body).toMatch(/uSteps\.value/);
  expect(body).toMatch(/uOctaves\.value/);
  // 断言 uSteps 出现在 uOctaves 之前（都在 setQuality 体内，不跨到 update()）
  expect(body.indexOf('uSteps.value')).toBeLessThan(body.indexOf('uOctaves.value'));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/dome-cloud.test.ts`
Expected: FAIL（`uOctaves.value` 不在 `setQuality` 内）

- [ ] **Step 3: 在 `setQuality` 里补写 `uOctaves.value = qualityParams(high).octaves`**

只加一行，不动纹理、不动 shader、不重烘。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/dome-cloud.test.ts`
Expected: PASS（全文件）

- [ ] **Step 5: Commit**

```bash
git add src/dome-cloud.ts src/dome-cloud.test.ts
git commit -m "fix(dome): setQuality writes uOctaves so low octave matches visual (uniform fix, not perf fix)"
```

---

### Task 2: QA 开关——`parseCloudLook` 与 `?sunoff=1`

**Files:**
- Modify: `src/qa.ts`、`src/main.ts`
- Test: `src/qa.test.ts`

**Interfaces:**
- Consumes: 既有风格照 `parseDomeVisible`（`src/qa.ts:36`：`'0'` → false，其余 → true）；`world?.setSunColor`（`src/world.ts:251` 经由 `DomeCloudHandles.setSunColor(color: Vec3)`）；`syncSun`（`src/main.ts` 内，每帧调 `setSunColor(sunColorFor(el))`）。
- Produces:
  - `parseCloudLook(raw: string | null | undefined): 'soft' | 'flat'`（`'flat'` → `'flat'`，其余 → `'soft'`）
  - `parseSunOff(raw: string | null | undefined): boolean`（`'1'` → true，其余 → false）
  - `main.ts` 接线：`?sunoff=1` 时启动后调一次 `world?.setSunColor([0,0,0])`，且 `syncSun` 内跳过 `setSunColor`（太阳项彻底归零，门 4 的证伪开关，§11.2）。

- [ ] **Step 1: 写失败的测试**

```ts
// src/qa.test.ts
import { parseCloudLook, parseSunOff } from './qa';
describe('parseCloudLook', () => {
  it('defaults to soft', () => {
    expect(parseCloudLook(null)).toBe('soft');
    expect(parseCloudLook(undefined)).toBe('soft');
    expect(parseCloudLook('')).toBe('soft');
    expect(parseCloudLook('whatever')).toBe('soft');
  });
  it('flat opts in', () => {
    expect(parseCloudLook('flat')).toBe('flat');
  });
});
describe('parseSunOff', () => {
  it('is off unless ?sunoff=1', () => {
    expect(parseSunOff(null)).toBe(false);
    expect(parseSunOff('0')).toBe(false);
    expect(parseSunOff('1')).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/qa.test.ts`
Expected: FAIL with "parseCloudLook not defined"

- [ ] **Step 3: 在 `src/qa.ts` 实现 `parseCloudLook` 与 `parseSunOff`，在 `src/main.ts` 接线 `?sunoff=1`**

`main.ts` 改两处：① 启动时 `const sunOff = parseSunOff(qaParams.get('sunoff'))`，为 true 则 `world?.setSunColor([0, 0, 0])`；② `syncSun` 内 `world?.setSunColor(sunColorFor(el))` 改为 `if (!sunOff)` 守卫。`?cloudlook` 的消费留给 Task 6，这里只做 parser。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run src/qa.test.ts` → PASS；`npx tsc --noEmit` → 0 错误

- [ ] **Step 5: Commit**

```bash
git add src/qa.ts src/qa.test.ts src/main.ts
git commit -m "feat(dome): ?cloudlook parser and ?sunoff=1 kill-switch for the sun term"
```

---

### Task 3: P1.5 形状——coverage 收窄 + 侵蚀下调（Worley 按决策树）

**Files:**
- Modify: `src/dome-cloud.ts`（`densityAt` 内两行常量）
- Test: `src/dome-cloud.test.ts`（常量钉死测试）

**Interfaces:**
- Consumes: `densityAt` 现状（`src/dome-cloud.ts:215-243`）：`coverage = smoothstep(0.30, 0.46, weather)`（:239）、`eroded = body - (1-detail)*0.32`（:241）；`worley3(x, y, z, cells, seed)`（`src/dome-cloud-noise.ts:94`，回补路径用）；量具 `artifacts/dome-audit/measure.py`（P1 版：coverage / tone_span / drift / banding_flips）。
- Produces: 新阈值（起点 `smoothstep(0.34, 0.42, weather)`、侵蚀权重起点 `0.22`，抓帧标定后锁死）；若 1+2 不达标才进 Worley（96³、12 细胞、权重约 0.35，与值噪声混合——设计 §5.1 顺序与风险 §10.1）。

设计 §5.1：三个旋钮按影响力排序，先 1+2，再决定要不要 3。目标先出“成块的瓣”。散布要求（blob 3–8）靠这一步的阈值实现。

- [ ] **Step 1: 写失败的测试（钉住新阈值）**

```ts
it('pins the P1.5 shape knobs (calibrated, see review)', () => {
  const src = readFileSync(new URL('./dome-cloud.ts', import.meta.url), 'utf8');
  expect(src).toMatch(/smoothstep\(0\.34,\s*0\.42,\s*weather\)/);
  expect(src).toMatch(/\.mul\(0\.22\)/);
});
```

（若抓帧标定后数值有变，同步改测试与本行注释，保持“测试即定值”；改钉死数值需在提交信息注明原因——门柱只能由抓帧数据搬。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/dome-cloud.test.ts`
Expected: FAIL（仍是 0.30/0.46 与 0.32）

- [ ] **Step 3: 改 `densityAt` 两行，抓帧标定**

**前置说明**：`blob_count` / `edge_grad_p95` / `row_peaks` 三项量具在 Task 9 才升级。本任务执行时只有 P1 版量具
（coverage / tone_span / drift / banding_flips / row_stripes），**`blob_count` 门先目测 blob 数落 3–8，`edge_grad` 先目测边缘锐度高于 P1，`row_peaks` 先目测行剖面 ≥ 2 峰**。Task 9 升级量具后回跑本步骤重新判门。

关雾后抓帧（Task 0.5 已先跑），用新的 P1 基线作参照：`?dome=1/0` 同机位对，目测 blob 落 3–8 且边缘比 P1 锐即锁死；
否则在 (0.32–0.36, 0.40–0.44) 与 (0.18–0.26) 内调，**调完重跑本步**。

- [ ] **Step 4: Worley 决策（只在 1+2 不达标时进）**

若 `blob_count` 仍 < 3 或边缘仍糊，才把 `worley3` 按约 0.35 权重混入 shape 层（`generateShapeVolume` 内，周期整除 96）；达标则**跳过此步**，并在提交信息注明“Worley 回补路径未启用”。

- [ ] **Step 5: 全量验证**

Run: `npx tsc --noEmit` → 0；`npx vitest run` → 全绿（52 文件起）

- [ ] **Step 6: Commit**

```bash
git add src/dome-cloud.ts src/dome-cloud.test.ts
git commit -m "feat(dome): P1.5 shape contrast — narrower coverage, weaker erosion"
```

---

### Task 4: P1.5 光照——3 采样 light march（带密度门）

**Files:**
- Modify: `src/dome-cloud.ts`（`colorNode` march 循环内，新增 `LIGHT_MARCH_DELTA_METRES` 具名常量）、`src/dome-cloud-light.ts`（新增纯函数 `marchTransmittance`）
- Test: `src/dome-cloud-light.test.ts`（`marchTransmittance` 数值用例 + `sunColorFor` 钳制用例）、`src/dome-cloud.test.ts`（shader 结构断言：3 采样 + 密度门 + low 单探针分支）

**Interfaces:**
- Consumes: `transmittance(sigmaT, distanceMetres)`（`src/dome-cloud-light.ts:40`）；`hgPhase` 常量已 ×4π 归一（P1 fix I2，真正乘 4π 在 `src/dome-cloud.ts:288`）；现有单次探针 `LIGHT_PROBE_METRES = 120`（`src/dome-cloud.ts:41`，low 档保留）；`sunColorFor(elevationDeg)`（`src/dome-cloud-light.ts:116-123`，**只做钳制**：`Math.max(0, …)` 把负仰角钉到 0° 暖橙，夜档真暗归 `cloudBands`——Review Focus 3）。
- Produces:
  - `marchTransmittance(densities: readonly number[], deltaMetres: number, sigmaPerDensity: number): number`（**`dome-cloud-light.ts` 的 TS 纯函数**，用于测试与文档注释；**`dome-cloud.ts` 的 TSL shader 内不调用它**，而是在 `colorNode` 里用 `Fn(...)` **内联复刻同式**，注释注明「与 `marchTransmittance` 同式」）。shader 结构断言：`LIGHT_MARCH_DELTA_METRES = 40`、密度门 `0.12`、三 tap 的 `Loop(3`、low 分支 `uOctaves.lessThan(1.5)`（若实现改成三次显式展开，则断言改为 3 次 `densityAt(`——**断言跟随实现形态，不预设写法**）。
  - march 内 `density > 0.12` 才沿 `uSunDir` 取 k=1..3（`Δ = LIGHT_MARCH_DELTA_METRES = 40`）求和；
    **low 档分支判据**：`If(uOctaves.lessThan(1.5), 单探针 original, 三采样)`（复用现有 `uOctaves` uniform，不新增）。
    单探针路径保留 `LIGHT_PROBE_METRES` 原实现不变（成本开关，风险 §10.3）。

设计 §5.2：判据是云带亮度直方图出现**受光/背光双峰分离**（局部极大值 ≥2；不规定底/顶极性——“暗底亮顶”若仍要，属风格化选择，对照 `ref-01-sunset-glide.png` 另拍），`?sunoff=1` 差值帧即太阳项的真实占比（门 4）。

- [ ] **Step 1: 写失败的测试**

```ts
// src/dome-cloud-light.test.ts：三采样光学厚度求和（纯函数，真钉子）
import { marchTransmittance, sunColorFor } from './dome-cloud-light';
it('sums optical depth over taps', () => {
  expect(marchTransmittance([0.5, 0.5, 0.5], 40, 0.038)).toBeCloseTo(
    Math.exp(-3 * 0.5 * 40 * 0.038), 6,
  );
  expect(marchTransmittance([], 40, 0.038)).toBe(1); // 空区跳过即透过率 1
});
it('sunColorFor clamps negative elevation (night darkness is owned by cloudBands)', () => {
  expect(sunColorFor(-8)).toEqual(sunColorFor(0)); // 只做钳制，不断言变暗
  for (const c of sunColorFor(-8)) {
    expect(Number.isFinite(c)).toBe(true);
    expect(c).toBeGreaterThanOrEqual(0);
  }
});
```

```ts
// src/dome-cloud.test.ts：shader 结构断言（数得出三采样 + low 分支）
it('marches three sun taps gated by density (high only)', () => {
  const src = readFileSync(new URL('./dome-cloud.ts', import.meta.url), 'utf8');
  expect(src).toMatch(/LIGHT_MARCH_DELTA_METRES\s*=\s*40/); // Δ 具名常量
  expect(src).toMatch(/0\.12/); // 密度门
  expect(src).toMatch(/uOctaves\.lessThan\(1\.5\)/); // low 档走单探针的分支判据
  expect(src).toMatch(/LIGHT_PROBE_METRES/); // low 档保留单次探针
  // 三 tap：Loop(3 或三次显式展开，二选一（断言跟随实现形态）
  expect(/Loop\(\s*3/.test(src) || (src.match(/densityAt\(/g) ?? []).length >= 3).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/dome-cloud-light.test.ts src/dome-cloud.test.ts`
Expected: FAIL（无 `marchTransmittance`，无三采样结构）

- [ ] **Step 3: 实现 `marchTransmittance` + 3 采样 march**

high 档：每步 `density > 0.12` 时沿 `uSunDir` 取 k=1..3（步长 `LIGHT_MARCH_DELTA_METRES`）采样 `densityAt` 求和得 τ，`T = exp(-τ)`（与 `marchTransmittance` 同式，DENSITY_SCALE 换算）；low 档走原单次探针。夜档验证以 `?sunoff=1` 差值 + 夜档帧云带直方图为准，不指望 `sunColorFor` 变暗。

- [ ] **Step 4: 抓帧验证门 4**

**前置说明**：`blob_count` / `edge_grad_p95` / `row_peaks` 三项量具在 Task 9 才升级。本任务执行时只有 P1 版量具
（coverage / tone_span / drift / banding_flips / row_stripes），**`blob_count` 门先目测 blob 数落 3–8，`edge_grad` 先目测边缘锐度高于 P1，`row_peaks` 先目测行剖面 ≥ 2 峰**。Task 9 升级量具后回跑本步骤重新判门。

关雾后抓帧（Task 0.5 已先跑），用新的 P1 基线作参照：`?sunoff=1` 同机位差值帧非零且集中在云带；直方图受光/背光双峰分离（不规定极性）。
否则调 Δ（30–50 m）与密度门（0.08–0.16），**调完重跑本步**。

- [ ] **Step 5: 全量验证**

Run: `npx tsc --noEmit` → 0；`npx vitest run` → 全绿

- [ ] **Step 6: Commit**

```bash
git add src/dome-cloud.ts src/dome-cloud-light.ts src/dome-cloud-light.test.ts src/dome-cloud.test.ts
git commit -m "feat(dome): P1.5 three-tap light march gated by density"
```

---

### Task 5: P1.5 分层——垂直 profile 调制（拆 deck 不在第一轮）

**Files:**
- Modify: `src/dome-cloud.ts`（`densityAt` 或 march 内垂直调制）
- Test: `src/dome-cloud.test.ts`（调制存在性 + 参数范围断言）

**Interfaces:**
- Consumes: `toBoxUV` 的 `y = (p.y - base)/SLAB_HEIGHT`（`src/dome-cloud.ts:207-212`）；Task 9 量具新增 `row_peaks`（行亮度剖面局部极大值 ≥ 2）。
- Produces: `profile(y): number`（**内联定义**，不是外部函数；`y` 是**世界高度，米**）：

  ```ts
  const yn = y.sub(DOME_SLAB.base).div(SLAB_HEIGHT);        // 0..1，sin 用这个
  const ceiling = smoothstep(DOME_SLAB.base + 20, DOME_SLAB.base + 100, y); // 米，只在云底淡入
  // ceiling 在云底部从 0 平滑升到 1，上界之后恒为 1
  ```

  完整调制式：`profile = ceiling.mul(float(0.72).add(float(0.28).mul(sin(yn.mul(3).add(phi).mul(2 * Math.PI)))))`。
  - **量纲写死（复审 S3）**：sin 必须吃 `yn`（0..1，整层 3 个周期）；若把 `y`（米）直接塞进 `sin(y.mul(3))`，波长是 1/3 m；
    若把 `yn` 塞进 ceiling，则 ceiling 恒 0、整层云消失。两处都别混。
  - `sin` 必须从 `three/tsl` import（加进 `dome-cloud.ts:120-143` 那段解构；当前**没有** `sin`，直接用会 ReferenceError）。
  - 乘积落在 **body**（`src/dome-cloud.ts:241` erosion 之前）。**τ 随之同变（拍板 2026-11-10，复审 R10）**：Task 4 的 light march 采样同一个 `densityAt`，调制必然进 τ——这是有意为之（光照与几何一致才自然），不是回归；旧版"只改几何、不改 τ"作废。若实测分层被 τ 抹平，再考虑把 light tap 拆到未调制密度（另立小任务）。
  - φ = 与 puff cloud 不同的 seed（避免同相位条纹）。

设计 §11.3 决策树：先上调制；若 `row_peaks` 仍 < 2，才升级拆 2–3 个真空隙 deck（动 `DOME_SLAB` 契约 + 重算步数预算，**本计划不含**，另开任务）。

- [ ] **Step 1: 写失败的测试**

```ts
it('modulates the vertical profile for 2-3 density peaks', () => {
  const src = readFileSync(new URL('./dome-cloud.ts', import.meta.url), 'utf8');
  expect(src).toMatch(/0\.72/);
  expect(src).toMatch(/^\s+sin,$/m); // sin 必须在 three/tsl 解构里，否则 ReferenceError
  expect(src).toMatch(/ceiling\s*=\s*smoothstep\(/); // ceiling 是内联定义，不是外部函数
  expect(src).toMatch(/const yn = y\.sub\(DOME_SLAB\.base\)\.div\(SLAB_HEIGHT\)/); // sin 吃归一化 y
  expect(src).toMatch(/sin\(yn\.mul\(3\)/); // 量纲写死：米 y 不能直接进 sin
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/dome-cloud.test.ts`
Expected: FAIL（无垂直调制）

- [ ] **Step 3: 实现 profile 调制**

**前置说明**：`blob_count` / `edge_grad_p95` / `row_peaks` 三项量具在 Task 9 才升级。本任务执行时只有 P1 版量具
（coverage / tone_span / drift / banding_flips / row_stripes），**`blob_count` 门先目测 blob 数落 3–8，`edge_grad` 先目测边缘锐度高于 P1，`row_peaks` 先目测行剖面 ≥ 2 峰**。Task 9 升级量具后回跑本步骤重新判门。

关雾后抓帧（Task 0.5 已先跑），用新的 P1 基线作参照：频率/相位按设计式，`φ` 取与 puff 不同的 seed。
目测行剖面 ≥ 2 峰即锁死，否则调频率（2–4）与幅度（0.20–0.32），**调完重跑本步**。

- [ ] **Step 4: 全量验证**

Run: `npx tsc --noEmit` → 0；`npx vitest run` → 全绿

- [ ] **Step 5: Commit**

```bash
git add src/dome-cloud.ts src/dome-cloud.test.ts
git commit -m "feat(dome): P1.5 vertical profile modulation for visible layering"
```

---

### Task 6: P2 两套看法——`uLook` 输出分支（只动颜色，不动密度/alpha）

**Files:**
- Modify: `src/dome-cloud.ts`（`uLook` uniform + 输出分支）、`src/main.ts`（`?cloudlook` 接线）、**`src/world.ts`**（`DomeLike` 加 `setCloudLook?` 可选接口、`WorldHandles.setCloudLook` 透传给 `dome?.setCloudLook`；`world.ts` 必须改，否则 main 拿不到句柄）
- Test: `src/dome-cloud.test.ts`（分支存在 + alpha 直通断言）

**Interfaces:**
- Consumes: `parseCloudLook`（Task 2）；`FALLBACK_BANDS`/`uBand0-3`（`src/dome-cloud.ts:85-90,187-190`，即 `cloudBands[0..3]` 单源灌入）；`puffBandIndex(sunW)`（`src/puff-cloud.ts:166`，**思路同构**：量化光照权重，不是输出亮度——§11.1 定案）；`puff-cloud.ts:112 PUFF_BAND_THRESHOLDS = [0.2, 0.4, 0.68]`（仅参考，体积云阈值独立标定）。
- Produces: `uLook`（0 = soft，1 = flat，默认 0）；flat 路径：取光照权重 → 按云带亮度分位标定的 4 阈值 → 把权重硬切到 `cloudBands[0..3]` 四档代表色（`cloudBands` 是 4 元组，`src/sky-track.ts:58`，有效索引只有 0–3）；**alpha 原值直通**（用户拍板：柔边、切换不变形）。

反目标（设计 §2）：四档糊、切换变形、边缘梳齿——三条都由“不动 alpha + 只动输出”守住，测试钉死。

- [ ] **Step 1: 写失败的测试**

```ts
it('adds a uLook output branch that never touches alpha', () => {
  const src = readFileSync(new URL('./dome-cloud.ts', import.meta.url), 'utf8');
  expect(src).toMatch(/uLook/);
  expect(src).toMatch(/setCloudLook/);
});
it('flat cannot reshape the cloud: alpha accumulation ignores uLook', () => {
  const src = readFileSync(new URL('./dome-cloud.ts', import.meta.url), 'utf8');
  const alphaLines = src.split('\n').filter((l) => l.includes('accA'));
  expect(alphaLines.length).toBeGreaterThan(0);
  for (const l of alphaLines) expect(l).not.toMatch(/uLook/);
});
it('flat path preserves existing alpha exactly (vec4 colorPart, unchangedAccA)', () => {
  const src = readFileSync(new URL('./dome-cloud.ts', import.meta.url), 'utf8');
  // 输出 vec4 的 alpha 分量必须直接是累积值 accA，不能是 uLook 参与计算的表达式
  const out = src.match(/vec4\([^;]*accA[^;]*\)/g) ?? [];
  expect(out.length).toBeGreaterThan(0);
  for (const v of out) expect(v).not.toMatch(/uLook/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/dome-cloud.test.ts`
Expected: FAIL（无 `uLook`）

- [ ] **Step 3: 实现 `uLook` 分支 + `setCloudLook` 句柄 + `main.ts` 接线**

`DomeCloudHandles` 加 `setCloudLook(look: 'soft' | 'flat'): void`；`world.ts` `DomeLike` 透传（照 `setSunColor` 的 `?.` 风格，`src/world.ts:251`）；`main.ts` 启动读 `parseCloudLook` 灌一次。flat 四阈值按云带亮度分位标定（抓帧定数，钉进测试注释）。

- [ ] **Step 4: 抓帧验证 P2 门 5 + 反目标**

**前置说明**：`blob_count` / `edge_grad_p95` / `row_peaks` 三项量具在 Task 9 才升级。本任务执行时只有 P1 版量具
（coverage / tone_span / drift / banding_flips / row_stripes），**`blob_count` 门先目测 blob 数落 3–8，`edge_grad` 先目测边缘锐度高于 P1，`row_peaks` 先目测行剖面 ≥ 2 峰**。Task 9 升级量具后回跑本步骤重新判门。

关雾后抓帧（Task 0.5 已先跑），用新的 P1 基线作参照：soft/flat 同机位，目测 blob 数、coverage 基本不变；
边缘目检无阶梯；`banding_flips` 不劣化。否则收窄阈值过渡（dither 或随 alpha 收窄，风险 §10.2），**调完重跑本步**。

- [ ] **Step 5: 全量验证**

Run: `npx tsc --noEmit` → 0；`npx vitest run` → 全绿

- [ ] **Step 6: Commit**

```bash
git add src/dome-cloud.ts src/dome-cloud.test.ts src/main.ts src/world.ts
git commit -m "feat(dome): P2 soft/flat switchable looks, output-side only"
```

---

### Task 7: 地平线 patch 层——1200–1800 m 淡出带里的廉价远云

**Files:**
- Create: `src/dome-horizon.ts`
- Test: `src/dome-horizon.test.ts`
- Modify: `src/world.ts`（挂载 + 透传 + `setDomeVisible` 级联）
- Modify: `src/world.test.ts`（`:136` 的 `WorldView` 字面量补 `headingRad`）

> **模块图纪律**：`src/dome-horizon.ts` 落在 src 根，会被 `module-graph.test.ts:20` 的
> `STATIC_WEBGPU_IMPORT` 扫到——**非 test 文件不得静态 `import ... from 'three/webgpu' / 'three/tsl'`**，
> 必须照 `src/dome-cloud.ts:102-103` 用 `await import()` 再解构。

**Interfaces:**
- Consumes: `DOME_SLAB.fadeStart/fadeEnd`（1200/1800，交接带）；调色单源（`setCloudPalette(bands, haze)` + `setSunColor`，与 deck 同一套灌入）；
  `WorldView`（`src/world.ts:23-26`，现为 `{ camera, radPerPixel }`——**本任务给它新增 `headingRad: number`**：
  接口加一个必填字段，拼装点 `main.ts:337` 由 `camera.getWorldDirection()` 的 yaw 派生
  （`yawRad = atan2(-dir.x, -dir.z)`，与 `game.ts` 的 yaw 同约定：0 = −Z、右转为负；复用一个模块级临时向量，零分配）；
  `world.ts:201` 的 `lastView` 初始字面量同步补 `headingRad: 0`；`src/world.test.ts:136` 的 `update` 字面量同样要补（漏了 `tsc` 会红，S8）。
  puff/sea 消费者只读 `camera`/`radPerPixel`，纯增量不受波及——复审 R9 原以为"扩接口会波及消费者"，
  实核要动**三处**字面量：`main.ts:337`、`world.ts:201`、`world.test.ts:136`）；`?dome=0` 开关语义
  （Review Focus 1；`world.ts` 现只藏 deck——本任务必须把 patch 接进级联）。
- Produces:
  - `PatchSpec = { distanceMetres: number, azimuthDeg: number, yMetres: number, sizeMetres: number, alpha: number, seed: number }`（`azimuthDeg` 是**相对扇区中心**的方位，绝对方位 = bin 中心角 + `azimuthDeg`；`distanceMetres 1300–1700`、`sizeMetres 80–200`、`alpha 0.5–0.8`）
  - `patchesFor(seed: number, binIndex: number): PatchSpec[]`（纯函数：确定性散布，**以 `binIndex * HEADING_BIN_DEG` 为中心的 ±40° 扇区**、距离 1300–1700 m、y 350–440 m、3–8 团，**每个 patch 自带固定 alpha（0.5–0.8，全部 ≥ 可见门 0.5）**；头顶不铺；同 `(seed, binIndex)` 输出恒等，不同 bin 散布不同）
  - `HEADING_BIN_DEG = 20`（朝向量化档距，见下方"patch 散布方向"）
  - `initDomeHorizon(scene, { seed, bands, sunDir }): DomeHorizonHandles`
    seed 决定 patch 散布确定性、bands 决定 patch 颜色（`cloudBands`）、sunDir 决定 patch 亮度偏移；
    world.ts 挂载点从 DomeCloud 初始化链路拿到这些参数，透传进去。
    返回 `{ update, setCloudPalette, setSunColor, setVisible, dispose, readonly count: number }`，单材质单 draw call，糙面片 + 柔边，**与 puff 平涂同色语言**，防“两层云打架”。
  - `world.ts`：与 deck 同 try/catch 挂载（照 `src/world.ts:190-196`），`setDomeVisible(false)` 同时调 `dome?.setVisible` 与 `domeHorizon?.setVisible`（开/关帧做差才干净）。
    **命名用 `domeHorizon`，不用 `horizon`**——`src/horizon.ts` 已被天空地平线占用（`HORIZON` / `horizonGlow`）。

**patch 散布方向（2026-11-10 用户裁定 R9：正前方 = 玩家朝向；第三轮 S2/S10 定生命周期）**：
朝向量化滑窗 + 相机跟随平移——

- 扇区中心 = 量化(相机 yaw, `HEADING_BIN_DEG 20°`)；扇区 = 中心 ±40°。玩家掉头飞，云跟着掉头，任何朝向前方都有云。
- **定位规则（S2 定案）**：`位置 = 相机位置 + distanceMetres × (−sin θ, 0, −cos θ)`，θ = bin 中心角 + `azimuthDeg`
  （与 `game.ts` 的 yaw 同约定：0 = −Z、右转为负——**别写成 (sin,cos)，那是镜像到身后的写法**）；
  距离/方位/尺寸/alpha 在 bin 内对每个 patch 恒定，**随相机平移、不随 yaw 旋转**。
  所以 patch 不会随接近变大——它按“无穷远背景”处理；deck 是有限距离视差。
  **两层运动逻辑不同是明示取舍，不是 bug**（将来谁报“远处的云不长大”，看这句）。
- **alpha 是 per-patch 固定值**（0.5–0.8），**删掉距离淡出曲线**（R8 的 1200→1350 淡入那套作废：距离恒定后它只会让近端 patch 永远半透明）。
  唯一的淡入是补生时 `PATCH_FADE_IN 0.15s`。
- **合并规则（S10）**：跨 bin 时保留旧组里绝对方位落进新扇区的；只从新组取落在“新暴露 20° 楔形”的补生；
  总数封顶 8（超了按离视轴远→近丢）；`binIndex = ((round(yawDeg / 20) + 9) mod 18) − 9`（18 个 bin，±180° 共用 −9）；
  跨边界 **2° 滞回**（`HEADING_BIN_HYST_DEG 2`），防相机 yaw 在边界抖动时反复补生/回收。
- **补生角与淡入**：新楔形离实际视轴 ≥30°（跨 bin 瞬间视轴在边界，楔形近端在 center+20°）；
  满舵 `TURN_RATE 1.25 rad/s`≈71.6°/s 下，12° 余量 = 0.17s > 0.15s，淡入在入画前走完（0.3s 会在画边留 44% 的跳变）。
- 与“不铺满 360°”不冲突：任意时刻存活的 patch 只占玩家前方 ±40° 一带，全环不同时存在。

用户拍板：远处糙、数量少、只要**玩家的**正前方（朝向滑窗 ±40°，不铺满 360°）；散布不要密布。

- [ ] **Step 1: 写失败的测试**

```ts
// src/dome-horizon.test.ts
import { patchesFor } from './dome-horizon';
describe('patchesFor', () => {
  it('scatters 3-8 visible patches ahead in the fade band', () => {
    const ps = patchesFor(7, 0);
    expect(ps.length).toBeGreaterThanOrEqual(3);
    expect(ps.length).toBeLessThanOrEqual(8);
    for (const p of ps) {
      expect(p.distanceMetres).toBeGreaterThanOrEqual(1300);
      expect(p.distanceMetres).toBeLessThanOrEqual(1700);
      expect(Math.abs(p.azimuthDeg)).toBeLessThanOrEqual(40);
      expect(p.sizeMetres).toBeGreaterThanOrEqual(80);
      expect(p.sizeMetres).toBeLessThanOrEqual(200);
      expect(p.alpha).toBeGreaterThanOrEqual(0.5); // 全部过可见门：spec 数 = 可见数
      expect(p.alpha).toBeLessThanOrEqual(0.8);
    }
  });
  it('is deterministic per (seed, bin)', () => {
    expect(patchesFor(7, 0)).toEqual(patchesFor(7, 0));
    expect(patchesFor(7, 0)).not.toEqual(patchesFor(8, 0));
    expect(patchesFor(7, 0)).not.toEqual(patchesFor(7, 1)); // 跨 bin 散布不同（滑窗补生的来源）
  });
});
```

```ts
// src/world.test.ts（既有 import.meta.glob 源码断言风格，见 setInterior 用例）
it('setDomeVisible cascades to the horizon ring (?dome=0 kills both)', () => {
  const src = sources['./world.ts'];
  // 命名是 domeHorizon（src/horizon.ts 已被天空地平线占用），别写成 horizon?
  expect(src).toMatch(/domeHorizon\?\.setVisible\?/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/dome-horizon.test.ts src/world.test.ts`
Expected: FAIL with "patchesFor not defined"

- [ ] **Step 3: 实现 `patchesFor` + `initDomeHorizon` + `world.ts` 挂载透传**

面片用 puff 同款四档色（`cloudBands`），只读调色单源；
**`update` 做两件事：相机跟随平移 ＋ 朝向滑窗维护**——`headingRad` 按上面的规则量化/滞回得当前 bin，
bin 内每个 patch 的距离/方位/尺寸/alpha 恒定，位置按上面的定位公式算（随平移、不随 yaw 旋转）；
跨 bin 按上面的合并规则补生/回收，补生带 `PATCH_FADE_IN 0.15s`（满舵下 12° 余量 = 0.17s，入画前走完）；
**per-patch alpha 固定 0.5–0.8，不再有距离曲线**——spec 数 = 可见数，blob 门与单测同口径。
patch y 区间 = `DOME_SLAB.base - 30 ~ DOME_SLAB.base + 60`（即 350~440 m），跨在 deck 底缘（380 m）上、海天线高度——
`y` 上限 440 m 的那部分落在 deck 底缘之上，但 1350 m 处 patch 已满不透明，合成是遮挡不是叠加；**Task 0.5 关雾后此区间不会被 fog 糊**。
60 m 机位平视时，这层云落在水平线上方 **9.7~16.3°**（y 350-440 / d 1300-1700 / 机位 60 m 的几何），正好在 fov 60° 画面内。
验收机位俯仰角 = 0°（纯平视），避免俯角看到 patch 顶或仰角看到 patch 底。

`world.update` 内新增调用链（参照 `dome?.update` 的模式，`src/world.ts:277`）：

```ts
domeHorizon?.update?.(t, sunDir, view);
```

（`DomeHorizonHandles` 必须带 `update`；若最终实现没有，本步视为未完成。）

- [ ] **Step 4: 抓帧验证交接**

**先复测 R7 异常瓣（复审 S6）**：按 Task 0.5 的口径检查 rows 330-420 / ±5° 的 on/off 差值瓣；仍在则先定性，不得用该帧标定 patch 的 alpha 与距离。

`?pos=0,60,-300` 低空平视：海平面有云，1200 m 处 deck 与 patch 交接无断线/双影；`?dome=0` 时 patch 同灭。否则调 patch 距离/尺寸/透明，**调完重跑本步**。

- [ ] **Step 5: 全量验证**

Run: `npx tsc --noEmit` → 0；`npx vitest run` → 全绿

- [ ] **Step 6: Commit**

```bash
git add src/dome-horizon.ts src/dome-horizon.test.ts src/world.ts src/world.test.ts
git commit -m "feat(dome): cheap horizon patch ring in the fade band (heading window)"
```

---

### Task 8: DOF 修云——先 spike 定修法，细审后合并（用户要求）

**Files:**
- Spike（审据，随 fix 一起提交）: `artifacts/dome-audit/dof-spike.md`
- Modify（定案后）: `src/post.ts`
- Test: `src/post.test.ts`（定案对应的 preset/结构断言）

**Interfaces:**
- Consumes: 管线 `pass → bloom → dof → smaa`（`src/post.ts:6`）；`dof(lit, viewZ, focus, focal, bokeh)`（`src/post.ts:225`，`dof()` 即成品图）；`POST_HIGH.dof = true` / `POST_LOW.dof = false`（`src/post.ts:76,88`）；云 `depthWrite: false`（`src/dome-cloud.ts:329`）拿远平面深度被按最大 CoC 糊（P1 review 的 DOF 云糊问题）。
- Produces: 修法结论——**本 spike 是「全局关远景 DOF」，不可能做到「只云不关海」**：云 `depthWrite = false`，云/天空/1200 m 外海在深度缓冲里共用远平面值，post 阶段只有 viewZ 和颜色、没有云 mask，无法按区域区分（「区域钳制」等于「全局关远景 DOF」）。
  原候选 A「云 mesh 不写 `viewZ`」已证伪：`viewZ` 是 pass 级 `scenePass.getViewZNode()`（`src/post.ts:208`），非 mesh 级可控。
  **钳制方向易写反，按 Step 1 模板写**。`DepthOfFieldNode` 源码在 `node_modules/three/examples/jsm/tsl/display/DepthOfFieldNode.js`，**不在 `src/nodes/display/`**。
  **合并前必须经 reviewer 细审**（用户要求），spike 文档为审据。

本任务是 P1.5/P2 验收可信度的前置：美学判断若钉在糊掉的成片上，soft/flat 对比失真。

- [ ] **Step 1: 写 spike（不写产品代码）**

`artifacts/dome-audit/dof-spike.md` 按下面模板写（单候选：CoC 钳制；抓 `?post=1` vs `?post=0` 同机位帧）：

```markdown
# DOF 云糊修复 spike

## 实测前提（Task 0.5 已先关 dome 雾）
关雾后 dome 的 NodeMaterial.fog=false 已落地，云的真实颜色/coverage 不再被雾色污染。

## 结论（先在代码里 spike 验证，再决定是否合入）
**本 spike 是「全局关远景 DOF」，不可能做到「只云不关海」**（云 depthWrite=false，深度缓冲共用远平面值，post 阶段无法按区域 mask）。

## 钳制方向（避免写反）
DepthOfFieldNode 内部（`node_modules/three/examples/jsm/tsl/display/DepthOfFieldNode.js:375`）：
  signedDist = viewZNode.negate().sub(focusDistanceNode);
viewZ 是负值，远的 viewZ 更负。
- 要钳制「远距离过大的 CoC」，需给传进去的 viewZ 加一个下限：
  viewZ.clamp(largeNegative, 0)
  或者等价写法：viewZ.max(largeNegative)
  这样太远（更负）的点会被「夹回」到 largeNegative 对应的 CoC。
- 不要写成 `.min(positiveClamp)`——方向完全错。
- 不要写成 `.min(-largeNegative)`——虽然数值上同义，但容易被误读为「全图最大 CoC」。

## 验证方法
spike 后抓 `?post=1` vs `?post=0` 同机位帧：
- 云的边缘是否还被 DOF 糊得看不清分层？
- 海面远景是否也被「牺牲」掉了？（预期：是，全局关）
- banding_flips 是否劣化？

## 源码路径
dof Node 的源码位置：`node_modules/three/examples/jsm/tsl/display/DepthOfFieldNode.js`，
不是 `src/nodes/display/`。参考时别找错目录。
```

- [ ] **Step 2: 送审修法**

把 spike 的钳制参数摆给 reviewer（用户），拍板后再动 `src/post.ts`。**未拍板前不得进 Step 3。**

- [ ] **Step 3: 实现定案修法 + 测试**

测试钉 preset/结构（如：云深度分支被剔除的源码断言，或 CoC 钳制常量断言）。

- [ ] **Step 4: 抓帧验证**

post 开/关两帧：`banding_flips` 不劣化，flat 档边界不被抹成渐变。否则调钳制参数，**重跑本步**。

- [ ] **Step 5: 全量验证**

Run: `npx tsc --noEmit` → 0；`npx vitest run` → 全绿

- [ ] **Step 6: Commit**

```bash
git add src/post.ts src/post.test.ts artifacts/dome-audit/dof-spike.md
git commit -m "fix(dome): keep DOF from blurring the cloud deck (reviewed approach)"
```

---

### Task 9: 量具升级 + 双档验收 + 写 P1.5/P2 验收报告

**Files:**
- Modify: `artifacts/dome-audit/measure.py`
- Create: `docs/superpowers/reviews/2026-11-10-dome-cloud-p15-p2-review.md`

**Interfaces:**
- Consumes: P1 量具（`THRESHOLD = 8`、`STRIPE_GRAD = 3.0`，`artifacts/dome-audit/measure.py:19-20`；输入 `on/off/t0/t30` 四帧）；P1 基线（coverage 29.78%、tone_span 0.327、drift 3.16/255、桌面 p95 20.9 ms——**这组是关雾前的值，Task 0.5 Step 3 会重抓并回填新值**）；Task 2 的 `?sunoff=1`；Task 6 的 `?cloudlook`。
- Produces: 新指标 `blob_count`（云带内面积 > 0.2% 连通块，目标 3–8）、`edge_grad_p95`（目标高于 P1 基线）、`row_peaks`（行亮度剖面极大值 ≥ 2）；sun-on/off 差值门（门 4）；验收报告（逐门 通过/未测，未过写原因与下一步）。

验收矩阵（设计 §8 + 用户拍板①）：桌面 high（`p95 < 24 ms`）+ **桌面 low 档代真机**（`p95 < 33.3 ms`，注明为代理值）；soft/flat 各一组；`?sunoff` 差值一组。

- [ ] **Step 1: 升级量具（`blob_count` / `edge_grad_p95` / `row_peaks` / sun-diff）**

`measure.py` 加四个输出，保持旧四个口径不变（P1 基线可比）。

- [ ] **Step 2: 跑量具确认可用（用 P1 旧帧回归）**

Run: `python artifacts/dome-audit/measure.py artifacts/dome-audit/p1-on.png artifacts/dome-audit/p1-off.png --rect 474.875,0,434.25,772 --t0 artifacts/dome-audit/p1-t0.png --t30 artifacts/dome-audit/p1-t30.png`
Expected: 旧四项与 P1 报告一致（新指标在旧帧上仅记录，不判门）

- [ ] **Step 3: 抓帧（soft / flat / sunoff × high / low）**

固定 `?pos=` 与 `?qa=frozen`，帧矩阵（复审 R11，显式列全，不写"X 对 Y 帧"总数）：

| 组 | 参数 | 档 | 帧 | 用途 |
|---|---|---|---|---|
| soft | `?dome=1` 与 `?dome=0` | high/low | `qa.step(0)`/`qa.step(1800)` | 8 帧＝4 对 on/off 差分（blob/coverage/tone/drift） |
| flat | `?cloudlook=flat&dome=1` | high/low | t0/t30 | 4 帧，与 soft 组同机位对应帧对比（gate 5；无需 dome=0 对照） |
| sunoff | `?sunoff=1&dome=1` | high/low | t0 | 2 帧，与 soft 组 on 帧做 sun-diff（gate 4；drift 不需要） |

合计 14 帧。命名 `p15-high-on-t0.png` / `p15-low-off-t30.png` / `p15-high-flat-t0.png` / `p15-high-sunoff-t0.png` 等，不混命名。
`?qa=frozen` 下云漂移只随 `elapsed`（Review Focus 2）。

- [ ] **Step 4: 跑量具判门 1–7**

Run: 同 Step 2 口径逐组跑。门：blob 3–8、edge_grad 上升、row_peaks ≥ 2、tone_span ≥ 0.2 且 sun-diff 非零、soft/flat 覆盖与 blob 基本不变、banding 不劣化、high p95 < 24 ms 且 low p95 < 33.3 ms（代理）。未过回对应 Task 调参，**调完重跑本步**。

**回跑清单（复审 R12）**：Task 3 Step 3、Task 4 Step 4、Task 5 Step 3、Task 6 Step 4 四处先前的"目测代判"，
在本步以升级后的量具全部重判——未重判不得写验收报告。

- [ ] **Step 5: 写验收报告并提交**

报告逐门记 通过 / 未测 / 未过（未过写原因与下一步；手机真机记 N/A 并注明桌面 low 为代理）。

```bash
git add artifacts/dome-audit docs/superpowers/reviews/2026-11-10-dome-cloud-p15-p2-review.md
git commit -m "test(dome): p1.5 + p2 acceptance frames, measurements and review"
```

---

## Self-Review

**1. Spec coverage**

| Spec 章节 | 落在哪个任务 |
|---|---|
| §5.1 形状三旋钮 + Worley 决策树 + 风险 10.1 | Task 3 |
| §5.2 3 采样 light march + 跳过阈值 + 风险 10.3 | Task 4（含 `marchTransmittance` 纯函数与 `LIGHT_MARCH_DELTA_METRES` 具名常量） |
| §5.3 分层调制 + §11.3 拆 deck 决策树（本轮只做调制） | Task 5 |
| §5.4 uLook + §11.1 量化光照权重 + 不动 alpha + `?cloudlook` | Task 6（parser 在 Task 2；alpha 直通有真单测） |
| §11.2 `?sunoff=1` 证伪门 4 | Task 2（开关）+ Task 4/9（量测） |
| §11.4 drift 降级为体检带 | Task 9（只记“非静止、无跳变”，不判 2–12 区间） |
| §11.5 `uOctaves` 漏写 bug | Task 1（首位） |
| §12 拍板①桌面 low 代真机 / ②方案 B / ③DOF 细审 | Task 9 / Task 7（含 `setDomeVisible` 级联） / Task 8 |
| §8 七门 + §5.5 新三指标 | Task 9 |
| 用户加项：散布不要密布 | Task 3（阈值）+ Task 7（3–8 团）+ Task 9（blob 门） |
| 用户加项：海平面云（前向 patch 层） | Task 7 |
| P1 遗留 DOF 糊云（P1 review 的 DOF 云糊问题） | Task 8 |

**2. Step scan**：每步一个动作一个可检查结果。抓帧标定类步骤（Task 3–6 Step 3/4）按 P1 计划同款口径写成“调完重跑本步”闭环；Task 8 Step 2 是显式停工门（未拍板不得进 Step 3）。

**3. Type consistency**：`DomeCloudHandles` 新增只在 Task 6 加 `setCloudLook`；`DomeHorizonHandles` 在 Task 7 自含（`update` + `count: number`）；`world.ts` 两处都用 `?.` 透传（与 `setSunColor` 一致），且 `setDomeVisible` 同时调 `dome` 与 `domeHorizon`；`marchTransmittance(densities, deltaMetres, sigmaPerDensity)` 纯函数归 `dome-cloud-light.ts`，**只作 TS 侧单测与文档注释，shader 内用 `Fn(...)` 内联复刻同式（TSL 不能调用 TS 函数）**；`Vec3 = [number, number, number]`（`sky-track`）全计划统一；`parseCloudLook` 返回 `'soft' \| 'flat'` 字符串联合，Task 6 直接消费。

**4. Review Focus**：五条各有归属 task 与测试（见头部列表），无空挂。

**5. Proportion**：本计划约 700 行（2026-11-10 并入审核修复后；并入前 549 行），spec 235 行 + P1 计划 839 行的前例——增量主要在测试代码与验收闭环，无实现体转写；阈值类常量钉死测试，数值标定留抓帧闭环。
