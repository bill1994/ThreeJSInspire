# 昼夜方案 B 期 1（轨道补档 + 静态 tod 映射 + 月盘）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **执行进度（2026-11-13 checkpoint→收口，远端续跑入口）**：SDD 串行执行，每任务独立复审；Task 6 由 Lead 亲演目检门。
> - **Task 1 ✅** `1a5b6d1`（tod 纯函数+解析器；3 minors）· **Task 2 ✅** `5bde0b2`（预算网格扩 65°；65° 豁免为 Task 4 删除前提）· **Task 3 ✅**（静态 `?tod` 接线；B2 tripwire 绿；WIP+docs 双 commit 不重写历史）· **Task 4 ✅** `cb042f7`（+15/30/45/65 R4 派生 + 人工 12 色；Task 2 豁免已删，65° 双列真值；15° 余量 thin→Task 6 watch）· **Task 5 ✅** `eab60ba`（`uMoonDir` + 1.5° 三层 noise 月盘；smoothstep→`u.nightWeight` 门等价性已裁定；tint 0.659 < 0.72 锚）
> - **Task 6 ✅**（M1 叠加断言入 `sky-moon.test.ts` + 8 帧矩阵 `artifacts/daynight/matrix/` sidecar 全；门 ②③④⑤ PASS；① 夜海偏亮 CONDITIONAL PASS——Task 8 接受 −8 亮海先例 + 机理为 B3 已记录的 +2° 钳制控制、深夜档超域，承接给期 3；12 色 CONDITIONAL PASS——向阳帧与 Task 4 键一致，反日 navy 为 R1 az 设计行为，yaw 向阳复拍为非门 follow-up；749/749、tsc 0。INDEX 登记债：用户 churn 未落定，patch 提案见 ledger `task-6-report.md`，待补 commit）
> - briefs 重生成：`bash <skills>/subagent-driven-development/scripts/task-brief docs/superpowers/plans/2026-11-13-day-night-planB-phase1.md <N>`；本地 ledger 在 gitignored `.superpowers/sdd/`，**远端以本节为准**

**Goal:** 落地 [`2026-11-12-day-night-planB.md`](2026-11-12-day-night-planB.md) 期 1（= 方案 A）：`?tod` 静态映射 + 轨道补档（+15/30/45/65°）+ shader 月盘；参考档恒等、默认画面逐位不变。

**Architecture:** 全部仍从 `skyTrackAt(el)` 单源扇出（main.ts syncSun 结构不动）；期 1 增量 = ①纯函数 tod→(el,az)→太阳/月方向（静态：设了就生效，无 elapsed 推进——B2）②KEYS 数组加四档（R4 程序化派生 + 人工 12 主观字段）③`uMoonDir` uniform + 与 sunDisc 同构的角度阈值月盘（R6）。审核 B1 修正吸收：t0 缺省 17.59 反解值；**方位偏移常数同样反解**——见 Task 1 的 `AZ_OFFSET` 推导，不是把参考方位 12.1° 直接当偏移用。

**Tech Stack:** TypeScript 5.5 · three 0.186.0（WebGPU/TSL）· Vitest 2.1 · CDP 采集量具

**Spec:** [`plans/2026-11-12-day-night-planB.md`](2026-11-12-day-night-planB.md)（R1–R8 定案、分期表、跨期验收门——本计划与其冲突时以它为准）＋ 审核记录（B1 已修 89e61d0；B2 吸收进 Task 3；B3 属期 3，见「跨期注意」）。

## Global Constraints

- three 0.186.0，WebGPU-only；禁 WebGL 回退。
- **调色单源**：新档必须落成 `SkyTrackState` 同结构 KEYS 条目（sky-track.ts），禁旁路调色。
- **单一太阳光源**：期 1 不碰灯光（R7 月光切换属期 3）。
- **参考档恒等**：6.97° 列逐字段不得变值；既有测试一行不碰即守卫。
- **默认逐位不变**：不带 `?tod`/`?todspeed` 启动 = 现状逐位相同（t0 缺省只存不施用——现状太阳由 SUN_POSITION 驱动，?tod 缺省时不得接管方向）。
- **时间纪律**：期 1 无 elapsed 推进；`?todspeed` 只解析存储（B2），期 2 才消费。
- bloom 预算 0.82：+65° 行与月盘峰值必须压线内（sky-color-js.test.ts:130 describe 是守卫）。
- 每任务 fail-first（先红后绿）；`npx tsc --noEmit` = 0 + `npx vitest run` 全绿才 commit。提交 scope：`feat(daynight):` / `test(daynight):`。
- 采集协议：`?qa=frozen` + `qa.step`；`http://[::1]:5173`（vite IPv6-only，Chrome localhost 竞速失败）；canvas 434×772（rect 474.875,0,434.25,772）；段前后 `describe().quality` 一致断言。
- `artifacts/` 只放证据和仪器；证据帧随代码 commit。

