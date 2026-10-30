# Porco 飞行手感 + 海 + 云 + 飞机 执行设计（分批落地）

- 日期：2026-10-30
- 分支：`feat/phaseb-post-pipeline`（本文写定时的审计基线）
- 意图：把参考图（日落、无边际海、NPR 云、卡通水上飞机、“just breathe / SWALLOW SPIRAL DIVE”）翻译成可分批执行的工程 work，每批可独立验证，不返工。
- 为什么现在做：后處理管线已合入，镜头导演层 + 失速 + toon 已有骨架（`director.ts`、`stall.ts`、`toon.ts`），但飞行仍是“无重力贴边滑行”、海是“假高光贴片”、同层云缺失、飞机是占位体——参考图的三处观感（零速下坠、粼粼海、两层云）都还做不出。

## 现状审计（只读结论，行号是证据）

- 飞行：`FLIGHT.MIN_SPEED 34 / MAX 78, DIVE_GAIN 16, ALT 6~240`（`src/game.ts:40-59`）；速度钳制永不为零（`game.ts:154-160`）；高度硬钳贴边滑行（`game.ts:192-193`）；`stall.ts:4` 自述 `no lift, no gravity, altitude hard-clamped`；`stall01` 阈值 `AOA_CRIT 0.42` 即 pitch>0.50rad（`stall.ts:40-43`）；效果为 `NOSE_DROP 0.55` 压 pitch + `DRAG 12` 减速（`game.ts:177-181`）+ buffet（`feel.ts:284`）。
- 海：CPU Phillips FFT 128 / 400m（`sea-fft.ts:42-46`），几何 1200m/240 段，法线中心差分 ×1.4 + noise bump（`sea-fft.ts:463,585-604`）；高光是假 spec `pow(...,96)*1.5`（`sun-road.ts:22`，`sea-fft.ts:624`）；`MeshBasicNodeMaterial` 不吃灯只认 `uSunDir`；雾手写 haze mix 且 `fog=false`（`sea-fft.ts:669-678`）；海天无缝靠合约 `SEA.haze == SKY.horizon`（`palettes.ts:36-37`）。
- 云：顶层真 TSL slab raymarch 95~265m、12/8 步（`clouds-compute.ts:79-180`）；无 3D 纹理、无 light-march；同层 NPR 云不存在；穿云只是 DOM 白雾 `WHITEOUT_MAX 0.6` + trauma 0.25（`in-cloud.ts`、`director.ts:77-83`）。
- 镜头/字幕：`dive01 → fovExtra 3 + bank 0.45 + trauma 0.35`（`director.ts:51-53,83-87`，`game.ts:356-367`）；跟机 12~60m；字幕底居 78px、0.4s 进 0.6s 出、单次播放（`subtitles.ts`）；机动名 cue 仅 5 种（`subtitles.ts:9,20-26`）。
- 飞机：`assets/blend/porco-fighter-v001.blend` 自建源 → `public/assets/porco-fighter.glb`（221KB，`072bf39`）；`src/plane.ts` 启动先放占位体、GLB 到后替换，鼻朝 +Z 上 `model.rotation.y = PI` 转 -Z；材质名 `livery_*` 命中才染色 + 全树 `toonify`（`plane.ts:51-71`）。

## Goals / Non-goals / Anti-goals

- Goals：① 顶部可零速悬停→自由落体→改出；② 海面可平行掠飞带水花；③ 海无边无际 + 波光粼粼 + 受光 gradient；④ 两层云（顶层体积 + 同层碎云）；⑤ 飞机从占位体升级为 S.21 神韵但不照抄。
- Non-goals：不做多人、不做真实气动仿真（保持风格化飞行）、不换渲染后端（继续 WebGPURenderer + forceWebGL 双跑道）。
- Anti-goals：① 直接粘 GLSL（WebGPURenderer 下 `ShaderMaterial` 报 not compatible，必须 TSL `Fn`）；② 一次性大爆炸改动看不出回归；③ 抄 Savoia S.21 原样导致版权/风格双输。

## 全局约束（所有批次遵守）

1. 双后端 TSL：新 shader 一律 TSL `Fn`（`glslFn` 仅 WebGL2、`wgslFn` 仅 WebGPU，不可移植）；`onBeforeCompile` 禁用。
2. 调色单源：改色只动 `palettes.ts`，海天缝合约 `haze == horizon` 不许破。
3. 飞机管线：鼻 +Z、材质名 `livery_*`、落地 `toonify`、GLB 无 mesh 即回退占位（`plane.ts:190-206` smoke 门）。
4. 每批门禁：`vitest run` 相关单测 → `node scripts/smoke.mjs` → 竖屏 `PORTRAIT_QA` 目检 → dev `http://192.168.1.24:5173/` 手飞。

