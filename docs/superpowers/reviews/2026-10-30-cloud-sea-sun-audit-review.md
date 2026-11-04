# 云·海·太阳审核与改造计划 — 技术评审

**被评审文档：** `docs/superpowers/plans/2026-10-30-cloud-sea-sun-audit.md`（105 行，B1–B4）
**评审基准：** 仓库实际代码（three 0.186.0，`three/webgpu` + `three/tsl`）、`artifacts/archive/dome-cloud-era/docs-qa/wisp-alt55-current.png` 实测像素、`three/examples/jsm/tsl/display/DepthOfFieldNode.js` 源码
**评审时间：** 2026-10-30

> 本评审只做审核与定位，未改动运行代码。原因见 §6：plan 自己的验收门是「改前固定机位截图 → 改 → 同机位截图」，本环境没有可用浏览器内核（electron 二进制缺失，仓库未装 playwright/puppeteer），截不了图就跑不了这道门。

---

## 0. 结论速览

> **⚠️ 先读 §7 和 §8。** §1–§6 是静态量测阶段的结论（旧 QA 图 + 代码）。Electron 装好后在真 WebGPU 后端实拍，**发现整条管线没有色调映射，中带 51.6% 的像素被截断在 250+**——这是当前画面「看不出是云」的主因，而 §1 的视线光照 / 配色 / lens 罩虽然代码事实全部成立，却不是这一帧的主导问题。**执行顺序以 §7.5 的 C0–C5 为准，§4 的 B0–B5 已被取代。** 另外 §8 的逐层隔离实验证明：巡航姿态下画面主导元素是 puff mesh，**两层体积云里 wisp 那层几乎不可见，建议合并成一层**。

方向对，四个判断里三个的数字是准的。但 **B3 按现计划写实现不出计划想要的效果**，而且**"顶端云像噪音"这个现象，plan 里没有任何一条命中真实病因**。

| 节 | 判定 | 说明 |
|---|---|---|
| §1 层云（垂直发育/覆盖/暗部） | ⚠️ 现象判断对，3 条修法有 2 条实现不了 | 三 slab 会与主 slab 重叠重复积分；`heightMask` 是 lens 且硬编码，塔柱建不出来 |
| §2 海 | ✅ 数字全部核对无误 | 6 个常数逐一验证通过；2 处需补（双域振幅分配、极坐标网格与世界钉扎冲突） |
| §3 太阳 disk | ⛔ 算术错，且归因不对 | `pow 220 → 3200` 给的是 **2.39°**，不是 0.7°；且真凶是**没有色调映射**（§7.1），disk 只占竖向 FOV 15% |
| §4 云速/风向 | ✅ 三条实锤全部核对无误 | 漂移 `(-1.54, +0.92)` m/s、海风 `(+0.82, -0.57)` 均确认 |
| （缺）顶端云形态 | ❌ 完全缺失 | 见 §1 + §7：静态阶段是视线光照/配色/lens 罩，实拍阶段是过曝 + puff mesh |

---

## 1. 顶端云为什么是「噪音纹理」而不是云

### 1.1 屏幕顶端此刻到底在渲什么

一条竖屏 9:16、垂直 FOV 60° 的相机，机位 = 飞机 + 6.8 m 高、向后退 30 m，瞄准点 = 飞机 + 0.9 m、前方 9 m。由 `camera-rig.ts` 常数算出的俯角 ≈ **−10.1°**（满速 FOV kick 到 69° 时 −8.6°）。因此**画面顶端只有 +20°~+26° 仰角**，不是天顶。

那个仰角区间里的渲染栈，从后往前：

| 层 | 对象 | 内容 |
|---|---|---|
| 1 | `sky_sunset_tsl`（r=800，背面，renderOrder −1000） | 垂直渐变 `#ff9a5a → #6b4fa1` + `cos^9` haze + `cos^220` disk |
| 2 | `clouds-wisp`（r=780，背面，renderOrder 1） | 5 步 raymarch，slab 30–82 m，`noiseScale×2.8` |
| 3 | `clouds-volumetric`（r=780，背面，renderOrder 2） | 12 步 raymarch，slab 95–265 m |
| — | `puff-00…13` | y 38–75 m、80–350 m 外，最大角半径 ~15°，**够不到画面顶部** |

所以「顶端云」= **两个 slab 的 raymarch 积分叠在渐变天空上**，一个 mesh 都没有。这一点本身没毛病，问题是接下来的四件事。

### 1.2 光照项吃的是视线方向，不是云

```ts
const sunWide  = pow(max(dot(dir, uSunDir), 0), 6.0);   // dir = 视线射线方向
const sunTight = pow(max(dot(dir, uSunDir), 0), 24.0);
const lightAmt = clamp(sunTight * 0.80 + sunWide * 0.20, 0, 1);
```

`dir` 是 `normalize(positionWorld - cameraPosition)`——**每像素的视线方向**。它完全不看云的形状、不看采样点的密度、不看光线走了多远。所以这套「光照」实质是一个**以太阳为圆心的屏幕空间径向渐变**，不是云的明暗。

`createTslCloudMaterial` 里另一个与形状有关的项是 `edge = 1 - smoothstep(0.35, 0.95, density)`，但它只喂 `rimAmt`，而 `rimAmt = smoothstep(0.30, 0.33, sunTight * edge)` —— 仍然被 `sunTight` 卡着。

**实测后果**（`artifacts/cloud-audit/shader-math.mjs`，按真实相机几何遍历上半屏 2040 个采样点）：

```
满速 speed01=1  pitch=-8.6°  fov=69
上半屏配色拆分: shadow 28.5%  base 35.4%  pink 36%
画面最顶 6 行(ndcY>=0.8): shadow 15 / base 19 / pink 0   ← 顶端 0% pink
```

`cos^24` 半功率角 13.7°，`cos^6` 27°。太阳仰角只有 **6.97°**（`SUN_POSITION = [60,35,-280]`）。所以仰角一过 20°，`sunTight` 掉到 0.28、`sunWide` 0.73，`lightAmt = 0.37`，`band2`（pink）的门是 0.58——**永远进不去**。剩下的只有 `base`，往外 10° 就跌到 `shadow`。

