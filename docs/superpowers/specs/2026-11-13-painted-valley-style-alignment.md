# painted-valley 对照与「往这种风格靠」的落地方案

> 状态：**对齐研究（非任务计划）**。本文只回答「它怎么做到的、我们现在差在哪、按什么顺序补」。
> 每一期开工前仍需按仓库惯例另出带 fail-first 测试的任务级计划（`docs/superpowers/plans/`）。
>
> 参考仓：`G:\DSHProject\refs\painted-valley`（`git clone https://git.patch.gg/blendi/painted-valley.git`，82 文件，HEAD 与 `patch.gg` 文件页一致）。
> 本项目：`G:\DSHProject\ThreeJSInspire`，HEAD `2f05b25` 基线之上。

---

## 0. 一句话结论

它不是一个「吉卜力滤镜」，是**三件互相独立的事**叠出来的：**少色数（2–3 个平涂，只有一条硬边）** + **笔触重采样（把颜色重新涂成有方向、有粗细、有聚集的 marks）** + **静态物一次性烘焙**。

我们目前只做了最便宜的那一件的一半：把连续光照量化成 4 档等距色阶（`puff-cloud.ts:239-246`、`dome-cloud.ts:431-440`、`toon-look.ts:52` 的 6 档出口档位化）。**量化 ≠ 平涂 ≠ 笔触**。所以「往这种风格靠」的主线不是调阈值，而是：**把 4 条硬切减到 1 条 + 加一层笔触**。

---

## 1. 能不能拉、能抄什么（许可）

| 资产 | 许可 | 对我们的含义 |
| --- | --- | --- |
| `src/valley/*`、`src/lib/*` 代码 | MIT（© 2026 Patch） | 可以读、可以抄公式；逐字复制需保留 MIT 声明。**建议只抄公式不抄代码**，我们自己用 TSL 重写 |
| 其绘制出的画面（贴图、cubemap、烘焙图） | CC0 | 可随意用 |
| `public/figure/starter-man*.glb` | CC0（Git LFS） | 不相关 |
| `src/figure/rapier/*` | Apache-2.0 | 物理，不相关 |
| `public/audio/*` | Sonniss GDC 录音，**未入仓** | 不相关 |

结论：**可拉、可学、公式可用**。仓库自带 `MISSING_ASSETS.md`（音频缺失）与明确警告：

> "It is a starting point, not a filter."

这句话是全文最重要的一句——它自己就否掉了「加个后处理」的路线。

---

## 2. 它到底怎么做的（五层）

### 2.1 世界与光：先定「几点了」，再定一切颜色

`src/valley/sky.js:1-60` 的 `KEYS` 是 4 档（太阳仰角 e = 2 / 11 / 27 / 50°），每档 15 个线性 RGB：`sun / amb / bounce / zenith / mid / horizon / glow / fog / fogSun / haze / cloudLit / cloudMid / cloudShade / cloudUnder / exposure`。任意时刻用 `blend(e)` 线性插值，`sunAt(hour)` 只负责摆太阳（`e = 64 − 62·t^1.25`）。

关键点：**云色是天空色表的一项，不是云自己算出来的**。云在任意小时的颜色都由这张表保证和天空同族。我们的 `setCloudPalette` + `palettes.ts` 已经是这个结构，方向一致。

### 2.2 云：球堆 → ray-march 进 cubemap → 每面画一次

`src/valley/clouds.js`：

- 形状：`MAX_PUFFS 240 / MAX_CLOUDS 14 / PER_CLOUD 44`，`layout()` 手摆塔状积云。
- `map(p)`：SDF + `smin(..., s.w*0.55)` + 64³ `billowTexture` 三倍频 + 压平云底（`sin` 微扰后 smin 圆角）。
- 渲染：`WebGLCubeRenderTarget(1024, half-float)`，`steps 110`，只画 5 个面（`FACES [0,1,2,4,5]`，朝下的面永远不用），分 8 条 strip，**每帧只重画一条**，换光时 `drawAll()`。

