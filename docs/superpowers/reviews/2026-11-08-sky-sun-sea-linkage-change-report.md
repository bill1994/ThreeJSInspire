# 更改报告 · 天空盒 / 太阳 / 海面联动（复查用）

**日期：** 2026-11-08 08:29 GMT+8
**状态：** **代码已直接修改在工作区，未提交 git、未推送、未打 tag。** 工作区可随时逐处核对或整体丢弃。
**范围：** 天穹、太阳方向、海面对太阳/天空的映射。**云层逻辑一行未改。**
**配套文档：** `docs/superpowers/reviews/2026-11-08-sky-sun-sea-linkage-review.md`（根因、方案调研、改进建议；本报告只讲「改了什么、怎么复查」）

---

## 0. 直接回答

**是，直接改了。** 你上一轮的要求包含"重点排查并修复联动问题"，当前是 Agent 模式（可编辑），所以我改完才交付。若你希望只出方案不动代码，告诉我，我可以把工作区还原后重出一份纯建议稿——现在还来得及，因为**没有提交**。

改动规模：

| | 数量 | 行数 |
|---|---|---|
| 修改既有文件 | 9 个 | **+216 / −51** |
| 新增文件 | 4 个（3 源码/测试 + 1 审查文档） | **+562** |
| 合计 | 13 个文件 | **+778 / −51** |

> 新增文件是 untracked，`git diff` 默认看不到，复核时别漏（见 §5.1）。

---

## 1. 变更总览（逐文件）

### 修改的既有文件（`git diff --numstat` 实测）

| 文件 | +/− | 改动摘要 | 复核重点 |
|---|---|---|---|
| `src/main.ts` | +73 / −31 | 组合根接线：唯一 `SunState`、`syncSun()` 脏检查、全 3D tow、`?sunspin`、QA 钩子、`describe().sun` | **太阳同步顺序**、首帧是否同步、QA 钩子 |
| `src/sky-webgpu.ts` | +33 / −7 | 视线方向基准、共享 uniform、setter 归一化 | **签名变更**（破坏性）、`cameraPosition` 用法 |
| `src/far-field.ts` | +20 / −8 | 天穹 tow 从 X/Z 扩到 X/Y/Z，第三参可选 | 球心 y 变化、`update` 兼容性 |
| `src/sea/material.ts` | +22 / −4 | `SeaOcean.setSunDirection()`，导出 `sunU` 供 4 条 ring 统一更新 | 着色表达式是否被误改 |
| `src/world.ts` | +9 / −0 | `WorldHandles.setSunDirection()` 转发海面 | 云侧 `puffs.update` 是否被动过（**没有**） |
| `src/qa.ts` | +14 / −0 | `parseSunSpin()` | 默认 0、上限 360 |
| `src/far-field.test.ts` | +17 / −0 | 3D tow 与两参兼容用例 | — |
| `src/qa.test.ts` | +17 / −1 | `parseSunSpin` 用例 | — |
| `src/world.test.ts` | +11 / −0 | setter 转发契约用例 | — |

### 新增文件

| 文件 | 行数 | 内容 |
|---|---|---|
| `src/sun-state.ts` | 148 | 唯一太阳状态：`direction`（永不替换的 Vector3）、`setAzEl` / `rotateAzimuth` / `setDirection` / `subscribe` / `version` / `snapshot` |
| `src/sun-state.test.ts` | 99 | 8 项：对象身份、az/el 往返、仰角钳制、旋转/订阅/version、非法值拒绝、快照隔离 |
| `src/sky-sun-sea-linkage.test.ts` | 139 | 8 项：① 代数联动（转 90° 后天空 glow 0.42→0、anti-solar cool 0→>0.2、海面 roadMask 1→0、glint 位移 >0.5）；② 源码契约（视线方向基准、共享 uniform、三路同步、全 ring 更新、3D tow） |
| `docs/.../2026-11-08-sky-sun-sea-linkage-review.md` | 176 | 根因 / 修复 / 验证 / 天空盒评估 / 方案调研 / P0–P2 建议 |

---

## 2. 逐文件改前 → 改后

### 2.1 `src/sky-webgpu.ts`（核心修复）

