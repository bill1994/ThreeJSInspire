# 2026-11-07 太阳光路 sparkle + 背阳压暗 计划复审

> 复审对象：`docs/superpowers/plans/2026-11-07-sun-road-sparkle-anti-solar.md`
> 复审时 HEAD：`23cae89`（计划自称的取证 commit 与之相同，代码未漂移）
> 方法：读全部涉及的源码与既有测试 → 冻结抓帧复现基线 → bloom/DOF 二分开单 → 纯数值复算计划钉住的每一个常数。
> 取证帧与量测脚本落在 `artifacts/sun-road-review/`。

## 0. 结论

三个缺陷都是真的，`knee` 是正确方向，但**这份计划现在不能直接开 Task 1**：

- **5 处执行级硬伤**：路径全指错目录；一条单测在任何实现下都不可能绿；两个被钉住的数字互相矛盾；删了 `ROAD_PEAK` 却要求 `gate` 不动；绊线要求的标识符与"就地内联"的指令打架。
- **6 处机制错配**：其中 sparkle 的世界尺度小了约 19 倍——按计划写完，在它自己的验收机位上**看不到设计的那种细碎金闪**，只会得到逐像素的静态噪点（10.6% 像素起闪）+ 一圈 bloom 晕，即"白纱"复发。
- **4 处验收会假通过**：`mid p95` 可以靠整体压暗达标而路消失；B 的两条判据互斥；验收帧里本来就有一条 128 m 环缝会被当成 glint。

改法在第五节，三处替换即可执行。

---

## 1. 先说结论对的部分（不推翻的东西）

计划的问题定义站得住，我按它自己的 A 机位复拍，数字对得上：

| 项 | 计划基线（720×1280） | 本次复拍（448×797，同 9:16） |
|---|---|---|
| A 向阳帧 mid p95 | 226 | **230.1**（sea-mid 232.6） |
| A 帧光路形态 | "白纱糊满近场" | 连续奶油色带，无任何离散闪光（`artifacts/sun-road-review/A-base.png`） |
| B 背阳帧远海 | 粉彩、p95 99 | far-sea 均值 (156,99,120)，玫粉（`B-away.png`） |

所以「`spec=pow(96)` 连续高值 × `BASE 1.5 × ROAD_PEAK 2.0 = 3.0`」这条根因判断是准的，
`roadBudget` 也确实是这个仓库里唯一钉住它的地方（`src/sea/sun-road.ts:117`）。
knee 化 + 把连续部分压回 `roadBudget` 以下，是这条链上的正确动作。

---

## 2. 阻断级硬伤（照做会卡住，或者改到错的文件上）

### E1 所有 Task 1/2 的路径都不存在

计划写 `src/water-shading.ts`、`src/sun-road.ts`、`src/water-shading.test.ts`、`src/sun-road.test.ts`。
仓库里实际是 **`src/sea/water-shading.ts`、`src/sea/sun-road.ts`、`src/sea/*.test.ts`**。
Task 3 的 `src/sea/material.ts` 反而是对的——说明是抄旧路径时漏改。

后果不是"点错地方"，是**建出两份平行模块**：`src/water-shading.ts` 新建成功、测试也过，
但 `material.ts:39` 读的仍是 `./water-shading`（= `src/sea/water-shading.ts`），画面一行不变；
而 `src/sea/material.test.ts` 的源码绊线用 `import.meta.glob('./*.ts')`，只扫 `src/sea/`，
**扫不到你新建在 `src/` 的那份**，所以也不会变红。一个安静的"做了半天空转"。

### E2 `roadSpecKnee(50, 1) < 1` 永远为假

```js
1 - Math.exp(-50) === 1        // exp(-50) ≈ 1.9e-22 < Number.EPSILON(2.2e-16)
```

双精度下 `1 - 1.9e-22` 就是 `1`。计划 Step 1 的 `expect(roadSpecKnee(50, 1)).toBeLessThan(1)`
在任何正确实现下都失败，而 Step 4 又要求"确认通过"——执行者会在这里开始改实现去迎合一条错断言
（最典型的误改：给 knee 加个 0.999 的假上限）。同理受影响的还有同段的 `toBeCloseTo(1, 3)`（这条恰好能过，别连它一起改）。

### E3 被钉住的两个数字互相矛盾：覆盖率根本到不了 [0.5%, 1.5%]

