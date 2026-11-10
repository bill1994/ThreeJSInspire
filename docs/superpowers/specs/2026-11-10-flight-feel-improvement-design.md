# 飞机飞行手感提升文档 v1.1（Porco Sunset / ThreeJSInspire）

- 日期：2026-11-10（v1.1 增补 Q1 失速恢复时间实测与硬保证）
- 对象：`src/game.ts` 飞行模型 + `src/feel.ts` + `src/camera-rig.ts` + `src/director.ts` + `src/stall.ts` + `src/skim.ts` + `src/in-cloud.ts` + `src/puff-cloud.ts` + `src/post.ts`
- 结论先行：你提的 5 点**全部成立**，而且刀刀砍在当前实现最薄的地方。此文档逐条给“现状→评价→改法→参数”，外加 4 条你没提但飞起来一定会撞上的补充，最后给 P0/P1/P2 三档实施顺序。

---

## 1. 现状速览（先对齐地基，再谈手感）

| 系统 | 现状 | 位置 |
|---|---|---|
| 能量模型 | 推力 6 / 二次阻力 `DRAG_K=6/(46²)` / 重力沿机头分量，可把速度真正飞到 0 | `src/game.ts:75-77,266-272` |
| 失速三段 | `cruise → hover（挂顶 0.5s + 冻结 0.08s）→ fall（ nose -1.1, maxSink 32 ）→ 速度回到 STALL_SPEED 22 才给杆` | `src/game.ts:104-133,285-339` |
| 天花板 | 软顶：`ALT_MAX=240` 只截位置不截姿态 | `src/game.ts:357-360` |
| 贴海 | `SKIM.DECK_Y=7 / FADE_Y=14`，`floorY=ALT_MIN+skim`，陡/快才算 hit，hit 只温柔拉到 `WATER_PULLUP_PITCH=0.12` | `src/skim.ts:10-23,36-50`、`src/game.ts:362-377` |
| 抖动 | trauma 模型，`TRAUMA_DECAY=1.15 / SHAKE_MAX=0.85`，正弦采样非每帧随机，`stall` 另叠一路 29.7Hz 抖 | `src/feel.ts:17-24,80-94,358-361` |
| 相机 | 死区 + 前视 + 指数平滑 + bank 跟随 0.28 + 速度 FOV kick 9，shake 以加性偏移叠在 follow 之上 | `src/camera-rig.ts:23-47,191-229` |
| 导演层 | stall/cloud/dive 三路边沿 trauma：`HIT_STALL=0.6 / HIT_CLOUD=0.9 / HIT_DIVE=0.35`，dive 另给 FOV+3 / bank 0.45 | `src/director.ts:29-55,59-96` |
| 穿云 | 硬触发（ENTER 0.999 / EXIT 0.985），白纱封顶 0.45 + 兜底瓣 `interiorOpacity01`，云内**无持续抖** | `src/in-cloud.ts:32,42,100-103` |
| 速度线 | 后期径向速度线已删：2 倍过密、1.5 倍过硬、横穿云和飞机 | `src/post.ts:221-223` |

> 汝这地基打得倒是端正，失速、贴海、白雾三件套皆有契约可测。差的不是“有没有”，是“顶端和低端那两口气没接住，巡航中间那口气太ជាមួយ”。

---

## 2. 逐条评审与改法

### Q1. 飞到最高失速下坠 → 要不要“到一定高度平缓改出、沿海面水平飞并还杆”？

**评价：非常对，但建议拆成两件事：天花板缓冲 + 顶点温柔改出。**

现状问题（含 v1.1 实测）：

1. `enterHover` 把速度清零、姿态冻住 0.5s，然后 `stepFall` 一头把 pitch 按到 `-1.1`，authority 要到 `STALL_SPEED*0.6→1.0` 才线性回来。玩家体感是“罚站 → 自由落体 → 好久才给杆”，挫败感拉满。
2. 天花板是纯位置截断，爬到 240 只是“顶住”，没有“快顶到了”的预告。
3. **恢复时间实测（一直仰飞 pin 住的 worst case，60fps 口径，见 `src/game.ts:285-339,349-378`）：hover 罚站 0.58s + fall 约 2.3~2.8s = 全程约 2.9~3.4s 才回到 cruise，掉高约 30~50m。** 明细：

