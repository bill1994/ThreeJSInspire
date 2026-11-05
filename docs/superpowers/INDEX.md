# docs/superpowers — 索引与状态

本仓库有 30 份计划/设计/审查文档（14 计划 + 12 评审 + 4 设计）。它们不是同级关系：有的是当前任务清单，有的是已经死掉的方向的执行记录。
本文是唯一的状态来源 —— **不确定某份文档还能不能信，先看这里，再决定读不读。**

状态图例：

| 状态 | 含义 | 怎么用 |
| --- | --- | --- |
| **LIVE** | 当前方向，代码正在按它走 | 改代码前必读，数值以它为准 |
| **PARKED** | 做到一半主动停下的线，将来可能续 | 只在回到那条线时读，别让它的设计混进主线 |
| **SUPERSEDED** | 被后续文档取代，方向已放弃 | 只用来查「当初为什么这么做」，**不要**照它改代码 |
| **HISTORY** | 已完成任务的执行/评审记录，只读 | 查证据和决策出处 |

---

## 0. 当前基线（2026-11-05）

分支 `reconstruct`（跟踪 `origin/reconstruct`），HEAD `4d7f6d3`。这个基线的定义是：

- **FFT 海面整体删除**（`sea-fft.ts` / `sea-fbm.ts` / `sea-metrics.ts`，约 2600 行）
- **体积云穹顶删除**（`clouds-compute.ts`，634 行）
- **活儿全在**：天穹（TSL）、近景 puff 云、飞机、post、HUD、音频，**以及新的分带海面**
- **海已经挂上、能跑、有位移、有光照项**：六条方形环 + 每帧角预算 + 10 m 迟滞 + b4/b5 内缩，
  加上太阳闪 / tinted fresnel / 解析反射 / 距离色（stylized-sea Task 5）。启动条读
  `sky + sea + puffs`
- **海还不好看**：浪花（Task 4）没有，调色与 ramp 眼调（Task 7）没做。光照项把水面**饱和度
  压低了 11%**、闪光聚成一小块而不是一条金路——这两个数是量的，不是感觉，见 Task 5 的执行
  注记

闸门在 `4d7f6d3` 上是过的（实测，不是转述）：`tsc --noEmit` exit 0 · `vitest run`
33 files / 314 tests 全绿 · `smoke ok` · 树干净。

```
src/sea/waves.ts            5 条波列、解析法线、雅可比（纯 TS）
src/sea/lod.ts              带表 + 每帧角度预算 + 可见性迟滞
src/sea/bands.ts            六条方形环、各自 snap 拖拽、孔洞内缩
src/sea/surface-material.ts Lagrangian 位移 + 逐列距离淡出 + 基础色阶 + 浪脊色窗
src/sea/depth-hooks.ts      岸线接口（休眠，待浪花任务接入）
```

**下一步不是几何，是着色**：stylized-sea 的 Task 4/5/7。注意那两份计划的 Task 表
（`- [ ]` 勾选）已经不可信，见第 2 节两行的说明。

旧实现只在 git 历史里：`git show 5db7458:src/sea-fft.ts`。计划里有这条引用，那是**故意的** ——
重建时要参考同一版 three r186 下的 TSL 写法。

---

## 1. 设计文档（specs/）

| 文档 | 状态 | 一句话 |
| --- | --- | --- |
| [`2026-11-04-stylized-sea-design.md`](specs/2026-11-04-stylized-sea-design.md) | **LIVE** | 当前海面重建的设计。参数化 Gerstner 取代 FFT，Uber-Anime 分层，明确不要 caustics / 水下 / 折射 |
| [`2026-11-04-infinite-ocean-lod-design.md`](specs/2026-11-04-infinite-ocean-lod-design.md) | **LIVE** | **无限海的分级表面**（rev 3）。可见性判据、每帧角预算、六带表、接缝缝合。**与上一份配套：一份管长什么样，一份管有多少、多细** |
| [`2026-11-02-puff-cluster-cloud-design.md`](specs/2026-11-02-puff-cluster-cloud-design.md) | **LIVE** | 近景云的球簇做法。云现在是活的，这份仍然有效 |
| [`2026-11-03-puff-shell-fusion-design.md`](specs/2026-11-03-puff-shell-fusion-design.md) | **PARKED** | 把「球簇」融成「整体贝壳」以消掉球缝。设计与探针脚本齐全（已归档），代码未动。停顿原因：海面重建优先级更高 |
| [`2026-10-30-porco-flight-sea-cloud-design.md`](specs/2026-10-30-porco-flight-sea-cloud-design.md) | SUPERSEDED | 初版总设计（FFT 海 + 体积云）。两份主角都已删除，只作历史 |

