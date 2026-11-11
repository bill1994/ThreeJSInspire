# 飞机飞行手感提升文档 v1.1（Porco Sunset / ThreeJSInspire）

- 日期：2026-11-10（v1.1 增补 Q1 失速恢复时间实测与硬保证；同日按复审 R1-R6 回填：改出边界 +0.45、速度注入定案 snap、松杆门挡下行为、FOV 降级、锚点修正；第三轮 S1：fallback 改 13.2 保险丝、硬保证分正常/延长两条路径）
- 对象：`src/game.ts` 飞行模型 + `src/feel.ts` + `src/camera-rig.ts` + `src/director.ts` + `src/stall.ts` + `src/skim.ts` + `src/in-cloud.ts` + `src/puff-cloud.ts` + `src/post.ts`
- 结论先行：你提的 5 点**全部成立**，而且刀刀砍在当前实现最薄的地方。此文档逐条给“现状→评价→改法→参数”，外加 4 条你没提但飞起来一定会撞上的补充，最后给 P0/P1/P2 三档实施顺序。

---

## 1. 现状速览（先对齐地基，再谈手感）

| 系统 | 现状 | 位置 |
|---|---|---|
| 能量模型 | 推力 6 / 二次阻力 `DRAG_K=6/(46²)` / 重力沿机头分量，可把速度真正飞到 0 | `src/game.ts:76,78,266-272`（THRUST L76 / DRAG_K L78） |
| 失速三段 | `cruise → hover（挂顶 0.5s + 冻结 0.08s）→ fall（ nose -1.1, FALL_MAX_SINK 32 ）→ 速度回到 STALL_SPEED 22 才给杆`；hover 准入 = `speed<22 && pitch>HOVER_PITCH 0.25 && apexCooldown<=0`（`game.ts:274-279`，无 vy/杆量判据） | `src/game.ts:70-96（常量）、274-279（准入）、285-339（机制）` |
| 天花板 | 软顶：`ALT_MAX=240` 只截位置不截姿态 | `src/game.ts:357-360` |
| 贴海 | `SKIM.DECK_Y=7 / FADE_Y=14`，`floorY=ALT_MIN+skim`；`waterHit01=max(陡,快)` 是 OR（`skim.ts:46-51`）；impact 分支才抬 `WATER_PULLUP_PITCH=0.12`（常量在 `game.ts:96`），fall 内非 impact 触底只强制 cruise+speed≥22、不抬 pitch（`game.ts:363-378`） | `src/skim.ts:10-23,36-51`、`src/game.ts:96,362-378` |
| 抖动 | trauma 模型，`TRAUMA_DECAY=1.15 / SHAKE_MAX=0.85`，正弦采样非每帧随机，`stall` 另叠一路 29.7Hz 抖 | `src/feel.ts:17-24,80-94,358-361` |
| 相机 | 死区 + 前视 + 指数平滑 + bank 跟随 0.28 + 速度 FOV kick 9，shake 以加性偏移叠在 follow 之上 | `src/camera-rig.ts:23-47,191-229` |
| 导演层 | stall/cloud/dive 三路边沿 trauma：`HIT_STALL=0.6 / HIT_CLOUD=0.9 / HIT_DIVE=0.35`，dive 另给 FOV+3 / bank 0.45 | `src/director.ts:29-55,59-96` |
| 穿云 | 硬触发（ENTER 0.999 / EXIT 0.985），白纱封顶 0.45 + 兜底瓣 `interiorOpacity01`，云内**无持续抖** | `src/in-cloud.ts:32,42,100-103` |
| 速度线 | 后期径向速度线已删：2 倍过密、1.5 倍过硬、横穿云和飞机 | `src/post.ts:221-223` |

> 汝这地基打得倒是端正，失速、贴海、白雾三件套皆有契约可测。差的不是“有没有”，是“顶端和低端那两口气没接住，巡航中间那口气太松”。

---

## 2. 逐条评审与改法

### Q1. 飞到最高失速下坠 → 要不要“到一定高度平缓改出、沿海面水平飞并还杆”？

**评价：非常对，但建议拆成两件事：天花板缓冲 + 顶点温柔改出。**

现状问题（含 v1.1 实测）：

1. `enterHover` 把速度清零、姿态冻住 0.5s；进入 `stepFall` 后 pitch 通过**指数逼近**
   `pitch += (pitchTarget - pitch) * attack(d, PITCH_ATTACK*0.6)`（`src/game.ts:316`）收敛到 `pitchTarget`，
   **不是瞬间按到 -1.1**；`authority` 用 `smoothstep01((speed-13.2)/8.8)`（`src/game.ts:311-313`；
   13.2 = 0.6·`STALL_SPEED`，8.8 = 0.4·`STALL_SPEED`）映射，**不是线性**。
   玩家体感是“罚站 → 自由落体 → 好久才给杆”，挫败感拉满。
2. 天花板是纯位置截断，爬到 240 只是“顶住”，没有“快顶到了”的预告。
3. **恢复时间实测**（60 fps；`createFlightState(startY)` + `stepFlight(state, 1/60, {x: 0, y: sy})`；
   阶段 A 满杆上拉直到 hover 触发，阶段 B 保持 `sy` 走完 hover + fall）：

