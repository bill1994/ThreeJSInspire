# 穿云体积感（in-cloud volumetric pass）执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 穿云时相机被云瓣真实包裹（近距淡出收敛 + 相机锚定兜底瓣），DOM 白纱降级为兜底层并随太阳方位着色。

**Architecture:** 三层递进——现场云瓣的近距淡出从「3–12 m 归零」改为「1.2–10 m、下限 0.3 的软曲线」；新增一组相机锚定的兜底瓣（独立组、depthWrite=false、透明度由进云度驱动）；DOM 白纱封顶降到 0.45 并按视线与太阳的夹角混色。纯函数全部进 `in-cloud.ts`，Three 侧只做接线。

**Tech Stack:** three 0.186 TSL（WebGPU 后端）、vitest、现有 qa 冻结抓帧协议。

**Spec:** `docs/superpowers/reviews/2026-11-07-frame-composition-review.md` 第五节（机制与「假」的四根源）。

## 审核对原方案的修正

原方案 2 写的是「贴脸放大到出画再淡出」。审核后修正：puff 瓣是**真实几何**（`buildPuffGeometry` 瓣簇网格，DoubleSide），不是板片——不存在「放大」这个动作，视角逼近时它们本来就随透视变大。云在脸上消失的真正机制是逐片元近距淡出（`puff-cloud.ts:211-219`，3 m 内归零）。因此本计划的三层是：现场瓣软曲线（替代硬归零）、兜底瓣（补相机周围的体积）、纱（兜底 + 着色）。

## Global Constraints

- 所有 TSL/`three/webgpu`/`three/tsl` 引用必须留在动态 `import()` 内（`material.test.ts` 绊线钉死）。
- `material.fog = false`；透明 puff 材质保持 `alphaTest = 0.02` + `depthWrite = true`（防透明挖洞，`puff-cloud.ts:203-206`）。
- 兜底瓣材质必须 `depthWrite = false`（低透明度大面积层写深度会挖掉身后所有云）。
- 兜底瓣 mesh 命名**不得**匹配 `/^puff-\d+$/`（`far-field.ts:67` 按此正则回收现场云，命中即整组被拖走）。
- 兜底瓣不得进入 `blobs`（否则白雾永久触发——兜底瓣永远贴着相机）。
- 兜底瓣跟随**相机**，不是飞机（`far-field.ts:84` 同一教训：rig 有滞后）。
- 白纱永不全屏不透明（`WHITEOUT_MAX` 封顶语义保留）。
- 低档（`setQuality(false)`）不得出现「空气穿云」：兜底瓣在两档都保持可见。
- 数值全部经 `src/in-cloud.ts` 纯函数或 `src/puff-field.ts` 常量进出，测试钉值。

## Review Focus

1. **兜底瓣被 far-field 回收**：名字撞上 `/^puff-\d+$/` 就整组被拖走（历史 bug「云场满天乱跳」复发）→ Task 2 绊线测试。
2. **兜底瓣污染 blobs**：若并入 `get blobs()`，相机永远在「云里」，白雾常驻 → Task 2 断言 blobs 只来自现场组。
3. **低透明层写深度**：兜底瓣若 `depthWrite = true`，身后场景被挖洞（`puff-cloud.ts:203-206` 同款）→ Task 2 源码绊线。
4. **低档空气穿云**：`setQuality(false)` 若连兜底瓣一起藏，手机上白雾满屏但什么都没有（`puff-cloud.ts:309-313` 注释同款问题）→ Task 3 断言。
5. **纱色与太阳脱节**：`veilTintCss` 输入非有限数必须回退中性色，不得 NaN 进 CSS → Task 1 测试。

---

### Task 1: `in-cloud.ts` 纯函数——纱色、纱上限、兜底瓣透明度

**Files:**
- Modify: `src/in-cloud.ts`
- Test: `src/in-cloud.test.ts`

**Interfaces:**
- Produces: `veilTintCss(fwdDotSun: number): string`（输入 cos∈[-1,1]，输出 CSS 色）；`interiorOpacity01(prox: number): number`（0..1）；`WHITEOUT_MAX` 由 `0.6` 改 `0.45`。
- Consumes: 无（纯函数，不引 THREE）。

- [ ] **Step 1: 写失败测试**（`src/in-cloud.test.ts` 追加）

