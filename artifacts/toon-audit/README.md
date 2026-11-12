# toon-audit — toon-look Phase 1 标定与 A/B 证据目录

toon-look-toggle Phase 1（plan: `docs/superpowers/plans/2026-11-12-toon-look-toggle-phase1.md`,
spec: `docs/superpowers/specs/2026-11-12-toon-look-toggle-design.md`）的采集帧、标定数据与量具脚本。
各 Task 的证据目录（`task2-*` / `task3-*` / `task4-*` / `ab-evidence-task*`）由对应任务的
capture/analyze 脚本生成，协议细节见各脚本头部注释。

---

## banding_flips toon 口径留痕（DOME-02 三要素，spec T6）

> **改判记录（谁批、改哪条、何时，三要素齐全——DOME-02 的教训照办）：**
>
> | 要素 | 内容 |
> |---|---|
> | **改哪条** | `banding_flips`（banding 像素翻转门）在 **toon 模式采集帧上不作验收门**。toon 模式下色带（posterize 阶梯）**是特性本身**，banding 门把特性当缺陷判负，语义失效。toon 采集改用 **`band_count`（列 plateau 计数）+ 目检** 判档位结构是否成立（门 2 的「banding_flips 按新口径解读」即此）。 |
> | **谁批** | 设计稿 T6 已批（主人 2026-11-12 定稿，DOME-02 三要素格式）。 |
> | **何时** | 2026-11-12。 |
>
> 注意范围：本改判**只覆盖 toon=1 的采集帧**。非 toon 帧的 banding 门语义不变；
> `uToon=0` 逐位不变门（验收门 1）不受影响。

## 量具指针表（Task 6 三区门选型必读）

**选错量具 = 量具对区域物理系统性低读。** Task 3 已实测：体积云是射线多样本累积，
逐像素的 posterize 平台被重新混合，**Task 2 的 `band_count`（列 plateau 计数）对 dome
区域系统性低读**（首跑实测 toon1 plateau 数反而低于 control，见
`task-3-report.md` 发现 1）。按区域选：

| 区域 | 量具 | 脚本 / 证据 |
|---|---|---|
| **sky / sea**（`skyColorTsl` 出口直射可见面） | 列剖面（column profile）+ `band_count` + 目检；对照列的 band_count 非零是已知读数（参考 ramp 本身 piecewise-flat），判别性证据是**剖面形态**（对照连续渐变 vs toon1 平坦锚级） | `analyze-band-count.mjs`；`ab-evidence-task2/band-profile.json` |
| **dome**（体积云，射线多样本累积） | **归因占比（attribution）+ 梯度分布（gradient）+ 阶梯剖面（profile）+ 目检 四件套**，不用 `band_count` | `analyze-task3-dome.mjs`（量具语义写死在头部）；`ab-evidence-task3/band-profile.json` |
| **cloud 调色层**（`applyToonLook` cloudBands/cloudHaze） | Task 4 沿用 dome 四件套口径 + A/B 帧（Task 6 已补采，见 matrix/） | `ab-evidence-task4/`、`task4-*` 采集；Task 6 四件套 → `ab-evidence-task6/band-profile.json` |

## bloom 预算 toon 行（spec T7，量具先行）

预算门在两处钉死（改任一轨道/出口参数后必须重跑）：

- 测试：`src/sky-color-js.test.ts` 的 `bloom 预算 — 每档峰值（JS 镜像钉值）` describe，
  toon it：`toonAmount=1` 非盘区峰值 < 该档 `bloomThreshold`（0.82）at EVERY budget key。
- 预算表注释：`src/post.ts` Desktop budget 块（含 2026-11-13 toon 行数值段）。

数学依据：出口档位化后输出亮度恒落锚点集 `TOON_STEPS`（最大 0.75 < 0.82），预算封顶；
测试钉的是「任何后续调参不得破坏该封顶」。

## 标定数据

- `steps.json` — Task 2 锚值标定（2952 方向网格，出口空间线性亮度，in-page import 源码，
  零重实现）。锚值 [0.02, 0.08, 0.18, 0.32, 0.52, 0.75] 与量化映射证据，常数落在
  `src/toon-look.ts`（标定产物，改动必须回本目录重标）。
- `calibrate-steps.mjs` / `capture-*.mjs` / `analyze-*.mjs` — 采集与分析脚本
  （headed Chrome CDP 127.0.0.1:9222 + dev server [::1]:5173，协议见各脚本头）。
