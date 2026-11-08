# 陆地飞行场景 0→1 项目路线图

> **状态：Roadmap（阶段级）。** 不是任务级实现计划。每个里程碑在开工前再单独产出一份
> `writing-plans` 任务级计划（失败测试 → 最小实现 → 提交）。
>
> **2026-11-05 更正**：行动仓已改绑 `ThreeJSInspire-reconstruct`（海面重建试验场）；
> 目标已定：**C. 先海后陆、上下两卷**；§5 已按两卷重排。
>
> **依据**
> - `吉卜力风格化陆地飞行场景-技术方案重构研究报告.md`（2026-11-05）
> - **行动仓：`G:\DSHProject\ThreeJSInspire-reconstruct`**（海面重建试验场；工作树 29 个源文件 / 27 个测试文件；
>   已删 `sea-fft.ts`、`sea-fallback.ts`、`clouds-compute.ts`、`clouds-fallback.ts`、`sky-sunset.ts`，
>   新增 `qa.ts`（29 行）、`puff-field.ts`、`puff-shape.ts`；`world.ts:5-6` 头注："Both will be rebuilt here"）
> - 对照仓：`G:\DSHProject\ThreeJSInspire`（master，海/云完整实现，A/B 像素对照用）
> - 数字来源仓：`ThreeJSInspire-puff-preview`（报告行号与审计脚本的实际出处，仅参考）
> - `docs/superpowers/reviews/2026-11-01-progress-handoff.md`（run 1 验收未过门清单）
> - `docs/superpowers/reviews/2026-11-02-tonemap-hull-resolution.md`（量测假象已解）
>
> 本文件只回答两件事：报告里哪些能拿、拿的顺序是什么。

---

## 0. 一句话结论

报告的技术**判断**大多能用，报告的**证据链**不能直接用——它的行号、文件清单、单测数、
审计脚本来自兄弟目录 `ThreeJSInspire-puff-preview`，而行动仓是 `ThreeJSInspire-reconstruct`
（海已删、待重建；`world.ts` 163 行、`qa.ts` 29 行，均已读验）。所以 0→1 的第一步不是
写地形，而是**把度量尺子先搬进来并重标定一次**；否则后面每一个"达标"都是拿别人的尺子量自己的画。

---

## 1. 可取之处（按价值排序）

| # | 结论 | 为什么值得拿 | 落地位置 |
|---|---|---|---|
| A1 | **「吸附跟随」会倒逼大气参数，远景塌墙** | 唯一一条直接解释本项目现状的因果链：`src/far-field.ts` 把海/云/穹顶吸附到 400 m，`src/horizon.ts` 的 `HAZE_FAR = 520` 不是大气物理算出来的，是被海面前缘逼出来的。地形若照抄吸附，会把同一个坑再踩一遍 | M2 大气解耦 + M3 地形世界锚定 |
| A2 | **地形必须世界锚定，禁止 per-chunk 随机** | 跨 chunk 裂缝的唯一根因；同时给"飞回去还是同一座山"提供可测判据（相邻 chunk 边界顶点逐点相等） | M3 |
| A3 | **分层连续（软阈值）而非硬分档，除飞机外全场禁量化** | 三张参考实测 13/16 明度桶、熵 7.17–7.33，与 cel 惯例的 2–4 档差 3.3–6.5 倍；这条同时解释了为什么海面 quantize 会在非光照项上画等高线 | M4 着色；`src/toon.ts` 只留飞机 |
| A4 | **唯一分叉点 = 实例数据来源（route C）** | 渲染层同源、数据来源分叉，才能让"两后端像素一致"成为可测合同而不是口号；且天然否决 atomics/indirect（WebGL2 编译期硬失败 / 静默失效） | M5 |
| A5 | **植被抽象层级高于写实：树冠色块 blob，草用色带** | 逐叶 alpha cutout 会把 `edge_sum` 顶出参考带、把 `flat_frac` 压到 0.31 以下；三处约束（吉卜力平涂 / overdraw / Safari 8 KB）的共同解 | M5 |
| A6 | **度量口径写死：S 用 HSV、flat_frac 用 Sobel<4/255、bands 16 桶** | 本仓库 run 1 的失败里至少两条是口径问题（凸包卡点已证实是量测假象）；口径不写死，验收会反复自证 | M0 |
| A7 | **FrameGovernor 三处必改 + 开机预检定档** | 现 `SLOW_FRAME_MS = 24` / `SLOW_FRAME_LIMIT = 60`：连续 60 帧超阈值才降档，而地形流送尖峰是单次 15–40 ms——**必然误判**；反过来真要降档又要等一秒 | M6 |
| A8 | **DOF 现在花钱买不到景深** | `post.ts` 的 `focalLength 420` 是世界单位，等于全画面焦外；`bokehScale 1.1` 实际模糊 ≤1.1 px。低档还必须整链裁剪 | M6 |
| A9 | **Safari 8 KB private / compileAsync 超时兜底，且超时不得判失败** | 失败形态是 pipeline 静默失败、`renderer.onError` 接不到，只能靠 console.error 文本 + `calls` 归零判定 | M7 |