计划 Task 2 同时钉了：
- `SPARKLE_LOW = 0.78`、`SPARKLE_HIGH = 0.94`
- `makeSparkleLattice` = **均匀白噪声**
- 覆盖断言：`mask > 0.8` 的像素占比 ∈ **[0.5%, 1.5%]**，mask 均值 ∈ [3%, 12%]

实算（65536 格穷举）：

| 量 | 计划钉住的值 | 均匀噪声实际给出 |
|---|---|---|
| `mask>0.8` 阈值对应的噪声 | ~0.91 | **0.894** |
| 强核心占比 | 0.5%–1.5% | **10.6%**（7–21 倍） |
| mask 均值 | 3%–12% | **14.0%** |

`mask>0.8` 是分位数问题：噪声过 0.894 就有 10.6%。要让强核心真的落在 1%，
`SPARKLE_LOW/HIGH` 必须抬到 ~0.99 附近；或者换成有重尾的分布（几次采样取积/积木式阈值），
或者干脆别用噪声（见 M1）。**这是本次复审最该先修的一条**：它同时决定"是不是又变成整片亮膜"
（计划自己的 Review Focus 1）和 `p99` 会不会破 `roadBudget`。

### E4 `ROAD_PEAK` 被删，但 `gate` 要求"不动"

Task 2：「语义变化：`SUN_ROAD.ROAD_PEAK` 删除」。
Task 3 Step 3.2：「`gate`/`nearFade` 不动」，而现图里 `gate` 就是
`ROAD_FLOOR + (ROAD_PEAK - ROAD_FLOOR) * mask`（`src/sea/material.ts:351-353`）。

删掉 `ROAD_PEAK` 之后 `gate` 的**新定义在计划里没有任何地方给出**，只给了 `sunRoadGain`
的新形态。这不是笔误级别：`gate ∈ [0.35, 2.0]` 还是 `gate = mask ∈ [0,1]`，
直接决定输入 knee 的量程（3.0 vs 1.5）、路的宽度，以及 M4 那条对比度结论。
`ROAD_PEAK` 在仓库里只有 `sun-road.ts:32,108,115` 与 `material.ts:352` 四个读点，删它很容易，但必须同时写清新 `gate`。

### E5 绊线要 `roadSpecKnee` 出现在 `material.ts`，指令却要求"就地内联"

Task 3 的 Step 1 绊线：`expect(src).toMatch(/roadSpecKnee/)`。
Task 3 的 Step 3 指令：「纯函数的 TSL 同构表达式**就地内联**」。
`roadSpecKnee` 是 Task 2 交给 **`sun-road.ts`（JS 镜像）** 的名字，图中内联时不会出现这个标识符。

这条只有靠"把内联 helper 恰好命名成 `roadSpecKneeTsl`"才能通过——`/roadSpecKnee/` 是子串匹配，
属于命名巧合而不是契约。同段的 `sparkleMask01|SPARKLE_LOW` 也有同样问题（`sparkleMaskTsl` 不匹配前者，
只能靠 `SUN_ROAD.SPARKLE_LOW` 出现在内联式里）。要么绊线改成匹配 `SUN_ROAD.ROAD_CEILING` / `SUN_ROAD.SPARKLE_` 这类**常量**，
要么明确"TSL helper 必须命名 `<name>Tsl`"并写进 Global Constraints。

---

## 3. 机制级错配（照计划做完，画面不会变成想要的）

### M1（最重）sparkle 的世界尺度小了约 19 倍

`SPARKLE_REPEAT_METRES = 3` + 256² 格 = **1.17 cm / 格**。而画面的像素足迹是：

`radPerPixel = 2·tan(30°)/1280 = 9.02e-4`（`src/view-budget.ts:17`，计划口径 720×1280）

| 距离 | 像素足迹 | 一格 sparkle 占几个像素 |
|---|---|---|
| 52 m（画面最下沿） | 4.7 cm | 4.0 |
| 137 m（sea-mid 带最近端） | 12.4 cm | 10.5 |
| 250 m（A 机位中段） | 22.6 cm | **19.2** |
| 400 m（sea-mid 带远端） | 36.1 cm | 30.8 |

