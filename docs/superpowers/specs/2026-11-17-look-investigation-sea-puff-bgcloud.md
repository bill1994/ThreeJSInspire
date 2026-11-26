# 三件套视觉调查报告：海 / puff 云 / bg-cloud 大理石纹

日期：2026-11-17
基线：`faf16ba`（工作区另有 `src/bg-cumulus.ts` 未提交实验，见 §6）
范围：只查 `src/sea/**`、`src/puff-*.ts`、`src/in-cloud.ts`、`src/bg-cumulus*.ts`，其余文件按交接书忽略。

---

## 0. 结论速览

| 你提的问题 | 真正的原因 | 一句话修法 |
|---|---|---|
| ① 海"物理真实但效果一般" | 它不是"参数没调好"，而是**整条链路都是物理光学模型**：Schlick 菲涅尔 + 真实天空查表 + Cox-Munk 镜面闪点 + Jacobian 泡沫。物理正确的画面天然就是写实的，任何参数都调不出 Ghibli。 | 保留光学**底子**，在**光照项**上做画师化：`fwidth` 抗锯齿的硬边明暗交界 + 量化高光 + 手绘泡沫形状，删掉高频闪点。 |
| ② puff"着色差、能看出是 mesh" | 它是 `MeshBasicNodeMaterial`，**完全不受光**。颜色 = 到云心的**径向**点积 + 4% 权重的法线 + 4 条 `step()` 色带。没有自阴影、没有瓣间遮蔽。而且 `side: DoubleSide` + 近处不透明下限，穿进去看到的是**同一个球壳的内壁**，用同一套中心径向渐变画的——空壳永远不可能像体积。 | 换成"每瓣球面法线加权 + 沿视线积分厚度"的假体积着色；`FrontSide` + 用已有的 `in-cloud.ts` 白纱接管入云。 |
| ③ bg-cloud 永远去不掉大理石纹 | **单位错了一个数量级**：`paint()` 收到的是包围球半径，不是 form scale，差 11.6–14.1 倍；再叠加**所有 SDF 采样点都取在包围球入射点 `pS` 而不是云面上**。两个 bug 互相掩盖，谁单独修都看不出所以然。 | 已定位并验证（§2）：解析球并集入射 + 牛顿收敛 + form scale，纹路视觉上消失。但底下 `light`/`broad` 仍是混沌的，必须再做"解析簇法线"才算真修好。 |

三条的共同点：**你现在的画面是"物理正确 + 后期风格化"，而参考的三家（Ghibli / Zelda / painted-valley）都是"造型本身就风格化"。** 后期加色带救不了几何和光照模型。

---

## 1. 参考实现到底做对了什么

`docs/reference/painted-valley/clouds.js`（MIT，470 行）的关键不是它的颜色，是它的**三个决定**：

1. **不是密度积分体，是 SDF 球并集 + sphere-trace 打表面 + 画表面。**
   `smin` 合并球，`t += max(d*0.5, 30)`，最多 260 步，再二分 9 次贴到皮上。拿到的是**一个精确表面点**，然后在那个点上画。
2. **法线分两级，而且"暗部只用大形"。**
   `e = scale*1.2` 出 `Ns`（大形），`e = scale*0.65` 出 `Nf`（细节），`N = normalize(Ns*0.8 + Nf)`。
   而决定暗部 ramp 的 `broad` **只吃 `Ns`**。源码注释原话：

   > Its modelling comes from the cloud's big forms alone: taken from every small heap, it breaks into stains.

   **这句话就是你的大理石纹。**
3. **明暗交界是一道 0.05 宽的硬边。**
   `col = mix(inShade, uLit, smoothstep(0.55, 0.6, light))`——窄到几乎像 `step`，但留了抗锯齿余量。加上暖白受光 `(1.22,1.20,1.14)` / 冷蓝暗部 `(0.31,0.46,0.63)`，就是 Ghibli 的"暖亮冷暗"分裂。

我们的移植把 1 和 2 都做了一半：有 `smin` 有 `paint()`，但**表面点取错了**（§2.2）、**尺度取错了**（§2.1），而 3 因为调色板四个色带挨得太近，硬边根本看不见。

---

## 2. bg-cloud：大理石纹的完整因果链

### 2.1 Bug A —— 长度尺度错了 11.6–14.1 倍

`src/bg-cumulus.ts:842` 原来写：

```ts
ancScale.addAssign(wA.mul(clA.w));   // clA = uClouds = (cx, cy, cz, bounds.r)
```

