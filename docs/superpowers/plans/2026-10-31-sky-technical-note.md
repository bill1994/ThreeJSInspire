# 天空技术说明（2026-10-31）

**目标：** 把「天空过平、被洗过」拆成可复跑的数值与代码位置，并**纠正三条与代码不符的既有结论**（stop 数、太阳盘、bloom 归属）。

**范围：** 只覆盖天穹 ramp、太阳光晕、天穹的结构与明度跨度，以及后处理对天穹的**实际**作用域。云见 `2026-10-31-clouds-technical-note.md`，海面见 `2026-10-31-sea-technical-note.md`，HUD/评分卡见 `2026-10-31-scorecard-gaps-technical-note.md`。

**状态：** 帧级指标已测；ramp 与光晕的代数推到线性值（推算）；bloom/DOF 的归属用 three 源码算到阈值与半径，但没有 A/B 帧（未验证）。

---

## 0. 证据分级

| 标记 | 含义 |
|---|---|
| **已测** | 重跑了 `artifacts/cloud-audit/{sky_band_probe,color_sample,ref_gap_measure}.py` |
| **推算** | 由 `palettes.ts` / `sky-webgpu.ts` / `renderer.ts` 的常量与 three 的 tone-map、bloom、DOF 公式直接推出 |
| **未验证** | 需要浏览器 A/B（`?post=0`）或多帧序列 |

**关键口径：** `sky_sat_mean` / `C*med` 若在**整条天穹带**上取中位，会把紫云一起平均进去，所得不是"天空"，而是"云+天空"。因此本文另给 **warm sky**：top 30% 内 hue 5–70°、s>0.10、v>0.45 的像素（即日落带本身），见 `color_sample.py`。凡"天空彩度"一律指这一列。

## Global Constraints

1. **调色单源**：`SKY_PALETTE` + `SKY_STOPS`（`src/palettes.ts:35-62`）；`HAZE_COLOR = SKY_PALETTE.horizon`（71），且必须等于 `SEA_PALETTE.haze`（93-94）。
2. **两个渲染器共用一个 ramp**：TSL 穹顶（`sky-webgpu.ts:77-81`）与 canvas 渐变（`sky-webgpu.ts:30-38`）都走 `SKY_STOPS`，但读的是**不同字段**（`at` vs `canvasY`，`palettes.ts:44-56`）。不许把两者强行统一。
3. **太阳单源**：`SUN_DIRECTION`（`palettes.ts:17,29-33`），朝向角 6.97°。
4. **单一输出所有者**：`pipeline.outputColorTransform` 归管线（`post.ts:6-13`）；tone mapping 是 `TONE_MAPPING.mode = 'neutral'`、exposure 1.0（`renderer.ts:18-21`）。
5. **天穹与海的接缝**：`SKY_BELOW_HORIZON` 只用于 canvas 回退（`palettes.ts:73-80`），穹顶在水线下必须保持 `horizon` 本身。
6. **不许在 `post.ts` 里给天空单独开 pass**：`post.ts:157-159` 已明确移除速度线，链上只有 bloom → dof → smaa。

## Review Focus

1. **抬暗部会碰海的地平线**：`HAZE_COLOR` 同时是天穹的 horizon stop 与海的远场霾；改一个，另一侧会出现横向色带。
2. **压 glow 会让太阳"没有存在感"**：现在太阳的可见性**全部**由 glow 承担（`DISK_GAIN = 0`，`horizon.ts:51`）。
3. **Neutral 的高光去饱和是硬编码分支**：`StartCompression = 0.76`、`Desaturation = 0.15`（`node_modules/three/src/renderers/shaders/ShaderChunk/tonemapping_pars_fragment.glsl.js:172-173`）。线性格值一旦越过 0.76 就按那条曲线走，改调色板比改曲线便宜。
4. **bloom 阈值现在压在"云的高光面"上**（§1.5），动云的调色板会连带改 bloom 的观感。
5. **天穹没有几何结构**：任何"加结构"的方案都要考虑它会不会与穹顶 slab（半径 780）和 puff 场抢深度/排序。