也就是说：**在 A 机位上，光路的每一个像素都覆盖 10–31 个噪声格**。
`LinearFilter` + 无 mipmap 的 bilinear 只混 4 个格，于是每个像素拿到的是**近乎独立的随机值**——
"细碎金闪"会变成逐像素的椒盐噪点，密度就是 E3 算出来的 10.6%，
再叠 `bloomThreshold 0.82` 和 `bloomStrength 0.7`，几百个孤立热点各自晕开一圈 → **白纱原地复发**。
配合 `SPARKLE_DRIFT 0.02 uv/s`，它还会随相机移动而"沸腾"（这是 aliasing，不是 twinkle）。

反差参照：`makeDetailNormalTexture` 的同尺度细节是 **1.56 cm/texel**，但它有
`detailGate = smoothstep(1.0, 2.0, detailPx)`（`material.ts:267-268`），**只允许在 <17 m（约 1.5 cm/像素）以内显示**。
计划把同一个尺度的纹理放进了没有 footprint gate、没有 mipmap 的路径，还指望它在 200–400 m 处成立。

要让 feature ≈ 2 px（250 m），256² 格应配 **≈58 m 的 repeat**（现在是 3 m）。
或者换机制（见第五节）。

### M2 和"计划自称的目标"对不上：这不是 Cox-Munk

计划写「细碎金闪（**Cox-Munk 风格密度型**）」。但 Cox-Munk 是把**斜率分布**变成闪光密度，
闪光点自然长在"法线刚好半角"的浪面上——密度随距离、风、坡度方差自动变化，天然自 LOD。
计划实现的是"白噪声 → 阈值 → 乘在 specular 上"：噪声与水面的几何**完全无关**，
glint 会出现在没有浪面朝向的地方，尺度也不会随距离变化（M1）。两者只是看起来都"闪"，机制不同，代价也不同。

### M3 加法式叠加把 0.98 变成 1.74

计划写 `sparkle = mask × glint × SPARKLE_BOOST`、`withRoad = withFoam + glitter × (glint + sparkle)`，
又推导「`ROAD_CEILING × 1.3 ≈ 0.98`，只有核心越阈值」。

实算：`glint_max = ROAD_CEILING = 0.82 - 0.063 = 0.757`，`sparkle_max = 0.757 × 1.3 = 0.984`，
两项相加 = **1.741**，再乘 glitter 的 R 通道（1.0）就是 +1.74，**叠在本来就有的 base 之上**。
要真得到 0.98，公式必须是 lerp 形：`glint × (1 + mask × (BOOST - 1))` 或 `max(glint, glint×BOOST×mask)`。
**0.98 这个数反推出的公式和写下来的公式不是同一个**。写成加法式的话，核心是 ~1.7–2.0（R 通道硬过曝），
`p99` 破 `roadBudget` 是必然而不是风险。

### M4 knee 会吃掉方位门的作用，路会"变平"

`knee(x) = 1 - exp(-x·k)` 在输入 1.5 以上就接近饱和。同一套常数下：

| | 改前 | 改后（gate 保持 2.0） |
|---|---|---|
| 路心加项 | 3.0 | 0.736 |
| 路外加项 | 0.525 | 0.354 |
| **路/路外比** | **5.7×** | **2.1×** |

计划一边说「路心密、路尾疏」，一边用一条会饱和的曲线把门控的对比度压掉 2.7 倍。
后果：mid p95 的下降有相当一部分来自"整片海都暗了"，而不是"路被拆成了闪光"——
这正是 V2 那条验收漏洞能让人自我说服的原因。

### M5 「背阳压暗」与「接缝不裂」在数学上互斥

计划要同时拿到：`reflectionAwayDim = 0.45`、`hazeAzimuthGate` 背阳 0.35、以及
验收 B 的「远缘与天际线色差每通道 ≤ 12」。

按仓库自己的常数复算远海（天空函数见 `sky-webgpu.ts:79-85`，海面混合见 `material.ts:359-366`）：

- 天空在背阳边缘实测 (189,107,118)；
- 远海 = `mix(refl × 0.45, haze, 0.55 × (1-e^{-1900×2.5e-4}) × 0.35 = 0.073)`
  → 约 **(135,77,89)**；
- 与天际线差 **(54,30,29)**，是 12 阈值的 4 倍以上。