也就是说：**云的几何和光照是离线画进一张 cubemap 的，运行时只花一次立方体采样**。这是它能在低端跑到 60fps 的根本原因，也是我们**不能照抄**的地方（见 §6.2）。

真正的干货在 `paint()`（`src/valley/clouds.js:280-310`）：

```glsl
float e = scale * 1.2;
vec3 Ns = ...;                    // 大形法线，半径 = 1.2 × 云尺寸
e = scale * 0.65;
vec3 Nf = ...;                    // 小形法线，半径 = 0.65
vec3 N = normalize(Ns * 0.8 + Nf);

vec3 L = normalize(uSunDir + vec3(0, 0.5, 0) - normalize(vec3(p.x, 0, p.z)) * 0.3);
float shadow = clamp(-map(p + L*scale*2.6)/(scale*0.8), 0, 1) * 0.5
             + clamp(-map(p + L*scale*6.5)/(scale*1.4), 0, 1) * 0.7;
float open  = clamp( map(p + Nf*scale*1.2)/(scale*1.2), 0, 1);
float up    = smoothstep(0.0, scale*7.0, p.y - base);
float light = (dot(N,L)*0.5+0.5) * exp(-shadow*1.3) + 0.1*up + 0.04*(open-0.5) + 0.1*N.y;

float broad = (dot(Ns,L)*0.5+0.5) * exp(-shadow) + 0.25*up + 0.1*Ns.y
            + 0.34 * (billow(p/(scale*16.0) + 0.3).b - 0.5);

vec3 inShade = mix(uShade, uMid, smoothstep(0.25, 0.85, broad));
inShade *= 1.0 - 0.07*(1.0 - smoothstep(0.1, 0.18, open));
vec3 col = mix(inShade, uLit, smoothstep(0.55, 0.6, light));      // ← 唯一一条硬边
return mix(uUnder, col, smoothstep(-0.2, 0.5, (p.y-base)/(scale*2.2) + light));
```

拆开看，这是**五个决定**：

1. **两套法线**：`Ns`（大形）负责「这一堆云朝向哪边」，`Nf`（小形）只用来算 `open` 和混进 `N`。注释直说：拿小堆去算暗部会「起斑」（`clouds.js:302-304`）。
2. **光不是 Lambert**：`L` 被抬高 0.5 并向观察者偏 0.3；再乘两段自阴影 `exp(-shadow*1.3)`；再叠 `up`（越靠云顶越亮）、`open`（凹处更暗）、`N.y`（朝上更亮）。这是**画出来的光**，不是物理光。
3. **暗部是软的**：`inShade` 是 `shade→mid` 的 `smoothstep(0.25,0.85,broad)`，宽度 0.6，慢变。只在 `lit` 那一刀上硬切，宽度 0.05。
4. **底音是混出来的**：`uUnder` 不是第四档，是 `(高度/2.2·scale + light)` 的混合，所以云底自然偏冷、受光处自然偏亮。
5. **色表只有 4 个**：lit / mid / shade / under，线性 RGB：

| 用途 | 线性 RGB | 相对 lit | 换算 L* |
| --- | --- | --- | --- |
| `uLit` | 1.22 / 1.20 / 1.14 | 1.00 | 107.3（>100，HDR 允许 bloom） |
| `uMid` | 0.70 / 0.79 / 0.88 | 0.648 | 90.7 |
| `uShade` | 0.31 / 0.46 / 0.63 | 0.367 | 72.3 |
| `uUnder` | 0.23 / 0.33 / 0.52 | 0.269 | 63.5 |
| `uHaze` | 0.50 / 0.72 / 0.92 | — | — |

L* 步长 = **8.8 / 18.4 / 16.6**。**不等距，中间那一跳最大**。

### 2.3 地：田块烘焙 + 笔触逐片元

两个层次，别混：

