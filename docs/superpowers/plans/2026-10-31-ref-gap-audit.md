# 参考图差距审计 + 补丁计划（2026-10-31）

**目标：** 把"当前画面离三张参考图还有多远"变成可复跑的数字，并把差距拆成能逐条验收的补丁项。

**范围：** 只做观感（颜色/明度/形体/构图）。不动玩法、不动后端双跑道、不动调色单源合约。

**状态：** 纯数值项（P2–P4）已可执行；结构性项（P5 云体量、P6 构图）**待与用户讨论后**再转成任务书。本文暂不作为任务书使用。

---

## Global Constraints

1. **调色单源**：颜色只改 `palettes.ts`；`SEA_PALETTE.haze == SKY_PALETTE.horizon` 的合约不许破（`palettes.ts:11-12, 67-71`）。
2. **双后端 TSL**：新 shader 一律 TSL `Fn`；`onBeforeCompile` 禁用；`forceWebGL` 跑道只保可玩不保效果。
3. **单输出所有者**：`outputColorTransform` 归管线，`BloomNode` 的 glow 必须 add 回场景色，`dof()` 返回成品不许再 add。
4. **每项改动跑满验证矩阵**（见文末），不许只看一个指标。
5. **重构不碰刚合入的四修**：`cloudLighting` 的色阶斜坡、`horizon` 的仰角读法、`dir.y` 符号、远场霾，均为已验收成果。

## Review Focus

1. **改一个颜色连带破地平线**：海上远场与天空地平线同色，抬任意一侧都会出现横向色带。
2. **ACES→Neutral 的回退**：低端机/旧驱动上高光不再滚降，可能出现硬切边（需在 `forceWebGL` 跑道目检）。
3. **抬暗部导致形体丢失**：云暗面抬高会把"体积感"压平，P3 要盯云的暗/亮分离度而不是只看 `dark_frac`。
4. **太阳路变宽后盖住波光**：`ROAD_FLOOR` 下调过多会让整片海变成一条亮带，失去"粼粼"。
5. **云体量放大后穿云穿帮**：slab 边界放大，`in-cloud` 的 DOM 白雾阈值与体积内雾感会不同步。

---

## 0. 已完成的改动（本次会话）

| 项 | 内容 | 验收 |
|---|---|---|
| P0 | **删除速度线**：删 `SPEED_LINES` / `speedLine01` / 极坐标 shader 段 / `uDive` / `setDive01` 及 5 条专测 | `tsc` 0；256 测试全过；`smoke ok`；实测 `streak_count` 22→14 |
| P1 | **tone mapping ACES → Neutral**（`renderer.ts:19`） | 天穹带 `sat_max` 0.298→**0.661**（参考 0.617）；`C*med` 12.0→17.9；`L*med` 67.5→57.7 |

P0 的附带收益：`grey_frac` 37.8%→**23.4%**，`C*med` 18.5→**22.4**。加法白线本身就在给整帧上白纱。

P1 的 A/B 口径：只比顶部 22% 的天穹带（云飘不到），两次截图为不同时刻，云位不同，故不做整帧对比。

---

## 1. 实测基线（三对，判据从这里来）

> **已作废（2026-10-31 晚）。** 下表是在 P0（删速度线）与 P1（ACES→Neutral）**之前**、且动画循环未冻结的情况下测的：云场每次刷新位置不同，相机朝向随飞行漂移，帧级指标摆动 2–4 倍。现行基线见
> `artifacts/cloud-audit/protocol/baseline-2026-10-31.json`（采集协议见 `2026-10-31-capture-protocol.md`）。
> 另注意：固定百分比分带（sky 0–30% / cloud 25–62% / sea 70–100%）只在**构图相近**的帧之间可比；
> 已实测 B-dive、C-bankdive 的海带里装的是天空/云（C 的海带均值 rgb(209,119,65)），这两对的海指标**不可引用**。


输入：`docs/superpowers/specs/assets/ref-0{1,2,3}-*.png` 对冻结帧 `artifacts/cloud-audit/protocol/`（场景↔参考↔抓帧的映射只在 `artifacts/cloud-audit/states.py` 定义一次）。现场帧 `live/` 不进仓库，对账只用协议帧。
量法：`artifacts/cloud-audit/ref_gap_three.py`（指标定义见 `ref_gap_measure.py` 顶部注释）。

| 指标 | ref-01/02/03 | 现场（P0、P1 之前） | 方向 |
|---|---|---|---|
| 中位彩度 C\* | 35.7 / 25.4 / 35.9 | 21.5 / 18.5 / 24.1 | 只剩 60–73% |
| 高彩度面积 C\*>35 | 52.0 / 34.9 / 53.1 % | 6.8 / 3.5 / 14.4 % | 少 4–15× |
| 近灰面积 C\*<15 | 8.1 / 9.3 / 9.6 % | 27.4 / 37.8 / 22.9 % | 多 3–4× |
| 近黑面积 L\*<12 | 0.6 / 2.2 / 0.5 % | 8.2 / 10.6 / 3.7 % | 多 4–14× |
| 天穹饱和峰值 | 0.611 / 0.658 / 0.533 | 0.318 / 0.343 / 0.372 | 约一半 |
| 海面平均明度 | 0.488 / 0.535 / 0.637 | 0.311 / 0.332 / 0.369 | 暗 35–45% |
| 太阳路 峰/中位 | 2.78 / 2.38 / 2.11 | 1.18 / 1.46 / 1.24 | 三对全无 |
| 云团相对面积（中位） | 0.231 / 0.053 / 0.024 | 0.036 / 0.011 / 0.011 | 小 2–6× |
| 径向线条数 | 8 / 9 / 10 | 15 / 22 / 19 | 密 2×（已随 P0 消除） |

