# 昼夜天空计划审核报告 —— `2026-11-08-day-night-sky.md`

**审核对象**：[2026-11-08-day-night-sky.md](../plans/2026-11-08-day-night-sky.md)（252 行 / 30 KB）
**审核日期**：2026-11-08　|　**口径**：静态代码对照 + 仓库既有画面（`artifacts/cloud-audit/protocol/A-cruise-alt60.png`、`.tmp-dark1.png`）
**结论**：**不通过（4 阻断 / 7 重要 / 12 注意）**

骨架是对的：参考档恒等 + 调色单源 + 「TSL 图 / JS 镜像」双写的组合，正是这个仓库过去唯一没翻车的写法。问题集中在**算术**和**门**：有 4 处会让 Task 按字面写就一定失败，或者写成功了也是假绿。

> 本次**只做静态对照**：没起 dev server、没采集新帧（计划把重采放在 Task 8）。凡涉及「画面」的判断，依据是仓库现存帧 + 代码可推导的量，已在各条里标注依据。

---

## 一、审核方法与证据边界

- **代码**：`src/sky-webgpu.ts` / `src/horizon.ts` / `src/palettes.ts` / `src/sea/material.ts` / `src/sea/rings.ts` / `src/far-field.ts` / `src/lights.ts` / `src/puff-cloud.ts` / `src/in-cloud.ts` / `src/main.ts` / `src/game.ts` / `src/post.ts` / `src/renderer.ts`；测试 `sea/material.test.ts` / `far-field.test.ts` / `game.test.ts` / `horizon.test.ts` / `module-graph.test.ts` / `renderer.test.ts`；`node_modules/three/examples/jsm/objects/SkyMesh.js`（Preetham 数学源）。
- **工具链**：`artifacts/cloud-audit/audit.py`、`states.py`、`color_sample.py`、`protocol/baseline-content-anchored.json`、`docs/superpowers/plans/2026-10-31-capture-protocol.md`。
- **画面**：`A-cruise-alt60.png`（1384×797，冻结协议出货帧）与 `.tmp-dark1.png` 用于核对「海天线」与「云的分档」两个可目视的事实；夜档画面**尚不存在**，计划里也没有 mock，所以夜档观感只能从调色表与代码推导，不能声称「看过」。
- 所有行号均已亲自打开确认；凡与计划引用不一致的（例如 `SkyMesh.js` 的 156/280–379），见 §四 T9。

---

## 二、阻断项

### B1　太阳项被能量场闸死：−2.30° 以下 `E ≡ 0`，−4° 档的 glow/sunTint 全部乘零

**计划位置**：[计划 127–131 行](../plans/2026-11-08-day-night-sky.md) 的合成式：

```text
day = ramp(dayStops) → awayCool → + sunTint·(glow + disc)
C   = mix(day · E, night, nightWeight) + floorLinear
```

**代码事实**：`E` 来自 Preetham，而 Preetham 的入射能量 `vSunE` 有一个硬 cutoff——`SkyMesh.js:177-190`：

```js
const cutoffAngle = 1.6110731556870734;  // ≈ 92.30°
const steepness   = 1.5;
const sunIntensity = EE * max(0, 1 - exp(-(cutoffAngle - acos(clamp(sunDir.y,-1,1))) / steepness));
```

代入 `clampSunElevation` 之前的口径（`SUN_DIRECTION.y = 0.12132`）：

| 太阳仰角 | `acos(y)` | cutoff − acos | `vSunE` |
|---|---|---|---|
| ≈6.97°（参考） | 1.44916 | +0.16191 | **102.3** |
| 0° | 1.57080 | +0.04028 | **26.5** |
| −2.30° | 1.61107 | 0 | **0** |
| −4° / −8° | 1.64061 / 1.71039 | 负 | **0**（`max(0,·)` 吃掉） |

而 `Lin = pow(vSunE · ratio · (1−Fex), 1.5)`（`SkyMesh.js:267`）——`vSunE` 在 1.5 次幂里，所以能量场随仰角掉得比线性还快；`vSunE = 0` 时 `Lin = 0`，只剩 `L0 = 0.1·Fex`（`SkyMesh.js:272`），`P ≈ 0.004·Fex`。

**后果**（两条，都很硬）：

