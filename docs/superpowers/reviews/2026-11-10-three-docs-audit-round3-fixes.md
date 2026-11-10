# 三份文档第三轮修正清单（S1-S13）执行档案

- 日期：2026-11-10
- 依据：`docs/superpowers/reviews/2026-11-10-three-docs-audit-round3.md`（证据与复现全文）＋ 主人同日逐条裁定
- 性质：本文件是**裁定后的最终改法**与逐条替换清单，供回溯"哪条、为什么、改了哪一行"。
  证据、源码行号、复算过程不在这里重复，见 round3 报告 §2-§5。
- S13 是执行中读 `main.ts` 时新发现的（URL 通道写在 `qa` 定义之前），不在 round3 报告里，单独记在 §2.5。
- 提交拆账：round2 报告 → `ba436ca`；R1-R16 回填 → `2d57c95`；本档案 + round3 报告 → `c200dd2`；S1-S13 落地 → `41e9469`。

## 0. 主人裁定摘要

| 项 | 裁定 |
|---|---|
| 批次 0/1/3 | 放行 |
| S2 / S4 / S5 / S7 | 同意，各带一处小修（见下） |
| S1 | 方向对、判据错：不能只留"仍满杆"，也不能留 `speed<22`。改判据为**机制失败信号**：延长用尽时 `speed < 13.2`（0.6·`STALL_SPEED`，authority 归零线） |
| 82.5% | 主人认领：那是 0.8s 的值；1.0s 正确值 88.9%（≈16.0） |
| S9/S10 根源 | 主人认领：R9 滑窗只在跨 yaw bin 时补生，直飞不换 bin，46 m/s 吃完 1200 m 近缘 ~26s，成立 |
| S7 第四份文件 | 同意一起改（设计 spec §5.2）；"暗底"美术项留到对照 `ref-01` 再拍 |
| R17 | 同意只写进计划（Task 1 顺手改），不单独开代码提交 |

## 1. S1-S13 一览（问题 → 最终改法）

| 编号 | 问题（一句话） | 最终改法 |
|---|---|---|
| S1 | fallback 判据含恒假项，且只留"满杆"会把拉杆玩家打回旧 fall | 判据 = 延长 2×0.3s 用尽时 `speed < 13.2`；硬保证正常 2.38s / 延长 ≤2.98s |
| S2 | patch 生命周期只定义跨 bin 回收，平移与 alpha 互斥 | 跟随相机：距离/方位 bin 内定死、per-patch 固定 alpha 0.5-0.8、距离带 1300-1700、删距离曲线 |
| S3 | Task 5 的 `y` 米/归一两种量纲 | 显式 `yn = (y-base)/SLAB_HEIGHT` 给 sin，ceiling 用米 |
| S4 | R14 只补控制台，URL 无法表达锁与端点 | URL 加 `hazelock/haze/away`（线性、≥4 位小数），先端点后锁 |
| S5 | `exportColorState` 的端点值无来源 | 闭包 `hazeNow/awayEdgeNow`，syncSun 未锁定分支 + `setHazeEndpoints` 双写，导出单读 |
| S6 | R7 只写进 Task 0.5，Task 7 Step 4 没有复测 | Step 4 加"先复测 rows 330-420，未定性不得标定 patch" |
| S7 | 门 4 仍写"暗底/亮顶"，与 7° 太阳几何相反 | 改"受光/背光双峰，不规定极性"；设计 spec §5.2/§8 同步；暗底列美术待拍 |
| S8 | `WorldView` 必填 `headingRad` 漏了 `world.test.ts:136` | 改成三处字面量，Files 补 `src/world.test.ts` |
| S9 | 测试看总数、门看 alpha≥0.5，可能测试绿门红 | 距离带 1300-1700 + per-patch alpha≥0.5 → 两者同口径 |
| S10 | 跨 bin"增量补生"无合并规则 | 保留 + 新楔形补生 + 总数封顶 8 + 18 bin 归一 + 2° 滞回 |
| S11 | R17 延期条件已满足，注释仍陈旧 | 写进 panel Task 1 步骤（不动源码） |
| S12 | "before 帧在 Task 0 现抓"没有步骤 | Task 0 加冻结抓帧项与路径 |
| S13 | （执行中发现）URL 通道写在 `qa` 定义之前，`qa.setTrackPatch` 会 TDZ | Task 1 Step 3.7 挪到 qa 对象创建后（约 L463）；Task 2 mount 同理 |

## 2. 逐条替换清单

> 行号以回填后的工作区版本（提交 `2d57c95`）为准；改完的版本以最终 diff 为准。

### 2.1 飞行手感 v1.1（`docs/superpowers/specs/2026-11-10-flight-feel-improvement-design.md`）

