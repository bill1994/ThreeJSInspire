# 背景 C3 噪声配比 + puff 特征放大 — 大理石纹终修执行文档（修订 v2）

- 日期：2026-11-16（修订）
- 状态：待用户批准（批准前不动码）
- 前置文档：`docs/superpowers/plans/2026-11-14-bg-cumulus-visibility-and-variants.md`（Task 5 大理石纹调查）、commit `853708f`（p 绕行修复）
- 数值依据：`artifacts/marble-verify/thit-numerics.json`（2026-11-16 七配比数值实验，**启动前先归档一份带日期后缀**）

## 1. 背景与结论（自包含）

背景积云层是「射线命中云面一点 + 画师着色」的烘焙实现。命中点 p = ro + rd·tHit 的大理石纹噪声，根因是噪声位移的「幅值 × 频率」（梯度）超过距离场有效推进要求（Lipschitz 条件 |∇d| ≤ 1 m/m），加上位移幅值相对 puff 特征尺寸比例过高（WT 334m vs puffR 428m），导致等值面折叠、二分命中在不同像素落进不同层。

2026-11-16 用 CPU 一比一复刻场与 march 的数值实验（`artifacts/marble-verify/thit-numerics.test.ts`，seed=7 生产布局，射线对数范围 **7433–15942**，取决于 puffScale 导致的云尺寸变化）量化确认：

| 配比 | 位移梯度 p99（≤1.0） | foldRatio | 真撕裂率/千对 | bracketsMultiCross | 备注 |
|---|---|---|---|---|---|
| V0（修复前） | 4.01 | 1.56 | 11.22 | 21 | 基线 |
| WT（当前工作区） | 2.00 | 0.78 | 4.62 | 8 | 已降一半幅值，仍不足 |
| 纯 C3（无 puff 放大） | **0.841** | 0.34 | 0.13 | 1 | 撕裂主力 |
| C3 + puff×1.25（近似几何①） | **0.815** | 0.27 | 0.19 | 1 | 本次方案 |

① 近似几何：测试台的 puff×1.25 是「后处理乘半径、球心不动」。本方案改 `heap()` 的 r 公式，r 一进公式，球心就跟着动（heap() 内 `x += w*0.5 - r*0.6`、`y += h - r*0.7` 两项直接吃 r），塔云球心最多内缩/下沉 ~150m。JSON 里的 0.19 是近似几何预测值，不是本方案真实几何的实测值——T3 跑 G1 时才会拿到真实值。

用户裁定（2026-11-16）：按「C3 + puff×1.25」执行。puff 放大在此是风格选择（更圆胖的堆状轮廓）+ 折叠安全垫；撕裂修复主力是 C3 的降幅降频。

### Lipschitz 条件的诚实说明

七种配比（含本方案）的 `dispGradMaxM` **全部 > 1.0**，`lipschitzOk` 字段全是 false。p99 ≤ 1.0 是工程代理——99% 区域满足，但极端离群点（~1%）的梯度仍破线。本方案 max=1.198。这些离群点若落在烘焙纹理的敏感区（p.y-base 正好在 smoothstep 过渡带内），理论上仍可能出现孤立的单像素撕裂——但不会形成连续条纹（大理石纹的本质），视觉上不可见。本任务 p99 硬卡 ≤ 1.0，max 不卡。

## 2. 目标

p 值恢复正常：命中点连续性达标（见验收门 G1），`?bgdbg=3`（着色锚回原 p）目检无大理石纹。着色锚点本任务不动（仍走 pSmooth 链路）；p 稳定后「锚回 p 找回体积感」是后续独立任务。

视觉对价（已拍板）：
- **位移幅值** 334m → 146m
- **fine 倍频波长** fine1: 7.5*2.7=20.25 → 7.5*1.35=10.125 倍；fine2: 7.5*7.3=54.75 → 7.5*2.7=20.25 倍——**最细档特征尺度从 ~187m 拉到 ~506m**，与 puff 半径（267–609m）同量级。菜花疙瘩基本消失，表面变光滑馒头。
- **base 项幅值 2.4 保留不动**——低频大尺度起伏仍存在。若视觉上低频分量补偿了高频的柔化，可后续调；本方案不动 base 项。

## 3. 改动清单

### 3.1 前置：`layoutClouds` 参数化（数值台和运行时共用）

`src/bg-cumulus-layout.ts` 新增可选参数，默认 1.0 保持不变：