上一行 `:838` 从 `uCloudInfo` 读的是 `.z`（base），这里却从 `uClouds` 读 `.w`——那是**包围球半径**，不是 `infoA.w` 的 form scale（`scale = width × 0.07`）。

实测 `layoutClouds(20261117)` 的 8 朵云：

| form scale | bounds.r | 倍数 | eN=0.4·scale | 平均 puff 半径 | shadow 探针 2.6·scale |
|---|---|---|---|---|---|
| 157 | 2183 | 13.94 | 63 m | 362 m | 408 m |
| 171 | 1982 | 11.62 | 68 m | 244 m | 445 m |
| 491 | 5781 | 11.78 | 196 m | 533 m | 1277 m |
| 442 | 5317 | 12.02 | 177 m | 488 m | 1149 m |

`paint()` 内部每一个长度都乘 `scale`，于是：

| 项 | 代码 | 实际值 | 应该是什么 | 后果 |
|---|---|---|---|---|
| `eN` | `scale*0.4` | 793–2312 m | ~60–200 m | 四点差分跨过好几个瓣 → `Ns` 根本不是导数 → **大理石纹** |
| `eF` | `scale*0.22` | 436–1272 m | ~35–110 m | "细节"法线比一个瓣还粗 |
| `shadow` 探针 | `scale*2.6` / `scale*6.5` | 5.2–15.0 km / 12.9–37.6 km | 410–1300 m | 探针落在云外 → `shadow≈0` → `exp(-shadow)≈1` → **没有自阴影** |
| `open` | `scale*1.2` | 2.4–6.9 km | ~190 m | 开启度无意义 |
| `up` | `smoothstep(0, scale*7, …)` | 13.9–40.5 km | 1.1–1.3 km | 云高只有 400–1600 m → `up≈0.02–0.1` → **顶部提亮是死的** |
| `hgt` | `/(scale*2.2)` | /4.4–12.7 km | /350 m | **`uUnder` 暗底永远到不了** |
| `broadBillow` | `scale*16` / `scale*5` | 25–92 km | 2.5–2.8 km | 噪声在整朵云上是常数 → **没有内部流动** |
| `shadeVar` | `scale*3` | 6–17 km | ~470 m | 同上 |

**一个单位错误同时解释了两件事**：大理石纹，以及"整朵云像一块橘色板子"。上一版注释（旧 `:788-789`）写"billow 尺度 140m 会让 hgt/up 归一化过紧，沿用已验证的 bounds.r"——把**噪声采样尺度**和**着色归一化尺度**混成了一个数。140 m 对 `up` 确实太紧，但 bounds.r 对所有项都太松。

### 2.2 Bug B —— 所有 SDF 采样点都不在云面上

修掉 A 之后（`?bgdbg=5`）云**直接消失了**：整朵塌成暗部紫色，跟天空糊在一起。

原因：`paintTsl` 收到的 `pS` 不是表面点，是**包围球解析入射点** `ro + rd*hazeDepth`。这是历史上为了压抖动故意换的（`p` 逐像素跳）。可是：

- `shadow` 探针从 `pS` 出发沿 `L` 走 410 m——`pS` 在云**前面**几百米，所以探针必然在云**内部** → `shadow≈1` 满值 → `light→0` → 全暗。
- 用 bounds.r 时探针走 5–15 km，反而**落到云外** → `shadow≈0` → 全亮。两个 bug 互相抵消，所以没人发现。

`?bgdbg=6` 的修法（已验证）：新增 `puffEntryTsl`，对每个 puff 球解一元二次取最小正 `tIn`，得到**与步进历史无关的精确入射点**，再用 3 步阻尼牛顿 `t -= 0.8·map(t)` 收敛到位移后的真实表面，并且 `pS = p`。

### 2.3 证据

| 帧 | 开关 | sha256 | 现象 |
|---|---|---|---|
| 基线 | — | `9053B0E5…` | 橘色云 + 大理石纹 + 无体积 |
| form scale | `?bgdbg=5` | `8B3D0EA8…` | 云几乎消失（Bug B 暴露） |
| 解析入射 | `?bgdbg=6` | `887BA83C…` | **大理石纹完全消失**，轮廓干净，但整朵平涂蓝灰 |

基线三次重拍 sha256 逐位相同 → 默认帧未被改动。

### 2.4 Bug C —— 纹路只是被"藏"起来了，没有根治

`?bgdbg=7` 把 `paint()` 内部的四个标量当假色输出（R=`light`, G=`broad`, B=`up`, A=`open`）：

