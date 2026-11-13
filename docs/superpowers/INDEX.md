# docs/superpowers — 索引与状态

本仓库有 49 份计划/设计/审查文档（22 计划 + 6 设计 + 21 评审）。它们不是同级关系：有的是当前任务清单，有的是已经死掉的方向的执行记录。

本文是唯一的状态来源 —— **不确定某份文档还能不能信，先看这里，再决定读不读。**

> **2026-11-08 记账**：本索引此前停在 20 份（2026-11-06 口径），漏登 4 条 ——
> `plans/2026-11-05-land-flight-0-to-1.md`、`plans/2026-11-07-in-cloud-volumetric-pass.md`、
> `reviews/2026-11-07-frame-composition-review.md`、`reviews/2026-11-07-sea-wave-scale-review.md`。
> 已按工作树实测补齐；**数量以本节为准，不再沿用旧口径**。§0 的基线描述也已标注为历史快照
> （海面早已重建，原文「没有海」不再是现状）。
>
> **2026-11-11 记账（补）**：穹顶云两线已收尾并登记（上表 11-09、11-10 两行），提交 `ae44ce7..1e97a05`，
> 评审 `artifacts/dome-audit/2026-11-10-dome-cloud-p15-p2-review.md`。
>
> **2026-11-11 记账（三，docs 对账）**：`specs/` 三份设计已补进 §1（穹顶 P1、穹顶 P1.5/P2、
> 飞行手感 v1.1）；飞行三档的提交拆账、实装值与验收映射写进该文 §8；R18 在 §6 挂了待拍板占位。
> **同日审计结论**：这三份「已完成」并不等价于「已验收」，修复总账见 §2 的
> [`2026-11-11-audit-repair-list.md`](plans/2026-11-11-audit-repair-list.md)（42 条，含 5 条 P0 阻塞）。
> 仍未逐条登记的：`reviews/2026-11-09-dome-cloud-p1-review.md`、调色板调研
> （`plans/2026-11-09-debug-color-ui-research.md`）、11-10 三文档审计系列
> （`reviews/2026-11-10-three-docs-audit*.md` 五份）与更早的个别漏登。

状态图例：

| 状态 | 含义 | 怎么用 |
| --- | --- | --- |
| **LIVE** | 当前方向，代码正在按它走 | 改代码前必读，数值以它为准 |
| **PARKED** | 做到一半主动停下的线，将来可能续 | 只在回到那条线时读，别让它的设计混进主线 |
| **SUPERSEDED** | 被后续文档取代，方向已放弃 | 只用来查「当初为什么这么做」，**不要**照它改代码 |
| **HISTORY** | 已完成任务的执行/评审记录，只读 | 查证据和决策出处 |

---

## 0. 删除型重构基线（2026-11-06）— **历史快照，不是当前状态**

> **当前状态（2026-11-09，HEAD `2f05b25`）**：海面已按
> [`plans/2026-11-06-stylized-fft-ocean.md`](plans/2026-11-06-stylized-fft-ocean.md) 重建
> （`src/sea/` 全套回归 + 细八度 4–27.5 m + 太阳路 v2），昼夜天空（调色板轨道 + Preetham 能量场 + 海霾/灯/太阳联动）在 11-08 落地，
> 近景 puff 云没被删过。穹顶云仍待重做。
> 闸门：`vitest run` 47 文件 / 396 用例全绿（2026-11-09 实测）、`tsc --noEmit` 干净。
> 本节保留的是 **2026-11-06 删除动作当时的快照**（记账时对应 HEAD `16f59a7`），
> 不是现在的模块盘 —— 读下文时记住这是「当初为什么删」的台账。

分支 `rebuild/sea-dome-reset`（从 `reconstruct` @ `a842657` 切出）。这个基线的定义只有一句话：

> **没有海，没有穹顶云，只剩天穹 + 近景 puff 云 + 飞机 + post + HUD + 音频。**

- **海面整体删除**：`src/sea/`（waves / lod / bands / surface-material / detail-grain / foam /
  depth-hooks 及全部单测）、`src/sun-road.ts`、`SEA_PALETTE`、`artifacts/sea-audit/`、
  两份 sea 归档、7 份海面计划/设计与 4 份海面评审
- **穹顶云残留删除**：`horizon.ts` 里的 `CLOUD_HAZE` / `cloudHaze` / `domeCloudHaze` /
  `horizonHaze`，`palettes.ts` 的 `CLOUD_PALETTE`，`artifacts/archive/dome-cloud-era/`，
  穹顶时代的技术说明与评审
- **搬走的两个值**（不是删，是换主人）：
  - `SEA_PALETTE.foam` → `palettes.ts` 的 `WAKE_FOAM`（`feel.ts` 的掠海浪花用）
  - `CLOUD_HAZE` 的 `NEAR/FAR/MAX` → `puff-cloud.ts` 的 `PUFF_HAZE`（近景云自己的空气透视）
- **活下来的云是唯一的云**：`puff-cloud.ts` / `puff-field.ts` / `puff-shape.ts` /
  `in-cloud.ts`，一行没动逻辑，只是不再向穹顶借常量
- 启动条现在读 `sky + puffs`（云建不起来时 `sky only`）