---

## 1. 实测基线

### 1.1 竖向着色剖面（**已测**，`color_sample.py` 的 `profile`）

top 30% 内、画面中央 40% 宽的中位 sRGB：

| 行高 | ref-01 | ref-02 | live cruise (neutral) | live cruise (nohud) |
|---|---|---|---|---|
| y=0.02 | (255,255,255)\* | (189,119,106) | (196,145,159) | (190,148,177) |
| y=0.10 | (207,112,130) | (177,90,85) | (203,156,165) | (214,156,168) |
| y=0.20 | (193,81,126) | (138,83,86) | (134,93,94)† | (234,161,148) |
| y=0.26 | (217,118,123) | (121,72,88) | (136,94,92)† | (235,162,129) |
| y=0.32 | (207,98,124) | (118,71,82) | (243,167,138) | (233,154,112) |
| y=0.40 | (203,116,116) | (133,79,80) | (245,170,126) | (198,133,105) |

\* ref-01/03 的 y=0.02 是白色字幕条，不参与颜色判断。
† 带 HUD 的帧在该行被混音器/速度卡覆盖，取的是面板色；判断天穹请用 `nohud` 列。

**读法：** 参考的天穹在 y=0.10–0.32 一直是**品红/紫**（B > G：+18 / +45 / +5 / +27）；现场同段变成**桃色**（B < G：−4 / −13 / −33 / −43）。这不是"更暗"，是**色相丢了**：蓝色分量相对绿色掉下去，天穹从"紫红晚霞"落到"奶油桃"。

### 1.2 warm sky 的彩度与明度（**已测**）

| case | warm share | L\* med | C\* med |
|---|---|---|---|
| ref-01 | 0.174 | 66.5 | **45.7** |
| ref-02 | 0.264 | 62.0 | **42.8** |
| ref-03 | 0.350 | 74.5 | **35.7** |
| live cruise (ACES, P1 前) | 0.260 | 70.7 | **14.4** |
| live cruise (neutral, P1 后) | 0.113 | 72.0 | **31.9** |
| live cruise (nohud) | 0.279 | 73.1 | **32.1** |
| live skim | 0.131 | 57.6 | 21.1 |

**结论（纠正）：** P1 把 tone mapping 从 ACES 换成 Neutral 之后，天空暖带的彩度从 14.4 回到 **31.9**，对参考区间 35.7–45.7 只差 **11%–30%**。**"整片天空被 bloom 洗过"这个说法不成立**——真的被洗过的话不会是这个量级（且 bloom 根本不作用在天穹上，见 §1.5）。

### 1.3 竖向跨度与结构（**已测**；P1 前后是两套数，必须分开看）

**表 A — `ref_gap_three.py` 的三对基线**（现场三帧是 **P1 之前的 ACES 帧**，不是当前状态）：

| 指标 | ref-01 / 02 / 03 | live cruise / dive / bankdive（ACES） |
|---|---|---|
| `sky_value_swing`（顶 8% 与地平线上方比） | 0.092 / 0.214 / 0.251 | **0.049 / 0.067 / 0.051** |
| `sky_sat_max`（P98） | 0.611 / 0.658 / 0.533 | **0.318 / 0.343 / 0.372** |

**表 B — 当前状态**（`ref_gap_measure.measure()` 直接跑中性帧与 nohud 帧）：

| 指标 | ref-01 / 02 / 03 | live cruise neutral（P1 后） | live cruise nohud |
|---|---|---|---|
| `sky_sat_max` | 0.611 / 0.658 / 0.533 | **0.770** | 0.773 |
| `sky_sat_mean` | 0.449 / 0.446 / 0.362 | **0.317** | 0.365 |
| `sky_value_swing` | 0.092 / 0.214 / 0.251 | **0.156** | 0.111 |
| `sky_value_top` | 0.788 / 0.744 / 0.937 | 0.733 | 0.762 |

