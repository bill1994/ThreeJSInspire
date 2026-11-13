# painted-valley 风格化改造 · 总案

**日期**：2026-11-13
**性质**：总案（umbrella plan）。它只定**顺序、隔离、闸门、回退**，不写实现细节。
**配套研究**：[`specs/2026-11-13-painted-valley-style-alignment.md`](../specs/2026-11-13-painted-valley-style-alignment.md)（五层拆解、逐模块改法、反面清单）
**每期开工前**：按 `INDEX.md:106` 的规矩，把该期扩成带 fail-first 测试的任务计划，落 `plans/YYYY-MM-DD-<phase>.md`。

---

## Goal

把「四档等距量化 + 全实时」的现有画面，改成「少色数 + 一条硬边 + 软体块 + 笔触重采样」的手绘观感，同时**不牺牲飞行速度感与帧预算**。

分四期交付，每期独立可回退：

| 期 | 一句话 | 是否动默认帧 |
| --- | --- | --- |
| P0 | 量尺：四个数能一键抓 | 否 |
| P1 | puff 4 档等距 → 2 主色 + 软体块 + 1 条硬边 | 是（挂开关） |
| P2 | 穹顶云 6 带 → 2 带 | 是（挂开关） |
| P3 | 海面远海平涂接管 | 是（挂开关） |
| P4 | 陆地 B3 改写 + 笔触层（**独立仓**） | 是 |
| P5 | Kuwahara + ink（只 high 档） | 是（挂开关） |

## Architecture（依赖图）

```
P0 量尺 ──┬─→ P1 puff ──┬─→ P2 dome ──┬─→ P5 Kuwahara + ink
          └─→ P3 海远海 ──────────────┘
                              P4 陆地 ──（依赖 B2 地形 + 接缝契约，独立仓）
```

规则：

1. **P0 不过，全案不开工。** 抓不出四个数，后面所有「变好了没有」都是感觉。
2. **P1 是整套理论的最小可证伪实验。** 一个文件、零新增采样、可回滚。P1 不成立就中止全案，成本只花一步。
3. **P1/P2/P3 是减法，P5 是加法。** 顺序不能反：先上 Kuwahara 再减量化 = 糊掉的四档灰。
4. **P4 不阻塞 P1–P3。** 陆地是独立仓、独立节奏，但它**阻塞 B2 的烘焙决策**——B3 不定，布局图不要烘。

## Tech Stack

Three.js r186（WebGPU 优先 / WebGL2 回退）、TSL 节点材质、Vitest、Vite 8、`npm run smoke` 帧预算探针。

## Spec

- 风格学依据：`specs/2026-11-13-painted-valley-style-alignment.md` §2（五层）、§4（四种风格化）
- 参考仓：`G:\DSHProject\refs\painted-valley`（MIT 代码 + CC0 美术）
- 陆地生成：`plans/2026-11-05-land-flight-0-to-1.md` B2/B4/B5（本总案不改）
- 陆地着色：同文件 B3（**本总案要求改写**，见 §6 风险 R3）

## Global Constraints（全期不许破）

1. **TSL only**：禁 `ShaderMaterial`、禁 `onBeforeCompile`。
2. **禁静态 `import 'three/webgpu'`**：只能运行时 `await import()`（`toon.ts:toonify()` 已是此模式）。
3. **调色板单源**：所有颜色走 `palettes.ts`，不许在着色文件里写字面量。
4. **除飞机外全场禁量化**（roadmap A3）：硬边只能用 `smoothstep` + `fwidth` 归一，不许 `step()` 切亮度。
5. **竖屏优先**：构图与距离带按竖向视野标定。
6. **字节门纪律**：任何改变默认帧的改动，要么挂在新开关下**默认关**，要么**明确重定基线并重跑六门**。不许悄悄改默认值。
7. **帧预算**：15.0 ms 目标；puff 是当前 p95 元凶（27.9 → 14.1 ms），任何给它加采样的方案默认否决。

## Review Focus

每期合并前必须回答：

- 这一期改的是**结构**还是**参数**？（只调参数的一律打回）
- 有没有新增纹理采样？新增几个？
- 默认帧变了没有？变了挂开关了吗？
- 退得回去吗？（单 commit 可 `git revert`）
- 抓帧对比存哪了？

---

## 0. 隔离与基线（Task 0，全案前置）

### 0.1 现状（2026-11-13 实测）

```
分支：feat/dome-cloud-volumetric（ahead origin 1）
工作树：脏。9 个文件改动 +290/−19，另有未跟踪 visual-presets.ts / visual-presets.test.ts
        其中 palettes.ts +91、post.ts +49、qa.ts +55、main.ts +57 —— 与本案要动的文件高度重叠
无 .worktrees / worktrees 目录，且 .gitignore 未忽略 .worktrees
```

