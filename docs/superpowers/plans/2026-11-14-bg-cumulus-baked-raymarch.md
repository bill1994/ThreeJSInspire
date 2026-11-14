# 背景云替换为 cubemap 烘焙 raymarch（painted-valley 移植）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把背景远云从「软边矩形面片环」（bg-cloud.ts）换成 painted-valley 式的 cubemap 烘焙 raymarch 积云：大而稀、有真体积剪影，太阳（及其反相月亮）移动时云色与受光方向联动，并按有限半径重投影保留视差。

**Architecture:** 每朵云是球堆 SDF（平底积云 + billow 3D 噪声推面），一个 TSL 光线步进 pass 把全部云烘进一张 cubemap（每帧限速烘 1–8 条带，太阳静止时停烘），天空 shader 按有限半径球壳重投影采样；云合成插在天空色/月盘之后、toon 量化之前。色彩吃现有 `cloudBands/cloudHaze` 单源。

**Tech Stack:** Three.js r186 WebGPURenderer + TSL（动态 import）、Data3DTexture（billow 噪声 32³）、CubeRenderTarget（或 2D atlas 回退，Task 0 裁决）、Vitest（纯函数层 fail-first）。

**Spec:** 参考实现 `G:\DSHProject\refs\painted-valley\src\valley\clouds.js`（本文「参考 clouds.js:NNN」指它）+ 本文 §设计裁定（形状/尺度/联动的决定都在这里钉死，没有独立设计稿）。

**与主 spec 的关系（取代声明）:** 本计划**取代** `docs/superpowers/specs/2026-11-13-painted-valley-style-alignment.md` §7 反面清单第 2 条（别抄小时级重烘云）与第 3 条（别抄 cubemap 云）对本层的适用性——理由：远处背景层语义本就是「不可达纯背景」（主人 2026-11-13 裁决，穿云仍由 puff/in-cloud.ts 承担，cubemap 不侵穿云层）；重烘禁令针对的是「小时级光照跳变闪变」，本方案用限速条带追平（§裁定 6）替代整图重烘，且实时日落轨道仍然单源直供颜色。Task 8 负责把这两条的取代注记写回 spec。

---

## 0. 现状事实（执行者必读）

1. **旧层与病根**：现 bg-cloud.ts 是 8–14 块 80–200 m 的软边矩形面片挂在 1300–1700 m 环上。主人 2026-11-14 目检裁定：太小、太密、billboard 太假；调参救不了「假」，按参考仓整体替换。**旧层调参已被本计划否决，不再是任何环节的回退选项。**
2. **参考仓常量是按它的尺度定的，不能照抄**（外审 2026-11-14 阻断项 1）：参考的 `t = (520 − ro.y)/rd.y` 里 520 是**参考仓自己的云底高度**（clouds.js:326），不是步进步数；`tEnd` 的 14500/56000（clouds.js:327）、霾长 46000（clouds.js:362）、110 步/max(d×0.5, 30 m)（clouds.js:334,340）同为 14 km 厚、56 km 远云场的遗产。搬到本计划 300–900 m 云底、3–7 km 距离带，这些值会整层切平/失霾/浪费步数——Task 1/3 的推导责任见 §裁定 4。
3. **太阳/月亮移动现状**（联动需求的事实基础）：`?tod=`/`?sun=` 定格接线（main.ts:196-198）；`?sunspin=deg/s` 匀速自转（默认 0，main.ts:456）；`qa.setTod(h)` 运行时杠杆（main.ts:565）；月亮恒为太阳反相位（time-of-day.ts:66 `moonDirectionFor`），期 2 将把 `todSpeed` 接成连续时间轴。云层必须支持「方向连续慢转」「离散跳变」「轨道色逐帧微变」三种光照变化（§裁定 6）。
4. **启动次序**（外审阻断项 4，main.ts 实测）：sky 在 211 行建、initWorld 在 214 行、`?bg=` 在 228 行才解析——按现状 sky 拿不到 world 的烘焙纹理。接线方案见 §裁定 7。
5. **渲染路径**：本仓 WebGPU-only（renderer.ts 拒绝非 WebGPU 后端），参考仓 WebGL2/GLSL3 **不能直搬**；src 根禁止静态 import `three/webgpu|three/tsl`（module-graph.test.ts），动态 `await import()` 是既定模式（sky-webgpu.ts:435-436）。TSL 无 out 参数——参考 map() 的两个 out（base/scale）要重组为返回值结构（§裁定 2）。
6. **共享出口**：`skyColorTsl`（sky-webgpu.ts:340）是天空与海面共用的上色出口，toon 量化在其内部收尾（:416）；海面调用钉在 sea/material.ts:366（`skyColorTsl(tsl, reflected, sunU, false)`）。云合成的插入点与海面隔离方案见 §裁定 9/10。
7. **本计划是主人点名的观感变更**：默认画面允许变（这正是目的），不适用「默认逐位不变」门；但 `?bg=0`（别名 `?dome=0`）关云路径的天空必须逐位等于无云基线，海面表现不受影响（§裁定 10）。
8. **本计划 v2 已吸收 2026-11-14 外审八条阻断项与全部接线缺口**；复核记录见文末 §外审复核段。