闸门在本次删除后复跑通过：`tsc --noEmit` exit 0 · `vitest run` 全绿 · `smoke ok`。

拆除后（2026-11-06）的模块盘 —— **历史，海面已回归，勿对照它改代码**：

```
src/world.ts        世界总装（只装近景云）+ FrameGovernor
src/far-field.ts    天穹壳跟相机 + 近景云环面回收（三路 tow 只剩这一路）
src/horizon.ts      天穹辉光/日盘的纯函数参考（海雾与云穹顶雾已删）
src/palettes.ts     色彩单源：天穹 / 机库涂装 / 浪花色
src/puff-cloud.ts   近景云材质与装配（含自带的 PUFF_HAZE）
```

**当时的下一步**（已完成）：海和云的重做从零开始。云的设计种子仍是
`plans/2026-11-02-puff-cluster-cloud.md` 与 `specs/2026-11-02-puff-cluster-cloud-design.md`。

---

## 1. 设计文档（specs/）

| 文档 | 状态 | 一句话 |
| --- | --- | --- |
| [`2026-11-02-puff-cluster-cloud-design.md`](specs/2026-11-02-puff-cluster-cloud-design.md) | **LIVE** | 近景云的球簇做法。云现在是活的，这份仍然有效，也是下一轮云重做的起点 |
| [`2026-11-03-puff-shell-fusion-design.md`](specs/2026-11-03-puff-shell-fusion-design.md) | **PARKED** | 把「球簇」融成「整体贝壳」以消掉球缝。设计与探针脚本齐全（已归档），代码未动 |
| [`2026-11-09-dome-cloud-volumetric-design.md`](specs/2026-11-09-dome-cloud-volumetric-design.md) | **LIVE（已落地 2026-11-11）** | 穹顶云体积化 P1 的设计稿：slab + 盒壁几何、Beer-Lambert + HG + powder、三层密度。与代码一致，实施顺序看 §2 的 11-09 计划行 |
| [`2026-11-10-dome-cloud-p15-p2-design.md`](specs/2026-11-10-dome-cloud-p15-p2-design.md) | **LIVE（已落地 2026-11-11）** | P1.5 质感 + P2 soft/flat 双 look 的设计稿。门 4 判据已按 round3 改为「受光/背光双峰分离，不规定极性」；「暗底」属风格化，见 §6 开口项 R18 |
| [`2026-11-10-flight-feel-improvement-design.md`](specs/2026-11-10-flight-feel-improvement-design.md) | **LIVE（已落地 2026-11-11；主观体感未签收）** | 飞行手感 v1.1：pushover 顶点改出／海垫钳制／云内碎抖／3D 风絮／失速预告／海面四层粒子／桨反馈／舒适开关／云门／G 黑边／低档裁剪。提交 `696f518..113861a`，拆账与 §6 映射见文内 §8。**验收只有无头模拟**：§6 勾 5 条、留 3 条（白雾贴边、巡航速度感、低档真机帧率） |
| [`2026-11-12-toon-look-toggle-design.md`](specs/2026-11-12-toon-look-toggle-design.md) | **LIVE（期 1 已落地 2026-11-13；期 2 未动）** | 三渲二 Look 总闸（海+天+云整体，主人已拍板）：`uToon` 总闸、`skyColorTsl` 出口档位化（双镜像同步，海天铁律不破）、dome 光照量化、hue-shifted 调色层走 `applyToonLook` 载体（D1 定案，非 setTrackPatch——整字段替换会短路轨道插值，修订注记见文内 T4）。默认 0 逐位不变；描边/rim 一期不做。亮度档位 6 档已生效（主人 2026-11-12 确认）。期 1 六门收口见 §2 同日 phase1 行（两项抓帧发现：夜档暗锚**仍在账**；dome 阈值标定**已随穹顶删除作废** 2026-11-13） |
| [`2026-11-13-painted-valley-style-alignment.md`](specs/2026-11-13-painted-valley-style-alignment.md) | **LIVE（对齐研究，2026-11-13；非任务计划）** | 第三方参考仓 `painted-valley`（`G:\DSHProject\refs\painted-valley`，MIT 代码 + CC0 美术）的逐层拆解与本仓对照。**核心结论**：它是「少色数（2–3 平涂 + 仅一条硬边）+ 笔触重采样 + 静态物一次烘焙」，不是后处理滤镜；我们目前只有 4 档等距量化（L* 步长 7.3/7.6/7.4），它是不等距 8.8/18.4/16.6。给出 P0–P5 分期（puff 2+1、dome 6 带→2 带、远海接管、陆地 B3 改写、Kuwahara/ink）、四道验收闸门与 kill 条件、8 条反面清单、参考仓文件索引。**每期开工前另出 fail-first 任务计划** |

`specs/assets/ref-0{1,2,3}-*.png` 是全部美术对齐的**参考真身**，任何配色/造型争议以它们为准。别删。

---

## 2. 计划（plans/）