1. **−4° / −8° 档的 `glow` 与 `sunTint` 被乘成 0。** 计划给 −4° 安排了 `glowGain 0.45 / glowPow 150 / sunTint [.9,.45,.25]`（[计划 76–77 行](../plans/2026-11-08-day-night-sky.md)），这些值在 `day·E` 里得到的贡献是 `0.45 × 0 ≈ 0`。也就是说「过渡档的日落余晖」在数学上不可能出现——而这正是整个功能的名字。
2. **两条测试必然失败。** [计划 138 行](../plans/2026-11-08-day-night-sky.md) 的夜档形态断言「地平线向阳仍略亮于背阳（afterglow 残留）」：`vSunE=0` 时 `Fex` 只依赖 `direction.y`，**不含方位**，所以向阳与背阳的 `E` 逐位相同；再叠加 `nightWeight=1`，`mix(day·E, night, 1) === night`，而 `night` 是纯垂直 ramp——两个方向的值**完全相同**。这条断言要么恒假，要么靠浮点噪声偶然为真（后者更糟：它会把一个不存在的能力盖成 PASS）。同理 [计划 107 行](../plans/2026-11-08-day-night-sky.md) 的 ③「参考档 > −4° 档 > −8° 档」：−4° 与 −8° 的 `vSunE` 都是 0、`P` 完全相同，严格大于不成立。Task 2 Step 2 会「预期 FAIL」，但 Step 3 的实现改不动它——它是移植公式的固有性质。

**修法**（改结构，不改艺术值）：

```text
C = mix( ramp(dayStops)·E  +  sunTint·(glow + disc),  night,  nightWeight ) + floor
```

即**把加法直射项移出 `E` 的闸门**。理由：`E` 是漫射入散射的比值（`Lin` 那种东西），而日盘/晖光是直射项，物理上本来就不该被漫射比压掉。参考档 `E=1`，所以恒等保证不受影响——这是最便宜的一改。

若作者**故意**要 `E` 闸住一切（让 −4° 只剩夜 ramp），那就要同时做三件事，否则计划自相矛盾：删掉 [计划 138 行](../plans/2026-11-08-day-night-sky.md) 的 afterglow 断言、把 −4° 列的 `glowGain/glowPow/sunTint` 标成「无运行时效果」、并把 Task 2 的 ③ 改成「参考档 > 0° 档 > −4°档 = −8°档」。**二选一，写进计划，别留给实现者临场发挥。**

### B2　Task 3 恒等测试重建的旧公式是错的，照写会把 g² 钉进代码

**计划位置**：[计划 137 行](../plans/2026-11-08-day-night-sky.md)：「内联重建旧公式（`rampColorJs(...)` + `antiSolarCool` 混向 `awayHorizonLinear()` + `horizonGlow`/`sunDisc`/`sunTint` 相加）」。

**代码事实**：现实现是**混向 `AWAY_COLOR`，不是混向 `awayHorizonLinear()`**（`sky-webgpu.ts:72-102`）：

```ts
const cool = pow(away, 1.2) * lowSky * HORIZON.AWAY_GAIN;   // 0.75 在这里乘一次
base = mix(base, AWAY_COLOR, cool);
```

而 `awayHorizonLinear()` 自己已经含了一次 `AWAY_GAIN`：`(1−0.75)·HAZE + 0.75·AWAY`（[horizon.ts:101-118](../../../src/horizon.ts)）。所以「混向 awayHorizonLinear + 乘 antiSolarCool（内含 AWAY_GAIN）」等于把增益乘了**两次**。取背阳端（`away=1, lowSky=1`）：

| 写法 | 结果 |
|---|---|
| 真实实现 | `0.25·base + 0.75·AWAY` |
| 计划写的「混向 awayHorizonLinear × antiSolarCool」 | `0.4375·base + 0.5625·AWAY` |

这不是笔误级别：它正是 [horizon.ts:124-127](../../../src/horizon.ts) 的 docblock 明令警告的那个错误（「再乘 antiSolarCool 会变成 g²」）。

**后果**：照字面写，恒等测试对忠实实现**必然失败**（差 ~0.19·|base−AWAY|），实现者为了让它绿，只能把 v2 写成 g² 的形式——于是不仅恒等丢了，还会同时改掉海面倒影的暗部。

**修法**：把 137 行改成「`mix(base, AWAY_COLOR, antiSolarCool(cosAz, dirY, {awayGain, awayHeight}))`」，并在测试里直接 `import { AWAY_COLOR, SKY_STOPS }` 取色，不要经过 `awayHorizonLinear()`。顺带把这条写成一句注释：**`awayHorizonLinear()` 是给海面用的端点，不是给穹顶用的混色目标。**

### B3　Task 4 的 bloom 预算与约束①⑥互斥：参考档峰值 0.97 > 0.82 是**故意的**

**计划位置**：[计划 155 行](../plans/2026-11-08-day-night-sky.md)「对四个关键帧…在仰角 −2…40°、相对太阳方位 ±90° 网格上取 Rec709 亮度，断言峰值 < `state.bloomThreshold`」；[计划 156 行](../plans/2026-11-08-day-night-sky.md)「按失败档位回调该档 `glowGain`/`floorLinear`」。

**代码事实**：参考档的 on-axis 峰值本来就超阈值，而且是文档化的设计：