**烘焙层（只烘布局，不烘笔触）**——`src/valley/floor.js`：`FLOOR {u0:250, v0:-1200, size:2400}`、`CELL 150`、8 种田野色、`fieldAt()` 用扰动 Voronoi（±24m / ±11m）出 border/hedge/key/朝向；`paintFloor(1536)` 逐像素写：田色 × wash（fbm）、树篱线、道路 stencil（Catmull-Rom 采样 0.7m、半宽 1.9m、羽化 1.3m）。

**逐片元层（笔触在这里）**——`src/lib/glsl.js:249-319`：

- `heroPaint()`：三段，每段一个 `fwidth` 门控
  - soft 斑：`tNoiseHi` 3 tap，`smoothstep(0.42,0.48)` / `(0.53,0.59)` 各乘 0.9
  - coarse 团：`paintCells(q*70)`，门 `smoothstep(0.3,0.7, px*70)`
  - fine 点：`paintCells(q*220)`，门 `smoothstep(0.3,0.7, px*220)`
- `landStrokes()`：`line = 1 − smoothstep(1.5, 3.2, |fract(x)−0.5| / fwidth(x))`——**除以 fwidth 保证任何距离都是同样几个像素粗**；`here` 用噪声决定「哪里画」，`fract(id*0.618) < 0.62` 决定「亮笔还是深笔」。
- `strokeCoord = (world.y + 7·noise)/5.5`——笔触沿等高线走，所以远山看起来「有坡」。

距离带：`heroPaint` 70→150m 起，2200→3600m 收；`landStrokes` 70→170m 起，2600→4600m 收；`paintGround` 近景点触 40→110m 收。**这是步行游戏的带子，我们得整体压缩到 60–400m**（见 §6.5）。

### 2.4 远：高度图 → 平涂条带

`src/valley/backdrop.js`（26KB）：主山用高度图沿视线 march 成条带，每像素同时出 lit/shade/受光/空气/云 bank 五个通道；`horizon.js` 的环 1440×120 对数外扩到 `REACH 6200`，最后 2km 归平。

**「远处的东西只画一次」**：画完把 HDR alpha 写低（`frame.js:515` 用 `alpha < 0.6` 判定「已经画过了」），收尾的 Kuwahara 直接跳过它（`r = 0`）。这是个很省的做法：**额外一个通道当「细节已烘」的遮罩**。

### 2.5 收尾：Kuwahara + 墨线 + 轻 bloom

`src/lib/frame.js:510-548`，`painted()`：

- 4 个象限取方差最小的一块（`w = 1/(1e-7 + v^4·1e12)`，极陡但不硬选，注释说硬选会闪）。
- 半径 `r = int(uPaint)`，**夹到 2**；`away < 16m || away > 140m` 时降到 1；已画的降到 0。
- 关键技巧：采样前 `c = c/(1+c)`，输出后 `o/(1−min(o,0.985))`——Reinhard 往返，让「方差」在感知上均匀，否则高光区方差爆炸、暗部完全不动。

`inkAt()`（`frame.js:552-568`）：只在 alpha < 0.23 的物体（人物）上找线，`smoothstep(0.008,0.022,e)`；线的颜色是**底色的暗化暖化**：`min(c,1.2) * vec3(0.2,0.14,0.15)`，强度 0.92。**山、云、海一律不描边。**

bloom 是极轻的加法（`c + bloom*uBloom`），不是光源。

---

## 3. 我们的现状（对照）

