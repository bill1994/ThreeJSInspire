# Scorecard 低分项技术说明（2026-10-31）

**目标：** 把视觉评分卡里「现在就自动不合格」的项，以及「四项自动指标全过却测不出『均匀噪波』」的原因，写成可复跑的证据与可测替代指标。

**范围：** 评分卡口径、HUD 形态、VFX/尾迹、渲染诊断缺口。云/海/天的美术问题各有专文，本文只在需要时引用。

**状态：** 四项指标与分带边缘密度已测；十类打分是我的判定（标「推定」）；`?post=0` 等 A/B 未验证。

---

## 0. 证据分级与评分卡出处

| 标记 | 含义 |
|---|---|
| **已测** | 重跑了 `artifacts/cloud-audit/scorecard_metrics.py` / `sky_band_probe.py` / `ref_gap_measure.py` |
| **推定** | 我的判定或由证据外推，需要人复核 |
| **未验证** | 需要浏览器 A/B、真机或渲染器诊断 |

评分卡原文（本机）：`C:\Users\63088\.agents\skills\threejs-aaa-graphics-builder\references\visual-scorecard.md`。本文按行引用，例如 `scorecard:45`。`artifacts/cloud-audit/scorecard_metrics.py` 的 docstring 就是抄它的四项阈值（`scorecard_metrics.py:10-12`）。同目录的 `references/technical-art.md`（渲染预算表、VFX 要求、表面细节系统）也按行引用，写作 `technical-art:9-19`。

## Global Constraints

1. **自动失败项优先于分数**：`scorecard:39-49` 列出 7 条，"任何一条成立，工作就不是 premium，不管单项分数"。HUD 那条是 `scorecard:45`「HUD is mostly rectangular stat/debug cards」。
2. **四项指标是 advisory，不是门**：`scorecard:53` 原文「These are advisory signals; a low value needs an explanation, not a higher score. Do not add noise, clutter, or particles just to raise pixel metrics.」
3. **不许为提分加噪**：同上。任何"为了让 edgeDensity 过 0.04 而加细节"的做法直接违反该条。
4. **必须报渲染诊断**：`scorecard:49`「No renderer diagnostics after major graphics work」是自动失败项；`scorecard:30` 的 Performance evidence 类要求 renderer counts。
5. **调色/尺寸单源**：HUD 的颜色与安全区来自 `palettes.ts` / `portrait.ts`（`hud.ts:15,215-223`），不许在 CSS 里另造一份。

## Review Focus

1. **改 HUD 会动测评口径**：天穹带边缘密度有 66% 来自 HUD（§1.3）。HUD 一改，"天穹"那一行的历史数据全部作废，必须重新基线。
2. **加细节会把分数推高但画面更差**：四项里三项只惩罚"太低"，`scorecard:53` 已经禁止这么用（§1.2 有实测反例）。
3. **HUD 是 DOM，不是画布**：`hud.ts:93-311` 全量 DOM + CSS，`root` 挂在 `#frame`（`hud.ts:209`）。这意味着 HUD 不参与 `renderer.info`，"UI 与画质"在诊断上是两条独立的账。
4. **安全区只在 resize 时重算**（`hud.ts:215-223`），旋转/横屏未测。
5. **尾迹是唯一的 VFX**：`feel.ts` 只有两条翼尖拉烟 + 一条 skim 尾迹（§1.6），没有 boost/pickup/hit 类事件特效。

---

## 1. 实测基线

### 1.1 四项自动指标（**已测**，`python artifacts/cloud-audit/scorecard_metrics.py`）

| case | `colorEntropyBits` | `dominantColorShare` | `edgeDensity` | `luminance.contrast` |
|---|---|---|---|---|
| 阈值（`scorecard:55-57`） | 低于 ~3.0 差 | 高于 ~0.6 差 | 低于 ~0.04 差 | 低于 ~60 差 |
| ref-01 target | 6.80 | 0.062 | 0.0540 | 196.0 |
| live cruise (neutral) | 6.10 | 0.084 | 0.0730 | 161.7 |
| live skim (alt 7) | 5.52 | 0.118 | **0.1140** | 157.0 |