## 设计裁定（本次计划钉死的决定）

1. **视差语义（取代「无穷远背景」旧约定）**：cubemap 不再按无穷远采样，改为**有限半径球壳重投影**——采样时 `p = cameraPosition + viewDir × R`，`sampleDir = normalize(p)`，**R = 4500 m**（距离带 3–7 km 的中值）。效果：云随相机平移有位移、随高度变化仰角不同；世界固定语义不变；240 m 高度对公里级云无穿模问题（球壳只是采样数学，不是几何）。穿云仍由 puff/in-cloud.ts 承担，本层永远够不到（主人 2026-11-13 裁决不变）。
2. **形状移植（含 TSL 重组）**：球堆 SDF 平底积云——底座 + 若干 head 叠加（参考 clouds.js:118-190），billow 3D 噪声推面（clouds.js:23-111, 233-275），smin 融合，平面云底带微波（clouds.js:264）。**移植重组点**：参考 map() 的 `out base, out scale` 两个出参在 TSL 里改为 `bgMapTsl(p, fine) → vec3(d, base, scale)` 返回值；paint() 每像素 12+ 次 map 调用（8 法线 + 2 阴影 + 1 open + 1 终值）的调用结构原样保留。烘焙全程只有一次（限速条带摊薄），主画面零成本。
3. **尺度适配（直接回应「太小太密」，外审阻断项 5 重写）**：布局按**角宽**约束排布，不按中心方位间隔：
   - 云数 **7–9**（确定性 seed 散布，沿用 world.ts:216 的 seed 7）；
   - 2 朵巨塔宽 **6–9 km**（放在距离带**远半段** 5–7 km，压角宽）+ 5–7 朵中云宽 **1.5–3 km**，云底带 **300–900 m**，塔高 **400–1600 m**，距离带 **3–7 km**；
   - 间距规则：任意两云 **角隙 ≥ (角宽ᵢ + 角宽ⱼ)/2 + 10°**（角宽 = 2·atan(宽/2/距离)，布局函数内计算并断言）；
   - 覆盖双门：**最大空档 ≤ 45°**（任一朝向 ±22° 内至少 1 朵——「随便往哪个方向看都能看到几块」的主人原话）且 **总角覆盖 ≤ 70%**（留白，不是云毯）；
   - 取舍显式化：云底 300 m 抬高后，仰角 < ≈1.9° 的纯地平线带会空出来（旧层 y 下探 60 m 能盖到）。这是「大而稀」的必然代价，Task 6 矩阵目检裁决；若主人不接受，回退选项是把距离带上限拉到 9–10 km 让下缘角降到 ≈1.3°，**不是**回旧面片层。
