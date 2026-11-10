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
- 模块挂载必须 **try/catch**，失败只丢自己（照 `src/world.ts:189-195`）。
- 漂移速度：detail **3.5 m/s**（tile 400 m）、weather **2.0 m/s**（tile 8000 m）——`DOME_DRIFT`（`src/dome-cloud-field.ts:109-120`，P1 门 3 实测反推后的值，初版 0.35 m/s 肉眼静止）；偏移按层分别计算（`driftOffset(elapsedSeconds, layer)`）。**本轮不动速度。**
- 所有时间取 **`elapsed`（累加 dt）**，不得 `Date.now()` / `performance.now()`。
- 纹理类型：96³ / 32³ 用 `Data3DTexture`；512² weather 用 `DataTexture` + `RepeatWrapping`。
- 单测文件与被测模块同名。提交信息 `feat(dome):` / `test(dome):` / `fix(dome):` 作用域。
- **用户拍板（2026-11-10，§12）：** ① 性能门手机那半用**桌面 low 档**代替真机；② 云底不降，海平面云另起 patch 层（方案 B）；③ DOF 这轮修，但修法必须过细审。散布密度先按设计门（blob 3–8）做，出效果再调。

## Review Focus

1. **`?dome=0` 与 `?puff=0` 同时给**：两套云全关（含 horizon patch），画面只剩天穹——开/关帧做差是覆盖率的唯一量法。→ Task 7 的 `setVisible` 级联测试。
2. **冻结抓帧（`?qa=frozen` + `qa.step()`）下云的漂移**：必须只随 `elapsed` 推进，两次同 `step(n)` 跑出不同的云即失败。→ Task 3 的 elapsed-only 断言。
3. **夜档（太阳仰角 -8°）的真暗归 `cloudBands`**：`sunColorFor` 只做钳制（-8° ≡ 0° 的暖橙），从不断言变暗；夜档量级骤降在 `sky-track` 的 `cloudBands` 里，测试必须钉对地方。→ Task 4 的钳制断言 + cloudBands 夜档备注。
4. **`?sunoff=1` 必须真把太阳项清零**：同机位 sun-on/off 两帧差值 ≈ 太阳项贡献，差值 ~0 说明开关是假的。→ Task 2 的接线 + Task 9 的量测门。
5. **flat 档不得碰 alpha**：量化只改颜色输出，soft/flat 同机位 `coverage` 与 `blob_count` 基本不变，否则“切换像换了一朵云”。→ Task 6 的 alpha 直通单测 + Task 9 抓帧门。

---

### Task 1: 修 P1 遗留 bug——`setQuality` 从不写 `uOctaves`

**Files:**
- Modify: `src/dome-cloud.ts`（`setQuality` 内）
- Test: `src/dome-cloud.test.ts`

**Interfaces:**
- Consumes: `qualityParams(high: boolean): DomeCloudQuality`（`src/dome-cloud.ts:57`，high `{steps:28,octaves:2}` / low `{steps:16,octaves:1}`）；`uSteps` / `uOctaves` uniforms（`src/dome-cloud.ts:191-192`）；shader 侧 `mix(detailBase, blended, uOctaves.sub(1))`（`src/dome-cloud.ts:237`）。
- Produces: `setQuality(high)` 同时写 `uSteps.value` 与 `uOctaves.value`。无新接口。

设计 §11.5：low 档一直在付第二个 detail octave（每步 4 次 3D 取数）。本轮第一件事修掉，否则后面所有性能数都量在漏水的桶上。

- [ ] **Step 1: 写失败的测试**