| startY | sy=-1 满杆上拉 | sy=+1 满杆压杆 | sy=+0.5 | sy=-0.5 |
|---|---|---|---|---|
| 60 | 5.25 s / 127.17 m，**触海强制 cruise** | 2.87 s / 46.89 m，**空中改出** | 3.63 s / 74.95 m，空中改出 | 5.20 s / 127.26 m，**触海强制 cruise** |
| 120 | 6.85 s / 187.17 m，**触海强制 cruise** | （未单独采样） | | |
| 240 | 8.08 s / 233.39 m，**触海强制 cruise** | （未单独采样） | | |

时长从 **hover 入口**起算（罚站 0.60 s + fall 段）；掉高从 **fall 起点**算。
fall 本体时长 = 上表减 0.60 s：60 m 满杆上拉 fall 本体 **4.65 s**（原文写的 2.9~3.4 s 是压杆数据，不是拉杆）。

**满杆上拉 fall 段演化（同上实测，t 从 hover 入口起算）**：

| t | vy | speed | pitch | 说明 |
|---|---|---|---|---|
| 0~0.60s | 0 | 0 | +1.2 | 罚站，杆死（`HOVER_HOLD` 0.5 + `HOVER_FREEZE` 0.08） |
| 1.0s | -3.92 | 3.94 | -0.577 | fall 已跑 0.40 s，pitch 向下收敛 |
| 1.5s | -8.83 | 8.96 | -1.014 | 接近最低 pitch |
| 2.0s | -13.73 | 13.89 | -1.083 | **pitch 最低值**——碰不到 -1.1（指数逼近要无限时间才收敛） |
| 2.5s | -18.64 | **16.66（平台，不再涨）** | -0.594 | authority 拉回 pitchTarget，speed 卡在 16.6 |

**关键结论（修正原文三处错误）**：

1. **“持续满杆上拉”必触海，任何高度都不空中改出**——60/120/240 m 全部靠 `integrate` 触海强制 cruise
   （`src/game.ts:373-376`）才得救。原文写的 2.9~3.4 s / 30~50 m 是压杆数据。
2. 能空中改出的是**压杆/松杆**，不是拉杆：`sy=+1` → 2.87 s / 46.89 m 空中改出；`sy=+0.5` → 3.63 s / 74.95 m。
3. 机制：speed 到 16.6 就平台——满杆上拉时
   `pitchTarget = FALL_PITCH(-1.1) + (playerPitch(+1.2) - (-1.1)) * authority`（`src/game.ts:315`）被 authority 拉回上仰，
   `sin(pitch) ≈ sin(-1.08) ≈ -0.88`，重力沿机头分量 `STALL.G_SINK * sin(pitch) ≈ 9.81 * (-0.88) = +8.6`（**向上抬**），
   抵消了大部分推力损失 → `speedTarget = 6 + (-vy)*max(0,-sin(pitch))` 被压在约 16.6 → **永远达不到 `STALL_SPEED=22`** → 永不切 cruise。

**“能否空中改出”不取决于高度，只取决于杆量——但门槛在 ≈+0.45，不在 −0.3**（复审 R3，240m 实测，速度平台与高度无关）：

- 空中改出唯一通路：**实质压杆 `sy ≳ +0.45`**（+0.5 → 3.63s/74.95m 改出；+1 → 2.87s/46.89m）
- `sy ≤ +0.4` 全部触海：+0.4 平台 21.37、+0.3 平台 20.23、0 平台 18.56、−0.2 平台 17.93、−1 平台 16.67——全都过不了 `STALL_SPEED 22`
- 旧版“sy>-0.3 大概率空中改出”作废；−0.85 与 −0.3 都不是真实门槛

掉高狠的原因：`integrate` 里 `pos.y += fwd.y*adv + vy*d` 两项全负（俯冲时 `-0.89*speed + vy`），末段下沉率 20+ m/s。

**authority 实际值（`smoothstep01((speed-13.2)/8.8)`；原文表里的 0.2/0.545/0.773 是线性估算，错）**：

| speed | authority |
|---|---|
| 13.2（0.6·`STALL_SPEED`） | 0 |
| 15 | **0.108** |
| 18 | **0.568** |
| 20 | **0.869** |
| 22（`STALL_SPEED`） | 1 |

另：pin 住仰飞时 authority 回来后 pitchTarget 会 blend 回 `+1.2`，靠 `APEX_COOLDOWN 1.2s` 防连吊，但冷却一过仍 pin 住会再次 zoom→hover，打摆子。

**修法影响**：

- 原文 Q1 的恢复时间预算、掉高预算全部建立在错误输入上——Q1 的“恢复到 cruise 的目标时间 1.2s”本身没问题，
  但它要修的前提（满杆上拉 pin 住）比文档想象的严重得多：满杆上拉不是“久一点才回来”，是**根本回不来**。
- 原文 F1-F3 的 pushover / hard cap / 松杆门逻辑方向不受影响，但具体数值需以正确前提重算。

真实飞行与游戏的折中（FAA 口径都是同一句：**改出首先是减小迎角，不是拉杆**，见参考）：街机向日落飞行不该复刻尾旋，而该做“pushover（轻推杆改出）”。