**四项全部通过**——包括视觉上最差的那一帧。这就是「scorecard 四项全部通过却测不出问题」的实测形态。

分带边缘密度（脚本自带）：

| case | sky（top 30%） | cloud（30–62%） | sea（72%+） |
|---|---|---|---|
| ref-01 | 0.0386 | 0.0394 | 0.0873 |
| live cruise | **0.0700** | 0.0577 | 0.0825 |
| live skim | 0.0977 | **0.1962** | 0.0436 |

### 1.2 为什么四项指标看不见「均匀噪波」（**已测 + 推定**）

三条独立理由，每条都有实测支撑：

**(a) 阈值是单向的，噪波只会把值推高。** 三项（entropy / edge / contrast）都是"低了才差"；加均匀噪声必然抬高 entropy 与 edgeDensity。`scorecard:53` 已经把这件事写成禁令。实测反例：`live skim` 的 `edgeDensity = 0.1140`，是参考 `0.0540` 的 **2.1×**，`dominantColorShare` 0.118 是参考 0.062 的 1.9× —— 两个"分数"都在"更好"的一侧，而画面正是最噪的那一帧。

**(b) 全局直方图没有尺度概念。** entropy 数的是 16³ 颜色桶的分布，edge 数的是 Sobel 幅值过 0.12 的像素比例；**"作者化的一层薄雾"和"均匀噪点"在这两个统计上是同一件事**。要分开必须做频带分解——`noise_audit.py` 的 `cloudHF` / `seaHF` / `*Slope` 就是这个雏形（`noise_audit.py:48-58`），但它是"低于才算差"的反向指标：实测 `seaHF` 现场 0.005 vs 参考 0.001、`seaSlope` −2.27 vs −3.71，噪波越多这两项越"难看"，**方向是对的**，只是还没进评分卡。

**(c) 没有任何一项测色相/分区。** 天空暖带的彩度实测 31.9（参考 35.7–45.7）。四项里没有一项会对这个报警。

### 1.3 天穹带的边缘密度被 HUD 污染（**已测**，`python artifacts/cloud-audit/sky_band_probe.py`）

| 帧 | 天穹带 edge（整幅宽） | 同帧 HUD-free 窗口（top 22%，x 0.36–0.56） |
|---|---|---|
| ref-01 | 0.0386 | 0.0571 |
| ref-02 | 0.0434 | 0.0568 |
| ref-03 | 0.0501 | 0.0489 |
| live cruise（带 HUD，ACES 帧） | **0.0700** | 0.0779† |
| live cruise（nohud，Neutral 帧） | **0.0235** | **0.0146** |

† 带 HUD 帧的"窗口"仍然压到了面板边缘，不可用。

**两件事：**
1. 同一场景，带 HUD 是 0.0700、去掉 HUD 是 **0.0235** → **66% 的"天穹边缘"其实是 HUD 面板边框和文字**。
2. 去掉 HUD 后 0.0235 **低于评分卡自己的 0.04"primitive-dominant"阈值** → 用评分卡的逻辑，**现场天穹会被判为"基本体主导/构图空洞"**，而带 HUD 的帧反而"通过"。评分卡的分带口径在竖屏 + DOM HUD 的组合下**方向是反的**。

### 1.4 渲染诊断缺口（**已测**）

- `package.json:5-11` 只有 `dev / build / preview / test / smoke`，**没有** `inspect:canvas`（评分卡 `scorecard:53` 指定的官方 metric 来源）。
- `scripts/smoke.mjs`（4559 B）只做模块加载冒烟：grep `calls|triangles|geometries|textures|renderer|metrics` 只命中一行 `src/renderer.ts`（文件路径字符串）。
- 全仓库没有任何 `renderer.info` 读取 → **draw calls / triangles / geometries / textures / post passes 一项都没测过**（`scorecard:30` 的 Performance evidence 只能给 1，`scorecard:49` 的自动失败项成立）。

