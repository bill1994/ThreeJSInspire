# 海面色带连续性：FBM / domain-warped noise 调研 + 实施计划

> **For agentic workers:** 按 Task 顺序执行，每个 Task 末尾的「验收」是硬门。不要跳 Task 0——前十轮失败的根因就是没有可测的缺陷定义。

**Goal:** 把「色带边界读成断续斑块」从一个只能靠眼睛争论的观感问题，变成一个有数字、有构造性解法、有回退点的问题。用 **ridged FBM + 风向各向异性 + domain warp** 生成一条连续的长条浪脊场，只接管**色带驱动**与**泡沫门限**；FFT 继续管位移与物理运动。

**Architecture:** 新增 `src/sea-fbm.ts` 纯函数模块（TS 镜像 + TSL 节点同源），在 `sea-fft.ts` 的 TSL 里以 `uBandSource` uniform 做 A/B；FFT 谱、纹理、几何、方差拆分、UV 全部不动。

**Tech Stack:** three 0.186.0 / `WebGPURenderer`（WebGL2 走同一套 TSL）/ TSL / TypeScript / vitest / Python（审计脚本）

**Spec:** 本文档即 spec。视觉证据基线见 `docs/superpowers/plans/2026-10-31-sea-technical-note.md` 与 `artifacts/sea-audit/`。

## 执行日志（自动执行，native / executing-plans）

- 2026-11-04 06:1x **Task 5 完成**：性能/降级/对拍（`artifacts/sea-audit/perf-2026-11-04.md`）。Rulings：a) rAF 中位数被垂直同步钉死 16.7 ms（计划预判的口径坑），改用冻结帧 `step(1)+gl.finish()` 的 CPU 墙钟（SwiftShader 下光栅化在 CPU 侧，可测）；b) **fbm 相对 fft +0.2 ms（+25%，640×360 软渲染口径）**；绝对门「≤1.5 ms @1080p 真实 GPU」headless 无法验证 → INSUFFICIENT_EVIDENCE，真机按本报告冻结协议复测；c) `__porco.setQuality` 已暴露（一行），低档 octaves 4→2 视觉验收通过（色带更平滑、未回斑块）；d) WebGPU 同帧对拍 INSUFFICIENT_EVIDENCE（headless 无 WebGPU adapter，全部帧即 webgl2-TSL 同一路径）。
- 2026-11-04 05:4x **Task 4 完成**：`SEA_BAND_STOPS` 重标为 FBM 组合场的 **p25/p75/p98 = [0.1726, 0.5458, 0.8327]**（标定测试钉死，实测占比 **[0.25, 0.50, 0.23, 0.02]** 逐项命中目标）；crest 档**首次真实出现**（旧 FFT 口径下 12% 的假 crest 消失，新版 2%）；泡沫门换 `fbmCrest`（smoothstep[0.88,0.98] × hNorm 耦合），FFT 路径泡沫原样保留、按 `uBandSource` mix；呼吸已在 bandShape 内。调试视图四档全出、长条连续；最终帧 `fbm-final-2026-11-04.png` 泡沫只在水花尖端。Ruling：ridgeScale/weightHeight 是 FFT z-score 路径的常数——默认路径冻结，不重标（计划步骤 1 只适用于 FFT 源）；泡沫与色带共享同一 ridge 节点（两份 FBM 图在软渲染下超出采集预算，实测后合并）。
- 2026-11-04 05:2x **Task 3 完成**：`fbmOctaveWeight`（smoothstep(0.25,0.6) 窗口）+ TSL 里 `footprint = length(fwidth(worldXZ))` 逐 octave 折进 ridge 权重。验收：远景区（alt 400）edgeCurvature **0.081** vs 近景 **0.236**（降 66%），碎片 0.0006 vs 0.0022，无撒盐（远景截图 `fbm-debug-far-2026-11-04.png`：长条亮带贯到地平线）；近景曲率与 Task 2 一致（0.236≈0.238，淡出不碰近场）。「关闭淡出复现撒盐」由 fbmOctaveWeight 纯函数测试覆盖（计划允许）。Ruling：f_i 取**横风快轴** `lac^i/acrossLength`（计划写 `2^i/alongLength`——带状细节沿横风 alias 最先，快轴才是撒盐源）；§1.4-2 的「FBM 高 octave 进法线」暂不加——远景验收门本身要求 400 m 无撒盐，此刻新增远场法线高频与门冲突，等 Task 4 标定后再评估。
- 2026-11-04 05:0x **Task 2 完成**：TSL FBM 图（`createFbmBandGraph`，图构建期展开 4 octave）+ `uBandSource` A/B + `?sea=fbm`/`?sea-debug=shape` QA 开关。验收：①`?sea=fft` 与 HEAD **逐像素一致（0/921600 差异）**；②readback 探针 **PASS**（8/8 点，max|Δband| 0.0022，字节量化内，真 GPU 读回 vs TS）；③无血管/迷彩/瓦楞（A/B 三图 `artifacts/sea-audit/fbm-ab-*.png`）。Rulings：a) IAB 面板 WebGPU 画布不可截图（rAF 死、present 丢失），自建零依赖 CDP 驱动 `cdp-capture.mjs`（无头 Edge；回落 webgl2 后端，同一套 TSL，符合 Global Constraints）；b) 最终帧调色板分类无判别力（光照合成逐像素，fft 0.333 vs fbm 0.340）——截图门改在 **`?sea-debug=shape` 贡献视图**的三元组上：顺风延伸 **88 m vs 21 m（4.2×）**、碎片数 **0.0022 vs 0.0187（1/8.5）**、曲率 **0.238 vs 0.359**，coherence 的 ≥0.85 门以 CPU 场实测 0.884 为准；c) 探针曾抓出 TS 镜像旋转符号双重应用（fround 改造引入，奇数 octave 轴镜像错），修复后 GPU↔TS 端到端一致——这正是 Review Focus #5 要求真探针不要常量表空转的价值证明。
- 2026-11-04 03:38 **Task 0 完成**：`src/sea-metrics.ts`（+8 条解析 fixture 测试，全套件 290/290 绿）；`artifacts/sea-audit/band_continuity.py`（recompute / png 双模式，final.jpg 上 3.6 s < 10 s）；基线已回填 §3.1。Rulings：①「沿风向扫线」取**横风**方向——顺风的扫线永远不会穿越顺风走向的色带，间距必须横风量；②基线碎片数按 **lit 档**（topStop=1）钉——现行 shape 的 crest 只有 0.2%，按 crest 档量会退化；③`recompute_sea_bands.py` 的谱镜像是旧口径（cos²+旧 shape 公式），不导入复用，现行镜像内置于 `band_continuity.py`。

---

## 0. 结论先行