| 文档 | 状态 | 一句话 |
| --- | --- | --- |
| [`2026-11-06-stylized-fft-ocean.md`](plans/2026-11-06-stylized-fft-ocean.md) | **已执行（2026-11-07，12/12 Task）** | 海面重建的实施计划：世界取模 FFT 场 + 同心方环 + 四档平涂，WebGPU-only。QA 量测项（bloom 峰值表、两档太阳路 99 分位、debug 覆盖率反解、目检）推迟到浏览器 QA pass |
| [`2026-11-07-in-cloud-volumetric-pass.md`](plans/2026-11-07-in-cloud-volumetric-pass.md) | **已执行（2026-11-07，6 Task）** | 穿云体积感：现场瓣近距淡出从「3–12 m 归零」改软曲线（1.2–10 m、下限 0.3）+ 相机锚定兜底瓣 + DOM 白纱封顶降到 0.45 并按视线-太阳夹角混色。验收回写在 [`reviews/2026-11-07-frame-composition-review.md`](reviews/2026-11-07-frame-composition-review.md) §五 |
| [`2026-11-07-sun-road-sparkle-anti-solar.md`](plans/2026-11-07-sun-road-sparkle-anti-solar.md) | **已执行（2026-11-07，v2 重写后 4 Task + round-2 验收帧）** | 太阳路 knee 预算（ROAD_CEILING≈0.757）+ GLINT_COS_THRESHOLD 斜率阈值闪光 + 背阳天空端压暗（AWAY_GAIN 0.75 / #5a3f60）+ 海面反射剔盘去重。v1 被 [`reviews/2026-11-07-sun-road-plan-review.md`](reviews/2026-11-07-sun-road-plan-review.md) 否决后重写（复审 §5 全吸收）；复审建议的天空值 0.55/#7f4f7e 经复算弃用。提交 48cdc06/d3e34a0/af462eb/ffcd7eb + 补丁 a665325/87ac421 |
| [`2026-11-08-day-night-sky.md`](plans/2026-11-08-day-night-sky.md) | **LIVE（待执行）** | 昼夜天空第一步（黄昏↔夜）：调色板轨道 × Preetham 比率能量场混合模型，参考档恒等，海霾/云/灯随轨道联动，星点层，夜档 bloom 预算。计划评审 [`reviews/2026-11-08-day-night-sky-plan-review.md`](reviews/2026-11-08-day-night-sky-plan-review.md)（12 处发现 + 元核查勘误）已全部修入 |
| [`2026-11-08-sea-nearfield-octave.md`](plans/2026-11-08-sea-nearfield-octave.md) | **LIVE（待执行；约束 1 钉死在昼夜计划 Task 1–8 全验收之后）** | C1 补 4–27.5 m 细带八度（11-07 海浪尺度审查 P1「近场波形消失」的修复）：子带逐位不动、细带独立归一逐格相加、顶点位移 32 m 低通；`?sea=nochop` A/B 钩子顺带补上 60 m 环缝证据链缺的 c1Gate A/B 工具 |
| [`2026-11-09-debug-color-panel.md`](plans/2026-11-09-debug-color-panel.md) | **已执行（2026-11-11，3 Task）** | 调色 Debug 面板（`?debug=color`）：qa 层轨道补丁／haze 锁／端点／chop 门／复现导出 + 悬浮面板（裸 DOM，动态 import）。默认路径逐位不变（同会话 A/B 字节级证实）；面板动作↔复现命令对照表与整体验收 ①④ 实测记录见计划进度段 |
| [`2026-11-09-dome-cloud-volumetric.md`](plans/2026-11-09-dome-cloud-volumetric.md) | **已执行（2026-11-11，Task 1–9）** | 穹顶云体积化 P1：slab+盒壁几何／分层漂移步长／Beer-Lambert+HG+powder 光照／三层密度体积／`?dome=0` 开关／装配／world 接线／性能仪器／验收。外部复审 7 处问题已修入计划 |
| [`2026-11-10-dome-cloud-p15-p2-horizon.md`](plans/2026-11-10-dome-cloud-p15-p2-horizon.md) | **已执行（2026-11-11，Task 0.5–9）** | P1.5 质感（雾洗/octave/cloudlook/shape/march/profile）＋ P2 soft/flat 双 look ＋地平线 patch＋DOF 远端钳制＋16 帧验收矩阵。提交 `ae44ce7..1e97a05`；评审 `artifacts/dome-audit/2026-11-10-dome-cloud-p15-p2-review.md`；遗留 R18（暗底视觉语言待 ref-01） |
| [`2026-11-11-audit-repair-list.md`](plans/2026-11-11-audit-repair-list.md) | **执行中（Phase 0 + Phase 1 完成 2026-11-12；Phase 2 待开）** | 三份"已完成"文档的审计修复总账：5 条 P0 阻塞（`FLT-01` GLB 螺旋桨空转／`FLT-02` 低档裁剪未接自动路径／`FLT-03` 失速预告分流／`DOME-01` horizon 未验收／`DOME-02` 门 1/2/5 换判据）＋ P1/P2 清单。**Phase 1 四条已关闭**（`DOME-01` 判据经主人接受改为三条合判，收口记录见 §1 末）。**每条动工前须扩成带 fail-first 测试的任务计划**，不是可直接照做的 step-level 计划 |
| [`2026-11-12-repair-phase1.md`](plans/2026-11-12-repair-phase1.md) | **已完成（四条 P0 全部关闭 2026-11-12；DOME-01 判据经主人接受）** | 修复清单四条 P0 的实施计划：FLT-01 螺旋桨兜底 pivot ✅（`e59728f`，浏览器门 3.91× PASS）/ FLT-02 自动低档接线 ✅（`4075e76`）/ FLT-03 失速预警/事件双态 ✅（`5898433`，ego 真机三帧 PASS）/ DOME-01 horizon：`d84a9fc` 的 gate FAIL **作废**（Step 9 证伪七处缺陷：rect 偏 69px、deck +11.8 抵消 patch −6.59、探针带掺 HUD、7/8 团在视野外、地平线锁错 100px）。Step 10 修体量：方位 40°→20°、数量 3–8→5–9、`MAX_PATCHES` 派生，9/9 团全在屏；Step 11 对比度一刀：`PATCH_SILHOUETTE_DARKEN=0.5` 只压背光侧（9 团 lit01 全≈0），同批次干净 A/B 行均值 2.297→4.003、p99 15.28→21.27、max 22.85→30.29（666 用例绿）。**判据已接受**：legacy row-mean>20 不可达，改为行均值≥2.5 / p99≥15 / 覆盖≥4% 三条合判（能区分控制组与压暗组）。证据 `p15-horizon-gate-v3/v4/v6.json` |
| [`2026-11-12-day-night-planB.md`](plans/2026-11-12-day-night-planB.md) | **执行中（期 1 已收口 2026-11-13；期 2 未开工）** | 昼夜轮转 + 月亮方案 B 分期计划：期 1 轨道补档+月盘（=方案 A，M）→ 期 2 时间轴（S–M）→ 期 3 月光/月相（M）。含 R1–R8 已定案技术决定、调色派生策略与跨期验收门；每期开工前另出任务级 fail-first 计划。**3 条已拍板（2026-11-12）**：R8 夜归零 ✓ / 默认 todSpeed=0（慢转 opt-in）✓ / 月光路碎闪 ✓。2026-11-12 审核修正 R2 缺省 t0（17.5→17.59 反解值）；B2/B3 已由期 1 计划吸收（B2 = Task 3 静态映射；B3 登记在期 1 计划「跨期注意」） |
| [`2026-11-13-day-night-planB-phase1.md`](plans/2026-11-13-day-night-planB-phase1.md) | **已执行（2026-11-13，6 Task 全绿；Task 6 Step 4 文档债于当日补齐）** | planB 期 1 任务级 fail-first 计划（6 Task）：tod 纯函数+解析器（**AZ_OFFSET≈−71.76° 反解推导写死在 Interfaces，防拿 12.09 当偏移**）→ bloom 网格扩 65°（钳位基线行）→ 静态 tod 接线（?sun= 胜 ?tod=、frozen 安全）→ KEYS +15/30/45/65°（R4 派生+人工 12 色）→ 月盘（uMoonDir 反相、日侧不可见）→ 采集矩阵+五项目检+INDEX.md:101 过期标注收口。B3 登记在「跨期注意」归期 3。**收口实测**：`tsc --noEmit` 0 · `vitest run` 68 文件 / 749 用例全绿；帧证据 `artifacts/daynight/matrix/`（tod ∈ {6,9,12,15,17.5,20,23} + `?tod=12` on/off，sidecar 全）。**两项 CONDITIONAL PASS 已记账**：① 夜海偏亮——走 −8 亮海先例，机理为 B3 已记录的 `main.ts:331` `lightEl = Math.max(el, 2)` 钳制、深夜档超设计域，**承接期 3**；② 人工 12 色——向阳帧与 Task 4 键一致，反日 navy 属 R1 方位设计行为，yaw 向阳复拍为非门 follow-up |
| [`2026-11-12-toon-look-toggle-phase1.md`](plans/2026-11-12-toon-look-toggle-phase1.md) | **已执行（2026-11-13，7 Task + 计划裁定 docs 修订；六门收口同批）** | 三渲二 Look 期 1 任务级 fail-first 计划（7 Task）：基准帧 → uToon 三件套 → 天海出口档位化（双镜像，JS 先行）→ dome 量化（三条 pin）→ `applyToonLook` 调色层 → bloom toon 行 + banding 留痕 → 六门收口。定案 D1/D2/D3 已随定稿生效（D1 批准留痕在设计稿 T4 注记 + 计划定案段）；DOME-01 收口后复核修正量具引用与 cloudBands 四层影响面（36b86fe）；6 档已生效；同会话成对 A/B 协议钉入计划（528a350，Task 1 裁定）。**提交** `0be8720`/`f523c49`/`2dc1c5d`/`cab7bc6`/`322f6c8`/`bd5d697`/`a5df4b0`/`05cd8d8` + 本收口提交。**六门**：G1 默认逐位（同会话成对三机位 BYTE-IDENTICAL + run 内稳定性门；跨会话辅证 toon0 sha 链与 Task 4 时代逐字节同）/ G3 镜像 pin / G4 参考档恒等三 describe 字节级未动 + 全量 65 文件 693 用例绿 / G5 toon 行峰值全落锚 max 0.75<0.82 / G6 repro URL+console 双通道夜档字面量太阳字节级重放——全绿。G2 天（ref 6 档 / 海平线 4 档）/ 海（7/9/6）/ 过渡帧 0.5（7 档）/ 接缝（翻转 control 已有、toon 未引入且 excess 6.95→5.23）绿。**两项发现待拍板**（证据 `artifacts/toon-audit/ab-evidence-task6/`）：①夜档天区 clean window 仅 2 档（<3，暗锚坍缩——T4 影子锚 0.44× 传播的抓帧复评输入；夜档目检结构成立不破相，整体偏暗；锚重选走标定流程）②dome 四件套 tierStructure 阈值（Task 3 定：3× 梯度 / step≥15）在 Task 4 调色层合成后的最终帧上 ref/horizon 不再命中（control 中位数跨会话逐位不变、toon1 减半）——**该条已于 2026-11-13 随穹顶删除作废**：阈值与其量具随 `dome-cloud.ts` 一并消失，不需要重标；若将来重做体积云再按新管线重立。**环境契约**：采集 Chrome 须带 `--disable-features=CalculateNativeWinOcclusion` 启动（原生遮挡检测在本桌面会卡死 hidden，rAF 停摆、抓帧挂起），配方 `artifacts/toon-audit/task6-scratch/launch-chrome2.ps1` |
| [`2026-11-12-render-perf-pass1.md`](plans/2026-11-12-render-perf-pass1.md) | **执行中（P1 任务级计划已出 2026-11-13，见同日 p1-measure 行）** | 渲染性能初步优化：固化 2026-11-12 实测口径与瓶颈排序。**关键数据**：high 档 p50 20.8 ms / **p95 27.9**（≈48 fps，vsync 3:2 节拍）；关 puff 云 p95→14.1（**掉帧元凶**）、关后处理→20.6、关海/穹顶→p50 13.9（地板）。**口径纪律**：焦点+档位双断言（失焦节流 rAF、governor 自动降档会污染段）、13.9 ms 是 vsync 地板不能当收益、p50/p95 双口径（常态分散 / 尾部元凶单一）、画面不许退化。方向排序 P1 puff overdraw → P2 后处理 → P3 海面片元（**不是远端**）→ P4 纹理内存（**有量具前置门**：memory 字段仓内不存在，dsh 外部诊断口径未入库）。2026-11-12 审核七处已修入（结论 3 双口径、§1.1 补钩子清单 + Chrome `[::1]` 写法、P4 前置门 + 删幻影天空 LUT） |
| [`2026-11-13-render-perf-p1-measure.md`](plans/2026-11-13-render-perf-p1-measure.md) | **待执行（已出计划 2026-11-13）** | 性能 P1（puff overdraw）量测先行任务计划（3 Task，**零 src 改动**）：绘制形态静态盘点（含 ?puff=0 级联语义核实）→ 运行时量测（`?puff=0` 差分覆盖率 + overdraw 估 + 距离分带计数，非 puff 区全等先验）→ 手段选择门（候选表按数据填判 + 优化计划大纲）。优化实施另出任务计划 |
| [`2026-11-13-painted-valley-look-master.md`](plans/2026-11-13-painted-valley-look-master.md) | **LIVE（总案，2026-11-13；未开工）** | 风格化改造**总案**（umbrella，非任务计划）：对标 [painted-valley 对齐研究](specs/2026-11-13-painted-valley-style-alignment.md)。只定顺序/隔离/闸门/回退，不写实现。依赖图 `P0 量尺 → P1 puff → P2 dome → P5 收尾`，`P3 海`并行，`P4 陆地`独立仓。**Task 0 是隔离与基线**（当前工作树脏：9 文件 +290/−19 未提交，必须先 checkpoint 再开分支/worktree，否则「退回去」会连 WIP 一起退）。P1 = 最小可证伪实验（一文件、零新增采样），不过则中止全案。每期开工前另出 fail-first 任务计划；每期收尾打 `look-P<n>` tag（回滚单位是 commit+tag，不是分支） |
| [`2026-11-02-puff-cluster-cloud.md`](plans/2026-11-02-puff-cluster-cloud.md) | **LIVE** | 云簇重做，已落地，仍在被引用；云重做从这里读起 |
| [`2026-10-31-capture-protocol.md`](plans/2026-10-31-capture-protocol.md) | **LIVE** | 抓帧契约：四态机位、冻结帧、复现门。这个机位定义现在还在用 |
| [`2026-10-31-sky-technical-note.md`](plans/2026-10-31-sky-technical-note.md) | **LIVE** | 天穹的实际算法说明。天穹没被删，这份仍然对；**背阳端的现值看文末附录 A**（10-31 正文的 `AWAY_*` 已过期） |
| [`2026-11-05-land-flight-0-to-1.md`](plans/2026-11-05-land-flight-0-to-1.md) | **LIVE（路线图，非任务计划）** | 陆地飞行场景 0→1 的**阶段级** roadmap（2026-11-05 定调「先海后陆、上下两卷」）。行动仓是 `G:\DSHProject\ThreeJSInspire-reconstruct`，本仓只作 A/B 像素对照；每个里程碑开工前另出任务级计划。⚠ 它引用的 `reviews/2026-11-02-tonemap-hull-resolution.md` 在本分支不存在，取原文用 `git show master:docs/superpowers/reviews/2026-11-02-tonemap-hull-resolution.md` |
| [`2026-11-03-puff-shell-fusion.md`](plans/2026-11-03-puff-shell-fusion.md) | **PARKED** | 上面那份 shell 设计对应的实施计划。脚本与曲线数据在 `artifacts/archive/puff-shell-fusion/` |
| [`2026-11-06-0to1-rebuild.md`](plans/2026-11-06-0to1-rebuild.md) | **DRAFT** | 另一条思路：复制出一个干净的 `0to1` 新仓库再清理。本次改走「同仓库新分支」，本文件仅作方案留档，**不要照它执行** |
| [`2026-10-30-puff-scatter.md`](plans/2026-10-30-puff-scatter.md) | SUPERSEDED | 云散布初版，被 cluster-cloud 重做取代 |
| [`2026-10-31-ref-gap-audit.md`](plans/2026-10-31-ref-gap-audit.md) | SUPERSEDED | 参考图差距审计。量法仍有效，结论针对已删的实现 |
| [`2026-10-31-scorecard-gaps-technical-note.md`](plans/2026-10-31-scorecard-gaps-technical-note.md) | SUPERSEDED | AAA 图形评分卡的四项自动指标。**量法可复用**，分数针对旧实现 |
| [`2026-10-29-phaseB-nine-improvements.md`](plans/2026-10-29-phaseB-nine-improvements.md) | HISTORY | Phase B 九项改进 |
| [`2026-10-29-porco-sunset-dogfight.md`](plans/2026-10-29-porco-sunset-dogfight.md) | HISTORY | 最初总计划。约束章节（竖屏、缺资源降级）至今有效 |