背阳远海之所以现在是粉的，是因为它**在忠实反射天空的背阳色**——这正是
`material.ts` 头注里那句「the reflection that is LITERALLY the sky's own TSL function」的全部意义。
把它乘 0.45，就是在这条链上开一个 55% 的台阶，海天之间重新出现一条硬边（也就是评审文档里的 P2 类问题）。
**"沉得深"和"接到天上"要靠改天空的背阳端（`HORIZON.AWAY_*`），不是改海面的反射系数**——
改天空是一行、两种渲染器同时跟随、接缝天然不裂。

### M6 方位模型重复造轮子，且两套曲线不同

`src/horizon.ts:89` 已经有 `antiSolarCool(cosAz, dirY)`，它是天空背阳色的**JS 镜像**
（`away^1.2 × lowSky × AWAY_GAIN 0.8`，有 7 条单测钉着）。计划在 `water-shading.ts` 里新增
`hazeAzimuthGate`（线性、1 → 0.35），是**第二套方位曲线**，与天空那套既不同形也不同参数。
两套曲线交叉的地方，海面的雾和天空的冷调会以不同速率转向 → 又是一条接缝。
仓库的既有约定（`palettes.ts:78-84` 注释）就是"同一个大气事实不要留两份"。

### M7 `hazeAway = 0xa56785` 是在 γ 空间推的

`mix(#ff9a5a, #8f5a90, 0.8)` 在 shader 里发生在**线性空间**（`linearFromCss`，`sky-webgpu.ts:151`）。
同样 0.2/0.8 权重换算回字节是 **#ad6b87**：`0xa56785` 与它差 (8,4,2)。
数值上没到 12 的阈值，但这条测试的意义是"钉住推导"，钉的却是另一个空间的结果。
更根本的是它把**一个推导结果冻成了字节**，而 `antiSolarCool` + `linearFromCss` 已经能算它——
按仓库的 `HAZE_COLOR === SKY_PALETTE.horizon` 的先例，这里应该导出一个**推导式**而不是一个常数。

### M8 新门控会吃到 `normalize` 的 NaN，而天空那边有防护、这边没有

`material.ts:347-348` 的 `sunXZ/viewXZ` 是裸 `normalize(vec2(...))`，没有长度下限；
`skyColorTsl` 里同位置写的是 `.length().max(1e-4)`（`sky-webgpu.ts:81`）。
计划 Task 1 承诺「非有限输入返回 1」，但 Task 3 是**就地内联 TSL**，
`HAZE_AWAY + (1-HAZE_AWAY)*(NaN+1)/2 = NaN`，会直接把 `withHaze` 打成 NaN——
近地/俯视机位（FALL 那类）最容易踩到。JS 镜像的兜底不能替代图里的兜底。
（顺带：`roadMask` 只要视野接近天顶就会吃到同一个坑，这是既有隐患，一次性补掉更划算。）

---

## 4. 验收级（会"通过"，但没验证到东西）

### V1 bloom 不是白纱的主体，计划把它当成了根因的一半

计划的缺陷①写「`bloom 0.7` 摊开成纱」。二分实测（同一帧、只切后处理）：

| 帧 | mid p95 | sea-mid p95 | sea-mid 过曝% |
|---|---|---|---|
| A-base（出货态） | 230.1 | 232.6 | 38.4% |
| 关 bloom | 219.3 | 221.1 | 27.5% |
| 关 DOF | 228.5 | 230.1 | 37.4% |
| 关 bloom+DOF | 218.5 | 220.1 | **25.0%** |

也就是说：**关掉整套后处理，仍有 1/4 的像素硬过 240**——白纱的体量在片段图里（那个 3.0），
bloom 只贡献 ~12 个灰度与 +13pp 过曝面积，DOF 只贡献 ~2.5 个灰度。
计划的修法（knee 压连续部分）方向没错，但"bloom 摊开"这个模型会误导验收：
如果真的按"少 bloom"去调 `bloomStrength / bloomThreshold`，`p95` 不会明显动，
而 `post.ts:65-84` 的注释明确禁止为了画面去动这两个数。

### V2 缺一条"路还在"的判据，`≤190` 可以靠整片压暗骗过去