**含义**：现在直接 `git switch -c` 会把这份未提交 WIP 一起带进新分支。那样「退回去」会连这份 WIP 一起退掉，隔离等于没有。

### 0.2 三步走（推荐顺序）

- [ ] **0.2.1 给 WIP 定性**：确认这 9 个改动是什么（疑为 toon-look 期 1 / preset 落地）。是完成态就在现分支打一个 checkpoint 提交：
      `git add -A && git commit -m "checkpoint(look): toon-look phase1 + presets before painted-valley work"`
      不许 `commit --amend`，不许混进本案改动。
- [ ] **0.2.2 建隔离工作区**（二选一，推荐 A）：
      - **A. worktree**（推荐：两个分支能同时在磁盘上，互不打断）
        `echo ".worktrees/" >> .gitignore && git add .gitignore && git commit -m "chore: ignore .worktrees"`
        `git worktree add .worktrees/painted-valley-look -b feat/painted-valley-look`
        注意：`vite` 默认端口会与主工作区冲突，用 `npm run dev -- --port 5174`。
      - **B. 简单分支**（省事，但同一时间只能看一个）
        `git switch -c feat/painted-valley-look`
- [ ] **0.2.3 基线快照**：在新工作区跑 `npm test`、`npm run build`、`npm run smoke`，把当前帧抓 4 组
      （日落主视角 / 云层内 / 低空贴海 / 远海）存 `artifacts/look-baseline/2026-11-13/`，
      连同 `frame-stats` 的 p50/p95 一起存档。**这是全案唯一的「之前」。**

### 0.3 验收

`npm test` 全绿、`npm run build` 通过、四组基线帧入库、基线的档数/硬边宽/笔触覆盖率/ink 密度四个数记在案。

**基线不干净就不许进 P1**——脏基线会让之后每一次「是不是改坏了」都变成猜。

---

## 1. P0 · 量尺

**目的**：把「像不像手绘」变成四个可数字。

| 指标 | 口径 | 工具 |
| --- | --- | --- |
| 档数 | 指定区域颜色的 CDF 峰数 | `qa.ts` 现有 CDF 口径 |
| 硬边宽度 | 档边两侧像素数（1080p，60m 机位） | 新增：边缘梯度直方图 |
| 笔触覆盖率 | 60–400m 带内被 mark 调制像素占比 | 新增 |
| ink 密度 | 描边像素 / 主体像素 | 新增 |

**闸门**：四个数一条命令出结果，且与人工数的一致（抓 3 帧对账）。
**Kill**：抓不出来 → 全案不开工。
**改哪些文件**：`src/qa.ts`、`src/frame-stats.ts`（+ 各自 `.test.ts`）。
**回退**：`git revert <P0 commit>`。

---

## 2. P1 · puff 云（最小可证伪实验）

**目的**：证明「少色数 + 一条硬边 + 软体块」在我们的日落逆光下成立。

**改法**（详见 spec §5.1，此处只列结构）：

1. 删中间档（L\* 52.6）：`bandColorNode` 的三段 `step` + 三层 `mix` 整段改写，**不是改数组长度**；
   `PUFF_BAND_COLORS` 4 元组 → 3 元组，`setCloudPalette` 与 `palettes.ts` 同步，`puffBandColors` 间距单测同步改。
2. 硬边收窄：`smoothstep(0.665, 0.695, w)`。
3. 暗部软体块：`mix(band0, band1, smoothstep(0.25, 0.85, broad))`，`broad` 用现成 `PUFF_LOBE_ATTRIBUTE` + `radial.y`。
4. 底音：`mix(under, col, smoothstep(-0.2, 0.5, localY/halfHeight + light))`。
5. 光里加三项纯算术：`+0.10*radial.y +0.04*(open−0.5) +0.10*surfaceNormal.y`。

**约束**：零新增纹理采样、零新增 pass、零新增 uniform。

**闸门**：档数 = 3；过渡带 ≤ 3px；p95 不升 > 0.5 ms；背光半球不塌成死紫；默认帧变化挂在开关下或已重定基线。
**Kill**：p95 > 29 ms，或档 0 占比 < 20%（坍缩）。
**改哪些文件**：`src/puff-cloud.ts`、`src/palettes.ts`、`src/puff-cloud.test.ts`。
**回退**：`git revert <P1 commit>`（单文件为主，干净）。

---

## 3. P2 · 穹顶云 6 带 → 2 带

