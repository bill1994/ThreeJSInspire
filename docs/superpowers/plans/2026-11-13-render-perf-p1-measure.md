# 渲染性能 P1（puff 云 overdraw 量测 + 手段选择门）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 [`2026-11-12-render-perf-pass1.md`](2026-11-12-render-perf-pass1.md) P1 的**第一步**：把 puff 云的绘制形态、屏幕覆盖率、overdraw 量清楚，用数据选定优化手段并产出后续优化任务计划的大纲。**本计划不含优化实施**——手段选定后另出任务级计划（路线图原文纪律）。

**Architecture:** 三步——①静态盘点（读码：每朵一个 mesh 还是 instanced、叠加层数、band 索引）②运行时量测（`?puff=0` 差分覆盖率 + 场景遍历分带计数）③决策备忘（候选表按数据填判 → 选定手段 + 预期收益）。全程只读 + 新增 `artifacts/perf-audit/`，**零 src 改动**（路线图「观测工具只读」纪律）。

**Tech Stack:** TypeScript 读码 · CDP 采集量具（仿 dome-audit capture 结构）· node PNG 差分 · Vitest 2.1（回归门用）

**Spec:** [`plans/2026-11-12-render-perf-pass1.md`](2026-11-12-render-perf-pass1.md) §1.1 协议（钩子清单/档位断言/`[::1]`）＋ §2-P1（证据、待查、候选表、门）。冲突以它为准。

## Global Constraints

- **零 src 改动**：本计划只读代码 + 采集 + 写 artifacts；需要新 qa 钩子才能量的事，停下来上报裁定，不许顺手加生产代码。
- 测量照 §1.1 协议：`[::1]:5173`、`?qa=frozen`、canvas 434×772（rect 474.875,0,434.25,772）、段前后 `describe().quality` 一致、`hasFocus` 断言。
- 证据只进 `artifacts/perf-audit/`（JSON + 仪器脚本 + 备忘）；结论叙述进计划进度段。帧随代码 commit。
- `npx tsc --noEmit` = 0 + `npx vitest run` 全绿作为「零改动」证明随 commit 报告。

## Review Focus

1. **差分口径失效**：`?puff=0` A/B 两帧若非 puff 区域不逐位一致（frozen seed 不同步、漂移动画未冻结），覆盖率数字是垃圾。差分前先验非 puff 区域全等。→ Task 2 步骤钉死。
2. **覆盖率 ≠ overdraw**：覆盖率是像素占用，overdraw 是每像素平均层数——两个数分开报，不许混用。→ Task 2 产物结构。
3. **遍历数 ≠ 实际画数**：场景遍历计数不含 frustum culling 效果，遍历数 ≥ 真实提交数；两口径都报。→ Task 2。
4. **`?puff=0` 级联语义**：先核实该开关只关 puff 不连带 dome/天穹（读 main.ts:195 与 world 接线），否则差分量到的是别的东西。→ Task 1。

---

### Task 1: puff 绘制形态静态盘点

**Files:**
- Create: `artifacts/perf-audit/puff-inventory.md`（读码结论 + 关键行号引用）

- [ ] **Step 1: 读码**——`src/puff-cloud.ts` / `src/puff-field.ts` / `src/puff-shape.ts`：绘制形态（每朵 mesh？InstancedMesh？merge？）、透明叠加结构（几层、blend 模式、depthWrite）、四档 band 索引怎么进 shader、`?puff=0` 的级联范围（main.ts:195 → world 接线，只关 puff 还是连带？）
- [ ] **Step 2: 写盘点**——结论 + 行号 + 每朵几何段数/顶点数 + 当前数量预算（云簇计划引用值）
- [ ] **Step 3: Commit** `test(perf): puff draw-form static inventory`

### Task 2: 运行时量测（覆盖率 + overdraw 估 + 分带计数）

**Files:**
- Create: `artifacts/perf-audit/measure-puff.mjs`（CDP 采集，仿 dome-audit 结构）+ `diff-puff.py`（非 puff 区全等校验 + puff 区覆盖率/层数估）
- Create: `artifacts/perf-audit/puff-runtime.json`（量测产物）

**Interfaces:**
- Consumes: §1.1 协议钩子（`?puff=0` 已存在，main.ts:195）；`qa.describe()` 透传
- Produces: `{ coveragePct, perBandCounts{near,mid,far}, traversalVsDrawn, overdrawEstimate }` 结构的 json（overdraw 估法写进脚本头注释）

- [ ] **Step 1: 写采集脚本**——同 URL 双帧（`?puff=0` / 缺省）× 参考档机位 + 海平线机位；`?qa=frozen` + 焦点/档位断言
- [ ] **Step 2: 写差分**——先验两帧非 puff 区逐位一致（不一致 = 冻结失效，修采集不修数字）；puff 区像素占比 + 按亮度层估 overdraw（口径注释钉死）
- [ ] **Step 3: 场景遍历分带**——经 `__porco.scene` 遍历 puff 节点按距离分带计数（near/mid/far 带界写死在脚本头）+ 与 renderer drawCalls 对账（遍历 ≥ 提交）
- [ ] **Step 4: 跑量测入库** + `tsc/vitest` 零改动证明 + Commit `test(perf): puff coverage/overdraw runtime measurement`

### Task 3: 手段选择门（决策备忘）

**Files:**
- Create: `artifacts/perf-audit/puff-decision.md`
- Modify: `docs/superpowers/plans/2026-11-12-render-perf-pass1.md`（进度段记录选定手段与后续计划大纲）

- [ ] **Step 1: 候选表按数据填判**——路线图 §2-P1 四条手段逐条对 Task 1/2 数据（距离 LOD / 减量缩尺寸 / 合并大 quad / 早退），每条写「数据支持度 + 预期 p95 收益估算 + 风险现值」
- [ ] **Step 2: 选定手段组合**——目标 `p95 < 16.7 ms`、云掩码覆盖率下降 ≤10%、「云还是云」；写后续优化任务计划的**大纲**（Task 列表级，不展开步骤）
- [ ] **Step 3: Commit** `docs(perf): puff overdraw decision memo and optimization plan outline`

## Self-Review

- 路线图 P1「待查」三条 → Task 1（绘制形态）/ Task 2（覆盖率+overdraw、尺寸距离分布）逐条有主。
- 门（p95<16.7 / 覆盖率 ≤10%）属优化实施计划——本计划只把数据备齐，门在 Task 3 备忘里作约束引用。
- 零 src 改动全局成立；每 Task 可独立复审。