结果是**满屏绿色蛇形纹 + 黑色斑块**。也就是说 `light` 和 `broad` 本身仍然是混沌场，`?bgdbg=6` 看起来干净，只是因为：

```ts
inShade = mix(uShade, uMid, smoothstep(0.25, 0.85, broad))
```

`smoothstep` 把混沌压进了一条窄带，而 `uShade`(0x6f618f) 和 `uMid`(0x826da8) 又挨得极近，所以看不出来。

**这意味着：只要你为了"更好的着色"去拉开明暗对比，大理石纹会立刻回来。** 这不是一个可以靠调色解决的 bug。

混沌源是 `dot(Ns, L)`：`Ns` 是用 `eN` 做的四点差分，而位移场最细一层是 `billow(q*7.3)` ≈ `scale*1.03` 波长——`eN = scale*1.2` 只比它大 15%，等于在**位移本身的波长上**求导，法线方向当然剧烈翻转。参考实现同比例，但它的 puff 半径 ≈ 1.4·scale，我们的是 **2.3–3.4·scale**（平均 244–537 m vs scale 157–182 m），位移幅度相对瓣半径大得多。

### 2.5 真修法（建议顺序）

1. **`Ns` 换成解析簇法线**，不要四点差分。在 `puffEntryTsl` 里顺手记录入射瓣的 `(i, cloudIdx)`，`Ns = normalize(Σ w_k·(p - c_k)/r_k)`，`w_k` 用 smin 权重。这从根上消灭 `Ns` 的高频——因为它只含球面曲率，不含 billow 位移。
2. **`shadow` 换成多点软阴影**：沿 `L` 走 3–4 个等距探针取 `clamp(-d/softness)` 的平均，别用两个单点。单点探针在凹凸皮上必然是二值的。
3. **`eN` 改成 `scale*3~4`**（真·大形），`eF` 保持 `scale*0.65`。
4. **调色板换成"暖受光 / 冷暗部"**：现在 `PUFF_BAND_COLORS`/bg 四带是同一色相的四个亮度（紫→玫瑰），没有色温分裂。参考的 `uLit` 暖白 vs `uShade` 冷蓝才是 Ghibli 的读法。
5. 上面四条做完，才允许把 `hardEdge` 之外的 `shadeMix` 拉宽到 `[0.35, 0.72]` 拿到更大的暗部层次。

---

## 3. puff 云：为什么"着色差"和"能看出是 mesh"

### 3.1 它根本不受光

`src/puff-cloud.ts`：

```ts
const material = new MeshBasicNodeMaterial();
material.colorNode = bandColorNode();
```

`bandColorNode()` 的全部输入：

```ts
const radial = normalize(positionLocal);              // 到云心的方向
lit = radial·sunDir * 0.96 + normalLocal·sunDir * 0.04
bandW = clamp(lit*0.5+0.5 + lobeShade*0.22, 0, 1)
→ step() at PUFF_BAND_THRESHOLDS = [0.2, 0.4, 0.68] 选四条 PUFF_BAND_COLORS
```

也就是说：

- 着色 = **一个球面渐变**（到云心方向的点积），跟这个像素在云的哪个瓣上、朝哪、有没有被别的瓣挡住**完全无关**。
- 法线只占 4%（`PUFF_NORMAL_WEIGHT = 0.04`，历史上从 0.28 → 0.10 → 0.04 一路降，因为高了每个瓣就像气球）。
- 每瓣只有一个常数 `lobeShade ∈ {-1,0,1}`，权重 0.22。
- 四条带是 `step()` 硬切，没有抗锯齿。

所以云看起来是"一个光滑大团 + 四条色带"——正是你说的"着色差"。

### 3.2 穿进去看到的是同一个壳的内壁

```ts
material.side = THREE.DoubleSide;
material.opacityNode = mix(PUFF_NEAR_FLOOR, 1.0, smoothstep(260, 860, dist)) * 0.96 * edgeFade;
```

近处不是淡出到 0，是淡到 `PUFF_NEAR_FLOOR` 的下限；同时 `DoubleSide` 让你看到**背面**。背面用同一套 `positionLocal` 径向渐变 → 内外壁颜色一模一样 → 一眼就是一层皮。

兜底方案 `interiorGroup`（名字 `puff-interior`）只有 `SHELL_COUNT = 3` 层缩放副本，alpha 0.07，`depthWrite = false`——三层壳撑不起体积感，而且它们跟着**相机**而不是云。

### 3.3 建议

分两条路，可以按预算选：

