# 云·海·太阳 改造计划 v2（按评审修正）

> **给执行者：** 这是 `2026-10-30-cloud-sea-sun-audit.md`（v1）的修正版，v1 已被本文取代。
> 执行前请先让用户确认 §0 的四个决策；§3 列的已完成项**不要重做**。
> 建议按任务顺序单任务提交，每个任务的验收步骤都是可跑的。

**Goal:** 让画面里的云/海/太阳达到 ref-01 的构图与配色，而不是把云渲成一团过曝的白噪。

**Architecture:** 先把渲染管线的动态范围修对（当前**没有任何色调映射**，中带 51.6% 像素截断在 250+），再谈任何颜色调整；然后把两层体积云合并成一个带塔形剖面的 slab，把光照从「视线方向」换成形状/深度；近景 puff 已按 ref-01 重做造型，散布另有专文。海最后动。

**Tech Stack:** three 0.186.0 + `three/webgpu`（WebGPURenderer）+ `three/tsl`，TSL node material 双后端同一套代码；vitest 2.1；Vite 6。

**Spec:** `docs/superpowers/specs/2026-10-30-porco-flight-sea-cloud-design.md`
**评审依据:** `docs/superpowers/reviews/2026-10-30-cloud-sea-sun-audit-review.md`（§7 / §8 / §9 是 v2 的主要输入）
**散布专文:** `docs/superpowers/plans/2026-10-30-puff-scatter.md`

---

## Global Constraints

- 双后端同一套 TSL：禁用 `onBeforeCompile`；`glslFn` / `wgslFn` 不可移植，不许用。
- 调色单源：改色只动 `src/palettes.ts`；`SEA.haze === SKY.horizon` 这条合约不许破。
- 天空 glow 的双份常数必须同步：`sky-webgpu.ts` 的 haze/disc 与 `horizon.ts` 的 `GLOW_POW` / `GLOW_GAIN`，海天线靠它对齐。
- 纯函数镜像约定：shader 里的常数要有一个 JS 纯函数镜像 + 单测（`horizon.ts` / `sun-road.ts` / `toon.ts` / `puff-cloud.ts` 都是这个写法）。
- 性能线：桌面优先 60 fps；手机能跑就行，降档只保可玩不保效果。
- 渲染目标为 `HalfFloat`（`post.ts`），任何 `pow()` 高次项都要当心半精度下溢。
- 每批门禁：`npx vitest run` → `node scripts/smoke.mjs` → 浏览器实拍对照。

---

## Review Focus

按 spec 隐含但 v1 任何任务都没测的输入/失效模式，最可能咬人的排前面。每条的测试写进拥有该代码的任务里。

1. **tone mapping 在 `RenderPipeline` 下的生效位置。** 场景渲进 HalfFloat RT，色调映射可能被跳过或位移；凭空写一行 `renderer.toneMapping = ...` 不能证明它生效。→ Task 1 的验收必须量像素，不能只看 API 调用。
2. **`?backend=webgl2` / `?post=0` 两条回退路径。** 加色调映射后，直出路径和 post 路径的观感可能分叉；`postSupported=false` 时走经典 WebGLRenderer，不吃 TSL。→ Task 1 要在这两条路径各量一次。
3. **低质量档。** `POST_LOW`（`dof:false`）、`CLOUD_STEPS_LOW = 8`、puff `setQuality(false)` 藏一半——三个降档都可能让某个不变量失效。→ Task 3 / Task 5 各加一条降档断言。
4. **云的竖直边界。** `y ± halfH` 相对海面（y=0）和云层底（95 m）的越界，在最大 scale 下最容易破。→ Task 5 的散布不变量（专文 §4 的第 3、4、9 条）。
5. **QA 开关。** `?alt=` / `?post=` / `?backend=` 是唯一能复现云层构图的入口，改完后它们必须仍然可用，否则后续所有验收都做不到。→ Task 1 的 Step 5/6 就是靠它们量的；§6 验证矩阵第 4 条再独立跑一遍。