**结论（重要修正）：** 换到 Neutral 之后，**饱和峰值已经高于参考**（0.770 vs 0.533–0.658），**竖向跨度落进参考区间**（0.156 vs 0.092–0.251），饱和均值到参考的 **70%–88%**。所以"天穹过平"在 P1 之后**只对了一半**：明度跨度与饱和度不再是最短的那块板。

真正还没补的是**结构**与**色相**：

| 指标 | ref-01 / 02 / 03 | live（当前帧） | 出处 |
|---|---|---|---|
| 天穹带边缘密度（top 30%，整幅宽） | 0.0386 / 0.0434 / 0.0501 | 0.0700（ACES 帧，含 HUD）/ **0.0235**（nohud） | `sky_band_probe.py` |
| 天穹细结构（top 22%，x 0.36–0.56 窗口） | 0.0571 / 0.0568 / 0.0489 | **0.0146**（nohud，唯一 HUD-free 窗口） | `sky_band_probe.py` |
| 行色调步数（同一窗口） | 26 / 35 / 30 | 53（nohud） | `sky_band_probe.py` |
| 暖带彩度 `C*med` | 45.7 / 42.8 / 35.7 | **31.9**（neutral）/ 32.1（nohud） | `color_sample.py` |
| 色相判据 `B−G`（y=0.20–0.32 行） | +5 … +45 | **−4 … −43** | `color_sample.py` 的 profile |

「天空带 edgeDensity 0.0129 vs 参考 0.0464」的**方向对**，但这两个数在本仓库复现不出来（脚本里没有 0.0129/0.0464）。同一窗口重测：**现场 0.0146，参考 0.0489–0.0571** → 现场细结构少 **3.3–3.9×**。

**附带发现（对评分卡文档有用）：** 同一帧带 HUD 是 0.0700、去掉 HUD 是 0.0235。即 `scorecard_metrics.py` 的"天穹带"边缘密度有 **66% 来自 HUD 面板和文字**，而且去掉 HUD 后 0.0235 **低于评分卡自己写的 0.04"primitive-dominant"阈值**。

### 1.4 ramp 的实际落点（**推算**）

`t = smoothstep(-0.02, 0.55, y_world/radius)`（`sky-webgpu.ts:71-72`），`radius = 800`（58），相机 `camY ≈ 60`（`game.ts:99`）→ `h ≈ 0.075 + sin(elevation)`。四个 stop 的 `at` 是 0 / 0.42 / 0.72 / 1（`palettes.ts:57-62`），解出仰角：

| stop | `at` | 颜色 | 出现仰角 |
|---|---|---|---|
| 0 | 0 | `#ff9a5a` horizon | −5.5° |
| 1 | 0.42 | `#c96a8f` rose | **9.2°** |
| 2 | 0.72 | `#6b4fa1` violet | **16.1°** |
| 3 | 1 | `#4a2f74` zenith | **28.4°** |

相机 `PerspectiveCamera(60, …)`（`src/main.ts:51`），竖屏 60° 垂直 FOV（注释写"~55"，`camera-rig.ts:19`，与代码不符）→ 画面顶部约 **27.5°–30°** 仰角（巡航时 `fovKick` 还会 +9°，`camera-rig.ts:46`）。

**结论：** 最暗的第 4 个 stop 只在 **28.4° 以上**出现，也就是画面最顶部 **~3%**；可见天穹实际只有 stop0→stop2，而且 stop1（玫瑰）只占 9–16°。**天穹的明度跨度被 ramp 的锚点挤到了画框之外**——但注意 P1 之后 `sky_value_swing` 已读到 0.156（表 B），所以这条在数值上不再暴露，只剩目检证据（§1.4 的 K1 任务已据此降优先级）。

### 1.5 bloom 的真实作用域（**推算** + **已测** three 源码）