- `post.ts:45-64` 的预算注释：`glow 0.42 + disc 0.3 ≈ 0.97`，越过 `bloomThreshold 0.82`，**ON PURPOSE**（POINT 是给日盘开花的）。
- 复算：`base = HAZE = [1, 0.323, 0.102]`，`sunTint·(glow+disc) = [1,0.78,0.52]·0.72 = [0.72, 0.5616, 0.3744]`，合成 `[1.72, 0.885, 0.477]`，Rec709 ≈ **1.03**（比注释里的 0.97 略高，同为「明显越阈」，不影响结论）。
- 网格的仰角区间 −2…40°（步长 2°）在 6–8° 一带必然扫到 glow 核与日盘边缘（参考档 `discGain 0.3`、日盘半角 2°，el=6 处 `smoothstep` 已给出 0.77 的盘权重），峰值 ≈0.98–1.03。

**后果**：Task 4 Step 1 在参考档必失败；Step 2 的补救手段（回调该档 `glowGain`）**直接违反约束①**——而 [计划 62 行](../plans/2026-11-08-day-night-sky.md) 已经断言 `glowGain === HORIZON.GLOW_GAIN`。于是实现者只剩两条路：偷偷放宽阈值（违反约束⑥），或者把参考档的 glow 调暗（恒等破功）。这是计划内部的自相矛盾，不是实现难度。

**修法**：把「峰值」拆成两个量测：

1. `includeDisc=false`（或剔除太阳方向 ±2.5° 锥）的**非盘区峰值** < 0.82 —— 这条才是「夜档不许整屏开花」的真判据；
2. 盘区峰值单独断言一个**上界**（例如 `≤ 1.10`），防止把日盘调爆。

这与 `post.ts` 现有注释的语义一致，也不需要动任何艺术值。

### B4　Task 6 的 far-field 修法无效，且它的回归 pin 是假绿

**计划位置**：[计划 185 行](../plans/2026-11-08-day-night-sky.md)「`far-field.ts` 的 `SKY_NAMES` 约第 23 行加星点对象名」；[计划 189 行](../plans/2026-11-08-day-night-sky.md)「星点不加进这个名单，夜档起飞约十秒后星点整体留在身后消失」；[计划 191 行](../plans/2026-11-08-day-night-sky.md)「far-field 源码含 `'sky_stars'`（防拖动名单漏加的回归 pin）」。

**代码事实**（[far-field.ts](../../../src/far-field.ts)）：

```ts
function findFirst(scene, names) { for (const n of names) { const o = scene.getObjectByName(n); if (o) return o; } return null; }  // 39–45：命中即 return
function moveTo(obj, x, z) { ... }                                                                                              // 47–53：单对象
// update(): 81  this.sky && moveTo(this.sky, x, z)
```

`SKY_NAMES` 是**候选名**列表，不是「要搬的清单」。加上 `'sky_stars'` 之后，`findFirst` 仍会在第一个命中（`sky_sunset_tsl`）处返回，星点一次都不会被搬——**特征按计划描述的方式修，等于没修**。

同时：`far-field.test.ts:27` 断言 `followed` 深等于 `{ sky: 'sky_sunset_tsl' }`，所以 Task 6 Step 4 的 `vitest run src/stars.test.ts src/far-field.test.ts` 会**原样通过**；加上「源码含 `'sky_stars'`」这条 pin 只匹配一个字面量，两处都是假绿。功能实际失效，测试全绿——这是最坏的一种组合。

**修法**：把 `followed` 从「一个对象」改成「一个数组」（`followed: { towed: string[] }` 或 `followed.sky` + `followed.stars`），`update()` 遍历搬；测试改成断言**两个对象的 position 都等于相机 x/z**，并把 `far-field.test.ts:27` 的深等断言一并更新。若不想动结构，就在 `initStars` 里返回一个 `tow(x, z)` 并让 `main.ts` 每帧调——但那样就绕开了 far-field 的单一职责，不推荐。

---

## 三、重要项

### M1　星点没关雾：`PointsMaterial` 默认 `fog=true`，r=780 会被全量染成 `#c96a7a`

[计划 189 行](../plans/2026-11-08-day-night-sky.md) 的材质参数里没有 `fog`。而仓库里**三处**背景材质都显式关了雾：`sky-webgpu.ts:131`、`puff-cloud.ts:260`、`puff-cloud.ts:341`（计划 [242 行](../plans/2026-11-08-day-night-sky.md) 自己也写了「海/天穹/云材质都 `fog = false`」）。星点是唯一漏网的。

量：`scene.fog = Fog('#c96a7a', 60, 700)`（`main.ts:58`），线性雾因子 `(700−780)/(700−60) = −0.125 → clamp 0`，即**完全雾化**。夜档会看到 900 个玫瑰色的点，而不是星；而且加性混合会把它们叠成一层薄纱。

**修法**：`PointsMaterial({ ..., fog: false })`，并在 `stars.test.ts` 里断言 `(points.material as THREE.PointsMaterial).fog === false`。别只靠肉眼——WebGPU 路径下 `PointsNodeMaterial` 的雾分支我没有把握，正因为没把握才要显式关掉并钉住。