```ts
// src/dome-cloud.test.ts
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('./dome-cloud.ts', import.meta.url), 'utf8');
it('setQuality writes both uSteps and uOctaves (P1 §11.5 leak)', () => {
  const body = src.slice(src.indexOf('function setQuality'), src.indexOf('function setQuality') + 600);
  expect(body).toMatch(/uSteps\.value/);
  expect(body).toMatch(/uOctaves\.value/);
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
git commit -m "fix(dome): setQuality writes uOctaves so low stops paying the second octave"
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

改完跑抓帧（Task 9 量具先行可用 P1 版）：`?dome=1/0` 同机位对，`blob_count` 落 3–8 且 `edge_grad_p95` 高于 P1 基线即锁死；否则在 (0.32–0.36, 0.40–0.44) 与 (0.18–0.26) 内调，**调完重跑本步**。

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
- Consumes: `transmittance(sigmaT, distanceMetres)`（`src/dome-cloud-light.ts:40`）；`hgPhase` 常量已 ×4π 归一（P1 fix I2，`src/dome-cloud.ts:248-251`）；现有单次探针 `LIGHT_PROBE_METRES = 120`（`src/dome-cloud.ts:41`，low 档保留）；`sunColorFor(elevationDeg)`（`src/dome-cloud-light.ts:116-123`，**只做钳制**：`Math.max(0, …)` 把负仰角钉到 0° 暖橙，夜档真暗归 `cloudBands`——Review Focus 3）。
- Produces:
  - `marchTransmittance(densities: readonly number[], deltaMetres: number, sigmaPerDensity: number): number`（`τ = Σ d·Δ·σ`，返回 `exp(-τ)`；dome-cloud.ts 以 `DENSITY_SCALE` 调用）
  - march 内 `density > 0.12` 才沿 `uSunDir` 取 k=1..3（`Δ = LIGHT_MARCH_DELTA_METRES = 40`）求和；low 档走原单次探针（成本开关，风险 §10.3）。

设计 §5.2：判据是云带亮度直方图出现暗底/亮顶分离（`?sunoff=1` 差值帧即太阳项的真实占比，门 4）。

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
  expect(src).toMatch(/LIGHT_PROBE_METRES/); // low 档保留单次探针分支
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/dome-cloud-light.test.ts src/dome-cloud.test.ts`
Expected: FAIL（无 `marchTransmittance`，无三采样结构）

- [ ] **Step 3: 实现 `marchTransmittance` + 3 采样 march**

high 档：每步 `density > 0.12` 时沿 `uSunDir` 取 k=1..3（步长 `LIGHT_MARCH_DELTA_METRES`）采样 `densityAt` 求和得 τ，`T = exp(-τ)`（与 `marchTransmittance` 同式，DENSITY_SCALE 换算）；low 档走原单次探针。夜档验证以 `?sunoff=1` 差值 + 夜档帧云带直方图为准，不指望 `sunColorFor` 变暗。

- [ ] **Step 4: 抓帧验证门 4**

`?sunoff=1` 同机位差值帧非零且集中在云带；直方图暗/亮分离。否则调 Δ（30–50 m）与密度门（0.08–0.16），**调完重跑本步**。

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
- Produces: `profile(y) = ceiling(y)·(0.72 + 0.28·sin(2π·(3y + φ)))`（`φ` 由 seed 定，避免与近景云同相，设计 §5.3）。

设计 §11.3 决策树：先上调制；若 `row_peaks` 仍 < 2，才升级拆 2–3 个真空隙 deck（动 `DOME_SLAB` 契约 + 重算步数预算，**本计划不含**，另开任务）。

- [ ] **Step 1: 写失败的测试**

```ts
it('modulates the vertical profile for 2-3 density peaks', () => {
  const src = readFileSync(new URL('./dome-cloud.ts', import.meta.url), 'utf8');
  expect(src).toMatch(/0\.72/);
  expect(src).toMatch(/sin\(/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/dome-cloud.test.ts`
Expected: FAIL（无垂直调制）

- [ ] **Step 3: 实现 profile 调制**

频率/相位按设计式，`φ` 取与 puff 不同的 seed。抓帧看 `row_peaks ≥ 2`，否则调频率（2–4）与幅度（0.20–0.32），**调完重跑本步**。

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
- Modify: `src/dome-cloud.ts`（`uLook` uniform + 输出分支）、`src/main.ts`（`?cloudlook` 接线）
- Test: `src/dome-cloud.test.ts`（分支存在 + alpha 直通断言）