- `post.ts:54` `bloomThreshold = 0.82`；three 的 high-pass 是 `smoothstep(threshold, threshold + 0.01, luminance(rgb))`（`BloomNode.js:12-16`，`smoothWidth = 0.01` 见 `107`）。
- 天穹的线性亮度（`palettes.ts` 的 sRGB → 线性，再按 `sky-webgpu.ts:88` 加 glow）：
  - 地平线 stop `#ff9a5a` → 线性 (1.000, 0.323, 0.102)，Rec709 亮度 **0.454**；
  - 加满 glow（`0.42 × (1, 0.78, 0.52)`，`sky-webgpu.ts:68,88`）→ (1.420, 0.651, 0.321)，亮度 **0.793**。
- 两者都 **< 0.82** → `smoothstep(0.82, 0.83, 0.79) = 0` → **天穹对 bloom 的贡献恒为 0**（推算；结论只依赖阈值与线性值，不依赖实现细节）。
- 而云的金色 `#ffe6c8`（`palettes.ts:104`）线性亮度 **0.820** —— 恰好压在阈值上；海 glitter 有 ×1.5（`sun-road.ts:20`）可以越过去。

**结论（纠正）：** 「bloom 阈值 0.82 低于天空自身亮度，整片天空被 bloom 洗过」**不成立**。真实情况相反：阈值卡在**云的高光面**上（0.820 vs 0.82），天穹一分钟都不进 bloom。

**那天空为什么平？** 两个可算的原因：
1. **加性光晕吃掉色相**（§1.6）；
2. **ramp 锚点在画框外**（§1.4）。
第 3 个候选是 DOF，但它几乎不成立（§1.7）。

### 1.6 光晕的代数（**推算**）

`base.add(sunTint.mul(glow))`（`sky-webgpu.ts:98`），`glow = pow(cos, 9) × 0.42`（88），`sunTint = (1.0, 0.78, 0.52)`（68，手写线性值，不是从 `SKY_PALETTE.sun` 推出来的）。

以 stop1（玫瑰 `#c96a8f`，线性 0.584 / 0.144 / 0.275）为例，在偏离太阳 0°/6°/10° 处：

| glow | 叠加后线性 | 过 Neutral 后的 sRGB（推算） |
|---|---|---|
| 0.00 | (0.584, 0.144, 0.275) | (195, 91, 133) |
| 0.10 | (0.684, 0.222, 0.327) | (210, 118, 146) |
| 0.20 | (0.784, 0.300, 0.379) | (224, 139, 157) |
| 0.42 | (1.004, 0.472, 0.493) | (240, 169, 173) |

`pow(cos,9)` 在 ±20° 内仍有 0.3–0.8 → 可见天穹的很大一块被推到最后一行那种"奶油粉"。实测 nohud 帧 y=0.20 是 (234,161,148)，与 0.2–0.42 档同量级 ✓。

**关键点：** glow 的 tint 是**暖桃色**，而基色在 9–16° 是**玫瑰/紫**。加性叠加把蓝通道相对比例压下去（B/G 从 1.9 降到 1.0），于是 `B−G` 由正转负（§1.1 的实测）。叠加量 0.42 与基色本身的量级（0.14–0.58）同阶 → 光晕不是"加一点光"，而是**重画了半个天空的色相**。

### 1.7 DOF 对天穹的作用（**推算**，需要 A/B）

`CoC = smoothstep(0, focalLength, |dist − focus|)`（`node_modules/three/examples/jsm/tsl/display/DepthOfFieldNode.js:373-379`），`focalLength = 420`（`post.ts:57`），`focus` 被夹在 12–60 m（`post.ts:82-92`）。

- 天穹（780/800 m 壳）、云的远侧、海的远场 **全部** `CoC = 1.0`（饱和）；
- 但采样步长 `sampleStep = invSize × bokehScale × CoC`（`405`），kernel 半径 ≤ 1（Vogel 盘，`_generateKernels` 498-511）→ 最大模糊半径 ≈ **`bokehScale` 像素 = 1.1 px**。