```ts
export function layoutClouds(seed: number, opts?: { puffFeatureScale?: number }): CloudLayout[]
```

`puffFeatureScale` 直接乘入 `heap()` 内部的 r 公式——**不是后处理乘半径**。改 heap 内第 154 行：

```ts
// src/bg-cumulus-layout.ts:154（现状）
const r = Math.min(w * 0.3, h * 0.62) * (0.72 + 0.5 * rand());
// 改为
const r = Math.min(w * 0.3, h * 0.62) * (0.72 + 0.5 * rand()) * puffFeatureScale;
```

参数化的原因：
1. 让数值台的 V0/WT/P1/P2/P4/C3 所有变体**共享同一份 puff 半径+球心布局**（历史对照不丢）
2. 让 G1 读的就是真实几何，不是近似几何

包围球 bounds.r 在 `buildOnce` 第 325 行由 puff 列表自动重算（取 puff 最大距离），不需要另改。**⚠️ valid() 不检查 puff 半径**——它只检查角隙和总覆盖，puff 放大不会让它 throw。视觉膨胀才是风险（见 §6）。

### 3.2 `src/bg-cumulus.ts` — lump 位移配比改为 C3（所有字面量单源化）

现状（`src/bg-cumulus.ts:583-590`）：

```ts
const lump = float(0.55).sub(n1.r).mul(2.4);
If(fine.greaterThan(0), () => {
  lump.addAssign(float(0.55).sub(billow(q.mul(2.7).add(0.3)).r));
  lump.addAssign(float(0.55).sub(billow(q.mul(7.3).add(0.7)).r).mul(0.36));
});
const dcB = dc.add(sc.mul(lump.mul(0.5).sub(0.55)));
```

**最终改后公式**（符号陷阱：meanShift 是加法偏移，不是减法）：

```ts
const lump = float(0.55).sub(n1.r).mul(BG_LUMP_BASE.amplitude);
If(fine.greaterThan(0), () => {
  lump.addAssign(float(0.55).sub(billow(q.mul(BG_LUMP_FINE.freq1).add(0.3)).r).mul(BG_LUMP_FINE.amp1));
  lump.addAssign(float(0.55).sub(billow(q.mul(BG_LUMP_FINE.freq2).add(0.7)).r).mul(BG_LUMP_FINE.amp2));
});
// 符号关键：ampMul 在 lump 外，meanShift 是 sc*lump*ampMul + sc*meanShift
// 不是 sc*(lump*ampMul - meanShift)——后者方向反了
const dcB = dc.add(sc.mul(lump.mul(BG_LUMP_OUTER.ampMul).add(BG_LUMP_OUTER.meanShift)));
```

导出常数块（放 `STEPS` 附近，数值台 import 消除双源漂移）：

```ts
// src/bg-cumulus.ts — C3 噪声配比单源（所有 lump 相关字面量进此）
export const BG_LUMP_BASE = {
  // base 项：幅值 2.4 保留（不跟进 ampMul 缩放），q 缩放 7.5、cloudIdx 偏移 0.37 也保留
  amplitude: 2.4,
  qScale: 7.5,
  idxOffset: 0.37,
} as const;
export const BG_LUMP_FINE = {
  freq1: 1.35, amp1: 0.6,   // 原 2.7 / 1.0 → 深降频 + 减幅
  freq2: 2.7,  amp2: 0.2,   // 原 7.3 / 0.36 → 深降频 + 减幅
  offset1: 0.3, offset2: 0.7, // 原字面量，保留不动
} as const;
export const BG_LUMP_OUTER = {
  ampMul: 0.25,   // 原 0.5 → 减半
  meanShift: -0.3, // 原 -0.55 → 收少 0.25·scale，云整体略胖
} as const;
```

### 3.3 数值台接线（`artifacts/marble-verify/thit-numerics.test.ts`）

1. **delete** 顶层 `const layouts = layoutClouds(SEED)` — 它会把所有变体钉死在同一份布局上（包括 V0 历史对照）
2. 改 `makeClouds` 签名为 `makeClouds(seed: number, puffFeatureScale: number)`，内部调 `layoutClouds(seed, { puffFeatureScale })`
3. VARIANTS 数组每个变体带 puffScale，`displacementStats`/`tHitScan` 循环里 `clouds = makeClouds(SEED, v.puffScale)`
4. G1 行 = C3+puff1.25 变体的读取

## 4. 验收门