---

## 3. 评审记录（reviews/）

14 份，**绝大多数 HISTORY**。它们是决策台账：为什么 128² 不是 256²、哪一版在哪块 GPU 上黑屏、
哪次白雾把帧糊死。写代码不需要读，**但任何「当初为什么」的问题答案都在这**。

2026-11-07 新增两份，都是「代码已改、结论待复核」的类型，**别当成已修好的验收报告**：

- [`2026-11-07-frame-composition-review.md`](reviews/2026-11-07-frame-composition-review.md) ——
  太阳光路黑洞的二分取证（9 组结构性删除实验，定案为「色带 mix 链 + 大数值加法」的通道湮灭），
  以及重写后的光路 knee / 背阳天空验收回写（§六，含 Round 1→2 的实测表）。**跨三个时点，
  顶部有时效分层表**：§一 的 P1–P5 与 §二 的定案都跑在已被替换的旧实现上（黑洞在 §四 已经消失），
  只有 §四（重写复核）与 §五/§六（体积感、光路验收）是现状。文末 §七 是 QA 入口表，
  含「`world.sea` 没有单变量关 C1 的钩子」这条已知缺口。留了「常量绿加法」tripwire：
  任何「某通道整体归零 / 出现紫斑」先跑它再怀疑调参。
- [`2026-11-07-sea-wave-scale-review.md`](reviews/2026-11-07-sea-wave-scale-review.md) ——
  海面波浪尺度的美术审核，**v2 修订版，结论「不通过（需返工）」**：2×P1（近场波形消失、
  4–32 m 八度缺位）+ 2×P2 + 1×P3。v2 自己撤回了 v1 的 20 m 环缝证据（实为 debug 等高线）、
  更正「没有透视加密」的误判，并把坡度论证降级为脚注。**判据 3（60 m 直线做 `c1Gate` 几何
  A/B）目前跑不了**——`c1Gate` 没有公开写入钩子，`setQuality(false)` 会连带改 `tierGain`
  并停 C1 派发（详见文内备注）。翼展有 9.8 / 10.9 / 11.4 m 三套口径，比值按区间读。
  v1 原件备份在 `artifacts/sea-review/report-backup-2026-11-07-orig.md`。