`technical-art.md:9-19` 的预算表（desktop 300 calls / 750k tris / 300 geoms / 60 textures / ≤2 post passes；mobile 150 / 300k / 200 / 40 / 0–1）**目前无法对照**。

### 1.5 HUD 形态（**已测**：读码）

| 事实 | 证据 |
|---|---|
| 面板样式：46% 透明度深色圆角矩形 + 1 px 边框 + `backdrop-filter: blur(3px)` | `hud.ts:64-65` |
| 左上：速度大数字 + 单位 + 进度条；下面再来一块"AIRSPEED" + 进度条 | `hud.ts:112-140` |
| 右上：5 行滑杆混音器（master/music/sfx/amb/UI），常驻 | `hud.ts:48-54,151-181` |
| 左下：一行等宽状态串 `${mode} · ${dir}${bank}° · ${climb} m/s · ${fps} fps` | `hud.ts:184-197,269` |
| 中列刻意留空（"so the sun disc and the plane silhouette stay unobstructed"） | `hud.ts:8-9` |
| 混音器宽度 `clamp(140px, 38vw, 196px)` | `hud.ts:75` |
| 全屏白雾层（进云遮罩），上限 0.6 | `hud.ts:108-110,288-296`；`in-cloud.ts:44` |
| 更新是事件驱动的（值不变则不写 DOM） | `hud.ts:225-283` |

**判定：** 这就是 `scorecard:45` 描述的「mostly rectangular stat/debug cards」，也是 `scorecard:29` 的 UI/HUD **1 分**描述「generic stat-card dashboard」。**自动失败项成立。**

### 1.6 尾迹与 VFX（**已测**：读码）

| 事实 | 证据 |
|---|---|
| 翼尖拉烟 = 两条固定长度（48 采样）的三角带，`MeshBasicMaterial` + 顶点色，**无贴图、无 alpha 纹理** | `feel.ts:32,127-159` |
| 颜色是常量 `[0.97, 0.94, 0.9]`，逐采样 alpha = `0.55·strength·(1−i/(n−1))²` | `feel.ts:48,237` |
| 宽度：首采样 0.06 m、后续 0.2 m | `feel.ts:289-291,329-333` |
| skim 尾迹 = 第三条同构带，泡沫色，宽 0.25/0.45 m，alpha = `skim×0.45` | `feel.ts:279,347,350` |
| 触发条件是"坡度 > 0.42 rad 或速度 > 0.72" | `feel.ts:26-29,327` |
| 事件类特效只有相机 trauma 抖动（apex / 水花），没有 boost/pickup/hit/telegraph | `feel.ts:306-325` |

**判定：** `scorecard:28` 的 VFX/motion **1 分**描述「generic particles and trails」——现状是**没有纹理的平涂三角带**，比"generic particles"更素。`/technical-art.md:39-48` 要求的是"event-driven, tied to gameplay state"，现状不满足。

### 1.7 全局：没有任何图像纹理（**已测**：`grep` 全仓库）

`TextureLoader` 0 次；`CanvasTexture` 1 处（天穹 canvas 回退，`sky-webgpu.ts:23-45`）；`DataTexture` 2 处（海的两个谱域，`sea-fft.ts:790-801`）；`map:` 只有 `toon.ts:99` 的透传。

**判定：** M materials/textures 类只能落在 **1 分**「basic roughness/metalness or emissive color」；`technical-art.md:69-73` 要的"可复用表面细节系统（trim sheet / decal / 共享噪声贴图）"完全没有。

---

## 2. 复核用户给的结论