---

## Batch A — 手感：冲顶零速 + 自由落体 + 掠飞（最先做，玩法命脉）

- A1 能量/重力：`game.ts stepFlight` 新增垂直速度与重力项；`speedTarget` 下限放开到 0（保留 `MIN_SPEED` 作巡航引用，新增 `STALL_SPEED` 判定）；`ALT_MAX` 硬钳改为悬停仲裁。
- A2 悬停→下坠→改出状态：到顶且速度→0 时姿态保持、位置悬停约 0.5s（配 hit-stop 微冻 0.08s + trauma 0.3，见 game-feel），随后重力接管机头下栽自由落体加速，空速回阈值恢复操控；`STALL` 常量加 `G_SINK`，`stall01` 在速度 0 附近保持咬合。
- A3 掠飞状态机：新增 `skim01 = smoothstep(ALT_MIN+8, ALT_MIN+1, y) * 平飞姿态门`；掠飞锁 `y≈ALT_MIN+1` 平行滑行；大角度大下沉仍判坠海拉起。`skim01` 输出给 `feel`（水沫粒子 + 尾迹）、`audio`（水声）、HUD（速度线显形）。
- 验收：满杆上冲必现“顶→停→掉→改出”；贴海平飞有水花无穿模；`game/stall/feel` 单测先行。

## Batch B — 海：无边 + 粼粼 + 受光（对标 web-ocean，只抄思路）

- B1 无限感：far-field 双环 + 贴片 follow（扩 `far-field.ts:62-85`），`HAZE_FAR 380` 余量加大；haze 改随太阳仰角插值（合约色值仍走 `palettes.ts`）。
- B2 高光重写（TSL `Fn`）：粗糙度随波斜率变化 + Fresnel 掠射增亮 + 双层法线（FFT 大波 + detail 扰动）；sun road 保 `WIDTH 25° / FLOOR 0.35` 方位门，闪烁频率随 `windSpeed`。
- B3 受光统一：海/天/云 `uSunDir` 收敛到 `SUN_POSITION` 单源；海节点真正响应灯光（`lights.ts` 定向 2.2 + 半球 0.7）而非假光；gradient 两段（天：紫顶→橙 horizon；海：deep→mid→lit→crest）。
- 验收：逆光窄亮 sun road + 近场碎钻；转太阳三处同动；地平线无断带。

## Batch C — 云：顶层升级 + 同层碎云（对标 procedural-clouds skill）

- C1 顶层 NPR 化：保留 slab 穹顶框架，加 Worley 基 + 侵蚀细节（两层不同 scale 的 `mx_fractal_noise`），云量/云型参数化；着色加 light-march 近似 + 迎光银边；**光照按 `toon.ts bandIndex` 思路收成 2~3 阶（flat 紫体 + 粉亮部 + 金 rim），与 ref-01/02 的色块云对阶**——当前 `clouds-compute.ts:167-176` 全是 smoothstep 平滑混合，这是要动的主因（`toon.ts` 开头“云不参与量化”的旧决定只保海，云作废）。
- C2 同层碎云（必须同款 NPR 不做写实）：低步 march 第二层 slab（用户拍板，真体积；穿进去是实雾不是贴纸），**用同一套 palette 同一阶数**；密度喂 `cloudDensityAt`；穿碎云 trauma 取 0.1 档（别跟大云 0.25 抢戏）。
- 验收：“头顶厚积云 + 身边碎棉花”两层感且同风格（暗部 flat 紫、亮部粉/金两阶与 ref 对阶）；穿云从整屏 DOM 白雾过渡到体积内雾感；**用户拍板（2026-10-30）：ref-03 云上视角用另铺低云 deck 实现，ALT_MAX 不动；云型只要 bank＋碎棉花，不要擎天柱状云。**

## Batch D — 观感收尾（参考图拾遗）

- D1 螺旋桨盘：半透明桨盘 + bloom 微光（占位体的实心桨 `prop_blade_0` 必换）。
- D2 翼尖拉烟/尾迹：`speed01 + bank` 双驱，螺旋俯冲可读性件。
- D3 字幕/机动名：`SWALLOW SPIRAL DIVE` 作 dive cue 变体（大 bank + 持续掉高，与 stall/low 互斥）；`just breathe.` 保持底居单次播放规范。
- D4 镜头：12~60m 锁机 + 中央留空；俯冲速度线加后效 pass（`post.ts` 链尾）。

