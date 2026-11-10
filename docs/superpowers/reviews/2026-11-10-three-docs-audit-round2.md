# 三份文档交叉复审（第二轮）报告

- 日期：2026-11-10
- 仓库：`G:\DSHProject\threejs-inspire`，分支 `feat/dome-cloud-volumetric`，HEAD `e93561b`
- 审核对象（均为上一轮审查 D1-D4 / B1-B11 / F1-F10 修复后的当前版本）：
  - `docs/superpowers/plans/2026-11-09-debug-color-panel.md`（调色面板计划）
  - `docs/superpowers/plans/2026-11-10-dome-cloud-p15-p2-horizon.md`（穹顶云 P1.5/P2 计划）
  - `docs/superpowers/specs/2026-11-10-flight-feel-improvement-design.md`（飞行手感设计 v1.1）
- 审核方式：三路源码逐行核查（本轮重验，不沿用上轮结论）、无头飞行模拟（`createFlightState`/`stepFlight`，dt=1/60，A 阶段满杆拉至 hover、B 阶段换测试杆量，与 v1.1 口径一致）、P1 验收帧像素分析（竖条 434×772 内）。未打开浏览器（三份功能均未落地）。
- 与第一轮报告（`2026-11-10-three-docs-audit.md`）的关系：上一轮 25 条已全部回填进当前版本，本轮逐条抽查回填质量；**本轮发现以修复稿新引入的问题、玩法/视觉理解层、跨计划冲突为主**，编号 R1 起。
- **回填记录（2026-11-10 同日）**：主人拍板②组六条全按推荐值（R1 snap 注入、R2 挡下直接进 pushover、R5 FOV 降级维持现状、R8 patch 自身淡出曲线、R10 承认 τ 同变、R13 qa 层补透传）。R1-R8、R10-R16 已全部回填至三份文档（含 R9 此前已裁定的玩家朝向滑窗）。**仍开放两条**：R17（`main.ts:17-18`／`qa.ts:50-56` 两处源码过期注释——属代码提交，建议随首个动到 `qa.ts` 的计划带走）、R18（门 4"暗底"的视觉语言——建议对照 `ref-01-sunset-glide.png` 拍板后再动设计 spec）。

## 0. 基线（本轮实测）

| 项 | 结果 |
|---|---|
| `npx vitest run` | 470/470 全绿（与两份计划所写基线一致） |
| 临时模拟测试 | 已写入 `src/zz-audit-sim.test.ts` 运行后删除，工作区无残留 |
| P1 帧竖条 coverage | 29.78%，与 P1 报告逐位一致（量具口径确认） |

## 1. 总览

| 文档 | 结论 | 阻断项 |
|---|---|---|
| 飞行手感 v1.1 | **数据骨架已扎实（两张实测表逐位复现），但 pushover 机制段有 3 处自相矛盾/未定义** | R1（fallback 死代码/常开两难）、R2（松杆门挡下后的行为未定义）、R3（改出杆量边界错 0.7，真实边界 +0.45~+0.5） |
| 穹顶云 P1.5/P2 | 上轮回填质量高，代码锚点本轮全数复核通过；剩 1 个未解释的画面异常＋1 个淡出方向缺口＋1 个玩法决策点 | R7（近地平线 on/off 异常未定性，Task 7 验收带正压着它）、R8（patch 淡出方向未钉）、R9（世界固定扇区 vs 自由转向） |
| 调色面板 | 可执行；qa 层接口清单与面板控件清单对不上、导出闭环缺 haze 侧状态 | R13（setChopGate/setHazeTargets 不在 qa 层）、R14（repro 不含 lockHaze 与端点色） |

---

## 2. 飞行手感设计 v1.1

### 2.1 已验证为正确（本轮逐位复现，给后续执行者当可靠地基）

