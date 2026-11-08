# 天空盒 / 太阳 / 海面联动审查与改进建议（2026-11-08）

**范围：** 仅天穹（sky dome）、太阳方向、海面对太阳/天空的映射（反射、光路、逆光浪峰、方位霾）。
**明确排除：** 云层。`world.update()` 里 puff 的太阳方向仍按既有约定从 `DirectionalLight` 派生，`game.ts` 白纱 tint 仍用启动快照，二者本次**未改、未验证、不讨论**。

**结论先行：** 联动失效不是"海面漏了一个 uniform"，而是**两处坐标系错误 + 太阳状态根本没有运行时入口**叠加的结果。已修复：天空球改用相机相对视线方向着色、球心改为全 3D 跟随相机、建立唯一 `SunState` 并让 sky / lights / 海面四条 ring 同时绑定与显式同步。测试 41 文件 / 342 用例全绿，`tsc`、`vite build`、`smoke` 均通过。

---

## 1. 根因

### 1.1 天穹把「被拖走的世界坐标」当成视线方向（致命）

修复前的 `src/sky-webgpu.ts`：

```ts
const dir = positionWorld.normalize();   // 方向 = 世界原点 → 球面片元
```

但 `src/far-field.ts` 每帧把半径 800 m 的天穹球心拖到相机 X/Z（`moveTo(sky, camX, camZ)`），Y 留在 0。于是球面片元的世界坐标约为：

```
positionWorld ≈ (camX + R·dx,  R·dy,  camZ + R·dz)      // (dx,dy,dz) = 真实视线方向，R = 800
```

归一化后的方向混进了 `camX/R`、`camZ/R` 两个**随飞行距离线性增长**的误差项。飞机沿 −Z  unbounded 飞行，`camZ/R` 很快超过 1，方向被彻底带偏。后果：

- 天空里的太阳盘（`cos(dir, sunDir)`）、光晕、方位冷却（anti-solar cool）、整条竖向 ramp **随相机位置漂移/旋转**；
- 海面 `sunU` 是纯世界方向 uniform（`sea/material.ts:287` 的 `viewDir` 同样是 `normalize(positionWorld − cameraPosition)`，与相机位置无关），**完全不动**。

这正是"太阳旋转时海面上的太阳映射仍停留在原位置"的成因：两边用的根本不是同一个方向基准。

### 1.2 太阳没有「活状态」，海面也没有接收口

修复前太阳是四份各自为政的事实：

| 消费者 | 太阳来源 | 更新时机 | 问题 |
|---|---|---|---|
| `main.ts` `liveSunDir` | `SUN_DIRECTION` / `?sun=az,el` | **仅启动时一次** | 之后没有任何入口能改它 |
| TSL 天穹 `sunDir` uniform | 每帧 `copy(liveSunDir)` | 每帧 | 独立副本，靠调用方不漏 |
| 海面 4 条 ring `sunU` | `initSea(..., sunDirLive)` **按引用捕获** | **建材质时一次** | `SeaOcean.update()` 连太阳参数都没有；无任何 setter，纯隐式别名 |
| puff 云 / 白纱 | 从 `DirectionalLight.position` 反推 / 启动快照 | 每帧 / 一次 | 第三条语义（本次不动） |

`?sun=az,el` 只是启动参数；运行时不存在"转太阳"这一动作。而海面唯一与天空的联系是初始化时那个**不可见的对象别名**——只要调用方替换向量对象、或未来把天空盒改成可旋转，海面必然停在原地。

### 1.3 天穹拖曳缺 Y，留下固定俯仰视差

仅拖 X/Z 时球心在 `(camX, 0, camZ)`，相机在 `(camX, camY, camZ)`。即便把着色改成 `positionWorld − cameraPosition`，仍残留约 `camY / R` 的垂直偏差：巡航 66.8 m ≈ **4.8°**，最高 240 m ≈ **17°**。天空地平线与海面反射的天空对不齐，接缝会显出一条色带。

---

## 2. 修复内容