**结论：** DOF 的"满糊"是**几何上的**，视觉上只有 ~1 px，**不足以解释天穹变平**。它值得改的原因是它是全屏 64+16 tap 的开销（`未验证`，本仓库没有帧计时），不是画质。
**待验证：** `?post=0` 与默认帧的天穹细结构差（`sky_band_probe.py` 的 `edge_strip`）。本环境没有 A/B 帧。

### 1.8 天穹自身的"结构"（**已测**：读码 + 目检）

`sky-webgpu.ts` 的天穹 = **4 段渐变 + 一个各向同性光晕 + 一个增益为 0 的盘**，没有任何条带/层云/色相差项（97-101 的全部内容）。参考图的天空有明显的**水平层云条带**（目检 `ref-01-sunset-glide.png` 上部）——这是天穹带边缘密度高 3.3–3.9× 的正面原因。

---

## 2. 复核用户给的结论

| # | 结论 | 判定 | 依据 |
|---|---|---|---|
| K1 | 3 个 `SKY_STOPS` | **不成立**：是 **4** 个（at 0 / 0.42 / 0.72 / 1） | `palettes.ts:57-62` |
| K2 | `cos^9` 圆光晕 | **成立**：`GLOW_POW = 9`、`GLOW_GAIN = 0.42` | `horizon.ts:26,34`；`sky-webgpu.ts:88` |
| K3 | 圆盘 | **不成立**：`DISK_GAIN = 0`（D4 决策），盘项存在但恒为 0 | `horizon.ts:44-51`；`sky-webgpu.ts:93-94` |
| K4 | bloom 阈值 0.82 低于天空亮度，整片天空被 bloom 洗过 | **不成立**：天穹线性亮度 0.454（平）/0.793（含满 glow）都 < 0.82，high-pass 输出 0；阈值实际压在云的金色面 0.820 上 | §1.5 |
| K5 | 天空带 edgeDensity 0.0129 vs 参考 0.0464，反而过平 | **方向成立、数值不可复现**：同窗口重测 0.0146 vs 0.0489–0.0571 | §1.3 |
| K6 | 天空过平 | **部分成立（P1 之后）**：`sky_value_swing` 已回到 0.156（参考 0.092–0.251），`sky_sat_max` 0.770 已高于参考；仍差的是**细结构 3.3–3.9×**、暖带 `C* 31.9`（参考 35.7–45.7）、以及色相偏桃（`B−G` 转负） | 表 B + §1.3 |

---

## 3. 已完成（不要重复建议）

| 项 | 现状 | 证据 |
|---|---|---|
| 4 段 ramp 替掉 2 段 mix | 旧实现 `mix(horizon, top, t)` 把中段压成灰红线；现按 stop 逐个 mix | 73-81；`palettes.ts:41-56` |
| 盘改成角度阈值 | `pow(cos,220)` 是 9.09°（17 倍于真实太阳），HalfFloat 下 64000 次幂会下溢 | `horizon.ts:35-43,130-141` |
| 盘被砍掉 | D4：参考图没有硬盘 | `horizon.ts:44-51` |
| 线性空间转换 | 手写 sRGB 浮点会被当线性再编码一次 | `sky-webgpu.ts:122-131` |
| P1：ACES → Neutral | 暖带彩度 14.4 → 31.9；`sky_sat_max` 0.318 → **0.770**（参考 0.533–0.658）；`sky_value_swing` 0.049 → **0.156** | `renderer.ts:18-21`；§1.3 表 B |
| 天空与海的霾同源 | `HAZE_COLOR = SKY_PALETTE.horizon`，海的远场逐字抄天穹的 glow 项 | 71；`sea-fft.ts:727-740` |
| 速度线已删 | 天穹不再被径向条纹污染 | `post.ts:157-159` |

---

## 4. 任务

### K1 — 把 ramp 的暗端锚回画框内（优先级低于 K2/K3）

**证据（推算）：** §1.4（stop3 只在 28.4° 以上出现，占顶部 ~3%）。**注意：** P1 之后 `sky_value_swing` 已经是 0.156（表 B），所以"缺暗端"目前**没有**在跨度指标上暴露出来；它暴露在**目检**上——参考图顶部的深紫（`#4a2f74` 量级）在现场帧里看不到。**这条请先目检复核再排期（未验证）。**