**改法（推荐街机向，保留硬失速作 fallback）：**

```ts
// 新增：顶点改出段，放在 hover 之后、fall 之前
// src/game.ts FLIGHT 新增
PUSHOVER_T: 1.0,          // 改出时长 s（可压到 0.9，别再短）
PUSHOVER_PITCH: 0.08,     // 改出目标：微微带杆平飞
PUSHOVER_EXTEND: 0.3,     // 满杆延长一次 0.3s
PUSHOVER_EXTENSIONS: 2,   // 最多两轮；用尽时 speed<13.2 才 fallback
RECOVERY_SPEED: 18,       // STALL_SPEED(22)*0.82：提前还杆
FALL_HARD_CAP: 0.8,       // fall 硬上限：只给 0.8s 就强制进 pushover，不等触地
CEILING_CUSHION: 30,      // 距顶 30m 进入缓冲
```

- `hover(0.5s)` 不变（这是 beat，要留）。
- `hover → pushover`：1.0s 内 pitch 指数趋向 `+0.08`，bank 趋向 0，yaw 保持，初始下沉只给 `-vy 4~6m/s`（随后衰减到 0，不是直接 −32）。
  **速度注入方式定案（拍板 2026-11-10，复审 R1）：入口 snap 到 `RECOVERY_SPEED 18`，不走 `FALL_SPEED_ATTACK` 重建**——
  2.2 attack 在 1.0s 内只到 88.9%（≈16.0；0.8s 是 82.8%/14.9），重建路线既到不了 18、又会喂饱 fallback（见下条判据重写）。
  入口初态：pitch 取当前值，vy 从 −4~6 m/s 起，speed 覆盖为 18（从 cruise 直进时约 4 m/s 的减速，按瞬态处理）。
- authority 在 pushover 内从 0→1 ramp 回来，玩家一推杆/松杆就能接管（只允许压杆改平，不允许继续带杆上仰；FAA 减迎角优先）。
- **硬保证（本次追问的答案，按实测重算）：正常路径 `0.58+0.8+1.0=2.38s`（取整 2.4s）；满杆延长走满 `2.38+2×0.3=2.98s`（取整 3.0s）——两条路径掉高都 `≤15m`；`fall` 超过 `FALL_HARD_CAP 0.8s` 无论速度多少强制进 pushover，绝不等触地才给回。**
  掉高账（复审 R4 重算）：fall 0.8s 约 5~6m（实测 fall+1.0s 掉 8.49m 按二次缩放，执行时以实测回填）＋ pushover 入口下沉 4~6m/s 在 1.0s 内衰减的 ~2-3m → 总掉高 **~8-9m**（旧版 ~6m 漏算了入口下沉），15m 预算仍成立。
- **fallback 触发条件**（拍板 2026-11-10，复审 R1/R3 修正）：入口已 snap 到 18，“速度没升到 18”永不成立，不再作判据；
  `pitch>0.25` 在 pushover/延长段被强制压到 ≤ +0.08（延长段 ≤ −0.05），恒假，也删；
  `speed<22` 同样不能留——延长走完时约 20.8-22，大概率仍 <22，会误伤所有满杆玩家。
  **只留机制失败信号：延长用尽时 `speed < 13.2`（= `0.6·STALL_SPEED`，`authority` 归零线）才回退现有 `fall` 兜底。**
  正常轨迹打不中它：pitch 以 3.6/s 从 +1.2 落向 +0.08，speed 最低只探到 ~17.2-17.5、延长走完约 20.8-22
  （复算，执行时用同款无头模拟 pin）；只有 snap/能量模型真坏了才会掉到 13.2 以下。
  **满杆不是前提**：持续满杆的归宿是 R2 的“挡下 → pushover”循环，不是旧 fall。
  （fallback 是保险丝，不是路径）
- **hover 准入松杆门**（修正原文）：上一次 pushover 结束后，**未检测到 `abs(sy) < 0.3`**（杆在中位附近，既不明显拉也不明显压），则不进下一次 hover。
  - `sy=-0.4`：还在拉 → 不触发松杆 → 不进 hover ✓
  - `sy=+1`：满压杆 → 不是松杆 → 不进 hover ✓
  - `sy=0.1`：中位附近 → 触发松杆 → 允许进 hover ✓
  - 注意 0.3 是**中位门**（防 pin 杆连吊），不是改出门（改出门 ≈+0.45，见上）——两个数字两件事，验收时别混。
- **门挡下时的行为**（拍板 2026-11-10，复审 R2）：hover 被松杆门挡掉、而失速条件（`speed<22 && pitch>HOVER_PITCH 0.25`）仍成立时，**直接进 pushover**——绝不能留在 cruise。现行 `stepCruise` 里 hover 是失速的唯一出口（`game.ts:274-279`），硬留在 cruise 会 speed→0、机头仰着静滞，比 hover 更糟。防摆子共两道闸，实现时都要落：
  - 第一道（既有，免费）：pushover 出口 pitch `+0.08` < `HOVER_PITCH 0.25`，天然免疫 re-hover，直到玩家把机头重新拉过 0.25 rad；
  - 第二道（本设计新增）：上面的松杆门。