- **恢复时间表 6 组全对**：sy=-1 @60/120/240 → 5.25 s/127.17 m、6.85 s/187.17 m、8.08 s/233.39 m，全部 `waterHit` 强制 cruise；sy=+1 → 2.87 s/46.89 m 空中改出；sy=+0.5 → 3.63 s/74.95 m；sy=-0.5 → 5.20 s/127.26 m。
- **fall 演化表全对**（t 自 hover 入口）：1.0 s → vy −3.924 / speed 3.941 / pitch −0.577；1.5 s → −8.829/8.961/−1.014；2.0 s → −13.734/13.887/−1.083；2.5 s → −18.639/16.662/−0.594。速度平台 16.67（≠22，永不改出）、pitch 全程最低 −1.084（碰不到 −1.1）均属实。
- hover 0.58 s＝0.5＋0.08、authority smoothstep 表、`FALL_SPEED_ATTACK 2.2` 在 1.2 s 只到 92.9%（目标 18 → 16.7）、trauma 线性衰减 0.22→0.19 s / 0.9→0.78 s，全部核对无误。
- 上一轮 F1-F10 的回填质量良好：满杆上拉必触海、FOV 链（`camera-rig.ts:205/213` 的 `baseFov + fovKick*speed01` ＋ `game.ts:590` 的 `min(9, 6+3*dive01)`）、线性衰减、12/18 分层等修正都已落进 v1.1 正文。

### R1（P0）pushover 的 fallback 条件与速度注入方式互斥——死代码或常开，二选一没做

**文档断言**（v1.1 第 114、118 行）：

- 第 114 行：pushover 进入时"速度从 0 **snap 到 `RECOVERY_SPEED 18`**（或用 `FALL_SPEED_ATTACK` 重建……不能同时承诺）"。
- 第 118 行：fallback 条件是"pushover 已经执行了 **0.8 s 以上**……且 pushover **确实没有让 speed 升到 `RECOVERY_SPEED 18`** 时，才 fallback"。

**矛盾**：

- 若选 **snap**：pushover 从第 0 帧起 speed ≡ 18，"没升到 18"永假 → fallback 是死代码，第 118 行整段失效。
- 若选**指数重建**（2.2 attack）：0.8 s 时 speed = 18×(1−e^{−1.76}) ≈ **14.9**，任何一次都"没升到 18" → fallback 几乎必触发，把玩家打回旧 fall（nose −1.1）——正是 R 系列要消灭的必触海路径。

**修法**：明确二选一并把 fallback 门改到与所选方式自洽——例如选 snap，则 fallback 判据应改为"pushover 延长机制（第 124 行的 +0.3 s）两轮用尽后仍持续满杆"；选重建，则门改成"0.8 s 时 speed < 14"这类重建路径真实可达的阈值，并说明它预期触发频率。

### R2（P0）松杆门挡下 hover 之后发生什么——未定义，且现状会比 hover 更糟

**文档断言**（第 120 行）：hover 准入松杆门"未检测到 `abs(sy) < 0.3` 则不进下一次 hover"。

**证据**：

- `game.ts:274-279`：`stepCruise` 里 hover 是 **pitch>0.25 且 speed<22 时的唯一出口**；`HOVER_PITCH: 0.25`（`game.ts:73`）从未在 v1.1 中出现。
- 挡掉 hover 后，cruise 能量模型（`game.ts:266-272`）在机头仰起时 `accel = 6 − 9.81·sin(pitch)` 为负，speed 会**钉在 0**、位置停在原地——一个没有 HOVER_FREEZE 拍点、也没有还杆路径的"静滞罚站"，比现行 hover 更难看。
- 反向利好文档没写：pushover 出口 pitch +0.08 **< HOVER_PITCH 0.25**，天然有一段免疫 re-hover 的窗口——这是防摆子的第一道闸，松杆门是第二道。设计应把两道闸写全。

**修法**：补一段"门挡下时的行为"——例如挡下的失速条件直接进 pushover（而不是 hover），或强制 pitch 目标压到 0 以下直到 speed≥22；并把 HOVER_PITCH 0.25 这道既有保护写进设计依据。

### R3（P0）"sy>-0.3 大概率空中改出"不成立——真实改出边界在 +0.45~+0.5

**文档断言**（第 73-77 行）："压杆/松杆（`sy>-0.3`）：speed 能在触海前回到 `STALL_SPEED=22`，大概率空中改出；介于中间（`-0.85≤sy≤-0.3`）：取决于……"。

**实测**（240 m，速度平台与高度无关，60 m 同结论）：

| B 阶段杆量 | fall 内速度上限 | 结局 |
|---|---|---|
| sy = −0.6 | 17.14 | 触海 |
| sy = −0.2 | 17.93 | 触海 |
| sy = 0 | 18.56 | 触海 |
| sy = +0.3 | 20.23 | 触海 |
| sy = +0.4 | 21.37 | 触海（7.45 s / 233.94 m） |
| sy = +0.5 | ≈22（可越线） | **空中改出**（3.63 s / 74.95 m） |