| 文件 | 改动 |
|---|---|
| **`src/sun-state.ts`**（新） | 唯一太阳状态：`direction` 是一个**永不替换、只原地修改**的 `Vector3`；`setAzEl` / `rotateAzimuth` / `setDirection` / `subscribe` / `version`。three 的 `uniform(value)` 保留对象引用（`three/src/nodes/core/UniformNode.js:241`），所以所有绑定者天然同步。仰角沿用 `HORIZON.DUSK_BAND` 钳制，非法值一律拒绝，绝不把 NaN 灌进 shader。 |
| `src/sky-webgpu.ts` | `:147` 方向基准改为 `positionWorld.sub(cameraPosition).normalize()` —— 与海面 `viewDir` 同源；`initSunsetSkyTSL` 第三参接收共享太阳向量；`setSunDirection` 归一化后再 copy。 |
| `src/far-field.ts` | `:93` 天穹改为全 3D 跟随 `moveTo(sky, camX, camZ, eyeY)`；`update(camX, camZ, camY?)` 第三参可选，兼容旧两参调用与抓帧。 |
| `src/sea/material.ts` | `SeaOcean` 新增 `setSunDirection(dir)`（`:549`），一次更新 4 条 ring 的 `sunU`；`buildSeaMaterial` 把 `sunU` 随其它 uniform 一并返回。**保留** `skyColorTsl(tsl, reflected, sunU, false)` 等全部着色表达式不变（源码 tripwire 测试依赖）。 |
| `src/world.ts` | `WorldHandles.setSunDirection` 转发给海面；`:191`。云侧更新路径一行未动。 |
| `src/main.ts` | `:138` 用 `createSunState()` 取代裸 `Vector3`；`?sun=` 走 `setAzEl`；`:245` 抽出 `syncSun()`（`version` 脏检查，静止时零开销），一次把太阳推给 lights / sky / world(sea)；`:288` 全 3D tow；新增 QA 杠杆 `setSun(az,el)`、`rotateSun(deg)`、`getSun()`、`?sunspin=<deg/s>`；`describe()` 增加 `sun` 字段供抓帧 sidecar 复现。 |
| `src/qa.ts` | `parseSunSpin()`，缺省/非法/非正一律 0（默认画面不变），上限 360 deg/s。 |

**双保险设计：** sky 与 4 条 ring 的 uniform 直接绑定 `SunState.direction`（引用同步），`syncSun()` 再走一遍显式 copy（可测试、可换绑）。任一条路径单独存在都不会漂。

**新增回归测试：**
- `src/sun-state.test.ts`（8 项）：对象身份永不替换、az/el 往返、仰角钳制、旋转/订阅/version、非法值拒绝、快照隔离。
- `src/sky-sun-sea-linkage.test.ts`（8 项）：① **代数联动**——旋转太阳 90° 后，`horizonGlow`（天空光晕）从 >0.3 掉到 <0.01、`antiSolarCool`（天空/海霾共用）从 0 升到 >0.2、`roadMask`（海面光路闸门）从 1 掉到 0、镜面 glint 方向位移 >0.5；② **源码契约**——钉死视线方向基准、共享 uniform、`syncSun` 三路推送、`setSunDirection` 全 ring 更新、3D tow。
- `world.test.ts` / `far-field.test.ts` / `qa.test.ts` 各补对应契约。

---

## 3. 验证

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | 通过 |
| `npx vitest run --no-file-parallelism` | **41 文件 / 342 用例全绿，0 error**（稳定复现） |
| `npm run build` | 通过（56 modules；>500 kB chunk 警告是既有，非本次引入） |
| `node scripts/smoke.mjs` | `smoke ok` |

> 本机 vitest 默认并行收集时偶发 `EPERM ... AppData/Local/Temp/.../ssr/` 临时目录权限报错（环境沙箱的 brokered-fs shim），会少收集部分测试文件，数字在 295–342 间波动但**从未出现失败用例**。加 `--no-file-parallelism` 可稳定拿到 41 文件 / 342 全绿 / 0 error。与代码无关，非本次改动引入。

### 浏览器端复跑步骤（建议补一次目检）