```ts
describe('veilTintCss', () => {
  it('背太阳侧给灰紫，朝太阳侧给暖米，中间取混色', () => {
    expect(veilTintCss(-1)).toBe('#cfc6da');
    expect(veilTintCss(1)).toBe('#ffe9c4');
    expect(veilTintCss(0)).toBe('#e7d7cf');
  });
  it('非有限输入回退中性色 #e7d7cf，绝不输出 NaN 色', () => {
    expect(veilTintCss(Number.NaN)).toBe('#e7d7cf');
  });
});
describe('interiorOpacity01', () => {
  it('prox 0.7 起步、0.95 饱和、越界钳制', () => {
    expect(interiorOpacity01(0.7)).toBe(0);
    expect(interiorOpacity01(0.95)).toBe(1);
    expect(interiorOpacity01(1)).toBe(1);
    expect(interiorOpacity01(0.5)).toBe(0);
  });
});
```

并把现有 `WHITEOUT_MAX` 相关断言从 `0.6` 改 `0.45`。

- [ ] **Step 2: 跑测试确认失败** — `npx vitest run src/in-cloud.test.ts`，预期 FAIL（函数不存在/值是 0.6）。
- [ ] **Step 3: 实现** — `veilTintCss`：两端色 `#cfc6da`/`#ffe9c4`，按 `clamp((fwdDotSun+1)/2, 0, 1)` 线性插值 RGB 后转 `#rrggbb`；非有限数直接返回 `#e7d7cf`。`interiorOpacity01 = clamp((prox − 0.7) / 0.25, 0, 1)`。`WHITEOUT_MAX` 改 0.45 并在注释里写明「兜底层，体积感由兜底瓣提供」。
- [ ] **Step 4: 跑测试确认通过** — 同 Step 2，预期全 PASS。
- [ ] **Step 5: Commit** — `feat(in-cloud): sun-aware veil tint + interior shell opacity curve`

### Task 2: 兜底瓣——相机锚定的内部壳层

**Files:**
- Modify: `src/puff-cloud.ts`（`initPuffClouds` 返回的 handle 增 `setInterior`）
- Test: `src/puff-cloud.test.ts`

**Interfaces:**
- Produces: `PuffHandle.setInterior(inCloud01: number, cam: { x: number; y: number; z: number }): void`；场景内新组 `puff-interior`，子 mesh 名 `incloud-shell-00..04`；每瓣材质 `opacityNode = uniform(base_i) × uniform(interior01)`。
- Consumes: `buildPuffGeometry`（复用 bank/scraps 变体）、Task 1 的 `interiorOpacity01`（由调用方传入已算好的 `inCloud01`）。

- [ ] **Step 1: 写失败绊线测试**（`src/puff-cloud.test.ts` 追加，源码签名风格）

```ts
it('兜底瓣命名不被 far-field 回收正则命中', () => {
  expect('incloud-shell-00').not.toMatch(/^puff-\d+$/);
  const src = sources['./puff-cloud.ts'];
  expect(src).toMatch(/incloud-shell-/);
  expect(src).toMatch(/depthWrite = false/); // 兜底瓣材质块
});
it('兜底瓣不进 blobs：blobs getter 只遍历现场组', () => {
  const src = sources['./puff-cloud.ts'];
  expect(src).toMatch(/get blobs\(\)[\s\S]*?group\.children/);
});
```

- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现** — `initPuffClouds` 内新组 `puff-interior`：5 个 mesh，复用 bank/scraps 几何，scale 0.45–0.7，摆位以组原点为心、半径 8–14 m 环形分布（方位角均匀 + 抖动）、y 偏移 ±4 m；材质 `depthWrite = false`、`alphaTest = 0.02`、无近距淡出、色带复用 `PUFF_BAND_COLORS` 但省略逐瓣 shade；每瓣一个 `uniform(base_i)`（0.10/0.14/0.18 交错），乘 `uniform(interior01)`。`setInterior(inCloud01, cam)`：组 position 设为相机全三维坐标；`interiorUniform.value = interiorOpacity01(inCloud01)`；`group.visible = inCloud01 > 0.001 && !hidden`（场外零 draw call）。`setQuality` 不动兜底瓣（低档保留，见 Review Focus 4）。`dispose` 一并清理。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: Commit** — `feat(puff): camera-anchored interior shell for in-cloud volume`

### Task 3: 现场瓣近距淡出软曲线

**Files:**
- Modify: `src/puff-field.ts:51-52`（常量）、`src/puff-cloud.ts:211-219`（曲线）
- Test: `src/puff-field.test.ts`、`src/puff-cloud.test.ts`

**Interfaces:**
- Produces: `PUFF_FADE_NEAR = 1.2`、`PUFF_FADE_FAR = 10`、`PUFF_NEAR_FLOOR = 0.3`。
- Consumes: 无。