**改法**（spec §5.2）：两条量化现在叠着——`TOON_TRANS_STEPS` 给 6 级、`FLAT_BAND_THRESHOLDS` 再给 4 档。

- `dome-cloud.ts:405-421` 的五层 `mix` 套 `step` **整段重写**成单刀 `smoothstep(0.43, 0.47, …)`；
  `TOON_TRANS_DITHER = 1 / TOON_TRANS_STEPS.length` 会变成 1（整片云随机跳档），必须改成固定 ±0.02。
- `FLAT_BAND_THRESHOLDS [0.28,0.61,0.84]` → `[0.30, 0.72]`，色表删 `uBand2`。
- `ambient` 的四色均分（各 ×0.25 = 灰）→ `mix(uHaze, uBand1, heightMix)`。
- **不动**：HG 双瓣、powder、三采样 light march、`STEP_CURVE_POWER 2.2`——这些是便宜的物理解释。

**闸门**：云内水平带 ≤ 2；`uToon=0` 逐位不变；夜档不塌。
**Kill**：夜档塌，或 `setQuality` 触发重烘（`setQuality` 绝不重烘是既有铁律）。
**改哪些文件**：`src/dome-cloud.ts`、`src/palettes.ts`、`src/dome-cloud.test.ts`。

---

## 4. P3 · 海面远海接管

**前提**：**不许回退连续光学。** `water-shading.ts` 头部已写清四档平涂为什么出色块，退回是开倒车。

**改法**（spec §5.3）：

- 远海：`paintAmt = smoothstep(0.45, 0.85, seaHazeAmount(d))`，亮度量化到 3 档后按 `0.25·paintAmt` 混入。
- 太阳路：一张 512 笔触 tile（照 `strokes.js` 做法），沿 sun-road 方向 1 tap，**只调制 glint，不调制底色**。
- 近海（< 500m）一律不加量化（A3）。

**闸门**：900m 外无可见色阶边；太阳路碎光不消失。
**Kill**：碎光消失，或近海出现色阶。
**改哪些文件**：`src/sea/water-shading.ts`、`src/sea/sun-road.ts`、`src/sea/water-shading.test.ts`。

---

## 5. P5 · Kuwahara + ink（加法，最后上）

**改法**（spec §5.5）：插在 `post.ts` 的 `pass` 之后、`bloom` 之前（要 HDR + depth，不能吃 bloom 光晕）。

- Kuwahara `r = 1`（9 tap），只 high 档；距离门控 `60m < d < 400m`。
- Reinhard 往返 `c/(1+c)` → `o/(1−min(o,0.985))`，方差感知。
- ink 只给飞机：`alpha < 0.23` + 4 邻域，`min(c,1.2)*vec3(0.2,0.14,0.15)`，强度 0.92。
- **云、山、海一律不描边。**

**闸门**：high 档 p50 不升 > 1 ms；移动档不启用；描边只出现在飞机轮廓。
**Kill**：移动档掉帧，或云/山出现轮廓线。
**改哪些文件**：`src/post.ts`、`src/post.test.ts`。

---

## 6. P4 · 陆地（独立仓，独立节奏）

**行动仓**：`G:\DSHProject\ThreeJSInspire-reconstruct`（`INDEX.md:116`）。
**依赖**：roadmap B2 地形生成 + 「接缝契约」（未写）+ B3 改写。

### R3 · B3 必须改写，不是微调

roadmap B3 现写「软阈值、色相收拢、纸纹 0」。对照参考仓实测：

- 「纸纹 0」**方向对**——它也没用纸纹，用的是 512 笔触图 + `tNoiseHi`。别加纸纹。
- 但它**有逐片元笔触层**（4–6 tap），B3 现写法会让地形只能靠色带，永远不像。
- 它的「软」只软在暗部体块，**受光边是硬的**（宽 0.04–0.05）。B3 全软会得到糊。

改写为三段式：硬边（`fwidth` 归一，宽 0.03–0.05）/ 软体块 `smoothstep(0.25,0.85,broad)` / 笔触（`landStrokes` + `paintCells`，**必须乘 `1/fwidth`**）。

### 烘焙分工

- 布局图（田块 Voronoi、树篱、道路 stencil）→ Worker 烘 1024² 覆 8 km（≈7.8 m/texel），`bakeRows` 切片 + `MessageChannel` 让帧；**嵌套定时器至少 4 ms**。
- 笔触/dab → 逐片元，不烘。
- 世界锚定 UV（A2），禁 per-chunk 随机。

### 距离带重映射（最容易照抄错）