| 模块 | 已有 | 缺 |
| --- | --- | --- |
| `puff-cloud.ts` | 5–10 大瓣 + 肩瓣合一 mesh；`PUFF_BAND_COLORS` 四档（L* 37.7/45.0/52.6/60.0）；`PUFF_BAND_THRESHOLDS [0.2,0.4,0.68]` 三刀硬切；`PUFF_NORMAL_WEIGHT 0.04`；`PUFF_LOBE_SHADE_GAIN 0.22`；`PUFF_HAZE {260,860,0.78}`；兜底壳层 5→3（2026-11-13 云层收敛） | 软体块；自阴影/开阔度/朝上三项光；单一硬边；底音；笔触 |
| `sea/water-shading.ts` | 2026-11-12 已把四档平涂换成连续光学（Fresnel 0.0204、`EXTINCTION 2.4`、`SLOPE_GAIN 14`）；`HAZE_CONVERGE 900→1900` 强制收敛 | 远海的「平涂接管」；笔触化的太阳路 |
| 陆地 | 未实现；roadmap A1–A9 / B1–B6 | 布局烘焙、笔触层、距离带重映射 |
| `post.ts` | `pass(samples:0) → bloom(add) → dof → smaa`；`bloomThreshold 0.82` 只让日盘泛光 | **没有 paint pass，没有 ink，没有 Kuwahara** |
| `toon-look.ts` | 6 锚点出口档位化 `TOON_STEPS [0.02,0.08,0.18,0.32,0.52,0.75]`，默认 0 逐位不变 | 它是**输出量化**，不是风格本身；拉满会把画面压成 6 级灰阶 |

全仓 grep `kuwahara|paper|grain|stroke|ink|brush`：**除了测试里的 "sink"，零命中**。也就是说我们没有画布层，只有「物理合成 + 色阶」。

---

## 4. 诊断：四种风格化，我们只做了最便宜的一种

| | 做法 | 观感 | 谁在用 |
| --- | --- | --- | --- |
| **量化** posterize | 连续亮度切成等距台阶 | 漫画/塑料，边缘机械 | `toon-look.ts`、`TOON_TRANS_STEPS` |
| **平涂** flat | 每个物体只给 2–3 个代表色，**一条**硬边，暗部用软体块 | 手绘赛璐璐 | painted-valley 的云 |
| **笔触** paint | 把颜色重采样成有方向/粗细/聚集的 marks，`fwidth` 保证像素宽 | 油画/水粉 | painted-valley 的地 |
| **墨线** ink | 只在轮廓与接触处加「底色的暗暖化」 | 赛璐璐收口 | 只给人物 |

**我们的 puff 现在是「4 档等距量化」**，L* 步长 7.3 / 7.6 / 7.4；painted 是「3 档不等距 + 一条硬边」，L* 步长 8.8 / 18.4 / 16.6。

把两者并排：

| | painted 云 | 我们的 puff |
| --- | --- | --- |
| 色数 | 3 主色 + 1 底音 | 4 档等距 |
| 硬切条数 | **1**（宽 0.05） | **3**（宽 0，`step()`） |
| 暗部 | `smoothstep(0.25,0.85,broad)` 软体块，宽 0.6 | 硬切，无体块 |
| 底音 | 高度 + 光 混出来 | 固定第四档 |
| 光照 | `dot(N,L)` + 两段自阴影 + open + up + N.y + 大形噪声 | `radial·sun` 球面梯度 + 每瓣 AO×0.22 |
| 法线 | 两半径（1.2 / 0.65 × scale） | 单法线，权重 0.04 |
| L* 步长 | 8.8 / 18.4 / 16.6（比例 2.1×） | 7.3 / 7.6 / 7.4（比例 1.04×） |

**绝对亮度不可比**（它是白天顶光，我们是日落逆光，`SUN_POSITION [60,35,-280]`）。可比的是**结构**：等距 = 机械，不等距 + 一条硬边 = 手绘。

> 注意：`toon-look` 的 6 档出口量化不是这条路。它是「把整幅画的亮度钉到 6 个锚点上」，painted-valley 里**根本没有**对应的东西（它连 bloom 都只是加法）。拉满 uToon 只会得到「6 级灰阶的写实画」。

---

## 5. 分模块方案

### 5.1 puff 云：把 4 档等距改成「2 + 1 + 1 条硬边」（零新增采样）

只改 `src/puff-cloud.ts` 的 `bandColorNode`（`:224-256`），**不加纹理、不加 pass、不加 uniform**。