- **持续上拉的正确修法**（不是 fallback）：直接在 pushover 里处理——pushover 期间玩家继续满杆上拉，不回退到旧 fall，而是把 pushover 延长 `PUSHOVER_EXTEND 0.3s`（`PUSHOVER_EXTENSIONS` 最多 2 次）且强制 pitch 上限 `-0.05`（保持平飞），**让玩家一直上拉杆也能改出**，而不是打回必触海的旧 fall。
  旧 fall（nose -1.1）只留给“真 bug 修不完”时的最后兜底。
- 天花板缓冲：`y > ALT_MAX-30 && vy>0` 时，pitch 增量 ×0.4 + FOV -1 + 风声低通 hint，顶到 240 只是轻轻滑过去，不再有“撞墙感”。

备选（拟真向，不推荐做默认）：保留当前 fall，但 hover 前 0.3s 加抖动预告 + 台词 `stall` 提前 + HUD 失速带闪，把“突然坠”变成“可预期的坠”。可做成 `?realism=1` 开关。

### Q2. 下坠至海面 → 平缓沿水平滑行 + 靠海晃动 + 禁止下探、只许上升？

**评价：方向极准，这就是水上飞机的 ground effect +  Deck cushion，正是现在缺的那块。**

现状：`floorY=ALT_MIN+skim` + `waterHit01` + 拉到 0.12，已经有“温柔托举”，但缺两样：① 低空持续的碎抖；② 俯仰钳制。
现在 `integrate`（`src/game.ts:362-378`）触底会强制 `pitch≥0.12`、`speed≥22`、进 cruise，**不会让飞机撞海**；但**触底前仍可压杆到底**，玩家没有“海就在下面不能继续压”的体感提示。缺的是“距离海面还有 20m 开始逐渐限制俯冲”的海垫层。

**改法：统一三层，`SEA_RUMBLE_Y` 纳入分层（原文“6→18”与分层用的 10/18 边界不一致）：**

```ts
// src/skim.ts 新增
SEA_CUSHION_Y: 18,        // 垫层顶
SEA_RUMBLE_Y: 12,         // 碎抖起振高度（同时是中层底）
PITCH_FLOOR_DEEP: -0.25,  // 中层 (y<18) pitch 下限
PITCH_FLOOR_FLOOR: -0.12, // 底层 (y<12) pitch 下限（“不能继续下探”的硬门）
```

- 高度分层：
  - `y > 18`：现有逻辑不变，完整杆量。
  - `12 < y < 18`：pitchTarget 下限钳到 `-0.25`，bank 自动回正率 ×1.5，`skim01` 驱动泡沫尾迹（已在 `src/feel.ts:377-386`）。
  - `y < 12`：**playerPitch 下限强制钳到 `-0.12`**（不是只钳 pitchTarget），实现“触底前 12m 以内禁止继续下探”；bank 回正率 ×2.0，自动配平 pitch→`+0.05~0.10`；碎抖从这里开始最明显。
- 碎抖（连续型，非边沿 trauma）：
  - 在 `feel.update` 加一路：`seaRumble = skim01 * 0.5 + smoothNoise(t)*0.5`，幅度 `0.10~0.16 * SHAKE_MAX`，频率 13Hz（y）+17Hz（x）+ 随机相位，不走 `addTrauma`（trauma 是事件型的，会衰减；这里要的是“贴着就一直颠”）。
  - 相机侧：shake 叠加即可，绝不碰 `state.pos`（game-feel 铁律：抖相机，不抖身体）。
- 音画绑定：碎抖幅度同时驱动风声高频 + 泡沫尾迹宽度 `0.45→0.7` 脉动，抖与声与浪同源才可信。

物理注脚：真机近水面是升力增、诱导阻力减（ground effect），但水面波浪扰流 + 艾克拉诺效应会引入低频颠簸。游戏里取后者做手感，前者可折成“垫层内阻力 -10%，更好维持平飞”，飞起来更“托得住”。

### Q3. 一直平飞像静止 → 怎么破？

**评价：一针见血。这是本项目当前最大的观感风险。**

根因：巡航速度恒定 + 海面环带 cell 6.4m 在 60m 高度视角下角速度太小 + 云 25 朵稀疏 + 速度线被删后无替代 + 巡航无 contrail（阈值 `CONTRAIL_BANK 0.42 / CONTRAIL_SPEED 0.72` 在 `feel.ts:26/29`，触发是 **OR**（`feel.ts:363`：`|bank|>0.42 || speed01>0.72`）；巡航 speed01≈0.27、平飞 bank≈0，两路都不通 → 全不触发）→ 大脑判定“没动”。

速度感的通用解（Elliot / Jacob 两篇讲透了）：**FOV、震动、UI、粒子、声音、关卡**六路叠，每路只出 2 分，合起来 12 分。绝不靠单一速度线吃全场（你删得对，`ref-02` 那种全屏放射线糊云必翻车）。

**改法（按性价比排序，前 3 个是 P0）：**