**一句话：顶端的云只有一个颜色，没有明暗。**

### 1.3 `base` 色和天空顶色本身几乎一样

`CLOUD_PALETTE.base = 0x7a5ba8`，`SKY_PALETTE.top = 0x6b4fa1`。两者在线性空间混合后的对比：

| 仰角 | 天空 sRGB | 云 base sRGB | ΔRGB(base,sky) | ΔL\* |
|---|---|---|---|---|
| 16° | 196,122,133 | 122,91,168 | 74,31,−35 | −14.3 |
| 20° | 171,109,144 | 122,91,168 | 49,18,−24 | −8.6 |
| 25° | 138,93,154 | 122,91,168 | 16,2,−14 | −1.6 |
| **30°** | 113,82,160 | 122,91,168 | **−9,−9,−8** | **+3.6** |
| **40°** | 107,79,161 | 122,91,168 | **−15,−12,−7** | **+4.8** |

**仰角 30° 以上，云的 `base` 和天空几乎同色（ΔL\* 3.6–4.8）。** 而 §1.2 证明了顶尖那片云恰好被锁死在 `base`。

于是画面顶端发生的是：**一个和天空同色的半透明体，唯一的可见变化是它的 alpha**。alpha 的变化来自密度场——也就是噪声明暗。这就是「完全就是噪音纹理而不是云」的最直接解释：**它不是云，它是给天空打的一层同色噪声遮罩。**

参考图 `ref-01` 里云和天的对比是 100+ 的 RGB 差（深紫云 vs 橙粉天），这是风格锚点，不是巧合。

### 1.4 高度罩把云压成一张 61 m 的薄饼

```ts
const hFrac = p.y.sub(slab.bottom).div(slabHeight);
const heightMask = smoothstep(0.02, 0.26, hFrac)
                    .mul( float(1).sub(smoothstep(0.62, 1.0, hFrac)) );
```

lens 形状、比例**硬编码**、按 slab 归一化。对主 slab（95–265，厚 170）算一下真正有密度的区间：

- 下限 `hFrac > 0.26` → y > 95 + 0.26×170 = **139 m**
- 上限 `hFrac < 0.62` → y < 95 + 0.62×170 = **200 m**

**实际有云的垂直空间只有 139–200 m，61 m 厚，悬浮在 slab 地板上方 44 m、天花板下方 65 m。**

这解释了两件事：
1. 永远不会出现参考图那种「云底贴着海平线」——云底被 `smoothstep(0.02, 0.26, …)` 抬起来了；
2. 永远不会有塔——天花板被 `1 - smoothstep(0.62, 1.0, …)` 压掉了。

plan §1 判断「没有垂直发育机制」是对的，但它把这归因于「slab 是 95–265 的扁 Deck」，没识别出**真正的元凶是这个 lens 罩**。加多少 slab 都白搭。

### 1.5 两个侵蚀 octave 都在 Nyquist 以下，且没有抖动

每次步进 `dt = span / steps`，`span = 170 / sin(仰角)`（上限被 `min(tFar, 900)` 截）。噪声特征尺寸 = 1/scale：

| 仰角 | dt | base worley (154 m) | erodeCoarse 1.7× (90 m) | erodeFine 4.3× (35.8 m) | 竖直 y×2.6 (59 m) |
|---|---|---|---|---|---|
| 8° | 58.1 m | 2.65 | 1.56 | **0.62** | **1.02** |
| 12° | 63.7 m | 2.42 | 1.42 | **0.56** | **0.93** |
| 20° | 41.4 m | 3.71 | 2.18 | **0.86** | **1.43** |
| 30° | 28.3 m | 5.43 | 3.19 | **1.26** | **2.09** |
| 45° | 20.0 m | 7.68 | 4.52 | **1.79** | **2.95** |

（数字 = 一个噪声特征里落几个采样点；要还原一个特征至少需要 2，理想 4+）

在画面顶端那个 20–26° 仰角区间：**`erodeFine` 一个特征只采到 0.9–1.3 个点，竖直方向 1.4–2.0 个点。** 权重 0.15 的 `erodeFine` 实际上不是在给形状加细节，是在给每个采样点塞一个**互不相关的随机数**。

同时 `t0` 上没有起始抖动（jitter/dither），12 个采样点是屏幕固定的，所以这不是白噪声，是**有结构的混叠**。

再叠上 `acc / max(alpha, 0.0015)` 这个归一化：12 个样本 × `stepAlpha 0.30` 的累积，数学上等于对噪声场做了一次 12 点盒式低通。**硬轮廓被平均掉了，剩下的是低对比度的斑块**——也就是截图里量到的：`near_flat_5x5_frac = 0.74`（74% 的像素和 5×5 邻域差不到 ±6），高频能量只占 3%。

**噪声被积分成了雾，雾里还留着噪声的斑。**

### 1.6 小结：四个成因的权重

| # | 成因 | 是否 plan 覆盖 | 证据 |
|---|---|---|---|
| 1 | `lightAmt` 是视线方向函数，无形状光照 | ❌ | §1.2 实测顶端 0% pink / 0% gold |
| 2 | `base` ≈ `SKY.top`，云天生无对比 | ❌ | §1.3 ΔL\* = 3.6–4.8 |
| 3 | `heightMask` lens 把云压成 61 m 薄饼 | ❌（归因错） | §1.4 算得 139–200 m |
| 4 | 侵蚀 octave 亚 Nyquist、无抖动、被积分成雾 | ❌ | §1.5 采样表 |

plan §1 的三条修法（塔柱 / coverage mask / 厚度致暗）只沾到一点边，**四条里一条都没打中**。这也是为什么现在的截图看不出来是个「云」，而是一张「噪声」。

---

## 2. 计划逐条审核

### 2.1 §1 层云 — 方向对，两条修法实现不了

**(a) ⛔ 「加第三个 slab（95~480m）」会重复积分。**
主 slab 是 95–265，塔 slab 是 95–480，两者在 95–265 完全重叠。`initClouds` 把每一层当独立 mesh 叠着画（renderOrder 1/2），重叠区密度会被算两遍，`alpha` 直接冲顶。plan 没提要不要缩窄/移除主 slab。