**Interfaces:**
- Consumes: `parseCloudLook`（Task 2）；`FALLBACK_BANDS`/`uBand0-3`（`src/dome-cloud.ts:85-90,187-190`，即 `cloudBands[4]` 单源灌入）；`puffBandIndex(sunW)`（`src/puff-cloud.ts:166`，**思路同构**：量化光照权重，不是输出亮度——§11.1 定案）；`puff-cloud.ts:112 PUFF_BAND_THRESHOLDS = [0.2, 0.4, 0.68]`（仅参考，体积云阈值独立标定）。
- Produces: `uLook`（0 = soft，1 = flat，默认 0）；flat 路径：取光照权重 → 按云带亮度分位标定的 4 阈值 → 回填 `cloudBands[4]` 代表色；**alpha 原值直通**（用户拍板：柔边、切换不变形）。

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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/dome-cloud.test.ts`
Expected: FAIL（无 `uLook`）

- [ ] **Step 3: 实现 `uLook` 分支 + `setCloudLook` 句柄 + `main.ts` 接线**

`DomeCloudHandles` 加 `setCloudLook(look: 'soft' | 'flat'): void`；`world.ts` `DomeLike` 透传（照 `setSunColor` 的 `?.` 风格，`src/world.ts:251`）；`main.ts` 启动读 `parseCloudLook` 灌一次。flat 四阈值按云带亮度分位标定（抓帧定数，钉进测试注释）。

- [ ] **Step 4: 抓帧验证 P2 门 5 + 反目标**

soft/flat 同机位：`blob_count`、`coverage` 基本不变；边缘目检无阶梯；`banding_flips` 不劣化。否则收窄阈值过渡（dither 或随 alpha 收窄，风险 §10.2），**调完重跑本步**。

- [ ] **Step 5: 全量验证**

Run: `npx tsc --noEmit` → 0；`npx vitest run` → 全绿

- [ ] **Step 6: Commit**

```bash
git add src/dome-cloud.ts src/dome-cloud.test.ts src/main.ts src/world.ts
git commit -m "feat(dome): P2 soft/flat switchable looks, output-side only"
```

---

### Task 7: 地平线 patch 层——1200–1800 m 淡出带里的廉价远云（方案 B）

**Files:**
- Create: `src/dome-horizon.ts`
- Test: `src/dome-horizon.test.ts`
- Modify: `src/world.ts`（挂载 + 透传 + `setDomeVisible` 级联）

**Interfaces:**
- Consumes: `DOME_SLAB.fadeStart/fadeEnd`（1200/1800，交接带）；调色单源（`setCloudPalette(bands, haze)` + `setSunColor`，与 deck 同一套灌入）；`WorldView`（`src/world.ts`，patch 跟随相机）；`?dome=0` 开关语义（Review Focus 1；`world.ts` 现只藏 deck——本任务必须把 patch 接进级联）。
- Produces:
  - `patchesFor(seed: number): PatchSpec[]`（纯函数：位置/尺寸/朝向确定性散布，正前方 ±40°、距离 1200–1800 m、3–8 团，与 deck 的 blob 门同量级；头顶不铺，视锥外靠 frustum cull）
  - `initDomeHorizon(scene): DomeHorizonHandles`（`{ update, setCloudPalette, setSunColor, setVisible, dispose, readonly count: number }`，单材质单 draw call，糙面片 + 柔边，**与 puff 平涂同色语言**，防“两层云打架”）
  - `world.ts`：与 deck 同 try/catch 挂载（照 `src/world.ts:189-195`），`setDomeVisible(false)` 同时调 `dome?.setVisible` 与 `horizon?.setVisible`（开/关帧做差才干净）。

用户拍板：远处糙、数量少、只要正前方；散布不要密布。

- [ ] **Step 1: 写失败的测试**

```ts
// src/dome-horizon.test.ts
import { patchesFor } from './dome-horizon';
describe('patchesFor', () => {
  it('scatters 3-8 patches ahead in the fade band', () => {
    const ps = patchesFor(7);
    expect(ps.length).toBeGreaterThanOrEqual(3);
    expect(ps.length).toBeLessThanOrEqual(8);
    for (const p of ps) {
      expect(p.distanceMetres).toBeGreaterThanOrEqual(1200);
      expect(p.distanceMetres).toBeLessThanOrEqual(1800);
      expect(Math.abs(p.azimuthDeg)).toBeLessThanOrEqual(40);
    }
  });
  it('is deterministic per seed', () => {
    expect(patchesFor(7)).toEqual(patchesFor(7));
    expect(patchesFor(7)).not.toEqual(patchesFor(8));
  });
});
```

```ts
// src/world.test.ts（既有 import.meta.glob 源码断言风格，见 setInterior 用例）
it('setDomeVisible cascades to the horizon ring (?dome=0 kills both)', () => {
  const src = sources['./world.ts'];
  expect(src).toMatch(/horizon\?\.setVisible\?/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/dome-horizon.test.ts src/world.test.ts`
Expected: FAIL with "patchesFor not defined"

- [ ] **Step 3: 实现 `patchesFor` + `initDomeHorizon` + `world.ts` 挂载透传**

面片用 puff 同款四档色（`cloudBands`），只读调色单源；`update` 只做相机跟随：patch 摆在相机前方固定方位/距离，随相机平移；远近淡出复用 `fadeAt` 的 1200→1800 口径，与 deck 同带交接。

- [ ] **Step 4: 抓帧验证交接**

`?pos=0,60,-300` 低空平视：海平面有云，1200 m 处 deck 与 patch 交接无断线/双影；`?dome=0` 时 patch 同灭。否则调 patch 距离/尺寸/透明，**调完重跑本步**。

- [ ] **Step 5: 全量验证**

Run: `npx tsc --noEmit` → 0；`npx vitest run` → 全绿

- [ ] **Step 6: Commit**

```bash
git add src/dome-horizon.ts src/dome-horizon.test.ts src/world.ts src/world.test.ts
git commit -m "feat(dome): cheap horizon patch ring in the fade band (approach B)"
```

---

### Task 8: DOF 修云——先 spike 定修法，细审后合并（用户要求）

**Files:**
- Spike（审据，随 fix 一起提交）: `artifacts/dome-audit/dof-spike.md`
- Modify（定案后）: `src/post.ts`
- Test: `src/post.test.ts`（定案对应的 preset/结构断言）

**Interfaces:**
- Consumes: 管线 `pass → bloom → dof → smaa`（`src/post.ts:6`）；`dof(lit, viewZ, focus, focal, bokeh)`（`src/post.ts:225`，`dof()` 即成品图）；`POST_HIGH.dof = true` / `POST_LOW.dof = false`（`src/post.ts:76,88`）；云 `depthWrite: false` 拿远平面深度被按最大 CoC 糊（P1 报告 §3.4）。
- Produces: 修法（二选一，由 spike 定）：A. 云 mesh 不写入 `viewZ`（深度分支剔除）；B. 天空/云区 CoC 钳制。**合并前必须经 reviewer 细审**（用户要求），spike 文档为审据。

本任务是 P1.5/P2 验收可信度的前置：美学判断若钉在糊掉的成片上，soft/flat 对比失真。

- [ ] **Step 1: 写 spike（不写产品代码）**

`artifacts/dome-audit/dof-spike.md`：A/B 两候选各抓 `?post=1` vs `?post=0` 同机位帧，记 `banding_flips` 与档边界清晰度，推荐其一并写清风险。

- [ ] **Step 2: 送审修法**

把 spike 结论摆给 reviewer（用户），定 A 或 B 后再动 `src/post.ts`。**未拍板前不得进 Step 3。**

- [ ] **Step 3: 实现定案修法 + 测试**

测试钉 preset/结构（如：云深度分支被剔除的源码断言，或 CoC 钳制常量断言）。

- [ ] **Step 4: 抓帧验证**

post 开/关两帧：`banding_flips` 不劣化，flat 档边界不被抹成渐变。否则换候选，**回 Step 1**。

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
- Consumes: P1 量具（`THRESHOLD = 8`、`STRIPE_GRAD = 3.0`，`artifacts/dome-audit/measure.py:19-20`；输入 `on/off/t0/t30` 四帧）；P1 基线（coverage 29.78%、tone_span 0.327、drift 3.16/255、桌面 p95 20.9 ms）；Task 2 的 `?sunoff=1`；Task 6 的 `?cloudlook`。
- Produces: 新指标 `blob_count`（云带内面积 > 0.2% 连通块，目标 3–8）、`edge_grad_p95`（目标高于 P1 基线）、`row_peaks`（行亮度剖面极大值 ≥ 2）；sun-on/off 差值门（门 4）；验收报告（逐门 通过/未测，未过写原因与下一步）。

验收矩阵（设计 §8 + 用户拍板①）：桌面 high（`p95 < 24 ms`）+ **桌面 low 档代真机**（`p95 < 33.3 ms`，注明为代理值）；soft/flat 各一组；`?sunoff` 差值一组。

- [ ] **Step 1: 升级量具（`blob_count` / `edge_grad_p95` / `row_peaks` / sun-diff）**

`measure.py` 加四个输出，保持旧四个口径不变（P1 基线可比）。

- [ ] **Step 2: 跑量具确认可用（用 P1 旧帧回归）**

Run: `python artifacts/dome-audit/measure.py artifacts/dome-audit/p1-on.png artifacts/dome-audit/p1-off.png --rect 474.875,0,434.25,772 --t0 artifacts/dome-audit/t0.png --t30 artifacts/dome-audit/t30.png`
Expected: 旧四项与 P1 报告一致（新指标在旧帧上仅记录，不判门）

- [ ] **Step 3: 抓帧（soft / flat / sunoff × high / low）**

固定 `?pos=` 与 `?qa=frozen`：`?dome=1/0`、`?cloudlook=soft/flat`、`?sunoff=1`、`qa.step(1800)` 前后，共 8 帧（high/low 各 4）。`?qa=frozen` 下云漂移只随 `elapsed`（Review Focus 2）。

- [ ] **Step 4: 跑量具判门 1–7**

Run: 同 Step 2 口径逐组跑。门：blob 3–8、edge_grad 上升、row_peaks ≥ 2、tone_span ≥ 0.2 且 sun-diff 非零、soft/flat 覆盖与 blob 基本不变、banding 不劣化、high p95 < 24 ms 且 low p95 < 33.3 ms（代理）。未过回对应 Task 调参，**调完重跑本步**。

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
| 用户加项：海平面云（方案 B 前向 patch） | Task 7 |
| P1 遗留 DOF 糊云（报告 §3.4） | Task 8 |

**2. Step scan**：每步一个动作一个可检查结果。抓帧标定类步骤（Task 3–6 Step 3/4）按 P1 计划同款口径写成“调完重跑本步”闭环；Task 8 Step 2 是显式停工门（未拍板不得进 Step 3）。

**3. Type consistency**：`DomeCloudHandles` 新增只在 Task 6 加 `setCloudLook`；`DomeHorizonHandles` 在 Task 7 自含（`count: number`）；`world.ts` 两处都用 `?.` 透传（与 `setSunColor` 一致），且 `setDomeVisible` 同时调 `dome` 与 `horizon`；`marchTransmittance(densities, deltaMetres, sigmaPerDensity)` 纯函数归 `dome-cloud-light.ts`，dome-cloud.ts 以 `DENSITY_SCALE` 调用；`Vec3 = [number, number, number]`（`sky-track`）全计划统一；`parseCloudLook` 返回 `'soft' \| 'flat'` 字符串联合，Task 6 直接消费。

**4. Review Focus**：五条各有归属 task 与测试（见头部列表），无空挂。

**5. Proportion**：计划约 420 行，spec 235 行 + P1 计划 839 行的前例——增量主要在测试代码与验收闭环，无实现体转写；阈值类常量钉死测试，数值标定留抓帧闭环。