### M2　Task 5 会改掉参考档的海：这是对的方向，但计划没声明它要破坏恒等

**计划位置**：[计划 173 行](../plans/2026-11-08-day-night-sky.md)（端点由 `skyColorJs` 在 `dirY=0` 派生）+ 约束⑤（[计划 19 行](../plans/2026-11-08-day-night-sky.md)）。

**代码事实**：向阳端点的现值 = `HAZE = [1.0, 0.323, 0.102]`（`sea/material.ts:395-405`，`cssToLinear(HAZE_COLOR)`）；派生后 = `HAZE + glow·sunTint`，其中参考太阳 6.97° 相对水平方向 `cos=0.9926`，`0.9926^120 × 0.42 = 0.1727`：

```
派生端点 = [1.173, 0.457, 0.192]   vs   现值 [1.000, 0.323, 0.102]
         Δ = [+0.173, +0.134, +0.090]   （G +42% / B +88%）
```

背阳端点不变（确实等于 `awayHorizonLinear()`，`horizon.test.ts:96-100` 那句「derived in linear space」说的就是它）。

**这不是 bug，恰恰是 Review Focus 1 的病因**：`A-cruise-alt60.png` 里海天线之所以是一道「橙海 vs 暖白天」的**色相台阶**，就是因为天穹在地平线叠加了 glow、海面没有。Task 5 把它补上，是对症下药。

**但计划把它写成了「参考档恒等 + parity 必须 PASS」**（约束①，[计划 15 行](../plans/2026-11-08-day-night-sky.md)）。按现值/派生值的差，参考档的海面颜色**一定变**，而且变在离相机最远的窄带上。于是两种可能，都不好：

- 如果 parity 的 sea 指标是**整块中位数**（`baseline-content-anchored.json` 的 `L*med/C*med` 形态），一条几十像素高的窄带可能根本推不动中位 → **PASS 了，但画面变了**（门瞎）；
- 如果推得动 → 与「参考档恒等」的字面承诺冲突，得整体重定基线（见 M5）。

**修法**：在约束①里显式开一个例外，写成「参考档恒等**除海面向阳霾端点**：该端点按约束⑤改为 `skyColorJs` 派生（Δ≈+0.17 的 glow 项），属**有意修复**，基线随之更新」。同时把这条列进 Task 8 的目检项②——不然将来没人知道这一笔是有意的。

### M3　`seaHazeEndpoints` 缺 `includeDisc` 开关，el=0 时海面端点吃满 0.35 的日盘

**计划位置**：[计划 173 行](../plans/2026-11-08-day-night-sky.md) 的 `seaHazeEndpoints(state, sun, refSun, refP)`；[计划 134 行](../plans/2026-11-08-day-night-sky.md) 的 `skyColorJs(dir, sun, state, refSun, refP)` 签名——**没有 `includeDisc` 参数**。

**代码事实**：海面自身采样天空时传 `false`（`sea/material.ts:329`：`skyColorTsl(tsl, reflected, sunU, false)`）；穹顶传 `true`。而 `el=0` 时太阳正好嵌在地平线上，“正对太阳水平方位”这个方向与太阳的 `dot ≈ 1`，`smoothstep(cosHalf, 1, 1) = 1` → 日盘项满额（0° 档 `discGain 0.35`，[计划 78 行](../plans/2026-11-08-day-night-sky.md)）。

**后果**：0° 档海面端点 = `HAZE + glow + 0.35·sunTint`，而海面自身渲染**从不采样日盘**（`includeDisc=false`）。于是接缝在这一档**翻符号**：海比天更亮 0.35。这比现在的不匹配更难看。

**修法**：给 `skyColorJs` 加第 6 个参数 `includeDisc = true`（与 `skyColorTsl` 同名同义），`seaHazeEndpoints` 固定传 `false`，并在计划里写一句：「日盘是天空专属特征，海面端点只跟 glow」。若作者坚持要含盘（理由是「海上也能看到倒影」），那也要显式写，并接受 `el≈0` 那一瞬的水平亮斑。

### M4　夜档云只换方向不换色：`bandColor` 是写死的黄昏四色

**计划位置**：[计划 218 行](../plans/2026-11-08-day-night-sky.md)「云的向阳着色本来就跟随活太阳，**无需改码**」。

**代码事实**：`puff-cloud.ts:192-197` 的活太阳确实每帧灌进来了（`world.ts` 从灯位置反推，`puffs.update(time, sunDir)`），所以**方向**是活的 ✓。但颜色不是：`puff-cloud.ts:224-229` 的 `PUFF_BAND_COLORS` 是四个写死的十六进制档，混完之后再叠 `HAZE_COLOR` 的空气透视（`:233-235`）。太阳到 −8° 时，`lit` 的分档会整体翻到云的背面/底部，**但四档仍然是黄昏暖色**——结果是「深蓝天幕上一朵黄昏色的云」，而且 `HAZE_COLOR = #ff9a5a` 会把远云拉回橙色。