2026-11-08 新增四份：

- [`2026-11-07-sun-road-plan-review.md`](reviews/2026-11-07-sun-road-plan-review.md) ——
  sun-road v1 计划的外部复审：5 处执行硬伤 + 8 项机制错配（E1–E5/M1–M8），另附可重跑量测
  `artifacts/sun-road-review/`。§5 重写方向是 v2 计划的蓝本，v1 从未被执行。
- [`2026-11-08-day-night-sky-plan-review.md`](reviews/2026-11-08-day-night-sky-plan-review.md) ——
  昼夜天空计划的独立代码对照审查（12 处发现全部修入计划）+ 元核查勘误段；海面细八度计划的
  二审落文同批。
- [`2026-11-08-sky-sun-sea-linkage-review.md`](reviews/2026-11-08-sky-sun-sea-linkage-review.md) ——
  天空盒/太阳/海面联动审查：两条坐标系错误（穹顶世界原点视线、far-field 只拖 X/Z）+
  太阳无运行时状态的架构缺口。修复已入库（`src/sun-state.ts` 等），文末留 4 条人工目检门。
- [`2026-11-08-sky-sun-sea-linkage-change-report.md`](reviews/2026-11-08-sky-sun-sea-linkage-change-report.md) ——
  上述修复的逐文件更改报告（9 个既有文件 +216/−51、4 个新文件 +562），含复查手册与 6 条风险。