4. **烘焙窗口重推（外审阻断项 1 的修复，全部从布局派生、禁止照抄参考数）**：
   - **Task 0 spike 结论（2026-11-14 实证，证据 `artifacts/bg-cumulus-spike/`）**：① CubeRenderTarget 逐面渲染可行（`setRenderTarget(crt, face)`，r186 three.webgpu）；② sampler3D（Data3DTexture HalfFloat+Repeat）在 TSL `texture3D` 采样可行；③ Loop/If/Var + vec3 返回值 Fn 经 compileAsync 编译可行；④ **rt.scissorTest / renderer.setScissor / renderer.setViewport 三条硬件裁剪路径在 WebGPU 后端全部被忽略**（三组截图证伪）——条带烘焙改用 **shader 侧 `Discard` 掩码 + `autoClear = false`**（实证：条带带外内容原样保留）；⑤ 立方图采样必须用 `cubeTexture(tex, dir)` 节点（`texture(tex, dir)` 会退化成只采一个面）；⑥ RT 内容相对 uv 存在 v 方向翻转，Task 3 用标定帧钉方向。RT 形态裁定：**cube**（atlas 不再需要）。
   - `uSlabStartY = minBase − 200`（Task 1 布局暴露 `minBase`/`maxDistance`；200 m 覆盖云底微波 + billow 下推余量）；
   - 步进起点 `t = (uSlabStartY − ro.y)/rd.y`（ro=(0,70,0) 与相机无关）；`rd.y < 0.002` 直接返回（防除零门，参考的 0.012 ≈ 0.7° 会吃掉 3–7 km 云的下缘视角，本带最近云下缘 ≈1.9°，门必须更低）；
   - `tEnd = maxDistance + 1000`（布局派生，不写 14500/56000）；
   - 步进预算重算：64 步起步、步长 `max(d×0.5, 30 m)`，推导依据（写进代码注释）：最近云 3 km、最小可辨特征 ≈ scale×0.5，64 步在该距离的分辨余量；Task 0 spike 验证 64 步在 1024² 下的剪影质量，不够再升（上限 96）；
   - 霾长重标：`1 − exp(−t/BG_HAZE_METRES)`，**BG_HAZE_METRES = 12000** 起步（7 km 处 ≈ 44% 霾混入，远景云沉进天色；矩阵目检裁决）。
5. **色彩单源映射**：`cloudBands[0]/[1]/[2]/[3]/cloudHaze` → 烘焙五色 `uUnder/uShade/uMid/uLit/uHaze`（bands[0]=背光底、bands[1]=背光顶、bands[2]=迎光底、bands[3]=迎光顶；world 现有 `setCloudPalette` 通道直供，main.ts:433 每帧已灌）。paint() 画师硬边上色移植（受光白 + smoothstep(0.55,0.6) 硬边 + 阴影侧冷调 + 云底深调，参考 clouds.js:279-310）；JS 镜像 `paintMixJs` 导出供测试钉值。**参考的 uLit 白天中性白不抄**（主 spec §7 第 4 条），颜色全部来自我们的轨道。
6. **烘焙调度（外审阻断项 3 的修复：限速追平，不是整图重烘）**：
   - 初始化 `drawAll()` 一次（首帧即有云，配 loading 门，之后此入口不再被运行时调用）；
   - 每帧纯函数 `bakeBudget(prevLightState, nextLightState) → strips: 0..8`，`strips = clamp(ceil(Δangle / 0.05°), 1, 8)`；lightState = {sunDir, paletteVersion} 任一变化即视为脏；
   - **静止停烘**：太阳不动、调色板不变 → 0 条带（uTime=0 本来就没有动画，没有理由永久跑 1/40）；
   - 连续慢转（sunspin 2°/s ≈ 0.033°/帧 → 1 条带/帧）与 qa.setTod 连扫、轨道色逐帧微变都走 1–8 条带追平，40 条带全场收敛 ≤ 8 帧；`?sunspin=30` 稳态 8 条带/帧（约 83 ms 一圈），帧时实测值记录进 Task 7，不得无界增长；
   - **单帧烘带数上限 8 是硬顶**，任何输入不得突破。
7. **接线顺序（外审阻断项 4 的修复）**：
   - `?bg=`/`?bgq=` 解析**上移到 main.ts 建 sky 之前**（resolveBgVisible 移到 ≈205 行前），结果作为参数传给 sky 与 world；
   - 云采样节点**永远编译**：`skyColorTsl` 新增可选尾参 `cloudNode = null`（§裁定 9），关云时绑 1×1 黑 cube + `uCloudOn = 0`——关/开是一个 uniform 翻转，**零重编译**；premultiplied 合成 `rgb = cloud.rgb + sky.rgb × (1 − a)`，a=0 时逐位不变；
   - main.ts 在 initWorld 之后显式 `skyTsl.setCloudTexture(world.cloudTexture)`（world 暴露 cloudTexture getter）；
   - `world.setBgVisible(v)` 内部改推 uniform（`uCloudOn`），不再走 mesh.visible；
   - `?bgq` 解析归 qa.ts（与 ?bg/?dome 同区块，qa.ts:30-67 模式），带 clamp 512..2048 与单测。