**可比性限制（必须记着）：** 参考是横向 16:9，现场是竖屏 9:16。凡"占画面比例"类指标（`cloud_coverage`、`sunroad_width_frac`）受构图主导，**不用于判定**；只用彩度、明度、线条密度这类与构图无关的量。

---

## 2. 待办：纯数值可验证（可立即执行）

### Task A — 海面黑位（`palettes.ts`）

**证据：** `SEA_PALETTE.deep = 0x1a1a38` 实测 **L\* 10.9**，`mid = 0x3a3358` 为 L\* 23.6；参考画面近黑面积只有 0.5–2.2%，现为 3.7–10.6%。
**做法：** `deep` 抬到 L\*≈20–24 的紫（候选 `0x2e2450`），`mid` 同步提亮一档；`haze` 不动（合约）。
**验收：** `dark_frac ≤ 3%` 且 `sea_value_mean ≥ 0.45`，且地平线无横向色带（目检）。
**风险：** 海"深"的感觉变浅；需同时看云的暗/亮分离度。

### Task B — 天穹亮度/彩度（`horizon.ts` + `SKY_STOPS`）

**证据：** 天穹带 `L*med 57.7` 对参考 45.3（过亮），`C*med 17.9` 对 45.2。调色板本身够饱和（`#6b4fa1` C\*50.5、`#ff9a5a` C\*58.6），是叠加层在洗。
**做法：** 压 `horizon.ts` 的 haze 叠加项与顶部 stop 的亮度，让天穹落在 L\*≈45、C\*≥35。
**验收：** 天穹带 `C*med ≥ 35`、`L*med 45±5`。
**风险：** 与海的远场霾共用 `HAZE_COLOR`，两侧必须一起看。

### Task C — 太阳路（`sun-road.ts` + `sea-fft.ts`）

**证据：** 现参数 `WIDTH_DEG 25 / ROAD_FLOOR 0.35 / NARROW 96 / BROAD 26`，实测 `sunroad_ratio` 只有 1.18–1.46，且 `sunroad_width_frac = 0`（没有任何一列超过 1.35× 中位）。设计意图是"只削窄不抬峰"，结果削完之后没有峰。
**做法：** road 内让低频斜率项（`BROAD`）主导形成连续亮带，road 外保留高 exponent 的碎钻；峰增益以 `ratio ≥ 2.2` 反推。
**验收：** `sunroad_ratio ≥ 2.2` 且 `sea_sparkle_rel ≤ 0.15`（巡航近景）。
**风险：** 峰一抬就碰 bloom 阈值，需同步看 `post.ts` 的 bloom 参数。

---

## 3. 待讨论：结构性（不转任务书前不动手）

### P5 — 云团体量

**证据：** 单团相对面积 0.036 对参考 0.231（差 4.5–6×），团数 5 对 3，`cloud_value_mean` 0.386–0.410 对 0.563。
**现状参数：** `CLOUD_BAND 95..480`、`CLOUD_STEPS_HIGH 12 / LOW 8`、`CLOUD_STEP_ALPHA 0.3`、`CLOUD_TOON_STEPS 4`、`CLOUD_PROFILE base .92 / waist .45 / topBias 1.6`、`CLOUD_NOISE_SCALE 0.0065`。
**为什么待讨论：** 放大体量会同时改变团数、粘边、穿云体验与 `in-cloud` 白雾阈值，是外观与玩法的交叉决策，不是调参。
**候选验收：** `blob_area_frac_median ≥ 0.12`、`blobs ≤ 4`。

### P6 — 构图

**证据：** 参考中飞机占画面高度 25–40%，现场约 4%（**目视估计，未测量**，当前脚本无法自动抠图）。
**为什么待讨论：** 参考是横向影视构图，项目是竖屏玩法；"抄不抄"是产品决策而非工程任务。

---

## 4. 不做

- 不做 time-of-day（太阳静态，`SUN_POSITION` 单源）。
- 不换渲染后端，不引入 GLSL `ShaderMaterial`。
- 不为了对齐参考图改 HUD/字幕版式。
- 不重做刚验收的四修。

## 5. 验证矩阵（每项必跑）

1. `npx tsc --noEmit`
2. `npx vitest run`
3. `node scripts/smoke.mjs`
4. `python artifacts/cloud-audit/audit.py --parity` — 三对指标、评分卡、云/海噪波、天穹带全在一张表里；末行必须是 `PASS`（102 个钉值对 `protocol/baseline-content-anchored.json` 零漂移，漂了即 exit 1）
5. 目检：地平线无横向带、云暗部没被抬平、太阳路不是一个整条
6. `forceWebGL`（`?backend=webgl2`）跑道目检，尤其 P1 的高光滚降

## 6. 复跑

```powershell
npm run dev                                     # 5174
python artifacts/cloud-audit/audit.py --parity  # 一张全表 + 对账门
```

现场帧重抓：`artifacts/cloud-audit/live/`（该目录不进仓库，只有 `protocol/` 下的冻结帧在库；cruise = `?alt=60` 等 12s；dive = `?alt=200` 向下拖 40px；bankdive = `?alt=220` 左拖 95px + 下拖 40px）。
