# 云 / 海 / 陆地 对齐现状 · 交接书

**日期**：2026-11-17
**性质**：现状盘点，不是计划。给下一个接手「怎么执行」的模型当输入。
**基线 commit**：`e72fef8`（工作树干净）
**证据**：`?toon=0` / `?toon=1` 双帧同机位（本机 dev server，1264×805 视口，竖屏 9:16 画布）

---

## 0. 一句话结论

颜色层面已经结构性地对齐了（三条硬合约在码里、有单测钉住），**距离层面和量化层面没有对齐**；
陆地**零源码**，所以「三方对齐」目前实际是两方对齐 + 一个空位。
另外总案（painted-valley master）的 P0 闸门**从未实现过**，按它自己的规则全案本不该开工 ——
计划与现实已经脱节，接手方第一件事应该是裁决「是按总案继续，还是重写一份」。

---

## 1. 项目事实

| 项 | 值 |
| --- | --- |
| 栈 | three@0.186.0 + WebGPU/TSL；WebGL2 回退 |
| 包名 | `porco-sunset-dogfight`（竖屏 9:16 飞行） |
| 工作区 | `G:\DSHProject\ThreeJSInspire`，分支 `new-reset` |
| 跑起来 | `npm run dev` → http://localhost:5173/ |
| 测试 | `npx vitest run`（C3 计划记载基线 763 用例；本轮未复跑） |
| 构建 | `npm run build` = `tsc --noEmit && vite build` |
| 帧预算探针 | `node scripts/smoke.mjs`（模块白名单，删模块必须同步） |
| 帧预算目标 | 15.0 ms |

硬约束（改任何一行都要守）：

1. TSL only —— 禁 `ShaderMaterial`、禁 `onBeforeCompile`。
2. 禁静态 `import 'three/webgpu'`，只能运行时 `await import()`。
3. 调色板单源 `src/palettes.ts`，着色文件里不许写颜色字面量。
4. `src/post.ts` 的 `pipeline.outputColorTransform` 是唯一输出所有者。
5. TSL 与 JS 纯函数镜像必须两侧同改（`sea/water-shading.ts` 与 `sea/material.ts` 是典型对）。
6. 抓帧协议：`?qa=frozen` + `step(n)` + `gl.finish()`（rAF 被 vsync 钉死，测不到片元成本）。
7. 任一模块失败只降级该特性，绝不黑屏。

---

## 2. 三系统现状

### 2.1 云 —— 三层，各管一段景深

| 层 | 文件 | 规模 | 关键参数 |
| --- | --- | --- | --- |
| 背景积云（烘焙 cubemap raymarch） | `src/bg-cumulus.ts` 55 KB | 7–9 朵，实宽 1.5–9 km | `STEPS=64` :37、`BG_HAZE_METRES=12000` :39、`HAZE_NEAR_GAIN=1.3` :41、`STRIPS_PER_FACE=8` :45、`REBAKE_METRES=250` :137 |
| 云的摆位 | `src/bg-cumulus-layout.ts` | 半径公式在 :154 `Math.min(w*0.3, h*0.62)*(0.72+0.5*rand())` | `valid()` 只查角隙/总覆盖，**不查 puff 半径** |
| 近景穿云 puff | `src/puff-cloud.ts` / `puff-shape.ts` / `puff-field.ts` / `in-cloud.ts` | 环面 wrap，半窗口 1000 m | `PUFF_HAZE {NEAR 260, FAR 860, MAX 0.78}`、`PUFF_BAND_COLORS` 四档、`PUFF_LOBE_SHADE_GAIN=0.22` |

- 场 `bgMap` `src/bg-cumulus.ts:530`，上色 `paintTsl` :616，霾 :868 `1 - exp(-depth*1.3/12000)`。
- 调色常数单源 `src/bg-cumulus-paint.ts` 的 `PAINT_CONSTANTS`。
- 量具：`src/cloud-mask.ts`（立方图球面覆盖率，`cubeTexelSolidAngle` 闭式解、`CLOUD_MASK_LAYER=7`）、`src/cloud-metrics.ts`、`src/cloud-gates.ts`。

**当前主线卡点（大理石纹）**：

