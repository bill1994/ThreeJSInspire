# docs/superpowers — 索引与状态

本仓库有 19 份计划/设计/审查文档（10 计划 + 7 评审 + 2 设计）。它们不是同级关系：有的是当前任务清单，有的是已经死掉的方向的执行记录。
本文是唯一的状态来源 —— **不确定某份文档还能不能信，先看这里，再决定读不读。**

状态图例：

| 状态 | 含义 | 怎么用 |
| --- | --- | --- |
| **LIVE** | 当前方向，代码正在按它走 | 改代码前必读，数值以它为准 |
| **PARKED** | 做到一半主动停下的线，将来可能续 | 只在回到那条线时读，别让它的设计混进主线 |
| **SUPERSEDED** | 被后续文档取代，方向已放弃 | 只用来查「当初为什么这么做」，**不要**照它改代码 |
| **HISTORY** | 已完成任务的执行/评审记录，只读 | 查证据和决策出处 |

---

## 0. 当前基线（2026-11-06）

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

```
src/world.ts        世界总装（只装近景云）+ FrameGovernor
src/far-field.ts    天穹壳跟相机 + 近景云环面回收（三路 tow 只剩这一路）
src/horizon.ts      天穹辉光/日盘的纯函数参考（海雾与云穹顶雾已删）
src/palettes.ts     色彩单源：天穹 / 机库涂装 / 浪花色
src/puff-cloud.ts   近景云材质与装配（含自带的 PUFF_HAZE）
```

**下一步**：海和云的重做从零开始。云的设计种子仍是
`plans/2026-11-02-puff-cluster-cloud.md` 与 `specs/2026-11-02-puff-cluster-cloud-design.md`。

---

## 1. 设计文档（specs/）

| 文档 | 状态 | 一句话 |
| --- | --- | --- |
| [`2026-11-02-puff-cluster-cloud-design.md`](specs/2026-11-02-puff-cluster-cloud-design.md) | **LIVE** | 近景云的球簇做法。云现在是活的，这份仍然有效，也是下一轮云重做的起点 |
| [`2026-11-03-puff-shell-fusion-design.md`](specs/2026-11-03-puff-shell-fusion-design.md) | **PARKED** | 把「球簇」融成「整体贝壳」以消掉球缝。设计与探针脚本齐全（已归档），代码未动 |

`specs/assets/ref-0{1,2,3}-*.png` 是全部美术对齐的**参考真身**，任何配色/造型争议以它们为准。别删。

---

## 2. 计划（plans/）

| 文档 | 状态 | 一句话 |
| --- | --- | --- |
| [`2026-11-02-puff-cluster-cloud.md`](plans/2026-11-02-puff-cluster-cloud.md) | **LIVE** | 云簇重做，已落地，仍在被引用；云重做从这里读起 |
| [`2026-10-31-capture-protocol.md`](plans/2026-10-31-capture-protocol.md) | **LIVE** | 抓帧契约：四态机位、冻结帧、复现门。这个机位定义现在还在用 |
| [`2026-10-31-sky-technical-note.md`](plans/2026-10-31-sky-technical-note.md) | **LIVE** | 天穹的实际算法说明。天穹没被删，这份仍然对 |
| [`2026-11-03-puff-shell-fusion.md`](plans/2026-11-03-puff-shell-fusion.md) | **PARKED** | 上面那份 shell 设计对应的实施计划。脚本与曲线数据在 `artifacts/archive/puff-shell-fusion/` |
| [`2026-11-06-0to1-rebuild.md`](plans/2026-11-06-0to1-rebuild.md) | **DRAFT** | 另一条思路：复制出一个干净的 `0to1` 新仓库再清理。本次改走「同仓库新分支」，本文件仅作方案留档，**不要照它执行** |
| [`2026-10-30-puff-scatter.md`](plans/2026-10-30-puff-scatter.md) | SUPERSEDED | 云散布初版，被 cluster-cloud 重做取代 |
| [`2026-10-31-ref-gap-audit.md`](plans/2026-10-31-ref-gap-audit.md) | SUPERSEDED | 参考图差距审计。量法仍有效，结论针对已删的实现 |
| [`2026-10-31-scorecard-gaps-technical-note.md`](plans/2026-10-31-scorecard-gaps-technical-note.md) | SUPERSEDED | AAA 图形评分卡的四项自动指标。**量法可复用**，分数针对旧实现 |
| [`2026-10-29-phaseB-nine-improvements.md`](plans/2026-10-29-phaseB-nine-improvements.md) | HISTORY | Phase B 九项改进 |
| [`2026-10-29-porco-sunset-dogfight.md`](plans/2026-10-29-porco-sunset-dogfight.md) | HISTORY | 最初总计划。约束章节（竖屏、缺资源降级）至今有效 |

---

## 3. 评审记录（reviews/）

7 份，**全部 HISTORY**。它们是决策台账：为什么 128² 不是 256²、哪一版在哪块 GPU 上黑屏、
哪次白雾把帧糊死。写代码不需要读，**但任何「当初为什么」的问题答案都在这**。

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