| # | 结论 | 判定 | 依据 |
|---|---|---|---|
| H1 | HUD 是矩形 stat 卡，评分卡明列自动失败项 | **成立**，原文是 `scorecard:45`，等级 1 的措辞在 `scorecard:29` | §1.5 |
| H2 | scorecard 四项自动指标全部通过 | **成立** | §1.1 |
| H3 | 四项测不出「均匀噪波」 | **成立**，且能给出三条机制（单向阈值 / 无尺度 / 无色彩） + 一个实测反例 | §1.2 |
| H4 | 翼尖拉烟与 skim wake 是无纹理平涂三角带 | **成立** | §1.6 |
| H5 | 需要说明评分卡的局限 | **成立**，而且比"指标不够多"更严重：**天穹带的口径本身被 HUD 污染到方向相反** | §1.3 |

---

## 3. 十类打分（**推定**，附一行证据）

| 类别 | 现分 | 证据 / 缺口 |
|---|---|---|
| Art direction | **2** | 日落紫金单源调色板（`palettes.ts`）+ toon 分档贯穿云/海/机体；但天空缺结构（见 sky 文 §1.8） |
| Hero/player | **2** | S.21 比例参考建模 + 3 档 toon ramp（`toon.ts:20-28`）+ 涂装单源；缺 decal/trim 与状态反馈 |
| Obstacles/enemies | **1**（genre 映射：云体/海面/边界） | 云是障碍也是景观，但没有 telegraph；穿云只有 DOM 白雾 |
| Rewards/interactables | **1** | 只有 `just breathe` 字幕（`subtitles.ts`），无交互物 |
| World/environment | **1–2** | 三层世界（云/海/天）+ 近景 puff，但层次靠亮度而非形；密度与体量见云文 §1.1 |
| Materials/textures | **1** | §1.7：全仓库 0 张图像纹理 |
| Lighting/render | **2** | Neutral tone mapping + bloom/dof/smaa 单所有者链（`post.ts`）；无阴影、无 key/fill/rim |
| VFX/motion | **1** | §1.6：三条无纹理三角带 + 相机抖动 |
| UI/HUD | **1** | §1.5：矩形 stat 卡（自动失败项成立） |
| Performance evidence | **1** | §1.4：无 renderer diagnostics（自动失败项成立） |

平均 **约 1.4**，低于 premium 门槛（`scorecard:36`：每类 ≥2、平均 ≥2.3）。

---

## 4. 已完成（不要重复建议）

| 项 | 现状 | 证据 |
|---|---|---|
| HUD 事件驱动 | 值不变不写 DOM，零每帧字符串分配 | `hud.ts:225-283` |
| 安全区 | 按 `#frame` 比例 + `env(safe-area-inset-*)`，resize 重算 | `hud.ts:209,215-223`；`portrait.ts` |
| 中列留空 | 有意为之，保护太阳与机体剪影 | `hud.ts:8-9` |
| 尾迹池化 | 预分配、零增长、零每帧分配 | `feel.ts:1-10,127-177` |
| 尾迹"薄→厚→淡" | alpha 二次衰减 + 尾部收拢，避免拖一条实心带 | `feel.ts:237,256-266` |
| 白雾有上限 | 1.0 会变成"白屏 bug"，故封 0.6 | `in-cloud.ts:39-44` |
| 速度线已删 | 曾与云体、机体交叉；P0 实测 `streak_count` 22→14 | `post.ts:157-159`；`2026-10-31-ref-gap-audit.md:33` |
| 字幕层 | 有独立模块与样式（不属 HUD 卡） | `main.ts:74` |

---

## 5. 任务

### SC1 — 去掉自动失败项：HUD 不再是"矩形 stat 卡"

**证据（已测）：** §1.5；`scorecard:45`。