**(b) ⛔ 就算不重叠，塔也建不出来。** 见 §1.4：`heightMask` 是硬编码的 lens，且 `CloudSlabSpec` 里**没有任何高度罩参数**（只有 `bottom/top/noiseScale/stepAlpha/densityLow/densityHigh/cellular`）。`createTslCloudMaterial` 是三层共用的，加一个 slab 就等于把同一个 lens 套在 385 m 上 → 密集体在 95+0.26×385 = **195 m 到 95+0.62×385 = 334 m**。那是一根悬空的带子，不是柱子。要出塔必须把这个 mask 提到 spec 里，并且从 lens 改成**左肩硬、右肩长的「塔形」剖面**（底 95 m 直接满密度 → 顶 480 m 收拢）。

**(c) ⚠️ 「steps 8（可以便宜）」会把混叠做重。** 385 m / 8 步，仰角 20° 时 `dt ≈ 99.7 m`，对 154 m 的 base 特征只有 **1.5 采样/特征**——比现在的 12 步更糟。降步数必须配**降 octave**（把 `erodeFine` 在低步数档直接关掉）或加抖动，否则省下来的时间全变成噪点。

**(d) ⚠️ 「阈值收紧（0.62~0.78）只让最密的核长成柱子」** 方向对，但 `densityLow/High` 宽 0.16、`smoothstep` 本身是软的，收窄后柱子的**侧壁**会更糊而不是更硬。要硬边得改 `density = step(threshold, shape)` 级别的台阶 + 抖动，否则还是「噪声阈值」。

**(e) ✅ 「厚度致暗把 `transmittance` 引进 `lightAmt`」** 这条是对的，而且是四条里唯一真正朝「形状光照」走的一步。但它只是**加一个轴**，§1.2 的根问题（`lightAmt` 主体是视线方向）没解。建议直接换掉：用累积不透明度当光照，或者退一步用「采样点密度 × 步序」造一个伪法线。

**(f) ⚠️ 「puff 垂直拉伸 1.5~2×，顶到 150~200 m」** 可行，但 puff 是烘焙顶点色 + `depthWrite: true` 的实体 mesh，拉高后会与 slab 的体积云**在视觉上抢主导权**（实体 vs 半透明），plan 没讨论两者怎么分工。而且 puff 现在 `wrapPuffZ` 只做 Z 回收、Y 是固定的，拉高后 38–75 m 的走廊要重排。

### 2.2 §2 海 — 六个数字全部核对无误

| plan 说法 | 代码 | 判定 |
|---|---|---|
| 单 Phillips 谱 400 m 域 | `patchSize: 400`，`SEA_PATCH_SIZE 1600 / TEX_REPEAT 4` | ✅ |
| RMS 振幅 0.34 m | `amplitude: 0.34` + `measureRmsHeight` 归一化 | ✅ |
| 1600 m 平铺 patch | `SEA_PATCH_SIZE = 1600` | ✅ |
| 280 段顶点（~5.7 m 网格） | `SEA_GEOMETRY_SEGMENTS = 280` → 1600/280 = 5.71 | ✅ |
| toon 带 0.14 / 0.56 / 0.88 | `smoothstep(0.14,0.56)` / `(0.54,0.88)` / `(0.88,1)` | ✅ |
| foamStart = 2.2σ | `foamStart: cfg.amplitude * 2.2` | ✅ |
| 海风 `(+0.82, −0.57)` | `windDirection: [0.82, -0.57]` | ✅ |

两处需要补：

**(a) ⚠️ B4-1「加第二 FFT 域 2048 m + 振幅提到 0.7 m」会双计。** `buildSpectrum` 末尾按 `measureRmsHeight` 把每个域归一到 `cfg.amplitude`。两个域各自归一到 0.7，合成后的 RMS 是 √(0.7²+0.7²) ≈ 0.99 m，不是 0.7。要么给每个域单独的 `amplitude`（0.34 / 0.6，合成 √(0.34²+0.6²) ≈ 0.69），要么改成一个 `varianceSplit` 参数。plan 的说法会让浪高出预期 40%。

**(b) ⚠️ B4-2 极坐标网格与 `snapToPeriod` 世界钉扎冲突。** `far-field.ts` 现在把海 mesh **snap 到整周期**（`round(x/400)*400`），这是「浪不跟着飞机走」的唯一保障（注释写明滑动的后果是"robbed of any sense of speed"）。换成「相机中心极坐标网格」后 mesh 会连续跟相机，此时必须把 UV 改成**世界坐标采样**（`uv = worldXZ / 400`）而不是网格参数 uv，否则整个浪场会跟着飞机平移。plan 没写这一条，实现时极易踩。

### 2.3 §3 太阳 — 现象对，替换值算错了 20 倍

`cos^220` 的半高角：`arccos(0.5^(1/220)) = 4.546°` → 直径 **9.09°**，真太阳 0.533°，大 **17.1 倍**。✅ plan 这条实锤正确。

但 `pow 220 → 3200` 的结果：

| 指数 N | 半高角 | 直径 |
|---|---|---|
| 220（现状） | 4.546° | 9.092° |
| **3200（plan 目标）** | **1.193°** | **2.385°** |
| 64000 | 0.265° | 0.530° |

**plan 说 3200 给「~0.7°」，实际是 2.39°；要到 0.53° 需要 N ≈ 64000。** 差 20 倍——照 3200 改完 disk 还有 2.4°，仍然是大光斑。

另外两点：

**(a) ⚠️ 64000 次幂在 fp16/half-float 上不安全。** 渲染目标是 `HalfFloat`（`post.ts:184` 注释明确），`cos^64000` 在 half 精度下会直接下溢成 0。如果真要 0.53°，得换个写法：`smoothstep(cos(halfAngle), cos(0), dot)`，用角度阈值而不是幂次。**这一条比选哪个数字更重要。**

**(b) ⚠️ plan 说「附带把 GLSL 版 `sky-sunset.ts`（如还在用）的同指数一起改」——`src/sky-sunset.ts` 已经不存在了**，`main.ts` 只走 `initSunsetSkyTSL`。这条是过期引用，删掉即可，避免实现的人去找一个不存在的文件。