2026-11-09 新增一份（**未被 git 跟踪，纯审阅汇总**）：

- [`2026-11-09-9701c7e-2f05b25-consolidated-issues.md`](reviews/2026-11-09-9701c7e-2f05b25-consolidated-issues.md) ——
  15 个提交、9701c7e→2f05b25（天空昼夜 / 海面细八度 / 太阳路跨 era）的双审阅员汇总：无 Critical，Important 5 条（TSL 天顶角上钳、能量比率除零守卫、`?sea=nochop` 与 FrameGovernor 无互斥、太阳路 PASS 跨 era 红利混杂、顶点 LOD 小数语义未验证）+ Minor 8 条 + 已确认通过项 + 遗留欠条。纯审阅结论，未改动任何代码。**文件未被 git 跟踪**。

海面与穹顶云相关的 5 份评审（`cloud-sea-sun-audit` / `four-fixes` / `sea-fbm-*` /
`sea-techart`）已在 2026-11-06 随实现一起删除 —— 它们描述的对象已经不存在，
留着的价值低于误读的成本。原始内容仍在 git 历史里：`git show a842657:docs/...`。

---

## 4. 证据与工具（artifacts/）

目录分层原则：**`artifacts/` 只放证据和仪器，不放叙述**。叙述在 `docs/`。