| t | vy | speed | authority `(speed-13.2)/8.8` | 体感 |
|---|---|---|---|---|
| 0~0.58s | 0 | 0 | 0 | 罚站，杆死 |
| ~1.0s | -9.8 | ~11 | 0 | 机头已按到 -1.1，往下扎 |
| ~1.5s | -14.7 | ~15 | ~0.2 | 杆刚有点松 |
| ~2.0s | -19.6 | ~19 | ~0.7 | 杆回来大半 |
| ~2.3~2.8s | — | ≥22 | 1 | 切回 cruise，`vy` 清零 |

掉高狠的原因：`integrate` 里 `pos.y += fwd.y*adv + vy*d` 两项全负（俯冲时 `-0.89*speed + vy`），末段下沉率 20+m/s。**高空 zoom 顶掉 40m 能回来；40m 以下仰飞失速，速度还没回到 22 就先拍地板，全靠 `integrate:373-376` 那句“fall 触地强制 cruise”捞回来——即“撞海才给回”。** 另：pin 住仰飞时 authority 回来后 pitchTarget 会 blend 回 `+1.2`，靠 `APEX_COOLDOWN 1.2s` 防连吊，但冷却一过仍 pin 住会再次 zoom→hover，打摆子。

真实飞行与游戏的折中（FAA 口径都是同一句：**改出首先是减小迎角，不是拉杆**，见参考）：街机向日落飞行不该复刻尾旋，而该做“pushover（轻推杆改出）”。

**改法（推荐街机向，保留硬失速作 fallback）：**

```ts
// 新增：顶点改出段，放在 hover 之后、fall 之前
// src/game.ts FLIGHT 新增
PUSHOVER_T: 1.2,          // 改出时长 s（可压到 0.9，别再短）
PUSHOVER_PITCH: 0.08,     // 改出目标：微微带杆平飞
RECOVERY_SPEED: 18,       // STALL_SPEED(22)*0.82：提前还杆
FALL_HARD_CAP: 1.6,       // fall 硬上限：超时强制进 pushover，不等触地
CEILING_CUSHION: 30,      // 距顶 30m 进入缓冲
```

- `hover(0.5s)` 不变（这是 beat，要留）。
- `hover → pushover`：1.2s 内 pitch 指数趋向 `+0.08`，bank 趋向 0，yaw 保持，vy=0，速度从 0 用 `FALL_SPEED_ATTACK` 重建，但初始下沉只给 `-vy 4~6m/s` 而不是直接 `-32`。
- authority 在 pushover 内从 0→1 ramp 回来，玩家一推杆/松杆就能接管（只允许压杆改平，不允许继续带杆上仰；FAA 减迎角优先）。
- **硬保证（本次追问的答案）：失控总时长锁死在 `0.58+1.2=1.8s` 以内，掉高 `<15m`；`fall` 超过 `FALL_HARD_CAP 1.6s` 无论速度多少强制进 pushover，绝不等触地才给回。**
- 只有玩家在 pushover 全程仍满杆上拉（`sy<-0.85` 不松杆），才 fallback 进现有 `fall`（nose -1.1）。另建议 hover 准入加“松杆门”：上一次 pushover 后未检测到 `sy>-0.3` 则不进下一次 hover，治 pin 杆打摆子。此乃“汝自寻死路，便许你坠”。
- 天花板缓冲：`y > ALT_MAX-30 && vy>0` 时，pitch 增量 ×0.4 + FOV -1 + 风声低通 hint，顶到 240 只是轻轻滑过去，不再有“撞墙感”。

备选（拟真向，不推荐做默认）：保留当前 fall，但 hover 前 0.3s 加抖动预告 + 台词 `stall` 提前 + HUD 失速带闪，把“突然坠”变成“可预期的坠”。可做成 `?realism=1` 开关。

