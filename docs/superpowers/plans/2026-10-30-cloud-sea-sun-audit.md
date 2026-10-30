# 云·海·太阳审核与改造计划（2026-10-30）

对照：已搭场景（`src/sea-fft.ts` CPU-FFT 海、`src/clouds-compute.ts` 双 slab 体积云、
`src/puff-cloud.ts` 近景 mesh 云、`src/sky-webgpu.ts` TSL 天空、`src/post.ts` bloom、
`src/sun-road.ts` 高光路）+ 参考图 `ref-01-sunset-glide.png` + `open-water` 仓库
（Leonxlnx，pure WebGL2，4 级 FFT 级联 + Beckmann BRDF + Poisson 闪光 + Jacobian 泡沫）。

> open-water 是原生 WebGL2，不是 three.js——**搬的是思想不是代码**（spectrum 级联、
> 极坐标网格、glint 统计、泡沫生成），在 TSL 里重写。动手前先看它仓库的 LICENSE。

---

## 1. 层云：密度 / 垂直高度 / 材质 vs 参考图

**参考图事实（ref-01）：** 积云是**拔地而起的柱子**——云底贴着海平面/地平线，
云顶冲到画面上部；左侧整坨是暗紫色剪影（几乎全是 shadow 色），中间柱子是
白→粉受光面，柱间有大片晴空缺口；云底平、云顶菜花状。

**现状差距（3 条实的）：**

1. **没有垂直发育机制。** 主 slab 是 95~265m 的扁 Deck（厚 170m），还加了
   lens 高度罩（顶底压成 0）；噪声 `y*2.6` 把特征**压扁**，方向跟参考图（高耸）
   正好相反。puff mesh 顶约 135m。参考图的柱子按比例要 400~500m+ 高。
2. **覆盖太均匀。** `densityLow 0.5 / High 0.68` 全场同一阈值 → 云量处处一样；
   参考图是成簇的 bank + 大缺口。缺一个低频 coverage mask。
3. **暗部下不去。** `lightAmt` 只跟太阳夹角有关、跟厚度无关 → 云再厚也变不成
   参考图左侧那种整坨暗紫；`shadow 0x4a3370` 只出现在 band1 底端。

**优化（B3 批）：**

- **Tower 列**：加第三个 slab（95~480m），噪声 y 拉伸改压缩（`y*0.7`），阈值收紧
  （0.62~0.78，只让最密的核长成柱子），steps 8（远+高频细节少，可以便宜）。
- **coverage mask**：`noiseScale*0.15` 的低频 fractal 乘到阈值上（一处成簇、一处放晴）。
- **厚度致暗**：把累积 `transmittance` 引入 `lightAmt`（越深越暗，柱子根部自动变紫，
  跟参考图左柱一致），shadow 色比重随深度加。
- **puff 拔高**：部分 puff 垂直拉伸 1.5~2×（非均匀 scale），顶到 150~200m，
  承接 deck → tower 的中间尺度（现在 75~135m 是空的）。

## 2. 海：按 open-water 重构（思想级）

**现状：** 单 Phillips 谱 400m 域、RMS 振幅 0.34m、无长涌浪；1600m 平铺 patch +
280 段顶点位移（~5.7m 网格）；toon 高度带 + 斜率相关高光 + Schlick + 方位 road。
参考图里是**长涌浪排 + 宽 glitter 路 + 近处暗紫水**——单 400m 谱发不出长涌浪，
0.34m 在巡航高度看就是平的，这是"很差"的主因。

**open-water 值得搬的（按性价比）：**

- **B4-1 长涌浪级联**：加第二 FFT 域 2048m（或 3 波解析 Gerstner 沿风向
  `[0.82,-0.57]`），振幅提到 ~0.7m；toon 带重调（现在的 0.14/0.56/0.88 是按
  0.34m 调的，大浪会顶穿高光带）。
- **B4-2 网格**：极坐标相机中心网格（近密远疏，参考 `Water` 类：`a=center/ang`，
  `q=1+ang` 几何级数环）替代均匀 280 段；远场靠 mip/filtered 位移 + haze，
  近场顶点留给涌浪。这同时修掉"远水糊、近水平"。