8. **月亮联动（Goal 不缩水）**：模块内部从 sunDir 派生月亮方向 = −sunDir（反相位恒成立，time-of-day.ts:66），不新增接口参数；烘焙光照方向 `L = normalize(sunDir × dayW + (−sunDir) × (1 − dayW))`，`dayW = smoothstep(−8°, 0°, 太阳仰角)`；颜色仍由轨道承担（夜档 bands 本身是暗调）。受光方向在日落→夜的过渡里连续翻转，无跳变。
9. **合成次序与数学（外审 B1，插在共享出口内、海面零接触）**：skyColorTsl 内部顺序改为 **天空日/夜混合 + 月盘 tint → 云 premultiplied 合成（`rgb = cloud.rgb + sky.rgb × (1 − a)`）→ toonQuantizeTsl（:416 原位）**——云画在月之后（云遮月成立）、量化之前（云软边和天空阶梯同拍）。月盘方向节点已在 skyColorTsl 签名里（:340 moonDirNode），云采样读同一 lightState 的方向，无双画。
10. **海面隔离**：云采样**只经 skyColorTsl 的可选 cloudNode 参数进入**；海面调用（sea/material.ts:366）**不传该参数** → 海面的节点图与今天逐字节一致（既有 pin 不动）。云进海面反射留作后续可选项，本期不做。
11. **未写入面保护**：只烘 5 面（底面永不烘）；天空侧 `sampleDir.y < 0` 时跳过云采样、直接落回天空渐变（Task 4 源码 pin 钉这一行，防采到底面空白）。
12. **显存上限**：`?bgq` 实际值 = min(请求值, 2048, device.limits.maxTextureDimension2D)；1024 cube RGBA16F ≈ 50 MB、2048 ≈ 201 MB，注释写明。
13. **billow 场预算（外审阻断项 8）**：billowField 降到 **32³**（shader 本来就在 q×2.7 / q×7.3 重采样同一张图补细节，参考 clouds.js:260），纯 JS 生成 ≈ 5M 内层运算（64³ 的 1/8）；**init 同步段预算 ≤ 150 ms**（Task 7 门）；不够质量的回退顺序：GPU compute 生成 → 预烘静态资源随包发，均在 Task 6 质量门不过时才启动。
14. **旧字段退场清单**：`headingRad` 全仓唯一消费者是旧 patch 朝向滑窗（bg-cloud.ts:524）——随旧层一起删（world.ts:31/168/225、main.ts:66/466-468/471、world.test.ts 对应钉）；`horizonCount` 语义改为「存活云朵数」（world.ts:58 注释 + world.test.ts:223 断言同步）；`FALLBACK_BANDS/FALLBACK_HAZE` 随旧文件删除（全仓仅 bg-cloud.ts 及其测试引用）。
15. **Task 0 回退语义（外审 C1 修正）**：spike 两条 RT 路径都不可行 → **撤案**：本计划归档 HISTORY、回到主人面前重开设计（候选方案届时另行提出）；**不回退到已被否决的旧层调参**。

## Global Constraints

- WebGPU-only；src 根禁止静态 import `three/webgpu|three/tsl`（module-graph.test.ts 扫描）；TSL 一律 init 内 `await import()`。
- 色彩单源：云色只吃 `sky-track.ts` 的 `cloudBands/cloudHaze`，禁旁路调色（layer-reduction 设计 §4）；参考仓的调色常量一个都不抄。
- 默认 seed 7（world.ts:216）不动；`?bg=0`/`?dome=0` 语义不变；不动 puff 层与海/月管线（海面经 §裁定 10 结构性隔离）。
- 收口门：`tsc --noEmit` 0 错、`vitest run` 全绿。

## Review Focus（规格没写但最可能咬人的五类输入）

