# 更新区间审阅问题清单（9701c7e..2f05b25）

**日期**：2026-11-09　|　**分支**：`rebuild/sea-dome-reset`
**范围**：`9701c7e` → `2f05b25`，15 个提交，95 文件 +8092/−222
**性质**：只读审阅＋双审阅员报告汇总。**未改动任何代码**，本文件是唯一新增。
**用途**：供其他模型二次核对。

## 0. 提交清单

```
5b36e23 fix(sky): one live sun state, full-3D dome tow（联动修复）
034bd6e docs(superpowers): register sun-road v2 plan/review/evidence + INDEX
2d7b1a3 feat(sky): keyframed palette track（Task 1 sky-track）
9d30518 feat(sky): preetham energy field（Task 2）
bcc5a77 feat(sky): skyColorTsl v2 + JS mirror（Task 3）
331d2f8 test(sky): per-keyframe bloom budget（Task 4）
8435ac8 feat(sky): haze/light rig/cloud palette follow track（Task 5）
8285e9c feat(sky): seeded star dome（Task 6）
0079d53 feat(sky): wire day-night track（Task 7）
473e26a docs(sky): night acceptance baselines（Task 8）
a60537c feat(sea): ?sea=nochop hook（Task 1）
8bf690c feat(sea): fine 4-27.5m octave merged（Task 2）
7d9c283 fix(sea): low-pass vertex C1 displacement（Task 3）
be58687 test(sea): round-3 acceptance frames + receipt（Task 4）
7747b26 fix(sea): align measure-round3.py operator
2f05b25 docs(sea): correct round-3 receipt ratios
```

## 1. 对照的执行文档

- `docs/superpowers/plans/2026-11-08-day-night-sky.md`（Task 0–8）
- `docs/superpowers/plans/2026-11-08-sea-nearfield-octave.md`（Task 0–5）
- `docs/superpowers/plans/2026-11-07-sun-road-sparkle-anti-solar.md`（v2）
- `docs/superpowers/plans/2026-10-31-sky-technical-note.md`（追补混合模型小节）
- `docs/superpowers/reviews/2026-11-08-sky-sun-sea-linkage-review.md` ＋ `…-change-report.md`
- `docs/superpowers/reviews/2026-11-08-day-night-sky-plan-review.md`
- `docs/superpowers/reviews/2026-11-07-sun-road-plan-review.md`
- `docs/superpowers/reviews/2026-11-07-sea-wave-scale-review.md`（v2，不通过）
- `docs/superpowers/INDEX.md`（状态源）

## 2. 总表

| 线 | 计划 | 落地 | 状态 |
|---|---|---|---|
| 天空＋联动 | day-night-sky Task 0–8 | 全部，无偏离 | 可合；2 Important robustness 缺口合后补 |
| 太阳路 | sun-road v2 | 已执行 | 通过（证据 ERA 纯度存疑，见 Minor 9） |
| 海面 | sea-nearfield Task 0–4（Task 5 回执首版已写） | 代码全落地 | 代码可合；**P1-A 保持 OPEN**（低档等价性视点边界见 Minor 10，小数 LOD 见 Minor 11） |

## 3. Critical（阻塞合并）

**无。** 两路审阅均未发现 Critical。

## 4. Important（代码缺陷，需要修）

> 本节 3 条：I-SKY-1 / I-SKY-2 / I-SEA-1。另三条原列 Important 的条目（ERA 纯度、视点边界、小数 LOD）经交叉审核实为**测试证据的解读边界或文档缺口**，非代码缺陷，已移 §5 Minor 9–11 改写为定性说明加代码证据。