## 2. 只取方向、不取数字

| # | 报告写法 | 本项目的处理 |
|---|---|---|
| B1 | P2 LAND 门：`sat_p99 ≤ 0.70`、`entropy ≥ 7.0`、`bands ≥ 13`、`flat_frac ≤ 0.36`、`edge_sum ≥ 0.10` | 这些是**插画目标**，报告自己也标注了。**先重测陆地基线，再决定门**；在重测完成前它们只是"方向：低边缘密度 + 大片平涂" |
| B2 | 表 5-1 的绝对 ms（15.0 / 30.0）与移动档 | 桌面 15.0 ms 可作分配意图（百分比），移动档报告自认 INSUFFICIENT_EVIDENCE。本小姐只把它当预算比例用，不当验收数字 |
| B3 | FOV 60 → 66–71°、kick 9 → 3–6°、距离 30 → 36–40 | 方向可行（竖屏窄水平 FOV 使机翼显大），但全部标着"待首批陆地帧验证"。**先出帧，再定值**；硬上限 `base + kick ≤ 75°` 可以先落 |
| B4 | 描边 = 背面重绘 vs 屏幕空间 Sobel 二选一 | 报告自己列了 INSUFFICIENT_EVIDENCE。**0→1 阶段不上描边**，等几何稳定后再测 |

## 3. 不采纳

| # | 报告主张 | 为什么不 |
|---|---|---|
| C1 | 「重构起点是移除海面与云层」 | 这是**产品决定**，不是研究结论，报告却把它当前提写进了每一章的预算。海/云是当前仓库唯一跑得好看的场景，也是新天空的 A/B 对照。**建议整段保留、用场景开关挂起**，不删 |
| C2 | P5「WebGL2 独立降级管线」作为独立阶段 | 与 route C 自己的原则冲突（渲染层同源）。0→1 阶段只做**同一份 TSL + CPU 实例数据**，真测出性能差再分叉；提前分叉等于维护两条跑道（R-3 已警告：4 处节点图构建点 ×2） |
| C3 | 运行时 GPU 侵蚀 / GPU 端压实 | 报告已否决（atomics 编译期炸、barrier 静默失效、回退端无 indirect 消费方）。采纳其结论：**离线烘焙 + 运行时轻量 talus** |
| C4 | 把「325 单测保持全绿」当 P0 门 | 本仓库是 265。写 325 会直接假失败 |

## 4. 文档硬伤（已在本 checkout 核实）