## Review Focus

1. **t0/offset 反解错一丝 → 默认或参考档画面移位**：`el(17.59)` 与 `az(17.59)` 的参考 pin 测试（±0.02°）是守卫——Task 1 红绿必须过这两条。→ Task 1 测试。
2. **?tod 与 ?sun= 双入口冲突**：两者都写 sun 方向。优先级钉死：同 URL 出现两者时 **?sun= 胜**（显式机位语义优先于时间轴），Task 3 测试 pin。→ Task 3。
3. **65° 超出现有能量场设计域**：ramp `smoothstep(-0.02,0.55,dirY)` 在 dirY=sin65°≈0.906 饱和于顶色；Preetham 比率高仰角域没测过。预算 65° 行 <0.82 + 正午目检双门。→ Task 4 预算 + Task 6 目检。
4. **月盘与星点打架**：星层 r780 在穹 r800 内、月盘画在穹上——深度/叠加顺序错则星点月盘互咬。→ Task 5 测试 pin 渲染顺序 + 目检。
5. **frozen 兼容**：`?qa=frozen` 下 tod 完全静止（期 1 本就无推进——测试钉「?todspeed=5 也不动」）。→ Task 3。

---

### Task 1: tod 纯函数 + 解析器（量具先行）

**Files:**
- Create: `src/time-of-day.ts` + `src/time-of-day.test.ts`
- Modify: `src/qa.ts`（`parseTod` / `parseTodSpeed`，仿 `parseSunSpin`:73 字面量纪律）
- Modify: `src/main.ts`（URL 接线 + qa 运行时对象挂 `setTod(h)` / `setTodSpeed(x)`——本任务只存状态，不接线方向）

**Interfaces:**
- Produces: `TOD_DEFAULT_H = 17.59`；`solarElevationFor(tod: number): number`（R1：`65·sin(π(tod−6)/12)`）；`solarAzimuthFor(tod: number): number`（`(tod−12)·15 + AZ_OFFSET`）；`moonDirectionFor(elDeg: number, azDeg: number): { el, az }`（`el→−el`、`az→az+180`，静态版）；`parseTod(raw): number | null`（0..24 之外拒绝）；`parseTodSpeed(raw): number`（≥0，缺省 0）
- **`AZ_OFFSET` 推导（实现时按此算，不是拍脑袋）**：参考方位 `az_ref = atan2(SUN_POSITION[0], −SUN_POSITION[2])·180/π = atan2(60,280) ≈ 12.09°`（main.ts:333 口径）；公式在 t0 处必须回到它 ⇒ `AZ_OFFSET = 12.09 − (17.59−12)·15 ≈ **−71.76°**`。**错误做法**是拿 12.09 当偏移——那样 t0 时刻方位会跑到 ≈95.9°，默认接 ?tod 时画面横跳。

- [ ] **Step 1: 写失败测试**（time-of-day.test.ts）

```ts
describe('time-of-day (planB R1/R2, reverse-solved anchors)', () => {
  it('reference anchors: el(17.59)≈6.97±0.02, az(17.59)≈12.09±0.02', () => { /* 双 pin */ });
  it('arc shape: el(6)=0, el(12)=65, el(18)=0, el(0)=−65', () => { /* 四点 */ });
  it('moon is antipodal: moonDirectionFor(6.97, 12.09) → el≈−6.97, az≈192.09', () => { /* 反相 */ });
  it('parseTod rejects <0, >24, non-numeric; parseTodSpeed defaults 0, rejects negative', () => { /* 纪律 */ });
});
```