### Q2. 下坠至海面 → 平缓沿水平滑行 + 靠海晃动 + 禁止下探、只许上升？

**评价：方向极准，这就是水上飞机的 ground effect +  Deck cushion，正是现在缺的那块。**

现状：`floorY=ALT_MIN+skim` + `waterHit01` + 拉到 0.12，已经有“温柔托举”，但缺两样：① 低空持续的碎抖；② 俯仰钳制（现在俯冲到海面仍能继续顶杆下探）。

**改法：加一个 6→18m 的“海垫层”：**

```ts
// src/skim.ts 新增
SEA_CUSHION_Y: 18,   // 垫层顶
SEA_RUMBLE_Y: 12,    // 碎抖起振高度
PITCH_FLOOR_NEAR_SEA: -0.12, // y<10m 时不许再低头
```

- 高度分层：
  - `y>18`：现有逻辑不变。
  - `10<y<18`：pitchTarget 下限钳到 `-0.25`，bank 自动回正率 ×1.5，`skim01` 驱动泡沫尾迹（已在 `src/feel.ts:377-386`）。
  - `y<10`：playerPitch 下限钳到 `-0.12`（实现“不再允许下探、只许上升”），bank 回正率 ×2.0，自动配平 pitch→`+0.05~0.10`。
- 碎抖（连续型，非边沿 trauma）：
  - 在 `feel.update` 加一路：`seaRumble = skim01 * 0.5 + smoothNoise(t)*0.5`，幅度 `0.10~0.16 * SHAKE_MAX`，频率 13Hz（y）+17Hz（x）+ 随机相位，不走 `addTrauma`（trauma 是事件型的，会衰减；这里要的是“贴着就一直颠”）。
  - 相机侧：shake 叠加即可，绝不碰 `state.pos`（game-feel 铁律：抖相机，不抖身体）。
- 音画绑定：碎抖幅度同时驱动风声高频 + 泡沫尾迹宽度 `0.45→0.7` 脉动，抖与声与浪同源才可信。

物理注脚：真机近水面是升力增、诱导阻力减（ground effect），但水面波浪扰流 + 艾克拉诺效应会引入低频颠簸。游戏里取后者做手感，前者可折成“垫层内阻力 -10%，更好维持平飞”，飞起来更“托得住”。

### Q3. 一直平飞像静止 → 怎么破？

**评价：一针见血。这是本项目当前最大的观感风险。**

根因：巡航速度恒定 + 海面环带 cell 6.4m 在 60m 高度视角下角速度太小 + 云 25 朵稀疏 + 速度线被删后无替代 + 巡航无 contrail（阈值 `CONTRAIL_BANK 0.42 / CONTRAIL_SPEED 0.72`，平飞全不触发）→ 大脑判定“没动”。

速度感的通用解（Elliot / Jacob 两篇讲透了）：**FOV、震动、UI、粒子、声音、关卡**六路叠，每路只出 2 分，合起来 12 分。绝不靠单一速度线吃全场（你删得对，`ref-02` 那种全屏放射线糊云必翻车）。

**改法（按性价比排序，前 3 个是 P0）：**

1. **3D 风絮粒子（替代速度线，必做）**：相机前方 40m 盒子里 200 个 pooled 点，速度 `-(forward*speed*0.6)` 往后拉，透明度 `∝ speed01`，只在画面边缘 30% 可见、中心留空。3D 视差比后期叠加可信 10 倍，且不横穿飞机。
2. **海面近场流速暗示**：`ring0` 加 foam streak 贴图滚动（速度 ∝ speed01），sun-road 碎闪强度随速度 +15%。海不动，船（你）再快也白搭。
3. **云门（level design）**：散布保证每 8~12s 有一朵 puff 从侧方 40~70m 掠过。无参照物的匀速 = 静止，这是铁律。
4. **FOV 基线重调**：现在只有 dive 给 +3（`DIRECTOR.FOV_DIVE`）。改成 `base 60 + speed01*4 + dive01*3`，巡航也有呼吸感，但总量仍 ≤9 不致眩晕。
5. **相机手持微动**：巡航加 `0.05°/s` 量级低频漂移 + bank 滞后（已有 `CAM_BANK_FOLLOW 0.28`，够了，别再加）。
6. **声音**：风噪 loop 音量/截止频率随 speed01（已在 `src/game.ts:668-672 intensity`，再加一层 pitch）。
7. **contrail 怠速**：巡航给极淡尾迹（alpha 0.08），转弯/加速再加浓。阈值从 `0.72` 降到 `0.55` 或另设 `IDLE_TRAIL 0.12`。