**后果**：计划把这条记为「已对账，无需改码」，等于把一个明显的夜档观感问题排除在验收之外；同时 [验收③](../plans/2026-11-08-day-night-sky.md)（夜档无全屏 bloom）没有任何一条测试或目检覆盖云——而云在夜档很可能就是画面里最亮的物体。

**修法**（二选一，别都做）：

1. **最小**：接受暖云，但在 Task 8 目检里加一项「夜档云不得比夜空亮过 X」，并给出实测值；
2. **正确**：把 `bandColorNode` 的四档色与 `HAZE_COLOR` 换成 `uniform`（与 Task 5 的海面端点同一手法），由轨道每帧灌入；轨道字段加 `cloudBands: [Vec3×4]` 与 `cloudHaze: Vec3`。工作量约等于 Task 5，可以并入同一 Task。

无论选哪个，把「无需改码」改成「方向已活、颜色未活」，并写明取舍。

### M5　parity 的工艺：重采即全表偏移，「1 LSB 重钉」在工具上不可执行

**计划位置**：约束①（[计划 15 行](../plans/2026-11-08-day-night-sky.md)）与 Task 8 Step 2（[计划 230 行](../plans/2026-11-08-day-night-sky.md)）。

**工具事实**（[audit.py:112-129](../../../artifacts/cloud-audit/audit.py)）：

```python
for old, new in zip(base["pairs"], data["pairs"]):
    for side in ("ref", "live"):
        for block in BLOCKS:
            for key, want in new[side][block].items():
                ok = abs(got - want) <= 1e-6 if numeric else got == want
```

三个问题，逐一：

1. **量纲错位**：`1e-6` 是浮点相等，而「1 个 LSB」是 8 bit 取整边界（≈0.4 个 L* 单位）。基线条目是 `C*med/L*med` 这类**聚合中位数**，不是逐像素量化值——所以「漂 1 LSB 可重定基线」这句话，在工具上既不能测、也不能局部改。**只要代码一改、PNG 一重采，全表都会偏移**，且偏移量不是整数 LSB。
2. **没有逐 pin 重钉的路径**：`parity()` 只读、不写；`--json` 写的是 `collect()` 的输出。计划 Step 2 说的「用 `--json` 的 pairs 段重组写入新基线」是**唯一可行**的路，但它等于**整份重生成**——那就不是「重钉个别 pin」，而是「关掉门再换一把新锁」。这两件事必须在计划里分开写，否则执行者会以为自己能外科手术。
3. **zip + 遍历新键 = 静默漏验**：若新测量少一个指标（例如 sea 块因为 `usable:false` 只剩 2 键），旧 pin 被**跳过**而不是失败；若 `states.py` 里删了一个 pair，`zip` 直接截断；若新增 pair，也截断。Task 8 恰好要**加三个夜间 pair**，加完 parity 仍只比前 3 个——新 pair 永远不进闸门。这不是理论风险，是这版 `parity()` 的确定行为。

**修法**（按顺序）：

1. `parity()` 改成**按 `pair` 名匹配**，并先断言 `len(base["pairs"]) == len(data["pairs"])` 与键集合相等，少一个就报错；
2. 阈值换成**可解释的量纲**：`|ΔL*| ≤ 0.5`、`|ΔC*| ≤ 0.5`（或直接换成 `max_abs_diff` 像素差），不要再拿 `1e-6` 当「LSB」；
3. **重定基线要有 before/after 对照**：在重采之前先把当前 4 个状态存成 `protocol/before-daysky-*.png`，之后用 `compare_repeats.py` 同款脚本跑一次 `max channel Δ`——仓库已有 `A-cruise-alt60.before-palette.png` 的先例，照抄即可。这才是「参考档恒等」的真门（见 M6）。

### M6　「参考档恒等」目前没有任何一条像素级证据

[计划 137 行](../plans/2026-11-08-day-night-sky.md) 的恒等测试是「**JS 镜像 vs 用同一批 helper 重建的旧公式**」。它只能证明「两个 JS 函数长得像」，证明不了「GPU 前后输出一样」：`rampColorJs` 与 TSL 的 `smoothstep` 链是两份代码，`applySkyTrack` 写入的 uniform 与重建脚本之间还隔着一层。再加上 M5（parity 重采即失效），**「参考档恒等」这条最强的承诺，实际是零覆盖**。

**修法**：Task 3 结束时加一步（不新增依赖，沿用采集协议）：冻结帧拍 `before`/`after` 各一张，跑 `max channel Δ`，阈值 ≤ 1；Δ>1 时把差异区域打印成 mask 存档。这一条比任何源码 pin 都值钱。

