# Phase-B Task 7–15 — 执行审核（第三方实现，rev.1）

**审核对象：** `git diff 55bf796..HEAD`（11 commits，1304 insertions / 31 files）
**审核方式：** 静态 diff 审查 + three r186 源码核对 + 真实 GLB 头解析 + `stepFlight` 数值复刻
**审核时间：** 2026-10-30
**判定：** 工程质量项全绿，**但 T8 引入玩法级回归、T10 的穿云是 DOM 白卡片**。T9、T10 的可达性、T13 的 HUD 容器是真修好的。

---

## 0. 客观指标（先认账）

`npx vitest run` → 21 files / 133 tests pass；`tsc --noEmit` exit 0；`npm run build` ok；`npm run smoke` → smoke ok。

这四项全绿，但下面三条 Critical 全部是在"测试全绿"的前提下存在的——其中一条还伴随了既有测试被改写。

---

## 1. Critical

### C1. T8 的失速反转了主控制：满杆 = 贴海滑行

`src/game.ts:168-180`。数值复刻（`FLIGHT.MAX_PITCH 1.2`、`MIN/MAX/CRUISE 34/78/46`、`DIVE_GAIN 16`、`STALL.AOA_CRIT 0.42`、`NOSE_DROP 0.55`）：

```
满杆 y=-1 → pitch 1.2 → aoa 1.00
           → speedTarget 56 − sin(1.2)·16 ≈ 41.1 → speed01 0.16
           → stall01 ≈ smoothstep(1.0 · √0.84) ≈ 0.98
           → _fwd.y = 0.932·0.02 − 0.55·0.98 = −0.52
```

净垂直速度 ≈ −21 m/s。从 `START_Y 60` 到 `ALT_MIN 6` 约 2.5 秒，之后**机头 68° 朝天贴海滑行**，且速度地板 34 让 `speed01 = 0`、失速自锁。

代入杆量（30 s 模拟）：

| stick y | 结果 |
|---|---|
| −1.0 | 5 s 内砸到 y=6，stall 1.00，永久贴海 |
| −0.8 | 10 s 内砸到 y=6，stall 0.68 |
| −0.6 | 爬得到 240 m，stall 0.18 |
| −0.45 | 爬得到 240 m，stall 0.01 |

玩家感受：把拇指拖到屏幕顶（最自然的上拉手势），飞机会低头并把机腹贴在离海面 6 m 处。**爬升要靠按住约 45% 杆量**。

两处既有测试被改写以适配这个模型：

- `game.test.ts:60-74`：「climbs for a negative forward drag」的杆量从 `y:-1` 改为 `y:-0.45`，注释写「a FULL nose-up hold now stalls by design」。
- `game.test.ts:94-104`：新增「drops altitude when the stick is held full up」，把满杆下坠**写成期望值**（`expect(s.pos.y).toBeLessThan(200)`）。
- `game.test.ts` 原有「never leaves the altitude band」那条仍是 `y:-1`，但**现在靠"根本不爬"通过**，`ALT_MAX` 的钳位路径不再被任何测试覆盖。

与 plan 的 Review Focus #3 冲突：plan 期望「顶住升限继续拉杆 → 失速项仍上涨」，但满杆会立刻脱离升限，该场景不可达；在升限处需要 `y≈−0.45`，而那里 `stall≈0.01`，没有任何反馈。

**最小改法：** 失速门限改看「超出当前速度能维持的平衡迎角」，而不是原始 pitch；或把 `NOSE_DROP` 钳到投影后 `|_fwd.y|` 不翻号（当前 `stall>0.62` 就翻号）。改完把 `game.test.ts` 恢复成 `y:-1` 并断言 y 上升。

### C2. T10 的穿云是 DOM 白卡片，体积云在玩家视线方向有个硬洞

`src/clouds-compute.ts:103`：

```ts
// Rays pointing down never enter the slab; mask them out instead of selecting.
const up = TSL.step(TSL.float(0), dir.y);
```

这句注释的前提是「相机永远在云板下方」——昨晚把 `ALT_MAX` 抬到 240 之后，相机进了 95–265，**向下的视线整段都在云里**，却仍然被 `:178` 的 `alpha = (1−transmittance)·up` 乘成 0。

机位俯视机身约 12°，60° 垂直 FOV 下 `dir.y>0` 只覆盖画面上约 30 %。于是云内画面是：**上三分之一不透明白云 / 下三分之二清澈海面 / 中间一条硬横线**。

真正让屏幕发白的只有 `hud.setWhiteout`（`game.ts:384` → `hud.ts:89`）：`#e8dfd6`、`opacity 1`、相机 y∈[135,225]，以 20 m/s 爬升约 6 秒全屏不透明米色，玩家在盲飞。