1. **L114**（S1/b/c）：
   - `2.2 attack 在 1.0s 内只到 82.5%（≈14.8）` → `2.2 attack 在 1.0s 内只到 88.9%（≈16.0；0.8s 是 82.8%/14.9）`。
   - 同条补 pushover 入口初态：`入口初态：pitch 取当前值，vy 从 −4~6 m/s 起，speed 覆盖为 18（从 cruise 直进时约 4 m/s 的减速，按瞬态处理）`。
2. **L116**（S1）：硬保证改为 `正常路径 0.58+0.8+1.0=2.38s（取整 2.4s）；满杆延长走满 2.38+2×0.3=2.98s（取整 3.0s）；两条路径掉高都 ≤15m`。
3. **L118**（S1）：fallback 判据重写：
   - 删 `pitch>0.25`（延长段强制 ≤ −0.05，恒假）；删 `speed<22`（1.6s 约 20.8，会误伤所有满杆玩家）。
   - 新判据：`延长用尽时 speed < 13.2（=0.6·STALL_SPEED，authority 归零线）才回退 fall`。
   - 补：正常轨迹最低 ~17.2-17.5、延长走完 ~21.6-22（复算；执行时同款无头模拟 pin），13.2 是保险丝不是路径；满杆不是前提（满杆归宿是 R2 的"挡下→pushover"循环）。
4. **L128**（S1）：`延长 0.3s` → `延长 0.3s（PUSHOVER_EXTENSIONS 最多 2 次，单次 PUSHOVER_EXTEND 0.3s）`。
5. **L239**（小项 a）：P1 档删 `FOV 基线 + `。
6. **L250-251**（S1）：`RECOVERY_SPEED 18（入口 snap）`；补 `PUSHOVER_EXTENSIONS 2, PUSHOVER_EXTEND 0.3`；`FALL_HARD_CAP 0.8（正常 ≤2.4s、满杆延长 ≤3.0s，掉高 ≤15m——实账 ~8-9m）`。
7. **L270**（S1）：计时验收改成 `正常 ≤2.4s、满杆延长 ≤3.0s，掉高 ≤15m`。

### 2.2 穹顶云计划（`docs/superpowers/plans/2026-11-10-dome-cloud-p15-p2-horizon.md`）

8. **L344-353**（S3）：`profile` 的量纲写死：
   ```ts
   const yn = y.sub(DOME_SLAB.base).div(SLAB_HEIGHT);        // 0..1，sin 用这个
   const ceiling = smoothstep(DOME_SLAB.base + 20, DOME_SLAB.base + 100, y); // 米，只在底部淡入
   profile = ceiling.mul(float(0.72).add(float(0.28).mul(sin(yn.mul(3).add(phi).mul(2 * Math.PI)))));
   ```
   测试补钉 `yn` 与 `.div(SLAB_HEIGHT)`；删掉"频率别写成 6"这种口头约定。
9. **L271 + L320**（S7）：`暗底/亮顶分离` → `受光/背光双峰分离（直方图局部极大值 ≥2；不规定底/顶极性）`；`直方图暗/亮分离` 同改。
10. **L461**（小项 d）：标题去掉 `（方案 B）`。
11. **L466**（S8）：Files 的 Modify 补 `src/world.test.ts`。
12. **L473**（S8）：`只需动两处字面量` → `三处字面量（main.ts:337、world.ts:201、world.test.ts:136）`。
13. **L475-477**（S2/S9）：`PatchSpec` 加 `alpha: number`（0.5-0.8）与 `sizeMetres` 范围（80-200）；`patchesFor` 距离改 **1300-1700**；`azimuthDeg` 相对扇区中心不变。
14. **L485-493**（S2/S10）：重写"patch 散布方向"：
    - 跟随相机：`位置 = 相机位置 + distanceMetres × (−sin θ, −cos θ)`（θ = bin 中心 + azimuthDeg，与 `game.ts` 的 yaw 同约定；写成 `(sin,cos)` 会把云镜像到身后）；bin 内距离/方位定死，随平移、不随 yaw 旋转。
    - 明示取舍：patch 行为等同无穷远，deck 是有限距离视差——两层运动逻辑不同，不是 bug。
    - 每个 patch 固定 alpha（0.5-0.8），**删除距离曲线**；可见计数 = spec 计数。
    - 合并规则：保留旧组里落进新扇区的；只从新组取落在"新暴露 20° 楔形"的补生；总数封顶 8（超了按离视轴远→近丢）；`binIndex = ((round(yawDeg/20)+9) mod 18) − 9`；跨边界 2° 滞回。
    - 补生角：新楔形离实际视轴 ≥30°（跨 bin 时视轴在边界，楔形近端在 center+20），淡入 `PATCH_FADE_IN 0.15s`——满舵 71.6°/s 下 12° 余量 = 0.17s，入画前走完。