**(c) ✅ 参考图 `ref-01` 里没有硬 disk，只有 glow + 海上 road。** 所以最小改动其实是**把 disc 项整个砍掉或压到 0.2 以下**，只留 `haze`，比调指数更贴合参考图，也绕开 half-float 下溢。

### 2.4 §4 云速 — 三条实锤全部成立

| plan 说法 | 核对 | 判定 |
|---|---|---|
| 漂移 `(−1.54, +0.92)` m/s | `windOffset = uTime*0.01`，`x` 加、`z` 乘 −0.6 → `−0.01/0.0065 = −1.538`，`+0.006/0.0065 = +0.923` | ✅ |
| 归一化 `(−0.86, +0.50)` vs 海风 `(+0.82, −0.57)` 几乎正相反 | 点积 = −0.99 | ✅ |
| 近底角速度 ~2°/s | deck 底 95 m、巡航相机 66.8 m，头顶 28 m 处 150 m 特征 | ✅ 量级对 |

这条是 plan 里质量最高的部分，不用改。但 plan **漏了两个同文件、同批能顺手修掉的硬 bug**，见 §3。

---

## 3. 计划完全没覆盖的四个真 bug

### 3.1 `clouds-wisp` 不跟相机，17 秒后消失 —— ✅ 已修复并实测确认

`far-field.ts`：

```ts
const CLOUD_NAMES = ['clouds-volumetric'];   // 只有主层（修复前）
```

但 `initClouds` 建了 **两个** mesh（`clouds-wisp@renderOrder1`、`clouds-volumetric@renderOrder2`），是两次 `new THREE.Mesh`，各自有独立 `position`。`farField.update` 只 `moveTo(clouds, camX, camZ)` 主层。

相机沿 −Z 无限飞。以 `CRUISE_SPEED = 46 m/s`，**780 / 46 ≈ 17 秒**（满速 78 m/s 时 10 秒）后相机穿出 wisp 穹顶（r=780，圆心仍在世界原点），穹顶整个落到相机背后，**近景碎云带静默消失**。

这不是视觉瑕疵，是「飞一会儿云没了」。

**实机证据（修复前，`dsh_browser_*` 驱动真 WebGPU 帧）：**

```
camZ -349.9   bankZ -349.9   wispZ    0.0   ← 已偏离 350 m
camZ -421.1   bankZ -421.1   wispZ    0.0   ← 偏离 421 m，画面云体出现横向撕裂条纹
camZ -739.9   bankZ -769.9   wispZ    0.0   ← 偏离 740 m，逼近 780 m 穹顶边界
```

**修复：** `far-field.ts` 的 `CLOUD_NAMES` 改为 `['clouds-volumetric', 'clouds-wisp']`，新增 `findAll` 逐层 `moveTo`；`followed.clouds` 仍报主层名，不影响启动读数。`far-field.test.ts` 加一条回归（飞到 −1000 m 后两层 `position.z` 必须相等）。

**修复后实机验证：**

```
camZ -349.9  wispOffset 0     camZ -625.3  wispOffset 0
camZ -487.9  wispOffset 0     camZ -764.3  wispOffset 0
camZ -902.6  wispOffset 0   ← 已越过旧的 780 m 死亡点，仍然是 0
camZ -2665.4 wispOffset 0
```

`npx vitest run` → **210 passed (25 files)**。

**⚠️ 一个计划外的观察（已作废，见 §8）：** 修好之后云的观感变化远大于「一行 tow」应有的量——修前画面是粉白雾加横向条纹，修后是**带硬轮廓、分瓣、与天空对比明确的云块**（见 `artifacts/cloud-audit/baseline/live-after-wisp-tow.png`）。我当时据此推断「wisp 层承担的可读造型比注释假设的多」。**§8 的逐层隔离实验证明这个推断是错的**：那两张图是不同飞行时刻，观感差异来自 puff mesh 而不是 wisp。`puff-cloud.ts` 那句「wisp 已退化成雾气载体，不再承担造型」是**对的**。

### 3.2 wisp 画在主层后面，注释说的是反的

```ts
// The wisp deck draws first: it is nearer the camera than most of the bank, and at its low
// optical depth it must not be occluded by the bank's outer shell.
await buildLayer('clouds-wisp',        WISP_SLAB, CLOUD_WISP_STEPS, 1, CLOUD_WISP_STEPS),
await buildLayer('clouds-volumetric',  MAIN_SLAB, steps,              2, null),
```

两个 mesh **共用同一个 `SphereGeometry(780)`**，都是 `depthWrite: false` + `depthTest: true` + `BackSide`。所以两者的片元深度**完全相同**，`depthTest` 的 `LEQUAL` 一律通过，谁后画谁覆盖。

`renderOrder` 1 先画 → **wisp 被主层盖掉**。注释想要的是「wisp 在前所以不能被理层盖住」，但先画恰恰等于在后面。要让近处那层显形，`renderOrder` 必须**更大**（后画）。

现在 wisp 只在主层的 alpha 漏洞里透出来——这也解释了为什么它的「丝状云」在画面上几乎读不出来，而 top 上那片全是主层的 mush。

### 3.3 巡航高度就在 wisp 带里，wisp 是全屏遮罩

- `CLOUD_WISP_BOTTOM/TOP = 30 / 82`
- 相机 y = `START_Y 60 + CAM_HEIGHT 6.8 = 66.8` —— **在带内**
- `insideSlab = step(30, 66.8) = 1` → `up` 掩码恒为 1 → **向下的射线也照积**

所以巡航时 wisp 不是「碎云」，是**罩住整个画面的半透明噪声层**，连海面都被它压了一层。实测 alpha 上限（`artifacts/cloud-audit/shader-math.mjs`）：5 步 × 0.14，密度 0.3/0.5/0.8 → **0.193 / 0.304 / 0.448**。

`puff-cloud.ts` 的文件头已经写了「wisp slab 保留——它现在退化成雾气/whiteout 载体，不再承担造型」。既然如此，它在**不穿云的时候**就该是 0，而不是常驻 0.2–0.45 的噪声纱。目前的行为和设计意图不一致。