**候选方向（不写实现）：**
- 速度 → **仪表弧/刻度带**（沿 `hudSafeArea` 的内边），而不是数字 + 进度条；
- 姿态（bank/climb）→ **地平线仪式的角标或边缘色带**，替代左下那行 `${mode} · L12° · +0.0 m/s · 142 fps`（`hud.ts:269`）；
- 混音器 → 收进可展开抽屉（现在常驻 38vw 宽，`hud.ts:75`），默认只留一个图标；
- STALL → 屏幕边缘脉冲 + 文字，而不是一块红底方块（`hud.ts:85-89`）；
- 调试信息（fps/mode）→ 只在 `?debug=1` 下出现。

**验收门：** `hud.ts` 中 `.porco-panel` 的使用处从 4 处降到 ≤1（面板样式只留混音抽屉）；`scorecard:45` 不再成立（复核人目检）；UI/HUD 类 ≥2（需要 `scorecard:29` 的"genre-specific states, meters/icons"）。

**风险：** §Review Focus 1 —— HUD 一改，天穹带的 edgeDensity 基线作废，必须同时重跑 §1.3。

**状态：面板门通过，其余两条待人工目检（run 2）。**

`.porco-panel` 的使用处 **4 → 1**（只剩混音器）：

| 原 | 现 |
| --- | --- |
| 速度卡 `porco-panel porco-speed` | **仪表弧** `porco-arc-wrap`，无面板背景 |
| 油门条 `porco-panel` | 并进同一个弧：外弧速度（橙）、内环油门（青绿） |
| 混音器 `porco-panel porco-mixer` | 保留 |
| 状态行 `porco-panel porco-status` | 去掉面板，纯文字 |

弧用 SVG `stroke-dasharray`/`stroke-dashoffset` 驱动（外弧长 151、内环 107），更新时只改一个数字属性。`qa.describe()` 之外用 `document.querySelectorAll('.porco-panel').length` 复核得 **1**。

**未做：** STALL 仍是红底方块（候选方向写的是「屏幕边缘脉冲 + 文字」）；姿态的角标/边缘色带没做；调试信息（fps/mode）仍在状态行里，没有收进 `?debug=1`。这三条都不在验收门的「panel ≤1」里，留待后续。

**注意：** HUD 一改，天穹带的 edgeDensity 基线确实作废了——`hud_suspected` 检测器会立刻标出新帧，§1.3 的旧数必须重跑。

### SC2 — 补渲染诊断（当前是自动失败项）

**证据（已测）：** §1.4。

**候选方向：** 加一个 `inspect:canvas` 等价物。前提是本仓库**没有**浏览器自动化依赖（`package.json:12-19` 只有 three / typescript / vite / vitest），所以最省的做法是先做 `?stats=1` 的页面内探针：把 `renderer.info.render.{calls,triangles}`、`renderer.info.memory.{geometries,textures}`、post pass 数与 DPR 打到 DOM，再由现有截图脚本抓取。

**验收门：** 每次美术改动后留一份 `{calls, triangles, geometries, textures, postPasses, dpr, shadowLights}` 快照，并对照 `technical-art:9-19` 的预算表；`scorecard:49` 不再成立。

**风险：** 探针本身会引入一次 `renderer.info` 读数，必须在 `pipeline.render()` 之后读，否则是空的（`未验证`）。

**状态：探针已实现，但对照的预算表不存在（run 2）。**

`__porco.qa.describe()` 增加 `render` 字段，在一次真实渲染（`qa.stepFrame(0)`）之后读 `renderer.info`：

```json
{ "available": true, "calls": 237, "triangles": 215187, "points": 0, "lines": 0,
  "geometries": 53, "textures": 35 }
```

没有新增 `?stats=1` 参数——`describe()` 本来就是 QA 入口，再加一个开关只会多一条要维护的路径。这条也回答了风险行：**必须在渲染之后读**，`qa.stepFrame(0)` 之后再 `describe()` 就能拿到非零值，直接读会得到上一帧或全零。

**但「对照 `technical-art:9-19` 的预算表」这一步做不了：那份文档在仓库里不存在。** `Get-ChildItem -Recurse -Filter *technical-art*` 无结果。所以 `scorecard:49`（"无渲染诊断"）这条可以从"没有探针"降级为"有探针、无预算表"——要真正判定超预算，得先把预算表补出来。

