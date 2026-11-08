# 太阳光路 knee+斜率阈值闪光 + 背阳天空端压暗 Implementation Plan（v2）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 光路亮度压回 `roadBudget` 并改成斜率驱动的稀疏闪光；背阳海面经天空端（`HORIZON.AWAY_*`）压暗且海-天接缝不裂；海面反射剔除太阳盘（去重）。

**Architecture:** 全部新数学进 `src/sea/sun-road.ts` / `src/horizon.ts`（JS 镜像 + 单测钉值），`src/sea/material.ts` 只做 TSL 接线；闪光 = 现有逐片元 spec 场的余弦阈值（几何驱动、天然随 mip 距离稀疏），**无新纹理、无 time uniform**；背阳走天空端一处改两种渲染器跟随。

**Tech Stack:** three 0.186 TSL（WebGPU）、vitest、vite、`__porco` QA 钩子。

**Spec:** 本文件 + 复审 `docs/superpowers/reviews/2026-11-07-sun-road-plan-review.md`（其 §5 改法已全部吸收，E1–E5/M1–M8/V1–V6 逐条落实）；基线与可重跑量测 `artifacts/sun-road-review/`（HEAD 23cae89）。

## v1 → v2 变更记录（为什么重写）

v1 经外部复审（见 Spec）与逐条复算核实，存在执行级硬伤与机制错配，v2 的对应决定：

1. **E1** 所有路径改为 `src/sea/…`（v1 写成 `src/…`，会建出平行模块且绊线扫不到）。
2. **E2** knee 大值断言改为 `(0.999, 1]` 区间（`1−exp(−50) === 1` 是 double 事实）。
3. **E3/M1/M2** sparkle 从「白噪声纹理 × 阈值」换成 **specDot 余弦阈值**（`GLINT_COS_THRESHOLD`）——用几何、不用纹理，天然随距离 mip 化；v1 的 1.17cm 纹理在 A 机位是每像素 10–31 格的椒盐噪点。
4. **E4** `ROAD_PEAK` **保留**（v1 误删且要求 gate 不动，自相矛盾）；预算由 knee×`ROAD_CEILING` 执行。
5. **M3** sparkle 用 **lerp 形** `cont × (1 + (BOOST−1) × core)`，不是 v1 的加法形（加法会叠到 1.74）。
6. **M4** 接受 knee 的对比度压缩并显式钉值：`KNEE_K = 0.8` 使路心/路外比 = 2.65（≥2.5 单测红线）；改前 5.7× 是预算违规的来源，不追回。
7. **M5/M6/M7** 背阳压暗改天空端（`AWAY_GAIN`/`AWAY_COLOR` 一处改）；海面雾色**等于**天空在该方位的地平线色（复用 `antiSolarCool` 同形曲线，线性空间推导，不冻结字节）；v1 的 `hazeAzimuthGate`/`reflectionAwayDim`/`hazeAway` 常数全部废弃。
8. **M8** 图内 `sunXZ/viewXZ` 归一化补 `.length().max(1e-4)` 防护（JS 镜像兜底不替代图内防护）。
9. **V1** 验收模型修正：白纱主体在片段图，bloom 只贡献 ~13pp 过曝面积——禁止调 `post.ts` 的 bloom 参数，全部压力在片段图常量上。
10. **V2** 补「路还在」下限；**V3** 分带钉死为 `measure_bands.py` 口径、基线 = `measurements.json`；**V4** 量测剔除 R0/R1 环缝行；**V5** FALL 帧降级为记录不作为通过条件；**V6** 删除「目测 p99」（线性预算由单测钉）。
11. **新增（复审未覆盖）**：双重太阳去重——`skyColorTsl` 含 glow+disc 而海面另有 pow 路径；knee 把路压到 0.757 后反射里的盘（0.3×fres）会成为第二太阳。海面反射采样剔除 disc、保留 glow（glow 是大气晕，真实镜子也反射它）。

## Global Constraints