- 已提交 `853708f` 修掉命中点 `p` 的抖动源头，但 **C3 配比尚未进码**，`src/bg-cumulus.ts:583-590` 仍是旧式
  `const lump = float(0.55).sub(n1.r).mul(2.4)` + `billow(q.mul(2.7).add(0.3))` + `billow(q.mul(7.3).add(0.7)).mul(0.36)`。
- 待办计划 `docs/superpowers/plans/2026-11-16-bg-cumulus-marble-c3-puff.md`（修订 v2）。数值依据（V0 / 纯C3 / C3+puff1.25）：
  位移梯度 p99 `4.01 / 0.841 / 0.815`，foldRatio `1.56 / 0.34 / 0.27`，真撕裂率‰ `11.22 / 0.13 / 0.19`，bracketsMultiCross `21 / 1 / 1`。
  视觉对价：位移幅值 334 m → 146 m，最细档特征尺度 ~187 m → ~506 m（菜花疙瘩消失，表面变光滑馒头）。
- **⚠️ 阻塞**：G1 数值门依赖的 `artifacts/marble-verify/thit-numerics.test.ts` 与 `.json` **彻底丢失**
  （`git log --all` 空 = 从未入库；磁盘已随 2026-11-16 证据清洗消失）。要按原 G1 卡收口必须重写数值台。
  可复用的底料已移到仓外 `G:\DSHProject\_archive\ThreeJSInspire-scratch-2026-11-17\marble-diag-scripts\`
  （10 个 py：`veins.py` / `flatness.py` / `levels.py` / `roi{,2,3}.py` / `banding.py` / `diff.py` / `sheet.py` / `probe_stats.py`，
  外加 33 份 `metrics.json` 历史与 12 张 compare 图）。

### 2.2 海 —— 一整个目录，23 个文件

- 挂载：`src/world.ts:206-207`（dynamic import + try/catch 降级）。
- 核心 `src/sea/material.ts`（32 KB）：世界锚定 FFT 位移（顶点 `mod(worldXZ, tileMetres)`）+ 同心方环
  （各自 mipLod 三线性低通 + 一环重叠混合防接缝）+ 碎浪 cascade 半在片元。
- **水体色 = 连续 Fresnel 加权的天空自身色**（直接调 `skyColorTsl`）→ 海天在物理上不可能不一致，这是结构性保证。
- **四档 `step()` 平涂已删**，只活在 `?sea=debug` 伪彩路径。
- 雾：`WATER_OPTICS {HAZE_DENSITY_PER_METRE: 2.5e-4, HAZE_MAX: 0.55}` + 远端强制收敛
  `HAZE_CONVERGE_START=900` / `HAZE_CONVERGE_END=1900`（`src/sea/water-shading.ts:104-135`）。
  这条收敛是 2026-11-12 补的：指数雾在最远环只到 0.378，乘 `HAZE_MAX` 实际只剩 **0.208**，远海没收敛到天空色，
  地平线是一条硬线。
- 太阳路：`src/sea/sun-road.ts`，`ROAD_CEILING≈0.757` 特意压在 bloom 阈值 **0.82** 之下。
- 常数：`SPECTRUM_WIND_SPEED=9`、`SPECTRUM_WIND_DIR_RAD=0.212`、`SPECTRUM_SEED=20261106`、`CREST_REFERENCE_METRES=0.45`、Schlick `F0=0.02`。

### 2.3 陆地 —— **零源码**

- `src/` 下没有任何 land / terrain 模块。
- 只有两份计划：`docs/superpowers/plans/2026-11-05-land-flight-0-to-1.md`（B2/B3/B4/B5）、
  `docs/superpowers/plans/2026-11-13-land-b2-single-patch.md`。
- 总案指定的行动仓 `G:\DSHProject\ThreeJSInspire-reconstruct` **不存在**（`G:\DSHProject` 下没有同名目录）。
- 结论：三方对齐里的「陆地」目前是空位，一切对齐只能在云↔海之间做。

---

## 3. 已成立的硬合约（不要用「对齐」的名义去动它们）

| 合约 | 位置 | 形式 |
| --- | --- | --- |
| 太阳单源 | `src/palettes.ts` `SUN_DIRECTION` | 云 / 海 / 天 / 植被共用 |
| 海雾色 == 天空地平线色 | `src/palettes.ts:175,197` | `SEA_PALETTE.haze MUST equal SKY_PALETTE.horizon`，数值与 TSL 双份 |
| 调色单源 | `src/palettes.ts` | `PUFF_BAND_COLORS`、`SEA_PALETTE`、`SKY_PALETTE` |
| 海色取天空色 | `src/sea/material.ts` → `skyColorTsl` | 海天不可能色偏 |
| 唯一输出所有者 | `src/post.ts` `pipeline.outputColorTransform` | bloom 只返回 glow 需 add 回；dof 返回成品不可再 add |
| bloom 阈值余量 | `ROAD_CEILING 0.757` vs `0.82` | 余量 0.063，改 GLOW_GAIN 前必须重跑该表 |

---

## 4. 已确认的未对齐点

### U1 · 霾距离三套，渐近上限还各不相同

| 系统 | 形状 | 饱和 | 上限 |
| --- | --- | --- | --- |
| puff | `smoothstep(NEAR, FAR, d)` | 860 m | **0.78** |
| 海 | `(1-exp(-d*2.5e-4))*0.55` + 900→1900 强制推到 1 | 1900 m | **1.0** |
| 背景积云 | `1-exp(-depth*1.3/12000)` | ~12 km | **~1.0** |

后果：一帧里同时出现 puff（860 m 已饱和到 0.78 就停）和背景云（3 km 处才 0.28）时，
「越远越霾」在数值上不单调 —— 远处的云读起来比近处的云更**不**融进空气。
这是可以目测到的（`?toon=0` 默认帧：近景 puff 已经几乎融进橙色，左上那朵大积云仍然是饱和的橙粉色块）。

**要裁决**：是把三者收敛到一条共同的距离律（谁做参考？`BG_HAZE_METRES=12000` 是照 `clouds.js` 抄的形状），
还是明确承认它们分属三个景深层、只在每层的接缝处做交接？后者便宜，但必须写出「交接处不出现硬度突变」的判据。

### U2 · 量化粒度三套，且总案约束与现实冲突

| 系统 | 量化 |
| --- | --- |
| 天 + 云出口 | `toonQuantizeTsl`，`TOON_STEPS = [0.02, 0.08, 0.18, 0.32, 0.52, 0.75]` 六档，最高 0.75 |
| puff | 自带四档色带（`PUFF_BAND_COLORS`），**不过** toon 出口 |
| 海 | 0 档，连续光学 |

- 实测副作用：`?toon=1` 时海**也**被量化了 —— 因为海体色直接取 `skyColorTsl`，
  天出口的量化沿着反射传进了海面（glint 变成色块）。所以 `?toon=` 不是「只影响天」的开关。
- `?toon=1` 帧上 puff 仍是平滑渐变、天和海是硬色块，**硬度不匹配肉眼可见**。
- **与总案冲突**：`docs/superpowers/plans/2026-11-13-painted-valley-look-master.md` 的 Global Constraint #4 写
  「除飞机外全场禁量化（roadmap A3）：硬边只能用 `smoothstep` + `fwidth` 归一，不许 `step()` 切亮度」。
  但现实是天出口在整片量化，而 `fwidth` **在 `src/` 里零命中**（本次 `git grep -l fwidth -- src` 为空）。
  也就是说：总案这条约束一行都没实现，而它的反例（量化出口）正在生产里跑。

### U3 · 大理石纹只在 `toon=0` 存在

`?toon=1` 帧上背景积云内部纹理被出口量化整片吃掉，只剩一个奶白色块。
含义：C3 配比这番功夫只对 `toon=0` 有意义。**先裁决默认档到底是 `toon` 多少**，再决定要不要继续修大理石。
（现状 `toon` 缺省 0。）

### U4 · puff 不吃 toon 出口，所以它永远不合流

puff 的 `material.colorNode = bandColorNode()` 直接输出四档色，不经过 `toonQuantizeTsl`。
在 `toon>0` 的帧里，云（硬色块）与 puff（平滑渐变）是两种画法拼在一起。

### U5 · 陆地空位导致「地平线以上」和「地平线以下」没有第三方约束

现在地平线以上全归天空/云，以下全归海。陆地一旦进来，会同时压到云的投影距离、
海的近岸浪高与雾起点、以及天空的地平线色（`SEA_PALETTE.haze == SKY_PALETTE.horizon` 这条合约会被陆地打断）。
**在地形存在之前把云的霾距离律定死，很可能白做一遍。**

### U6 · 背景积云重烘是增量+全量混合，`uDebug` 分支刚修好

`src/bg-cumulus.ts` 的着色分支原先只在 `If(uDebug.equal(0))` 里执行，`?bgdbg=3|4` 时整支不跑，
增量重烘会留下 init 期 fallback 内容 —— 开关形同虚设。已在本轮提交 `e72fef8` 扩到 `equal(0).or(equal(3)).or(equal(4))`。
接手方修改这条分支时注意：**不要退回单值判断**。

---

## 5. 计划与现实的偏差（接手方必须先处理）

| 编号 | 偏差 | 证据 |
| --- | --- | --- |
| D1 | 总案 **P0 量尺从未实现** | `git grep -iE "cdf\|histogram\|edgeWidth\|strokeCoverage\|inkDensity" -- src scripts` → 零命中。`src/qa.ts` 全是 URL 参数解析器，无任何像素统计 |
| D2 | 总案 **P2 主语已消失** | 穹顶云 `dome-cloud.ts` 于 2026-11-13 随 cloud-layer-reduction 整体删除，取而代之的是 2026-11-14 的烘焙积云 `bg-cumulus`。P2「6 带 → 2 带」无对象可改 |
| D3 | 总案的 **P4 陆地仓不存在** | `G:\DSHProject\ThreeJSInspire-reconstruct` 无此目录 |
| D4 | 总案自己是「P0 不过全案不开工」，但 2026-11-13 之后所有实际工作（toon-look 期 1、bg-cumulus、大理石）都绕过了 P0 | 见 D1；`docs/superpowers/INDEX.md` 最新只记到 2026-11-14，未登记 11-16 的 p 修复 / 证据清洗 / C3 待办 |
| D5 | 总案 Global Constraint #4（禁量化、用 fwidth 硬边）与在跑的 toon 出口量化直接矛盾 | 见 U2 |

**所以「怎么执行好」这个问题，第一个答案不是排列 P1/P3 的顺序，而是先回答：总案还算数吗？**

三个选项，各有代价：

- **A. 承认总案作废，按现状重写一份**（推荐给它评估）：以 `src/cloud-mask.ts` + `cloud-metrics.ts` 为已有的量尺底座，
  把「四个数」缩成「遮罩覆盖率 + 档数 + 硬边宽度」三个能一键出的数，先立 P0'，再排期。
- **B. 补完 P0 再继续**：`fwidth` 归一、边缘梯度直方图、笔触覆盖率、ink 密度四个都要新写，工作量不小，
  且 D2 让它后面的一半排期无对象。
- **C. 直接进表现层**：放弃量化可测，靠抓帧目检推进。便宜，但「变好了没有」会退化成感觉，与总案开篇的立场相反。

---

## 6. 给接手模型的问题清单

1. 霾距离律要不要统一？如果统一，参考哪一套（`1-exp(-d*ρ)` 的 ρ 取多少，饱和距离定在哪），
   以及 puff 的 `MAX 0.78` 这个「云再远也得读成云」的上限要不要保。
2. 默认档 `toon` 到底是 0 还是 >0？这决定 U3（大理石要不要继续修）和 U4（puff 要不要接出口）的优先级。
3. 量化与「禁量化」冲突怎么收口：是撤掉出口六档、改成 `smoothstep+fwidth` 硬边（贵，但符合总案），
   还是承认「出口六档」是新方案的一部分、把总案约束 #4 改写（便宜，但要重定基线并重跑门）。
4. 陆地什么时候进？如果在云的霾距离律定死之前进，U5 会让那份工作返工。
5. C3 大理石配方要不要在没有 G1 数值台的情况下先落码、用目检过渡？还是先把数值台从
   `_archive/.../marble-diag-scripts/` 那批 py 里拼回来？

---

## 7. 红线

1. 不许为了「对齐」把海的连续光学退回四档平涂 —— `src/sea/water-shading.ts` 头部已写清为什么出色块。
2. 不许在着色文件里写颜色字面量，一律走 `src/palettes.ts`。
3. 不许给云、山、海描边（只给飞机）。
4. 不许悄悄改默认帧：要么挂开关默认关，要么明确重定基线并重跑门。
5. 不许让 puff 加采样 —— 它是当前 p95 元凶（27.9 → 14.1 ms 的历史记录在总案 Constraint #7）。
6. 不许在接缝契约定稿前烘布局图（陆地进来时）。
