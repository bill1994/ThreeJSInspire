# 三份任务审计 → 修复清单（2026-11-11）

- 日期：2026-11-11
- 分支：`feat/dome-cloud-volumetric`，审计基线 HEAD `b046180`（含 docs 账本回填提交）
- 审计对象（三份已宣称"完成"的文档）：
  1. `plans/2026-11-09-debug-color-panel.md`（调色 Debug 面板，3 Task）
  2. `plans/2026-11-10-dome-cloud-p15-p2-horizon.md`（穹顶云 P1.5/P2 + horizon，Task 0.5–9）
  3. `specs/2026-11-10-flight-feel-improvement-design.md`（飞行手感 P0/P1/P2）
- 审计方式：三路独立审阅（各自读文档、读代码、跑测试）+ 主审独立复算。**主审对审阅员的每条 Critical/Important 都做了二次核验**，下文标注了被修正的审阅员说法。三审（同日，逐条对照代码/文档原文 + 实跑量具复验）：42 条主条目 35 条坐实、7 条部分成立（修正已直接落进下文条目）、0 条推翻，修正记录见 §7。
- 证据基线（主审本轮实跑）：`npx tsc --noEmit` = 0；`npx vitest run` = 65 文件 / 656 用例全过；`npm run build` 通过（`color-panel` 独立 chunk 8.78 kB）；`measure.py` 复现验收报告门 1 数字；GLB 节点表由二进制 JSON chunk 解析得到。

> **本文件是什么/不是什么**：是**修复待办总账**，不是 step-level 执行计划。
> 每条动工前须扩成带 fail-first 测试、Files、验收门的任务计划（沿用本仓 `plans/` 的既有格式）。
> 状态列只有 `OPEN / WIP / DONE`；没有验证证据不得置 DONE。

---

## 0. 判定口径（先统一，否则又会互相说服）

1. **"代码写着" ≠ "功能生效"**：必须有一条跑在生产路径上的证据（真实 GLB / 真实低档转场 / 真实帧循环），结构断言与 regex 不算。
2. **"测试绿" ≠ "验收通过"**：测试若可空跑（找不到前置状态也返回 0）视为无效测试。
3. **"报告写了通过" ≠ "判据满足"**：判据以 design/plan 的原文为准；改判据必须留痕（谁批的、改哪条、何时）。
4. **体感项必须有浏览器/真机证据**：无头模拟只能证明机制，不能签收手感与观感。

---

## 1. P0 — 阻塞"完成/通过"口径（先修这些）