1. **相机爬到 ALT_MAX 240 m**：期望「高低两处都仍看得到几朵」（云底 300 m 抬高后高机位下缘角变小，重点看低机位）。→ Task 6 矩阵高低两帧。
2. **`?sunspin=30` 稳态跑**：限速追平应收敛（全场重照 ≤ 8 帧一轮）、帧时长有界（8 条带/帧的实测成本进 Task 7，不得随时间漂移）。→ Task 3 bakeBudget 模拟 + Task 6 实跑 10 s。
3. **qa.setTod 离散跳变 / 复现导出重放**：大跳变后全场在 ≤ 8 帧内追平，期间不卡死单帧。→ Task 3 模拟测试用例。
4. **WebGPU 侧两个未证事实**：sampler3D（HalfFloat + Repeat）采样正确性；**RT 级 scissorTest 是否被 WebGPU 后端尊重**（40 帧条带调度整个压在它上面——r186 的 three/tsl 有 Loop/Break/Var/If、three.webgpu 有 CubeRenderTarget 与 activeCubeFace，但 scissor 通道未证）。→ Task 0 spike 第一优先验证项。
5. **月云同框 + 底面空白**：夜档月盘被云遮的合成是否成立；`sampleDir.y < 0` 保护是否真的挡住未写入面。→ Task 4 源码 pin + Task 6 夜档帧目检。

---

### Task 0: TSL/WebGPU 烘焙 spike（可证伪第一步，不过则撤案）

**Files:**
- Create: `artifacts/bg-cumulus-spike/probe.mjs`（独立探针，不进 src、不进 boot graph）
- Modify: 本文 §裁定 4/6（把 cube/atlas、scissor、64 步质量结论写进备注）

**Interfaces:**
- Produces: RT 形态结论（`cube` | `atlas`）+ scissor 可用性 + 步数质量结论，Task 3/4 依赖。

- [ ] **Step 1: 写探针**：WebGPURenderer + TSL 全屏三角形 fragment：`Loop` 64 步假 march + sampler3D 采样（billow 场先用随机 Uint16Array 占位），验证三件事——① CubeRenderTarget 逐面渲染（或 2D atlas 5 区块）可行；② **RT 级 scissorTest 在 WebGPU 后端被尊重**（半条带烘、读回另一半必须为空）——不尊重则 atlas 改用多 pass viewport 或整面重烘方案，结论照样记录；③ Var 重组的 `bgMapTsl → vec3` 返回值结构能编译。
- [ ] **Step 2: 跑探针并记录**：各路径可行性 + 读回像素证据存 `artifacts/bg-cumulus-spike/`。
- [ ] **Step 3: 裁决**：至少一条 RT 路径可行 → 结论写入本文；**两条都不可行 → 撤案**（本计划归档 HISTORY、向主人重开设计；不回退旧层调参——它已被裁定救不了「假」）。
- [ ] **Step 4: Commit**（探针产物 + 本文修订）。

### Task 1: 纯函数布局层 `src/bg-cumulus-layout.ts`

**Files:**
- Create: `src/bg-cumulus-layout.ts`
- Test: `src/bg-cumulus-layout.test.ts`

**Interfaces:**
- Produces（Task 3 消费）:
  - `layoutClouds(seed: number): CloudLayout[]`，`CloudLayout = { puffs: [x,y,z,r][]; base: number; scale: number; widthMetres: number; distanceMetres: number; azimuthDeg: number; bounds: {cx,cy,cz,r} }`
  - `layoutWindow(layout): { minBase: number; maxDistance: number }`（march 窗口派生，§裁定 4）
  - `billowField(size = 32): Uint16Array`（RGBA HalfFloat 3D 数据，参考 clouds.js:23-111 移植，六颗斑 + 三档 lumps + value 场公式不变，仅体积 32³）
  - 常量：`CLOUD_COUNT_RANGE = [7,9]`、`WIDTH_TOWER_RANGE = [6000,9000]`、`WIDTH_MID_RANGE = [1500,3000]`、`BASE_RANGE = [300,900]`、`HEIGHT_RANGE = [400,1600]`、`DIST_RANGE = [3000,7000]`、`MIN_ANGULAR_GAP_EXTRA_DEG = 10`、`MAX_EMPTY_ARC_DEG = 45`、`MAX_COVERAGE = 0.7`

- [ ] **Step 1: 写失败测试**：同 seed 恒等；数量 ∈ [7,9] 且恰 2 朵塔；**角隙断言**（每对云 gap ≥ (角宽ᵢ+角宽ⱼ)/2 + 10°，角宽按各自距离算）；**最大空档 ≤ 45°**；**总角覆盖 ≤ 70%**；宽度/高度/距离落带且塔在远半段；billow 场值域 [0,1] + 3 个固定 texel 数值 pin。
- [ ] **Step 2: 跑测试确认红**：`npx vitest run src/bg-cumulus-layout.test.ts` → FAIL。
- [ ] **Step 3: 实现**：heap/cumulus 按参考 clouds.js:118-190 移植（差异仅尺度带与方位散布求解器：先摆 2 塔于远半段，中云按角隙+空档双约束确定性求解，无解时收缩宽度重试，收敛判据进注释）。
- [ ] **Step 4: 跑测试确认绿 → Step 5: Commit** `feat(cloud): angular-constrained cumulus layout + billow field`。