| # | 现象 | 核实方式 | 后果 |
|---|---|---|---|
| D1 | 行号/文件清单与任何工作树都对不上：报告写 `sea-fft.ts` 1471 行、有 `sea-fbm.ts` 465 / `qa.ts`；`puff-preview` 侧是 1379 / 428 / 26；**行动仓 reconstruct 里根本没有 sea 文件**，`world.ts` 163 行、`qa.ts` 29 行（均已读验） | 三仓文件清单 + 逐文件读验 | 任何"按行号改代码"在行动仓直接落空；引用行号前必须先声明 checkout |
| D2 | 报告称 P0 要"扩展已在跑的 `artifacts/ghibli-audit/frame-metrics.mjs`" | 该脚本只在 `puff-preview` 得到确认；但行动仓已有 `qa.ts`（29 行，`?pos=`/`?puff=`/`?qa=frozen` 全接线，见 `main.ts:21,148-151,249-252`） | M0 不是"扩展已有"，是**以 qa.ts 为杆子补 metrics**；工时比报告预估小，比"从零起"大 |
| D3 | 单测数 325 | 主仓实测 26 files / 265 tests；**行动仓 reconstruct 是 27 个测试文件**（增 `puff-field/shape/qa`，去 `sea/clouds`；总数本会话无执行器，待跑 `npm test`） | 门必须按行动仓重写，325/265 都不能直接用 |
| D4 | `sky-land-split.mjs` 被判不可信（ref-01 88.4% vs 目视 50–55%） | 报告 §3.6.4 自承 | **LAND 分区基线整体悬空**，必须重测，不能拿报告里的 LAND 数字当起点 |
| D5 | 用海面场景的 60 fps 与海面参考图做陆地预算与基线 | 报告 §3.7.1 自承"只在海面场景下取得" | 陆地基线 = 0，M2/M4 的门必须先建基线 |
| D6 | 预算重复计账：表 5-1 的 GPU 11.4 已含地形 1.8 + 植被 1.2 + 植被 alpha 1.0，随后又"GPU 11.4 + 第 3 章上界 5.5 = 16.9" | 逐项相加 | 若 5.5 是同一批 GPU 项，则 16.9 重复了 4.0 ms；若是生成期 CPU，则不该与帧预算相加。**结论方向（预算已满）成立，数字不成立** |

## 5. 阶段表（上下两卷）

工时单位：**会话日**（一个可被验收的 AI 协作日）。上卷 12–18，下卷 22–32，合计 34–50。

共享地基（两卷都要，先修）：

| 里程碑 | 目标 | 主要交付 | 验收门 | 回滚开关 | 工时 | 依赖 |
|---|---|---|---|---|---|---|
| **M0 尺子** | 让"达标"可复现（reconstruct 已有 `qa.ts` 抓帧杆子，本步是补齐不是从零起） | `artifacts/ghibli-audit/frame-metrics.mjs`（S/bands/entropy/unique/flat/edge/ΔL*）、`artifacts/perf/accumulate.mjs`（N=100 帧累积）；`artifacts/captures/<date>/<state>/{frame.png,sidecar.json,metrics.json,capture.md}`；**重测 LAND 分区**（不用 sky-land-split） | 同帧两次独立采集差异 ≤ 3%；reconstruct `npm test` 跑绿（27 文件，总数待数）；LAND 基线表落盘 | 无（纯新增） | 1 | — |
| **M1 骨架** | 给"海面重建"留好落点位（reconstruct 已无海可包，A/B 对照帧取自主仓） | `src/scene/` 注册表；`SceneModule { init/update/dispose/setQuality }`；`world.ts` 改为注册表装配（现 sky+puffs 原样迁入）；主仓同帧抓帧做像素对照基线 | 注册表单测；sky+puffs 场景与改前同帧 ΔL* p95 ≤ 1 | git tag（删海前的提交即天然回滚点） | 1–2 | M0 |

上卷 A：海面 + 顶云重建（reconstruct 当前使命，`world.ts:5-6` 头注原话）：

| 里程碑 | 目标 | 主要交付 | 验收门 | 回滚开关 | 工时 | 依赖 |
|---|---|---|---|---|---|---|
| **A2 海面** | 把海写回来，行为先对齐主仓 | 移植主仓 `sea-fft.ts` + `sea-fallback.ts`（**推荐路线，待 §9 确认**：行为已知、有测试 pin 住）；`sun-road.ts`（已在）与 `horizon.ts` 耦合复查：`HAZE_FAR` 不得被海面前缘倒逼（A1 教训） | 与主仓同帧 ΔL* p95 ≤ 2（移植保真）；随后按 tonemap-hull 决议（逆 tonemap 后重拟合凸包）重跑 handoff run-1 海门 | 注册表 flag 关海 | 4–6 | M1 |
| **A3 顶云** | 把顶云写回来 | 重建 `clouds-compute.ts` 或等价路径；与近景 puff 联合验收（`?puff=0` paired on/off 已有） | coverage / cloudHF 按修正口径重测达标；穿云三条（`qa.ts` 头注）：无硬切边、不凭空消失、白雾平滑进出 | `?dome=0` | 4–6 | A2 |
| **A4 海场景收敛** | 海场景可验收、可降级 | DOF 修焦平面或撤（低档零 RT）；BloomNode 假关闭改图重建；governor 三改（阈值 ×1.25、连续帧 60→8、生成期屏蔽位）+ 开机预检；海场景 run-2 验收 | low 档 `renderer.info.memory.textures` 前后差 = 0；"一次尖峰不降档"单测；run-2 门全绿；low ≤ 30 ms | `?post=0\|low` | 2–3 | A3 |