| 步骤 | 改什么 | 改法 / 具体值 | 依据 |
| --- | --- | --- | --- |
| A | 删掉中间那档（52.6） | 阈值 **不是改数组长度就完事**：`bandColorNode` 里 `const [t0,t1,t2]` 三段 `step` + 三层 `mix` 要一起改写成单刀；`PUFF_BAND_COLORS` 由 4 元组降为 3 元组，`setCloudPalette` 的 4 档灌入随之改（`palettes.ts` 单源同步，`puffBandColors` 那条间距单测一并改） | 保持现有受光覆盖率，只改结构 |
| B | 硬切改窄过渡 | `step(0.68, w)` → `smoothstep(0.665, 0.695, w)` | painted 的 `smoothstep(0.55,0.6)` 宽 0.05/1.2 ≈ 0.04 |
| C | 暗部改软体块 | `mix(band0, band1, smoothstep(0.25, 0.85, broad))`，`broad` 用**每瓣属性**（`PUFF_LOBE_ATTRIBUTE` 已有）＋ `radial.y`，不取新纹理 | 免费；取小堆会起斑 |
| D | 加底音 | `mix(under, col, smoothstep(-0.2, 0.5, localY/halfHeight + light))` | `clouds.js:309` |
| E | 光里加三项 | `+0.10*radial.y + 0.04*(open−0.5) + 0.10*surfaceNormal.y`，`open` 由 `lobeShade` 反相近似 | `clouds.js:300`；全是算术 |

结果：L* 37.7（暗）→ 45.0（软体块，步长 7.3）→ 60.0（硬边，步长 15.0），比例 2.05 ≈ painted 的 2.09。**色表一个都不用新增**，`palettes.ts` 仍是单源。

验收闸门：
- 抓帧数档数 = 3（`qa.ts` 现有 CDF 口径）
- 硬边两侧过渡带 ≤ 3px（1080p，60m 机位）
- puff 的 p95 不升 > 0.5 ms（当前 p95 27.9，这是硬约束）
- 背光半球不塌成死紫（`[0.6,0.35,0.001]` 那个坑的复现检查）
- **基线纪律**：本改动会改变默认帧，`uToon=0` 的逐位字节门（G1）必然被打破。两条路选一条：① 挂在新 look 开关下、默认关；② 明确重定基线并重跑六门。**不许悄悄改默认值**。

Kill 条件：p95 > 29 ms，或档 0 占比 < 20%（坍缩）。

### 5.2 穹顶云：把 6 条带减到 2 条

> **已作废（2026-11-13）**：dome 模块已按 `specs/2026-11-13-cloud-layer-reduction-design.md` 整体删除，本节失去主语，不再排期。层数与背景层落点以该设计为准（背景层 `bg-cloud.ts`，单用途，见其 §6.1 Q4）；云的视觉语言（2+1 硬边、软暗部、底音）仍以 §5.1 为准。

### 5.3 海面：不要回退连续光学，只在远海接管

`water-shading.ts` 的头部注释已经写清了「四档平涂为什么会露出硬边色块」。**别回退**。painted 的水只有 3.9KB（`src/valley/water.js`）：一块 PlaneGeometry，`skyAt()` 反射天空 + 岸线镜像 + `pow(dot(R,sun), 420)` 的碎光 + Fresnel `0.03 + 0.97·(1−cos)^5`。它根本没有波谱。

我们的海承担速度感，波谱不能删。可借的只有两处：

| 步骤 | 改什么 | 具体值 |
| --- | --- | --- |
| A | 远海平涂接管 | `paintAmt = smoothstep(0.45, 0.85, seaHazeAmount(d))`，把亮度量化到 3 档后按 `0.25·paintAmt` 混入 |
| B | 太阳路笔触化 | 用一张 512 笔触 tile（照 `strokes.js` 的做法），沿 sun-road 方向拉伸采样 1 tap，只调制 `glint`，不调制底色 |
| C | 不动 | `HAZE_CONVERGE 900→1900`、`SLOPE_GAIN 14`、`F0 0.0204` |