`t0` 已经为「相机在云内」重钳（`clouds-compute.ts:97`），但同一处的兄弟项 `up` 没人回头看——正是 review §1.1 预言的「抬升包线会打破的东西没人重调」。

**最小改法：** `up = select(camY > CLOUD_BOTTOM, float(1), step(0, dir.y))`，`slabRayT` 同步；whiteout 上限压到约 0.8。

### C3. 每次失速都被判成俯冲

`src/game.ts:354`：

```ts
const dive01 = clamp(-_fwd.y * 2, 0, 1);
```

`_fwd` 是**被失速压过**的模块级 scratch（`game.ts:172` 写它），所以 `stall→1` 时 `_fwd.y = −0.55` → `dive01 = 1.0`。同一帧连锁反应：

- `fovKick = 6 + 3 = 9`（最大广角）、`bankFollow 0.45`（`game.ts:364-367`）
- `feel.addTrauma(0.6 stall + 0.35 dive = 0.95)`（`game.ts:368`），叠加 M6 的 buffet 后垂直摆幅约 1.07 m
- 鼓组 `setIntensity(1)`
- 字幕：`game.ts:400` 先出 `stall`，`:403` 因 `dive01 > 0.6` 紧接着出 `dive`，**把失速字幕覆盖掉并消耗掉该条 cue**，之后真正俯冲时反而没有台词

**最小改法：** `dive01` 改由未修改的 `state.pitch` 推导，如 `clamp(-Math.sin(state.pitch) * 2, 0, 1)`。

---

## 2. Important

| # | 问题 | 证据 |
|---|---|---|
| I1 | **T11 的"饱和"证明测错了边**：`SEA_FOLLOW_STEP = SEA_PATCH_SIZE/3 = 400`，`far-field` 按它吸附，海面正向边缘最坏只有 400 m 远；而 `HAZE_FAR = 520` → 最坏相位 haze 只有 0.81–0.85，仍留 15–19 % 海色。`horizon.test.ts:14` 却拿理想的 `hypot(600,240)` 去证，且写死字面量；`horizon.ts:8` 声称"checked against the 240 m ceiling"不成立（真正的约束是 400 m 吸附滞后） | `sea-fft.ts:552,664`、`far-field.ts:85`、`horizon.test.ts:14` |
| I2 | **T12 把海面峰值眩光抬高 2.6×，而 bloom 阈值是抬高之前定的**：`spec·1.5·(1+1.6·mask)` 峰值 3.9×，`post.ts` 的 `0.82` 未重调；同时 `nearFade = dist·0.02` 在 240 m 高度下早已饱和为 1，近场保护失效 | `sea-fft.ts:630,641-646`、`post.ts:58` |
| I3 | **9 个新导出函数在测试外零消费者**：`roadMask`/`sunRoadGain`/`azimuthDiff`/`horizonHaze`/`horizonGlow`/`bandIndex`/`busGainDb`/`duckGain`/`lowerThirdY`。shader 里是内联副本，所以 T11/T12/T14 的单测证的是"参考实现"，产品跑的那份改了没人知道 | `sun-road.ts:26,35,44`、`sea-fft.ts:635-665`、`audio.ts:75,85`、`portrait.ts:33` |
| I4 | **`smoke.mjs` 没加 8 个新模块**，"smoke ok" 对本期是空检查；`npm run build` 靠 vite 解析掩盖了它 | `scripts/smoke.mjs:3-21` |
| I5 | **`toon.ts` 的静态 `import { MeshToonNodeMaterial } from 'three/webgpu'` 让 `renderer.ts` 的经典 WebGL 兜底变成死代码**：import 链 `main→game→plane→toon` 在模块图阶段就失败，`createRenderer` 的 last-resort 分支永远到不了，"never a black page" 的承诺失效 | `toon.ts:15`、`renderer.ts:53-58` |
| I6 | **音频云内增噪是永久 latch**：`cloudBoost = cloudWind01(1)` 一次写死后不再衰减，出云后风机永远更响；而 `game.ts:383` 本来每帧都算 `camCloud01` | `audio.ts:146,359,454` |
| I7 | **字幕落在刚保留出来的安全区内**：`subtitles.ts:54` 写死 `bottom:78px`，而 `hud.ts:211-213` 用 `hudSafeArea().bottom ≈ 0.14H`（844 帧上 118 px）并放状态行，两者会顶在一起 | `subtitles.ts:54`、`hud.ts:211-213` |
| I8 | **`PORTRAIT_QA.md` 过度声称**：`:13` 写 "PC WebGPU ≥ 55 fps：达成"，而同文档表格自记 51–134 与 46–94；`:21` 写"已取证，见 SDD ledger"，但**仓库里没有任何截图，`.superpowers/sdd/` 只剩一个 `.gitignore`**（ledger 已在 01:15 被删） | `docs/PORTRAIT_QA.md:13,21` |