| ID | 工作流 | 问题 | 证据 | 修法 | 验收 |
|---|---|---|---|---|---|
| **FLT-01** | 飞行 P1-2 | **正式 GLB 上螺旋桨视觉全空转**：`setProp` 只认 `prop_spin`，资产里没有；占位机被删后直接 return | `src/plane.ts:290-292`；GLB 33 节点只有 `prop_blade_0/1`、`prop_spinner`、0 animation（主审解析）；占位机移除 `src/plane.ts:262-266`；`src/plane.test.ts:107-120` 把 no-op 写成预期 | 资产加 `prop_spin` 父组（首选），或代码兜底找两片桨旋转 + 改 `metal_prop` opacity；测试改成钉真实 GLB 节点名/mock 扁平节点；删除"no-op 是预期"用例 | 真实 GLB 路径下 throttle 0→1，桨转速与 blur 透明度都变；缺节点时测试红 |
| **FLT-02** | 飞行 P2-4 | **低档裁剪没接自动路径**：移动端/governor 降档走 `world.applyQuality`，它只扇出 sea/puffs/dome；唯一 `game.setQuality` 是 QA 手动杆 | `src/world.ts:244-249`、`:253`、`:308-310`；`src/main.ts:417-419`（只更新 post）、`:454-456`（QA 杆） | `initGame` 后按 `world.quality` 调一次；质量变更块同步 `game?.setQuality(...)`；补转场测试 | 模拟 governor 降档后 spray/mist 关闭、streaks=100；回升恢复 |
| **FLT-03** | 飞行 P0-5 | **失速预告的台词没被提前、HUD 预警/事件两态无可区分**（三审修正：HUD 经 :306-310 两态 OR 本就随 stallWarn 提前亮）：`if (stall>0.5)` 先吃掉 one-shot，`else if (stallWarn)` 在 pin 场景到不了台词（窄窗口仍可达、showCue 已被 one-shot 消费成 no-op）；注释说反 | `src/game.ts:945-948`；pin 实测 stall>0.5 @0.25s、stallWarn @2.12s、hover @2.60s；`src/hud.ts:306-310` 本就把两态 OR；`:1008-1011` downbeat 也绑 0.25s | 拆成"预警态/事件态"两个 cue id（或视觉状态），台词与 HUD 在 stallWarn 时切；补帧循环消费测试 | pin 场景下台词在 stallWarn 后、hover 前出现；HUD 带在预警态与事件态有可区分表现 |
| **DOME-01** ✅ | 穹顶 Task 7 | **地平线 patch 未验收**：报告没有 Task 7 的门，证据帧未提交且早于接线；现有帧里该层弱到与噪声同量级 | 报告全文仅 `:48` 提到 horizon（用于排除）；主审像素：t0 带 rows240–400 max 19 / >20 **0**；t30 max 25 / >20 **43**；patch 投影矩形 t0 6 / t30 9；审阅员 headless 探针能挂 8 quad（alpha .51–.76，1.3–1.7 km） | HEAD 重抓 `?pos=0,60,-300` on/off 对；门 = 9.7–16.3° 带内 on/off >20 luma 且 `count` 合理；`world.test.ts` 加挂载/计数断言；若仍不可见，二分 WebGPU 材质路径（RGBA 顶点色、renderOrder 2、depthWrite false、transparent 排序） | 提交帧里能用掩码量到 patch 区域；删掉 patch 后该区域差值回落 |
| **DOME-02** | 穹顶 Task 9 | **门 1/2/5 判据被替换后仍写"门 1–7 通过"** | design §8：门 1 `blob∈[3,8]`、门 2 `edge_grad` 上升、门 5 soft/flat 基本不变；主审复算 P1 基线 `edge_grad=13.828`，P1.5 high 11.077 / low 12.541；blob high=1；coverage 28.272→24.404、31.143→24.286 | 二选一并留痕：① 换能数 blob 的机位重抓重调；② 由主人书面认改判，写进 design/plan/report 三处 | 报告每个门只写"满足原判据"或"已改判（依据/批准）"，不允许混写 |

**Phase 1 收口（2026-11-12）**：四条 P0 全部关闭。DOME-01 的修复链与判据变更留痕如下——原门（`?dome=1` vs `?dome=0&puff=0`）经实证**证伪**：deck 在探针带贡献 +11.8、patch 贡献 −6.59，符号相反，该口径结构性量不出 patch；另叠加 rect 偏 69px、探针带掺 HUD、7/8 团在视野外、地平线检测锁错 100px。改为**同页隔离口径**（仅内存切 `dome-horizon.visible`，deck/HUD/天空逐像素一致），再修实现层（方位 ±40°→±20°、数量 5–9、`MAX_PATCHES` 派生）与对比度（`PATCH_SILHOUETTE_DARKEN=0.5`，只压背光侧）。**判据经主人书面接受（2026-11-12）由 `row-mean > 20` 改为三条合判**：行均值 ≥2.5、单像素 p99 ≥15、带内覆盖 ≥4%；理由是该 legacy 阈值要求整条带平均暗 8%（覆盖约 46% 且保持 30+ 暗度），等于把云压成不透明黑带，与"远景云"语义冲突。证据：`artifacts/dome-audit/p15-horizon-gate-v3/v4/v6.json`、`analyze_horizon_isolation.py`、帧 `p15-horizon-{on,off,iso-hidden}-t0-v6*.png`。遗留（不影响本次关闭）：patch 屏幕 y 90–134、覆盖率 5.8%，是"几团云"而非"一条云带"；位置偏高于海天线（y≈300）。