### I-SKY-1 · TSL 天顶角缺上钳（robustness）
- 文件：`src/sky-preetham.ts:183`
- 现状：JS（`:92`）是 `acos(min(max(dy,0),1))`；TSL 是 `acos(max(0.0, direction.y))`。
- 风险：`normalize` 舍入出 `1+1ulp` 时 `acos` 得 NaN，整像素天空变 NaN（恰好天顶方向）。
- 修法：`acos(clamp(direction.y, 0.0, 1.0))`，与 JS 对齐；补 TSL 侧单测或源码 pin。

### I-SKY-2 · 能量比率 TSL 直接相除（图/镜像契约裂口）
- 文件：`src/sky-webgpu.ts:226`
- 现状：`clamp(num.div(den), 0.0, 2.0)` 先除后钳；JS（`src/sky-preetham.ts:124-141`，`energyRatioJs`）在 `d===0` 或 `!Number.isFinite` 时直接返回 0。
- 风险：TSL 侧没有 JS 的 `d===0` 守卫和非有限值崩塌分支。注：**原报告"den 红通道下界为 0（BLUE_BOTTOM[0]=0）→ 除零"的论证不成立**——den 由 `(Lin + L0) * 0.04 + BLUE_BOTTOM[i]` 构成，L0 = `0.1 * Fexp(-) > 0` 恒成立，den[0] 不会精确为 0。真实裂口是：当 den 极小（subnormal 或接近浮点下限）时，TSL 相除的行为在不同驱动上是否与 JS 的"崩塌为 0"语义一致，没有显式守卫保证。
- 修法：`den.max(1e-12)` 后再除，或 `select` 守卫；注释写明与 JS `energyRatioJs` 的 `d===0 → 0` 语义对齐。

### I-SEA-1 · `setChopGate` 与 FrameGovernor 自动降档无互斥
- 文件：`src/sea/material.ts:626-640`、`src/world.ts:171-219`
- 现状：慢帧自动 `setQuality(false)` 静默重写 `c1Gate`，破坏 `?sea=nochop` A/B。
- 修法：`chopOverride` 标志＋warn，或 `describe()` 暴露 c1Gate。

> 下三条原列 Important，经交叉审核实为测试证据解读边界或文档缺口，非代码缺陷，已移 §5 Minor 9–11。

## 5. Minor

1. `src/sea/fine-band.test.ts:182` 的 `console.log('[golden-probe]')` 应删（原报告行号 168-174 有误，实际在约 182 行）。
2. `accumulateSpectrum` 缺 `re/im` 自洽断言。
3. Task 4 Step 4 的 before/after sea 块 diff 数字未贴（只写了天空证据）。
4. `src/main.ts:191` sea 未挂载时 nochop 静默跳过，建议 `console.warn`。
5. 纱色只启动注入：`src/main.ts:167-171` vs `:377-384`，运行时转太阳后过期；二选一：`syncSun` 内按 `el` 重注，或文档写死"启动快照"语义。
6. `src/sky-webgpu.ts:163-168` 每帧重算 ref uniforms 纯浪费，提为模块常量。
7. `src/sky-track.ts:80-90` 的 `srgbToLinear` 假设 7 字符 hex，加输入断言。
8. `src/sky-webgpu.ts:4` 注释出现 `forceWebGL` 字样，naive grep 误报，换说法。
9. 太阳路 PASS 存在 ERA 混杂：glints 43→4 和 blown 4.8/p95 204.2 的通过同时吃到天空新红利（反射基准＋霾端点），缺同 era 活体对照（`round3-A3` vs `round3-A3-nochop` 的 Δblown/Δp95）。**证据链需补充，代码无问题**。
10. 低档等价性视点受限：`tierGain` 只作用太阳路 drive（`src/sea/material.ts:396-401`），背阳机位 specDot ≈ 0 所以 H007-nochop ≡ H007-lowtier 逐字节一致属预期，不可推广到向阳机位。**代码设计正确，测试解读边界需收窄措辞**。
11. 顶点 `level(C1_VERTEX_MIP_LOD)` 小数 LOD 语义：`C1_VERTEX_MIP_LOD = log2(32/4.878 / 0.75) ≈ 3.1287`（`src/sea/cascades.ts:94-96`），TSL `texture.level(float)` 接受浮点做三线性混合，不是整数截断。**代码计算正确，缺注释说明意图**。

