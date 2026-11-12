# 三渲二 Look 开关（海 + 天 + 云整体）设计

> 状态：**已定稿待执行**。语义与范围经主人拍板（2026-11-12 chat：「三渲二，整体切换」）；本文件把调研结论钉成可开工的设计。实施顺序：修复清单 Phase 1 之后，writing-plans 另出任务级计划。

## 0. 为什么现在做

主方向是三渲二（3D 渲染成 2D 手绘感）。项目现状**半只脚已经在了**：近景 puff 是四档 toon 分档（`puffBandIndex` 单源、TSL 逐片元），但三个「连续渐变」的源头挡住了整体观感——天穹能量场与 ramp（连续）、海面反射（连续，且字面复用天穹函数）、dome 体积光照（Beer-Lambert + HG 连续明暗）。本设计给这三处加一个**统一的 toon 档位化总闸**，让整幅画面在海天云一体的前提下切出手绘感。

## 1. 架构事实（设计所依赖的现状，全部已核实）

1. **海天一致铁律**：海面反射字面调用天穹同一个 `skyColorTsl`（`src/sea/material.ts:16-17`，import 于 ：42；「sea and sky cannot disagree」）——**任何海面风格化必须经由这个共享函数**，单独动海必撕裂。
2. **双镜像纪律**：`skyColorTsl`（TSL）与 `skyColorJs`（JS 镜像）成对存在（`src/sky-webgpu.ts` / `src/sky-color-js.ts`），镜像对齐有测试守卫——天穹出口的任何改动**必须两侧同步**。
3. **look 开关先例**：P2 已建 `uLook` uniform 模式（soft/flat 双 look：只动颜色输出、alpha 与密度一行不碰，`dome-cloud.ts:392`；测试钉「flat cannot reshape the cloud」）——toon 总闸沿用同款纪律。
4. **调色单源**：`SkyTrackState`（sky-track.ts:44-77）经 `syncSun` 扇出（main.ts:309-359）；`qa.setTrackPatch`（`DebugTrackPatch = Partial<SkyTrackState>` 整字段替换）与 `qa.setHazeEndpoints` 是现成的数据推送通道。
5. **jitter 现成**：dome march 已用 `interleavedGradientNoise`（dome-cloud.ts:332）——档间抖动不用新造。
6. **bloom 预算**：0.82 阈值 + post.ts:46-60 预算表 + sky-color-js.test.ts:150 守卫。

## 2. 目标 / 非目标 / 反目标

**目标**：一个总闸（`uToon` 0..1 过渡），开启后天、海、dome 云整体呈现三渲二观感（档位化明暗 + hue-shifted 调色板）；puff 在新调色板下自然跟上；`?debug=color` 面板可切换、可过渡、可复现。

**非目标（一期不做）**：屏幕空间描边/rim light（成本最高，色相分层已够「平」）；puff 分档机制重构（已是 toon）；月相/时间轴联动（方案 B 各期独立）；WebGL 回退。

**反目标（做出来就算失败）**：
- 默认路径（`uToon=0`）与现状有任何一个字节的差异；
- 海天不一致（toon 化只落一边）；
- 破坏 alpha/密度/几何——toon 只动颜色输出与光照分布，**不 reshape 云形**（uLook 纪律）；
- 新造第二调色源（一切颜色仍必须流经 `SkyTrackState` 或其预设快照）。

## 3. 已定案（主人批准，2026-11-12）

- **整体切换**：海+天+云一起，不做逐对象独立开关（海天铁律 + 混搭必然难看 + 省一条撕裂回归面）。
- 默认关：`uToon=0` 逐位不变；参考档恒等测试一行不碰。

## 4. 设计决定（T1–T7）