---

## 2. P1 — 验收完整性 / 行为缺口

| ID | 工作流 | 问题 | 证据 | 修法 |
|---|---|---|---|---|
| **FLT-04** | 飞行 P0 | **P0 验收测试可空跑**：`climbToHover` 找不到 hover 返回 3600，`toBeGreaterThan(0)` 仍绿；低空测试一进 cruise 就 break，从没跑 pushover；`waterHit` 只看末帧 | `src/flight-p0accept.test.ts:22-30/34/58/76-90`；`src/flight-seacushion.test.ts:118-130` | 学 `flight-pushover.test.ts:23-29` 返回 −1；断言真实 phase 序列；累计 `maxWaterHit`；低空测试跑到 cruise |
| **FLT-05** | 飞行账本 | **§6 两条勾选内容不真**：①"继续满杆才进 fall"与代码相反；⑤"维持 7~9m"与测试注释自认的 ~12-13 m 相抵（原写的实测 12.36 查无出处，三审已删） | spec §6 L285/L293；`src/game.ts:418-421`、`:509-517`（fall 保险丝 speed<13.2）、`:483-484`（延长圈 pitch 钉 −0.05）；`:375` 的 +0.05 trim；`flight-p0accept.test.ts:136-149`（注释原文 ~12-13 m, not 7-9） | 改 spec 措辞或改代码；§6 勾选与 §8.2 值表按 §4 回改 |
| **FLT-06** | 飞行 Q3-5 | 相机手持微动未实现，且不在分档表 | spec:190；`git diff 50a1822..113861a -- src/camera-rig.ts` 为空 | 实现，或写入 §8.3 明示不做 |
| **FLT-07** | 飞行 Q3-6 | 风噪只有 gain 随速度，截止频率/pitch 没接 | `src/audio.ts:361` 固定 1500Hz、`:437` 仅 gain | 同 FLT-06 |
| **FLT-08** | 飞行 Q1 | 天花板只打四折 pitch，缺 FOV −1 与风声低通提示 | `src/game.ts:379-387`；spec:141 | 同 FLT-06 |
| **FLT-09** | 飞行 Q4-L1 | L1"加宽脉动"实为 alpha 倍率：`wakeStrength` 喂给 `strength`，宽度仍固定 0.45，注释却写 width | `src/feel.ts:689/693`、`:691-692` 注释、`:103-106` | 把 pulse 同时喂 width，或改注释+spec 措辞 |
| **DOME-03** | 穹顶 Task 4 | **计划/设计仍要求 low 单探针，代码已删分支**；计划 Step 1 的断言照抄必失败 | plan `:20/:268/:269/:299`；design `:194`；代码 `src/dome-cloud.ts:344-358`；测试反向断言 `dome-cloud.test.ts:66/77` | 改计划 Task 4、全局约束第 20 行、design §10.3、模块头注释；测试注释写清"分支已删"的原因 |
| **DOME-04** | 穹顶性能 | 低档现在恒付 3-tap + 两个 octave，design 的 high-only 缓解被删；perf 门 p95 16.8 是 vsync 地板，测不出余量 | `src/dome-cloud.ts:282-283/350-358`；design `:194`；`probe_perf_live.mjs` 读 rAF | 恢复真实分档开关，或明确接受并补 GPU 计时；design 同步 |
| **DOME-05** | 穹顶 Task 1 | `uOctaves` 成死 uniform（只写不读），`setQuality` 里那行写入无效 | `src/dome-cloud.ts:441`；全文件无 shader 读取；`:281` 注释与 `:348` 矛盾 | 删除 uniform 与对应 pin，或真正用它 gate `detailFine` |
| **DOME-06** | 穹顶 Task 8 | Task 8 验收证据被报告自己判无效；spike 无实测数字/无送审裁定 | 报告 `:14-18`；plan `:657-659`；`artifacts/dome-audit/dof-spike.md` | 同档同 elapsed 抓 post=1/0 有效对，记 banding/CoC；spike 补数字与裁定 |
| **DOME-07** | 穹顶文档 | "CoC 1.0→~0.1" 数值错：按 focal 420、focus 12–60 复算为 **0.198–0.352**（默认 focus 34 约 0.28） | `src/post.ts:78/97-100`；`DepthOfFieldNode.js:375-376` | 改数字，或把钳制降到 ≈−92…−140 m |
| **DOME-08** | 穹顶证据 | **sidecar 对 6 帧记的是旧字节数**（恰好是被低档修复改过的那批） | 主审逐项比对：`low-on-t0` 197572/实际 253375、`low-on-t30` 183404/225868、`low-flat t0/t30` 197572·183404/286635·264184、`low-sunoff-t0` 197546/223338、`high-on-t30` 285953/286005 | 从提交帧重生成 sidecar/哈希；证据帧入库 |
| **DOME-09** | 穹顶门 4 | 设计要求的"受光/背光直方图双峰"从未量，报告用 `sun_diff_mean` 顶替 | design `:172`；报告 `:32`；`measure.py` 无直方图峰指标 | 补量具，或在 design/plan 改判并留痕 |
| **DOME-10** | 穹顶 Task 7 | **±40° 扇区 vs ±18° 水平半 FOV**，常用航向锥内 0–1 团，"任意时刻前方有云"不成立 | fov 60 竖屏 434×772 → 半 FOV ≈18°；plan `:511-512`；审阅模拟 720° 转向 28% 航向 0 团（主审未复跑） | 每 bin 保证一团贴近视轴，或收窄扇区；加锥内计数测试 |
| **PNL-01** | 面板 | `?debug=color` 与 `?qa=frozen` 叠加时面板像死的：冻结态无渲染循环，两个杠杆也不触发 `syncSun` | `docs/PORTRAIT_QA.md:33`；`src/main.ts:617`、`:474-491`；`qa.step` 是唯一重绘入口 | 文档注明"冻结态需 `qa.step(0)`"，或给两个杠杆补 `syncSun()` 对齐 `setSun` |
| **PNL-02** | 面板 | 计划 Global Constraint 6"URL 过长给明确上限"未落地 | plan `:46`；`src/qa.ts:95-105`、`src/main.ts:585-595` 均无长度检查 | 加字符上限 + 专用告警，或改判据并写进计划 |