`specs/assets/ref-0{1,2,3}-*.png` 是全部美术对齐的**参考真身**，任何配色/造型争议以它们为准。别删。

---

## 2. 计划（plans/）

| 文档 | 状态 | 一句话 |
| --- | --- | --- |
| [`2026-11-04-stylized-sea.md`](plans/2026-11-04-stylized-sea.md) | **LIVE（部分）** | 海面任务清单。**Task 1/2/5 已完成；Task 3/6 已被 LOD 计划取代**（不要再照它们造 `src/sea/shading.ts`）。**Task 7 部分完成**：调色与带宽重排已落地，但水面还不像水（无可见浪脊、闪光不过阈值）。**剩 Task 4（浪花）+ 更硬的带边** |
| [`2026-11-04-sea-surface-lod.md`](plans/2026-11-04-sea-surface-lod.md) | **LIVE（进行中）** | 分级表面计划。**Task 1–6 全部完成**，R6 已解除，R2 的 fragment 成本 spike 已出报告。开头 Status 节是唯一可靠的断点；剩下的都是着色（见上一行）与被临时值拖住的 ramp 调校 |
| [`2026-11-02-puff-cluster-cloud.md`](plans/2026-11-02-puff-cluster-cloud.md) | **LIVE** | 云簇重做，已落地，仍在被引用 |
| [`2026-10-31-capture-protocol.md`](plans/2026-10-31-capture-protocol.md) | **LIVE** | 抓帧契约：四态机位、冻结帧、复现门。这个机位定义现在还在用 |
| [`2026-10-31-sky-technical-note.md`](plans/2026-10-31-sky-technical-note.md) | **LIVE** | 天穹的实际算法说明。天穹没被删，这份仍然对 |
| [`2026-11-03-puff-shell-fusion.md`](plans/2026-11-03-puff-shell-fusion.md) | **PARKED** | 上面那份 shell 设计对应的实施计划。脚本与曲线数据在 `artifacts/archive/puff-shell-fusion/` |
| [`2026-11-03-sea-fbm-band-continuity.md`](plans/2026-11-03-sea-fbm-band-continuity.md) | SUPERSEDED | FBM 色带延续性。整个 FBM 方向被 Gerstner 取代，任务全部作废 |
| [`2026-10-31-sea-technical-note.md`](plans/2026-10-31-sea-technical-note.md) | SUPERSEDED | FFT 海面的技术说明与实测数字。**数值仍可作重建的对照基线** |
| [`2026-10-31-clouds-technical-note.md`](plans/2026-10-31-clouds-technical-note.md) | SUPERSEDED | 穹顶体积云。dome 已删 |
| [`2026-10-31-ref-gap-audit.md`](plans/2026-10-31-ref-gap-audit.md) | SUPERSEDED | 参考图差距审计。量法仍有效，结论针对已删的实现 |
| [`2026-10-31-scorecard-gaps-technical-note.md`](plans/2026-10-31-scorecard-gaps-technical-note.md) | SUPERSEDED | AAA 图形评分卡的四项自动指标。**量法可复用**，分数针对旧实现 |
| [`2026-10-30-puff-scatter.md`](plans/2026-10-30-puff-scatter.md) | SUPERSEDED | 云散布初版，被 cluster-cloud 重做取代 |
| [`2026-10-30-cloud-sea-sun-audit.md`](plans/2026-10-30-cloud-sea-sun-audit.md) | HISTORY | 第一轮云/海/天审计 |
| [`2026-10-29-phaseB-nine-improvements.md`](plans/2026-10-29-phaseB-nine-improvements.md) | HISTORY | Phase B 九项改进 |
| [`2026-10-29-porco-sunset-dogfight.md`](plans/2026-10-29-porco-sunset-dogfight.md) | HISTORY | 最初总计划。约束章节（竖屏、缺资源降级）至今有效 |