### 3.4 DOF 是个死效果，白跑一整趟

`post.ts`：`focalLength: 420`、`bokehScale: 1.1`、`focusDistance ≈ 30`。

three r186 `DepthOfFieldNode`：

```js
const signedDist = viewZNode.negate().sub(focusDistanceNode);
const CoC = smoothstep(0, focalLengthNode, signedDist.abs());   // focalLength 单位是「世界单位」
...
const sampleStep = _invSize.mul(bokehScaleNode).mul(CoC);        // _invSize = 1/screenSize
const sUV = uvNode.add(sampleStep.mul(bokeh64.element(i)));
```

`bokeh64` 是 Vogel 盘（半径 ≤ 0.994）。所以：

- **CoC**：云在 450 m 外、`|450−30| / 420 > 1` → CoC 饱和到 1.0，**完全失焦**；
- **实际模糊半径** = `bokehScale × CoC` 像素 = **≤ 1.1 px**。

即：云被判定「彻底失焦」，换来 1 个像素的模糊。**一个 64+16 tap 的双 pass 换来 1 px。** 这不是顶端糊的原因（1 px 糊不出一片 mush），但它是白花的预算，而且 `focalLength` 的参数语义被误用了 420 世界单位 ≈ 全画面失焦。要么把 `bokehScale` 提到 8–12 让 DOF 真的工作，要么关掉省一个 pass。

---

## 4. 修正后的批次建议

> **⚠️ 本节已被 §7.5 取代。** 浏览器实看之后发现「没有色调映射」是全局前提，所有颜色相关的调参都必须排在它之后。下表保留作为**逐条修法**的参考，**执行顺序看 §7.5 的 C0–C5**。

保留 plan 的 B1–B4 骨架，改三处、加一批：

| 批 | 内容 | 与 plan 的差异 |
|---|---|---|
| **B0**（新增） | `clouds-wisp` 跟相机 ✅ **已做**（见 §3.1）；wisp `renderOrder` 3（后画）⚠️ 待定（设计判断）；启动时把 wisp 密度压到「只在实际穿云时可见」 | plan 完全没有 |
| B1 | 太阳 disk | 现指数改 `smoothstep` 角度阈值（half-float 安全），或直接砍 disc 只留 haze；删掉 `sky-sunset.ts` 的过期引用 |
| B2 | 云流速/风向/切变 | 原样保留（数字全对） |
| **B3′** | 层云造型 | **先改两个结构性前提**，再谈塔：① `heightMask` 从硬编码 lens 提到 `CloudSlabSpec`，改成「底满密度 → 顶收拢」的塔形剖面；② 主 slab 与塔 slab **不重叠**（主 95–265 缩成 95–200 或直接合并成一个 95–480 的单 slab + 分层密度）。③ 降步数必须同时关掉 `erodeFine`。④ 光照从「视线方向」换成「形状/深度」，这一条是 B3 的真核心，不是可选项 |
| B4 | 海 | B4-1 加 `varianceSplit` 而不是两个 0.7；B4-2 明确「UV 用世界坐标、不做网格跟随」 |
| **B5**（新增） | 顶端分离度 | `CLOUD_PALETTE.base` 与 `SKY_PALETTE.top` 必须拉开到 ΔL\* ≥ 15；用 §1.3 那张表当回归基线，加一个纯函数单测把这个约束钉住（`palettes.test.ts` 已有模式） |

---

## 5. 证据与复现

| 文件 | 作用 |
|---|---|
| `artifacts/cloud-audit/legacy/measure_topband.py` | 真实 QA 帧的 8 条横带统计：平坦度 / 边缘密度 / 连通块 / 值级数 |
| `artifacts/cloud-audit/legacy/zoom_topband.py` | 顶端裁切放大 + 12 级等值线图；量 `near_flat_5x5_frac`、高频能量占比 |
| `artifacts/cloud-audit/shader-math.mjs` | 按真实相机几何重算上半屏配色拆分；采样密度表；alpha 上限表 |
| `artifacts/archive/dome-cloud-era/docs-qa/wisp-alt55-current.png` | 被量的真实帧（1669×917，游戏列 x 577–1093） |

关键实测值：

```
顶端 crop (516×340):  near_flat_5x5_frac 0.74   high_freq_energy 3.0%
上半屏配色 (满速):     shadow 28.5%  base 35.4%  pink 36%
画面最顶 6 行:         shadow 15 / base 19 / pink 0 / gold 0
云 base vs 天空 @40°:  ΔRGB (-15,-12,-7)   ΔL* +4.8
有效云层高度带:        139 m – 200 m  (61 m)
云 alpha @ 密度0.5:    0.858   @ 密度0.15: 0.425
wisp alpha @ 密度0.3:  0.193   @ 密度0.8:  0.448
```

## 6. 本次评审没做的事

- **没有做改前/改后的同机位对照。** 首次评审时本环境 `dsh_browser_open` 报 `no spawnable Electron binary`（electron 44+ 装包不再下载 ~158 MB 运行时，而插件探测是纯文件系统、不触发懒下载），只能拿仓库里已有的 `artifacts/archive/dome-cloud-era/docs-qa/wisp-alt55-current.png` 做静态量测。

  **该阻塞已解除：** 运行时二进制已装入 `~/.dsh/profiles/desktop/node_modules/electron/dist`（SHA256 校验通过，`dist/version` / `path.txt` / `electron.exe` 三项满足 `install.js` 的 `isInstalled()`），插件自身的 `resolveElectronPath()` 实测返回该路径，`dsh_browser_*` 已能在真 WebGPU 后端出帧（`backend=webgpu`、`fft sea · tsl clouds`、`quality=high`）。

  但**真正的同机位对照仍未做**：§3.1 的修复前后是两次不同的飞行时刻。需要的三机位基线（`?alt=60` 平飞、`?alt=60` 抬头、`?alt=200` 云中）还没建。

  **抓帧注意：** 掐掉动画循环后单次 `render()` 得到的帧是残的（HUD 读数自相矛盾、云穹顶露出三角面）。WebGPU surface 必须让 rAF 正常跑，截图前先 `await` 两三个 `requestAnimationFrame`；PNG 小于 ~150 KB 的基本都是残帧，丢弃重拍。