Task 4A 只有上限（mid p95 ≤190、blown% = 0、局部极大值 ≥30 个）。
M4 那张表说明：把整片海压暗 40% 也能让 p95 掉到 190 以下，而"太阳光路"这个视觉锚点会一起消失。
**必须补一条下限**：路心亮度 / 同距离路外亮度 ≥ 某值（改前 5.7×，knee 后天然是 2.1×，
所以阈值要按新机制重新定，比如 ≥2.5×，并且和 M4 的常数一起钉在单测里）。

### V3 分带没有定义，基线也没落盘

计划里出现了 `mid 带`、`far-sea`、`near-sea`、`road 区` 四个带，**没有一个给出高度比例或几何定义**，
也没有一帧存证（`artifacts/cloud-audit/protocol-2026-11-01/measure.json` 有先例，这次没有）。
我能复现 226（对得上），但复现不出 `far-sea p95=99 / p5=20` 和 `FALL mid 234 / near 70`——
换一组合理的带边界就会得到 136/61 这种数。基线不可复现 = 验收不可复核。

### V4 验收帧里本来就有一条 1 像素的环缝，会被算成 glint

计划自己的 A 机位，`R0`（outer = 128 m）与 `R1` 的接缝在画面上落成 **y≈508 的一条 1 像素横线**：
该行中位数从 50.2 跳到 55.7、最亮 156、90 个像素高出局部中位数 40+。
它正好横穿光路区域。Task 4A 的「光路区内局部极大值 ≥30 个」会把这条线算进去（它本身就是一串极大值），
`blown% = 0` 也有可能被它之外的亮点破坏。要么换机位，要么在量测里先排除该行，
要么承认它并单独修（这是 `rings.ts` / `rings-mesh.ts` 的既有几何缝，不在本计划范围）。

### V5 `C(FALL)` 的观察窗可能根本没覆盖改动区

`FALL_PITCH = -1.1 rad`（`src/game.ts:90`），自由落体时机头下压 63°。
在这个姿态里，"背阳远海"和"25° 方位门"这两处改动都不一定在画面内；
而 C 的判据（near-sea p5–p95 跨度）量的是**水体自身的对比**，恰好是这两处改动最不直接影响的东西。
计划没有先拍一帧确认「FALL 帧里 road / haze 像素各占多少」——C 很可能是个空测。
建议：先出 FALL 帧，标出 road 掩码覆盖率，覆盖率 <某值就把 C 改成"P4 复拍仅记录、不作为本计划的通过条件"（这也更符合计划自己说的"残留另开单"）。

### V6 「road 区 p99 目测 ≤ 阈值对应灰度」

「目测」不是判据，且这条与 `roadBudget` 的语义（线性亮度、p99）对不上。
`roadBudget` 是 linear HDR 量，`p99` 应该在同一域里算——要么在 `?sea=debug` 或临时 uniform 里读出线性值，
要么把这条删掉，交给 M3/V2 的单测去钉。

---

## 5. 建议改法（可直接落到计划里）

### 5.1 换掉 sparkle 的机制（Task 2 + Task 3 的主体）

不要"白噪声 × specular"，改成**阈值化斜率场**——即计划自己写的 Cox-Munk：

```ts
// sun-road.ts
GLINT_COS_THRESHOLD: 0.9985,   // 法线半角内的像素才起闪；密度随坡度方差自然变化
```

图里 `spec` 已经是 `max(0, reflect(sun,N)·V)`，它**逐像素**反映真实浪面朝向，
天生随距离 mip 化（远处的坡度被 mip 平均掉 → 闪光自然稀疏、"路尾疏"免费得到），
这正是 M1 里"要让 feature≈2 px 需要 58 m repeat"的正确解——因为它用的是几何，不是纹理。

- 想要"细碎"：提高阈值（`0.9985` → 更少、更硬的核心），而不是抬高噪声门；
- 想要"密"：降 `GLINT_COS_THRESHOLD` 或抬 `SLOPE_GAIN`（`water-shading.ts:86`，已有 8→14 的调参记录）；
- 想要"动起来"：闪光天然随浪动，不需要 `timeUniform` / `SPARKLE_DRIFT` / 纹理 / 显存 / 漂移。

如果一定要保留纹理路线，最小修正是三条一起上：repeat 抬到 ~60 m、加 mipmap + 显式 LOD
（学 `detailGate` 的写法）、覆盖率断言改成**屏幕空间**（给定距离范围）而不是纹理空间。