---

## 0. 决策（2026-10-30 用户已拍板）

| # | 决策 | 结论 | 对任务的影响 |
|---|---|---|---|
| **D1** | 云型 bank / tower | ✅ **tower** | `PUFF_SHAPE.aspect` 1.45 → **≈1.95**（参考图中央云柱实测值）。Task 3 的 slab 顶界取 `480 m`；Task 3 / Task 5 的判据不变 |
| **D2** | 两个 slab 合并 / 保留两层 | ✅ **合并** | Task 3 按合并实施：单 slab + 塔形剖面，`CLOUD_BAND` 取代四个旧常数；`clouds-wisp` 从场景里消失 |
| **D3** | wisp `renderOrder` | ✅ **随 D2 消失** | 无需处理 |
| **D4** | 太阳 disk 砍掉 / 缩到 0.53° | ✅ **砍掉**，只留 haze | Task 2 里 disc 增益设 0，`sunDisc` 纯函数保留作为可回退的开关 |

> D1 推翻了 spec 里「不要擎天柱状云」那条旧拍板——以本次用户决定为准，spec 那行需要同步修订。


---

## 1. 与 v1 的差异（审完的修正清单）

| v1 的说法 | 实测/推导 | v2 |
|---|---|---|
| §3 太阳 disk 太大 → `pow 220 → 3200`，直径 ~0.7° | `pow 3200` 实际是 **2.39°**；要 0.53° 需 **≈64000**，而 64000 次幂在 HalfFloat 下**下溢成 0** | 改为角度阈值 `smoothstep(cosHalf, 1, dot)`，或直接砍 disc（D4） |
| §3「向阳 = 白屏」归因于 disk | disk 只占竖向 FOV 15%；真正的全场截断来自 **没有色调映射** + `haze` 项让 R 通道在离太阳 ~50° 内 > 1.0 | 新增 **Task 1**（全局前置），disk 降为 Task 2 |
| §3 附带改 `sky-sunset.ts` | **该文件已不存在**，`main.ts` 只走 `initSunsetSkyTSL` | 删掉这条过期引用 |
| §1 B3「加第三个 slab（95~480m）」 | 与主 slab 在 95–265 **重复积分**，alpha 冲顶；且 `heightMask` 是把 slab 归一化的 lens，385 m 上算出的密集体在 **195–334 m**，是一根悬空带，不是塔 | 改为**合并成一个 slab + 塔形剖面**（Task 3），剖面参数提到 `CloudSlabSpec` |
| §1「steps 8（可以便宜）」 | 385 m / 8 步，仰角 20° 时 `dt ≈ 99.7 m`，对 154 m 基频只有 **1.5 采样/特征**，比现在更糊 | 降步数必须同时关掉 `erodeFine` octave（Task 3 Step 5） |
| §2 海 | **六个常数全部核对无误**（400 m 域 / 0.34 m / 1600 m 贴图 / 280 段 / 0.14-0.56-0.88 / 2.2σ） | 保留，只补两处（Task 7） |
| §2 B4-1「振幅提到 0.7 m」 | 两个域各自归一到 0.7，合成 RMS = 0.99，**双计** | 改 `varianceSplit`（Task 7） |
| §2 B4-2 极坐标网格 | 与 `far-field.ts` 的 `snapToPeriod` 世界钉扎冲突；网格跟相机会让浪场跟着飞机走 | 明确 UV 用世界坐标（Task 7） |
| §4 云速/风向 | **三条实锤全部成立**（漂移 `(-1.54,+0.92)` m/s，海风 `(+0.82,-0.57)`，点积 −0.99） | **原样保留，不动**（§5） |
| §1「没有垂直发育机制」 | 部分对，但元凶是 `heightMask` 的 lens（有效云层只剩 139–200 m，61 m 厚） | Task 3 改剖面，不是加 slab |
| （缺）`clouds-wisp` 不跟相机 | 实机确认：`camZ -739.9` 时 `wispZ` 仍是 0，偏离 740 m | **已完成**（§3） |
| （缺）puff 是巡航画面的主导元素 | §8 逐层隔离：关掉 puff，那团占半屏的白色物体整块消失 | **已完成造型重做**（§3）；散布见专文 |