## Batch E — 飞机：Savoia S.21 参考的取舍（本次新增章节）

- 参考：Sketchfab `Savoia S21` by FEDERICOFELICI，CC Attribution 4.0（署名可商用），2.7k 三角 / 1.5k 顶点低模，可下载（需登录），链接 https://sketchfab.com/3d-models/savoia-s21-3418b01468474872939971466704bbc7 。
- 决定（本小姐拍板）：**不直接拖进仓库当成品**。三条理由：① 用户明确“贴近但不要完全一样”；② 已有自建源 `porco-fighter-v001.blend` + 染色/toon/朝向/smoke 全链路，直接套用，换裸模等于重接管线；③ CC-BY 要求署名，直接商用还要补 credits 链。
- 做法：下载作**比例参考底图**导入 Blender 摆拍对比，把现 `v001` 向 S.21 神韵改——船体/撑杆高单翼/推进桨布局借鉴，整流罩、浮筒、尾条纹、座舱玻璃做差异化；材质名保持 `livery_*` 六件套；鼻 +Z 不许反；三角数控在 3~5k；导出覆盖 `porco-fighter.glb` 前备份 `v00N`。
- 署名：README/credits 加 “Savoia S.21 proportions referenced from FEDERICOFELICI (CC-BY 4.0)” 一行，即使没用它的 mesh 也算体面。
- 验收：`meshCount>0` smoke 过；toon 三阶 + 日落暖光下剪影与参考图同构不同款。

## 留给 builder 的事（可自行定）

- 各 Batch 内任务粒度与并行度；具体 TSL 节点写法；粒子条数/贴图尺寸等性能数（以 `smoke.mjs` + 真机帧率为准）。
- only-builder-may-decide 标记见各 Batch 正文；除此之外的接口变更先回本文修订。

## 审稿决议（builder-check 后本小姐拍板的，2026-10-30）

- 参考图归档：`docs/superpowers/specs/assets/ref-01-sunset-glide.png`（0:06 日落平飞 just breathe）、`ref-02-speed-lines.png`（0:08 速度线）、`ref-03-spiral-dive.png`（SWALLOW SPIRAL DIVE）。一切视觉验收以这三张为准。
- 太阳：静态日落，不做 time-of-day；`SUN_POSITION` 归 `palettes.ts` 单源，“转太阳三处同动”仅为调试 gizmo 不进正式版。
- 无限海尺度：相机 far 保持 2000；HAZE 范围以“ALT 6~240 全高度无断带”为验收，follow 吸附防抖策略留给 builder。
- 云：DOM 白化 `WHITEOUT_MAX` 保留作降级兜底；云量/云型参数 builder 可调并给默认值；`cloudDensityAt` 签名不变。
- skim01 消费者现状：`feel` 双翼尖 ribbon 已存在可复用为水沫/尾迹；`audio` 有 pulse 槽（`stall/dive/cloud/line`）需新增水声 kind；HUD 速度线不存在→D4 新建。
- 字幕默认阈值（builder 可调、用户可推翻）：SWALLOW 触发 `|bank|>0.6 且持续掉高>8m/s 满 1.5s`；优先级 `stall > low > dive机动名`；冷却 20s；`just breathe.` 首飞巡航 10s 播一次。
- 飞机管线硬事实：六件套 = `livery_white / livery_green / livery_red / dark_trim / glass_canopy / metal_prop`（`plane.ts:26-33`）；新版存 `porco-fighter-v002.blend/.glb`，v001 永留；署名放 README + 应用内 credits 各一行。
- 用户拍板（2026-10-30）：① 性能线桌面优先 60fps，手机能跑就行（B/C/D 按桌面画质做，forceWebGL 降档只保可玩不保效果）；② 零速悬停锁死操控、下栽改出（悬停约0.5s＋微冻0.08s＋trauma 0.3，下栽加速到阈值自动恢复）；③ 撞水温柔拉起无惩罚（不做重生/受击系统，坠海=自动拉起＋字幕提示）。

## 验证矩阵（每批相同）

1. `vitest run <对应单测>`（game/stall/feel/sea/sun-road/cloud/in-cloud/portrait/toon）
2. `node scripts/smoke.mjs`
3. `PORTRAIT_QA` 目检 + `http://192.168.1.24:5173/` 手飞（含手机端触屏拖杆）