**路线 A（便宜，1–2 天）：假体积着色 + 换朝向**
1. `side` 改 `FrontSide`；入云交给已有的 `src/in-cloud.ts` 白纱（它本来就是干这个的，`setVeilTintEndpoints` 已经在跑）。
2. 着色从"中心径向"改成**每瓣球面法线的加权和**：几何里已经有 `lobeShade` 属性和合并后的顶点，再加一个 `lobeCentre`（vec3，存最近瓣的球心）和 `lobeRadius`（float）。片元里 `Nlobe = normalize(worldPos - lobeCentre)`，用它替换 `normalLocal`，把 `PUFF_NORMAL_WEIGHT` 提到 0.5–0.7。
3. 加**视线厚度**代理：`thickness = clamp((cloudRadius - |p - centre|)/cloudRadius, 0, 1)`，乘进暗部——这一项是"空壳"和"体积"之间最便宜的桥。
4. 四条带换成 `fwidth` 抗锯齿的窄 `smoothstep`（宽度 ~0.02），并把 `PUFF_BAND_COLORS` 改成暖亮冷暗。

**路线 B（正确，3–5 天）：直接搬 painted-valley 的球并集**
`bg-cumulus` 已经证明了这套管线在你项目里能跑（`smin` + `puffTex` + `paint()`）。把近景 puff 改成同一套：一个包围盒/全屏 pass，`puffTex` 存瓣，`sphere-trace` 打表面，`paint()` 画。好处是远近两层云共用一套着色器、一套调色板、一套法线逻辑，`U4`（puff 绕过 toon 出口）和 `U1`（三套霾律）两个错位会一起消失。代价是每像素 raymarch——但近景 puff 只有 25 朵、包围盒小，`STEPS` 可以压到 24–32。

我的判断：**B 才是你要的"另一种方式"**。A 能把"很差"救到"能看"，但"能看出是 mesh"这个症状是空壳几何的必然结果，A 只能靠白纱遮。

---

## 4. 海：为什么"物理真实"就等于"效果一般"

`src/sea/material.ts` 的片元链（694 行，逐项）：

1. `normalBase` ← FFT 斜率纹理，`SLOPE_GAIN = 14`
2. `detailNormal` ← 4 m 平铺 value-noise 法线，`detailGate = smoothstep(1,2, texel/foot)`
3. `v = |dot(viewDir, normal)|` → `bodyCol = mix(grazing, deep, v)` —— **纯视角渐变**
4. Beer-Lambert 冠部透射 `exp(-max(0,0.45-hFrag)*2.4)`，`EXTINCTION_PER_METRE = 2.4`
5. `bodyLit = bodyTinted * (1 + nDotL*0.9)`
6. 逆光冠辉 `towardSun^5 · T · (1-v²) · 0.55`
7. `skyColor = skyColorTsl(reflect(viewDir, normal), …)` —— **真实天空查表**
8. Schlick `fres = 0.02 + 0.98(1+cos)^5`（`F0 = 0.0204`）
9. Jacobian 泡沫 `smoothstep(TH, TH+0.15, 1-jacobian)`
10. 太阳路：`GLOSS_POW = 96`、`GLINT_COS_THRESHOLD = 0.9995`、`GLINT_COS_BAND = 0.0005`、`SPARKLE_BOOST = 1.3`
11. 霾：`(1-exp(-d·2.5e-4))·0.55` + `smoothstep` 900→1900 强行收敛到 1

**这里的每一项都是"物理正确"的教科书实现。** 而 Ghibli/Zelda 的海恰恰**不是**这样：

- 菲涅尔让远处变成镜面 → 海天同色 → 海"消失"成一条反光带。手绘海是**远近同色**、只换明度。
- `GLOSS_POW = 96` + `GLINT_COS_THRESHOLD = 0.9995` 产生的是**密集高频闪点**——这是"真实感"最强的信号，也是最不像手绘的东西。手绘太阳路是一条**平滑的长条渐变**。
- 4 m 细节法线 + FFT 高频让水面到处是细碎噪点。手绘海是**大块可读的波形**，细节靠笔触而不是噪声。
- 泡沫是 Jacobian 阈值出来的不规则碎块。手绘泡沫是**有形状的**（月牙、团块、沿波峰的连续描边）。

### 建议（守住"不许回到 4 条 `step()` 色带"的红线）

红线说的是**颜色**不许分带，不是**光照**不许分带。所以：