### 活的部分

| 路径 | 内容 |
| --- | --- |
| `cloud-audit/*.py` `*.mjs` | 量测仪器：`audit.py --parity` 一张全表、`ref_gap_three.py` 三对基线、`sky_band_probe.py` 天穹分带、`scorecard_metrics.py` 评分卡四项、`puff-coverage.py` 云占比、`color_sample.py` 彩度剖面 |
| `cloud-audit/protocol/` | 抓帧契约的冻结帧 + `capture-protocol.json` + `baseline-*.json` 的 102 个钉值 |
| `cloud-audit/protocol-2026-11-01/` | 同上一次采集 + `measure.json`。puff 验收的机位来源 |
| `cloud-audit/ref/` | 参考图裁切（`centre_column.png` / `left_bank.png`），造型对齐的真身 |
| `cloud-audit/qa-shots/` | 天穹辉光与 HUD 的 A/B 帧 |
| `cloud-audit/puff-*.{json,jpg}` | 云簇预算与 hero 帧 |
| `ghibli-audit/*.py` | 参考图量测：`edge-loops.py` 轮廓弧、`solve-ramp.py` **反解 NeutralToneMapping**（屏上目标色的正解，别自己手推）、`measure-bands2.py`、`palette-span.py` |
| `sea-review/` | 海面波浪尺度审核（2026-11-07）的整包证据：18 张冻结帧（含 560×995 真 9:16 复拍）、`capture.mjs` / `motion.mjs` / `measure.py` / `details.py`、`capture*.json`（逐帧 `describe()` 与可重放 URL）、`measurements.json` / `details.json`，以及 `report-backup-2026-11-07-orig.md`（v2 修订前的原件）。量具口径注意：`row_stripes` 数的是「行均值梯度 >3 的行数」，不是可见条纹条数 |
| `sun-road-review/` | 太阳路 knee + 背阳端压暗的验收证据：`A3-r2.png` / `B3-r2.png` / `C3-fall.png` 三机位帧、`measure_bands.py`（分带 p50/p95/blown%，按地平线行切带）、`measurements-round2.json`。**带定义仍跨天际线**，复用前先看 frame-composition review §六「遗留」 |
| `dsh-setup/` | 工具链与 harness 的本地配置记录 |

> `cloud-audit/` 保留是刻意的：里面的仪器**多数与海无关**（天穹分带、评分卡、云占比、调色反解），
> 但 `protocol*/` 的冻结帧是海面时代拍的，只作历史对照 —— 新的海重做后要重新抓一套。

### 归档的部分

`artifacts/archive/` 装的是**已删实现的证据**。不删是因为「当初为什么否定它」比结论更值钱。

| 路径 | 内容 | 为什么是死的 |
| --- | --- | --- |
| `archive/puff-shell-fusion/` (8) | **PARKED 线**：`shell-probe.mjs`（半径包络可行性探针）、`shell-bench.mjs`（25 朵壳生成耗时）、`shell-plot.py`（极坐标对比图）、4 组 `shell-curve-*.json`、1 张探针图 | 不是死的，是**停的** |

海面（`sea-fft-fbm-era/`、`sea-detail-attempt/`）与穹顶云（`dome-cloud-era/`）的证据帧
已于 2026-11-06 一并删除；需要时从 `git show a842657:artifacts/...` 取。

### 不在库里（本地临时）

`artifacts/cloud-audit/live/` 被 `.gitignore` 排除，是现场抓帧的暂存区。
某些早期数字只在它里面可复核，删了就真没了 —— 想清磁盘先想清楚这一条。

---

## 5. 清理记录

### 2026-11-06 — 海面与穹顶云整体删除

一次删除型重构，目标是「零负担起点」。删的东西：

- `src/sea/` 全部 15 个文件（7 模块 + 8 单测）、`src/sun-road.ts` + 单测
- `horizon.ts` 的 `HORIZON.HAZE_NEAR/HAZE_FAR`、`horizonHaze`、`CLOUD_HAZE`、
  `cloudHaze`、`domeCloudHaze`（天穹辉光/日盘保留）
- `palettes.ts` 的 `SEA_PALETTE`、`CLOUD_PALETTE`
- `artifacts/sea-audit/`、`archive/sea-fft-fbm-era/`、`archive/sea-detail-attempt/`、
  `archive/dome-cloud-era/`