### M7　星点亮度余量只有 3%，而断言的是「色值」不是「合成后是否越阈」

`#dfe6ff` 的线性 Rec709 = `0.2126·0.738 + 0.7152·0.791 + 0.0722·1.0 ≈ 0.795`，距 0.82 只有 4% 余量（[计划 189/191 行](../plans/2026-11-08-day-night-sky.md) 要求「< 0.82」，可过）。但星点是 `AdditiveBlending`：**两个点重叠就是 1.59**，900 个 1.6px 的点撒在半球上，重叠几乎必然发生；再叠上夜天空（≈0.03）与 diaphanous 的 MSAA 边缘，越阈的不是「单点色值」而是「屏幕上的像素」。

**修法**：断言改成「雨点核在夜天空上的**合成亮度** < 阈值 × 1.05」（用 JS 镜像加一个星点贡献项），或直接把星色压到 ≈0.55（`#b9c6ff` 一档）并把 `size` 提到 1.8–2.0 补回感知亮度。后者的好处：余量足够，且看起来更像星（更小更密）。

---

## 四、注意项（不阻断，但会被实现者踩到）

| # | 位置 | 事实 / 风险 | 建议 |
|---|---|---|---|
| T1 | [计划 121 行](../plans/2026-11-08-day-night-sky.md) | 只给 `antiSolarCool` 加了 `opts`，但 `horizonGlow(sunDot)`（[horizon.ts:88](../../../src/horizon.ts)）里也烘死了 `GLOW_POW/GLOW_GAIN`，`sunDisc` 的 gain 在调用处 | `horizonGlow` 同样加 `opts?: {pow, gain}`，默认取 `HORIZON`，`horizon.test.ts:62-68` 的 FWHM 断言不受影响 |
| T2 | [计划 171–172 行](../plans/2026-11-08-day-night-sky.md) | `seaHazeTargetLinear` 在 `src` 里**只有测试在调**，加可选端点不会驱动运行时；真正要动的是 `seaHazeTsl` 的 4 份 ring 材质。另注意：`sunU = uniform(opts.sunDirection)`（[material.ts:282](../../../src/sea/material.ts)）今天**不是**靠每帧原地改数组工作的——`lights.setSunDirection` 是 copy 出去（[lights.ts:30](../../../src/lights.ts)），`world.ts:201-202` 归一化的是另一个局部向量。海面太阳之所以正确，只因为太阳从不移动 | 在 `initSea` 里建**一次**两个数组，作为 opts 传给 4 次 `buildSeaMaterial`（与 `sunU` 同一传参位置），`setHazeTargets` 原地写数组 → 4 个 ring 同时生效，不必遍历 4 份 uniform；并且必须**真的每帧写**，别复制 `sunU` 那个「靠太阳不动」的隐性假设 |
| T3 | 画面 | 海面 `material.fog = false`（[material.ts:433](../../../src/sea/material.ts)），远景全靠 `seaHazeTsl` 收敛；外环只到 1900 m（[rings.ts:25-30](../../../src/sea/rings.ts)），alt 60 时水线以下约 `atan(60/1900) ≈ 1.8°` 是穹顶露出的窄条 | 目检②「无横向色带」存在**几何残差**，不是端点能修的；把它写成「已知、非本次范围」，别让它冒充 Task 5 的失败 |
| T4 | [计划 218 行](../plans/2026-11-08-day-night-sky.md) | 去掉 `clampSunElevation` 后，`lights.ts:30` 的 `position = dir × 288.5` 在 −8° 时落到**地平线下方 40 m**，方向光从下往上打 | 灯的仰角单独钳 `≥ +2°`，强度交给轨道（`#304060 / 0.15`）；否则机身会出现莫名的底部冷边 |
| T5 | [计划 233 行](../plans/2026-11-08-day-night-sky.md) | 夜档 `hemi 0.12 + sun 0.15` 会让机身接近全黑；目检四项没有「飞机轮廓可辨」 | 加一项可读性目检（或给夜档 hemi 设下限），否则「夜航」会变成「一块黑」 |
| T6 | [计划 58 行](../plans/2026-11-08-day-night-sky.md) | `rampColorJs` 要镜像 `sky-webgpu.ts:74-79` 的**段内二次 smoothstep**（mix 因子是 `smoothstep(stops[i-1].at, stops[i].at, t)`）；写成线性插值，中段会漂 | Task 1 的断言（端点/锚点）抓不到，补一条「t=0.21 时按 smoothstep 公式」的中点断言 |
| T7 | [计划 225/232 行](../plans/2026-11-08-day-night-sky.md) | `color_sample.py` 的 `CASES` **已由 `states.py` 派生**（`color_sample.py:40-41`），只要改 `states.py`；另外 `warm_sky` 的过滤是 `hue 5..70 & s>0.10 & v>0.45`，夜档 navy 会返回 `None`（打印 `(no warm band)`） | 只改 `states.py`；夜档另加冷带/全天指标，否则 Step 4 的「夜档 sky L*/C*」拿不到数 |
| T8 | [计划 15 行](../plans/2026-11-08-day-night-sky.md) | 「`--parity` 现有 **4 状态** 必须 PASS」不准确：parity 只覆盖 3 个 ref pair（D-skim 无参考图，`states.py` 的 `pairs()` 就 3 条） | 改成「3 pair / 102 pin」，或在 `states.py` 给 D 补一张参考图（本次不做） |
| T9 | [计划 100 行](../plans/2026-11-08-day-night-sky.md) | `SkyMesh.js` 行号偏移：varyings 在 **152–154**（不是 156）、fbm 在 **307–336**（不是 280–379）；`:278` 还有 `+vec3(0,0.0003,0.00075)` 蓝底项，计划 100 行说「取 (Lin+L0)×0.04」、103 行又说「比率会消掉常数」，两处口径要统一 | 统一为「移植时保留该常数，比率里它不严格消掉（影响 <0.1%，可接受），但在注释里写明」 |
| T10 | [计划 62 行](../plans/2026-11-08-day-night-sky.md) | `SUN_TINT_LINEAR = [1,0.78,0.52]` 是**乘子**不是颜色，不能按约束⑨去 sRGB 解码 | 在计划里点名，并在变量注释写「multiplier, already linear」 |
| T11 | [计划 200 行](../plans/2026-11-08-day-night-sky.md) | `veilTintCss`（[in-cloud.ts:53-66](../../../src/in-cloud.ts)）在 **sRGB 字节空间**插值并做 1/64 量化；轨道里的 `veilCool/veilWarm` 是线性 Vec3，直接灌进去会偏亮 | 注入前线性→sRGB 回转（或轨道直接存 CSS 字符串给 DOM 用），并把夜档非有限回退色 `#e7d7cf` 一起换成轨道值 |
| T12 | [计划 89 行](../plans/2026-11-08-day-night-sky.md) | `hazeLinear/awayEdgeLinear` 在 Task 1 是 authored 字段、Task 5 变成「遗留字段」；两处形态并存容易被后来者当成真值 | 在接口注释里写死「Task 5 后运行时不用，仅作参考档恒等的锚」 |