```
?qa=frozen&sun=0,8            // 固定姿态、太阳在 -Z
__porco.qa.step(1)
__porco.qa.setSun(90, 8)      // 运行时转 90°；或改用 ?sunspin=30 匀速转
__porco.qa.step(1)
__porco.qa.describe()         // sun.azimuthDeg / direction / version
```

**验收门：**
1. 天空太阳盘/光晕与海面 sun road 同时转到新方位，二者方位角差 < `SUN_ROAD.WIDTH_DEG`（25°）；
2. `?sunspin=30` 连续两帧，水面光路的中心方位随太阳同步移动，不滞后、不留在 −Z；
3. 飞行远离原点（`?pos=...` 或自然飞 30 s）后，天空太阳不再因球心被拖走而漂移；
4. 地平线无新增横向色带（3D tow 消除了俯仰视差）。

本环境无浏览器自动化，**未做实机抓帧**；GPU 端一致性由代数测试 + 源码契约钉住，上述四门需人工目检确认。

---

## 4. 现有天空盒实现评估

**现状：** 单个 TSL `MeshBasicNodeMaterial` 背面球（`SphereGeometry(800,32,20)`），`skyColorTsl()` 是「4 段高度 ramp + 方位冷却 + `pow(cos,120)` 光晕 + 2° 角阈值太阳盘」，`horizon.ts` 保存同式的 JS 镜像；同一个函数被天穹与 4 条海面 ring 的反射直接调用。

**值得保留的优点：**
- **零资源、单函数同源**：`sea/material.ts:336` 的 `skyColorTsl(tsl, reflected, sunU, false)` 与天穹字面同一个函数——"海反射的就是天"在结构上成立，这是本项目最对的一个决定，别为了上物理模型丢掉。
- 调色单源（`SKY_STOPS` / `HAZE_COLOR`），参数化、可运行时改太阳方向。
- 风格化紫橙晚霞，不背物理模型在低仰角的包袱（见 §5）。

**可优化空间（按性价比排序）：**

1. **每像素 ALU 重复（最大热点）。** `skyColorTsl` 每帧被天穹（整屏）+ 海面（下半屏）各跑一次 ≈ 1.5 屏；720×1280 竖屏约 **1.4 M 次/帧**。每次含 3 个 ramp `smoothstep`、4 段 `mix`、2 次 XZ 归一化、`pow(away,1.2)`、`pow(cos,120)`（`exp(120·log x)`，很贵）、disc `smoothstep`。60 fps 下是移动端的主要 ALU 负担。**LUT 化可换成一次双线性采样。**
2. **几何 + tow 是自找的坐标陷阱。** 手工球 + `far-field` 每帧矩阵更新，正是 §1.1/§1.3 两个 bug 的温床。three r186 自带的 `scene.backgroundNode` 已经用 `w = 0` 的顶点变换实现"无限远背景"：`node_modules/three/src/renderers/common/Background.js:110` 注释原文 *"by using a w component of 0, the skybox will not translate when the camera moves through the scene"*，并以 `normalWorldGeometry` 作为方向、支持 `backgroundRotation` 整体旋转。迁过去可直接删掉 mesh 与 sky tow。
3. **兜底渐变与天穹不同源。** `sunsetGradientTexture()` 是静态 canvas 竖向渐变，**不含任何太阳方位信息**；一旦 TSL dome 构建失败，画面退回一张与太阳无关的底图。建议由同一份 LUT 生成，或明确降级为纯色安全网（并在 boot label 标注）。
4. **`SUN_TINT` 是第二份颜色事实。** `sky-webgpu.ts:69` 的 `[1.0, 0.78, 0.52]` 是手写线性值，不在 `SKY_PALETTE` 内——`2026-10-31-sky-technical-note.md` 的 K2(c) 早就标了"未做"。且它是常量：太阳从 3° 升到 15° 时 tint 不变，物理上低太阳应更红。
5. **亮度预算靠手工标定。** 天空 glow/disc 与海面 `ROAD_CEILING` 是两套常量，`post.ts` 记录 bloom 余量只有 **0.063**；改任一侧都要重新扫一遍线性亮度表。
6. **没有 `scene.environment` / PMREM。** 机身与其它材质拿不到天空环境光，目前靠 `HemisphereLight` 顶替；若要让反射与天空严格同源，需要预过滤环境贴图。