近海（< 500m）**一律不加量化**——A3「除飞机外全场禁量化」这条要继续守。

### 5.4 陆地：布局烘焙 + 笔触逐片元（与 roadmap B3 的冲突要先解决）

roadmap `plans/2026-11-05-land-flight-0-to-1.md` 的 B3 写的是「软阈值、色相收拢、**纸纹 0**」。对照 painted 的实际做法，这条要修正：

- **它也没有纸纹**。它用的是 `tStrokes`（512 笔触图，`strokes.js` 生成：70 大软斑 + 420 短笔 + 900 碎点）和 `tNoiseHi`，不是纸纹。所以「纸纹 0」这条**方向是对的**，我们不要加纸纹。
- 但它有**笔触层**，而且笔触是逐片元的（4–6 tap），不是后处理。B3 现在的写法会让 B2 出来的地形只能靠色带，永远不像。
- 它的「软阈值」只软在暗部体块上，**受光边是硬的**（宽 0.05）。B3 若全部软，会得到「糊」。

建议 B3 改写为三段式，并写成常量：

| 层 | 实现 | 常量 |
| --- | --- | --- |
| 硬边 | 受光/背光一刀 | 宽 0.03–0.05（屏幕空间，用 `fwidth` 归一） |
| 软体块 | 暗部 `shade→mid` 慢变 | `smoothstep(0.25, 0.85, broad)` |
| 笔触 | `landStrokes` + `paintCells` 三段 dab | 见 §2.3；**必须乘 `1/fwidth` 才不变粗** |

烘焙分工（借 `lib/index.js` 的做法）：

- 布局图（田块 Voronoi、树篱、道路 stencil）→ Worker 烘成一张 1024² RGBA，覆盖 8 km（≈0.128 texel/m），`bakeRows` 切片 + `MessageChannel` 让帧。**他们的注释值得抄：定时器嵌套至少 4 ms，不然主线程照样卡。**
- 笔触/dab → 逐片元，不烘。
- 我们不需要 1536²，因为我们的可视带只有 520m（`HAZE_FAR`）。

**距离带整体重映射**（这是最容易照抄错的地方）：

| painted 的带子 | 用途 | 我们应改成 |
| --- | --- | --- |
| `paintGround` 40→110m | 脚下笔触 | 15→80m |
| `landStrokes` 70→170m 起 / 2600→4600m 收 | 远坡长笔 | 60→400m（受 `HAZE_FAR 520` 约束） |
| `heroPaint` 70→150m 起 / 2200→3600m 收 | 远坡色斑 | 60→400m |
| `backdrop` 6.2km 环 | 一次性远山 | 已有：`bg-cloud.ts`（原 dome-horizon.ts）的 1200–1800m 淡出带平涂面片；高度带 60–650 m |

`bg-cloud`（原 `dome-horizon`）按 `specs/2026-11-13-cloud-layer-reduction-design.md` §6.1 Q4 定为**单用途**——只做这一层高空背景云带；「扩成远景条带」不在该设计范围，将来**另立模块**。

### 5.5 收尾：加 paint pass 与 ink，但只给该给的东西

`post.ts` 的链是 `pass(samples:0) → bloom(add) → dof → smaa`。Kuwahara 要插在 **pass 之后、bloom 之前**（它要 HDR + depth，且不能吃 bloom 光晕）。

| 步骤 | 做法 | 成本 |
| --- | --- | --- |
| A | Kuwahara `r = 1`（9 tap），只 high 档 | 全屏 9 次采样；移动档直接关 |
| B | 距离门控：`60m < d < 400m` 时 `r = 1`，其余 `r = 0` | painted 的 16–140m 换成我们的带子 |
| C | Reinhard 往返 `c/(1+c)` → `o/(1−0.985)` | 方差感知均匀，否则高光吃掉一切 |
| D | ink 只给飞机（唯一的 cel 主体） | `alpha < 0.23` + 4 邻域，`min(c,1.2)*vec3(0.2,0.14,0.15)`，强度 0.92 |