---

## 3. 评审记录（reviews/）

12 份，**全部 HISTORY**。它们是决策台账：为什么 128² 不是 256²、为什么放弃 FFT、哪一版在哪块 GPU 上黑屏。
写代码不需要读，**但任何「当初为什么」的问题答案都在这**。

唯一半活的：`2026-11-04-sea-fbm-open-issues.md` —— 里面 M1/M2 两条随 FBM 方向一起作废，
其余关于量测脚本硬编码的观察（`band_continuity.py` 里还钉着 FFT 的 stops）在重建时仍然成立。

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
| `sea-audit/*.mjs` `*.js` `band_continuity.py` | 抓帧与分带量测。**逐文件判决表在 [`artifacts/sea-audit/README.md`](../../artifacts/sea-audit/README.md)** —— 这个目录横跨 FFT / FBM / Gerstner 三个时代，别看文件名猜。活的：`cdp-capture.mjs` 抓帧、`band_continuity.py`（**只剩 png 模式**，`--recompute` 已随 FFT 场删除）、`eval-perf-webgpu.js`、`eval-wind.js`、`eval-lowq.js` |
| `ghibli-audit/*.py` | 参考图量测：`edge-loops.py` 轮廓弧、`solve-ramp.py` **反解 NeutralToneMapping**（编屏上目标色的正解，别自己手推）、`measure-bands2.py`、`palette-span.py` |

### 归档的部分

`artifacts/archive/` 装的是**已删实现的证据**。不删是因为「当初为什么否定它」比结论更值钱；
移出去是因为它们和活仪器混在一起，没人分得清哪个还能跑。

| 路径 | 内容 | 为什么是死的 |
| --- | --- | --- |
| `archive/sea-fft-fbm-era/` (30 帧 + 4 脚本) | FFT vs FBM 的 A/B 帧、`fbm-debug-*` 诊断视图、性能对照图；以及四个死仪器 `fbm-readback-probe.js` / `fbm-diff-map.js` / `eval-perf-rAF.js` / `eval-perf-glfinish.js` | 两个实现都已删除；四个脚本要么 import 已删模块（前两个），要么用 `rAF`/`gl.finish()` 量一个看不见 fragment 的成本（后两个） |
| `archive/dome-cloud-era/layers/` (6) | 穹顶云的分层拆解 A~F | dome 已删除 |
| `archive/dome-cloud-era/baseline/` (4) | 穹顶时代的 alt60 基线帧 | 同上 |
| `archive/dome-cloud-era/docs-qa/` (5) | 原 `docs/qa/`：`wisp-alt55` / `slab-alt200` / `clouds-alt60` 对比帧 | 同上。两份历史评审引用了它们，路径已同步改 |
| `archive/puff-shell-fusion/` (8) | **PARKED 线**：`shell-probe.mjs`（半径包络可行性探针）、`shell-bench.mjs`（25 朵壳生成耗时）、`shell-plot.py`（极坐标对比图）、4 组 `shell-curve-*.json`、1 张探针图 | 不是死的，是**停的**。海面重建优先，这条线让路 |

> 历史文档里仍写着 `artifacts/sea-audit/fbm-ab-*.png` 这类原路径 —— 那些是当时的记录，不再回改。
> 按文件名到 `artifacts/archive/` 下找同名文件即可。

### 不在库里（本地临时）