- **§3.1 之外的运行代码没动。** §3.2（wisp `renderOrder` 反了）**故意没改**：它需要一次设计判断——wisp 本来就罩住全屏，把它画到最前面会让雾感更重，这和「wisp 退化成雾气载体」的意图是否一致，得由计划的所有者定。
- **`lightAmt` 换成形状光照**是 B3 的核心，工作量最大且没有现成配方，本次只给了方向和判据（参考图对比度 ≥ 100 RGB），没有给实现。

---

## 7. 浏览器实看之后的修正（2026-10-30 晚，Electron 装好后）

上文 §1–§6 基于静态量测（旧 QA 图 + 代码）。浏览器通了之后在真 WebGPU 后端实拍了 alt 60 / alt 200 两档，**三条结论需要改写，两条新问题浮上来**。

### 7.1 最重要的一条：整条管线没有色调映射

```
$ grep -rn "toneMapping" src/
(无匹配)
```

`renderer.ts` 建 `WebGPURenderer` 时没设 `toneMapping`，three 默认 `NoToneMapping`。渲染目标是 `HalfFloat`（`post.ts`），中间值可以超过 1.0，但**输出阶段直接截断**。

天空的 haze 项（`sky-webgpu.ts`）在正对太阳处给 R 通道加 0.42，而地平线色 `#ff9a5a` 的线性 R 已经是 1.0：

| 离太阳角 | `cos^9` | haze 增益 | 天空线性 R | 结果 |
|---|---|---|---|---|
| 0° | 1.000 | 0.420 | 1.420 | 截断 |
| 20° | 0.571 | 0.240 | 1.240 | 截断 |
| 30° | 0.274 | 0.115 | 1.115 | 截断 |
| 40° | 0.091 | 0.038 | 1.038 | 截断 |
| 50° | 0.019 | 0.008 | 1.008 | 刚不截断 |

太阳方位在画面中心偏右、竖屏水平半 FOV 只有 18°——**整个画面都落在截断锥里**。

实拍实测：

| 帧 | 区域 | max-RGB 均值 | ≥250 |
|---|---|---|---|
| `live/alt60-live1.png` | 上 30% | 173.6 | 14.6% |
| `live/alt60-live1.png` | 中带 | **228.7** | **51.6%** |
| `live/alt200-a.png` | 中带 | 224.9 | 38.5%（≥240） |
| `artifacts/archive/dome-cloud-era/docs-qa/wisp-alt55-current.png` | 中带 | 165.2 | 31.5% |

**中带一半以上的像素是 250+。** 这解释了「云看不出是云」的当前主因：不是云的形状不对，是**云和天的关系被截断抹平了**。

计划 §3 把「向阳白屏」归因于 `cos^220` 的 9° disk。**disk 只占竖向 FOV 的 15%，且是局部**；真正让整帧发白的是 haze 项 + 无色调映射。先修 disk 不改这个。

### 7.2 巡航时画面被 puff mesh 主导，计划一个字没提

`live/alt60-live1.png` 里右侧那团占掉半个画面的白粉色物体是 `puff-cloud.ts` 的 mesh，**能看到 10–20 m 级的三角面**。

算一下它的真实尺寸：

- `IcosahedronGeometry(r, 1)` → 每个 blob **80 个三角面**（20 面 × detail 1 细分 4）
- 局部包围盒：X ±38 m、Y ±20 m、Z ±25 m（`cx` 沿 X 铺到 ±20，blob r 最大 18）
- `mesh.scale = 1.6–2.6` → **半尺寸最大 99 × 52 × 65 m**
- 近带 z = −80 … −350，相机比飞机再后 30 m → 最近处约 110 m

`atan(99/110) = 42°` 半角，而竖屏水平半 FOV 只有 18°——**一朵云就能横向盖满整屏**，而它只有 80 个三角面/bloB。

对比：左侧远处那簇小 puff 观感是好的（菜花状、有分瓣）。**同一套代码，远看对、近看散**。所以问题不是「puff 不该存在」，是「近带那几朵的尺寸 ÷ 细分 不平衡」。

### 7.3 穿云高度是一块无特征白板

`?alt=200`（主 slab 95–265 之内）实拍：上 30% 的 p5–p95 = 109–226，0% 截断但 38.5% ≥240，画面**几乎找不到任何结构**。

原因叠加：`whiteout01(206.8)` 撞满（`inCloud01` = 1 → × `WHITEOUT_MAX` 0.6）的 DOM 米色罩，加上体积云本身在那里也没有明暗（§1.2 的视线光照问题在这里最致命，因为整屏都是「正对云」）。

### 7.4 §1「顶端是噪音」的口径要改

| 帧 | 上 30% 亮度级数 | p95 | 判读 |
|---|---|---|---|
| 旧 `wisp-alt55-current.png` | 46 | 187.6 | 紫雾 + 多级噪声 → 真「像噪音」 |
| `live/alt60-live1.png` | **8** | **252.7** | 被打爆的白 → 不是噪声，是过曝 |

**修好 wisp 跟随后，「像噪音纹理」这个症状已经变成「糊成一片白」。症状换了，病因也换了。** §1.2 / §1.3 / §1.4 的代码事实（视线光照、base ≈ sky 色、lens 罩压成 61 m）**仍然全部成立**，它们决定的是「云没有明暗 / 没有塔」，但**不是当前帧的主导问题**。

### 7.5 修正后的执行顺序

原计划的 B1→B2→B3→B4 排序不再成立：**颜色相关的每一项都建在截断的基线上调，先修颜色是给自己挖坑。**