15. **L501-515**（S9）：测试距离断言 1300-1700；加 `alpha ∈ [0.5,0.8]`；`ps.length` 3-8 即"可见数"。
16. **L533-544**（S2/S10）：Step 3 按第 14 条重写 update；`alpha = p.alpha * birthFade`；y 区间保持 350-440；`12~14°` → `9.2-17.6°`，`压在 deck 底缘下方` → `跨在 deck 底缘上（1350 m 处 patch 已满不透明，合成是遮挡不是叠加）`。
17. **L554-556**（S6）：Step 4 开头加 R7 复测句。
18. **L566**（小项 d）：commit message 改 `feat(dome): cheap horizon patch ring in the fade band (heading window)`。

### 2.3 调色面板计划（`docs/superpowers/plans/2026-11-09-debug-color-panel.md`）

19. **L8-10**（小项 h）：Architecture 的 qa 函数补 `setChopGate`、`setHazeEndpoints`。
20. **L72-78**（S12/S4）：Task 0 加 before 抓帧项（`?qa=frozen` + `qa.step(0)` → `artifacts/debug-color/before.png`，记 SHA/step）；qa parser 清单补 `parseHazeLock`、`parseLinearVec3`（新增）。
21. **L102-106**（S4/S5）：`exportColorState` 返回 `haze/awayEdge` 来自闭包缓存；新增 parser 与 `setChopGate`/`setHazeEndpoints` 并列。
22. **L108-115**（S4/S5）：测试补 `parseHazeLock/parseLinearVec3`、缓存双写单读、"锁定→改端点→导出=改后值"。
23. **L133-148**（S4/S5/S11）：Step 3 加 `hazeNow/awayEdgeNow` 缓存与赋值点；启动块顺序：解析 `haze/away` → `setHazeEndpoints` → `lockHaze(true)`；repro 数字 `toFixed(4)`；顺手改 `main.ts:17-18` 与 `qa.ts:50-56` 两处注释（R17）。
24. **L167-168**（小项 i）：海面组补 `clearChopGate` 透传，nochop 做成可恢复。

### 2.4 穹顶云设计 spec（`docs/superpowers/specs/2026-11-10-dome-cloud-p15-p2-design.md`）

25. **L101**（S7）：`云带内亮度直方图出现暗底/亮顶分离` → `云带内亮度直方图出现受光/背光双峰分离（不规定底/顶极性）`；补一句 `"暗底亮顶"若仍要，属风格化选择，对照 ref-01 另拍`。
26. **L170**（S7）：门 4 同改为 `受光/背光双峰分离`。

### 2.5 执行中发现（S13）

27. **panel Task 1 Step 3.7 / Task 2 Files**（S13）：原计划把 URL 通道写在 `qaParams` 那段（L184-195），但 `qa` 对象在 L370 才由 `Object.assign(__porco, { qa })` 创建——L184 调 `qa.setTrackPatch` 会 TDZ/undefined。
    - 改法：URL 解析与 `setHazeEndpoints`/`lockHaze` 一律挪到 `Object.assign` 之后、`setAnimationLoop` 之前（约 L463）；`?debug=color` 的 mount 同理。顺序仍是"先端点、后锁"。
    - 证据：`main.ts` L184-195（qaParams 块）在 L370（qa 定义）之前；动画循环 L465 之后才跑第一帧，所以 L463 接最晚且安全。

## 3. 验证记录（改完自查）

- [x] `git diff` 逐条对 S1-S13 + 小项：4 文件 `+99/−66`，无顺手改无关段。
- [x] 残留 grep：`82.5`／`两处字面量`／`暗底/亮顶`／`12~14`／`FOV 基线`／`增量补生` 只在本档案（作为"改前"记录）出现；`470 用例` 只剩 Task 0 的历史括注（已标"勿沿用"）；`两轮` 只剩常量注释 `PUSHOVER_EXTENSIONS: 2`（已定义）。
- [x] 飞行 pin：pitch 3.6/s 从 +1.2 → +0.08、speed 从 18 起，Euler 1/60 复算：最低 **17.16**（含 stall 拖拽）/ **17.55**（不含）@0.23s，1.6s **21.64-21.97**；距 13.2 最近也有 3.9 的余量。
- [x] 面板：`exportColorState` 端点来源 = `hazeNow/awayEdgeNow`（syncSun 未锁定分支 + setHazeEndpoints 双写）、URL 参数、启动顺序（先端点后锁、L463 之后）四处文本一致；`setChopGate/clearChopGate` 成对。
- [x] 穹顶：`distanceMetres 1300–1700`、`sizeMetres 80–200`、`alpha 0.5–0.8`、合并规则（保留+新楔形+封顶 8+18 bin+2° 滞回）、`(−sin,−cos)` 定位、三处字面量在同一份计划里自洽；`9.7~16.3°` 与 y 350-440 / d 1300-1700 的几何一致。
- [x] 设计 spec §5.2 / §8 与计划 Task 4 判据同词（"受光/背光双峰，不规定极性"）。
- [x] 计划自身行号锚点：`main.ts` L370（qa 定义）/ L463（`Object.assign` 结束）/ L465（`setAnimationLoop`）与本文一致；`world.test.ts:136` 是唯一漏掉的字面量。
