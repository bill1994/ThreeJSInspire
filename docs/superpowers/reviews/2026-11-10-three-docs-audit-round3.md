# 三份文档交叉复审（第三轮）报告

- 日期：2026-11-10
- 仓库：`G:\DSHProject\threejs-inspire`，分支 `feat/dome-cloud-volumetric`，HEAD `e93561b`
- 审核对象：按第二轮报告回填后的**工作区修复稿**（未提交）。`git diff --stat`：3 文件 `+89 / −66`
  （panel `+20/−15`、dome `+43/−17`、flight `+26/−34`），三份文档全文 213 / 724 / 291 行。
- 审核方式：三份文档**全文通读**（不是只读 diff）；`git diff` 逐条对账 R1-R18；源码逐行复查
  （`game.ts` / `feel.ts` / `camera-rig.ts` / `director.ts` / `skim.ts` / `main.ts` / `world.ts` / `qa.ts` /
  `sea/material.ts` / `dome-cloud.ts` / `world.test.ts` / `tsconfig.json` / `measure.py`）；
  无头飞行复算（`createFlightState`/`stepFlight`，dt=1/60，A 阶段满杆至 hover、B 阶段换杆量，与 v1.1 同口径）；
  P1 量具口径核对。未起浏览器（三份功能仍未落地）。
- 与第二轮的关系：R1-R18 逐条回填对账，结论 **11 条闭合 / 5 条半闭合 / 2 条仍开放**；
  半闭合 5 条 + 新增 12 条，编号 S1 起。
- **本轮未修改三份文档**：修复稿还挂在工作区（未提交），此时叠加我的改动会把两份 diff 混在一起、无法回滚。
  每条都给了可直接替换的文本，拍板后一次改完（S6/S8/S9/S11/S12 + 小项不涉及设计决策，可先落）。

## 0. 基线（本轮实测）

| 项 | 结果 |
|---|---|
| 飞行复算 11 组 | 与 v1.1 两张表**逐位一致**（含 +0.45 边界，见 §5.1），无一处需要改数 |
| `game.ts` 常量/分支锚点 | L65/70-96/96/99-100/274-279/285-339/311-316/362-378/590 全部复核通过 |
| `feel.ts` 锚点 | `CONTRAIL_BANK 0.42` L26、`CONTRAIL_SPEED 0.72` L29、OR 触发 L363 全部属实 |
| `world.ts` 锚点 | `WorldView` L23-26、try/catch L190-196、`lastView` L201、`setHazeTargets` L243-244、`setSunColor` L250-252、`dome.update` L277 全对 |
| `main.ts` 锚点 | L184-195（qa 启动块）、L267/275/276/282/298-304/370/399/403/407/412 全对；L337 就是 `WorldView` 字面量拼装点 |
| `sea/material.ts` | `setChopGate` L647、`chopOverride` L598、`setQuality` 的 override 守卫 L631-643 属实 |
| `measure.py` | coverage / tone_span / row 梯度**全部在 on/off 差分 mask 内**统计（文件头 docstring 已写明） |

## 1. 总览

| 文档 | 结论 | 本轮新发现 |
|---|---|---|
| 飞行手感 v1.1 | R3/R5/R6 回填精准；但 R1 的 fallback 改完仍是死代码，且"2.4s 硬保证"被自己的延长机制打破 | S1 |
| 穹顶云 P1.5/P2 | R10/R11/R12 闭合；R7/R9 只落了一半；Task 7 的 patch 生命周期与跨 bin 合并都没定义、Task 5 量纲混用 | S2 S3 S6 S7 S8 S9 S10 |
| 调色面板 | R13/R16 闭合；R14 只补了控制台通道，导出端点的数据源没定义 | S4 S5 S11 S12 |

## 2. 回填对账（R1-R18）