---

## 5. 方案调研（含取舍）

| 方案 | 原理 | 对本项目 | 结论 |
|---|---|---|---|
| three 官方 `Sky` / `SkyMesh`（Preetham 解析模型） | turbidity / rayleigh / mie / `sunPosition` uniform，O(1) 每像素 | 色调是"正午蓝天"，要做大量调色才能回到紫橙晚霞；且解析模型在低太阳仰角不可靠 | **不建议替换**，仅作参考 |
| Hosek-Wilkie | 更准确的解析天空 | 学术论文明确：模型只拟合地面观测、**太阳须在地平线上，不支持日出/日落**；另有低仰角绝对亮度反常的批评。本项目太阳被钳在 **3–15°**，正好落在它的失效区 | **排除** |
| Bruneton / Hillaire LUT 管线 | Transmittance / Multi-scatter / Sky-View LUT，compute 预积分，全屏 pass 一次双线性采样 | 工业级动态时间方案；`tsl-sky`（npm，three ≥0.184 / WebGPU，Hillaire EGSR 2020 移植）已实现，提供 `setSunDirection({elevation, azimuth})`、`sky.attach(scene)` 同时设 `environment` + `background`、aerial perspective | 若未来要写实时变化的写实天空，这是正解；但引入依赖、LUT 计算与全套重调色，**本期不做** |
| **共享 Sky LUT（推荐）** | 用 `horizon.ts` 已有的 JS 镜像（`horizonGlow` / `antiSolarCool` / `sunDisc`）把现有 `skyColorTsl` 烘成 2D 表：u = 相对太阳方位角、v = 仰角 | 保留现有艺术风格与"天空=反射"单源；天穹与海面都采样同一张表；太阳旋转只需改 u 采样偏移，`SunState.version` 变化时重绘 | **P1，性价比最高** |
| `scene.backgroundNode` | r186 内置无限远背景球（w=0，`normalWorldGeometry`，`backgroundRotation`） | 消灭 mesh / tow / 坐标系陷阱；旋转天空有官方 uniform | **P2 结构升级** |
| 官方 `webgpu_ocean.html` 惯例 | 同一 `sun` 向量同时写 `sky.sunPosition` 与 `water.sunDirection.value`；`PMREMGenerator.fromScene(sky)` 供反射 | 本次修复本质就是把这条行业惯例补齐 | 已对齐 |
| PMREM / `scene.environment` | 从天空生成预过滤环境贴图 | 让机身与水面反射同一份环境光 | P2 可选 |

**关键取舍：** 这个场景是**风格化低仰角日落**。解析物理模型（Preetham/Hosek）在 3–15° 恰是最不稳的区域，且会抹掉现有紫橙调色；而纯程序化 ramp 的痛点只是 ALU 与几何管理。因此合理路线是 **「保留 ramp 的艺术风格 → 烘成共享 LUT → 迁到 backgroundNode」**，而不是换模型。

### 资料