`artifacts/cloud-audit/live/` 被 `.gitignore` 排除，是现场抓帧的暂存区。
某些早期数字只在它里面可复核，删了就真没了 —— 想清磁盘先想清楚这一条。

---

## 5. 清理记录

### 2026-11-04

- 归档 45 帧死证据到 `artifacts/archive/`（见上表），**没有删除任何一帧**
- `docs/qa/` → `artifacts/archive/dome-cloud-era/docs-qa/`，两份引用它的评审已改路径
- 修正 `README.md`：原文还在描述 FFT 海 + 体积云，结构表里 5 个文件已不存在
- 修正 6 个模块里指向已删文件的注释（`palettes` / `sun-road` / `horizon` / `sky-webgpu` /
  `puff-cloud` / `main`）；`palettes.ts` / `sun-road.ts` / `horizon.ts` 里那些
  「无消费者但仍是契约」的值补了说明，免得下一个人当死代码删掉
- 修正 `plans/2026-11-04-stylized-sea.md` 里的幽灵引用：`artifacts/cloud-audit/tonemap_unfold.py`
  **从来不存在**，真工具是 `artifacts/ghibli-audit/solve-ramp.py`
- 顺手修正 3 处早就写错的文档路径：`puff-v5-hero.png`→`.jpg`、
  `fbm-readback-probe.mjs`→`.js`、`ref01-left-bank-zoom.png`→`ref/left_bank.png`

**没有**做的事，和原因：

- 没有删任何脚本。文档按路径点名调用它们（`python artifacts/cloud-audit/audit.py --parity`），
  删了就是 100 多处断链，换回来 156 KB
- 没有删任何文档。这是本仓库最贵的资产
- 没有删 `archive/`。证据换不来字节数，但要占注意力 —— 所以移出主路径而不是销毁

### 2026-11-04（二）shell 融合线归档

puff shell 融合的一整套（3 脚本 + 4 组曲线 + 1 张探针图）此前**从未提交**，是仓库里唯一有
丢失风险的部分。已全部移入 `artifacts/archive/puff-shell-fusion/` 并入库，状态标 **PARKED**
（不是放弃，是让路给海面重建）。

- 脚本按新位置改了三处路径，并实测仍可运行：
  `node .../shell-bench.mjs 10 0.75` → 25 朵、17.5 ms/朵；`python .../shell-plot.py` → 出图
- 两份文档留在 `docs/`（叙述层不搬进 `artifacts/`），状态改为 PARKED 并在此登记

### 2026-11-05 仪器断代：把量测工具和它量的实现对齐

海面从 FFT/FBM 换成 Gerstner 分带之后，`artifacts/sea-audit/` 里有一半仪器在给
**已经不存在的 shader** 做体检。做的处理：

- **四个死仪器归档**（`archive/sea-fft-fbm-era/`）：`fbm-readback-probe.js` /
  `fbm-diff-map.js`（`import('/src/sea-fft.ts')`，构建 404）、`eval-perf.js` → `eval-perf-rAF.js`
  （rAF 被 vsync 钉死）、`eval-perf-frozen.js` → `eval-perf-glfinish.js`
  （`WebGPURenderer` 没有 `getContext()`）
- **补一个活的**：`eval-perf-webgpu.js`，按 `fragment-cost-2026-11-05.md` 的冻结协议写
  （离屏 RT + 批量斜率 + 隐水对照；对照不过就自报「仪器瞎了」）
- **`band_continuity.py` 半删**：`--recompute` 整段（Phillips 谱 + `SEA_BAND_STOPS` 分带模型）
  连同它的常量一起删除，**只留 png 模式**。删改前后对同一张
  `skim-shaded-2026-11-05.png` 的输出**逐字节相同**，证明只切了死的那半
- **新增 `artifacts/sea-audit/README.md`**：逐文件判决表。之前 INDEX 写「重建直接复用
  `--recompute` 分带占比」是**错的**，那句正是会被误读的一句，已改指向该表

**没有**删任何脚本、任何帧、任何文档 —— 只搬家与改注释。