| 编号 | 应落位置 | 现状 | 判定 |
|---|---|---|---|
| R1 | flight 114/118/250 | snap 定案已写；fallback 判据改写后仍不可达、"两轮"无定义 | **半** → S1 |
| R2 | flight 125-127/271 | 门挡下直接进 pushover、两道闸都写全了 | 闭（入口初态见 §4 小项） |
| R3 | flight 73-77 | 门槛改 +0.45，复算逐位一致 | 闭 |
| R4 | flight 117/251 | 掉高改 ~8-9m，账能对上 | 闭 |
| R5 | flight 175-178/259 | FOV 降级为"维持现状" | 闭（§4 P1 档残留见小项） |
| R6 | flight 14/16/166/273 | 三处锚点、OR 语义、"缓降"表述全改 | 闭 |
| R7 | dome 74-76 | 只写进 Task 0.5 Step 3；Task 7 Step 4 没有复测项 | **半** → S6 |
| R8 | dome 539-541 | 曲线与"可见 patch"口径都写了 | 闭（但与生成带宽冲突 → S2/S9） |
| R9 | dome 31-32/473-493 | 滑窗方案写全；`WorldView` 字面量少算一处 | **半** → S8 |
| R10 | dome 354 | τ 同变，旧句作废 | 闭 |
| R11 | dome 670-678 | 14 帧矩阵，算术自洽 | 闭 |
| R12 | dome 685-686 | 回跑清单四项 | 闭 |
| R13 | panel 102-106/159/167 | 两个透传入 qa 层，纪律改写 | 闭（nochop 单向见小项） |
| R14 | panel 60/102-104/143 | 控制台通道补了；URL 通道仍无锁与端点 | **半** → S4/S5 |
| R15 | panel 72/192 | before 改成现抓、用例数改成实测 | **半** → S12 |
| R16 | panel 163 | `?sunspin` → 每帧 `qa.rotateSun`，属实 | 闭 |
| R17 | `main.ts:17-18`、`qa.ts:50-56` | 一字未动；而本计划正是"首个动这两个文件"的计划 | **开放** → S11 |
| R18 | design §2.3/§5.2、dome Task 4 | 仍写"暗底/亮顶"，executor 会照做 | **开放** → S7 |

---

## 3. 新发现

### S1（P0）fallback 改完仍是死代码；"两轮"没定义；2.38s 硬保证被延长机制打破

**文档断言**（flight 114/116/118/128）：

- 118：fallback 只在"**延长机制两轮用尽**"时触发，条件还要求"仍满杆、且仍失速（**speed 掉回 22 以下且 pitch>0.25**）"。
- 128：延长 = pushover **延长 0.3s** 且**强制 pitch 上限 −0.05**。
- 116：失控总时长**锁死在 2.38s（取整 2.4s）**。

**证据**：

1. `pitch>0.25` 在延长段恒假：延长把 pitch 压到 ≤ −0.05，pushover 目标本身也只有 +0.08。
   R2 的直接入口（门挡下从 cruise 进）入口瞬间确实 pitch>0.25，但 fallback 被"两轮用尽"挡在 ≥1.3s
   （两轮则 1.6s）之后，届时 pitch 早已 ≤0.08。
2. `speed<22` 也不是安全判据（**按第三轮裁定修正**）：pushover 的 pitch 以 3.6/s 从 +1.2 落向 +0.08，speed 最低 ~17.2-17.5、1.6s 约 20.8-22，大概率仍 <22 → 同样会误伤满杆玩家。（原稿按"pitch 已收敛到 0.08"估出的 22.07 前提错了，保留此注以免误导。）
3. "两轮"全文只出现一次（118），正文只定义了一次 +0.3s——上限几次、是否叠加、写进哪个常量都没有。
4. 时长账：延长 0.3s → 2.68s；"两轮" → 2.98s。验收 270 的"**≤2.4s**"会在延长路径上失败。

**修法**（二选一，都要动 118/116/270 三行）：