### Task 2: 纯函数上色映射 `src/bg-cumulus-paint.ts`

**Files:**
- Create: `src/bg-cumulus-paint.ts`
- Test: `src/bg-cumulus-paint.test.ts`

**Interfaces:**
- Consumes: `Vec3`（sky-track 同款）。
- Produces（Task 3 消费）:
  - `mapPalette(bands: readonly Vec3[], haze: Vec3): { lit: Vec3; mid: Vec3; shade: Vec3; under: Vec3; haze: Vec3 }`（bands[3]→lit、[2]→mid、[1]→shade、[0]→under）
  - `lightBlend(sunDir: Vec3, sunElevDeg: number): { dir: Vec3; dayW: number }`（§裁定 8：moonDir = −sunDir 内部派生，dayW = smoothstep(−8°, 0°, sunElevDeg)）
  - `PAINT_CONSTANTS`（硬边 0.55/0.6、阴影探针 2.6/6.5×scale 等，参考 clouds.js:279-310 抄定值——只抄结构常数，颜色全来自轨道）
  - `paintMixJs(light: number, broad: number, up: number, open: number, colors: {lit,mid,shade,under,haze}): Vec3`（paint() 的 JS 镜像）

- [ ] **Step 1: 写失败测试**：映射恒等表 pin；`lightBlend` 三点 pin（正午 dayW=1 → dir=sunDir；el=−8° 以下 dayW=0 → dir=−sunDir；过渡带单调）；`paintMixJs` 硬边两侧落点断言；「无灰律」。
- [ ] **Step 2: 确认红 → Step 3: 实现 → Step 4: 确认绿 → Step 5: Commit** `feat(cloud): palette mapping + day/night light blend pure layer`。

### Task 3: GPU 模块 `src/bg-cumulus.ts` — 烘焙材质 + 限速调度

**Files:**
- Create: `src/bg-cumulus.ts`
- Test: `src/bg-cumulus.test.ts`（纯函数 + 源码 pin）

**Interfaces:**
- Consumes: Task 1 `layoutClouds/layoutWindow/billowField/常量`、Task 2 `mapPalette/lightBlend/paintMixJs/PAINT_CONSTANTS`、Task 0 RT/scissor/步数结论。
- Produces（Task 4/5 消费）:
  - `initBgCumulus(renderer: unknown, scene: Scene, opts: { seed: number; sunDir?: Vector3; quality?: number }): Promise<BgCumulusHandles>`
  - `BgCumulusHandles = { update(t: number, sunDir: Vector3): void; setLight(p: { bands: readonly Vec3[]; haze: Vec3 }): void; drawAll(): void; setCloudOn(on: boolean): void; setVisible(v: boolean): void; dispose(): void; readonly count: number; readonly texture: import('three').Texture }`——职责：`update` = 每帧泵（算 bakeBudget、烘 N 条带）；`setLight` = 调色板推送（paletteVersion 递增）；`drawAll` = 仅 init/loading 用；`setCloudOn` = uCloudOn uniform 翻转（?bg=0 与 setBgVisible 同一条路）。
  - 纯函数 `bakeBudget(prev: { azDeg: number; elDeg: number; paletteVersion: number }, next: 同构): number`（0..8，§裁定 6 公式）

- [ ] **Step 1: 写失败测试**：bakeBudget 五用例——全静止 → 0；0.033°/帧慢转 → 1；4° 跳变 → 8；跳变后连续帧模拟 40 条带 ≤ 8 帧收敛；paletteVersion 变化单独触发 ≥ 1。源码 pin：无静态 `three/webgpu|three/tsl` import、`STEPS = 64`、`BG_HAZE_METRES = 12000`、`MAX_STRIPS_PER_FRAME = 8`、`uSlabStartY` 由 `layoutWindow` 派生（禁止字面量 520/14500/56000/46000）。
- [ ] **Step 2: 确认红 → Step 3: 实现（拆两步提交）**：
  - **3a 单朵云**：TSL `bgMapTsl(p, fine) → vec3(d, base, scale)`（Var 重组 out 参数）+ `paintTsl(p, ...) → vec4`（premultiplied 输出，参考 clouds.js:218-310，billow/smin/基面微波/法线双探针/阴影双探针/open 全保留）；
  - **3b 场与步进**：全域 map（14 朵球包围盒 early-out 结构保留）+ 64 步 march + 二分细化 + 最近未命中描边（uTexel = 3/size）+ RT 按 Task 0 裁决 + 条带状态机（bakeBudget 驱动、静止停烘、init drawAll）。