1. **3D 风絮粒子（替代速度线，必做）**：相机前方 40m 盒子里 200 个 pooled 点，速度 `-(forward*speed*0.6)` 往后拉，透明度 `∝ speed01`，只在画面边缘 30% 可见、中心留空。3D 视差比后期叠加可信 10 倍，且不横穿飞机。
2. **海面近场流速暗示**：`ring0` 加 foam streak 贴图滚动（速度 ∝ speed01），sun-road 碎闪强度随速度 +15%。海不动，船（你）再快也白搭。
3. **云门（level design）**：散布保证每 8~12s 有一朵 puff 从侧方 40~70m 掠过。无参照物的匀速 = 静止，这是铁律。
4. **FOV：维持现状，不再作为速度感主力**（拍板 2026-11-10，复审 R5 降级）：
   - 事实链：`speed01=(speed−34)/44`（`MIN_SPEED: 34`，`game.ts:65`）→ 持续平飞巡航 speed=46 时 speed01≈**0.27** → `fov = 60 + min(9, 6+3·dive01)·speed01 ≈ 61.6°`（`camera-rig.ts:205/213` ＋ `game.ts:590`）。旧版“平飞满速 66°”把俯冲瞬态（speed01→1）当成了巡航态——66/69° 只在俯冲里出现。
   - 因此旧候选 A（`60+6·speed01+3·dive01`）在巡航 ≡ 现状（dive01=0 时逐项相等），候选 B 巡航反而低 0.6°——**两个候选对“巡航 fov 静止感”都是空操作**。病根是巡航 speed01 恒在 0.27 附近不动，不是缺 speed 耦合（`*speed01` 一直在乘）。
   - 结论：FOV 链**本轮不动**。速度感押注在本条 #1-3（3D 风絮、海面流速暗示、云门）——那三条的诊断与方案均核对成立。若日后仍想要动态 FOV，方向是挂**加速度/俯冲进入率**或抬 `CAM_FOV_KICK` 上限，另立小项评审，不做基线重分配。
5. **相机手持微动**：巡航加 `0.05°/s` 量级低频漂移 + bank 滞后（已有 `CAM_BANK_FOLLOW 0.28`，够了，别再加）。
6. **声音**：风噪 loop 音量/截止频率随 speed01（已在 `src/game.ts:668-672 intensity`，再加一层 pitch）。
7. **contrail 怠速**：巡航给极淡尾迹（alpha 0.08），转弯/加速再加浓。阈值从 `0.72` 降到 `0.55` 或另设 `IDLE_TRAIL 0.12`。

### Q4. 贴海加什么 particle 增强接触感？

**评价：必加。现在只有一条泡沫尾迹 + 一个 splash ring（`src/feel.ts:293-313`），单薄了。**

**改法：4 层，按 Visibility 排序（全 pooled、零分配、WebGPU-safe）：**

| 层 | 内容 | 量级 | 生存 |
|---|---|---|---|
| L1 泡沫尾迹 | 已有 ribbon，加宽脉动 `0.45→0.7` + alpha 随 skim 脉动 | 2 条 ×48 采样 | 常驻 |
| L2 水花 spray | `THREE.Points` 400 池，初速向上 3~7m/s + 向后 5m/s，重力 -9.8，大小 0.3~0.8m，foam 色 | burst 60/s（skim>0.5 时） | 0.7s |
| L3 水雾 mist | 6~8 个软 sprite（径向渐变纹理），贴水面 0.3m，扩张 2→6m，alpha 0.18→0 | 轮替 | 1.2s |
| L4 触水环 | 已有单环，加第二环（延迟 0.15s，半径 ×1.6，alpha ×0.5）+ 翼尖涡环（bank>0.5 时） | 2 环 | 0.55s |

- 颜色全部取 `WAKE_FOAM`，bloom 阈值 0.82 以上不触发（泡沫不该发光）。
- 音效：skim>0.5 起 looped 击水声，音量 ∝ skim×speed01，进出做 0.2s 淡入淡出（参考 Unreal boat splash 按顶点采样水面的做法，重型；我们按高度采样即可）。
- 性能：Points 一 draw call，sprite 复用同一纹理，总 overdraw 控在 1/8 屏内，低档直接关 L2/L3（`setQuality` 已有先例）。

### Q5. 穿 puff 云复用晃动感，物理拟真？

**评价：可以用，但要用“连续颠簸”，不是复用 stall 那一下重的。**

现状：`HIT_CLOUD=0.9` 只有进云瞬间的边沿一拳，云里全程安静 + 白纱 0.45 + 兜底瓣。这恰好反了：真机穿积云是**进去一颠 + 里面一路碎抖 + 出来一松**（MSFS 社区吐槽最多的就是“云里太安静不像真的”）。

**改法：**

```ts
// src/director.ts 新增
CLOUD_RUMBLE: 0.22,  // 云内持续 trauma 目标（不是单次 hit）
```