**⚠️ 开工前先归档 JSON**：`cp artifacts/marble-verify/thit-numerics.json artifacts/marble-verify/thit-numerics.pre-c3-$(date +%s).json`。全量 vitest 会重写它。

1. **G1 数值门**：`npx vitest run artifacts/marble-verify/thit-numerics.test.ts`，C3+puff1.25 变体行必须同时满足：
   - `trueTearsPer1k` ≤ 0.5（撕裂率）
   - `dispGradP99M` ≤ 1.0（梯度 p99，Lipschitz 代理）
   - `bracketsMultiCross` ≤ 1（**硬线**，字段名精确；V0=21、WT=8 都远超 1）
   - `dispGradMaxM` 不检查（诚实地说 max 仍破线，只看 p99）
   - T3 失败预案只调 BG_LUMP_FINE.amp1/amp2 和 BG_LUMP_OUTER.ampMul 档位（0.25→0.3/0.2），**不碰 puffFeatureScale**——几何口径变了参数去背锅就错了
2. **G2 目检门**：浏览器截图 + 识图：正常模式无大理石纹；`?bgdbg=3`（强制 pS=p 着色）同样无大理石纹、无斑驳脏纹（允许轻微颗粒感）。G1 是切片值，**G2 是主证据，别把 G1 当可选项**。
3. **G3 云形+质感门**：同机位（`?qa=frozen&puff=0`）并排截图识图：
   - 云朵数量、外形、覆盖相当，无明显缩水或膨胀超过约一成
   - **边缘起伏/周长**：拿 `?bgforce=single` 标定台（若存在）做改前改后并排，看轮廓锯齿是否基本成立（C3 方案最细档波长翻了 2.7×，菜花疙瘩消失是预期，但光滑馒头不应变成球体）
4. **G4 回归门**：`npx vitest run` 全量绿（基线 **763** 通过）；`npx tsc --noEmit` 零错误。跑完立即另存一份 JSON：`thit-numerics.post-c3-$(date +%s).json`，与 pre-c3 比对确认 G1 三指标。

## 5. 任务分解

1. T1：`bg-cumulus-layout.ts` 参数化 `layoutClouds` + puffFeatureScale 透传到 heap()。
2. T2：`bg-cumulus.ts` 新增 BG_LUMP_BASE/FINE/OUTER 常数块 + lump 公式完整重写（**符号关键**：`.mul(ampMul).add(meanShift)` 不是 `.mul(ampMul).sub(-meanShift)`）。
3. T3：数值台删除顶层 `layouts` 单例 → `makeClouds(seed, puffScale)` 参数化 → VARIANTS 每个变体带 puffScale → 跑 G1；不达标回 BG_LUMP 幅值档位微调。
4. T4：G2/G3 目检（截图存 `artifacts/marble-verify/`）。
5. T5：G4 全量回归 + 归档 post-c3 JSON。
6. T6：**拆两个提交**：提交 A（并行会话化妆层+开关+uDebug 修复），提交 B（C3+puff 本方案）。提交 B 信息带 G1 三个数字。

## 6. 风险与回滚

- **视觉膨胀**：meanShift −0.3 比旧 −0.55 少收 0.25·scale，叠加 puff×1.25。**valid() 不检查 puff 半径**（它只看角隙和总覆盖），不会 throw。真正风险是视觉上云整体微胖 ~10%。预案：meanShift 回 −0.4 或 puffFeatureScale 降到 1.2，重跑 G1。
- **表面变光滑馒头**：fine2 特征尺度从 ~187m 拉到 ~506m 与 puff 半径同量级。G3 边缘起伏对比门兜底。
- **base 项低频补偿**：若视觉上 base 项的 2.4 幅值补偿了高频柔化，云朵看起来没那么光滑，可后续调 base amplitude——本方案不动 base 项。
- **回滚**：拆两个提交，各自独立 revert：`git revert <提交B hash>` 只撤 C3+puff；`git revert <提交A hash>` 撤化妆层+开关。

## 7. 工作区既有未提交改动的处置（已拆提交，自洽）

并行会话的未提交改动（`bg-cumulus-paint.ts` 的 broadBillowFine、`bg-cumulus.ts` 的 pS 化妆层、`main.ts`/`world.ts` 的 `?bgdbg` 接线、本会话的 `uDebug` 分支修复）与 C3+puff 本方案**拆两个提交**。提交 A 先入，提交 B（本方案）后入。若用户要求顺序颠倒或拆分更多，灵活调整，但 C3+puff 的改动必须独立于并行改动提交，方便单独回滚。