---

## 3. P2 — 文档漂移 / 证据链 / dev-only 卫生

### 3.1 面板

| ID | 问题 | 证据 | 修法 |
|---|---|---|---|
| PNL-03 | `navigator.clipboard` 无可用性守卫，非安全上下文同步 TypeError，`.catch` 接不住 | `src/debug/color-panel.ts:668-671` | `if (!navigator.clipboard) warn+return` |
| PNL-04 | haze/away 拾色器读数锁定时不刷新（只写 `input.value`，span 不动） | `color-panel.ts:487-488`、`addColor` 返回 input `:176` | `addColor` 返回 `{input,value}`，刷新时双写 |
| PNL-05 | nochop 初值固定 `false`，`?sea=nochop&debug=color` 时按钮与真实闸门相反 | `color-panel.ts:563-570` | 读初始状态或文档写明组合语义 |
| PNL-06 | 6.97° 关键帧与 step 0.1 滑杆不兼容，关键帧后滑杆读数可能与真实值脱节（三审：不兼容坐实；吸附显示依赖浏览器 value sanitization，以浏览器实测为准） | `color-panel.ts:130`（input.step 通用写入）、`:282-289` | 关键帧不改滑杆值，或 step 改 0.01 |
| PNL-07 | 模块图 tripwire 只扫 `src/*.ts`，`src/debug/` 在守卫外（三审：面板计划 :47-50 明文把该豁免记录为设计取舍——本条属加固建议） | `src/module-graph.test.ts:13` | glob 扩到 `./**/*.ts` 或单列断言 |
| PNL-08 | 证据链：验证①判据未回写（`:209` vs `:241-246`）；`:243` 引用的 sidecar 没有差异数字；`:232` 提交列写"本提交"；`c5a0c6d` 无进度行；D3 行号再漂移（三审：前四子项坐实，D3 子项未定位、保留待查） | 计划对应行 | 逐条补 hash、补引用、改判据措辞 |
| PNL-09 | 验收④记录里 `dcp` 一项不可复现（今天入口命中 4 次，全在 three 的 `ndcPos`） | 主审构建后 grep | 换成更长、唯一的串 |