- [ ] **Step 4: 确认绿 → Step 5: Commit** 两条：`feat(cloud): single-cumulus TSL map/paint`、`feat(cloud): budgeted strip bake scheduler`。

### Task 4: sky 消费接线 `src/sky-webgpu.ts`

**Files:**
- Modify: `src/sky-webgpu.ts:340,416,461`（skyColorTsl 增可选尾参 `cloudNode = null` 与 `cloudOn` uniform；合成插在月盘 tint 之后、toonQuantizeTsl 之前；`sampleDir.y < 0` 保护）
- Modify: `src/sky-webgpu.ts` handles（新增 `setCloudTexture(texture | null)`：null 绑 1×1 黑 cube + uCloudOn=0）
- Test: `src/sky-webgpu.test.ts`（源码 pin）

**Interfaces:**
- Consumes: Task 3 `BgCumulusHandles.texture`。
- Produces: `setCloudTexture` 句柄（main.ts 在 initWorld 后显式接线）。

- [ ] **Step 1: 写失败测试**：源码 pin——① 合成在 `toonQuantizeTsl(` 之前（正则序断言：cloud composite 行号 < quantize 行号）；② `sampleDir.y < 0` 早退保护存在；③ sea 调用路径不含 cloudNode（sea/material.ts:366 既有 pin 保持原样通过）。
- [ ] **Step 2: 确认红 → Step 3: 实现 → Step 4: 确认绿 → Step 5: Commit** `feat(cloud): sky composites baked cumulus before toon quantize`。

### Task 5: world 接线切换 + 旧层退场 + 启动次序修复

**Files:**
- Modify: `src/main.ts:211 前`（`?bg=`/`?bgq=` 解析上移，结果传给 sky init 与 initWorld）；`src/main.ts:220 附近`（initWorld 后 `skyTsl.setCloudTexture(world.cloudTexture)`）；`src/main.ts:66,466-468,471`（删 headingRad 派生与传参）
- Modify: `src/world.ts:211-219,302`（initBgCumulus 挂载、update 只传 sunDir、局部变量 domeHorizon → bgCumulus、暴露 `cloudTexture` getter、setBgVisible 改推 setCloudOn）；`src/world.ts:31,58,168,225`（删 headingRad、horizonCount 注释改「存活云朵数」）
- Modify: `src/qa.ts:30-67 区块`（新增 `parseBakeQuality(raw): 512|1024|2048`，clamp + 缺省 1024）
- Delete: `src/bg-cloud.ts`、`src/bg-cloud.test.ts`
- Modify: `src/world.test.ts`（旧 `domeHorizon?.xxx` 形状钉全部改 `bgCumulus?.xxx`——改名即天然红灯；headingRad 钉删除；horizonCount 断言改云朵数语义；新增 initBgCumulus/cloudTexture/setCloudOn 钉）

- [ ] **Step 1: 改 world.test.ts 钉**（新名 + 删 headingRad）→ **Step 2: 确认红**（旧 world.ts 命中不了新钉）。
- [ ] **Step 3: 执行切换**（world + main + qa + 删旧文件）。
- [ ] **Step 4: `npx tsc --noEmit` 0 错 + `npx vitest run` 全绿 → Step 5: Commit** `feat(cloud): swap patch ring for baked cumulus layer`。

### Task 6: 浏览器验收矩阵（抓帧门）

**Files:**
- Create: `artifacts/bg-cumulus/matrix/`（帧 PNG + sidecar JSON，契约沿用 docs/superpowers/plans/2026-10-31-capture-protocol.md）

