# 调色 Debug UI 调研（2026-11-09）

> **性质**：调研文档，不是实施计划。只回答"能不能做、怎么做、摸哪里"。
> **结论先行**：能做，推荐 **B 方案（`?debug=color` 屏上调色板，dev-only 动态 import）**，
> 底层复用 `__porco.qa` 同一套 setter，面板每个动作回显可复现命令。
> 本调研只读代码，未改任何实现。

## 1. 你想做的两件事，现状各差多远

| 需求 | 现状已有的杠杆 | 缺口 |
|---|---|---|
| 看日夜轮换 | `?sun=az,el` 启动太阳（`main.ts:146-149`）；`?sunspin=deg/s` 匀速转（`qa.ts:59-63`，上限 360）；控制台 `__porco.qa.setSun/rotateSun/getSun`（`main.ts:372-382`）；`syncSun` 版本门控每帧跟随（`main.ts:260-296`） | 没有**可视化连续 scrub**：想看 6.97°→0°→−4°→−8° 整段过渡，只能手敲命令或等 sunspin 转；没有一键跳关键帧 |
| 调海面颜色 | `seaHazeEndpoints` 每帧从镜像派生端点（`main.ts:283-289`）；`world.setHazeTargets` 原地写 uniform（`world.ts:204-206`，四环共享）；`?sea=debug` 假色、`?sea=nochop` A/B（`qa.ts:36-50`） | 端点每帧被 `syncSun` 重算，**手调的值下一帧就被覆盖**；海体着色常量（SLOPE_GAIN / CREST_TINT / WATER_OPTICS / SUN_ROAD knee / fineCrestMetres）没有运行时入口，只能改源码重编 |

## 2. 可调参数清单（实现时按此表接线）

### 2.1 天空轨道（`SkyTrackState`，`sky-track.ts`，`skyTrackAt(el)` 产出）

`dayStops / nightStops / nightWeight / awayColor / awayGain / awayHeight / glowPow / glowGain / sunTint / discGain / cloudBands / cloudHaze / floorLinear / preetham{turbidity,rayleigh,mieCoefficient,mieDirectionalG} / sunLightColorCss+Intensity / hemiSkyCss+GroundCss+Intensity / veilCool / veilWarm / starOpacity / bloomThreshold`。
`hazeLinear / awayEdgeLinear` 自 Task 5 起只是遗留字段，运行时以 `seaHazeEndpoints()` 派生为准，面板**不要**暴露这两个。

### 2.2 海面（`src/sea/`）

- **uniform（可运行时调）**：霾端点 ×2（`setHazeTargets`）、`sunU`（`setSunDirection`）、`c1Gate`（`setChopGate/clearChopGate`＋`chopOverride` 已落地）、`tierGain`（随 `setQuality`）。
- **模块常量（要调需新增 setter 或改源码重编，实现时逐个确认是否 uniform 化）**：
  `SLOPE_GAIN / CREST_TINT / WATER_OPTICS 全表 / SUN_ROAD（KNEE_K / ROAD_CEILING / GLINT_COS_THRESHOLD / GLOSS_POW）/ fineCrestMetres [0.03,0.06] / amplitudePeak（禁动，护栏 0.13746）`。
- **只读对照**：`?sea=debug` 假色、`?sea=nochop` A/B 保持原样，面板里放快捷按钮即可。

### 2.3 灯 / 云 / 纱 / 星 / 后处理

`lights.setSunLook / setAmbience`（`lights.ts:26-27`）、`setCloudPalette`（`puff-cloud.ts:88`）、
`setVeilTintEndpoints`（`in-cloud.ts:61`，刚改成随 `syncSun` 更新）、`stars.setOpacity`、
`post` 的 bloom 阈值 0.82（注释钉死，面板只读展示＋改前警告，不建议放滑杆）。

## 3. 方案选项

### A. 纯控制台 API（零 DOM，`__porco.qa` 扩展）

- 做法：`qa` 下加 `setTrack(patch)`、`lockHaze(on)`、`setSea(name, value)` 等函数，URL 加 `?sun=` 同类参数。
- 优点：零体积、零样式、符合仓库现有 QA 惯例（`step/describe` 都是这个路子），可写源码 pin 测试。
- 缺点：**调颜色靠打字是最痛苦的**——你要的是"看看轮换、拖拖颜色"，控制台给不了连续 scrub 和即时视觉反馈。需求匹配度不及格。