---

## 2. 实测基线（验收判据从这里来）

这些数字是 v2 全部验收的起点，改动后要拿同一套脚本重量。

| 指标 | 当前实测 | 脚本 |
|---|---|---|
| 中带 `≥250` 像素占比 | **51.6%** | `artifacts/cloud-audit/live/alt60-live1.png` + `compare_topband.py` |
| 上 30% 亮度级数 | **8**（旧 QA 图是 46） | 同上 |
| 上 30% `p95` | **252.7**（贴顶截断） | 同上 |
| 天空线性 R（正对太阳） | **1.42**（>1 = 截断） | 解析推导，见评审 §7.1 |
| alt=200 上 30% `p5–p95` 跨度 | **116**（无特征白板） | `live/alt200-a.png` |
| `clouds-wisp` 与世界原点偏离 | 已修复，全程 0 | 浏览器 `__porco` 钩子 |
| puff 世界半高 | 局部 38.3 / 2 = 19.15 m | `buildPuffGeometry` bbox |

抓帧注意（踩过的坑，别再踩）：
- 掐掉动画循环后单次 `render()` 得到的是**残帧**（HUD 读数自相矛盾、穹顶露三角面）。
- 必须让 rAF 正常跑，截图前 `await` 两三个 `requestAnimationFrame`；PNG 小于 ~150 KB 基本是残帧，丢掉重拍。
- 想固定机位就把 `__porco.game.update` 换成空函数，渲染循环照跑，得到的是**完整帧**。

---

## 3. 已完成，不要重做

| 项 | 位置 | 验证 |
|---|---|---|
| `clouds-wisp` 跟随相机 | `src/far-field.ts` `CLOUD_NAMES` + `findAll` | `far-field.test.ts` 6 条；实机飞到 `camZ -2665` 偏移仍为 0 |
| puff 造型按 ref-01 重做 | `src/puff-cloud.ts` `PUFF_SHAPE` / `puffBandIndex` / `bakeColor` | `puff-cloud.test.ts` 19 条；215 tests 全绿 |
| `vite.config.ts` 忽略 `artifacts/` | 否则拷截图会 `EBUSY` 打死 dev server | 手动 |

---

## 4. 任务

### Task 1: 给渲染管线加色调映射（全局前置）

**Files:**
- Modify: `src/renderer.ts`（`createRenderer`，两条返回路径都要设）
- Modify: `src/post.ts`（若色调映射要挂到 pipeline 末端）
- Test: `src/renderer.test.ts`（新建）

**Interfaces:**
- Produces: `export const TONE_MAPPING: { mode: 'aces' | 'neutral'; exposure: number }`，供 QA 脚本与 `__porco` 钩子读出。
- Produces: `applyToneMapping(renderer: unknown): void`，两条 renderer 分支都调用。