### 3.2 穹顶

| ID | 问题 | 证据 | 修法 |
|---|---|---|---|
| DOME-11 | 陈旧注释：模块头仍描述 low 单探针；`:281` 与 `:348` 矛盾 | `dome-cloud.ts:11-13/281` | 与 DOME-03 一起改 |
| DOME-12 | 计划 14 帧 vs 报告 16 帧（多 2 帧 Task 8 nopost）——三审：报告 :5-6 已自注增量来源（8+4+2+2=16），修法已被满足，本条**关闭** | plan `:705`；报告 :5-6 | （已满足）可选：在 plan :705 补一行 14→16 备注 |
| DOME-13 | Task 3 标定值 0.32/0.40/0.18 未回写计划（只写在测试注释） | plan `:211/:217-221` | 计划记录终值 + 标定依据 |
| DOME-14 | `qa.ts:167` 注释"main 不 import 它"已过期 | `qa.ts:167` vs `main.ts:205` | 改注释 |
| DOME-15 | 测试空洞：`post.test.ts:99` 的 .min(positiveClamp 负向 tripwire 实质空转（符号仓内不存在；三审措辞修正，原称永假断言）；`dome-cloud.test.ts:119-128` 只钉含 `accA` 的行，`sampleA` 定义行（dome-cloud.ts:401-403）不在守卫内——uLook 漏进 sampleA 测试不红 | `src/post.test.ts:99`；`src/dome-cloud.test.ts:119-128`；`src/dome-cloud.ts:401-403` | 把 sampleA 定义行纳入 alpha 守卫；tripwire 改为可真实触发的写法 |
| DOME-16 | 淡入余量算术不成立（滞回算式 (28°−18°)/71.6°/s ≈ 0.14s < `PATCH_FADE_IN_S 0.15`，宽 200m patch 前缘入画仅 ~0.08s；滞回 2° 使换 bin 发生在边界+2°——dome-horizon.ts:128；原 "~0.094s" 推导口径三审未能复现，按算式重写），plan 的"12°=0.17s"按现实现不成立 | plan `:511-512`；`dome-horizon.ts:44/:128` | 改计划算术或调淡入，并同步 dome-horizon.ts:15-16 模块头的同款旧算术 |
| DOME-17 | 报告落点与计划不符（`artifacts/` vs `docs/.../reviews/`）；`1e97a05` 合并 Task 8+9 且未按约定前缀 | plan `:678/:669/:721` | 统一落点；后续按约定拆分 |

### 3.3 飞行

| ID | 问题 | 证据 | 修法 |
|---|---|---|---|
| FLT-10 | `CLOUD_RUMBLE` 是死常量（全仓仅一处），真实目标是 0.15–0.40 | `src/director.ts:45` vs `:57-59`；spec §5 | 删除或真正使用；§5/§8.2 说清曲线 |
| FLT-11 | `seaRumbleAmp` 实装 `RUMBLE_AMP 0.16 × [0.625,1]` = 0.10–0.16，spec 自相矛盾：§Q2(:167) 写 0.10~0.16 与实装一致，矛盾仅在 §5:269 速查行 seaRumbleAmp 0.12*SHAKE_MAX（三审核验 :269 原文坐实） | `src/feel.ts:56-58`；`feel.test.ts:152-155`（注释 0.625 x 0.16 = 0.10, the spec floor）；spec §5:269 vs §Q2:167 | 改 spec §5:269 速查行（对齐 0.10~0.16），不动常量 |
| FLT-12 | 云内碎抖在云外就起：非 hold 时直接用原始 `prox`，最远 2 倍半径仍 track | `src/game.ts:851/874-875`；`in-cloud.ts:106-110`；`feel.ts:620-624` | 按 in-cloud/whiteout 状态门控，或改名"近云扰动" |
| FLT-13 | `HIT_CLOUD 0.6` 标"实测定案"但无实测证据 | spec §8.2；§8.3 自认无抓帧 | 改"设计值/未实测"，补一次记录 |
| FLT-14 | `lastStallWarn`/G 闪簿记在 `if (audio)` 内，audio 为 null 时会重复加 trauma / G 闪不动 | `src/game.ts:1021-1028` | 簿记移出音频块 |
| FLT-15 | 云门只做水平判定（GateSpot 无 y、候选只查水平框）——三审：far-field:120-122 注释明示 y 不动、散布已按体量反解进高度带，注释与实现自洽，撤与注释不符的说法，降为设计取舍记录 | `src/far-field.ts:120-122/146-148`；`cloud-gates.ts:88-99`；`puff-field.ts:164` | 写入 spec §8.3 作为已确认取舍；真机若现隔空触发再补 y 邻近门 |
| FLT-16 | P2-4 测试名"spray 停发排空"与实现不符（只 `visible=false`，不排空） | `src/feel.ts:755-757` | 改名或真排空 |

---

## 4. spec §6 勾选 + §8 值表回改（主审自己的错，必改）

上一轮回填的飞行 spec 把 §6 勾了 5 条、§8.2 写了三处值表（三审更正：勾选在 spec §6，§8.2/§8.3 是值表与开口——原标题 §8 账本 措辞错位），审计证明其中两条不成立、一条只测得一半：

| §6 条目 | 当前 | 应改为 |
|---|---|---|
| ① 满杆爬升 3 次 / 继续满杆才进 fall | `[x]` | 改为 `[x]` 仅限"不进 fall"；删掉/改写"继续满杆才进 fall"子句（fall 只在 13.2 保险丝，`game.ts:513`） |
| ② 恢复计时 | `[x]` | 保留；注 hands-off 测试可空跑（FLT-04） |
| ⑤ 贴海 20s 维持 7~9m | `[x]` | 改为"稳在垫层顶 ~12–13m（测试注释原文），非 7–9" |
| §8.2 `HIT_CLOUD` | "实测定案 0.6" | 改"设计值 0.6，未实测" |
| §8.2 `CLOUD_RUMBLE` 0.22 | 写成目标 | 注明死常量，真实目标 0.15–0.40 |
| §8.2 舒适档 | "trauma ×0.4" | 实为"送相机的 shake 输出 ×0.4" |
| §8.3 | 三条开口 | 追加：P1-2 GLB prop、P2-4 自动低档、Q3-5/Q3-6/Q1 天花板/Q4 L1 宽度 |

---

## 5. 执行顺序与门

| 阶段 | 内容 | 出口条件 |
|---|---|---|
| **Phase 0** | §4 账本回改 + 本清单登记 | 文档不再出现"已通过"的错误陈述 |
| **Phase 1（阻塞）** ✅ 2026-11-12 | FLT-01、FLT-02、FLT-03、DOME-01 | 真实 GLB 桨动；自动低档裁剪生效；pin 台词在预警态；60m 帧能测到 patch（判据经接受改为三条合判，见上） |
| **Phase 2（验收完整性）** | DOME-02（补拍或书面改判）、DOME-06、DOME-08、FLT-04、FLT-05 | 报告每门可追溯；sidecar 与磁盘一致；测试不可空跑 |
| **Phase 3（行为/文档）** | FLT-06…09、DOME-03…05、DOME-09/10、PNL-01/02 | 计划/设计/代码三方一致 |
| **Phase 4（卫生）** | 其余 P2 | 逐条关闭，可批量提交 |

**纪律**：Phase 1 每条都要补一条会红的测试（fail-first）；Phase 2 每条都要留可复核的数字，不许再出现"口径失配所以不算"这种解释性通过。

---

## 6. 未验证 / 不可复核（不许当成已通过）

- 面板验收①的最强证据（同会话对 80ec08d 的 A/B）**provenance 不可复核**：临时 worktree 已删，只能按"产物一致 + 代码等价"判为强支持。
- 穹顶门 2–7 未逐帧重跑（主审只复现门 1）；手机真机从未测。
- 飞行的巡航速度感、穿云白雾、水花/颠簸观感均无浏览器/真机证据。
- 穹顶审阅员的"28% 航向锥内 0 团"来自其模拟，主审未复跑。
- Task 8 修复前后"逐位相同"只有字节数记录，修复前帧不在库。

---

## 7. 附：审计过程中的说法修正（防止下游误引；1–2 主审二核，3–8 三审新增）

1. "地平线 patch 带内 on/off 零像素"**只对 t0 成立**；t30 实测 max 25 / >20 共 43 px，但仍在噪声量级、无法据此判通过。结论（未验收）不变。
2. 验收④的 `dcp` 命中不是泄漏，是 three 的 `ndcPos` 造成的 3 字符匹配噪声；记录应换更长的串。
3. （三审 2026-11-11）FLT-11 定案过程：三审子审曾误判本条推翻（只查到 spec §Q2 的 0.10~0.16），经 §5:269 原文复核改判成立——`seaRumbleAmp 0.12*SHAKE_MAX` 坐实存在；spec 自相矛盾，修法钉死为改 §5 速查行。
4. （三审）FLT-05 的"实测 12.36m（测试注释自认）"查无出处：全仓 grep 12.36 仅命中本清单；测试注释原文 "~12-13 m"。已删改，同改 §4 ⑤行。
5. （三审）FLT-03 的"else if 永不执行"过强：窄窗口（pitch∈(0.25,0.504] 且 v<26）仍可达，只是 showCue 已被 one-shot 消费成 no-op；"HUD 没被提前"与自引 :306-310 两态 OR 相抵——HUD 会随 stallWarn 提前亮，缺的是两态区分。
6. （三审）FLT-15 的"pickGateSource 与注释不符"不成立：far-field:120-122 注释明示 y 不动、散布已按体量反解进高度带（puff-field:164），自洽；撤说法、降为设计取舍记录。
7. （三审）DOME-12 关闭（报告 :5-6 已自注 16 帧增量来源）；DOME-15"永假断言"改称实质空转的负向 tripwire；DOME-16 的 "~0.094s" 未能复现推导口径，按滞回算式重写（换 bin 于边界+2°：(28°−18°)/71.6°/s ≈ 0.14s < 0.15s）。
8. （三审）实跑复核全部命中：tsc=0；measure.py P1 基线 edge_grad_p95=13.8281；CoC 复算 focus 12/34/60 → 0.198/0.279/0.352；sidecar 六帧旧字节与磁盘实际逐一吻合；analyze_horizon patch 带 max≈24.9/255、超阈 0 行；dist 入口 "dcp" 4 命中全在 three 的 ndcPos（大小写不敏感）。vitest 总数/build chunk 大小沿用主审自报未复跑。