| 批 | 内容 | 验收判据（可测，不靠眼睛） |
|---|---|---|
| **C0** | 加色调映射：`renderer.toneMapping = ACESFilmic`（或 `Neutral`，更保色相）+ `toneMappingExposure`；确认在 `RenderPipeline` 半浮点链路里生效的位置 | 中带 ≥250 占比 **51.6% → < 5%**；上 30% 亮度级数 **8 → ≥ 20** |
| **C1** | 复位天空 haze 增益（`sky-webgpu.ts` 0.42；与 `horizon.ts` 的 `GLOW_POW/GAIN` 必须同步，海天线拿它对齐） | 上 30% p95 落在 **225–245**，不再贴顶 |
| **C2** | puff 近带造型：`detail 1 → 2`（80 → 320 面/blob）；近带 `s` 上限压低或 z 推远，使最近一朵半角 < 25° | 近带单朵屏幕占比 < 1/3；无可见 10 m 级三角面 |
| **C3** | 穿云质感：`WHITEOUT_MAX` 或白化层结构（让穿云是「有质感的白」而非「糊白」） | alt 200 的 p5–p95 跨度 **≥ 140**（现在 116） |
| **C4** | 原 §1 结构：`heightMask` lens → 塔形剖面；`lightAmt` 换成形状/深度光照；`base` 与 `SKY.top` 拉开 ΔL* ≥ 15 | 顶端出现可辨的柱状轮廓与明暗；参考图对比度 ≥ 100 RGB |
| **C5** | 海（原 B4） | 可并行，但要在 C0/C1 之后再定色 |

原 §2.4（云流速/风向）优先级降到最低：实拍里看不出问题，数字全对，别先动它。

### 7.6 需要设计判断、不能代决的两件

1. **wisp 的 `renderOrder`**（原 §3.2）。它是「近处那层」，但先画就被主层盖住；改成后画会让全屏雾感更重。要不要这层雾，取决于 wisp 在造型里的定位。
2. **puff 是不是云的近景形态**。§7.2 说明它现在既是最大视觉问题、又是唯一远看正确的元素。§8 的隔离实验进一步确认：巡航姿态下**画面上唯一可读的云就是 puff**，两层体积云加起来只有一小团软边紫云。先定这个，再谈 B3 怎么改。

---

## 8. 逐层隔离实验：两层体积云是不是多余的

§7.6 留了两个「要设计判断」的问题。其中一个的前提值得先验证：**画面里那两层体积云到底各干了什么活。** 把飞机冻住（`game.update` 换空函数，渲染循环照跑，所以是完整帧而非残帧），逐层 `visible = false` 后各拍一张。

冻结机位：`camZ = -475.4`、`camY = 66.8`、`fov 61.6`、`?alt=60`、`quality=high`。

| 变体 | 开着的层 | 画面里实际看到的 |
|---|---|---|
| `layers/A-all.png` | wisp + main + puff | 右侧占半屏的白粉巨块 + 左上一团紫云 |
| `layers/B-main-only.png` | main + puff | **与 A 几乎逐像素同观感** |
| `layers/C-wisp-only.png` | wisp + puff | 同 A（大块仍在） |
| `layers/D-no-puffs.png` | wisp + main | 巨块消失，只余天空 + 海 + 左上一小团紫云 |
| `layers/E-main-slab-only.png` | main | 左上一团**软边、低对比的紫色云**——体积云系统唯一可读的「云」 |
| `layers/F-wisp-slab-only.png` | wisp | **一层几乎看不见的暖粉色薄纱，零形状** |

（`layers/C-wisp-only.png` 与 A 的差异量级低于肉眼分辨，故不单列。）

### 8.1 结论一：占掉画面的那团不是体积云

`A` 与 `B` 几乎一致，`D` 里巨块整块消失——**那团白粉色的东西自始至终是 `puff-cloud.ts` 的 mesh**，和两层 slab 都无关。§7.2 的测算因此是对的：巡航高度下画面的主导元素是实心 puff，不是体积云。

### 8.2 结论二：wisp 层几乎不可见，我上一轮的推断作废

`E`（只留主层）与 `F`（只留 wisp）对比：主层给出那团软边紫云，wisp 只给出一层暖粉薄纱、**没有任何形状**。`A` 与 `B`（关掉 wisp）观感无差。这与它的参数一致：5 步 × `stepAlpha 0.14`、`WISP_DENSITY 0.35` → alpha 上限 0.19–0.45，且 `noiseScale ×2.8` 的特征被 5 步采样平均掉。

**所以 §3.1 里「wisp 承担的造型比假设多得多」的判断是错的**，`puff-cloud.ts` 原作者那句注释是对的。两张图观感不同，是因为它们是不同飞行时刻，不是 wisp 的功劳。

### 8.3 结论三：一层就够，而且很可能一层都嫌多

直接回答「体积云有两层、正常一层就够了吧」：

- **`renderOrder` 那个待决问题确实纯粹由「两层」产生。** 两个 mesh 共用同一个 `SphereGeometry(780)`、都 `depthWrite:false`、都是半透明——片元深度相同，只能靠 `renderOrder` 决定谁盖谁。**只剩一层，这个问题自动消失。**
- **但 puff 那个问题跟层数无关**，它是独立的 mesh 系统。
- **在巡航姿态下，体积云系统整体贡献很小**：`F` 几乎是空的，`E` 只有一小团，「全关」的画面（天空 + 海 + 太阳）反而相当干净。

### 8.4 因此建议把两个 slab 合并成一个

```ts
// 现在
WISP_SLAB = { 30..82,  scale×2.8, 5 steps, alpha 0.14, cellular:false }
MAIN_SLAB = { 95..265, scale×1,   12 steps, alpha 0.30, cellular:true  }
```

合并后只保留一个 slab，理由：

1. **消掉 `renderOrder` 待决项**（§8.3）。
2. **消掉 §2.1(a) 的重复积分风险**——原计划 B3 要加的塔 slab 本来就和主 slab 在 95–265 重叠。
3. **消掉「相机在带内导致 `up` 掩码恒为 1」的怪逻辑**（§3.3）：相机 66.8 m 落在 wisp 的 30–82 里，是现在 wisp 罩住全屏的原因；合并后 slab 底界可以定在 30 m 或 95 m，二选一，语义清楚。
4. **省一趟 5 步 raymarch**，以及 `in-cloud.ts` 里 `WISP_DENSITY` 的 max-not-sum 记账。