- A（推荐）：fallback 判据删掉 speed/pitch 两个永假条件，只留"延长用尽仍满杆"，并新增 `PUSHOVER_EXTENSIONS: 2`；
  硬保证改成"正常 2.38s、延长路径 ≤2.98s，掉高仍 ≤15m"；验收 270 同步。
- B：承认自动 fallback 不可达，删掉触发条件，写"fall 仅在调试开关下可达"；硬保证保持 2.4s。

### S2（P0）Task 7 的 patch 生命周期只定义了一半：跟随平移 vs 世界坐标定死，两种读法各坏一边

**文档断言**（dome 490/536-541）：

- 490："patch **世界坐标**在同一 bin 内**定死**（不随视角旋转——保视差，不贴镜头晃）"。
- 536："update 做两件事：**相机跟随平移** ＋ 朝向滑窗维护——当前 bin 内的 patch **世界坐标定死**不旋转"。
- 537："跨 bin 时按 `patchesFor(seed, bin)` 增量补生…并**回收离窗 patch**"。
- 539-541：alpha 按**距离** 1200→1350 淡入、1350-1650 持满、1650→1780 淡出。

**证据**：

- 两句字面互斥：跟随平移 → 世界坐标每帧在变；世界坐标定死 → 不跟随平移。执行者必须自己选一个。
- **读法 A（跟随相机）**：距离恒定 → 距离 alpha 每帧不变。可见区间是 [1275,1715]，
  1200-1275 与 1715-1800 共 160/600 = **26.7%** 的距离带永远 <0.5，被 541 的"可见 patch"口径排除；
  且 46 m/s 飞过去云不会变大，"保视差"只剩转向视差，没有接近视差。
- **读法 B（世界固定）**：1500 m 正前方的 patch 飞 **4.9s** 就掉进 alpha<0.5 区，而要飞到 0 m 才因越出 ±40°
  被回收（**32.6s**）——中间约 **27s** 前方没有任何可见 patch。Task 7 的验收是静帧（Step 4），
  抓不到这个洞，真飞起来就是"云突然没了"。
- 根因：**生命周期判据（方位）与 alpha 判据（距离）不是同一个量**，缺一条"距离 <1200 时回收/重投"的规则。

**修法**：钉一条生成规则，二选一：

1. "patch 位置 = 相机位置 + per-patch 固定距离 × 方位（bin 内定死）"，alpha 改成 **per-patch 固定值**或只按 bin 淡入，删掉距离曲线；
2. "世界固定位置 + 距离 <1250 m 时回收到 1750 m 并重抽方位（0.3s 淡入）"，保留距离曲线。

无论哪条，541 的"可见 patch"口径与 S9 的测试必须同口径。

### S3（P1）Task 5 的 `y` 有两种量纲：sin 用米 → 波长 1/3 m；ceiling 用归一 → 整层云消失

**文档断言**（dome 344-353）：

```ts
const ceiling = smoothstep(DOME_SLAB.base + 20, DOME_SLAB.base + 100, y);   // y 必须是米
profile = ceiling.mul(float(0.72).add(float(0.28).mul(sin(...))));          // 相位 2π·(3y+φ)
sin(y.mul(3).add(phi).mul(2 * Math.PI))                                     // y 必须是 0..1
```

**证据**：

- `ceiling` 的阈值是 400/480 m，`y` 只能是**米**（380-1150）。
- 设计 §5.3 要"2–3 条密度峰"，即整层 3 个周期，`y` 必须是**归一化 0..1**；若用米，`sin(2π·3y)` 的波长是
  **0.33 m**，逐采样白噪。
- 两个分支各自是硬失败：照 ceiling 用米 → 云变雪花；照 sin 用归一 → ceiling 恒 0 → **整层云消失、coverage=0**。
- 测试只钉 `/0\.72/` 和 `/^\s+sin,$/m`，抓不到量纲错。