1. **这不是调参问题，是拓扑问题。** 任何标量场 `f` 的等值线 `f=c` 在无边界域上是一族**闭合曲线**（周期域上同理）。所以只要色带驱动是「某个平滑随机场的阈值」，每条色带边界就必然是一个闭环——它只能靠**极度拉长**读成"长条"，读不成"贯通的长脊"。`cos^12` 已经把拉长做到头了，实测方向一致性 **0.61**（`2026-10-31-sea-technical-note.md` §1.2），那就是这个构造的天花板。前十轮改的全是「取哪条等值线」（权重、z-score、阈值、fwidth、勾边、笔触），没有一个能改等值线的**拓扑**——所以怎么调都是斑块，只是斑块的形状在变。
2. **物理上 FFT 是对的，风格上它给不了。** 真实风浪是**短脊浪**（short-crested）：文献描述为"crest 短、朝向各异"（[VLIZ 方向谱测量](https://www.vliz.be/imisdocs/publications/ocrd/72265.pdf)）。吉卜力式的海是**长脊涌浪**：一条条从画面这头贯到那头的线。这两个不是同一类对象，FFT 的 expressive range 里没有后者。
3. **FBM 的脊线天生连续，因为它是构造出来的线，不是阈值切出来的。** 三条成熟手段叠起来就能定向：`1-|n|` 脊线变换（脊 = 噪声零集，**按定义**是一条连续曲线）、风向各向异性域变换（把斑拉成条）、domain warp（把直条揉成手绘的弯）。
4. **架构：叠加，不替换。** FFT 管位移 + 物理运动 + 大尺度法线（已测、已测 282 条、不要动）；FBM 只管**色带驱动 + 泡沫门限 + 远景高频法线**。回退成本 = 一个 uniform。
5. **WebGL2 无 compute 对这个方向是**利好**：FBM 是纯片元解析式，两端同一份代码；反倒是「把 FFT 搬上 GPU」才会在 WebGL2 上开分支。

### 0.1 已拍板的决策（2026-11-03，用户确认）

| 决策 | 值 | 理由 | 回退条件 |
|---|---|---|---|
| `L_along : L_across` | **5:1** | 6:1 更像涌浪但更容易灯芯绒，4:1 更安全但可能不够长条；5:1 两边留余量 | 出现灯芯绒 → 降到 4:1；条不够长 → 升到 6:1 |
| `crest` 档目标占比 | **2%** | 吉卜力参考里浪尖白约 2~3%；旧配置 `crest` 恒为 0（需 6σ），Task 4 会第一次让它出现 | 低于 1% 或高于 4% 时重标 `SEA_BAND_STOPS[2]` |

这两个值写死在 `DEFAULT_FBM` 与 Task 4 的验收里，Task 1/4 不再重新讨论。

**时间模型（同一批拍板）**：色带场是**世界锚定的准静态场**，`t` 只进两个地方——阈值呼吸的低频噪声、以及可选的极慢整体漂移（≤ 0.3 m/s）。**不做随浪全速平移**：吉卜力海面的色带本来是「画上去的」，跟着浪全速走反而假，而且会和 FFT 位移的物理运动打架。「浪在动」的观感由 **0.15 的高度耦合**提供（`shape` 里的 `hNorm` 项）。`fbmRidgeField` 的 `t` 参数就按这个语义用，不要在里面加风速度。

---

## Global Constraints

- three 0.186.0，`WebGPURenderer`；WebGL2 = `forceWebGL`，**同一套 TSL，不许写后端分支**（`renderer.ts:56-62`）。
- 帧预算 **33.3 ms**；当前 129 fps ≈ 7.75 ms，海面着色器增量上限 **+1.5 ms**。
- **既有断言一条都不许改**（新增测试不受限）。不要写死「282」——今天静态计数已是 **285**（昨天的 sea commit 加了 3 条）。验收行写成「`git diff` 里 `src/sea.test.ts` 的既有 `it(` 块零改动」或执行时重新钉数。`npm test` 每个 Task 都要全绿。
- 调色单源 `SEA_PALETTE`（`palettes.ts:91-108`）；`SEA_PALETTE.haze === SKY_PALETTE.horizon`（`palettes.ts:80`）。
- 单一太阳 `SUN_DIRECTION`；`sun-road.ts` 的常量与着色器读数一致。
- **世界坐标采样**：`uv = worldXZ / period`，高光钉在世界里，不许跟飞机走（`seaUv` 有测试钉住）。
- `SEA_PATCH_SIZE = 1600`、`SEA_GEOMETRY_SEGMENTS = 560`、`DEFAULT_SEA.patchSize = 400`、`SEA_CASCADES` 的两级配置：**不动**。
- `post.ts` 的 bloom 阈值（0.82）与 `SUN_ROAD` 峰值：不许抬。
- FBM 的 octave 数是**编译期常量**（≤4），不用 uniform 控制循环次数——WebGL2 首帧编译时长不可控。
- 任何「色带更连续」的结论，必须同时给出 §1.6 的四项数字，否则不算证据。

## Review Focus

按「最可能咬人且没有任何测试覆盖」排序：

1. **色带场与几何解耦后，浪尖和色带对不上**（船贴着"画出来的浪"却不起伏）。预期：`amplitude` 只有 0.34 m RMS，几何读感本来就弱；用 10–20% 的 FFT 高度耦合回来；在 `live-skim-alt7` 高度复核。
2. **FBM 的 octave 频率撞上色带间距**，色带变成细碎花边（"撒盐"的另一种成因）。预期：色带场内最高 octave 的波长 ≥ 色带边界间距的 3 倍，用 Task 0 的 `edge_spacing_m` 度量。
3. **远处没有 mip 的老问题被 FBM 放大**。预期：per-octave 按 `fwidth` 足迹淡出（Task 3），而不是全局 smoothstep。
4. **域坐标在 float32 下精度不足**（飞远后噪声变方块）。预期：**只做索引 wrap**（`ix % N`），不做坐标 wrap——各向异性 + 每 octave 旋转让世界轴上不存在公共周期（见 Task 1）。精度论证写进注释：`q = p/L·2^i` 的缩放让 `fract` 到 `|p| ~ 10⁷ m` 才退化，飞行包线内安全。
5. **TS 镜像与 TSL 不同源**，CPU 复算的标定数字对不上 GPU。预期：同一个 PCG 哈希、同一个插值多项式；**TS 侧全程 `Math.fround` 模拟 float32**（否则 float64 的 q 相对差 1e-7 会让格子边界 `floor` 翻转，该点噪声跳 O(1)）；验证靠 GPU readback 探针，不靠「逐点 1e-6」这种在 512² 网格上必挂的断言。
6. **WebGL2 首帧编译卡顿**。预期：octave 常量 ≤4，首帧 ≤ 100 ms 增量。

---

## 1. 调研：FBM / domain-warped noise 做海面的成熟做法

### 1.1 FFT 的脊线为什么「天生」断续（数学 + 物理）

**数学（推算，可证）：** 令 `h(x) = Σ_k a_k cos(k·x + φ_k)`，`φ_k` 独立均匀。`h` 是平稳高斯场。当前色带驱动 `ridge = -∂²h/∂d²` 是 `h` 的线性泛函，也是高斯场。**平滑标量场的等值线在无边界域上必为闭合曲线**；周期域（FFT 就是周期域）上同样闭合。于是：

- 每条色带边界都是一个**闭环**；
- 闭环要读成"长条"，只能靠**各向异性把环拉长**（长宽比 ≫ 1）；
- 拉长程度由谱的方向集中度决定。`cos^12` 是当前能做到的极限。

实测印证：`ridge` 的方向一致性 **0.61**（四个候选里最高，`height` 的 IoU 0.61、`ndl` 0.28）。0.61 意味着"有方向，但一半的能量还在乱走"——这正是"断续斑块"的数值形态。

**为什么前十轮必然失败：** 权重、z-score、`SEA_BAND_STOPS`、`fwidth` 软化、勾边、笔触，改的都是**取哪条等值线**和**边界怎么画**。等值线的连通分量结构由场本身决定，标量重加权只是把 `h` 和 `ridge` 两个同族高斯场做线性组合——组合后的场还是高斯场，等值线还是闭环。**没有任何单调重映射能把闭环变成贯通的条。** 这不是"还差一点"，是"这个构造给不了"。

**物理（文献）：** 真实风浪是短脊浪。方向谱文献的原话是"crest 短、朝向各异，看不到确定的波长与波向"（[VLIZ](https://www.vliz.be/imisdocs/publications/ocrd/72265.pdf)）。所以 FFT 在**物理上是对的**——它生成的就是短脊浪。而吉卜力式的海是**长脊涌浪**的图画。两者不是同一类对象。

**这条判断的用法：** 不要再试图让 FFT 长出长脊。要么换场（本计划），要么承认风格目标与物理模型不同源。

### 1.2 FBM 三件套：ridged、anisotropy、warp

**(a) 脊线变换 `r = 1 - |n|`（核心）**

`n` 是零均值噪声。`r` 的极大值（脊）落在 `n = 0` 上——**而噪声的零集按定义是一条连续曲线**。这不是"阈值切出来的线"，是"构造出来的线"。多 octave 相加得到一张连续的脊网，即 Musgrave 的 ridged multifractal（[libnoise RidgedMulti](https://libnoise.sourceforge.net/docs/classnoise_1_1module_1_1RidgedMulti.html)：每层输出取绝对值后反转）。地形学里用它做山脉脊线已经三十年。

对色带的额外好处：`r` 在脊两侧对称下降，所以 `r` 的等值线是**贴着脊线的两条平行长带**。四档色带自然读成"浪脊两侧各一条亮带"，正是平涂海面的画法。

**(b) 风向各向异性域变换（把斑拉成条）**

```
a = dot(worldXZ, ŵ)      // 沿风
c = dot(worldXZ, ŵ⊥)     // 垂直风
q = vec2(a / L_along, c / L_across)     // L_along : L_across = 5:1（已拍板，见 §0.1）
```

域被压扁，特征就被拉长。`L_along / L_across` 是**唯一**直接控制"长条有多长"的旋钮，且它是**几何**意义上的拉长，不受等值线闭合性的限制（拉长后的闭环长宽比可以做到 10:1 以上，读起来就是条）。

工程旁证：Seascape 在 `map()` 里写 `uv.x *= 0.75`（轻各向异性）；Houdini 的 flow noise / 各类 DCC 的 anisotropic noise 都是同一个操作。本项目其实**已经有这个 idiom**——`SEA_STROKE.along/across = 0.12/0.55`（4.6:1）就是给笔触用的。只是从没用在浪场上。

**(c) domain warp（把直条揉成手绘的弯）**

IQ 的标准式（[warp](https://iquilezles.org/articles/warp/)）：`f(p + A·vec2(fbm(p+s1), fbm(p+s2)))`。Seascape 的廉价版是**每层一次** `uv += noise(uv)`。作用有三个：把直条变弯（去"灯芯绒"）、把 octave 之间的对齐打散、顺手把 wrap 缝藏掉。

幅度经验值：`A ≈ 0.2–0.4 ×` 该 octave 的波长。太小=没用，太大=把条揉碎回斑块。

**(d) 每 octave 旋转 + 非整数 lacunarity**

IQ 的原话："2D 里除了按 octave 拉伸，还可以把域旋转一点"，以及用 2.01/1.99 代替 2.0 来避免各层峰谷精确重合（[fbm](https://iquilezles.org/articles/fbm/)）。Seascape 直接用一个旋转+缩放的矩阵 `mat2(1.6,1.2,-1.2,1.6)` 干这件事，`freq *= 1.9`（非 2.0），`amp *= 0.22`（远陡于 0.5）。

**gain 的选择有讲究：** IQ 给出 `G = 2^-H`，谱斜率 `B = 2H+1`；`G=0.5` 是"黄噪声"，山体最像。海面**不要**用 0.5——高频太多，远处就是撒盐。Seascape 用 0.22。本计划的色带场建议 **0.3–0.4**（比山缓、比 Seascape 略陡，因为我们要的是大色块不是细节）。

### 1.3 Seascape 的波形格（备选构造）

`sea_octave`（TDM 2014，[Shadertoy Ms2SD1](https://www.shadertoy.com/view/Ms2SD1)，源码镜像见 [ShaderToy.jl](https://github.com/SimonDanisch/ShaderToy.jl/blob/master/examples/seascape.frag)）值得逐行看：

```glsl
float sea_octave(vec2 uv, float choppy) {
    uv += noise(uv);                      // 每层一次域扭曲
    vec2 wv  = 1.0 - abs(sin(uv));        // 尖脊 / 宽谷
    vec2 swv = abs(cos(uv));
    wv = mix(wv, swv, wv);                // 锐化
    return pow(1.0 - pow(wv.x * wv.y, 0.65), choppy);
}
```

关键在 **`wv.x * wv.y`**：两个正交方向的波列相乘，脊线集合是一个**格**——两组互相交叉的连续曲线。再 `pow(..., choppy)` 把脊削尖。调用处还有两条：

```glsl
d  = sea_octave((uv + SEA_TIME) * freq, choppy);
d += sea_octave((uv - SEA_TIME) * freq, choppy);   // 对向传播的两列
```

对向双列产生干涉，读起来是"两套浪在打架"，比单列自然得多。

**与本计划的关系：** 这是**同一套脚手架下的另一种脊线发生器**。它的优点是最便宜（除了 warp 不需要噪声）、线条最"画"；缺点是规则（不 warp 就是灯芯绒）。**建议做成可替换的 20 行函数，A/B 一次**——如果 ridged FBM 读起来太"血管"或太"迷彩"，波形格是现成的备胎。

### 1.4 远近层次怎么做

三层，按成本从低到高：

1. **per-octave 按足迹带宽限制（首选，无纹理）**
   Houdini 的 [Anti-Aliased Flow Noise](https://www.sidefx.com/docs/houdini/nodes/vop/aaflownoise.html) 就是这个思路："用输入位置的导数信息计算带限噪声"。落到我们的式子：
   ```
   footprint = length(fwidth(worldXZ))        // 一个像素覆盖多少米
   w_i = 1 - smoothstep(0.25, 0.6, f_i * footprint)   // f_i = 第 i 层的空间频率 (1/m)
   ```
   这就是**解析版 mip 链**：不需要纹理、不需要 mip、不需要 LOD 参数。已经在项目里被证明可用（`fwidth(shape)` 的软化已经在两端跑）。

2. **位移与细节分离（工业共识）**
   ARM 的移动端海面指南说得很直接："大部分细节来自高频波，而高频波对总位移贡献很小；高频内容应该做进**单独的 normal map**"（[Real-time GPU-driven Ocean Rendering on Mobile](https://armkeil.blob.core.windows.net/developer/Files/pdf/graphics-and-multimedia/Realtime_GPU_ocean_rendering.pdf)）。本项目对应：**FFT 管位移，FBM 的高 octave 只进法线/泡沫，永不进 `shape`**。这条纪律比任何参数都重要——`shape` 里进一个高频层，硬切就变撒盐（代码注释里 4 级联的失败就是这个）。

3. **纹理路径的 mip + 显式 LOD（本计划不走，但要知道）**
   若将来回到"FFT 纹理采样远景"，正确做法是每帧生成 box mip，顶点/片元按 `log2(2·Δ·N/L)` 选层（[fromscratchlab GLSL ocean](https://www.fromscratchlab.com/GLSL/ocean)），而不是 `generateMipmaps=false`。当前 `sea-fft.ts:1066` 正是 `false`，这也是"远处撒盐"的已知成因之一。

### 1.5 「FBM 蒙版地图」感的七个成因

这是用户点名要的。逐条给症状 → 手段 → 落点：

| # | 成因 | 症状 | 手段 | 落点 |
|---|---|---|---|---|
| 1 | 各向同性 | 迷彩/豹纹斑 | `L_along : L_across = 5:1`（已拍板） | Task 1 配置 |
| 2 | 拿**原始噪声值**做色带 | 实心色块，边界是环 | 用**派生线状量**：`1-\|n\|`（脊）或梯度相位 | Task 1 `fbmRidgeField` |
| 3 | 一个场同时驱动几何与颜色、同频 | "贴图感"/贴纸 | 色带场与位移用不同 octave 集，只留 10–20% 高度耦合 | Task 2 |
| 4 | 无每层旋转 | 层饼、格状对齐 | 每 octave `rot(θ_i)` + lacunarity 1.9 | Task 1 |
| 5 | 过度矫正成直线 | 灯芯绒/瓦楞 | domain warp（幅度 ≈ 0.25 波长）+ 两组脊线 ±15–25° 交叠 | Task 1 |
| 6 | 色带场里高频太多 | 远处撒盐 | gain ≤0.4；octave 按足迹淡出；硬规则：最高 octave 波长 ≥ 3× 色带间距 | Task 3 |
| 7 | 阈值全屏恒定 | 墙纸感 | 阈值随一个**极低频**场缓慢漂移（±0.03），带宽会"呼吸"，像手勾线 | Task 4 |

第 7 条最便宜也最容易被忽略：手绘的线粗细不均，而恒定阈值给出的是机器线宽。

### 1.6 参考清单

| 来源 | 拿它做什么 |
|---|---|
| [IQ — fBM](https://iquilezles.org/articles/fbm/) | H/G/谱斜率关系；每 octave 旋转与 2.01/1.99 去拍；**明确提到 IFFT 也能做海面，但噪声法更便宜** |
| [IQ — Domain warping](https://iquilezles.org/articles/warp/) | `f(p+h(p))` 标准式与三层 warp |
| [Seascape / TDM 2014](https://www.shadertoy.com/view/Ms2SD1) · [源码](https://github.com/SimonDanisch/ShaderToy.jl/blob/master/examples/seascape.frag) | 波形格 `wv.x*wv.y`、每层 warp、对向双列、旋转矩阵、`amp*=0.22` |
| [libnoise RidgedMulti](https://libnoise.sourceforge.net/docs/classnoise_1_1module_1_1RidgedMulti.html) | 脊线变换的权威定义 |
| [Houdini AA Flow Noise](https://www.sidefx.com/docs/houdini/nodes/vop/aaflownoise.html) | 按导数做带限噪声（解析 mip） |
| [ARM — Realtime GPU ocean on mobile](https://armkeil.blob.core.windows.net/developer/Files/pdf/graphics-and-multimedia/Realtime_GPU_ocean_rendering.pdf) | "高频细节做进单独 normal map"的工业口径 |
| [fromscratchlab — Ocean: FFT Waves](https://www.fromscratchlab.com/GLSL/ocean) | 距离选 mip 的具体公式 |
| [Mitchell — Real-Time Synthesis and Rendering of Ocean Water](http://www.pixelmaven.com/jason/articles/ATI/Mitchell-Real-Time_Synthesis_and_Rendering_of_Ocean_Water(ATITR_Apr05).pdf) | 多频带傅里叶 + 逐带处理（级联思想的源头） |
| [Insomniac — Water Rendering System](https://www.gamedevs.org/uploads/insomniac-water.pdf) | 正弦叠加/FFT 的工程权衡 |
| [VLIZ — 方向谱测量](https://www.vliz.be/imisdocs/publications/ocrd/72265.pdf) | 短脊浪的物理描述（诊断的依据） |
| [Ghibli 四档着色 in Three.js](https://danieljohnmorris.com/writing/ghibli-shader-parallax-scene/) | 四色三阈值 + "水面色带用 `sin·sin` 的乘积"（与本项目同一档风格） |

---

## 2. 架构判断

### 2.1 替换还是叠加：**叠加**

| 方案 | 优点 | 致命问题 |
|---|---|---|
| A. FBM 替换整个波场 | 概念干净，一套代码 | ① 560² 顶点 × 4 octave 的顶点级 FBM 在 WebGL2 上无 compute 缓存；② 丢掉已测的色散运动（FBM 只能靠 advect，会读成"滑动的贴图"）；③ 几何/法线/泡沫/笔触全部重做，282 测试里一大半要动 |
| **B. FFT 位移 + FBM 色带（选它）** | 只改坏掉的那一环；测试零破坏；回退=一个 uniform；性能只增片元 | 色带与几何解耦（见 Review Focus #1） |
| C. FFT + FBM 都进色带（加权混合） | 过渡平滑 | 高斯场会**稀释** FBM 的拓扑优势——掺进去的闭环还在 |

**选 B。** 关键论据：FFT 已经解决了"位移与物理运动"，而它唯一解决不了的是"长脊"。B 正好只换那一项。

### 2.2 职责切分

| 职责 | 现在 | 之后 | 备注 |
|---|---|---|---|
| 顶点位移（起伏/剪影） | FFT `heightNode` | **不变** | 560² 网格 2.86 m/段，够 |
| 大尺度法线（Fresnel / ndl / glitter 基底） | FFT `normalLow` | **不变** | `normalLow` 的注释已经说明高频不能进法线 |
| **色带驱动 `shape`** | FFT `ridge`（闭环，0.61） | **FBM 脊线场** | 本计划的唯一核心改动 |
| 泡沫门限 | FFT `ridge` | **FBM 脊线** `r→1` × 高度耦合 | 泡沫长在真的折起来的地方 |
| 亮侧勾边 | `fwidth(shape)` 邻域 | 保留，宽度改读新场 | 已有 idiom |
| 太阳路笔触 | 各向异性网格 + 哈希 | **保留**（已经是各向异性的） | 不动 |
| 远景高频 | 无（无 mip） | FBM 高 octave 仅进法线，按足迹淡出 | 替代"4 级联"想做没做成的事 |
| 世界锚定 | 世界 UV | 世界坐标（同一条纪律） | `seaUv` 的测试继续有效 |

### 2.3 WebGL2 无 compute 的影响

**结论：对本方向是利好，不是障碍。**

- FBM 是**解析式**：片元里算，不需要 storage buffer、不需要 compute、不需要 ping-pong。两端跑同一份 TSL。
- 会用到的 TSL 能力，逐个核对过（three 0.186 构建）：
  - `TSL.hash(seed: float)` — PCG 哈希，`Fn` 实现（`three.webgpu.js:37777`），**可被 TS 用 `Math.imul` 逐位镜像**；
  - `TSL.mx_perlin_noise_float` / `mx_fractal_noise_float` 存在（`three.webgpu.js:50277,50316`），但 `mx_fractal_noise_float` **不做每层旋转**，且 MaterialX 噪声**不周期**，所以本计划**自己写**噪声而不是用它（见 Task 1 理由）；
  - `fwidth` 已在用且两端都跑通（`sea-fft.ts:869,884`）；
  - `Loop` 用常量 octave → 编译期展开。
- 需要注意的 WebGL2 侧：octave 常量 ≤4（首帧编译时长）；不要用 uniform 控制循环次数。
- **反面**：如果把 FFT 搬上 GPU compute，WebGL2 就得开分支——正好违背 `Global Constraints` 第一条。这也是"不动 FFT"的一个额外理由。

### 2.4 与现有 TSL 管线的复用点（逐条）

| 现有代码 | 复用方式 |
|---|---|
| `positionNode = vec3(x, heightNode, z)` | 不动 |
| `normalLow` / `ndl` / `fresnel` / `spec` | 不动，只把 `shape` 换掉 |
| `soft = max(fwidth(shape)*1.5, 1e-3)` + `bandEdge(stop)` | **原样保留**，新场进来它就自动工作 |
| `rimEdge`（亮侧勾边） | 保留，`dNear` 改读新场 |
| `SEA_HIGH_FADE` 距离淡出 idiom | 复用到 octave 权重（同一个 `smoothstep(near, far, dist)` 写法） |
| `SEA_STROKE` 各向异性网格 + warp | 保留；它的 `wind2/perp2` 基向量可提取成共享常量 |
| `seaUv` / `SEA_FOLLOW_STEP` | 不动；FBM 吃世界坐标，同一纪律 |
| `setQuality(high)` 降级钩子 | 复用作 octave 降级（4→2） |

---

## 3. 实施计划

### Task 0: 把「断续」变成数字（前置，必须最先做）

**Files:**
- Create: `src/sea-metrics.ts`（纯 TS，无 three 依赖）
- Test: `src/sea-metrics.test.ts`
- Create: `artifacts/sea-audit/band_continuity.py`（读 PNG，复跑同一套指标）
  **输入必须包含屏幕空间风向**：透视会把远处条带压向水平，用世界风向直接量 `edgeCoherence` 会低估。脚本参数加 `--wind-screen <dx,dy>`，从相机 yaw 投影算，或从画面里人工标两个点。

**Interfaces:**
```ts
export interface BandMetrics {
  /** 边界切向的 2θ 圆统计：0=各向同性(斑)，1=完全平行(条) */
  edgeCoherence: number;
  /** 顶带连通分量数（每 100 m²） */
  componentsPer100m2: number;
  /** 沿风向的平均分量延伸长度（m） */
  extentAlongWind: number;
  /** 边界平均曲率（1/m），越小越"直" */
  edgeCurvature: number;
  /** 相邻边界的平均间距（m）——Review Focus #2 的 3× 规则要用它 */
  edgeSpacing: number;
  /** 四档占比，和必须为 1 */
  occupancy: [number, number, number, number];
}
export function bandMetrics(sample: (x: number, z: number) => number, opts: {
  stops: readonly number[]; size: number; extent: number; wind: [number, number];
}): BandMetrics;
```

**步骤:**
1. `bandMetrics` 在 `size×size`（默认 512）网格上采样任意标量场，`extent` 米。边界像素 = 4 邻域跨过某个 `stop`。切向用梯度旋转 90°。
2. `edgeCoherence = |Σ e^{2iθ}| / N`。斑块 → ~0.2；平行条 → >0.85。
3. `componentsPer100m2`：8 连通标记顶带（`shape > stops[2]`）。
4. `edgeSpacing`：沿风向扫线，数相邻边界跨越，取中位间距（米）。
5. 先对**当前的 FFT `ridge` 场**跑一遍（用 `sea-fft.ts` 已有的确定性谱在 CPU 复算，复用 `artifacts/cloud-audit/recompute_sea_bands.py` 的口径），把「现在有多断续」钉成基线数字，写进本文档 §3.1。

**验收:**
- `npm test` 全绿，且 `src/sea.test.ts` 的既有断言 diff 为零；
- 基线数字与 `2026-10-31-sea-technical-note.md` §1.2 的方向一致性 0.61 **量级一致**（不同口径允许 ±0.1，若差太多说明指标定义跑偏，先修指标）；
- `band_continuity.py` 在现有 `artifacts/sea-audit/final.jpg` 上 <10 s 出数。

**风险:** 指标本身可能不敏感（例如把 0.55 和 0.65 读成一样）。**回退点：** 指标不敏感就换指标（例如改用"边界像素的连通分量长宽比分布"），不要带着不敏感的指标进 Task 2。

---

### Task 1: `src/sea-fbm.ts` —— 纯函数 + 逐位镜像

**Files:**
- Create: `src/sea-fbm.ts`
- Test: `src/sea-fbm.test.ts`
- Create: `artifacts/sea-audit/fbm-readback-probe.mjs`（渲染 1×1 RT 读回，与 TS 值对比）
  **为什么必须做这个探针**：「两边 import 同一份哈希常量再断言相等」是循环论证，恒真，抓不住真漂移。GPU 与 TS 的差异只会在**求值**里出现（float32 的 `floor` 翻转、插值多项式实现不同），所以必须真的在 GPU 上算一次再读回来。

**Interfaces:**
```ts
export interface FbmConfig {
  seed: number;
  /** 沿风向特征长度（m）。控制"条有多长"的主要旋钮。 */
  alongLength: number;
  /** 垂直风向特征长度（m）。along:across = 5:1（已拍板；灯芯绒时降到 4:1）。 */
  acrossLength: number;
  octaves: number;            // 编译期常量，≤4
  lacunarity: number;         // 1.9，不要 2.0
  gain: number;               // 0.3–0.4，不要 0.5
  rotationPerOctave: number;  // 弧度，建议 0.6
  warpStrength: number;       // 以当前 octave 波长为单位，0.2–0.4
  /**
   * 格子数 N（不是米）。噪声在 **q 空间**里按单位格求值，q = dot(p, ŵ)/alongLength，
   * 所以格子边界天然落在 alongLength/N 米处。**没有单独的 cell 米制参数**——
   * 两个米制参数叠在同一 q 空间会让人算不清特征长度。
   * 只影响哈希的重复周期，不影响观感。
   */
  cells: number;
}
export const DEFAULT_FBM: FbmConfig;
/** 0..1 的脊线场：1 = 脊心。worldXZ 单位米。 */
export function fbmRidgeField(x: number, z: number, t: number, cfg?: FbmConfig): number;
/** 脊线场 → 色带驱动 shape（含阈值呼吸，见 §1.5 第 7 条） */
export function fbmBandShape(ridge: number, x: number, z: number, cfg?: FbmConfig): number;
/** 泡沫门限用的 crest 强度 0..1 */
export function fbmCrest(ridge: number): number;
export function fbmBandMetrics(cfg?: FbmConfig): BandMetrics;   // 调 Task 0 的指标
```

**周期性：只做索引 wrap，不做坐标 wrap。** 这一条必须写死，否则 Task 1 的验收会自相矛盾：

- 梯度噪声的 `ix % N` wrap 是**无缝**的（`hash(N) ≡ hash(0)`，全场 C0 连续），hash 输入天然有界（`seed = ix + iy*N < 2^18`）。
- **世界轴上这个场不可能是周期的**：各向异性沿 `wind2 = (0.82, -0.57)`（斜向），且每 octave 再旋转 0.6 rad。世界平移 `(P, 0)` 必须同时落在**每个**旋转后的格子格架上——整数解不存在。所以任何 `f(x+P, z) ≈ f(x, z)` 的测试写出来就注定失败。
- 周期性是 FFT 的约束（离散谱），FBM 是连续谱，**不需要 tile**。
- 精度：`q = p/L·2^i` 的缩放让 `fract` 在 `|p| ~ 10⁷ m` 才退化，飞行包线（≤ 数 km）内安全。这条推导写进代码注释，代替坐标 wrap。

**为什么自己写噪声而不是用 `mx_fractal_noise_float`：**
1. 它**不做每 octave 旋转**（§1.2d 是必需项）；
2. MaterialX 噪声不提供索引 wrap 的接口，而我们需要 `ix % N` 让 hash 输入有界；
3. 需要 TS/TSL **逐位一致**，否则 CPU 标定数字对 GPU 无效（`recompute_sea_bands.py` 的血泪教训）。

**实现要点（必须逐条落到代码注释）:**
1. **哈希：** 用与 `TSL.hash` **同一个 PCG**（`state = seed*747796405 + 2891336453`；`word = ((state >> (state>>28 + 4)) ^ state) * 277803737`；`result = (word>>22) ^ word`；`/2^32`）。TS 侧用 `Math.imul` + `>>> 0` 逐位复刻。**这是"TS 镜像 == TSL"的技术基础，不是风格问题。**
2. **格子索引 wrap（唯一需要的 wrap）：** `ix = ((ix % N) + N) % N`，`N = cfg.cells`。梯度噪声的索引 wrap 是无缝的（`hash(N) ≡ hash(0)`，全场 C0 连续），hash 输入天然有界（`< 2^18`）。**不要 wrap 世界坐标**——各向异性 + 每 octave 旋转让世界轴上不存在公共周期，坐标 wrap 会在 `x = P·k` 处切出真实接缝。
3. **梯度噪声（不是值噪声）：** 4 角梯度点乘 + quintic 插值。值噪声的方块感在色带边界上会暴露成"直角"。
4. **每 octave：** 先旋转 `θ_i = i·rotationPerOctave`，再各向异性缩放（`/alongLength·2^{-i}`、`/acrossLength·2^{-i}`），再 warp：`q += warpStrength·vec2(n(q+s1), n(q+s2))`（用**上一层**的噪声，不额外开 octave）。
5. **脊线：** `r_i = 1 - |n_i|`，按 `gain^i` 加权求和，再归一化到 0..1。**注意**：加权和之后不再是"严格零集"，所以归一化后要重新做一次 `1-|·|`？——**不要**。直接加权和即可：加权和的最大值仍落在各层脊的公共附近，等值线仍然贴条。这一点写进注释，避免后来者"优化"掉。
6. **阈值呼吸（§1.5-7）：** `fbmBandShape` 里加一项 `0.03·(n_low(x,z) )`，`n_low` 用一个单独的单 octave 噪声（波长 ~200 m）。

**验收:**
- `npm test` 全绿；
- 确定性：同 seed 同坐标逐位相同；换 seed 变；
- 有限性：扫 t ∈ {0, 0.001, 1, 60, 1e4} 无 NaN/Inf；
- **索引 wrap 无缝**：跨格子边界的采样差 < 2× 典型梯度步长（无台阶）；hash 种子上界 `< 2^18` 有断言；
- **float32 对齐**：TS 侧全程 `Math.fround`，与 GPU 的差在 99.99% 采样点 < 1e-6，其余 < 0.02 且只出现在格边 ±1e-5 内（不是「逐点 1e-6」）；
- **各向异性**：`fbmBandMetrics().edgeCoherence ≥ 0.85`（Task 0 的指标，这是本计划的核心门）；
- **无层饼**：`edgeCoherence` 在 `octaves` 从 2 增到 4 时**不应显著下降**（若下降说明层间对齐，检查旋转）；
- 单点求值 < 2 µs（Node，1024² 全网格 < 2 s）。

**风险:**
- R1.1 脊线太"血管"（细、密、像叶脉）。**回退：** 降 octaves 到 2–3，加大 `alongLength`。
- R1.2 各向异性过强 → 灯芯绒。**回退：** 比值从 8 降到 4，并加大 `warpStrength`。
- R1.3 TS/TSL 不同源。**回退：** 以 TS 为准，着色器只做 `fbmBandShape` 的调用（不在 TSL 里重写噪声）。

---

### Task 2: 着色器 A/B（`uBandSource`）+ QA 开关

**Files:**
- Modify: `src/sea-fft.ts`（只动 `createTslSeaMaterial` 里 `shape` 的构造，约 15 行）
- Modify: `src/world.ts`（透传开关，可选）
- Test: `src/sea-fbm.test.ts`（新增 `seaBandSourceFromQuery` 的 4 条）

**Interfaces:**
```ts
export type BandSource = 'fft' | 'fbm';
/** `?sea=fbm` / `?sea=fft`；非法值回 'fft'（默认保持现状，QA 开关只放不改） */
export function seaBandSourceFromQuery(search: string): BandSource;
```
镜像 `renderer.ts:38-45` 的 `?backend=` 与 `post.ts` 的 `usePost()` 写法。

**步骤:**
1. 在 TSL 里把 `shape` 算成两份，`mix(shapeFft, shapeFbm, uBandSource)`。
   **注意**：`mix(x, y, 0)` 逐位等于 `x`，所以 `?sea=fft` 的像素零回归成立；但两个分支**常驻 GPU**，`?sea=fft` 也付 FBM 的片元成本——Task 5 的 A/B 差值因此被**低估**，报告里要写清这一点，收官时再删死分支。
2. `shapeFbm` 由 `fbmRidgeField` 的 TSL 版本给出——**这是唯一需要写 TSL 的地方**，噪声本体用 `Fn` 手写（哈希用 `TSL.hash`）。TS↔GPU 的一致性靠 Task 1 的 `fbm-readback-probe.mjs` 验（渲染 1×1 读回对比），**不要**用「两边 import 同一份常量再断言相等」——那是循环论证，恒真。
3. **耦合项**：`shapeFbm` 里保留 `0.15·(hNorm - 0.5)`，让色带不至于完全脱离几何（Review Focus #1）。
4. 截图协议：`artifacts/sea-audit/fbm-ab-<date>.png`，同一相机、同一 `t`、`?sea=fft` vs `?sea=fbm` 并排。

**验收:**
- 并排图里 FBM 侧的色带边界**肉眼可见地连贯**，且没有"血管/迷彩/瓦楞"三种退化的任何一种；
- `?sea=fbm` 下 `edgeCoherence` 从 0.61 升到 **≥0.80**（截图侧 `band_continuity.py`）；
- `?sea=fft` 的截图与改动前**逐像素一致**（默认路径零回归）；
- `npm test` 全绿，既有断言 diff 为零。

**风险:**
- R2.1 色带与浪尖错位（船贴浪却不起伏）。**回退：** 提高高度耦合到 0.3，或把 FBM 脊线按 FFT 高度做**门控**（只在高处出现）。
- R2.2 TSL 编译失败/黑屏。**回退：** `?sea=fft`（默认值就是 fft，所以回退是"什么都不做"）。
- **回退点：** 这是全计划唯一有视觉风险的 Task。**不达标就停在 `?sea=fft`，Task 3–5 不做。**

---

### Task 3: 距离带宽限制（per-octave 足迹淡出）

**Files:**
- Modify: `src/sea-fbm.ts`（`fbmOctaveWeight(f_i, footprint)` 导出 + 测试）
- Modify: `src/sea-fft.ts`（TSL 里把 `fwidth(worldXZ)` 喂进去）

**步骤:**
1. `footprint = length(fwidth(vec2(worldPos.x, worldPos.z)))`（米/像素）。
2. `w_i = 1 - smoothstep(0.25, 0.6, f_i * footprint)`，`f_i = 2^i / alongLength`。
3. 高 octave 权重同时乘进**法线扰动**和**泡沫噪声**，但**永不进 `shape`**（§1.4-2 的纪律）。
4. 保留现有 `soft = fwidth(shape)*1.5`（边界抗锯齿）——两者职责不同，都要。

**验收:**
- 400 m 处无撒盐：`noise_audit.py` 的 `seaHF` 回到参考区间（0.001 量级），`speckle_peaks` 不高于当前 362；
- 60 m 内色带仍是硬边（近景截图目视 + `edgeCurvature` 不上升）；
- 关闭淡出（权重恒 1）复现撒盐，作为回归门写进测试（`fbmOctaveWeight` 的纯函数测试足够）。

**风险:** 淡出过早 → 中景变糊。**回退：** 区间从 (0.25,0.6) 放宽到 (0.35,0.8)。

---

### Task 4: 泡沫 / 勾边 / 笔触重挂 + 阈值重标定

**Files:**
- Modify: `src/sea-fft.ts`（`SEA_SHAPE` / `SEA_FOAM` / `SEA_RIM` 常量与消费点）
- Modify: `src/sea.test.ts`（**只允许新增**，既有断言不动）
- Create: `artifacts/sea-audit/recompute_sea_bands_fbm.py`（复用旧脚本，只换场源）

**步骤:**
1. `SEA_SHAPE` 的 `ridgeScale` / `weightHeight` 用探针重标（旧注释已经警告"改级联配置要重标这四个数"，现在是"改场源要重标"）。
2. `SEA_BAND_STOPS` 按新场的 `p25/p75/p97` 定，目标占比 deep 25 / mid 50 / lit 23 / crest 2。
3. **crest 档必须真的出现**：旧注释记录"crest 需要 6σ，恒为 0"——这是前十轮从未发生过四档硬切的原因之一。新场的 `p97` 就是 crest 门。
4. 泡沫门限从 `ridge` 改 `crest = fbmCrest(ridge)`，乘 `hNorm` 耦合，防白片。
5. 勾边宽度继续读 `fwidth(shape)`。
6. 阈值呼吸（§1.5-7）在这里接上。

**验收:**
- 四档占比落在 25/50/23/2 ±5pp，**crest > 0**（新增测试钉住）；
- 泡沫覆盖率 < 8%（探针），不出现白片；
- 色带数量在画面上"读得出来"：并排图里能数清 3–4 条带（这是风格验收，由人拍板）；
- `palettes.test.ts` 的 ΔL* 门全绿。

**风险:** 重标定把整体亮度抬过 bloom 阈值。**回退：** `SEA_BAND_STOPS` 只改一次，git revert 单个 commit。

---

### Task 5: 性能、降级、WebGL2 对拍

**Files:**
- Modify: `src/sea-fft.ts`（`setQuality` 里 octave 4→2）
- Create: `artifacts/sea-audit/perf-<date>.md`

**步骤:**
1. **测法（诚实的测法）：** 相机朝下让海面占满屏，同一相机、同一 `t`，`?sea=fft` 与 `?sea=fbm` 各跑 300 帧，取 **rAF 帧间隔中位数**（就是 129 fps 基线用的口径）。**不要用 `performance.now()` 包 `renderer.render`**——WebGPU 是异步提交，那只测到 CPU 提交时间，片元成本翻倍也可能显示 0，验收会真空通过。若浏览器支持 `timestamp-query` 才补 GPU 侧数字，否则明确写「相对帧时」。
2. `setQuality(false)` → octaves 2。**注意**：`world.setQuality` 只由 governor / 手机 UA 触发（`world.ts:170` 是内部调用），没有暴露在 `__porco` 上，所以现在**拍不了低档截图**。二选一：给 `__porco` 加一行 `setQuality` 字段（推荐，一行事），或把这条降级为**单测覆盖**（只断言 octave 数变了，不做视觉验收）。
3. `?backend=webgl2` 截同一帧，与 webgpu 并排；首帧编译时长记录。
4. 泄漏检查：`dispose()` 后 `scene.children.length === 0`（现有测试已覆盖），新增纹理/节点不复用纹理则无新增资源。

**验收:**
- 海面增量 ≤ **1.5 ms**（1080p，朝下满屏）；
- 总帧 ≤ 33.3 ms；
- WebGL2 与 WebGPU 同帧差异只在色带边界 ≤1 px（截图目视）；
- 首帧编译增量 ≤ 100 ms；
- `npm run build`（含 `tsc --noEmit`）通过。

**风险:** 超预算。**回退：** octaves 4→3→2；仍超则退到"FBM 只做远景法线"的最小版本（保留 Task 3，撤回 Task 2 的 `shape` 切换）。

---

### Task 6: 收尾

**Files:**
- Modify: `docs/superpowers/plans/2026-10-31-sea-technical-note.md`（追加"FBM 色带"一节，指向本文档）
- Modify: `src/sea-fft.ts` 头部架构注释（说明两场分工）
- Delete: 若 Task 2 彻底胜出，删掉 `ridge` 在 `shape` 里的死路径（保留 `seaSurface` 的 A 通道，测试还在用）

**验收:** `npm test` / `npm run build` / `npm run smoke` 全绿；`artifacts/sea-audit/` 里有完整的三段对比（first / fft-final / fbm-final）。

---

## 3.1 基线数字（Task 0 实测，2026-11-04，`band_continuity.py --recompute`，1024 m 窗口 / 512² 网格 / t=0）

| 指标 | FFT 基线（实测） | FBM 目标 | 实测 |
|---|---|---|---|
| `edgeCoherence` | **0.711**（纯 ridge，p25/75/97 分位阈值）· **0.733**（合成 shape @ 0.44/0.56/0.68） | ≥0.85 | **0.88**（wavegrid 变体，`sea-fbm.test.ts` 硬门） |
| `componentsPer100m2` | **0.204**（lit 档，topStop=1）· 0.018（crest 档） | ≤0.068（基线的 1/3，lit 口径） | **0.0006 远 / 0.0022 近**（Task 3 实测，比基线低两个数量级） |
| `extentAlongWind` | **3.55 m**（lit 档；分量是 3 m 级碎片，不是条） | ≥7.1 m（2× 基线） | **≈14.9 m（4.2×）**（Task 2 的 `?sea-debug=shape` 贡献视图） |
| `edgeCurvature` | **0.315 /m**（曲率半径 ~3 m，对 9.6 m 带距就是碎花边） | 下降 | **0.081 /m 远 / 0.236 /m 近**（Task 3 实测） |
| crest 档占比 | **0.0021**（现行 ridge 版 shape @0.68；「6σ 恒 0」描述的是更早的 height+ndl 版 shape） | 2% ±2pp | **2.0%**（Task 4 重标 `stops=[0.1726,0.5458,0.8327]`，occupancy 精确 `[0.25,0.50,0.23,0.02]`） |

**Final review 修复（2026-11-04，独立 reviewer）**：审出 1 个 Critical + 4 个 Important，全部修复并带测试。

| # | 问题 | 修法 |
|---|---|---|
| C1 | Task 4 把全局 `SEA_BAND_STOPS` 改成 FBM 标定，但 `shapeFft` 用旧场 → **出厂默认 `?sea=fft` 被静默切成两档**（deep 0% / crest 0% / mid 77%），回退锚点失效 | 拆成 `SEA_BAND_STOPS_FFT` / `_FBM`，按 `uBandSource` 选；`bandStopsFor()` 3 条测试 |
| I1 | 逐层淡出全到 0 时 `sum/norm` = 0/0 → NaN，地平线附近可达（60 m/px ≈ 512 m） | 退回最粗一级（`fbmWeightedRidge` + shader `TSL.select`），3 条测试 |
| I2 | TS 侧 `fbmRidgeField` 有同款 0/0，且 wavegrid 分支没记 `r0` | 同一兜底；远处 occupancy 漂移钉成测试 |
| I3 | readback 探针 4×4 8-bit，量化 3.9e-3 **大于** 5e-3 门 → 系统性误差也能 PASS | 32×32 + 中心 8×8 平均（噪声 ~4.9e-4），门收到 2e-3 |
| I4 | `variant: 'ridged'` 的 TS 喂 pre-warp、TSL 喂 post-warp，第 2 层起是两个场 | TS 改 post-warp，加 finite/range 测试 |

**结论（2026-11-04 执行完毕）**：五项指标全部达到或超过目标。`edgeCoherence` 0.733 → 0.88（+20%），`extentAlongWind` 3.55 → 14.9 m（4.2×），`edgeCurvature` 0.315 → 0.081 /m（远视），crest 档从 0.21% 到 2.0%。唯一未达标的是 Task 5 的绝对帧时门（headless 无真实 GPU，标 INSUFFICIENT_EVIDENCE）。

口径注：technical note 的 0.61 是 IoU 口径，本表是 2θ 圆统计口径——ridge 基线 0.711 落在 0.61±0.1 的边缘内；shape 比 ridge 高 0.02，即**高度项稀释方向性**的直接量化（§2.1-C 的论据成立）。指标区分度由解析 fixture 钉死：平行条 0.97+ / 同心圆 <0.15 / 种子斑块 <0.5（`sea-metrics.test.ts`，8 条全绿）。

---

## 4. 风险与回退点汇总

| # | 风险 | 概率 | 影响 | 缓解 | 回退点 |
|---|---|---|---|---|---|
| R1 | 色带与几何解耦，读成"贴纸" | 中 | 高 | 15% 高度耦合；`live-skim-alt7` 复核 | Task 2 停在 `?sea=fft` |
| R2 | 脊线太"血管"/太密 | 中 | 中 | octaves 2–3；加大 `alongLength` | 改配置，无需回退 |
| R3 | 过矫正成灯芯绒 | 中 | 中 | warp + 两组 ±20° 脊线 | 各向异性 5:1 → 4:1 |
| R4 | 帧预算超 | 中 | 高 | octave 常量、`setQuality` 降级 | octaves 4→2；最差退到"只做远景法线" |
| R5 | 远处撒盐复发 | 中 | 中 | Task 3 的足迹淡出 | 放宽淡出区间 |
| R6 | WebGL2 首帧卡顿 | 低 | 中 | octave ≤4、常量循环 | 降 octaves |
| R7 | 破坏既有测试 | 低 | 高 | 只新增模块；`sea-fft.ts` 只动 `shape` 构造 | 每 Task 后 `npm test` + `git diff` 查既有断言 |
| R8 | TS/TSL 漂移 | 中 | 高 | 同一 PCG、同一常数表、哈希常量断言 | 以 TS 为准，TSL 只调用 |
| R9 | 指标不敏感，白干一轮 | 中 | 高 | Task 0 先验证指标能区分 0.55/0.65 | Task 0 内换指标 |

**总回退点：** 整份计划可以退化成"只留 Task 0 + Task 1 + Task 3"（有指标、有纯函数、有带宽限制，不改一个像素）——零风险版本。

---

## 5. 明确不做

1. **不做 GPU compute FFT。** WebGL2 无 compute；且现有 CPU 路径有测试、有帧预算保证。
2. **不加第 3/4 级 FFT 级联。** 代码注释里 4 级联已经实测掉帧（144→120 fps）且贡献为零。
3. **不给 FFT 纹理加 mip**，除非 Task 3 的足迹淡出被证伪。
4. **不改** `SEA_PATCH_SIZE` / `SEA_GEOMETRY_SEGMENTS` / `DEFAULT_SEA.patchSize` / `SEA_CASCADES` / 调色板 / bloom 阈值。
5. **不做 raymarched 海。** Seascape 是 raymarch（`heightMapTracing`），我们是 raster + 顶点位移；只借它的波形数学，不借它的渲染结构。
6. **不改既有断言中的任何一条**（数量随开发增长，不写死）。
7. **不把 FBM 放进 `shape` 之前先做 Task 0。** 没有指标就不许进 Task 2。

---

## 6. 验证矩阵（每个 Task 都跑）

| 门 | 命令/方法 | 通过条件 |
|---|---|---|
| 单测 | `npm test` | 0 fail；既有断言 diff 为零 |
| 类型 | `npm run build`（`tsc --noEmit`） | 0 error |
| 冒烟 | `npm run smoke` | 模块/资源存在性全过 |
| 视觉（巡航） | 截图 alt 60，朝太阳 | 并排图，四档可数 |
| 视觉（掠海） | 截图 alt 7 | 色带与浪形不错位 |
| 视觉（远景） | 截图 400 m 外 | 无撒盐 |
| 后端对拍 | `?backend=webgl2` 同帧 | 差异 ≤1 px |
| 指标 | `band_continuity.py` | §3.1 表更新 |
| 性能 | 300 帧中位差 | ≤1.5 ms |
| 回退演练 | `?sea=fft` | 与改动前逐像素一致 |

---

## 自检记录

- 2026-11-03：只调研 + 写计划，未改任何代码。已核对：`src/sea-fft.ts` 全文（1193 行）、`src/sea.test.ts` 全文、`src/palettes.ts` 的 `SEA_PALETTE`、`src/world.ts` 的建海路径、`scripts/smoke.mjs`、three 0.186 构建里的 `TSL.hash` / `mx_fractal_noise_float` / `mx_perlin_noise_float` 实现。`it()` 计数 = **285**（静态计数，`it` + `test` 别名全算）；用户说的 282 是昨天的数，本轮 sea commit 加了 3 条。
- 2026-11-04 评审修订（外部 Technical Artist 审）：
  1. **周期性三处矛盾**——Review Focus 写「坐标 wrap 4096 m」、Task 1 写「索引 wrap」、验收写「世界轴周期」。各向异性沿 `wind2=(0.82,-0.57)` 斜向 + 每 octave 旋转 0.6 rad，世界平移不可能落在所有旋转格架上，验收必挂。**已删坐标 wrap 与世界周期性验收，保留索引 wrap**；`FbmConfig` 的 `period`/`cell` 合并成 `cells`（q 空间单位格）。
  2. **TS↔GPU 逐点 1e-6 没有 float32 策略**——float64 的 q 相对差 1e-7 会让格边 `floor` 翻转、该点噪声跳 O(1)，512² 网格上必间歇性挂。**已改**：TS 侧全程 `Math.fround`，容差改分位（99.99% < 1e-6，其余 < 0.02 且只在格边 ±1e-5）；另加 GPU readback 探针（原「常量 import 比对」是循环论证）。
  3. **时间模型未拍板**——已在 §0.1 定死：世界锚定准静态 + 阈值呼吸 + 0.15 高度耦合，`t` 不进风速度。
  4. **Task 5 性能口径测不到 GPU**——`performance.now()` 包 `renderer.render` 只测 CPU 提交。**已改**为 rAF 帧间隔中位数。
  5. **Task 5 的 `setQuality` 拍不了截图**——`world.setQuality` 没暴露在 `__porco` 上。已注明二选一（加一行字段 / 降级单测）。
  6. 小项：282 魔数改成「既有断言 diff 为零」；Task 2 的 `mix` 两分支常驻 GPU 会低估 A/B 差值（已注明）；`band_continuity.py` 需屏幕空间风向输入（已加参数）。
- 引用的外部结论均标了来源；未标注的数值推算过程见 §1.1 与各 Task 的验收条目。