下卷 B：陆地飞行（报告路线；sky 模块与海场景共享，改动一律走 `?sky` 开关保护海场景）：

| 里程碑 | 目标 | 主要交付 | 验收门 | 回滚开关 | 工时 | 依赖 |
|---|---|---|---|---|---|---|
| **B1 天空/大气** | 拆掉"几何边缘倒逼雾" | 单一 `skyGradient(elevation)` 源（`at` 用仰角，不用 canvasY）；雾由视距积分决定，`HAZE_FAR` 与几何前缘解耦；两条 ramp 解释路径等值 | 40–70° 仰角带 ΔL* ≥ 6；两条 ramp 逐点 ΔL* ≤ 0.5；主体/背景 ΔL* ≥ 20 | `?sky=legacy` | 3–4 | M1 |
| **B2 地形** | 世界锚定 + 流送不卡 | `src/terrain/field.ts` 纯函数 `heightAt(x,z)`（fBm 5 octave、lacunarity 1.97、domain warp 幅度 ≪ 特征尺寸）；128 m chunk / ring 5–6；Worker + 时间切片 + 双缓冲；chunk 级 3 档 LOD | 相邻 chunk 边界顶点**逐点相等**；首帧生成 ≤ 2.0 s；一次流送尖峰不触发降档；无可见裂缝/接缝 | `?terrain=0` | 6–8 | M1 |
| **B3 着色** | 分层连续 + 色域收拢 | `landShading.ts`（TSL）：坡向/高度/曲率 → 软阈值色带；大气透视做**色相+饱和收拢**而非 lerp 到雾色；纸纹默认 0 | LAND 门（**以 M0 重测基线为准**，方向：低边缘密度、大片平涂、极值饱和封顶）；颗粒单独过 Δentropy ≤ 0.1 / Δflat_frac ≤ 0.02 | `?shade=legacy` | 4–6 | B2 |
| **B4 植被** | 实例数据分叉，渲染同源 | `generateVegetationInstances(chunk, backend) -> {instances: Float32Array, count}`；CPU(Worker) 版先行、compute 版后置；自定义实例属性（**不用 instanceMatrix**：storage 在 WebGL2 会退化 PBO→纹理）；顶点着色器距离折叠；树冠 blob + ao 渐变；草走色带 | 两档实例数一致、同布局；剔除不增 drawcall；chunk 边界双档 alpha cutout 交叉淡化无 popping | `?veg=0`、`?veg-source=cpu\|compute` | 4–6 | B2、B3 |
| **B5 镜头/手感** | 陆地帧重标定（A4 的 governor/post 改动直接复用，只重验镜头） | FOV 66–71 + kick 3–6（`base+kick ≤ 75`）+ 距离 36–40 首批陆地帧验证；相机与地平线平行 | 相邻档 ΔL* 中位 ≤ 12 / p95 ≤ 25；FOV 值由陆地帧定死 | `?feel=legacy` | 2–3 | B4、A4 |
| **B6 硬化** | WebGL2 是一等公民（全量） | `?backend=webgl2` 全帧成功；pipeline 失败捕获（console.error 文本 + `calls` 归零）；Safari `compileAsync` 3–5 s 超时兜底且**超时不判失败**；烘焙产物版本化 | 100% 帧渲染成功、零编译错误；WebGL2 low ≤ 30 ms；两档 ΔL* 中位 ≤ 3 | `?backend=webgpu` | 3–5 | B5 |

**对应关系**：M0/M1 两卷共享；上卷 = reconstruct 使命 + 报告 §1 四根因 + handoff run-1 未过门清单；
下卷 = 报告 P0–P5（P0→M0；P1→B1；P2→B2+B3+B4；P3→B5；P4→B4 后半；P5→B6，只做同源不做独立管线，见 C2）。

## 6. 复用与弃置（文件级）