- 所有 TSL/`three/webgpu`/`three/tsl` 引用留在动态 `import()` 内（`material.test.ts` 绊线钉死）。
- **路径一律 `src/sea/…`**（E1）；本计划不新建任何模块文件。
- TSL mix 用函数形不用方法形（r186 方法形因子错位，`material.ts:383-385` 注释）。
- **TSL 同构 helper 命名 `<name>Tsl`**（E5），绊线优先匹配 `SUN_ROAD.*` / `HORIZON.*` 常量。
- 图内所有 XZ 归一化带 `.length().max(1e-4)`（M8）。
- spec 的 pow 指数不得硬编码：`SUN_ROAD.GLOSS_POW = 96`，镜像与图共用。
- 每个 shader 常数有 JS 镜像 + 单测（`KNEE_K` 在 `SUN_ROAD`，不留在图里）。
- `SEA_PALETTE.haze === SKY_PALETTE.horizon` 契约与 `HAZE_MAX`/`HAZE_DENSITY_PER_METRE` 不动；`post.ts` 的 bloom 参数不动（V1）。
- 不新增 GPU 资源（无纹理、无 render target），`dispose()` 不需要新条目。
- `SUN_ROAD.lowTierGain` 机制与值不动（1.0）。

## Review Focus

1. **闪光密度失控 → 白纱复发**：specDot 阈值是密度旋钮，屏幕空间密度是记录指标 → Task 4 量测 + Task 2 的 core 亮度区间单测。
2. **knee 吃平方位门** → Task 2 路心/路外比 ≥ 2.5 单测红线。
3. **双重太阳去重不完整** → Task 3 绊线：海面 `skyColorTsl(…, false)`；glow 保留的理由写在 `sky-webgpu.ts` 注释里。
4. **第二套方位曲线复发** → 全仓库只允许 `antiSolarCool` 一条曲线形状；Task 3 的 TSL 版必须同指数同常量。
5. **NaN 经 XZ 归一化进图**（FALL/俯视机位）→ Task 3 源码绊线匹配 `max(1e-4)`。
6. **环缝行污染 glint 计数**（A 机位 y≈508 一像素亮线，实测中位 126→169）→ Task 4 量测脚本先剔除跳变行。

---

### Task 1: `horizon.ts` 背阳端改值（天空侧机制）+ 推导式镜像

**Files:**
- Modify: `src/horizon.ts`（`AWAY_GAIN`、`AWAY_COLOR`、新增 `awayHorizonLinear()`）
- Test: `src/horizon.test.ts`

**Interfaces:**
- Produces: `HORIZON.AWAY_GAIN = 0.75`（0.8→0.75）、`HORIZON.AWAY_COLOR = '#5a3f60'`（#8f5a90→#5a3f60，起始值，Task 4 在目标界内可调）；`awayHorizonLinear(): [number, number, number]` —— `mix(线性(#ff9a5a), 线性(AWAY_COLOR), AWAY_GAIN)` 的 JS 推导（M7：推导式，不冻结字节；sRGB→linear 就地实现，horizon.ts 不引 THREE）。
- Consumes: 无。
- 语义：`antiSolarCool` 形状与指数（1.2）不动——它是全仓库唯一的方位曲线（M6）。
- 目标（Task 4 B 验收据此）：背阳天际线线性亮度 ≤ **0.17**（改前 0.210）；显示空间远海均值亮度降 ≥15%。

- [ ] **Step 1: 写失败测试**（`src/horizon.test.ts` 追加；既有 AWAY 相关期望值按新常数重算更新）