## 6. 已确认的通过项（核对时勿重复挑刺）

- 参考档恒等：54 方向逐通道 ≤1e-6；天空像素门 0px 差；parity 重跑 PASS（3 pair/110 钉）。
- bloom 预算：非盘区全 `<0.82`（参考 0.7428），盘区 ≤1.10（参考 0.9515）；阈值未动。
- 霾同源：`seaHazeEndpoints` 双 `includeDisc=false`；`awayHorizonLinear()` 字面保留。
- 子带逐位不动：逐格 `fround(subPre+fine)`＋窗口互斥＋golden pin。
- 顶点低通分子＝32（与 5.1287 互斥）；`i===0` 仅 R0。
- 源码 pin 红线：`c1Gate`/`normalNode`/`i===0`/海面 `skyColorTsl(...,false)`/全函数式 `mix(`。
- 判据：2/3/4/6 通过；判据 1（7m gy ×1.32/stripes 0）失败已诚实记录并按逃逸条款停迭代；回执无瞒报。
- `np.gradient`→`np.diff` 口径漂移已由 7747b26 订正。
- 夜基线 45→49 钉 PASS；夜天空与昼夜 era 逐位一致。

## 7. 遗留欠条（非本轮）

- `main.ts:62-63` 兜底 `#a86a86` 与 `scene.fog('#c96a7a')` 仍是 dusk 残留，第二步收编。
- 判据 1 未达根因（row-mean-gradient 数不出宽幅 2D 起伏）待新量具或新计划，不在本轮硬调。

## 8. 修订记录

**日期**：2026-11-09　|　**依据**：交叉审核（对本报告逐条用工作树代码取证）

| 改动 | 原因 |
|---|---|
| §2 总表：太阳路行加注"证据 ERA 纯度存疑，见 Minor 9"；海面行加注"低档等价性视点边界见 Minor 10，小数 LOD 见 Minor 11" | 原总表把三条证据类条目隐含列在 Important，实际是测试文档问题而非代码缺陷，需在总表中显式标注去向 |
| §4 标题改为"Important（代码缺陷，需要修）"，加导引说明三条证据类已移 Minor | 避免后续 reviewer 误以为所有 Important 条目都需改代码 |
| I-SKY-2：JS 侧引用 `sky-color-js.ts:133-137` → `sky-preetham.ts:124-141` | 原报告引用错误——`sky-color-js.ts:133-137` 是无关的 `skyColorJs` 内部映射，`d===0 → 0` 守卫实际在 `energyRatioJs`（`sky-preetham.ts:124-141`） |
| I-SKY-2：重写风险论证，删除"BLUE_BOTTOM[0]=0 → 除零" | den 由 `(Lin + L0) * 0.04 + BLUE_BOTTOM[i]` 构成，L0 = `0.1 * Fexp(-) > 0` 恒成立，den[0] 不会精确为 0。真实契约裂口是 TSL 侧缺 JS 的 `d===0` 守卫，极小 den 在不同驱动上行为未定义 |
| I-SEA-2/3/4：从 Important 移到 Minor 9–11，改写为定性说明加代码证据，删除旧 Important 级描述和 `~~...~~` 标记 | 清理残留——上一轮降级时把旧 Important 正文完整保留加删除线，现在清掉，每条只留一句定性结论（性质、为什么不需要改代码）加文件:行号证据 |
| Minor 1：行号 `168-174` → `182` | grep 证实 golden-probe console.log 实际在第 182 行，原报告行号偏差 ~10 行 |

**未改**：§0 提交清单、§1 对照文档、§6 通过项、§7 遗留欠条；其余 Important 和 Minor 条目正文均原样保留。