```diff
- const { positionWorld, uniform } = tsl;
- const dir = positionWorld.normalize();
- const sunDir = uniform(new THREE.Vector3(...SUN_DIRECTION));
+ const { positionWorld, cameraPosition, uniform } = tsl;
+ const dir = positionWorld.sub(cameraPosition).normalize();
+ const sunDir = uniform(sunDirection ?? new THREE.Vector3(...SUN_DIRECTION));
```

- `initSunsetSkyTSL(THREE, scene, radius = 800)` → **`initSunsetSkyTSL(THREE, scene, sunDirection?: Vector3, radius = 800)`**。⚠️ **这是破坏性签名变更**：第三参从 `radius: number` 变成 `sunDirection?: Vector3`，`radius` 挪到第四参。仓库内只有 `main.ts` 一处调用（已改），TypeScript 会拦住数字实参；但**外部 JS 脚本/浏览器 console 直接调旧签名会静默出错**，这是最值得你确认的一处。
- `setSunDirection`：`sunDir.value.copy(dir)` → `sunDir.value.copy(dir).normalize()`（防御非单位向量）。
- **`skyColorTsl()` 函数体一个字没改**——天穹与海面反射仍字面共用它。

### 2.2 `src/far-field.ts`

```diff
- update(camX: number, camZ: number): void;
+ update(camX: number, camZ: number, camY?: number): void;
- moveTo(sky, camX, camZ);
+ moveTo(sky, camX, camZ, eyeY);   // eyeY = 有限数 ? camY : 0
```

- 球心 y 从固定 **0** 变为**相机高度**，`positionWorld − cameraPosition` 才等于真实视线方向。
- 两参旧调用仍合法（y 默认为 0，行为与旧版一致），`far-field.test.ts` 里专门钉了这条。
- **puff 的 wrap/edgeFade 逻辑完全没动**，只用 camX/camZ。

### 2.3 `src/sea/material.ts`

```diff
 export interface SeaOcean { ... + setSunDirection(dir: THREE.Vector3): void; ... }
- return { material, debugUniform, radPerPixel, tierGain, c1Gate };
+ return { material, debugUniform, radPerPixel, tierGain, c1Gate, sunU };
+ setSunDirection(dir) { for (const bits of materialBits) bits.sunU.value.copy(dir).normalize(); }
```

- 只新增接口、导出 uniform、setter，**所有 TSL 着色表达式保持不变**：`skyColorTsl(tsl, reflected, sunU, false)`、`reflect(sunU, normalNode)`、`vec2(sunU.x, sunU.z)`、`length().max(1e-4)` 等源码 tripwire 全部原样（既有 `material.test.ts` 全绿可作证）。
- `materialBits` 类型多一个 `sunU: any`。

### 2.4 `src/world.ts`

新增接口方法 + 三行转发 `sea?.setSunDirection(dir)`。`initWorld` 签名未变；`update()` 里 `puffs?.update(time, sunDir)` 及其从 `sunLight.position` 反推方向的代码**一字未动**。

### 2.5 `src/main.ts`（接线）

| 位置 | 改前 | 改后 |
|---|---|---|
| imports | `clampSunElevation`, `sunDirectionFromAzEl`, `SUN_DIRECTION` | `createSunState`, `parseSunSpin` |
| boot | `lights` → `skyTsl` → `liveSunDir`（`new Vector3(...SUN_DIRECTION)`） | `sun = createSunState()` → `lights` → `skyTsl(THREE, scene, sun.direction)` |
| `?sun=az,el` | main 内 `clampSunElevation` + `sunDirectionFromAzEl` + `liveSunDir.set(...)` | `sun.setAzEl(azRaw, elRaw)`（钳制逻辑移进 `SunState`，行为等价） |
| `initWorld` / `initGame` | 传 `liveSunDir` / 值快照 | 传 `sun.direction` / 值快照（**等价**） |
| 每帧 | `lights.setSunDirection(liveSunDir)` + `skyTsl?.setSunDirection(liveSunDir)`（每帧无条件 copy） | `syncSun()`：按 `sun.version` 脏检查，一次推 **lights / sky / world(sea)**；静止时零开销 |
| `farField.update` | `(x, z)` | `(x, z, y)` |
| QA | — | `?sunspin=<deg/s>`、`qa.setSun(az,el)` / `rotateSun(deg)` / `getSun()`、`describe().sun` |
| 格式 | `async selfCheck()` 那段注释缩进错乱 | 顺手整理缩进（**纯格式，无逻辑变化**） |