- three.js r186 源码：`node_modules/three/src/renderers/common/Background.js:91-131`（w=0 背景球、`normalWorldGeometry`、`backgroundRotation`）；`node_modules/three/src/nodes/core/UniformNode.js:241`（`uniform()` 保留引用）
- three.js 官方 ocean 示例（WebGL / WebGPU 双版）：同一太阳向量写 sky 与 water — https://threejs.org/examples/webgpu_ocean.html ｜ 教程拆解 https://www.shanebrumback.com/tutorials/water-shader-effects.html
- three.js `Sky` / `SkyMesh`（Preetham）：https://deepwiki.com/mrdoob/three.js/6.2-examples-and-documentation-ui
- `tsl-sky`（Hillaire 2020 的 three/WebGPU 移植）：https://www.npmjs.com/package/tsl-sky
- Frostbite, *Physically Based Sky, Atmosphere and Cloud Rendering*（LUT 管线）：https://media.contentapi.ea.com/content/dam/eacom/frostbite/files/s2016_pbs_frostbite_sky_clouds.pdf
- Bruneton/Preetham 预计算 LUT 综述：https://cstopics.com/encyclopedia/graphics/special-effects-rendering/water-and-atmospheric/atmospheric-scattering-bruneton-preetham ｜ Sky-View LUT 参数化：https://deepraster.com/articles/atmospheric-scattering-sky-rayleigh-mie-explained
- 8 种晴空模型定量评估（Hosek 的地平线/日落限制）：https://ar5iv.arxiv.org/html/1612.04336
- Hosek-Wilkie 低仰角亮度问题：https://timothykol.com/pub/sky.pdf ｜ 实现侧日落混合：https://www.othercomputer.com/blog/2021-02-20-haloray-3-0-0
- 仓库内既有依据：`docs/superpowers/plans/2026-10-31-sky-technical-note.md`（调色单源、bloom 余量 0.063、K2(c) 未做）

---

## 6. 改进建议与优先级

### P0 — 本次已完成
单一 `SunState`、视线方向基准、3D tow、显式版本化同步、QA 杠杆与回归测试。**这层不做好，后面任何天空实现都会继续和海面脱钩。**

### P1 — 低风险高收益（建议下一轮）
1. **共享 Sky LUT**：把 `skyColorTsl` 的 JS 镜像烘成 `256×64` RGBA16F（约 128 KB），u = 相对太阳方位、v = 仰角；天穹与海面 `reflected` 都从这张表采样。太阳旋转只改 u 偏移；`SunState.subscribe` 触发重绘。**验收**：`?sunspin=30` 时天空与水面太阳方位角同步，且帧 ALU/帧时间下降。
2. **`SUN_TINT` 单源化**：从 `SKY_PALETTE.sun` / `horizon` 派生，并随 `elevationDeg` 在两色间插值（低太阳更红）。注意重跑 `post.ts` 的线性亮度表，峰值必须仍 < bloom 阈值 0.82（现余量 0.063）。
3. **兜底渐变同源**：由同一 LUT 生成 canvas 渐变，或明确降级为纯色并在 boot label 写出"sky fallback"，避免"太阳转了、兜底没转"的新不一致。
4. **抓帧可复现**：`describe().sun` 已加；把 `qa.setSun` / `rotateSun` 写进 `docs/PORTRAIT_QA.md` 的联动用例。

### P2 — 结构升级（排期前先做 A/B）
1. **迁到 `scene.backgroundNode`**：`scene.backgroundNode = skyLutSample(normalWorldGeometry, sunU)`，删除 `sky_sunset_tsl` mesh 与 `far-field` 的 sky tow。**硬约束**：若用 `backgroundRotation` 旋转天空，必须由同一个 `SunState` 同步改 `sunDir`，否则又是一次"天空转、海面不转"。
2. **端到端 GPU 校验**：抓帧脚本同时测「天空太阳盘中心方位」与「海面 sun road 峰值方位」，断言角度差 < 25°，作为回归门。
3. **若未来转写实**：`tsl-sky` + `PMREMGenerator.fromScene(sky)`，但需重做调色、bloom 预算与海面 haze 契约（`HAZE_COLOR = SKY_PALETTE.horizon`）。

---

## 7. 遗留与边界

- 云路径未动：`world.update()` 里 puff 的太阳方向仍从 `DirectionalLight.position` 反推；由于灯的 setter 已接入 `SunState`，实际也会跟着转，但**本次未验证**。
- `game.ts` 白纱 tint 仍是 `initGame` 时的方向快照，运行时转太阳不会更新（云侧逻辑，按要求排除）。
- `scene.background` 的 canvas 兜底仍不含太阳方位，属降级路径，见 P1-3。
- 未做浏览器实机抓帧，§3 的四条验收门需人工目检。
- 本次未提交 git，改动均为工作区变更。