```ts
describe('awayHorizonLinear', () => {
  it('是线性空间推导：mix(horizon, AWAY_COLOR, AWAY_GAIN)，亮度 ≤ 0.17', () => {
    const [r, g, b] = awayHorizonLinear();
    // 0.25*1.000 + 0.75*lin(0x5a)=0.328；g=0.25*0.318+0.75*lin(0x3f)=0.117；b=0.25*0.103+0.75*lin(0x60)=0.114
    expect(r).toBeCloseTo(0.328, 2);
    expect(g).toBeCloseTo(0.117, 2);
    expect(b).toBeCloseTo(0.114, 2);
    expect(0.2126 * r + 0.7152 * g + 0.0722 * b).toBeLessThanOrEqual(0.17);
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `npx vitest run src/horizon.test.ts`。
- [ ] **Step 3: 实现** — 改两个常数（注释写明目标与「0.55+#7f4f7e 会更亮，弃」的复审后复算结论）；`awayHorizonLinear()` 用标准 sRGB 解码 `c <= 0.04045 ? c/12.92 : ((c+0.055)/1.055)^2.4`。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: Commit** — `feat(sky): darken the anti-solar horizon at the source`

### Task 2: `sun-road.ts` knee + 斜率阈值闪光镜像

**Files:**
- Modify: `src/sea/sun-road.ts`
- Test: `src/sea/sun-road.test.ts`

**Interfaces:**
- Produces（全部导出）:
  - `SUN_ROAD.ROAD_CEILING`（= `roadBudget('high')` ≈ 0.757，连续部分上限）
  - `SUN_ROAD.KNEE_K = 0.8`（knee 软度；推导：core=ceiling×BOOST 须 >0.82 且比值 ≥2.5，见测试）
  - `SUN_ROAD.GLOSS_POW = 96`（现 `material.ts:346` 硬编码迁入）
  - `SUN_ROAD.GLINT_COS_THRESHOLD = 0.9985`、`SUN_ROAD.GLINT_COS_BAND = 0.0005`（密度旋钮：阈值越低核心越密）
  - `SUN_ROAD.SPARKLE_BOOST = 1.3`
  - `roadSpecKnee(x: number, k: number): number` = `1 − exp(−x·k)`，NaN→0
  - `sunRoadGain(specDot, azimuthDiff, nearFade)` **语义更新**：`roadSpecKnee(specDot^GLOSS_POW × BASE × gate(azDiff) × nearFade, KNEE_K) × ROAD_CEILING`；`gate`/`ROAD_PEAK`/`ROAD_FLOOR`/`WIDTH_DEG`/near-fade 全部不动（E4）
  - `sparkleGlint(cont: number, specDot: number): number` = `cont × (1 + (SPARKLE_BOOST−1) × smoothstep(GLINT_COS_THRESHOLD, THRESHOLD+BAND, specDot))`
- Consumes: 既有 `roadBudget`、`roadMask`。
- 依据：M3 lerp 形；M4 KNEE_K 推导（core ≈ 0.895 ∈ (0.82, 1.05)，比值 2.65 ≥ 2.5）。

- [ ] **Step 1: 写失败测试**（`src/sea/sun-road.test.ts` 追加；既有 `sunRoadGain` 期望值按新语义更新）

```ts
describe('roadSpecKnee', () => {
  it('单调、0→0、大值落在 (0.999, 1]（E2：1−exp(−50)===1 是 double 事实）', () => {
    expect(roadSpecKnee(0, 1)).toBe(0);
    expect(roadSpecKnee(2, 1)).toBeGreaterThan(roadSpecKnee(1, 1));
    const top = roadSpecKnee(500, 1);
    expect(top).toBeGreaterThan(0.999);
    expect(top).toBeLessThanOrEqual(1);
  });
  it('NaN → 0', () => { expect(roadSpecKnee(Number.NaN, 1)).toBe(0); });
});
describe('预算与对比度（复审 5.3）', () => {
  it('连续部分不越 ROAD_CEILING', () => {
    expect(sunRoadGain(1, 0, 1)).toBeLessThanOrEqual(SUN_ROAD.ROAD_CEILING + 1e-9);
  });
  it('路心/路外比 ≥ 2.5（KNEE_K=0.8 → 2.65；改前 5.7 是预算违规来源）', () => {
    const road = sunRoadGain(1, 0, 1);
    const off = sunRoadGain(1, (25 * Math.PI) / 180 * 3, 1);
    expect(road / off).toBeGreaterThanOrEqual(2.5);
  });
  it('sparkle 核心 lerp 形：亮度 ∈ (0.82, 1.05)，只有核心过 bloom 阈值', () => {
    const core = sparkleGlint(sunRoadGain(1, 0, 1), 1);
    expect(core).toBeGreaterThan(0.82);
    expect(core).toBeLessThan(1.05);
  });
  it('阈值下不起闪', () => {
    expect(sparkleGlint(0.5, SUN_ROAD.GLINT_COS_THRESHOLD - 1e-4)).toBeCloseTo(0.5, 6);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现** — 常量带注释（KNEE_K 推导、GLINT_COS_THRESHOLD 的 Cox-Munk 语义：法线落在镜面半角锥内的片元才起闪，密度随坡度方差变化；GLOSS_POW 迁移说明）。`sunRoadGain` 改 specDot 签名。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: Commit** — `feat(sea): budget-limited road knee and slope-gated glint mirrors`

### Task 3: 接线——`skyColorTsl` 去重 + `material.ts` 图重写

**Files:**
- Modify: `src/sky-webgpu.ts`（`skyColorTsl` 加 `includeDisc` 参数）
- Modify: `src/sea/material.ts`（光路段、雾色段、NaN 防护）
- Test: `src/sea/material.test.ts`（绊线）、`src/sky-webgpu.ts` 若有测试同步

**Interfaces:**
- Consumes: Task 1 `awayHorizonLinear()`、`HORIZON.AWAY_GAIN`；Task 2 全部常量与 `roadSpecKnee`/`sparkleGlint` 的 TSL 同构（helper 命名 `roadSpecKneeTsl`/`sparkleGlintTsl`，E5 约定）。
- Produces: `skyColorTsl(tsl, dir, sunDir, includeDisc = true)` —— 默认 true（穹顶不变），海面传 `false`（去重：镜中太阳像由 specular 路负责；glow 保留——大气晕是天空辐射的一部分）。`material.ts` 图内新段：
  1. `sunXZ/viewXZ` 归一化带 `.max(1e-4)`（M8）；
  2. `cosAz` → `coolTsl`（与 `antiSolarCool` 同形：`away^1.2 × lowSky × AWAY_GAIN`，dirY 用反射线 y）→ 雾色 `mix(vec3(HAZE_COLOR), vec3(awayHorizonLinear()), coolTsl)`，雾量公式不动（M5/M6/M7 解）；
  3. 光路：`cont = roadSpecKneeTsl(pow(specDot, GLOSS_POW) × BASE × gate × nearFade, KNEE_K) × ROAD_CEILING`；`glint = sparkleGlintTsl(cont, specDot)`；`withRoad = withFoam + glitter × glint`。

- [ ] **Step 1: 写失败绊线测试**（`src/sea/material.test.ts` 追加/更新，常量匹配制，E5）

```ts
it('光路是 knee+阈值闪光形：常量进场，无硬编码 96', () => {
  const src = sources['./material.ts'];
  expect(src).toMatch(/SUN_ROAD\.ROAD_CEILING/);
  expect(src).toMatch(/SUN_ROAD\.GLINT_COS_THRESHOLD/);
  expect(src).toMatch(/roadSpecKneeTsl/);
  expect(src).not.toMatch(/pow\(96/);
});
it('海面反射剔除太阳盘（双重太阳去重），雾色随方位取天空边缘色', () => {
  const src = sources['./material.ts'];
  expect(src).toMatch(/skyColorTsl\(tsl,\s*reflected,\s*sunU,\s*false\)/);
  expect(src).toMatch(/awayHorizonLinear/);
  expect(src).not.toMatch(/reflectionAwayDim|hazeAzimuthGate/); // v1 废弃项不得残留
});
it('XZ 归一化有 NaN 防护；mix 全函数形', () => {
  const src = sources['./material.ts'];
  expect(src).toMatch(/length\(\)\.max\(1e-4\)/);
  expect(src).not.toMatch(/\)\.mix\(/);
});
```

- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**（三处；全部函数形 mix）。`skyColorTsl` 的 disc 项包进 `includeDisc` 分支并加注释（去重理由 + glow 保留理由）。
- [ ] **Step 4: 跑测试确认通过** — `npx vitest run`，全绿（含被更新语义的既有用例）。
- [ ] **Step 5: Commit** — `feat(sea): sparkle road wiring, azimuth haze from sky edge, sun-disc dedup`

### Task 4: QA 冻结抓帧验收（钉死口径）+ 常量绿冒烟 + 回写

**Files:**
- Modify: `docs/superpowers/reviews/2026-11-07-frame-composition-review.md`（回写）
- Modify: `artifacts/sun-road-review/measure_bands.py`（加环缝行剔除与路心/路外量测，口径如下）

- [ ] **Step 1: 常量绿冒烟** — `withRoad` 后临时 `.add(vec3(0.0, 0.5, 0.0))`：G 通道抬升、R/B 不动、无紫斑。异常即停（评审文档第二节 tripwire）。测完还原。
- [ ] **Step 2: 复拍 A/B**（`?qa=frozen` + noop `__porco.game.update`，448×797 同 9:16；机位同 `artifacts/sun-road-review/README.md`）。
- [ ] **Step 3: 量测验收**（口径 = `measure_bands.py` 分带：sky 0–0.35 / mid 0.35–0.62 / sea-mid 0.45–0.62 / near 0.62–0.90 / bottom 0.90–1.00；基线 = `measurements.json`；**先剔除中位数跳变 >20 的行**——V4 环缝）：
  - **A**（向阳）：mid p95 ≤ **195**（基线 230.1）；sea-mid blown% ≤ **15**（基线 38.4）；路心（rows 0.55–0.80 内最亮 60px 列窗）均值 ≥ **190**（基线 213）且左缘路外均值 ≤ **100**（基线 94.4）——「路还在、别处变暗」（V2）；路区内离散 glint（局部极大 +25 以上、剔除环缝行）≥ **10**（基线 0，连续奶油带）。
  - **B**（背阳）：sea-mid p50 ≤ **89** 且 near p50 ≤ **70**（基线 104.4 / 81.9，−15%）；远缘与天际线色差每通道 ≤ **12**（M5 解后应天然成立）；far-sea 均值 R−B ≤ **25**（基线 36，去粉）。
  - **C**（FALL）：实况页 pointer 按住上拉复现，`.porco-status` 出现 FALL 时抓帧——**仅记录** road/haze 像素占比，不作为通过条件（V5）；P4 维持开放单。
  - 连续两轮不达标的项记录实测值并标注「待调参」（旋钮：`GLINT_COS_THRESHOLD` 密度、`AWAY_GAIN/AWAY_COLOR` 深度、`KNEE_K`），不无限刷数。
- [ ] **Step 4: 全量回归** — `npx vitest run` 全绿、`npx tsc --noEmit` 干净。
- [ ] **Step 5: Commit** — `docs(reviews): knee road + away-sky verification`

## Self-Review 记录

- 覆盖：E1→路径；E2→Task 2 测试；E3/M1/M2→Task 2 阈值机制；E4→ROAD_PEAK 保留声明；E5→命名约定+常量绊线；M3→lerp 测试；M4→KNEE_K 推导+比值红线；M5/M6/M7→Task 1+3 天空端机制；M8→绊线；V1→验收模型；V2→A 下限对；V3→口径钉死+基线落盘；V4→剔除行；V5→C 降级；V6→删除；双重太阳→Task 3 includeDisc。
- 类型一致：`awayHorizonLinear()` Task 1 产出 / Task 3 消费；`sunRoadGain(specDot,…)`/`sparkleGlint(cont, specDot)` Task 2 定义 / Task 3 同构；常量名全部 `SUN_ROAD.*`。
- 比例：四个任务，接口+钉值级，无函数体转录；验收全部带基线数值与出处。