整个 `(-0.85, +0.45)` 杆量带的速度平台都过不了 22——"取决于"的中间带实际横跨文档所写的三段中的两段。**"能否空中改出不取决于高度，只取决于杆量"这句结论仍对，但门槛线要改写**：只有实质压杆（约 `sy ≥ +0.45`）才空中改出；-0.3 不是任何有意义的边界。此错会影响：松杆门 0.3 的语义解释（中位门与改出门是两件事）、验证清单"松杆门"用例的预期值。

### R4（P1）掉高账不自洽：vy=0 与"初始下沉 4~6 m/s"不能同段成立

第 116-117 行："失控总时长 2.38 s、掉高 ≤15 m"；"pushover 段 vy=0 不再掉高 → 总掉高 ~6 m"。但第 114 行同一 pushover 段"初始下沉只给 `-vy 4~6 m/s`"——这 1 s 内自带 ~2-3 m 沉降。总账应为 ~8-9 m。15 m 预算仍够，但 "~6 m" 与后文数字对不上；且 fall 0.8 s ≈ 5-6 m 是从"fall+1.0 s 掉 8.49 m 按二次缩放"外推的，执行时应以实测回填。

### R5（P1）Q3-4 的 FOV"重分配"两个候选在巡航段都是空操作

- 事实链：`speed01 = (speed−34)/44`（`MIN_SPEED: 34`，`game.ts:65`）；持续平飞巡航 speed=46 → **speed01 ≈ 0.27**；fov = 60 + min(9, 6+3·dive01)·speed01（`camera-rig.ts:205/213` ＋ `game.ts:590`）。
- 所以**持续平飞 fov ≈ 61.6°，不是 v1.1 写的 66°**——66/69° 是俯冲瞬态（speed01→1）的值，把瞬态当巡航基线了。
- 代数：候选 A `60+6·speed01+3·dive01` 与现状 `60+(6+3·dive01)·speed01` 之差 = `3·dive01·(1−speed01)`——**巡航（dive01=0）时恒等于现状**；候选 B 在巡航（s≈0.27）给 61.0°，比现状还低 0.6°。
- 结论：两个候选都治不了文档自己诊断的"巡航 fov 静止感"。病根是巡航 speed01 恒在 0.27 附近不动，不是缺 speed 耦合（耦合已存在）。要动只有三条路：把 kick 挂到**加速度/俯冲进入率**、抬 `CAM_FOV_KICK` 上限、或承认 FOV 无作为、把 Q3 的宝押在 #1-3（风絮粒子/海面流速/云门——这三条的诊断与方案本轮核对都是对的）。建议 Q3-4 按此改写或整条降级。

### R6（P2）§1 速览表的锚点与触发细节（3 处小错，上轮 F10 未覆盖到的）

| 文档 | 实际 |
|---|---|
| "失速三段 … `src/game.ts:104-133`" | 常量块在 **L70-96**（L104-105 是 `FlightPhase` 类型）；机制段 285-339 对 |
| "contrail 阈值 `CONTRAIL_BANK 0.42 / CONTRAIL_SPEED 0.72`" | 常量在 **`feel.ts:26/29`**（`game.ts:677` 是音效那路的内联字面量）；触发是 **OR**（`feel.ts:363`：`|bank|>0.42 || speed01>0.72`），不是并列条件——平飞 speed01 0.27 < 0.72 所以结论"平飞不触发"仍成立，但机制描述要写对 |
| "hit 只温柔拉到 `WATER_PULLUP_PITCH=0.12`"（贴海行，引 skim.ts） | 常量在 **`game.ts:96`**；且抬 pitch 只在 impact 分支（`game.ts:367-372`），fall 内非 impact 触底（L373-377）只强制 cruise+speed≥22 不抬 pitch；`waterHit01 = max(steep, fast)` 是 OR（`skim.ts:46-51`） |

另：§6 清单"下压杆无反应"表述过强——`PITCH_FLOOR_FLOOR −0.12` 下压杆仍有约 −6.9° 缓降响应，改成"下压杆最多缓降、不再俯冲"。