- [ ] **Step 1: 写失败测试** —— `renderer.test.ts` 断言 `TONE_MAPPING.exposure` 在 `(0.5, 1.5]` 且 `mode` 是两者之一；断言 `applyToneMapping` 对缺失 `toneMapping` 字段的对象不抛（防经典 WebGLRenderer 路径炸）。
- [ ] **Step 2: 跑测试确认失败** —— `npx vitest run src/renderer.test.ts`，期望 `TONE_MAPPING is not defined`。
- [ ] **Step 3: 实现** —— WebGPU 分支 `renderer.toneMapping = ACESFilmicToneMapping`（若观感偏灰改 `NeutralToneMapping`），`renderer.toneMappingExposure = TONE_MAPPING.exposure`；经典 WebGLRenderer 分支同样设置。**若 post 路径下不生效，把等效曲线挂到 `RenderPipeline` 的输出节点。**
- [ ] **Step 4: 跑测试确认通过** —— 同上命令。
- [ ] **Step 5: 量像素验收（这条才是真验收）** —— 起 dev server，`?alt=60` 抓帧，跑 `compare_topband.py`。**PASS = 中带 `≥250` 占比 < 5%，上 30% 亮度级数 ≥ 20。**
- [ ] **Step 6: 验回退路径** —— `?post=0` 与 `?backend=webgl2` 各抓一张，中带截断占比同样 < 5%。
- [ ] **Step 7: 提交** —— `git commit -m "feat(render): tone map the pipeline so the sky stops clipping"`

---

### Task 2: 天空 haze / 太阳 disc 复位