**候选方向：**
- (a) 重设 `at`，让 4 个 stop 落在可见仰角 0–30°（例如 0 / 0.30 / 0.58 / 0.85）；
- (b) 保留 `at`，改 `smoothstep` 的上界（`0.55` → 约 `0.38`），等价于把整个 ramp 压进可见范围；
- (c) 在 ramp 之后再加一个以 `dir.y` 为自变量的暗端乘子（不改 stop 表）。

**验收门：** 顶部 15% 带能读出可辨识的深端层次（目检），且 `sky_value_swing` **不低于**当前 0.156（不许把 P1 的收益吃掉）；`sky_band_probe.py` 的 `row_tonal_steps` 在 nohud 帧上不劣化（现 53，参考 26–35）。**注意**：`dark_frac` 不许因此上升（现 0.082/0.106/0.037，参考 0.005–0.022）。

**风险：** 海的远场霾与天穹同色（Global Constraints 1/5）；天穹一变暗，海的地平线会显得"亮一条"。

### K2 — 光晕：从"加性重画"改成"保色相加亮"

**证据（推算）：** §1.6 的代数表；§1.1 的 `B−G` 符号翻转。

**候选方向：**
- (a) `add` → `mix`（或给 glow 乘 `(1 − base)`），只抬明度不改色相；
- (b) 收窄 `GLOW_POW`（9 → 24–40），把光晕从 ±20° 收到 ±8°，让玫瑰带保留原色；
- (c) `sunTint` 从硬编码 (1, 0.78, 0.52) 改成从 `SKY_PALETTE.sun` / `SKY_PALETTE.horizon` 派生——现在的硬编码是 `SKY_PALETTE` 之外的第二份颜色事实（违反 Global Constraints 1）。

**验收门：** warm sky 的 `C*med ≥ 38`（参考 35.7–45.7），且 y=0.20–0.32 行的 `B−G` 回到 **> 0**（现在 −4…−43，参考 +5…+45）；`sky_sat_max ≥ 0.53`。

**风险：** 太阳会变"小"；`DISK_GAIN = 0` 意味着太阳的存在感全靠 glow，一收窄就可能看不出太阳在哪。

### K3 — 天穹需要**结构**，不是更多的光

**证据（已测）：** §1.3（细结构 0.0146 vs 0.0489–0.0571）；§1.8（天穹只有渐变 + 一个各向同性光晕）。

**候选方向：**
- (a) 在穹顶上按 `dir.y` 叠 3–5 条**水平条带**（颜色取 ramp 的邻站，或者 `SKY_PALETTE.sun` 的低增益），这是参考图里最明显的"天空结构"；
- (b) 用一个高层薄板（比 CLOUD_BAND 高、比 puff 远）承载"高空层云"，但它会引入第三条云路径，排序与 `renderOrder` 要重排；
- (c) 只提高 ramp 的色相分段数（现在 4 段），让天穹在**色相**上有台阶——成本最低，但不产生"条纹"。

**验收门：** nohud 帧的天穹细结构 `edge_strip` 从 0.0146 抬到 **≥ 0.035**（仍低于参考 0.0489–0.0571，因为参考还含鸟/星点类的极小结构）；目检：天空能看出 3 条以上的水平层次。

**风险：** 条带一硬就会像"色带伪影"（尤其是 8 bit 输出 + SMAA 之后）；必须与 `sky_band_probe.py` 的 `row_tonal_steps` 同看，别把 53 步变成 8 步。

### K4 — bloom 阈值的作用域重新标定（顺带修注释）

**证据（推算）：** §1.5。`post.ts:45-49` 的注释写"bloomThreshold 0.82 高于地平线的线性亮度（flat sky ~0.45 Rec709，太阳盘 ~2.4×）"——这一段本身是对的，**与"天空被 bloom 洗过"的结论互相矛盾**，说明那句结论是误读。