- [ ] **Step 2: 跑红** `npx vitest run src/time-of-day.test.ts`
- [ ] **Step 3: 实现** 纯函数 + 解析器 + main 接线（只存 tod/todSpeed 状态与 qa 杠杆）
- [ ] **Step 4: 跑绿** + tsc + 全量
- [ ] **Step 5: Commit** `feat(daynight): tod pure functions and parsers (reverse-solved anchors)`

### Task 2: bloom 预算网格扩到 65°（补档前的空行基线）

**Files:**
- Modify: `src/sky-color-js.test.ts:130` describe（`BUDGET_KEYS` 加 65）
- Modify: `src/post.ts:45-69`（预算注释块补 65° 行说明）

- [ ] **Step 1: 扩网格**——此时 `skyTrackAt(65)` 段外钳到参考档 6.97，65° 行记到的是**钳位值**（即补档前基线，注释里写明语义）。**同步补 toon 列**：预算表扩维时必须同时加 65° 的 toon 行（`toonAmount=1` 峰值 < 0.82 断言），按 [`2026-11-12-toon-look-toggle-phase1.md`](2026-11-12-toon-look-toggle-phase1.md) Global Constraints 跨计划依赖 ②③（BUDGET_KEYS 与 post.ts 预算表双方都改，**后做方负责把另一维补齐**——否则 65° 档没有 toon 预算守卫；合并成「state 行 × 参考/toon 两列」，别各写一块）
- [ ] **Step 2: 跑绿**（本任务无红绿——量具先行任务，验收 = 65° 行有数且注释说明「此为钳位基线，Task 4 补档后变真值」）
- [ ] **Step 3: Commit** `test(daynight): bloom budget grid extends to +65 deg (clamped baseline row)`

### Task 3: 静态 tod 接线（B2：设了就生效，不推进）

**Files:**
- Modify: `src/main.ts`（init 与 `qa.setTod`：`solarElevationFor/solarAzimuthFor` → `sunDirectionFromAzEl` → 写 sun 方向；沿 `?sun=` 同一条路径）
- Test: `src/time-of-day.test.ts` 追加 + 采集验证

**Interfaces:**
- Consumes: Task 1 全部导出；main.ts:164 的 `?sun=` 解析路径（优先级参照）
- Produces: `?tod=<0-24>` 启动即设太阳方向；`qa.setTod(h)` 运行时同效；**优先级 = ?sun= 胜 ?tod=**（同 URL 双参数时）

- [ ] **Step 1: 写失败测试**（?tod=12 → 太阳方向 el≈65°；?tod=0 → el≈−65°；?tod=12&sun=180,7 → ?sun 胜；?todspeed=5 在 `?qa=frozen` 下 tod/方向纹丝不动）
- [ ] **Step 2: 跑红 → 实现 → 跑绿**（syncSun 扇出自动让轨道/霾/灯/云跟随新方向——结构零改动）
- [ ] **Step 3: tsc + 全量 + 浏览器冒烟**（`?tod=12` 一帧：正午高位阳光、无画面异常）
- [ ] **Step 4: Commit** `feat(daynight): static ?tod wiring (sun direction, ?sun= precedence, frozen-safe)`

### Task 4: 轨道补档（+15/30/45/65° 四档 KEYS）

**Files:**
- Modify: `src/sky-track.ts`（KEYS 加四条；`deriveKeyFromNeighbors` 派生纯函数 + 单测）
- Test: `src/sky-track.test.ts` 追加 + `src/sky-color-js.test.ts` 预算 65° 行转真值

**Interfaces:**
- Produces: 四档 `SkyTrackState`（R4：nightStops/dayStops/cloudBands 从相邻档 hue-shift 派生——暗端向紫亮端向暖同 toon D1 手法；`hazeLinear`/`awayEdgeLinear` 走 `seaHazeEndpoints` 派生；灯光色从 `sunColorFor` 派生；**人工只调**双 ramp 8 色 + cloudBands 4 色的主观值——初值 my call，Task 6 抓帧复评）
- 派生函数签名：`deriveDayKey(el: number, lowKey: SkyTrackState, highKey: SkyTrackState): SkyTrackState`（纯函数，单测钉派生方向断言）