- 进云边沿保留 `0.9`（或降到 0.6，0.9 对 25 朵云太吵，实测再定）。
- 云内：`traumaTarget = 0.15 + 0.25*cloudProx`，每帧 `trauma += (target-trauma)*min(1,dt*3)` 追踪；另叠一路 23Hz 小幅 buffet（复用 stall 那路 sine，幅度 `0.12*prox*SHAKE_MAX`）+ bank 慢摇 `±0.06rad @0.7Hz`。
- 出云：trauma 自然衰减即可。`src/feel.ts:66-72` 用的是**线性衰减**（注释写明 “Linear decay is unconditionally stable”）：`next = t - TRAUMA_DECAY*dt`，`TRAUMA_DECAY = 1.15`。
  - trauma 0.22 约 **0.19s** 回零
  - trauma 0.9 约 **0.78s** 回零
  如果想让出云 trauma 持续约 0.4s，需要在云内保持 `traumaTarget = 0.22+`（进云后逐渐升），出云时 target 归零让自然线性衰减走完约 0.2s 余留。
  如果确实想要“指数松开”的非线性体感，需要改 `feel.ts` 的 `updateTrauma` 实现（从 `t - step*dt` 改成 `t * exp(-step*dt)`），代价是稳定性分析和现有测试可能需要更新。
- 视听绑定：白纱（已在 `src/game.ts:628`）+ 兜底瓣（`setInterior`）+ 风声低通（muffle 400Hz）三件套，抖只是其中一路。纯抖无雾 = 灵异事件。
- 防闪：已有 ENTER/EXIT 滞回（0.999/0.985），抖动的 `prox` 输入必须走 `whiteoutHold` 后的 `cloudProx`，不直接读原始 prox。

---

## 3. 你没提但我忍不住要加的 4 条

1. **失速预告 beat（P0）**：hover 前 0.6s 给三连——轻抖（0.2 trauma）+ 台词 `stall` 提前 + HUD 失速带闪 + 音效 pulse。现在是“突然罚站”，玩家会以为是 bug。game-feel 铁律：大 juice 之前必有小预告。
2. **螺旋桨存在感（P1）**：巡航静止感的一半锅是桨。prop blur disc 透明度/转速随 throttle，+ 桨尖嗡鸣 pitch 随 speed01。便宜，效果立竿见影。
3. **可用性开关（P1）**：`reduce shake / reduce flash` 两档。trauma 全局 ×0.4，白纱封顶 0.45→0.25。长飞 + 晕 3D 必备，不然前面调得越爽死得越快。
4. **G 力黑边（P2）**：dive pull-up 瞬间 0.25s 暗角 0.25 + FOV 回弹。只做 dive>0.7 的大动作，别做成全程煤灰。

---

## 4. 分档实施表

| 档 | 内容 | 工时感 | 验收 |
|---|---|---|---|
| P0 | 顶点 pushover + 海垫钳制 + 云内碎抖 + 3D 风絮 + 失速预告 | 2~3 天 | 满杆爬升不再自由落体；贴海只能上不能下且一直小颠；巡航有速度感；失速前有预告 |
| P1 | 海面 4 层粒子 + 桨反馈 + 云 trauma 下调 + 可用性开关 | 2 天 | 贴海有水花有声；云里一路颠；设置里可关抖 |
| P2 | 云门关卡 + G 黑边 + 海面 streak 滚动 + 低档裁剪 | 1~2 天 | 连续飞 60s 每 10s 有参照掠过；低端机不掉帧 |

> **全部三档已执行（2026-11-11，`696f518..113861a`）**。拆账见表 §8.1；验收只有自动化（§8.2），
> 主观项与真机项仍是开口（§8.3）。别再拿「P1 accepted」当整份文档的签收章。

---

## 5. 调参速查（可直接进 `FLIGHT / STALL / SKIM / DIRECTOR / FEEL`）

```ts
// 顶点
HOVER_HOLD 0.5（保留）, HOVER_FREEZE 0.08（保留）
// hover 的 0.08s freeze 是 airframe hit-stop，不是世界暂停——freeze>0 时 stepFlight 内部直接 return 上一帧 state，但 dt 仍累加
PUSHOVER_T 1.0, PUSHOVER_EXTEND 0.3 × 2（PUSHOVER_EXTENSIONS 2）, PUSHOVER_PITCH 0.08, RECOVERY_SPEED 18（pushover 入口 snap 到 18，拍板定案；不用指数重建）
FALL_HARD_CAP 0.8（正常 ≤2.4s、满杆延长 ≤3.0s，掉高 ≤15m——实账 ~8-9m，不等触地）
CEILING_CUSHION 30
// 海垫
SEA_CUSHION_Y 18, SEA_RUMBLE_Y 12, PITCH_FLOOR_DEEP -0.25, PITCH_FLOOR_FLOOR -0.12
seaRumbleAmp 0.12*SHAKE_MAX, seaFreq 13/17Hz
// 云
HIT_CLOUD 0.9→0.6（待实测）, CLOUD_RUMBLE 0.22
// 速度感
FOV 维持现状 60 + min(9, 6+3*dive01)*speed01（Q3-4 已降级：候选 A/B 均为巡航空操作，不改动）
WIND_STREAKS 200, CONTRAIL_SPEED 0.72→0.55（触发是 OR，阈值在 feel.ts:26/29）
// 海粒子
SPRAY 400池/60perSec/0.7s, MIST 8 sprite/1.2s, RING×2
```

---