- **B4-3 glint 统计**：现在的 `smoothstep(0.42,0.78,sparkle)*spec` 是均匀闪粉；
  改成 footprint 相关的稀疏闪（近处稀疏亮斑、远处连续路——open-water 的 Poisson
  `lambda` 思想， footprint 由 `dFdx/dFdy` 估）。
- **B4-4 泡沫**：现在的 foam 只跟波高走（`foamStart=2.2σ`）；改成**波高 + 坡度
  联合 + 下风向拖尾**（open-water 的 Jacobian + active breaking 简化版：CPU 纹理
  里已有高度/法线，加一阶差分估 steepness，阈值只取波峰前脸）。
- **不搬的**：完整 Beckmann PBR（跟 toon 美术冲突）、雨/闪电/Volumetric 云
  （范围爆炸）、GPU FFT ping-pong（CPU FFT 可单测是现有优点，保留）。

## 3. 太阳 disk 太大

**实锤数字：** `sky-webgpu.ts` 里 `disc = cos^220 × 2.4`。
cos^220 的半高宽：`0.5^(1/220) ≈ cos(4.5°)` → **disk 直径约 9°，真太阳 0.53°，
大了约 17 倍**。再加 bloom（threshold 0.82，disk 亮度 ~1.1 进 bloom，
strength 0.7 / radius 0.6）→ 向阳 = 白屏。参考图里太阳是 glow + 海上 road，
没有硬 disk。

**修（B1 批，最小）：** `pow 220 → 3200`（直径 ~0.7°），gain `2.4 → 1.4`；
haze 项 `cos^9×0.42` 不动（那是 glow 本体，也是海天交界 glow 的对齐基准，
`horizon.ts GLOW_POW/GAIN` 抄的它）；bloom threshold 0.82 先不动，改完截图验：
向阳时海面 road 和机翼可读、disk 缩成小亮点。附带把 GLSL 版 `sky-sunset.ts`
（如还在用）的同指数一起改。

## 4. 顶层云流速太快、太假

**实锤（3 条）：**

1. **风向反了。** 云漂移 `(−1.54, +0.92) m/s`（`windOffset=uTime*0.01` 除以
   `noiseScale 0.0065`），归一化 ≈ `(−0.86, +0.50)`；海风是 `(+0.82, −0.57)`。
   **几乎正相反**——云往东飘、海浪往西走，不假才怪。
2. **层流滑动。** 全场单一 offset，无高度切变、无方向扰动 → 整层 deck 像传送带。
3. **近底角速度大。** deck 底 95m、巡航 60m，头顶 35m 处的 150m 特征角速度
   ~2°/s，看着就是"呼呼地跑"。

**修（B2 批，跟 B3 同文件，先后做）：** 漂移方向对齐海风、基速 `1.54 → 0.9 m/s`；
加高度切变（offset 乘 `(0.6+0.8*hFrac)`，顶快底慢）；fine octave 加独立慢 morph
（只动细节不运移）；wisp 层比主层慢 20%（低空风小，符合直觉）。

---

## 分批与顺序

| 批 | 内容 | 文件 | 为什么这个顺序 |
|----|------|------|---------------|
| B1 | 太阳 disk 缩小 | `sky-webgpu.ts`（+GLSL 版如有） | 最小、最独立；海天 glow 对齐以它为基准，先定下来 |
| B2 | 云流速/风向/切变 | `clouds-compute.ts` | 纯 uniform 逻辑，单测好 pin；跟 B3 同文件，**先做避免冲突** |
| B3 | tower 列 + coverage + 厚度致暗 + puff 拔高 | `clouds-compute.ts`、`puff-cloud.ts` | 视觉主菜；依赖 B2 的风场（tower 用同一漂移） |
| B4 | 海重构（分 4 小步：涌浪→网格→glint→泡沫） | `sea-fft.ts`、`sea.test.ts` | 最大；每小步独立截图验，不断 toon 风格 |

每批：改前固定机位截图 → 改 → 同机位截图 + `npx vitest run` + `node scripts/smoke.mjs`。
B3/B4 涉及 shader 常数变化的，加单测 pin 住（参考现有 `horizon.test.ts` /
`sun-road.test.ts` 模式：纯函数镜像 + 阈值断言）。