- [ ] **Step 1: 写失败测试**（段间插值连续性：65° 列存在且 `skyTrackAt(65)` 不再等于钳位参考值；clamp 测试零改动仍绿 = 段外语义未破；镜像对齐沿既有测试模式逐新档跑）
- [ ] **Step 2: 跑红 → 实现（派生 + 人工 12 色）→ 跑绿**
- [ ] **Step 3: 预算 65° 真值行 <0.82**（红则压档内曲线，禁改 0.82/禁碰参考列）
- [ ] **Step 4: tsc + 全量 + Commit** `feat(daynight): track keys +15/30/45/65 (R4 derivation, human ramps)`

### Task 5: 月盘（R6）

**Files:**
- Modify: `src/sky-webgpu.ts`（`uMoonDir` uniform + 角度阈值月盘，与 sunDisc horizon.ts:193 同构；两三层 noise 斑驳，无贴图；亮度锚 0.72）
- Modify: `src/main.ts`（syncSun 推 `uMoonDir` = Task 1 `moonDirectionFor`）
- Test: 源码 pin + 预算

**Interfaces:**
- Consumes: Task 1 `moonDirectionFor`；horizon.ts `sunDisc` 形态
- Produces: 月盘渲染（日侧不可见：`el > 0` 时月盘 alpha→0；`?tod=0` 时 el≈−65° 月在头顶）

- [ ] **Step 1: 写失败测试**（pin：月盘表达式在 sky-webgpu 亮度恒 <0.82；日侧 alpha→0 的 step 结构存在；预算测试加月向采样 <0.82）
- [ ] **Step 2: 跑红 → 实现 → 跑绿**
- [ ] **Step 3: 浏览器验证**——`?tod=0` 帧月盘在头顶可见；`?tod=12` 帧月盘不可见；星点月盘不打架（目检）
- [ ] **Step 4: tsc + 全量 + Commit** `feat(daynight): shader moon disc (uMoonDir, antipodal, budget-safe)`

### Task 6: 采集矩阵 + 目检 + 收口

**Files:**
- Create: `artifacts/daynight/capture-phase1.mjs` + `artifacts/daynight/matrix/`
- Modify: `docs/superpowers/INDEX.md`（planB 行状态更新；`2026-11-08-day-night-sky.md`:101 过期标注随本计划修——planB 验收门 6）

- [x] **Step 1: 采集**——tod ∈ {6, 9, 12, 15, 17.5, 20, 23} 各一帧（high 档）+ `?tod=12` on/off 对照，sidecar 记 URL + describe
- [x] **Step 2: 目检五项**（海/云/霾/灯/veil 随轨道联动，复用昼夜计划 Task 8 Step 5 口径）逐档过（① CONDITIONAL PASS 见进度块裁定，其余 PASS）
- [x] **Step 3: 人工 12 色复评**——正午/上午帧若色不成立，回 Task 4 调主观字段（只动人工档，不碰派生）（CONDITIONAL PASS：向阳一致，无回調）
- [ ] **Step 4: INDEX 登记 + Commit** `test(daynight): phase1 capture matrix, five-point visual gate`（部分：M1 测试 + 本计划进度块已入收口 commit；INDEX 登记待用户 churn 落定，patch 提案在 ledger `task-6-report.md`）

## 跨期注意（本计划不实施，登记防丢）

- **B3（期 3.2 前置）**：R7 月光转向必须显式替换 `main.ts:331` 的 `lightEl = Math.max(el, 2)` 灯仰角钳制，否则灯钉在太阳方位不动。
- **期 2**：tod 模块改 elapsed 驱动（`tod = (t0 + elapsed·speed) mod 24` 纯函数 + 确定性测试）；月随轨动态化；R8 夜归零落在期 2。
- 期 3：深夜档 −20/−40°、月光照明（R7）、月相 SDF、月光路碎闪。

## Self-Review

- planB 期 1 表 1.1→Task 1/2、1.2→Task 4、1.3→Task 5、1.4→Task 6；Task 3 为 B2 静态映射新增（1.4 采集矩阵的前置，planB 表未单列——审核 B2 指出的范围缺口在此补齐）。
- AZ_OFFSET 推导写在 Interfaces，防实现者拿 12.09 当偏移。
- Review Focus 五条各落 owning task。
- 长度 ≈ 路线图的 1.5 倍，无代码转写。