- `stepFrame` 顺序：`sunSpin` → `syncSun()` → `world.update()` → `game.update()` → `farField.update()`。太阳同步在 `world.update()`（puff 从灯反推方向）**之前**，所以云侧读到的灯位置是当帧最新值。

### 2.6 `src/qa.ts`

新增纯函数 `parseSunSpin`：缺省 / 空串 / 非法 / ≤0 → **0**（默认画面完全不变），上限 360 deg/s。

---

## 3. 行为变化对照（复查时按这张表看）

| 场景 | 改前 | 改后 |
|---|---|---|
| 默认启动（无参数） | 太阳 = `SUN_DIRECTION`，天穹球心 `(camX, 0, camZ)` | 太阳 = `SUN_DIRECTION`（数值相同），球心 `(camX, camY, camZ)`；**首帧强制同步一次** |
| `?sun=az,el` | 启动时写一次，之后永不变 | 启动时 `setAzEl`，之后可运行时改 |
| 运行时转太阳 | **无入口** | `qa.setSun/rotateSun` 或 `?sunspin`；sky、灯、4 条海面 ring 同时变 |
| 飞行远离原点 | 天空太阳随 `camZ/R` 漂移，海面映射不动 | 天空太阳稳定（视线方向与相机位置解耦），反射与天空同向 |
| 巡航高度的地平线 | 天空/海面有 `camY/R` 俯仰视差 | 3D tow 消除视差 |
| `?sunspin` 未指定 | — | 0，无任何画面/性能变化 |
| build 产物 | — | `dist/` 被 `npm run build` 重写（已 gitignore） |

---

## 4. 自检结论（我复核 diff 后的判定）

| # | 核对项 | 判定 |
|---|---|---|
| 1 | `skyColorTsl` 与海面全部着色表达式是否被动过 | **未动**，既有 `material.test.ts` 全绿 |
| 2 | 云侧逻辑是否被顺手改了 | **未动**，`world.update()` 的 `sunDir` 派生与 `puffs.update` 原样 |
| 3 | `initSunsetSkyTSL` 新签名的调用点 | 全仓仅 `main.ts` 一处，已适配；**但属破坏性变更，见 §6 风险 R1** |
| 4 | `far-field.update` 两参兼容 | 兼容，`far-field.test.ts` 新增用例钉住 |
| 5 | 默认太阳数值是否漂移 | 未漂移，仍是 `SUN_DIRECTION`；仰角钳制仍 `HORIZON.DUSK_BAND` 3–15° |
| 6 | `sun.direction` 会不会被整体替换（导致引用失效） | 不会，所有 setter 原地 `.set()`；测试断言对象身份不变 |
| 7 | 首帧同步是否覆盖 frozen 抓帧 | 覆盖：`lastSunVersion = -1` 强制首帧同步，`qa.step()` 也走 `stepFrame` |
| 8 | 同步顺序对云的影响 | `syncSun()` 在 `world.update()` 之前，灯位置当帧已更新 |
| 9 | NaN 是否会进 shader | `SunState` 拒绝非法输入；两个 setter 都 `.normalize()` |
| 10 | 静态太阳的每帧成本 | `syncSun()` 被 version 挡住，零写入（旧版每帧 2 次 copy） |

**自检里值得你注意的 3 处行为变化**（不是 bug，但要确认接受）：
- S1：天穹球心 y 从 0 变成相机高度（渲染行为变化，需目检）。
- S2：`initSunsetSkyTSL` 第三参语义变了（编译期有 TS 保护，运行时 JS 没有）。
- S3：两个 `setSunDirection` 加了 `.normalize()`，传非单位向量时结果与旧版不同（旧版 sky 是原样 copy）。

---

## 5. 复查手册

### 5.1 看全量改动

```bash
cd G:/DSHProject/threejs-inspire
git status --short                       # 9 个 M + 4 个 ??（新增文件）
git --no-pager diff --no-color           # 9 个已跟踪文件的完整 diff
git --no-pager diff -U0 --no-color -- src/main.ts src/sky-webgpu.ts   # 逐文件聚焦
# untracked 文件不在 diff 里，直接打开：
#   src/sun-state.ts、src/sun-state.test.ts、src/sky-sun-sea-linkage.test.ts
```