---

## 3. 穹顶云 P1.5/P2 计划

### 3.1 已复核通过（上轮回填质量抽查 + 本轮新增核验）

- 全部代码锚点本轮重验通过：`qualityParams`/`uSteps`/`uOctaves`/`detailFine` 无条件求值/`mix(…uOctaves.sub(1))`/`smoothstep(0.30,0.46,weather)`/`.mul(0.32)`/`NodeMaterial` 无 fog/`depthWrite=false`/`setQuality` 只写 `uSteps` 且函数体以 `\n  };` 收尾（Task 1 测试窗口成立）/`STEP_CURVE_POWER`/`LIGHT_PROBE_METRES`/`DENSITY_SCALE`/`FALLBACK_BANDS`/`uBand0-3`/`toBoxUV`。
- **Task 6 的 vec4 正则可行**：输出语句是单行 `return vec4(acc.div(max(accA, 1e-4)), accA);`（`dome-cloud.ts:322`），全文件唯一 `vec4(` 调用，`vec4\([^;]*accA[^;]*\)` 恰好匹配一次。
- **Task 5 的 `sin` pin 可行**：three/tsl 解构（L119-144）逐名一行、行行尾逗号，`/^\s+sin,$/m` 能落；`sin` 确实缺席、`smoothstep` 确实在。
- **Task 7 的 `domeHorizon?\.setVisible\?` pin 与房子风格一致**：`world.ts:250-252` 的 `setSunColor` 就是 `dome?.setSunColor?.(color)` 可选链到底。
- `fadeAt` 方向确认：≤1200 → 1，≥1800 → 0，smoothstep（`dome-cloud-field.ts:90-99`）——这是 R8 的证据基础。
- `DOME_DRIFT` 双层速度属实且 `driftOffset(elapsed, layer)` **已带 layer 参数**（`dome-cloud-field.ts:123-134`）——上轮"双层装不下"的修复已到位。
- Task 0.5 前提铁证补强：`NodeMaterial.setupOutput → setupFog` 对 **custom colorNode 一样生效**（`node_modules/three/src/materials/nodes/NodeMaterial.js:1183-1205`，fog 节点混 RGB 保 alpha）；且 dome 是全场景唯一 700 m+ 开雾的对象（sky/sea/puff/stars 全部显式关雾，飞机 toon 材质只在近景）。像素侧：云带像素均色 (175.4, 87.2, 97.0) 与雾色 (201,106,122) 通道同比 ~0.87，雾洗实锤。
- `sunColorFor` 钳制、`worley3`（已在 detail 体积里以 4 细胞在用）、measure.py 口径与既有文件、`horizon.ts` 命名冲突、POST dof 行号、`DepthOfFieldNode.js:375` 钳制方向模板——全部与计划一致。

### R7（P1）近地平线存在一个未定性的 on/off 异常，正好压在 Task 7 的验收带上

P1 帧（`?pos=0,240,-300`，deck on/off 差值，竖条内）在仰角 **+1.2°~+2.2°**（rows 360-375，约 3 行高、全宽）有一瓣异常：hitFrac 0.90-0.98、平均 |diff| 19-37/255。形态是 **ON 帧更暗**（off 行均值 159-165 的渐亮 ramp，on 变成 152-154 平台 + row 375 处突变到 164）。

- deck 几何解释不了：240 m 机位、deck 底 380 m，2° 仰角入板需 ~3.8 km > 盒半宽。
- 也不是 DOF 下抹：紧邻其上的 5°-10° 带差值恒 0.0%，涂抹不可能跳过 100 行只落 3 行。
- 机制未定论（候选：post 链与天空地平线亮带边缘的相互作用 / SMAA 对该边的响应差异）。量级小（~0.3% 面积，coverage 指标不受影响），但它就在 Task 7 patch 与"海平面有云、交接干净"验收所盯的带里。
- **修法**：Task 0.5 Step 3 重抓基线时加一条检查——关雾后 on/off 在 ±5° 带是否仍有此瓣；Task 7 Step 4 验收前先复测一次。异常若仍在，patch 的 alpha/淡出标定会被它污染。

### R8（P1）Task 7 patch 淡出方向未钉——照"复用 fadeAt 口径"字面执行，patch 大半不可见 + 交接带双倍叠加