- **T1 总闸与入口**：`uToon` 模块级 uniform（sky-webgpu.ts，与 `discGain` 同层）。入口三件套：`?toon=<0-1>` 启动参数（`qa.ts` 新增 `parseToon`，仿 `parseCloudLook` 字面量纪律）、`qa.setToon(x)` 运行时杠杆、面板「风格」组滑杆（0–1 过渡）。默认 0。
- **T2 天 + 海档位化（核心）**：posterize 加在 `skyColorTsl` **出口**（亮度轴 N 档阶梯 + hue-shifted 档位色，N 与曲线由抓帧标定锁死——沿用 P1.5「抓帧标定后测试钉值」流程）；`skyColorJs` **同步同一步**（双镜像纪律，否则镜像测试红）。海反射吃同一出口，自动一致。
- **T3 dome 光照量化**：光照项/透射率阶梯化（stepped transmittance）；只动颜色输出，alpha/密度/步数一行不碰；档间用既有 IGN jitter 抖动防带闪。与 `uLook`（soft/flat）正交：toon 是第二根输出轴，两者可组合，测试照 uLook 先例钉「toon cannot reshape」。
- **T4 调色硬化预设**：toon 版 `cloudBands`/`cloudHaze`/海霾端点做成一套 hue-shifted 快照（暗部偏紫、亮部偏暖——风格化 ramp 标准做法），走 `setTrackPatch`/`setHazeEndpoints` 现成通道，不新增管线。**合成顺序（my call，builder 可复核）**：toon 预设为底层、用户手动 trackpatch 为顶层（syncSun 先应用 toon 层再叠用户层）；`exportColorState` 的 repro 必须包含 toon 状态，复现链不许断。
- **T5 太阳路 / 浪花（期 2）**：glitter 阈值化成稀疏 sparkle（K4_MARGIN 预算体系内）；浪花从渐变改剪影带。海霾端点的 toon 硬化快照同期落地。
- **T6 量具语义改判**：`banding_flips` 在 toon 模式下「色带 = 特性」——toon 采集帧的验收**不走**现行 banding 门，单独口径并文档留痕（DOME-02 的教训：改判必须谁批、改哪条、何时三要素齐全）。
- **T7 bloom 预算**：预算表（post.ts:46-60）加 toon 模式行，全档复测 <0.82；大色块亮度集中是 toon 的常态，按表说话。

## 5. 分期

| 期 | 内容 | 量级 |
|---|---|---|
| 1（核心） | T1 总闸 + T2 天海档位化（双镜像）+ T3 dome 量化 + T4 调色预设 + T6/T7 门与面板 | M |
| 2（完善） | T5 太阳路/浪花/海霾硬化 + N 档曲线精调 + toon 全档采集矩阵 | S–M |

**明确不做**：描边/rim、puff 重构、WebGL 回退、第二调色源。

## 6. 验收门

1. **默认逐位不变**：`uToon=0` 的 before/after A/B 帧字节级一致（Task 0 现抓基准，沿调色面板计划验收①的协议）。
2. **toon on/off 采集对**入库 `artifacts/`，天/海/云三区各可量到档位结构（新量具 `band_count`，或 banding_flips 按新口径解读）。
3. **镜像对齐**：toon 化后的 `skyColorTsl`/`skyColorJs` 逐点一致。
4. **参考档恒等**：既有测试不碰、必须绿。
5. **bloom 预算**：toon 行全档 <0.82。
6. **复现链**：`exportColorState` 含 toon 状态，URL/console 双通道照旧可重放。

## 7. 风险

| 风险 | 等级 | 对冲 |
|---|---|---|
| 双镜像不同步（TSL 改了 JS 忘改） | 中 | T2 写明同 commit 同步；镜像测试红就是守卫 |
| dome 量化与 uLook 组合爆炸（2×2 状态） | 中 | 测试照 uLook 先例钉组合断言；采集矩阵只抓代表性组合 |
| toon 大色块顶 bloom | 中 | T7 预算行先行（量具先行纪律） |
| toon 预设与用户 patch 叠加语义混淆 | 低 | T4 合成顺序写死 + repro 全量导出 |
| 档位数/曲线主观性 | 低 | 抓帧标定流程（P1.5 先例），门柱只能由抓帧数据搬 |

## 8. 留给 builder 的

- `skyColorTsl` 出口的精确插入点与 TSL 写法（懒编译坑：Fn 体内结构断言走源码 pin，别信运行时反射）。
- N 档曲线的标定脚本与帧（复用 `artifacts/dome-audit/` 量具风格）。
- 面板「风格」组的具体控件布局（`src/debug/color-panel.ts` 既有 addSlider/addButton 模式）。

## 9. 待主人拍板

- **toon 亮度档位数初值**：my call 是 **6 档**起步（够「平」又不至于色阶病），标定后允许搬。不同意现在说，否则按 6 走。