建议复核顺序：**`sky-webgpu.ts`（签名 + 方向基准）→ `sun-state.ts`（唯一状态）→ `main.ts`（接线）→ `sea/material.ts`（着色未动）→ `far-field.ts`（3D tow）→ 测试**。

### 5.2 命令验证（本次 08:29 实测全部通过）

| 命令 | 实测结果 |
|---|---|
| `npx tsc --noEmit` | OK |
| `npx vitest run --no-file-parallelism --reporter=dot` | **41 文件 / 342 用例通过，0 error**（29.6 s） |
| `npm run build` | ✓ built in 5.45 s（>500 kB chunk 警告是既有） |
| `node scripts/smoke.mjs` | `smoke ok` |

> 默认并行跑 vitest 会撞本机 `EPERM ...Temp/.../ssr/`（沙箱 brokered-fs），**只影响收集数量、不产生失败用例**，数字会在 295–342 波动。复核请用 `--no-file-parallelism`。

### 5.3 浏览器实机复查（**本次没做，留给你**）

```
?qa=frozen&sun=0,8
__porco.qa.step(1)
__porco.qa.getSun()                 // 记录基准：az / el / direction / version
__porco.qa.setSun(90, 8)            // 或 ?sunspin=30 匀速转
__porco.qa.step(1)
__porco.qa.describe()               // sun 字段应随之变化
```

**四条验收门：**
1. 天空太阳盘/光晕与海面 sun road 同步转到新方位，方位角差 < `SUN_ROAD.WIDTH_DEG`（25°）；
2. `?sunspin=30` 连续两帧，水面光路中心随太阳移动，不滞后、不留在 −Z；
3. 飞行远离原点（`?pos=...` 或自然飞 30 s），天空太阳不再漂移；
4. 地平线无新增横向色带（验证 3D tow 的俯仰视差消除）。

另外建议补一次 **`?post=0` 与默认帧 A/B**，确认 `scene.background` 的 canvas 兜底与 dome 之间没因球心 y 变化露出接缝。

---

## 6. 未覆盖 / 风险清单（如实列出）

| ID | 项 | 说明 |
|---|---|---|
| **R1** | `initSunsetSkyTSL` 签名破坏性变更 | 第三参由 `radius` 变 `sunDirection`。仓库内仅一处调用已适配，但外部 JS/console 旧调用会静默出错。若你在意兼容性，可改成 options 对象 `(THREE, scene, { sunDirection, radius })`，我可以马上改。 |
| **R2** | 无浏览器实机抓帧 | 本环境无浏览器自动化；GPU 端一致性靠代数测试 + 源码契约钉住，§5.3 四门需人工目检。 |
| **R3** | `game.ts` 白纱 tint 是启动快照 | 运行时转太阳后白纱不跟（云侧逻辑，按你的要求排除）。灯的 setter 已接入 `SunState`，云的方向实际会跟，但**未验证**。 |
| **R4** | `scene.background` canvas 兜底 | 静态竖向渐变、不含太阳方位；dome 正常时不可见，降级路径仍与太阳无关（审查报告里列为 P1-3）。 |
| **R5** | `dist/` 被构建重写 | 已 gitignore，不影响工作区源码；若你有手工比对 dist 的习惯，注意它现在是新构建。 |
| **R6** | 未提交 | 全部改动在工作区；`git checkout -- <file>` 可逐文件回退，新增文件需手动删。 |

---

## 7. 若你要回滚 / 拆分提交

- 整体丢弃：`git checkout -- src/` 会还原 9 个既有文件，另外手动删除 3 个新增 `src/*.ts` 与审查文档（不建议你这么做前先备份）。
- 建议的提交粒度（若之后要提交）：
  1. `fix(sky)`: `sky-webgpu.ts` + `far-field.ts` + 对应测试（坐标基准修复）
  2. `feat(sun)`: `sun-state.ts` + `main.ts` + `qa.ts` + `world.ts` + `sea/material.ts` + 联动测试（唯一太阳状态与同步）
  3. `docs`: 两份 review 文档
- 我没有替你执行任何 git 写操作。

---

**一句话：** 改了 13 个文件、净 +727 行，核心是 2 处坐标系修正 + 1 个唯一太阳状态；着色算法没动、云没动、没提交；全绿可复跑，但浏览器实机目检还欠你一次。