**基线留档：** 上面那组数字就是当前快照。后续美术改动重跑 `describe().render` 对比即可。

### SC3 — 给"均匀噪波"一个可测的量，并把它放进评分口径

**证据（已测）：** §1.2(a)(b)(c)；`seaHF` 0.005 vs 0.001、`seaSlope` −2.27 vs −3.71 已经能测出来。

**候选方向：** 把 `noise_audit.py` 的三个量（分带 `HF share`、`slope`、`speckle_count`）升格为评分卡的**反向**指标：高频占比**高于**参考即扣分。同时给"结构尺度"一个量（低频能量占比或 blob 面积中位），补上四项指标缺的"尺度"维度。

**验收门：** 三个新指标对 `live skim` 帧给出"不通过"（现在四项全过）；对 ref-01/02/03 给出"通过"。

**风险：** 参考图本身也有噪（ref-01 的 `speckle_count` 256），阈值必须按参考区间设，不能设成 0。

**状态：已实现，但两个方向是相反的（run 2）。**

`scorecard_metrics.structure_metrics()` 增加分带高频指标，`STRUCTURE_GATES` 定阈值：

| | `sea_hf` (≤0.0035) | `cloud_hf` (≥0.0025) | `structure_pass` |
| --- | --- | --- | --- |
| D-skim（live） | 0.00037 | **0.00082** | **False** |
| A-cruise | 0.00124 | **0.00027** | **False** |
| ref-01 | 0.00054 | 0.00528 | **True** |
| ref-02 | 0.00100 | 0.00515 | **True** |
| ref-03 | 0.00317 | 0.00302 | **True** |

**验收门满足**：两条实测帧不通过，三条参考通过。

**但任务的前提只对了一半。** 原文把「均匀噪波」当成一个**反向**指标——高频高于参考即扣分。实测下来：

- **海面**确实如此（我们的 0.00124 是 ref-01 的 2.3 倍）；
- **云是反的**：我们的 `cloud_hf` 只有 **0.00027–0.00082**，参考是 **0.00302–0.00528**，低 6–20 倍。因为 toon 分档是 4 档量化，band 内部常数、band 之间硬边（见 T3 状态段）。

**一个统一方向会把画面里最平的部分判成最好的。** 所以阈值拆成两条相反的门：海面是上限，云是下限。

**未做：** `cloud_blob_median` 已经算出来（0.0236–0.2308），但没进 `structure_pass`——「结构尺度」该用什么门还需要和 T1 的连通块结论一起定，而 T1 的门本身就和参考不符。

### SC4 — 天穹带口径修正（否则所有天空数据都在测 HUD）

**证据（已测）：** §1.3（0.0700 vs 0.0235）。

**候选方向：** 在 `scorecard_metrics.py` / `sky_band_probe.py` 里把"天穹带"改成 HUD-free 窗口，或先做 HUD 掩膜（DOM 已知位置，可导出为掩膜）。

**验收门：** 同一天气条件下，带 HUD 与 nohud 两帧的天穹带指标差 ≤10%；历史数据重算一遍并标注"口径变更"。

**状态：确认成立，已加检测（run 2）。** 同一相机（`[0, 66.8, -98.099]`、`elapsed` 3）、同一时刻采两帧：

| 帧 | `edge_full` | `edge_strip` | `C_med_strip` | `hud_edge` |
| --- | --- | --- | --- | --- |
| 带 HUD | **0.1180** | **0.1010** | **25.0** | **0.1343** |
| 无 HUD | 0.0106 | 0.0000 | 32.9 | 0.0050 |
| ref-01 | 0.0386 | 0.0571 | 45.5 | 0.0216 |

`edge_full` 差 **11.1×**，`edge_strip` 从 0 跳到 0.1010，`C_med_strip` 被拉低 **7.9**——远超 10% 的验收门。