**修法**：明确写 `const yn = toBoxUV(p).y;` 给 sin 用（0..1），`ceiling` 继续用米；或把 sin 改成
`sin(y.sub(DOME_SLAB.base).div(SLAB_HEIGHT).mul(3).mul(2*Math.PI))`，并在测试里钉 `.div(SLAB_HEIGHT)`。

### S4（P1）R14 只补了控制台通道：URL 通道仍表达不了 haze 锁，双通道验收不可能过

**文档断言**（panel 102-104；验收 194）：repro 的 URL 是 `?sun=az,el&trackpatch=…`；控制台是
`qa.setSun; qa.setTrackPatch; qa.lockHaze`。验收 3 要求"**双通道各跑一遍画面一致**"。

**证据**：锁定 + 改过端点的画面，URL 里既没有 lock 也没有端点 → 新开窗口必不一致。
R14 的原话是"repro 追加 `qa.lockHaze(true)`；若补了 `setHazeEndpoints`，端点值一并导出"——现在两句都只落在控制台字符串上。

**修法**：URL 加 `&hazelock=1&haze=r,g,b&away=r,g,b`（**线性值**，不是 sRGB）。**启动顺序必须是"先 `setHazeEndpoints`（直写 uniform）→ 再 `lockHaze(true)`"**：
反过来的话首帧 `syncSun` 被锁挡掉，海面拿的是模块默认端点（`sea/material.ts:552`），画面照样不一致。
或把验收 3 降级为"URL 只保证未锁定态，锁定态以控制台通道为准"。

### S5（P1）`exportColorState` 的端点值没有来源：qa 拿不到 uniform，面板本地又不归 qa 管

**文档断言**（panel 102、143）：返回值含 `haze: Vec3 | null, awayEdge: Vec3 | null`；
Step 3.5 又说"锁定态若**面板本地持有** haze/awayEdge 值，repro 追加 `qa.setHazeEndpoints(...)`"。

**证据**：`syncSun` 里 `const { haze, awayEdge } = seaHazeEndpoints(...)`（main.ts:298-304）是局部变量，
`world` 没有 getter，qa 层也没有缓存。三种来源互相打架：

- **重算**：锁定后玩家改过端点，重算值 ≠ 实际 uniform 值 → 导出的 repro 是"没改过"的画面；
- **面板本地**：qa 拿不到 → `exportColorState().haze` 只能是 null，与 Review Focus 3"必须包含锁定态端点值"冲突；
- **syncSun 缓存**：计划没写。

**修法**：main 闭包加 `let hazeNow: Vec3 | null = null; let awayEdgeNow: Vec3 | null = null;`，
`syncSun` 未锁定分支赋值、`setHazeEndpoints` 里也赋值，`exportColorState` 读它；
QA 测试钉"锁定 → 改端点 → 导出值 = 改后的值"。

### S6（P1）R7 只回填了一半：Task 7 Step 4 没有"验收前先复测异常瓣"

**文档断言**：R7 修法要求两处——Task 0.5 Step 3 重抓基线时检查、**Task 7 Step 4 验收前先复测**。
现状：dome 74-76 补了前一处；Task 7 Step 4（554-556）只有"海平面有云、交接无断线/双影"，没有复测项。

**证据**：R7 的异常瓣在 rows 330-420 / ±5°、ON 帧暗 ~10 luma；Task 7 的验收盯的正是这条带。
异常未定性时抓的 patch alpha/距离标定会被它污染，且报告分不清是 patch 的问题还是异常瓣的问题。

**修法**：Task 7 Step 4 开头加一句："先按 Task 0.5 的口径复测 rows 330-420 差值瓣；仍在则先定性，
不得用该帧标定 patch 的 alpha 与距离。"

### S7（P2）R18 的可执行文本仍写着"暗底/亮顶"——executor 会拿它当硬门去调反方向