| 处置 | 文件 | 说明 |
|---|---|---|
| 原样复用 | `src/game.ts`、`src/input.ts`、`src/plane.ts`、`src/audio.ts`、`src/hud.ts`、`src/director.ts`、`src/subtitles.ts`、`src/feel.ts`、`src/renderer.ts` | 飞行核心与表现层不动；`game.ts` 的纯函数 stepFlight 是这套东西最值钱的部分 |
| 小改复用 | `src/camera-rig.ts`（FOV/距离/地平线平行）、`src/post.ts`（撤 DOF、修 bloom 门）、`src/palettes.ts`（陆地季节色板）、`src/main.ts`（组合根 + scene 开关） | |
| 改写 | `src/world.ts`（→ scene 注册表）、`src/far-field.ts`（→ 地形 LOD/流送）、`src/horizon.ts` + `src/sky-*.ts`（→ 仰角驱动的单一 ramp） | |
| 已删（行动仓）／对照（主仓） | reconstruct 已删：`sea-fft.ts`、`sea-fallback.ts`、`clouds-compute.ts`、`clouds-fallback.ts`、`sky-sunset.ts`（各文件头注 + `world.ts:5-6` 为证）；保留：`puff-cloud.ts`、`sun-road.ts`、`sky-webgpu.ts` | 重建时实现参考主仓对应文件 + `puff-preview` 的 `sea-fbm.ts`；像素对照帧一律取自主仓，不用 reconstruct 自证 |
| 新增 | `src/scene/`（M1）、`src/sea/` + `src/clouds/`（上卷重建落点，M1 预留接口）、`src/terrain/`、`src/land-shading.ts`、`src/vegetation/`（下卷）、`artifacts/ghibli-audit/`、`artifacts/perf/` | |

## 7. 预算（重列，只给单一口径）

桌面 60 fps × 90% = 15.0 ms 为目标帧。下卷（陆地）按下表**占比**分配（不是实测）；
上卷（海）暂无分项数——主仓现状只有一个"<16.67 ms 上限"，等 M0 累积器实测后填：

| 项 | ms | 来源 |
|---|---|---|
| 天空 + 大气 | 1.2 | 报告表 5-1 |
| 地形 opaque | 1.8 | 报告表 5-1 |
| 植被实例化 + alpha 片元 | 2.2 | 报告表 5-1 |
| 阴影 1024² | 2.0 | 报告表 5-1 |
| bloom + SMAA + tonemap | 2.4 | 报告表 5-1（DOF 已撤） |
| **GPU 小计** | **9.6** | 逐项相加 |
| CPU + HUD | 1.3 | 报告表 5-1 |
| 余量 | 4.1 | 15.0 − 10.9 |

**结论不变的那一半**：即使不重复计账，只要地形生成尖峰（8 ms 量级）落在帧内，流送帧仍会越过 15.0 ms，并在 `SLOW_FRAME_MS = 24` 附近抖动——所以 Worker + 时间切片 + 生成期屏蔽位不是优化项，是**前置条件**。

## 8. 悬空项（M0 必须先填）

1. 区域基线：下卷 LAND 六项待重测（报告 LAND 数字来自不可信的地平线检测）；上卷海门按 handoff run-1 + tonemap-hull 决议（逆 tonemap 后重拟合）重测，不直接复用 run-1 数字。
2. 帧时重复性阈值：两次独立采集差 ≤ 3% 目前是"待定标"，要先跑 20 次同帧才知道噪声底。
3. 首帧生成耗时：2.0 s 是工程估算，需在真机（含 H-C 低端）上测。
4. 描边成本与抖动：两卷都不做，但 B5 要留出测量位置。
5. 移动端绝对 ms：报告自认无一手数据，本路线图不承诺。

## 9. 下一步

岔口状态（2026-11-05 更正后）：

1. **行动仓**：已定 = `ThreeJSInspire-reconstruct`。
2. **海与云**：已定 = reconstruct 树内已删、按 `world.ts:5-6` 头注重建；主仓保留完整实现做对照。
3. **0→1 的目标**：已定 = **C. 先 A 后 B 两段走**（2026-11-05 拍板）。§5 已重排为上卷 A2–A4 + 下卷 B1–B6。
4. 海面重建技术路线（待确认；本小姐推荐 port 主仓 `sea-fft.ts` + `sea.test.ts`：行为已知、有测试 pin 住，审计修复做增量）：复用主仓 ／ 以 `puff-preview` 的 `sea-fbm.ts` 为起点 ／ 按报告 §3 重写。