- `fadeAt(d)`：1（≤1200）→ 0（≥1800）。patch 散布恰在 1200-1800 m，若 alpha＝`fadeAt(自身距离)`：1500 m 处只剩 0.5，1600 m 处 0.26，1800 m 恒 0——**散布窗与可见窗错位**，`patchesFor` 的 3-8 团有一半实际看不见。
- 且 deck 在同一带也按同式淡出：1200-1400 m 段两者叠加会顶到过透明，形成"环带增密再消失"的接缝观感，与 Step 4 "无断线/双影"门打架。
- **修法**：显式钉 patch 自身 alpha 曲线（建议 1200→1350 淡入、1350-1650 持满、1650→1780 淡出，全程在 `fadeEnd=1800` 盒壁之前归零），或与 deck 互补交接（deck 淡出率＝patch 淡入率），并写明 blob/团计数按"可见 patch"计。

### R9（P1·玩法决策点）世界固定 ±40° 扇区 vs 可自由转向的飞行

飞机可任意 yaw（bank 转弯），而 patch 方位"在世界坐标系一次性定死、只跟平移"。玩家掉头 180° 飞，前方地平线就永远没有云——用户拍板的"只要正前方"更可能指"**玩家的前方**"，而 B 方案实现的是"**世界的前方**"。三条路：

1. 接受（若玩法实质单向、构图永远朝 -z，需主人确认）；
2. 稀疏 360° 环（每 ~45° 1-2 团，总量仍"不密布"，与拍板精神兼容）；
3. 扩 `WorldView` 加朝向（计划已以"波及 puff/sea 消费者"为由否决——本轮实核该顾虑不成立：`WorldView` 是纯数据接口，消费者只读 `camera`/`radPerPixel`，加字段只需动接口定义与两处字面量）。

这不是笔误，是 Task 7 开工前要拍的板。

> **裁定（2026-11-10，主人）：选"玩家的前方"。** 已回填计划 Task 7：`WorldView` 新增 `headingRad`（`main.ts:337` 由相机世界朝向派生），patch 改**朝向量化滑窗**（`HEADING_BIN_DEG 20°`，bin 内世界坐标定死、跨 bin 视野外补生/回收、补生 0.3s 淡入），`patchesFor(seed, binIndex)` 双参。R9 关闭。

### R10（P2）Task 5"只改几何，不改 τ"与乘进 `densityAt` 的 `body` 矛盾

调制乘在 `dome-cloud.ts:241` erosion 之前的 `body` 上＝乘在 `densityAt` 内部；Task 4 的 light march 采样**同一个 `densityAt`**，τ 必然同变。二选一：把调制只乘在主射线密度上（light tap 用未调制值，需拆函数），或承认 τ 同变（视觉上反而自洽）并改掉第 348 行的"不改 Task 4 的 τ"。现状会让 executor 拿着互相矛盾的验收依据。

### R11（P2）Task 9 Step 3 "8 对 16 帧"数不上

枚举：单看 soft 组 = dome(2) × 档位(2) × t0/t30(2) = 8 帧 = **4 对**；三组（soft/flat/sunoff）全抓是 24 帧 12 对，且 flat 组不需要 dome=0 对照、sunoff 组是 sun 开关不是 dome 开关，"对"的定义还不同。上轮 B2 让核对帧数，回填的"8 对 16 帧"仍不闭合。修法：列一张显式矩阵表（组 × 档 × 帧 × 对照方式），不写总数。

### R12（P2·执行提醒）四个任务的"Task 9 前先目测、之后回跑重判"补丁可行，但回跑义务只散落在各任务正文

建议在 Task 9 Step 4 显式加一张"回跑清单"（Task 3 Step 3 / Task 4 Step 4 / Task 5 Step 3 / Task 6 Step 4 四项），否则漏跑就是目测值静默定稿——这正是上轮 B3 想堵的洞。

---

## 4. 调色面板计划

### 4.1 已复核通过