- [ ] **Step 1: 七档静态**：`?tod ∈ {6,9,12,15,17.5,20,23}` 各一帧——六项目检：剪影可读（无硬边矩形残留）/ 留白（一块一块数得出来）/ 受光方向跟随太阳 / 云底平且带微波 / 无 stair 锯齿 / **远景云沉进天色**（霾长 12000 的目检裁决）。
- [ ] **Step 2: `?bg=0` 差分帧**：与无云基线逐位比对（uCloudOn=0 路径）。
- [ ] **Step 3: 联动实跑**：`?sunspin=2` 跑 60 s（受光侧跟随、帧时平稳）+ `?sunspin=30` 跑 10 s（限速 8 条带/帧生效、全场 ≤ 8 帧收敛、帧时记录）。
- [ ] **Step 4: 视差实跑**：`?pos=` 低空与 240 m 各一帧 + **平飞 1 km 前后两帧**——云在画面里位移量 > 0（有限半径重投影生效的直接证据）。
- [ ] **Step 5: 360° 自旋一圈**（`?sunspin` 转机位或 qa 驱动 yaw）——**立方图面缝/条带缝**目检：任意朝向无受光方向断裂（40 个烘焙时刻的拼盘在稳态慢转下应无可见缝）。
- [ ] **Step 6: 高低机位 + 夜档月云同框目检**（Review Focus 1/5）。
- [ ] **Step 7: 记录 PASS/FAIL 进本文进度段；FAIL 回对应 Task 修 → Step 8: Commit** `test(cloud): baked cumulus capture matrix`。

### Task 7: 性能门

- [ ] **Step 1: 同机同档对比**（frame-stats，swap 前后）：稳态（太阳静止）烘焙增量 **0**（停烘生效）；条带烘带帧（追平期）p95 增量 ≤ 2 ms/条带 × 当帧条带数且单帧总量 ≤ 12 ms；`?sunspin=30` 稳态 p95 记录且不随时间漂移；**init 同步段 ≤ 150 ms**（billow 32³ 预算）；主画面 draw calls 差 ≤ 2；全案 p50/p95 不劣于旧层基线。
- [ ] **Step 2: 数值记录进本文进度段 → Step 3: Commit** `test(cloud): bake cost gate`。

### Task 8: 文档收口

- [ ] **Step 1: INDEX.md 登记**（plans 表加本行，状态「已执行」+ 提交链）。
- [ ] **Step 2: specs/2026-11-13-painted-valley-style-alignment.md §7 反面清单第 2、3 条加取代注记**（注记内容 = 本计划头部「取代声明」原文；背景层适用性由有限半径重投影 + 限速追平 + 穿云归 puff 承接；第 4 条「别抄颜色」不受影响，本计划本来就只抄结构常数）。
- [ ] **Step 3: Commit** `docs(cloud): register baked cumulus layer, supersede anti-pattern items`。

## Self-Review

（v2 已自审：①外审八条阻断全部有归处——1→裁定 4/Task 1+3、2→裁定 1/Task 4、3→裁定 6/Task 3+6、4→裁定 7/Task 5、5→裁定 3/Task 1、6→裁定 8/Task 2+3、7→取代声明/Task 8、8→裁定 13/Task 7；②接线缺口七条——B1 合成数学→裁定 9、B2 海面→裁定 10、B3 底面→裁定 11、B4 ?bgq→裁定 7、B5 horizonCount→裁定 14、B6 headingRad→裁定 14、B7 显存→裁定 12；③签名自洽——setLight 带类型、texture 用 import('three') 类型、update/drawAll/setCloudOn 职责分离；④Task 0 回退语义改为撤案；⑤world.test 钉 reality 核过（domeHorizon 形状钉改名即红）；⑥矩阵补面缝/视差两项；⑦TSL 工作量按 3a/3b 拆分。）

## 外审复核段

- 2026-11-14 外审（主人提供）八条阻断 + 七条接线缺口 + 五条小问题，已逐条核实并吸收进 v2：spec 反面清单第 2/3 条原文核实（§7，行 285-289）；main.ts 启动次序核实（sky 211 / initWorld 214 / ?bg 228 / setBgVisible 236）；world.test.ts 钉形态核实（domeHorizon?.xxx，无 initBgCloud 钉）；sea/material.ts:366 共用出口核实；headingRad 消费者唯一性核实（仅 bg-cloud.ts:524）。一处勘误：外审所称「§6.2」实为 spec 的 §7 反面清单（条目位置与内容一致），取代声明按 §7 落。

## 进度段

（执行时在此追加：Task 完成记录、提交链、矩阵 PASS/FAIL、性能数值。）