**文档断言**：dome 271"判据是云带亮度直方图出现**暗底/亮顶分离**"；设计 §5.2（design 101）同；
Task 4 Step 4（320）"直方图**暗/亮**分离"。

**证据**：R18 的结论是 7° 太阳给的是**底亮顶暗**，暗底亮顶是风格化选择，Task 4 的 3-tap march 只会强化
"受光底/背光顶"。"暗/亮分离"又可以被读成两种极性——等于没钉。R18 被记成"开放/待拍板"，
但 R18 的建议（改写判据）本身不需要拍板，只有"要不要暗底"才需要。

**修法**：Task 4 Interfaces + Step 4 改成"**受光边/背光体分离（亮度直方图双峰），不规定底/顶极性**"；
design §5.2 同步；若确实要暗底，另标"美术选择（对照 `ref-01-sunset-glide.png` 拍板）"。

### S8（P2）`WorldView` 加必填 `headingRad` 会打断 `world.test.ts:136`，tsc 直接红

**文档断言**（dome 473）："接口加一个必填字段…`world.ts:201` 的 `lastView` 初始字面量同步补…
**实核只需动两处字面量**"。

**证据**：还有第三处——`src/world.test.ts:136`：

```ts
world.update(3.5, 1 / 60, { camera: new THREE.Vector3(0, 7, 0), radPerPixel: 6.014e-4 });
```

`tsconfig.json` 的 `include: ["src"]`、`strict: true` → 缺必填字段直接报错，Task 7 Step 5 的
`npx tsc --noEmit` 必红。第二轮的 R9 结论本身也写的是"两处"，这处是上轮和这轮一起漏的。

**修法**：三处（main.ts:337、world.ts:201、world.test.ts:136）；或把 `headingRad` 设成可选默认 0——
但那与"必填、防止消费者忘传"的意图相反，推荐补测试字面量。

### S9（P2）可见 patch 计数与单测口径不一致：测试看总数，门看 alpha≥0.5

**文档断言**（dome 501-515 测试；541 门）：测试断言 `patchesFor` 返回 **3-8 个**；
门按"**可见 patch（alpha ≥ 0.5）**"计。

**证据**：按 539-541 的曲线，可见区间是 [1275,1715]，只占 1200-1800 的 **73.3%**；
均匀撒 3-8 个 → 可见 2.2-5.9，**可能 <3**。测试绿、门红，正好是 R8 想堵的"散布窗与可见窗错位"的残余。

**修法**：生成器的距离区间直接收到 1300-1700（全部可见），或单测加一条"alpha≥0.5 的 patch ≥3"，
并让 measure 的 blob 门用同一距离口径。

### S10（P2）"跨 bin 增量补生"没有合并规则：按字面实现就是每 20° 整组换一遍

**文档断言**（dome 490/537）："跨 bin 时按 `patchesFor(seed, bin)` **增量补生**…并回收离窗 patch"。

**证据**：

- `patchesFor(seed, bin)` 每个 bin 返回一组**全新随机**的 3-8 个 patch，和上一组没有身份对应关系。
  "增量"要成立，必须补一条规则：旧组里方位仍落在新扇区的保留、新组里只取落在新暴露 20° 楔形里的补生、
  总数封顶 8；否则执行者只能整组替换——满舵 `TURN_RATE 1.25 rad/s` 下每 **0.28s** 换一组、全员 0.3s 淡入，
  转向时就是持续闪烁。
- 合并还会把计数顶穿：旧组残留 + 新组补生可以 >8，而 blob 门要 3-8；单测只测 `patchesFor` 单组，测不到运行时集合。
- 另：heading 由追击相机派生（473），相机有死区和前视滞后；20° bin 边界上没有滞回，yaw 在边界附近微抖就会反复触发
  补生/回收。±180° 接缝（bin +9 与 −9 是同一朝向、不同索引）也没写归一规则。