- [ ] **Step 1: 写失败测试** — `puff-field.test.ts` 钉新常量值；`puff-cloud.test.ts` 源码绊线：opacityNode 段含 `PUFF_NEAR_FLOOR` 与 `mix`（曲线形如 `mix(float(PUFF_NEAR_FLOOR), float(0.96), smoothstep(NEAR, FAR, dist))`）。
- [ ] **Step 2: 跑测试确认失败**（旧值 3/12、无 floor）。
- [ ] **Step 3: 实现** — 替换常量与曲线；注释写明「近处片元保留 0.3 不归零：钻云时瓣以半透明软墙包裹相机，深度仍写（沿用 alphaTest 防洞约定）」。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: Commit** — `feat(puff): floored near-fade so the cloud wraps the camera`

### Task 4: 纱降级为兜底 + 着色接线

**Files:**
- Modify: `src/hud.ts:44,296-302`、`src/game.ts:396-403,606-614`
- Test: `src/hud.test.ts`（源码绊线）、`src/game.test.ts`

**Interfaces:**
- Produces: `HudHandle.setWhiteout(v: number, tintCss?: string)`；`initGame` opts 增 `sunDir?: { x: number; y: number; z: number }` 与 `onInCloud?: (inCloud01: number, cam: { x: number; y: number; z: number }) => void`。
- Consumes: Task 1 的 `veilTintCss`。

- [ ] **Step 1: 写失败绊线测试** — hud 源码含 `setWhiteout(v: number, tintCss?` 与按 tint 写 `background`；game 源码含 `onInCloud?.(` 调用点与 `veilTintCss(`。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现** — hud：`setWhiteout(v, tintCss)` 存 tint，写 `whiteout.style.opacity` 与 `whiteout.style.background`（tint 缺省保持 `#e8dfd6`）。game：opts 收 `sunDir`（main 传 `liveSunDir`），每帧 `const fwdDotSun = pose.forward.x*sunDir.x + pose.forward.y*sunDir.y + pose.forward.z*sunDir.z`，`hud?.setWhiteout(whiteout01(camCloud01), veilTintCss(fwdDotSun))`；帧末 `opts.onInCloud?.(cloudProx, { x: camera.position.x, y: camera.position.y, z: camera.position.z })`。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: Commit** — `feat(hud): sun-tinted backstop veil + in-cloud sink wiring`

### Task 5: world/main 接线

**Files:**
- Modify: `src/world.ts`（WorldHandle 增 `setInterior`，转发 `puffs?.setInterior?.`）、`src/main.ts:178`（initGame opts 传 `sunDir: { x: liveSunDir.x, y: liveSunDir.y, z: liveSunDir.z }` 与 `onInCloud: (v, cam) => world?.setInterior?.(v, cam)`）
- Test: `src/world.test.ts`（源码绊线：`setInterior` 存在并转发 `puffs?.setInterior`）

- [ ] **Step 1: 写失败绊线测试**。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**（两处各 3–5 行，注意 `world` 在 `initGame` 之前已就绪，`main.ts:155` 早于 `main.ts:178`）。
- [ ] **Step 4: `npx vitest run` 全绿**。
- [ ] **Step 5: Commit** — `feat(world): route in-cloud signal to interior shell`

### Task 6: QA 冻结抓帧验收（qa 三条门）

**Files:**
- 无源码改动；产出截图与结论写回 `docs/superpowers/reviews/2026-11-07-frame-composition-review.md` 第五节。

- [ ] **Step 1: 相机放云心** — `http://localhost:5199/?pos=265,153,-120&qa=frozen`：场景含 `puff-interior` 组；`.porco-whiteout` opacity ≤ 0.46；画面出现包裹相机的瓣（非纯平纱）。
- [ ] **Step 2: 进出平滑** — 沿 z 轴取 `?pos=265,153,-40 / -80 / -120` 三帧：白雾 opacity 单调上升无跳变（qa 门「白雾平滑进出」）。
- [ ] **Step 3: 不凭空消失** — 云心帧里现场瓣与兜底瓣同时可见（qa 门「不凭空消失」）。
- [ ] **Step 4: 纱色随太阳** — `?pos=...&sun=0,10` vs `?pos=...&sun=180,10`：白雾背景色分别偏暖/偏灰紫。
- [ ] **Step 5: 低档** — 施加降档后兜底瓣仍在场（Review Focus 4）。
- [ ] **Step 6: Commit** — `docs(reviews): in-cloud volumetric pass verification`

## Self-Review 记录

- 覆盖：spec 四根源 → Task 3（根源 1/4）、Task 1+4（根源 2）、Task 2+3（根源 3）；qa 三条门 → Task 6。
- 类型一致：`setInterior(inCloud01, cam)` 在 Task 2/4/5 三处签名一致；`veilTintCss`/`interiorOpacity01` 仅 Task 1 定义、后续只消费。
- 比例：任务均为接口+钉值级描述，无函数体转录。