1. **光照项量化，颜色项连续。** 把第 5 步的 `bodyLit` 换成 `fwidth` 抗锯齿的两段/三段 `smoothstep`（宽度 `~1.5*foot`），色相仍由 `bodyCol` 连续给出。这样既有硬边交界，又不违反红线。
2. **杀掉闪点，换画师太阳路。** `GLINT_COS_THRESHOLD` 那套 Cox-Munk 是性能上的聪明做法，但它就是写实感的来源。改成：一条沿太阳方位的 `smoothstep` 长条 + 沿 `nDotL` 的低频脉动（2–3 个八度，不是 96 次方）。
3. **细节法线降频、降权。** `DETAIL_REPEAT_METRES` 4 m → 12–16 m，`detailGate` 门槛抬高，让近处才有细纹。
4. **泡沫改成"沿冠部描边"而不是"阈值碎块"**：用 `transmittance` 的低值区做形状，再做一次形态学式的 `smoothstep` 拉宽，得到有宽度的描边。
5. **霾收敛律统一**（`U1`）：现在三套云三套律，近处 puff 在 860 m 就饱和到 0.78，海到 1900 m 才到 1.0，bg-cloud 到 12 km 才到 1.0。既然要风格化，索性统一成一条 `1-exp(-d/12000)`，三处共用 `src/palettes.ts` 的一个函数。

`?toon=1` 现在会把海一起量化（因为海体色**就是** `skyColorTsl`），而且量出来是随机色斑——那不是风格化，那是 bug。要么让海走自己的风格化出口，要么把 `toon` 限定在天穹。

---

## 5. 三条统一路线（如果你想一次到位）

参考三家的共同点，按"离你现在的代码有多远"排序：

| 路线 | 海的改法 | 云的改法 | 距离 |
|---|---|---|---|
| **A. 后期风格化**（你现在在做的） | 保留 FFT + 光学，加色带/描边 | 保留烘焙 cubemap，调色 | 最近，但你已经在它的天花板上了 |
| **B. 光照模型风格化**（我推荐） | 保留 FFT 几何，**换光照**：量化明暗 + 画师太阳路 + 描边泡沫 | **换光照**：解析簇法线 + 软自阴影 + 暖亮冷暗 | 中。两个子系统各改一个函数，不动管线 |
| **C. 造型风格化**（painted-valley 原教旨） | 丢掉 FFT，手搓 3–5 个大波形 + 滚动泡沫贴图 | 球并集 + sphere-trace + paint() | 最远，但最像参考 |

对 bg-cloud 你**已经在 C 上**了，只差把三个 bug 修完。对 puff，B 是性价比最高的（A 那条"空壳"救不回来）。对海，B 就够——海的问题从来不是几何。

---

## 6. 我改了什么（可一键回滚）

只动了 `src/bg-cumulus.ts`，**+93 / −9**，全部默认关闭：

- `uPaintForm` uniform（默认 0）：`ancScale` 在 `bounds.r` 和 form scale 之间切。
- `puffEntryTsl`：解析球并集入射距离。
- `?bgdbg=5`：form scale 着色（暴露 Bug B）。
- `?bgdbg=6`：解析入射 + 牛顿收敛 + `pS = p`（**大理石纹消失**）。
- `?bgdbg=7`：`paint()` 内部 `light/broad/up/open` 假色（**证明 Bug C 仍在**）。
- `debugMode()` 里补了 `bakeAll()`（首烘在构造期同步跑完，改 uniform 不重烘，否则 5/6/7 截图与基线逐位相同）。

**默认帧 `?qa=frozen&toon=0&puff=0` 三次重拍 sha256 均为 `9053B0E5…`，未变。**

不想要就 `git checkout -- src/bg-cumulus.ts`。想要留下当诊断工具就提交——它把"大理石纹到底哪来的"变成了三个可复现的开关。

复现脚本：`.dsh-shots/cap.mjs`（基线 / 5 / 6）、`.dsh-shots/cap-sun.mjs`（背光 vs 迎光）、`.dsh-shots/cap-ch.mjs`（7）。
跑法：`npm run dev`（本机 5173 被占，实际在 **5174**）→ `node .dsh-shots/cap.mjs`。

---

## 7. 还没查的

- `scripts/cloud-probe.mjs`（39 KB）没读，里面可能已经有你之前做的量化尺子。
- `src/in-cloud.ts` 只读了 API，没读白纱的具体着色——路线 A 依赖它。
- 海没做逐项 A/B（时间都花在云上了）。上面第 4 节的判断来自代码结构 + 截图的闪点密度，不是实测数字。如果要做，`?sea=debug` 已经在，加一个 `?seaband=N` 就能逐项关。