- 7 份计划/设计（stylized-sea ×2、sea-surface-lod、sea-technical-note、
  sea-fbm-band-continuity、clouds-technical-note、cloud-sea-sun-audit、
  porco-flight-sea-cloud-design）+ 4 份评审

接线改了三处：`world.ts` 只装云（`update(t, dt)` 不再吃相机/角预算）、`main.ts` 去掉
`perPixelRadians` 与 sea 分支、`feel.ts` 的浪花 tint 改读 `WAKE_FOAM`。
`smoke.mjs` 白名单同步删掉 6 条，`puff-cloud.test.ts` 的「穹顶配色不被改」守卫一并删除
（它守的那个对象已经不存在）。

**刻意没删**（判断留档，不同意就说）：

- `subtitles.ts` 里「黄昏的海面」这类**叙事文案**——那是剧情，不是实现
- `audio.ts` 的 wave ambience 层（`seaSrc` 带通噪声）——是场景声音，删了会静场
- `camera-rig.ts` 的 `CAM_MIN_Y`、`puff-field.ts` 的 `SEA_CLEAR`——名字带 sea，语义是
  「y=0 基准面」，海回来后仍然对

---

## 6. 开口项（等拍板 / 等手飞）

登记原则：**代码已完成、但需要人做决定或动手体感验收的，放这里**，不要散落在各计划正文里被误读成"已验收"。

| 项 | 内容 | 卡在谁 | 现状与影响 |
| --- | --- | --- | --- |
| **R18** | 穹顶云「暗底亮顶」这个视觉语言要不要做。门 4 现只判「受光/背光双峰分离，**不规定极性**」，是刻意留的中性判据 | **已作废（2026-11-13）**——穹顶云链条按 [`cloud-layer-reduction-design`](specs/2026-11-13-cloud-layer-reduction-design.md) 整体删除，R18 失去主语。本行与「主人 2026-11-13 答复可以要」一并只作历史留档，**不要**再排期 | 无影响。dome 模块删除后门 4 与其极性判据一起消失；若将来重做体积云，届时按新设计重新立项，**不要**把这条捞回来当既有决定 |
| **飞行 §6 三条** | ① 穿云白雾贴边不闪（目检）② 巡航 30s 能否说出"变快/变慢"（手飞）③ 低档机真机帧率（需真机） | 需主人手飞 / 真机 | 机制均已单测 pin 住，观感与真机未验收。详见 `specs/2026-11-10-flight-feel-improvement-design.md` §8.3。**① 2026-11-13 手飞回归并修复**：主人报「离得还有点距离还是会白」——根因是 `whiteout01` 把 prox **线性**映射成整屏白纱（d=1.5 即 30 m 云外 15 m 处仍有 0.225），与 `IN_CLOUD` 注释声称的「硬触发」相反；已收紧为近场带 `VEIL_INNER=0.96`（≈d 1.075 / 30 m 云约 2.5 m）+ 兜底瓣起点 `INTERIOR_FADE.START` 0.7→0.88，单测新增 d=1.35/1.5 处必须为 0 的回归守卫（750 用例绿）。**手飞验推迟（主人 2026-11-13 裁定）**：云本身马上要重做，白纱「进云是否断层」并入减层之后的验收（[云层收敛计划](plans/2026-11-13-cloud-layer-reduction.md) Task 9），现在不单独排期 |
| **65° 档超域两症**（2026-11-13 实跑发现） | `?tod=12`（el=65°）帧上有两个不合应然的现象，**默认参考档 6.97° 实测都没有**（`?qa=frozen` 对照帧干净）：**(a) 地平线绿带**——地平线上方约 24 px 的青→绿→黄过渡，行剖面 hue 214.5→162.5→123.2→62.1→33.0，sat 仅 0.08–0.13 但 lum 0.43–0.53 反高于上方紫空 0.31–0.34；65° 键 `dayStops` 是 `#e78b51/#d98aa5/#7d63b4/#57408a`（无绿），故绿色不可能来自 ramp，疑为 `seaHazeEndpoints` 能量比在超域处串色。**(b) 穹顶硬分界**——天空出现带笔直斜边与水平硬线的紫色楔形；`?dome=0` A/B 确认属穹顶家族（关掉即消失，近景 puff 原样保留），而 `dome-cloud.ts:18-19` 写着「盒壁处 `fadeEnd` 已经让云全透明，所以看不见盒子边」——该不变式在 65° 档失效（`fadeEnd` 按**相机距离**淡出，管不到视线在 slab 内的**路径长度**） | 待定级：绿带走一次 `seaHazeEndpoints(65°)` 直读 A/B；硬边需确认是 slab 出射面还是 deck 实体边缘（两者都关在 `?dome=0` 下，目前无分档杠杆），再决定加路径长度渐隐还是收 `fadeEnd` | 不阻塞默认交付：默认 6.97° 档逐位不变（G1/G4 已证），`?tod` 为 opt-in 路径。两症同源（都在新补的 65° 档），**建议合并成一条「65° 档收口」任务**再动。证据帧：本地 `ab-dome-on/off.png`、`ref-tod-default-frozen.png` + 行剖面探针（尚未入 `artifacts/`） |