**修法**：补一段伪代码级规则——"保留 `abs(绝对方位 − 新中心) ≤ 40°` 的旧 patch；从新组取 `方位 ∈ 新扇区 \ 旧扇区`
的补生，按方位排序取到总数 ≤8；bin 索引用 `wrapToBin(yaw)` 归一到 18 个；bin 边界加 2° 滞回"。

### S11（P2）R17 的延期条件已经满足：本计划同时动 qa.ts 和 main.ts，两处陈旧注释还是没人管

**文档断言**：R17 建议"随首个动到 `qa.ts` 的计划带走"。
**证据**：panel Task 1 的 Files 明确 Modify `src/qa.ts` 与 `src/main.ts`——条件已满足，但 Task 0/1 都没提。
两处注释现状：

- `main.ts:17-18`："The sea was deleted on 2026-11-06 … nothing in this file tows or budgets a water surface any more."
  实际 L174-194（`initWorld`）、L276-281（`world.update` 带 view）、L297-304（`setHazeTargets`）都在用海。
- `qa.ts:50-56`："`setQuality` 任何一次换档都会重写 `c1Gate`，本钩子在换档后失效。"
  实际 `sea/material.ts:596-643` 的 `chopOverride` 已让它换档后仍生效——panel 自己在 168 行也写了"换档不失效"。

**修法**：Task 1 加一步"顺手改两处注释"，并补源码 pin（`!/nothing in this file tows/`、`!/换档后失效/`）；
或写进 Task 0 的对账项。

### S12（P2）R15 的"before 帧在 Task 0 现抓"没有对应步骤，验收 1 悬空

**文档断言**（panel 192）："before 帧在 Task 0 现抓"。
**证据**：Task 0（69-78）四项全是只读对账，`Files: 无（只读检查）`；没有抓帧命令、没有存放路径、
没有 step 数/冻结协议。真到验收 1，executor 只能自己发明一套 before 帧口径——"逐像素一致"就不可比。

**修法**：Task 0 加一条：`?qa=frozen` + `qa.step(0)` 抓 before 存 `artifacts/debug-color/before.png`，
记录 SHA 与 step 数；`Files` 改 `Create`。

---

## 4. 小项（可一并改，均有源码/算术依据）

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| a | flight 239 | §4 的 P1 档仍列 "FOV 基线"，与 Q3-4"维持现状"冲突 | 删掉该项或改成"FOV 不动（Q3-4 已降级）" |
| b | flight 114 | "2.2 attack 在 **1.0s** 内只到 **82.5%**（≈14.8）"数值错：1.0s 是 **88.9%（16.0）**；82.5% 对应 0.8s | 改成 88.9% / ≈16.0，结论（snap 仍必要）不变 |
| c | flight 125-128 | R2 直接入口没定义 pushover 起始姿态：从 cruise 进时 pitch>0.25、speed≈22，snap 18 是 4 m/s 减速，与"从 hover 进"不同初态 | 补一句入参（pitch 取当前值、vy 从 −4~6 起、speed 覆盖为 18） |
| d | dome 461/566 | 标题与 commit 仍写"方案 B"/"approach B"，与 R9 作废的"世界固定 B 方案"同名；§12 的"方案 B"是 patch 层，另一件事 | 标题去掉"（方案 B）"，commit 改 "heading-window" |
| e | dome 475-476 | `PatchSpec.sizeMetres` 没给范围，测试也没钉；尺寸直接决定 3-8 团能否铺满 80° 扇区 | 补 `sizeMetres 80-200`（或按角度反推）并进测试 |
| f | dome 490 | "0.3s 淡入"没考虑转向速率：满舵 `TURN_RATE 1.25 rad/s`≈**71.6°/s**，出生在 30° 外、半 fov 18°，只剩 12°≈**0.17s**，淡入没走完就进画面 | 满舵时把补生角放到 ≥40° 外，或把淡入改成按角度驱动 |
| g | dome 543 | "12~14°"与几何不符：y 350-440 / d 1200-1800 / 机位 60 m = **9.2-17.6°**；"压在 deck 底缘下方"也只对 350-380 段成立（440 > 380） | 改成 9-18°；"下方"改成"跨在底缘上"（1350 m 处 patch 已满不透明，合成是遮挡不是叠加） |
| h | panel 8-10 | Architecture 仍只列 3 个 qa 函数（Task 1 已 5 个） | 补 `setChopGate` / `setHazeEndpoints` |
| i | panel 168 | nochop 是单向钉死：`chopOverride` 一旦置 false，面板没有 `clearChopGate` 透传，回不去（且此后 `setQuality` 不再改 chop） | 加 `qa.clearChopGate()` 或让按钮 toggle `setChopGate(true)` |