---

## 3. Minor（节选）

- **M1** `toonify` 的属性丢弃对**当前 GLB 无害**：GLB 头显示 6 材质、`images: 0`、无 emissive/normal/alphaMode、全 `doubleSided`。唯一真实损失是 `metal_prop`(0.85/0.34) 与 `glass_canopy`(0.1/0.18) 在平面 toon 色阶下丢掉高光读感（螺旋桨可见）。
- **M2** 全白 ramp（等于没有 toon）能通过所有测试：`hexToRgba` 对非法 hex 静默返回白色，`toon.test.ts` 只断言尺寸/滤镜，不断言像素。
- **M4** `directorCurve` 只读 5 个输入里的 `dive01`，其余 4 个是死参数；`director.test.ts` 怎么改都过。
- **M5** 每帧约 6 次分配（`director.ts:89` 展开对象、`game.ts:364`、`camera-rig.ts` tuning、`game.ts:389` 每帧新建闭包），而 `game.ts:336` 自称 "no allocation"。
- **M6** `feel.ts:50-53` 承诺 `|shake| ≤ trauma²·SHAKE_MAX`，`:284` 在其后又加 `0.35·stall·SHAKE_MAX`，C3 的 0.95 trauma 下实测约 1.07 m 垂直摆幅；`feel.test.ts` 未更新。
- **M8** T15 的 `lowerThirdY` 无消费者，`CAMERA_TUNING` 未被触碰，"机身在下一三分线"没有落地。
- **M9** `#boot-status` 仍是 `position:fixed`（`main.ts:50-65`），只有 HUD 进了 `#frame`；review §2.5 只修了一半。

---

## 4. 逐任务判定

| Task | 判定 | 说明 |
|---|---|---|
| 7 toon | **done** | gradientMap + 飞机专属 + 无全局量化；但 ramp 像素无断言、静态 import 破坏兜底 |
| 8 stall | **wrong** | 公式贴 plan，但控制包线反转，既有测试被改写掩盖 |
| 9 director | **partial** | 注入 + ≤9° 钳位正确；`dive01` 取自失速污染向量 |
| 10 clouds | **partial** | 升限/`slabRayT` 真修好；云内朝下视线被遮成透明，穿云靠 DOM 白卡 |
| 11 horizon | **partial** | 无新几何 ✓、常量共享 ✓；饱和证明测理想边而非 400 m 吸附边 |
| 12 sun road | **partial** | 参数化既有 glint ✓；峰值 2.6× 未与 bloom 重对账；三函数无消费者 |
| 13 subtitles | **partial** | HUD 容器修复正确；字幕落进保留区会撞状态行 |
| 14 audio | **partial** | `pulse()` 可用；`cloudWind01` 永久 latch；两个 helper 无消费者 |
| 15 portrait QA | **partial** | 纯函数拆分 ✓、`portraitAspect` 双端使用 ✓；`lowerThirdY` 死、相机调参未做、QA 文档过度声称 |

---

## 5. 建议修复顺序（按"玩家能感知的损失 / 改动成本"排序）

1. **C1** 失速门限（玩法回归，最伤）→ 恢复 `game.test.ts` 的 `y:-1`
2. **C2** 云内 `up` mask + whiteout 上限（穿云目前是假的）
3. **C3** `dive01` 改取 `state.pitch`（连修字幕覆盖、FOV 跳满、trauma 叠爆）
4. **I5** `toon.ts` 改动态 import（否则"永不白屏"的安全网是画的）
5. **I1** `HAZE_FAR` 与 400 m 吸附边对账
6. **I4** `smoke.mjs` 补 8 个模块
7. I2 / I6 / I7 / I8 各自独立，可并行

I3 是取舍问题：要么删掉那 9 个"参考实现"和只测它们的测试，要么加一条源码扫描断言，锁住 shader 里的内联副本。

---

## 6. 关于我自己的责任

I5 这条有一半是我昨晚留下的：我在 `renderer.ts` 里写了"`three/webgpu` 加载失败 → 退回经典 WebGLRenderer"的兜底，但没检查后来的模块会不会用静态 import 把它变成死代码。兜底写在主路径上、被别人的静态 import 短路，这种安全网是假的。