**Files:**
- Modify: `src/sky-webgpu.ts`（haze 增益、disc 项）
- Modify: `src/horizon.ts`（同步 `GLOW_POW` / `GLOW_GAIN`，合约要求）
- Test: `src/sky.test.ts` 或并入 `src/horizon.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `TONE_MAPPING`（曝光变了，增益要重配）。
- Produces: `export function sunDisc(dot: number, cosHalfAngle: number): number` —— 纯函数角度阈值，替代 `pow(cos, 220)`。
- Produces: `export const SKY_GLOW = { hazePow: number; hazeGain: number; discHalfAngleDeg: number }`，`horizon.ts` 读同一份。

- [ ] **Step 1: 写失败测试** —— 断言 `sunDisc(1, cosHalfAngle)` === 1；`sunDisc(cosHalfAngle*0.999, cosHalfAngle)` < 0.05；`sunDisc` 对非有限输入返回 0；断言 `SKY_GLOW.hazeGain` 与 `horizon.ts` 的 `GLOW_GAIN` 相等（**这条是合约，防止两份常数漂移**）。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现** —— disc 换成 `sunDisc`；按 D4 决定 disc 增益（砍掉则设 0 并保留常数）。haze 增益按实拍重配，初值 `0.42 → 0.22`。`horizon.ts` 抄同一份。
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 量像素验收** —— 判据是**性质**，不是一个固定窗口（`top30 p95 ∈ 225–245` 是 v2 初稿在「还没加色调映射」的基线上算的，Task 1 落地后已经过期）：
  - 没截断：上 30% 的 `≥252` 占比 **< 1%**（Task 2 实测 0.18%）；
  - 仍然亮：上 30% 的 `p95` **≥ 200**（实测 208.0，比砍盘前的 243.3 暗，但仍在地平线辉光该有的亮度上）；
  - 没有硬盘：截图里太阳是**渐变的辉光**，不是一块边界清楚的亮斑；
  - 海天交界无断带（`?alt=200` 与 `?alt=60` 各一张目检）。
- [ ] **Step 6: 提交**

---

### Task 3: 云层 slab 合并 + 塔形剖面

> 依赖 D1（bank/tower）与 D2（是否合并）。若 D2 选保留两层，本任务改为「给第三 slab 单独的高度剖面，并与主 slab 不重叠」，其余不变。

**Files:**
- Modify: `src/clouds-compute.ts`（`CloudSlabSpec` 加剖面字段；删除 `WISP_SLAB`；`createTslCloudMaterial` 的 `heightMask` 改为读 spec）
- Modify: `src/in-cloud.ts`（`WISP_DENSITY` 相关逻辑按合并后的单层重写）
- Modify: `src/far-field.ts`（合并后 `CLOUD_NAMES` 少一个名字）
- Test: `src/clouds.test.ts`、`src/in-cloud.test.ts`

**Interfaces:**
- Produces: `export interface CloudProfile { base: number; waist: number; topBias: number }` —— `heightMask` 的形状参数，替代硬编码的 `smoothstep(0.02,0.26) × (1 - smoothstep(0.62,1.0))`。
- Produces: `export function profileDensity(hFrac: number, p: CloudProfile): number` —— 纯函数镜像，TSL 侧读同一组数。
- Produces: `export const CLOUD_BAND = { bottom: number; top: number }`，取代 `CLOUD_BOTTOM` / `CLOUD_TOP` / `CLOUD_WISP_BOTTOM` / `CLOUD_WISP_TOP` 四常数。

- [ ] **Step 1: 写失败测试** —— `profileDensity`：`hFrac=0` 时 ≥ 0.85（云底满密度，塔形而非 lens）；`hFrac=1` 时 ≤ 0.05；单调性断言（底到腰不降、腰到顶不升）；非有限输入返回 0。另断言合并后场景里 `clouds-wisp` **不存在**、`clouds-volumetric` 恰好 1 个。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现** —— `heightMask` 改为 `profileDensity(hFrac, spec.profile)`；`CloudSlabSpec` 增 `profile` 字段；合并 slab 为单层（底 `DECK_BOTTOM` 之上、顶按 D1：bank 用 `95..300`，tower 用 `95..480`）。
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 加降档断言** —— `CLOUD_STEPS_LOW = 8` 时同样满足 `profileDensity` 的边界与单调性；同时**关掉 `erodeFine` octave**（低步数下它只会注入混叠）。
- [ ] **Step 6: 实拍验收** —— `?alt=200` 抓帧，量**上 30%** 的 `p5–p95` 跨度 **≥ 140**（当前 116）；云层出现可辨的垂直结构而不是一层薄饼。
- [ ] **Step 7: 提交**

---

### Task 4: 云的光照从「视线方向」换成形状/深度

**Files:**
- Modify: `src/clouds-compute.ts`（`lightAmt` 的计算）
- Test: `src/clouds.test.ts`

**Interfaces:**
- Produces: `export function cloudLighting(o: { accumTransmittance: number; stepIndex: number; steps: number; sunTight: number }): number`
- 语义：返回 0..1 的受光量，**必须是累积透过率与步序的函数**，不再是 `dot(viewRay, sunDir)` 的近邻。

- [ ] **Step 1: 写失败测试** —— 断言「越深越暗」：同一 `stepIndex` 下 `accumTransmittance` 越小 → 返回值越小（单调）；断言抖动：对 `steps ∈ {8, 12}` 同一输入返回相同值（步数无关性）；断言非有限输入返回 0。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现** —— 把 v1 的 `rimAmt = smoothstep(0.30,0.33, sunTight * edge)` 保持不变作为边缘光，但主体明暗换成 `cloudLighting` 的输出；band1/band2 阈值按 ref-01 的 4-6 阶重配。
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 实拍验收** —— 顶端出现**云与天空的对比**：`CLOUD_PALETTE.base` 与 `SKY_PALETTE.top` 的 `ΔL*` 需 **≥ 15**（当前 3.6–4.8，见评审 §1.3）。加一条 `palettes.test.ts` 的断言把这个约束钉住。
- [ ] **Step 6: 提交**

---

### Task 5: puff 散布（另见专文）

**Files:**
- Modify: `src/puff-cloud.ts`（`puffLayout` → `puffScatter`；`initPuffClouds` 先建模后散点）
- Test: `src/puff-cloud.test.ts`

详见 `docs/superpowers/plans/2026-10-30-puff-scatter.md`，那里的 9 条不变量就是本任务的验收。
**前置：** 云层底（Task 3 产的 `CLOUD_BAND.bottom`，即散布专文里的 `DECK_BOTTOM`）定下来之后才能动，否则高度带要重算。

- [ ] **Step 1: 按专文写 9 条不变量单测（红）**
- [ ] **Step 2: 实现 `puffScatter` 到绿**
- [ ] **Step 3: `initPuffClouds` 改为先建模取 bbox、再散点**
- [ ] **Step 4: 加降档断言** —— `setQuality(false)` 后（藏掉一半的云）**剩下那半仍然满足全部 9 条不变量**，尤其是不穿海、不顶穿、最小间距。
- [ ] **Step 5: 实拍验收** —— 视野内不超过 2 朵互相咬合；云底与海面之间始终有天空；有一片可辨的晴空缺口。
- [ ] **Step 6: 提交**

---

### Task 6: puff 的分档挪到片元着色（可选，视观感定）

**Files:**
- Modify: `src/puff-cloud.ts`（`MeshBasicNodeMaterial.colorNode` 用 TSL 算分档）
- Test: `src/puff-cloud.test.ts`（保留 `puffBandIndex` 作为 JS 镜像）

**背景：** 现在分档烘进顶点色，硬边界只能沿三角面拓扑走，近距离出多边形锯齿（`live/puff-v3-hero.png`）。

- [ ] **Step 1: 写失败测试** —— 断言 `puffBandIndex` 与 TSL 侧用的是同一组阈值（导出 `PUFF_BAND_THRESHOLDS` 供两边读）。
- [ ] **Step 2: 实现** —— 顶点色只保留 `shade` 抖动，分档在 `colorNode` 里按 `radial + normal` 算。
- [ ] **Step 3: 实拍验收** —— 近距离（相机距云面 < 40 m）无可见多边形色阶边界。
- [ ] **Step 4: 提交**

---

### Task 7: 海（最低优先级，可并行）

**Files:**
- Modify: `src/sea-fft.ts`（谱域归一化）、`src/sea.test.ts`

- [ ] **Step 1: 写失败测试** —— 两域合成后总 RMS 落在 `amplitude ± 10%`（钉住「不许双计」）；断言 UV 采样用世界坐标（反射/高光随 mesh 平移不变）。
- [ ] **Step 2: 实现** —— 加 `varianceSplit`，把目标 RMS 按方差拆分到长短波两域；网格跟随相机时 UV 用 `worldXZ / 400`。
- [ ] **Step 3: 跑测试确认通过**
- [ ] **Step 4: 实拍验收** —— 长涌浪排可辨；`HAZE_FAR` 处无断带；toon 带不被大浪顶穿。
- [ ] **Step 5: 提交**

---

## 5. 降级 / 不做

| 项 | 决定 | 理由 |
|---|---|---|
| 云漂移速度与风向（v1 §4） | **不动** | 三条实锤全部核对无误；实拍里看不出问题。别先动它 |
| 完整 Beckmann PBR 海面 | 不做 | 与 toon 美术冲突 |
| 雨/闪电/体积云 | 不做 | 范围爆炸 |
| GPU FFT ping-pong | 不做 | CPU FFT 可单测是现有优点 |
| `DOF`（`post.ts`） | 待定，默认**关掉** | `focalLength 420` + `bokehScale 1.1` 让 450 m 外 CoC 饱和到 1，实测模糊半径 **≤ 1.1 px**。64+16 tap 双 pass 换一个像素。要么把 `bokehScale` 提到 8–12 让它真工作，要么关掉省一个 pass（评审 §3.4） |

---

## 6. 验证矩阵（每个任务都跑）

1. `npx vitest run`（相关文件先单独跑，最后全量）
2. `node scripts/smoke.mjs`
3. 浏览器实拍：`?alt=60` 平飞 / `?alt=200` 云中 / 俯冲三个机位，用 `artifacts/cloud-audit/*.py` 量像素，不靠眼睛
4. 回退路径各一次：`?post=0`、`?backend=webgl2`
5. 降档各一次：`world.setQuality(false)` 或手机 UA 路径

**当前基线：215 tests 全绿。** 任何一步掉到红都不许往下走。