---

## 五、最小修改清单（按 Task 顺序，可直接改计划）

1. **约束①**：加例外「海面向阳霾端点按约束⑤派生，Δ≈+0.17，属有意修复」；把「4 状态」改「3 pair / 102 pin」；把「1 LSB 重钉」改成「整份重生成 + before/after 像素对照」（M2/M5/T8）。
2. **约束⑥ / Task 4**：预算拆「非盘区峰值 < 0.82」+「盘区上界 ≤ 1.10」，采样走 `includeDisc=false` 或剔除 ±2.5° 锥（B3）。
3. **Task 2**：③ 的断言按 B1 的结论改写（或接受「−4° ≡ −8°」）；明确「`vSunE` 在 −2.3° 以下恒 0」这一事实写进 Interfaces（B1）。
4. **Task 3**：合成式把 `sunTint·(glow+disc)` 移到 `E` 外（或明确「夜档无 afterglow」并删断言）；恒等测试改用 `mix(base, AWAY_COLOR, antiSolarCool(...,opts))`（B1/B2）；加一步 before/after 像素门（M6）。
5. **Task 5**：`skyColorJs` 加 `includeDisc`，`seaHazeEndpoints` 传 `false`（M3）；海面端点建一次、4 ring 共享（T2）。
6. **Task 6**：`far-field` 改多对象 + 更新 `far-field.test.ts:27`（B4）；`fog: false` 并钉住（M1）；星点亮度断言改「合成后」（M7）。
7. **Task 7**：灯的仰角钳 `≥ +2°`（T4）；`horizonGlow` 也加 opts（T1）；`veilTintCss` 的色空间回转（T11）。
8. **Task 8**：`parity()` 按名匹配 + 断言 pair/键数量 + 换量纲（M5）；`states.py` 加夜档（`color_sample.py` 不用改，T7）；云加一项亮度目检（M4）。

---

## 六、计划做对的地方（不要在这几条上返工）

- **参考档恒等**作为第一约束、并且**从调色板 import 而不是抄数字**（约束②）——这个仓库历史上所有「两份常数」的翻车都死在这条上。
- **TSL 图 + JS 镜像双写**，并把签名 pin 在 `sea/material.test.ts:90`——海面是第二个消费者，这条 pin 是唯一能防止海天分叉的机制。
- **`applySkyTrack` 用模块级单例 uniform**（[计划 123 行](../plans/2026-11-08-day-night-sky.md)）——这是让穹顶与海面读到同一组值的唯一干净解法，理由写得很清楚。
- **保留 `includeDisc` 参数**、海面继续传 `false`——说明作者知道日盘是天空专属特征（可惜 Task 5 自己忘了，见 M3）。
- **`?qa=frozen` 采集协议已经在跑**，Task 8 引用它对得上（`main.ts:286-298` 的 `frozen`/`step(count,dt)`/`stepFrame`），不是空头承诺。
- **明确不做**一节把 `scene.background`/`scene.fog` 的夜档残留写成已知项，比假装解决要诚实。