## 5. 复现

### 5.1 飞行复算（与 v1.1 同口径；B 列＝hover 入口起算）

| startY | B 杆量 | 实测（本轮） | 文档值 | 判定 |
|---|---|---|---|---|
| 60 | −1 | 5.25s / 127.18m，触海 | 5.25 / 127.17 | ✓ |
| 120 | −1 | 6.85s / 187.17m，触海 | 6.85 / 187.17 | ✓ |
| 240 | −1 | 8.08s / 233.39m，触海 | 8.08 / 233.39 | ✓ |
| 60 | +1 | 2.87s / 46.89m，空中 | 2.87 / 46.89 | ✓ |
| 60 | +0.5 | 3.63s / 74.95m，空中 | 3.63 / 74.95 | ✓ |
| 60 | −0.5 | 5.20s / 127.26m，触海 | 5.20 / 127.26 | ✓ |
| 240 | +0.4 | 7.45s / 233.94m，触海，平台 21.37 | 21.37 / 触海 | ✓ |
| 240 | +0.3 | 7.60s，平台 20.23 | 20.23 / 触海 | ✓ |
| 240 | 0 | 7.82s，平台 18.56 | 18.56 / 触海 | ✓ |
| 240 | −0.2 | 7.90s，平台 17.93 | 17.93 / 触海 | ✓ |
| 240 | **+0.45** | 3.93s / 86.91m，**空中改出**（y=153.1） | "≈+0.45 才改出" | ✓ |

```ts
// src/zz-audit3-sim.test.ts（运行后已删除，工作区无残留）
import { createFlightState, stepFlight } from './game';
const DT = 1 / 60;
// A 阶段 sy=-1 直到 phase==='hover'；B 阶段换 syB；记 hoverAt / 其后首个 cruiseAt / fall 内 max speed
```

pushover 段的 22.07 / 23.20 是常微分近似（`6 − (6/46²)v² − 9.81·sin(0.08)`，Euler 1/60），
因为 pushover 尚未实现，不能用 `stepFlight` 复算。

### 5.2 本轮用到的对账（Git Bash / WSL）

```bash
git diff --stat
grep -n "WorldView" src/*.ts            # 3 处字面量：main.ts:337 / world.ts:201 / world.test.ts:136
grep -n "nothing in this file tows" src/main.ts
grep -n "换档后失效" src/qa.ts
sed -n '596,643p' src/sea/material.ts   # chopOverride 守卫
sed -n '1,40p' artifacts/dome-audit/measure.py  # mask 口径
```

## 6. 限制

- 未起浏览器：三份功能均未落地。飞行用无头模拟，不覆盖 bank/风/鼠标耦合；pushover 本身无实现，只能用常微分近似。
- 未重跑 `npx vitest run` 全量（本轮不涉及新测试）；只跑了临时的单文件模拟并已删除。
- S2 的"27s 无云"按 46 m/s 直线、正前方 1500 m、±40° 扇区几何推算；真实值随方位角与回收策略变。
- 未改三份文档：理由见文首；S6/S8/S9/S11/S12 与小项 a/b/d/h/i 是纯机械修正，拍板即可落。