## 6. 验证清单（按 game-feel 第 7 条：播一遍，看它回不回得来）

> 勾选口径（2026-11-11 回填）：✅ = 已由**无头模拟**单测钉死，不 = 体感签收；⚠️ = 机制已 pin、观感/真机仍待手飞。逐条证据见 §8.2。

- [x] 满杆爬升 3 次：hover→pushover→平飞，全程不碰 fall；继续满杆**也不进 fall**——fall 只在 pushover 结束且 speed<13.2 的保险丝触发（`game.ts:509-517`）。原「继续满杆才进 fall」与代码相反，按修复清单 §4 回改（2026-11-12，FLT-05）。
  → `src/flight-p0accept.test.ts`「three pinned rounds stay out of fall」
- [x] 失速恢复计时：pin 仰飞从 hover 到 cruise 正常 ≤2.4s、满杆延长 ≤3.0s，掉高 ≤15m；fall 单次 ≤0.8s 即被 pushover 打断；低空仰飞不再触地才给杆（与高度无关）。
  → `src/flight-p0accept.test.ts`「recovers hover→cruise within 2.4s losing at most 15m hands-off」＋`src/flight-pushover.test.ts`「…within 2.98s losing at most 15m pinned full-up」「caps any single fall segment at FALL_HARD_CAP」（注 2026-11-12：hands-off 一条可空跑——climbToHover 找不到 hover 返回 3600、`toBeGreaterThan(0)` 仍绿；修复清单 FLT-04，Phase 2 修测试）
- [x] 松杆门：pushover 后未检测到 `abs(sy)<0.3`，则下一次失速直接进 pushover（不进 hover、也不留在 cruise 静滞），pin 杆不再打摆子。
  → `src/flight-pushover.test.ts`「blocks re-hover on a pinned stick and goes straight to pushover」「allows hover again after the stick has been seen loose」
- [x] 60fps / 30fps 各飞一遍 pushover，海垫回正速率一致（指数平滑 `1-exp(-λdt)`，禁用固定 lerp）。
  → `src/flight-p0accept.test.ts`「flies the same arc at DT=1/60 and DT=1/30」
- [x] 贴海 20s：不碰杆能稳在垫层顶 ~12–13m（测试注释原文；本文旧写的 7~9m 与实测不符——+0.05 自动配平把机托在垫层顶，按修复清单 §4 回改 2026-11-12，FLT-05）；下压杆只余缓降（pitch 下限 −0.12）、无法俯冲；上拉杆秒回。
  → `src/flight-p0accept.test.ts` 三条（holds the deck / gentle sink only / pulls straight back up）
- [ ] 穿云 3 朵：进有 hit、里有抖、出有松，白雾不闪（贴边微动测试）。
  ⚠️ 「进/里/出」已 pin（`src/flight-p1accept.test.ts`：`HIT_CLOUD 0.6`、进云目标 0.40、feel 2s 可 track）；**白雾贴边不闪仍是目检项，没做**。
- [ ] 巡航 30s：盯着海面 5s 再看云，应能说出“我变快/变慢了”。
  ⚠️ 机制已 pin（`src/wind-streaks.test.ts`、`src/wake-streak.test.ts`、`src/cloud-gates.test.ts`）；「说不说得出来」只能手飞判，没做。
- [ ] 低档机：L2/L3 关后帧率回升，L1/Ring 仍在，接触感不断。
  ⚠️ 裁剪已 pin（`src/flight-p2accept.test.ts`「低档一键裁剪」「removes the points / hide」）；**真机帧率未测**，桌面 low 只是代理。

---

## 7. 参考与锚点

- FAA 失速改出：首要是减迎角（`AC 120-109A`）：https://www.faa.gov/documentLibrary/media/Advisory_Circular/AC_120-109A.pdf
- 速度感六路（FOV/抖动/UI/粒子/声音/关卡，含边缘速度线做法）：https://elliotdev.gg/adding-the-feeling-of-speed/
- 速度感知与 FOV/动模糊/外周 streak：https://www.jacobspencer.dev/blog-posts/the-speed-problem.html
- 地面效应（近水升力/阻力变化，做海垫物理注脚）：https://www.understandingflight.com/ground-effect/
- 云中颠簸体感（SimShaker / MSFS 社区对“云里太安静”的抱怨即反证）：https://forums.flightsimulator.com/t/air-turbulence-physics/471971
- 屏幕震动 trauma 模型（与本项目 `feel.ts` 同源）：https://kidscancode.org/godot_recipes/4.x/2d/screen_shake/index.html
- 船体水花按顶点采样水面（重型参考，按需裁）：https://amirzakeo.com/projects/boat-splash-system.html
- 项目内视觉锚点：`docs/superpowers/specs/assets/ref-02-speed-lines.png`（反面教材：过密过硬，边缘化复用）、`ref-01-sunset-glide.png`（巡航构图目标）、`ref-03-spiral-dive.png`（dive 强度上限）。

---

## 8. 执行记录（2026-11-11 回填）

> 本节是事后补的账。三档代码 2026-11-11 已全部落地，但当时只写进了 commit message 与测试，
> 没有回写本文。**功能以代码与测试为准；主观体感项见 §8.3，迄今没有签收。**