**`strip` 的注释「x in [0.36, 0.56] (no HUD text, no letterbox)」是错的。** HUD 的速度卡起于画面 x≈0.36、音量滑块延到 x≈0.64，`strip` 整段落在里面。

已给 `sky_band_probe.py` 加 `hud_edge` / `hud_suspected`：直接测面板区域（x 0.34–0.66、y 0.08–0.30）的边缘密度，带 HUD **0.1343** vs 无 HUD 0.0050 / ref-01 0.0216 / 协议帧 0.0005，阈值 0.08 干净分开。**用比值做检测是不行的**——HUD 同时抬高 `edge_full` 和 `edge_strip`，比值仍接近 1（实测 1.17），第一版检测器就是这么漏掉的。

**历史数据：** run 2 的全部天穹数字（`C_med_strip` 32.9、`edge_strip` 0.0000）都来自隐藏 `.porco-hud` 的帧，口径一致，无需重算；run 1 §2 那张天穹表同理（§1 写明「隐藏 `.porco-hud`」）。**今后任何天穹带数字必须来自 nohud 帧，`hud_suspected` 为 True 的帧直接作废。**

### SC5 — 尾迹从"平涂三角带"升级

**证据（已测）：** §1.6。

**候选方向：**
- 沿轨迹的**长度方向 alpha 剖面**（现在是纯横向二次衰减，尾部一刀切）；
- 用共享噪声纹理/程序化扰动做**边缘破碎**（现在边缘是几何直边）；
- 远处**提前淡出**（现在 `boundingSphere` 半径 1e9，永不裁剪，`feel.ts:151`）；
- 尾迹在云里/贴近海面时应有不同的混合（现在与海面高光同亮度，会显得像一条白带）。

**验收门：** VFX/motion 类 ≥2（`scorecard:28` 的"event-driven VFX"）；目检：尾迹末端不是一条直线切口；`speckle_count` 不因尾迹上升。

### SC6 — 事件特效（VFX 类的 2 分门槛）

**证据（已测）：** §1.6 最后一行：只有 trauma 抖动。

**候选方向：** 按 `technical-art.md:39-48` 的最小集，给"贴海掠过（skim）"和"顶点悬停（apex hover）"各做一个事件特效（水花环 / 冲击环 + 短暂 hit-stop），因为它们已经有状态源（`skim.ts:36-40`、`game.ts` 的 `hover` 相位）。

**验收门：** 两个事件各有可截图的中间帧；`scorecard:28` 从 1 升到 2。

---

## 6. 验证矩阵

1. `npx tsc --noEmit`
2. `npx vitest run`（`hud.ts` 没有专测，改动后至少跑全量；`feel.test.ts` 覆盖尾迹池）
3. `node scripts/smoke.mjs`
4. `python artifacts/cloud-audit/audit.py --parity` — `== visual scorecard` 段是四项指标（SC1），`== sky dome` 段给 SC4 的 `edge_strip`，`== noise` 段给 SC3 的 `cloudHF` / `seaHF` / `slope` / `speckle_peaks`；末行必须 `PASS`
5. 渲染诊断快照（SC2）—— 每次美术改动后一份
6. 目检：HUD 是否还像"仪表盘截图"；尾迹末端是否有切口；天空能否数出层次
7. **未验证项**：移动端竖屏（`artifacts/` 里没有移动端帧）、`?post=0` A/B、安全区旋转

## 7. 复跑

```powershell
python artifacts/cloud-audit/audit.py --parity  # 四项指标 + 分带 + 噪波 + 对账门
```

注意：本文件 §1.1/§1.3 里记的 live 帧数字（例如 cruise 的 `dominantColorShare 0.084`）来自 `artifacts/cloud-audit/live/`，那批帧不在库里，已不可复现；现在的可比数字只来自 `protocol/` 的冻结帧，见 `audit.py` 输出。