**云、山、海一律不描边。** Ghibli 感来自「没有线的地方干净」，加了线立刻变成「描边三渲二」。

---

## 6. 分期与闸门

| 期 | 内容 | 依赖 | 验收 | Kill |
| --- | --- | --- | --- | --- |
| **P0** | 量尺：档数 / 硬边宽度(px) / 笔触覆盖率 / ink 密度 | `qa.ts`、`frame-stats.ts` 已有 | 四个数能一键抓 | 抓不出来就别开工 |
| **P1** | puff 2+1（§5.1） | 无 | 档数 3；过渡 ≤3px；p95 +0.5ms 内 | p95 > 29ms |
| **P2** | dome 6 带 → 2 带（§5.2，**已作废**）→ 由 `specs/2026-11-13-cloud-layer-reduction-design.md` 承接（dome 已删；puff 视觉语言仍在 §5.1） | — | 见该设计 §8 | — |
| **P3** | 海面远海接管（§5.3） | P0 | 900m 外无可见色阶边 | 太阳路碎光消失 |
| **P4** | 陆地 B2/B3 改写 + 笔触层（§5.4） | roadmap B2；**行动仓是 `ThreeJSInspire-reconstruct`** | 60–400m 有笔触，无一刀软到底 | 烘焙卡帧 |
| **P5** | paint pass + ink（§5.5） | P1–P4 | high 档 p50 不升 > 1ms | 移动档掉帧 |

顺序不能乱：P1/P2 是「减法」，先减掉机械感；P5 是「加法」，最后上。**先加 Kuwahara 再减量化，会得到「糊掉的四档灰」。**

---

## 7. 反面清单（照抄会翻车的地方）

1. **别把 `uToon` 拉满当风格开关。** 它是 6 锚点出口量化，painted 没有对应物；拉满 = 6 级灰阶。
2. **别抄小时级重烘云。** 我们是实时日落，`setCloudPalette` + 调色板轨道已经覆盖；重烘只会让云在时间变化时闪。
3. **别抄 cubemap 云。** 我们要视差（飞在云层之间）和穿云（`in-cloud.ts`），cubemap 在无穷远，穿不进去。
4. **别抄它的颜色。** `uLit 1.22/1.20/1.14` 是白天中性白；我们的云是日落逆光，抄了就丢调色板单源。
5. **别上全屏量化。** A3 明文禁；而且量化是「最便宜的那种风格化」，正是我们要减掉的。
6. **别加纸纹。** 它自己也没用纸纹（用的是 `tStrokes` 笔触图）。
7. **别给云和山描边。** 见 §5.5。
8. **别把 `landStrokes` 的 `fwidth` 除法去掉。** 去掉之后近处一笔粗、远处一笔糊，是最典型的「假笔触」。

---

## 8. 参考仓阅读索引

| 想知道什么 | 读哪 |
| --- | --- |
| 云的光照与配色公式 | `src/valley/clouds.js:280-310`、`406-410` |
| 云怎么进 cubemap、怎么增量重画 | `src/valley/clouds.js:396-466` |
| 一天的光色表 | `src/valley/sky.js` `KEYS` / `blend` / `sunAt` |
| 田块/道路怎么烘 | `src/valley/floor.js` `fieldAt` / `paintFloor` |
| 笔触三段与 `fwidth` | `src/lib/glsl.js:249-319` |
| 相机跟随的地面网格 | `src/lib/ground.js` `warpedGrid` |
| Kuwahara 与墨线 | `src/lib/frame.js:510-568` |
| 远山条带 | `src/valley/backdrop.js`、`horizon.js` |
| 人物为什么不是「画」 | `src/valley/wanderer.js`（3 平涂 + `INK` alpha） |
| 它自己怎么描述这套东西 | `README.md`「The idea」 |