### 8.1 提交拆账

| 提交 | 日期 | 档 | 内容 | 规模 |
|---|---|---|---|---|
| `696f518` | 2026-11-11 | **P0** | 顶点 pushover ＋ 海垫钳制 ＋ 云内碎抖 ＋ 3D 风絮 ＋ 失速预告 | 17 files，+1664/−45 |
| `70e9a96` | 2026-11-11 | **P1-1** | 海面粒子 L2 spray／L3 mist／L4 第二环＋翼尖涡环 ＋ 击水声 | 6 files，+587/−29 |
| `60743c9` | 2026-11-11 | **P1-2/P1-3** | 桨反馈（转速/透明度/嗡鸣）＋ 可用性开关；commit 自带「P1 accepted」 | 12 files，+440/−20 |
| `113861a` | 2026-11-11 | **P2** | 云门 ＋ G 黑边 ＋ 海面 streak 行波 ＋ 低档一键裁剪 | 21 files，+691/−22 |

### 8.2 实装值 vs 本文数值

| 项 | 本文写的 | 实装 | 出处 |
|---|---|---|---|
| `HIT_CLOUD` | 0.9→0.6（「待实测」） | **0.6**（设计值，未实测——原「实测定案」无实测证据支撑，§8.3 第 4 条自认未抓帧；修复清单 FLT-13，2026-11-12 更正） | `src/director.ts:40` |
| `CLOUD_RUMBLE` | 0.22 | 0.22（**死常量**：全仓仅此一处定义、零使用；真实目标是 `cloudTraumaTarget = 0.15 + 0.25·prox` 即 0.15–0.40，`director.ts:57-59`——修复清单 FLT-10，2026-11-12） | `src/director.ts:45` |
| `CONTRAIL_SPEED` | 0.72→0.55 | 0.55 | `src/feel.ts:30` |
| `PUSHOVER_T / PUSHOVER_EXTEND / PUSHOVER_EXTENSIONS` | 1.0 / 0.3 / 2 | 1.0 / 0.3 / 2 | `src/game.ts:162/166/168` |
| `RECOVERY_SPEED` | 18（入口 snap，不定指数重建） | 18（snap） | `src/game.ts:170` |
| `FALL_HARD_CAP` | 0.8 | 0.8 | `src/game.ts:172` |
| `WIND_STREAKS` | 200 | 200（low 100） | `src/wind-streaks.ts:14/19` |
| 舒适档 | trauma ×0.4 / 白纱 0.25 | 0.4 / 0.25（`?shake=reduced`、`?flash=reduced`；实为**送相机的 shake 输出 ×0.4**——comfort.ts 缩的是 shakeScale 出口，trauma 本体不缩，2026-11-12 措辞更正） | `src/comfort.ts:12/14` |
| `TRAUMA_DECAY` | 线性衰减（§Q5 复算后保持） | 线性 1.15 | `src/feel.ts:18/180` |
| FOV | **维持现状，本轮不动**（Q3-4 降级） | 未改 | `src/camera-rig.ts` |

### 8.3 没覆盖 / 没签收（诚实口径）

1. **§6 的 ✅ 全是无头模拟**：直接调 `createFlightState` / `stepFlight` 喂输入，相机、HUD、音频、
   DOM 白纱都不在回路里。它证明机制对，不证明"摸起来对"。
2. **三条观感/真机项未验收**：穿云白雾贴边不闪、巡航 30s 的速度感、低档真机帧率——见 §6 的 ⚠️ 三条。
3. `?shake=reduced&flash=reduced` 只测了参数解析与单点缩放（`src/comfort.test.ts`），
   没有端到端观感验证。
4. 本轮**未新增浏览器抓帧**：`artifacts/` 下没有任何 flight 证据帧，所有验收都是数值/结构断言。
5. **执行缺口（三审追加，2026-11-12，修复清单 §4）**：P1-2 正式 GLB 上螺旋桨视觉全空转（`setProp` 只认 `prop_spin`、资产无此节点，FLT-01）；P2-4 低档裁剪未接自动路径（`world.applyQuality` 不扇出 `game.setQuality`，FLT-02）；失速预告台词在 pin 场景到不了（FLT-03）；Q3-5 相机手持微动未实现（FLT-06）；Q3-6 风噪截止频率/pitch 未接（FLT-07）；Q1 天花板缺 FOV −1 与风声低通（FLT-08）；Q4-L1「加宽脉动」实为 alpha 倍率（FLT-09）。

> **状态（2026-11-11 回填）**：本文从"待批准方案"变为**已执行设计稿**，P0/P1/P2 三档落地
> （`696f518..113861a`），§6 已勾 5 条、留 3 条开口。下次谁再说"飞行手感已经做完了"，
> 请他把 §8.3 一起念完。
>
> **2026-11-12 修正**：§6 ①⑤ 勾选内容与 §8.2 三处值表按修复清单 §4 回改（原勾选两处内容不真、
> 三处值表口径错误：HIT_CLOUD 未实测、CLOUD_RUMBLE 死常量、舒适档缩的是相机出口）；执行缺口见 §8.3 第 5 条。