---

## 七、验收建议（如果只改一处）

**先做 M6 的 before/after 像素门，再做任何 Task。** 理由：B1 会改掉 `day` 的合成顺序、B2 会改掉恒等测试的重建式、M2 会改掉海面端点——这三件事都动「参考档长什么样」，而当前的验收体系里**没有任何一条能证明它没变**（M5）。门先立起来，后面的每一步才是可回滚的。

```bash
# 门（沿用既有协议，不新增依赖）
npx tsc --noEmit && npx vitest run
python artifacts/cloud-audit/protocol/compare_repeats.py          # 复现性
# 新增：before/after 同帧 max-channel Δ ≤ 1，差异 mask 存盘
```

---

**审核人结论**：计划可以继续，但 **B1–B4 必须在开工前改掉**。其中 B1 是设计层的（会决定夜档到底长什么样），B2/B3/B4 是执行层的（照写一定失败或假绿）。改完这四条，这份计划的骨架就配得上它自己的约束表了。

---

## 八、勘误（2026-11-08 元核查，独立复算后回填）

对本报告 B1–B4 / M1–M7 / T1–T12 中的 19 条事实断言做了第二轮独立代码对照与数值复算（5 路并行核查，复算脚本按 `SkyMesh.js` 真实数学重建）：**16 条属实、3 条部分属实**（B1、T9、T11）。四条阻断的结论全部维持，但下列 5 处本文自身有误，执行时以本节为准；计划正文已按本文修法 + 本节勘误同步修订。

1. **B1 的子论据「计划 107 行 ③ 必然失败（−4° 与 −8° 的 P 完全相同）」有误。** 两档 vSunE 同为 0，但各档 preetham 参数不同（−4°：turb 3.5/ray 3.5/mie 0.006；−8°：4/4/0.004），消光 Fex 随之不同：P(−4°)≈1.44e−6 > P(−8°)≈6.12e−7（Rec709 口径，地平线向阳方向）。按 P 与按 E 两个口径的严格不等式都成立，**Task 2 ③ 会通过，不要改弱它**。B1 的结构性结论不受影响：直射项被 E 闸死属实（−4° 档 glow 贡献 ≈1.2e−8，8bit 一步长的约三百万分之一），138 行 afterglow 断言在 nightWeight=1 下恒假也属实。
2. **B1 的论据「vSunE=0 时向阳与背阳的 E 逐位相同」不准确。** 逐位相同的是分子 P（vSunE=0 时只剩 0.1·Fex×0.04，只依赖视线天顶角）；E 还依赖分母（参考档 Lin 含方位项的相位函数），实测 −4° 地平线背阳方向的 E 约为向阳的 105 倍。不影响结论：nightWeight=1 时整个 day 支路被丢弃。
3. **T9 的行号「纠错」本身错了两处。** fbm 云块实际在 `SkyMesh.js:280–379`（fbm 函数 307–323、云合成块 326–379）——**计划原文「剥离 280–379」是对的**，按本文的「307–336」剥离会留下 337–379 的死代码；varyings 实际在 151–154（本文写 152–154 漏了 151，且计划 100 行的「156–278」指数学主体范围、并未声称 varyings 在 156）。278 行蓝底常数属实；参考档 E 仍严格 =1（同函数同输入相除），但**非参考档暗区（P<0.05）蓝通道比值偏置可达 1%–15%**，比本文「<0.1%」的估计大——仍可接受，实现注释写明即可。
4. **T11 的方向说反了。** 线性 Vec3 直灌 `veilTintCss` 的 sRGB 字节插值器：×255 缩放后灌入约偏暗 48/255，不缩放直接灌会被 `Math.floor` 截成全黑——是**偏暗/全黑**，不是「偏亮」。修法不变（注入前线性转 sRGB 回转，或轨道存 CSS 字符串给 DOM）。
5. **M2 括号里的 sea 指标形态写错。** `baseline-content-anchored.json` 的 sea 块六键是 `usable / horizon_frac / sparkle_rel / sunroad_ratio / value_mean / rows`（整块聚合），`L*med/C*med` 在 tone 块。结论反而更硬：parity 阈值是 1e-6 精确相等，端点一变 sea 块必 FAIL，不存在「窄带推不动中位数」的假绿路径。另：M7 的余量实测 3.2%（0.795 对 0.82），本文标题 3% 与正文 4% 不一致，取 3.2%；B3 的盘权重实测 0.86（本文写 0.77），误差方向反而加重越阈。