### B. 屏上调色板（推荐，`?debug=color` 开关，dev-only）

- 做法：新文件（如 `src/debug/color-panel.ts`），只在 URL 含 `?debug=color` 时 `await import()` 动态载入；
  shipping 包体积零增加。面板分四组：
  1. **太阳**：仰角 scrub 滑杆（−8°…＋15°，拖动即 `sun.setAzEl`＋`syncSun`，已有版本门控所以静止零开销）、方位滑杆、
     关键帧一键跳（6.97° / 0° / −4° / −8°）、`sunspin` 播放/暂停/速度（复用现有 `?sunspin` 语义）。
  2. **轨道覆盖**：对 2.1 字段的子集（先做 `nightWeight / glowGain / glowPow / awayGain / discGain / starOpacity / floorLinear`）
     放滑杆/颜色拾取；实现方式是在 `syncSun` 里 `skyTrackAt(el)` 之后 merge 一份 `debugTrackPatch`（空 patch＝零行为变化，参考档恒等不受影响）。
  3. **海面**：霾端点"锁定"开关（锁定后 `syncSun` 跳过 `setHazeTargets` 重算，手调值才留得住）＋两端点颜色拾取；
     `?sea=nochop / debug / quality` 快捷按钮；SLOPE_GAIN 等常量先只读展示，第二步再决定 uniform 化。
  4. **导出**：当前太阳＋覆盖 patch 一键导出为可复现命令（`?sun=…&…` URL 或 `qa.setSun`＋patch JSON），贴进采集 sidecar 即复现。
- 面板每个动作 `console.info` 回显等价控制台命令，保证"面板调的＝手敲能复现的"。
- 优点：直接命中"看轮换＋调颜色"；动态 import 不污染 shipping；与现有 setter/版本门控天然咬合。
- 缺点：要写 ~300 行面板代码＋样式；颜色拾取 sRGB↔线性来回（`in-cloud` 踩过的坑：线性直灌 byte 会截黑，面板侧必须走同一回转）。

### C. 往现有 HUD 里加调色区

- 否决：HUD 是出货界面（左下启动条、右上音频面板都是给玩家的），调色控件混进去等于把脚手架焊在产品上。
  仓库惯例也是 QA 东西走 `__porco`/URL，不走 HUD。

## 4. 推荐：B 方案，任务拆分草案（实施计划另出）

1. `qa` 层加三个无 DOM 函数：`setTrackPatch(patch|null)`、`lockHaze(on)`、`exportColorState()`（面板与控制台共用同一入口，源码 pin 可测）。
2. `syncSun` 加两处 merge 点：`skyTrackAt` 后合 patch；`setHazeTargets` 前检查 haze 锁。空 patch／未锁定＝行为与今天逐位一致（现有 405 用例即回归网）。
3. `color-panel.ts`（动态 import，`?debug=color` 门控）：太阳组 → 轨道组 → 海面组 → 导出组。
4. 海常量 uniform 化评估（第二步）：SLOPE_GAIN 等逐个确认 uniform／重建语义后再放滑杆，第一步只读展示。
5. 文档：本调研转实施计划时补"面板动作↔复现命令"对照表；`PORTRAIT_QA.md` 加调色板用例。

## 5. 红线（实施时钉死）

- 不新增第三方依赖（手写面板；`lil-gui` 之类不引入）。
- shipping 默认路径零变化：无 `?debug=color` 时不 import、不建 DOM、不改 `syncSun` 行为（空 patch 恒等）。
- 颜色空间：面板拾取的 sRGB 进 TSL 前走线性解码（约束⑨），回显 byte 走 `in-cloud` 同款回转，禁止线性直灌。
- bloom 阈值 0.82 不放滑杆（只读＋警告），`amplitudePeak` 禁止暴露（护栏）。
- 覆盖值与复现命令必须双向一致：面板调出的任何画面，一条命令能重放。

## 6. 开放问题（实施计划前确认）

1. 海常量里哪些已经是 uniform、哪些要新建 setter？（`material.ts` 逐个查，SLOPE_GAIN 优先。）
2. 仰角 scrub 范围要不要含白天档（>15°）？当前轨道只定义到参考 6.97°，往上是钳到参考档。
3. 面板样式走裸 DOM＋内联样式即可，还是要跟 HUD 风格统一？（建议前者，dev 工具不讲究。）