| painted | 用途 | 我们 |
| --- | --- | --- |
| `paintGround` 40→110m | 脚下笔触 | 15→80m |
| `landStrokes` 70→170 起 / 2600→4600 收 | 远坡长笔 | 60→400m（受 `HAZE_FAR 520` 约束） |
| `heroPaint` 70→150 起 / 2200→3600 收 | 远坡色斑 | 60→400m |
| `backdrop` 6.2km 环 | 一次性远山 | 已有 `dome-horizon.ts` 1200–1800m 淡出带 |

**`dome-horizon.ts` 已是最接近参考仓的东西**（平涂面片 + 四档带色 + per-patch alpha），应扩成「远景条带」，不另起一套。

### 接缝契约（独立文档，先于烘焙）

五个预判失效点，每个都要一条检查：

1. **块边界法线不连续** → 法线必须从 `heightAt` 解析求（固定 eps），与 chunk、LOD 无关。
2. **LOD 换档色带跳变** → 同 1，法线不来自网格。
3. **掠射角边宽失控**（1–5° 俯角下 `fwidth` 巨大）→ 边宽设屏幕空间下限，远处退化成按距离带预选档位。
4. **烘焙图显影**（切一半被采样）→ ready 标志或双缓冲。
5. **笔触随爬升漂移**（距离带按相机距离）→ 带子随高度补偿，或按坡面面积绑定。

**最省的验证**：B2 先出一块 512m 单块实验体，跑四个检查（边界色带连续性 / 换档跳变 / 掠射角边宽 / 烘焙显影）。有接缝再写细则，没有就缩成两页。

---

## 7. 度量与基线

| 工具 | 用途 | 现状 |
| --- | --- | --- |
| `npm run test` | 单测（Vitest） | 有 |
| `npm run build` | `tsc --noEmit && vite build` | 有 |
| `npm run smoke` | 帧预算探针 | 有 |
| `qa.ts` CDF | 档数/占比 | 有口径 |
| `frame-stats.ts` | p50/p95 | 有 |
| 抓帧对比 | 前后同机位 | **需补**：固定 4 组机位 + 固定 tod |

**基线目录**：`artifacts/look-baseline/2026-11-13/`（四组：日落主视角 / 云层内 / 低空贴海 / 远海）。
每期结束追加 `artifacts/look-P< n >/` 同机位对比，diff 只在同机位同 tod 下有效。

---

## 8. 中止与回退手册

| 情况 | 动作 |
| --- | --- |
| P1 闸门不过 | **中止全案**。`git revert` P1 commit，回 `feat/painted-valley-look` 起点。研究文档保留（结论仍然有效：这条路不成立） |
| 单期画面不满意 | `git revert <该期 commit>`；分支不删（留着做对照） |
| 整案放弃 | `git switch <原分支>`，`git worktree remove .worktrees/painted-valley-look`，分支可留可删 |
| 默认帧被意外改动 | 立即查六门；确属有意 → 走「重定基线」流程并写进 INDEX，不许静默 |
| 帧预算爆 | 按序关：ink → Kuwahara → P3 远海 → P2 带数，**不许先关 puff**（它是观感核心） |

**回滚单位是 commit + tag，不是分支。** 每期收尾打 `look-P0…look-P5` 轻量 tag，回退时 `git revert look-P1..look-P2` 比对着分支找 commit 可靠。

---

## 9. 不做清单

1. 不抄 cubemap 云（我们要视差与穿云，`in-cloud.ts` 已有）。
2. 不抄小时级重烘云（实时日落，重烘会让云随时间闪）。
3. 不抄它的颜色（白天中性白 vs 我们的日落逆光，抄了就丢单源）。
4. 不上全屏量化（A3）。
5. 不加纸纹（它自己也没用）。
6. 不给云、山、海描边。
7. 不去掉 `landStrokes` 的 `1/fwidth`（去掉 = 假笔触）。
8. 不在 P1 之前动 Kuwahara（先加后减 = 糊）。
9. 不在接缝契约定稿前烘布局图（返工要重烘全部）。
10. 不把本案混进 daynight / preset 的 WIP（Task 0 必须先隔离）。

---

## 10. 开工顺序（执行清单）

- [ ] Task 0：WIP 定性 → checkpoint 提交 → 建 worktree/分支 → 四组基线帧 + 三个命令全绿
- [ ] P0 任务计划（fail-first）→ 实现 → 四个数一键抓
- [ ] P1 任务计划 → 实现 → 抓帧对比 → **MAYBE-KILL 决策点**
- [ ] P2 任务计划 → 实现
- [ ] P3 任务计划 → 实现
- [ ] P5 任务计划 → 实现
- [ ] P4：先出接缝契约 → B2 单块实验 → 四检查 → B3 改写 → 笔触层