**候选方向：** 保持 0.82，但把"谁在阈值上"写清楚（云的金色面 0.820 / glitter 峰值 / 天穹 0.454–0.793）；若 K2 抬高天空亮度，**必须重算**这一行，否则天穹会突然开始 bloom。

**验收门：** 改 K1/K2 之后重跑一遍本节的线性亮度表，天穹峰值仍 < 0.82；否则同步抬阈值。

### K5 — 文档与常量漂移（低成本）

**证据（已测）：**
- 注释 `camera-rig.ts:19` 写"~55 deg vertical FOV"，实际 `main.ts:51` 是 **60**，且 `fovKick` 会 +9（`camera-rig.ts:46`）——**真漂移**；
- `horizon.ts:8` 的注释仍写"checked against the 240 m ceiling"（当前 slab 顶是 480，`clouds-compute.ts:37`）——**这条不是错误**：`src/game.ts:98` 的 `ALT_MAX` 就是 240 m，讨论的是飞行高度上限而非云层顶，注释准确，保留；
- `palettes.ts:46` 的 `at` 注释写"1 at h = 0.55，约 33 deg"，按 `h = 0.075 + sin(el)` 反算是 **28.4°**——**这条也不成立**：`h = 0.075 + sin(el)` 的映射已经不存在了，现行 `src/sky-webgpu.ts:71-72` 是 `h = positionWorld.y.div(radius)`（即 `h = sin(仰角)`）再 `smoothstep(-0.02, 0.55, h)`，`asin(0.55) = 33.4°`，注释里的 33 deg 是**对的**。

**状态：已完成（40785e6）。** 三条里只有 FOV 一条是真漂移，已改（`camera-rig.ts:19` → "a 60 deg vertical FOV (`main.ts` base FOV, 69 deg at full `CAM_FOV_KICK`)"）。ramp 落点表已写进 `palettes.ts` 注释：t=0 → h −0.020 → −1.1°；t=0.42 → h 0.235 → 13.6°；t=0.72 → h 0.351 → 20.6°；t=1 → h 0.550 → 33.4°。另外两条按上面的理由不动代码——把正确的注释改成错误的才是漂移。


---

## 5. 验证矩阵（每项必跑）

1. `npx tsc --noEmit`
2. `npx vitest run`（`horizon.test.ts` / `renderer.test.ts` / `palettes.test.ts` / `post.test.ts`）
3. `node scripts/smoke.mjs`
4. `python artifacts/cloud-audit/audit.py --parity` — `== sky dome` 段看 `edge_strip`、`sat_strip`、`C_med_strip`、`steps`；`== gap` 段看 `sat_max`、`value_swing`、`grey_frac`；末行必须 `PASS`
5. warm sky 的 `L*med/C*med` 与竖向着色剖面（`B−G` 符号）走 `python artifacts/cloud-audit/color_sample.py`——这一条不在 audit.py 里
6. 目检三项：① 天穹能数出 ≥3 层水平结构；② 太阳附近是"亮核 + 晕"而不是一张奶油纸；③ 地平线接缝无横向色带
7. **A/B（未验证，必须先补）**：同一截图脚本下 `?post=0` vs 默认，量 `edge_strip` 差 —— 用来给 §1.7 的 DOF 结论定案
8. `?backend=webgl2` 目检（天穹是 TSL 节点材质，WebGL2 走同一条路径；`sky-webgpu.ts:116-119` 有降级到 canvas 渐变的分支）

## 6. 复跑

```powershell
python artifacts/cloud-audit/audit.py --parity  # 天穹带 + 三对 sky_* 指标 + 对账门
python artifacts/cloud-audit/color_sample.py    # warm sky 彩度 + 竖向剖面（不在 audit.py）
```

线性亮度与 Neutral 预测的口径见 §1.5/§1.6；`StartCompression = 0.76`、`Desaturation = 0.15` 出自 `node_modules/three/src/renderers/shaders/ShaderChunk/tonemapping_pars_fragment.glsl.js:172-173`。