### Q4. 贴海加什么 particle 增强接触感？

**评价：必加。现在只有一条泡沫尾迹 + 一个 splash ring（`src/feel.ts:293-313`），单薄了。**

**改法：4 层，按.Visibility 排序（全 pooled、零分配、WebGPU-safe）：**

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
- 出云：0.4s 指数松开（trauma 自然衰减即可，`TRAUMA_DECAY 1.15` 约 0.8s 回零，刚好）。
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
| P1 | 海面 4 层粒子 + FOV 基线 + 桨反馈 + 云 trauma 下调 + 可用性开关 | 2 天 | 贴海有水花有声；云里一路颠；设置里可关抖 |
| P2 | 云门关卡 + G 黑边 + 海面 streak 滚动 + 低档裁剪 | 1~2 天 | 连续飞 60s 每 10s 有参照掠过；低端机不掉帧 |

---

## 5. 调参速查（可直接进 `FLIGHT / STALL / SKIM / DIRECTOR / FEEL`）

```ts
// 顶点
HOVER_HOLD 0.5（保留）, HOVER_FREEZE 0.08（保留）
PUSHOVER_T 1.2, PUSHOVER_PITCH 0.08, RECOVERY_SPEED 18
FALL_HARD_CAP 1.6（失控总时长≤1.8s，掉高<15m，不等触地）
CEILING_CUSHION 30
// 海垫
SEA_CUSHION_Y 18, SEA_RUMBLE_Y 12, PITCH_FLOOR_NEAR_SEA -0.12
seaRumbleAmp 0.12*SHAKE_MAX, seaFreq 13/17Hz
// 云
HIT_CLOUD 0.9→0.6（待实测）, CLOUD_RUMBLE 0.22
// 速度感
FOV = 60 + speed01*4 + dive01*3（总量≤9）
WIND_STREAKS 200, CONTRAIL_SPEED 0.72→0.55
// 海粒子
SPRAY 400池/60perSec/0.7s, MIST 8 sprite/1.2s, RING×2
```

---

## 6. 验证清单（按 game-feel 第 7 条：播一遍，看它回不回得来）

- [ ] 满杆爬升 3 次：hover→pushover→平飞，全程不碰 fall；继续满杆才进 fall。
- [ ] 失速恢复计时：pin 仰飞从 hover 到 cruise ≤1.8s，掉高 <15m；fall 单次 ≤1.6s 即被 pushover 打断；40m 低空仰飞不再触地才给杆。
- [ ] 松杆门：pushover 后未松杆（`sy>-0.3` 未出现）则下一次不进 hover，pin 杆不再打摆子。
- [ ] 60fps / 30fps 各飞一遍 pushover，海垫回正速率一致（指数平滑 `1-exp(-λdt)`，禁用固定 lerp）。
- [ ] 贴海 20s：不碰杆能自己维持 7~9m；下压杆无反应；上拉杆秒回。
- [ ] 穿云 3 朵：进有 hit、里有抖、出有松，白雾不闪（贴边微动测试）。
- [ ] 巡航 30s：盯着海面 5s 再看云，应能说出“我变快/变慢了”。
- [ ] 低档机：L2/L3 关后帧率回升，L1/Ring 仍在，接触感不断。

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

> 下一步：你点个头（或挑一档 P0/P1/P2），我就按上表开工。实现时每条单独调参、单独验收，绝不一锅烩。罢了罢了，先把 pushover 写了，汝那自由落体本小姐看着实在心烦。(¬‿¬)