- main.ts 全部行号锚点（L267/275/276/282/298-304/370/399/407/412/73/214/225、qaParams 块 L184-194）本轮重验全对；`setHazeTargets(hazeLinear, awayEdgeLinear)` 两个线性 Vec3 的签名确认。
- `SkyTrackState` 面板所列 12 个字段**全部实名存在**（`sky-track.ts:44-77`；另 13 个字段不进面板，无碍）；`skyTrackAt` 段外钳端点（范围 [-8, 6.97]），与"−8…+15 scrub、>6.97＝参考档"的设计一致；`sun-state.setAzEl` **不钳仰角**（仅有限性守卫），面板可自由驱动。
- Step 1b 的 `linearToSrgbCss` pin 期望值核对无误：[0.5]→188→`#bcbcbc` ✓；公式与实现一致（未导出属实）。
- module-graph 只扫 src 根、`src/debug/` 豁免 ✓；9 个海常量全部真实导出（含行号）✓；`qa.setQuality` 存在 ✓；`?sea=debug` 确需重载（仅启动解析）✓。
- 三计数器门控方案与 `sun.version` 现行逻辑兼容（首帧 `-1≠version` 会同步）✓。

### R13（P1）面板控件清单调用了 qa 层不存在的函数——"表现层不绕过 qa 层"纪律自破

Task 2 海面组要做的三件事里有两件没有 qa 层入口：

- "`?sea=nochop` 等价 `setChopGate(false)`"——`setChopGate` 是 `SeaOcean` 的方法（`sea/material.ts:647`），qa 层没有；
- 锁 haze 后的"两端点颜色拾取"——写端点只能调 `world.setHazeTargets(haze, awayEdge)`（`world.ts:243-244`），qa 层也没有。

而 Interfaces 明写"面板只调 Task 1 的 qa 函数……纪律：表现层不绕过 qa 层"。修法二选一：Task 1 的 qa 层补 `setChopGate(on)` 与 `setHazeEndpoints(haze, awayEdge)` 两个透传（照 `setQuality` 先例），或把纪律改写为"只经 qa/world 句柄，禁直碰 uniform 与 DOM 外状态"。当前文本会让 executor 在 Task 2 现场二选一。

### R14（P1）`exportColorState` 的 repro 闭环缺 haze 侧状态——锁定态画面必不可复现

repro 双通道目前只含 `?sun=` + `trackpatch` + `qa.setSun/qa.setTrackPatch`（第 103、138-139 行）。但面板明确支持"锁 haze + 锁定时改两端点颜色"（Review Focus 3 自己点名的高危路径）：这套画面重放时既没有 `qa.lockHaze(true)`，也没有端点色——重放必不一致，恰好砸中 Task 2 Step 3 的"复现命令双通道各跑一遍画面一致"验收。修法：repro 追加 `qa.lockHaze(true)`；若按 R13 补了 `setHazeEndpoints`，锁定态下的端点值一并导出。

### R15（P2）跨计划执行顺序会使两处硬编码基线过期

- 整体验收 1 钉"无参默认画面与 `353abdf` 逐像素一致"：`353abdf` 是 11-08 的 commit（现 HEAD 的祖先 ✓）。若穹顶云计划先执行（Task 0.5 关雾即改变默认画面），这条必挂。修法：before 帧改为"本计划开工前 HEAD 现抓"。
- Task 0 与验证 2 的"470 用例"：穹顶云计划 Task 1-9 会加测试文件。修法：写"以开工实测为准"。
- 同理 Task 0 的"qa.ts 当前 7 个 parser"在穹顶云 Task 2 落地后变 9 个——计划已写"漂移以 grep 为准"，够用，列出即可。

### R16（P2）sunspin 面板机制需写明

`?sunspin` 是启动期常量（`parseSunSpin` → `main.ts:189`，无运行时 setter；停止只能重载）。面板的"播放/暂停＋速度滑杆"实际得靠每帧调 `qa.rotateSun(deg)`（存在，`main.ts:403`）自建状态机。"复用 `?sunspin` 语义"应改为"复用单位与 ≤360 上限，驱动走 `qa.rotateSun`"。

### R17（P3·顺带）两处会误导 executor 的陈旧注释

- `main.ts:17-18` 头注释仍称"海已于 11-06 删除、本文件不再托管水面"——海已随 rebuild 回归（L192-194 在用）。
- `qa.ts:50-56` 注释称 nochop 钩子"setQuality 换档后失效"——`sea/material.ts` 已有 `chopOverride`（L598、L631-643），现行为是**换档后仍生效**。面板计划引用的 nochop 行为以代码为准，两处注释建议顺手修。

---