合并的正确形态不是「把 wisp 删掉、主层不动」，而是**一个 30→480 m 的单 slab + 高度密度剖面**：底界低于巡航高度（保留「能钻进去」的手感，`ALT_MIN 6` / `ALT_MAX 240` 让飞机进得来），顶界给塔留空间，剖面从「底满密度」往上收拢（§2.1(b) 说的塔形），而不是现在的 lens。

**唯一需要保留的判断：** wisp 存在的原始理由是「巡航高度上你真正穿过去的那层」。合并后如果 slab 底界定在 95 m，这个手感就没了——但现在的 wisp 也没提供它（`inCloud01(66.8)` ≈ 0.046，whiteout 不到 3%，等于没有）。所以这个理由目前是**空头支票**，经不起 §8.2 的隔离验证。

### 8.5 实验的边界

只在**一个姿态、一个高度（60 m）、一个时刻**做过。没验证：
- 主动爬升到 95–265 m 穿过主 slab 时两层的分工；
- 低质量档（`CLOUD_STEPS_LOW = 8`）下的表现；
- puff 在高速/俯冲时的远近回收边界。

要推翻「合并成一层」，只需要在上面任一情境里找到 wisp 不可替代的证据。

---

## 9. 按参考图重做 puff 造型（2026-10-30 晚实现）

用户确认意图：**参照 `ref-01-sunset-glide.png` 构建近景云（puff）**。§7.2 / §8 已定量证明 puff 是巡航画面的主导元素，所以这一节是实际动手记录。

### 9.1 参考图实测（`artifacts/cloud-audit/legacy/ref_probe.py`）

| 区域 | 高宽比 | 云体均色 | 平涂档数 | 结构 |
|---|---|---|---|---|
| 中央云柱 | **1.95**（52×101 px） | (124,75,141) | 6 | 大瓣竖直堆叠，左亮右暗一道分界 |
| 左侧云团 | ~1.0 | (133,90,145) | 6 | 大瓣、零高频细节、硬剪影 |

换算成建模参数：**单瓣直径占云宽 0.6~0.8**，轮廓是 5~6 段浅圆弧，整朵 4~6 个平涂色阶。
云体均色 (124,75,141) ≈ `CLOUD_PALETTE.base`（#7a5ba8），不是 `shadow`。

### 9.2 改了什么（`src/puff-cloud.ts`）

| 项 | 旧 | 新 | 依据 |
|---|---|---|---|
| 瓣的排布 | 沿 **X** 摊开 ±20 m | 沿 **Y** 堆叠主轴 + 两侧肩瓣 | 参考图高宽比 1.95 |
| 单瓣尺寸 | r 9~18（占云宽 ~0.35） | `lobeDiameter 0.62 × width` | 参考图实测 0.6~0.8 |
| 单瓣形状 | Y 压 0.62（扁饼） | 三轴 0.94~1.08（圆） | 参考图瓣是圆的 |
| 云整体 | 半尺寸 **99 × 52 × 65 m** | 23 × 35 × 23 m（缩放前） | 旧值近距离占满全屏（§7.2） |
| 细分 | `detail 1`（80 面/瓣） | `detail 2`（180 面/瓣） | 旧值能数出三角面（实拍确认） |
| 色阶 | 3 档（shadow/pink/gold） | **4 档**（shadow/base/pink/gold） | 参考图云体是 base，不是 shadow |
| 着色基准 | 逐顶点**法线** | 云心**径向** 0.72 + 法线 0.28 | 见 §9.3 |

比例全部收进 `PUFF_SHAPE`，`aspect` 一个数就能从「积云」切到「柱子」（对应 spec 里"不要擎天柱"那条拍板的开关）。

色阶分档抽成纯函数 `puffBandIndex(sunW)`（0/1/2/3），和 `horizon.ts` / `sun-road.ts` / `toon.ts` 同一写法，单测钉住。

### 9.3 过程中撞到的两个着色 bug

**(a) 逐顶点法线着色 → 每瓣各长一道明暗分界。**
一整朵云变成十几道亮月牙夹深折痕，实拍读成「一串珠子」而不是一朵云（`live/puff-v2-hero.png`）。
参考图的整朵云**只有一道**分界线。改成按「从云心指向该顶点的方向」着色：太阳侧的顶点无论自己朝哪都判受光，整团共享一个终结线，再掺 28% 表面法线让分界不是一根直线。

**(b) 漏了 `base` 档 → 云身整块掉进最暗的紫。**
只给 shadow/pink/gold 三档时，巡航视角下云是深紫团子（`live/puff-v3-cruise.png`）。
参考图云体均色最接近 `base`，补回第 4 档后云身有主色、受光面才有粉/金（`live/puff-v4-cruise.png`）。

### 9.4 还没解决的

1. **顶点色烘焙不出干净的 toon 边。** 硬分档画在顶点色上，分界只能沿三角面拓扑走，近距离会出现多边形锯齿（`live/puff-v3-hero.png`）。
   正解是把分档挪到片元着色（`MeshBasicNodeMaterial.colorNode` 用 TSL 算），代价是每像素一点 ALU；但那要重写材质，不在本次范围。
2. **云是浮在空中的团，不是贴着海平线的云带。** `PUFF_Y_MIN/MAX = 38..75` 让它们悬在巡航高度附近，参考图的积云是**云底压在地平线**上的。这条要么改布局走廊，要么靠 §8.4 的单 slab 底界来承接。
3. **`aspect` 用了 1.45**，是「有垂直发育的积云」而非参考图那根 1.95 的柱子——因为 spec（2026-10-30）拍板「云型只要 bank＋碎棉花，不要擎天柱状云」，而审核计划 §1 却要 Tower 列。**这两份文档还没和解**，当前按 spec 走。

### 9.5 验证

- `npx vitest run` → **215 passed (25 files)**；`puff-cloud.test.ts` 19 条，新增：高宽比区间、剖分数下限、四档阈值、`base` 必须是最宽档。
- 实拍：`live/puff-v2-hero.png`（3 档+逐瓣法线，错）→ `live/puff-v3-cruise.png`（3 档，过暗）→ `live/puff-v4-cruise.png`（4 档 + 云心径向，当前）。
- **没有做改前改后的同机位对照**：三次实拍是三个不同的飞行时刻。要严格对照得用 §6 说的三机位基线。