### 5.2 背阳压暗改成改天空（Task 1 大幅简化）

```ts
// palettes.ts / horizon.ts —— 一处改，天空和海面同时跟随
AWAY_GAIN: 0.55,              // 0.8 -> 0.55：玫粉更收
AWAY_COLOR: '#7f4f7e',        // 更沉一档
```

海面侧只做一件事：**让远海的雾色等于"天空在那个方位画出的地平线色"**——
用现成的 `antiSolarCool` 当权重、用 `skyColorTsl` 的同一套 stop 出颜色：

```ts
// material.ts
const cool = antiSolarCoolTsl(cosAz, float(0));           // 复用 horizon.ts 的形状
const hazeCol = mix(HAZE_COLOR, awayHorizonCol, cool);     // awayHorizonCol 由同一 mix(#ff9a5a,#8f5a90,AWAY_GAIN) 推出
```

这样：不需要 `hazeAway` 常数（M7 消失）、不需要第二套方位曲线（M6 消失）、
不需要压反射（M5 消失）、`HAZE_MAX / HAZE_DENSITY` 一个数都不用动，
`palettes.test.ts` 的 `haze === horizon` 契约保留。

### 5.3 补两条断言（把 V2/M3 变成红线）

```ts
// sun-road.test.ts
it('sparkle 核心不超过 bloom 阈值太多，连续部分不越 roadBudget', () => {
  const cont = roadSpecKnee(1 * SUN_ROAD.BASE * 2.0, SUN_ROAD.KNEE_K) * SUN_ROAD.ROAD_CEILING;
  expect(cont).toBeLessThanOrEqual(SUN_ROAD.ROAD_CEILING + 1e-9);
  // lerp 形，不是加法形
  const core = cont * (1 + (SUN_ROAD.SPARKLE_BOOST - 1));
  expect(core).toBeGreaterThan(0.82);          // 只有核心过阈值
  expect(core).toBeLessThan(1.05);             // 但也别把通道打穿
});
it('路心仍比路外亮，knee 没有把方位门吃平', () => {
  const road = sunRoadGain(1, 0, 1), off = sunRoadGain(1, (25 * Math.PI) / 180 * 3, 1);
  expect(road / off).toBeGreaterThan(2.5);      // 改前 5.7，knee 后 2.1 —— 需要显式决定
});
```

（第二条里的 2.5 是"要不要接受 M4 的对比度损失"的显式决定点；如果接受，就把门槛写成 2.0 并在计划里写明理由。）

### 5.4 其余机械修正

1. 路径全部改 `src/sea/…`（E1）。
2. `roadSpecKnee` 的 `<1` 断言换成 `toBeLessThanOrEqual(1)` + `toBeGreaterThan(0.999)`（E2）。
3. `SPARKLE_LOW/HIGH` 与覆盖率目标二选一（E3）；若保留噪声路线，按 1% 反解 → `LOW≈0.98, HIGH≈0.995`，并把这条写进注释供后人调。
4. 明写新 `gate`（E4）。
5. 绊线改成匹配常量（`SUN_ROAD.ROAD_CEILING` / `SUN_ROAD.GLINT_COS_THRESHOLD`），或把"`<name>Tsl`"写进约束（E5）。
6. `dispose()` 里补 sparkle 纹理释放（现 `material.ts:518-521` 只释放 detail normal）。
7. `K = 1.2` 现在写在 Task 3 的图里当"调参入口"——违反计划自己的 Global Constraint（每个 shader 常数都要有 JS 镜像 + 单测），挪进 `SUN_ROAD.KNEE_K`。

---

## 6. 证据

| 文件 | 内容 |
|---|---|
| `artifacts/sun-road-review/README.md` | 抓帧配方（冻结法、机位、后处理 A/B） |
| `artifacts/sun-road-review/A-*.png` | A 机位：base / 关 bloom / 关 DOF / 关全部 |
| `artifacts/sun-road-review/B-away.png` | B 机位（背阳） |
| `artifacts/sun-road-review/measurements.json` | 各帧分带 p5/p50/p95/过曝% |
| `artifacts/sun-road-review/measure_bands.py` | 可重跑的量测脚本 |

复算脚本没有入库（一次性），但每条数字都能在本文里手算复核；
E2/E3/M3/M4/M5/M7 的算式都写在对应小节。