## 5. 画面证据（P1 帧，`?pos=0,240,-300`，竖条 434×772）

| 量测 | 结果 | 对计划的含义 |
|---|---|---|
| coverage | 29.78%（与 P1 报告逐位一致） | 量具口径无损 ✓ |
| deck 实占仰角 | 25-31°: 100%、20-25°: 96%、15-20°: 96%、10-15°: 15%、**5-10°: 0.0%**、±5°: 14.3%（＝R7 异常瓣，非真云） | 地平线 patch 动机成立：空带是 **0-10°**；patch（60 m 机位 9.2-17.6°）恰与 10-15° 薄边衔接 ✓。设计 §12-2 "只在 21-30° 可见"低估约 6°（该句按 60 m 机位口径另算，两口径都指向同一结论） |
| 云带均色 vs 雾色 | (175.4, 87.2, 97.0) vs (201,106,122)，通道同比 ~0.87 | Task 0.5 雾洗前提的像素实锤 ✓ |
| 带内亮度结构 | 下半 137 vs 上半 114（**底亮顶暗**） | 见 R18 |
| luma 跨度 | p5 74 / p95 163（span 0.348） | 与 tone_span 0.327 量级互证 ✓ |

### R18（P2·视觉语言决策点）设计门 4 要"暗底/亮顶"，而日落几何给的是"底亮顶暗"

7° 太阳照云底：当前帧（也是物理直觉）是**底亮顶暗**。Task 4 的 3-tap light march 沿近水平太阳方向积累光学厚度，方向上会**强化**受光底/背光顶，而不是翻转成"暗底亮顶"。设计 §2.3 "云底暗、边缘亮"若是要的，那是风格化选择（与 `ref-01-sunset-glide.png` 的吉卜力语言对照过吗？），不是光学会自然给出的。建议：门 4 判据改写成"受光边/背光体分离"或"亮度直方图双峰"，避免 executor 拿"暗底"当硬门去调一个物理上反向的参数。

---

## 6. 复现命令

### 6.1 飞行模拟（v1.1 口径：A 阶段满杆至 hover，B 阶段换杆量）

```ts
import { describe, it } from 'vitest';
import { createFlightState, stepFlight } from './game';
// phase = (s) => (s as any).phase
// let s = createFlightState(startY); 循环 stepFlight(s, 1/60, { x: 0, y: hoverAt < 0 ? -1 : syB })
// 记 hoverAt（首次 'hover'）、cruiseAt（其后首个 'cruise'）、yAtFall、fall 内 speed 上限
```

关键输出：B=-1@60/120/240 → 5.25/127.17、6.85/187.17、8.08/233.39（触海）；B=+1 → 2.87/46.89（空中）；B=+0.5 → 3.63/74.95（空中）；B=+0.4@240 → speed 上限 21.37、7.45 s 触海；B=+0.3@240 → 20.23 触海；B=0@60 → 18.56 触海；B=-0.2@240 → 17.93 触海。

### 6.2 像素分析（竖条口径＝measure.py 的 --rect）

```python
import numpy as np, math
from PIL import Image
on = np.asarray(Image.open('artifacts/dome-audit/p1-on.png').convert('RGB')).astype(np.int16)
off = np.asarray(Image.open('artifacts/dome-audit/p1-off.png').convert('RGB')).astype(np.int16)
X0, X1 = 475, 909  # 竖条 = 434x772, 9:16
m = np.abs(on[:, X0:X1] - off[:, X0:X1]).max(axis=2) > 8
# 仰角剖面（水平相机 vfov60）：elev(r) = degrees(atan((1-2r/H)*tan30))
# R7 异常瓣：rows 360-375（+1.2~+2.2°）hitFrac>0.9、ON 行均值 152-154 vs OFF 159-165
```

## 7. 限制

- 未起浏览器：三份功能均未落地，无页面对象可测；飞行用无头模拟（未覆盖 bank/风/鼠标耦合输入），穹顶用既有帧像素分析。
- R7 异常机制未定论（已排除 deck 几何与 DOF 下抹两个假设）；标注为"待 Task 0.5 关雾后复测"。
- R3 改出边界 +0.45~+0.5 是 0.1 步进夹逼（+0.4 触海 / +0.5 改出）。
- 画面结论基于 240 m 机位 P1 帧；60 m 机位的仰角分布按几何推算。
