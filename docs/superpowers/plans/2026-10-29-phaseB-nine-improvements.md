# Phase B 九项改进 Implementation Plan (rev.2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在已落地的 Task 1–6（脚手架 / FFT 海面 / 体积云穹 / 占位机 / 输入+相机+手感+HUD+音频）之上，加入卡通着色、失速、导演系统、穿云、地平线锁定、太阳路、字幕、音画同步、竖屏 QA 九项改进，并新增 bloom + 远距模糊的 WebGPU 后期管线。

**Architecture:** 单一 TSL 代码路径——兜底后端从「经典 `WebGLRenderer` + 三套并行 GLSL 实现」改为 `WebGPURenderer({ forceWebGL: true })`，于是海/云/天空/飞机在两条路径上跑同一份节点材质，效果与后期只需实现一次。后期处理走 `RenderPipeline`：scene pass（HalfFloat）→ bloom（叠加）→ dof（替换）→ smaa，全部纯 TSL 节点。

**Tech Stack:** Vite 6 / TypeScript 5.5 / three r186（`three/webgpu` + `three/tsl` + `three/addons/tsl/display/*`）/ vitest 2.1（node 环境，无 DOM）/ WebAudio 程序化合成（无采样）。

**Spec:** `docs/superpowers/reviews/2026-10-29-phaseB-nine-improvements-review.md`（rev.1 评审，本版逐条落实）

---

## 本次修订摘要（rev.1 → rev.2）

| 编号 | rev.1 评审结论 | rev.2 处置 |
|---|---|---|
| 前置 6.5 | 新增建议 | 抽出 `src/palettes.ts`（`SUN_POSITION` / `SKY_PALETTE` / `SEA_PALETTE` / `CLOUD_PALETTE`），`CloudHandle` 归位到 `clouds-compute.ts` |
| 前置 6.6 | 新增建议 | 兜底改 `forceWebGL`，删除 `sea-fallback.ts` / `clouds-fallback.ts` / `sky-sunset.ts` 的 GLSL 穹顶，`far-field` 去掉 `seaKind` 分支 |
| **16（新）** | 原计划完全没有后期处理 | 新增 `src/post.ts`：bloom + 远距模糊 + SMAA，`?post=0` 可关，低画质档自动降 |
| 7 | ⛔ 方案不成立 | 改为 `MeshToonNodeMaterial` + 3 色标 `gradientMap` + `toonify()` 整机换材质；**不碰**海面已手写的分带 |
| 8 | ⚠️ 无升力模型 | 明确为「风格化失速」：鼻头下沉 + 掉速 + buffet，并给出可测的 `stepFlight` 行为 |
| 9 | ⚠️ 与既有逻辑重复 | `CAM_FOV_KICK` / `CAM_BANK_FOLLOW` 从常量改为可注入 `CameraTuning`，导演只做增量 |
| 10 | ⛔ 参数上不可达 | 抬升限 `ALT_MAX 46 → 240`、`START_Y 30 → 60`；云层 raymarch 起点钳制并抽出 `slabRayT()` 单测 |
| 11 | ⛔ 1500 m 光圈在雾/海/天空之外 | 取消新 mesh；改为把海面已有的 haze 数学抽成 `horizon.ts` 纯函数并加饱和性单测 |
| 12 | ⚠️ 约 60% 已存在 | 参数化既有 glint（幂 96 保留），新增方位角门限 `roadMask()` |
| 13 | ✅ | 合并 HUD 容器 bug 修复（`body` → `#wrap`），字幕定格在画布盒内 |
| 14 | ✅ | 只加纯函数（`busGainDb` / `duckGain` / `cloudWind01`），`pulse()` 是薄胶水 |
| 15 | ⚠️ 测试跑不起来 | 拆出 `src/portrait.ts` 纯函数，`main.ts` 模块级 DOM 访问不进测试 |

---

## Global Constraints

- three r186；`three/webgpu` 与 `three/addons/tsl/display/*`，**不写** `ShaderMaterial` / `RawShaderMaterial` / `onBeforeCompile`。
- **单后端代码路径**：`?backend=webgl2` 表示 `forceWebGL: true`，不是换渲染器。任何 TSL 之外的第二套实现都属于缺陷。
- **不开 tone mapping**：`three` 当前未设 `toneMapping`，`RenderPipeline.outputColorTransform = false` 由 SMAA 负责；ACES 会洗掉已调好的晚霞色板。
- `pass()` 必须显式 `{ samples: 0 }`（WebGPU 兼容模式会强制 `_samples = 0`），抗锯齿交给 `smaa()`。
- 移动端 60 fps = 16.67 ms 预算；FFT ≤128（低画质 64），云半分辨率，raymarch 高 12 / 低 8 步。
- `FrameGovernor` 60 帧连续 >24 ms 降档且**不回升**；降档必须同时调低后期（`post.setQuality(false)`）。
- 测试跑在 vitest node 环境（**无 DOM**）：只有纯函数能进单测，DOM/GPU 部分靠 `npm run smoke` + 人眼截图验收。
- 每个数值首次落地一律标 `[PLACEHOLDER]`，等真机截图再定。
- 调色板单一来源：颜色只能来自 `src/palettes.ts`，不许在 shader/TS 里再写字面量。
- 音频：`dbFromSlider` 是 gain²，`musicDuck` -12 dB / 0.25 s，**不得覆盖用户滑块值**。
- Blender 源版本化 `assets/blend/porco-fighter-vNNN.blend` → 单一产出 `assets/porco-fighter.glb`。
- 每个 Task 收尾必须 `git commit`；提交前 `npx vitest run` 与 `npx tsc --noEmit` 全绿。

## Review Focus

以下五类输入/失效模式 spec 隐含但任何单测都不会自动覆盖，最可能先咬到玩家。每条在对应 Task 里都有测试钉住。

1. **相机在第 0 帧就在云里**：`START_Y` 抬高后若出生点落在 `CLOUD_BOTTOM` 之上，开屏就是白屏。中期灰（`inCloud01` 在 60 m 必须为 0）。
2. **剖切边界抖动**：相机贴着 `CLOUD_BOTTOM` / `CLOUD_TOP` 上下微动时，`inCloud01` 若用单次 `smoothstep`，白雾会一闪一闪。→ 进/出两个不同阈值（滞回）。
3. **点满升限后玩法消失**：`ALT_MAX 240` 处钳位，玩家继续拉杆时若没有任何反馈（速度不掉、不抖），会以为卡死。→ 失速项在钳位处仍然上涨。
4. **`pass()` 与 `renderer.setPixelRatio` 相乘**：竖屏 1440×2560 @ dpr2 = 2880×5120 的 HalfFloat RT，bloom 会吃掉十几毫秒。→ 开后期时 pixelRatio 上限降到 1.5。
5. **`smaa(renderOutput(...))` 与 `outputColorTransform` 二选一**：两者同时生效会做两次 sRGB 编码，画面发白、晚霞变粉灰。→ 单测钉住 `outputColorTransform === false` 且输出节点在 `smaa` 之后。

---

## File Structure

**新增**

| 文件 | 职责 |
|---|---|
| `src/palettes.ts` | 全项目颜色与太阳方向的唯一来源 |
| `src/lights.ts` | 日落灯光组（原 `sky-sunset.ts` 的 `initSunsetLights`） |
| `src/post.ts` | RenderPipeline：bloom + dof + smaa，画质档与开关 |
| `src/toon.ts` | 3 色标 gradient map、`toonify()` 整机换材质 |
| `src/stall.ts` | 失速强度与鼻头下沉（纯函数） |
| `src/director.ts` | 由飞行状态推导相机参数增量与震屏触发 |
| `src/in-cloud.ts` | 相机在云层内的浓度（纯函数） |
| `src/horizon.ts` | 海天 haze / glow 数学（海面 shader 与单测共用） |
| `src/sun-road.ts` | 太阳路的方位角门限与增益 |
| `src/subtitles.ts` | 字幕队列、淡入淡出 |
| `src/portrait.ts` | 竖屏比例、安全区、下三分位 |

**修改**：`src/renderer.ts`、`src/main.ts`、`src/world.ts`、`src/far-field.ts`、`src/game.ts`、`src/camera-rig.ts`、`src/plane.ts`、`src/feel.ts`、`src/hud.ts`、`src/audio.ts`、`src/sea-fft.ts`、`src/clouds-compute.ts`、`index.html`、`scripts/smoke.mjs`。

**删除**（Task 6.6）：`src/sea-fallback.ts`、`src/clouds-fallback.ts`、`src/sky-sunset.ts`。

---

## Task 6.5: 抽出共享调色板 `src/palettes.ts`

**Files:**
- Create: `src/palettes.ts`, `src/palettes.test.ts`
- Modify: `src/sea-fallback.ts`（删本地 `SEA_PALETTE`）、`src/clouds-fallback.ts`（删本地 `CLOUD_PALETTE`、改从 `clouds-compute` 引 `CloudHandle`）、`src/clouds-compute.ts`（`CloudHandle` 落地于此）、`src/sea-fft.ts`、`src/sky-webgpu.ts`、`src/sky-sunset.ts`、`src/world.ts`

**Interfaces:**
- Produces: `SUN_POSITION: readonly [number, number, number]`（值 `[60, 35, -280]` 不变）、`SKY_PALETTE: { top, horizon, sun }`、`SEA_PALETTE: { deep, mid, lit, crest, glitter, foam, haze }`、`CLOUD_PALETTE: { shadow, base, pink, gold }`（键与色值从现有文件**原样搬运**）。

- [ ] **Step 1: 写失败测试** `src/palettes.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { SUN_POSITION, SKY_PALETTE, SEA_PALETTE, CLOUD_PALETTE } from './palettes';

const HEX = /^#[0-9a-f]{6}$/i;

describe('palettes', () => {
  it('keeps every colour a 6-digit hex, so THREE.Color and TSL agree', () => {
    for (const css of [...Object.values(SKY_PALETTE), ...Object.values(SEA_PALETTE), ...Object.values(CLOUD_PALETTE)]) {
      expect(css).toMatch(HEX);
    }
  });

  it('has the sea keys the shader reads by name', () => {
    expect(Object.keys(SEA_PALETTE).sort()).toEqual(['crest', 'deep', 'foam', 'glitter', 'haze', 'lit', 'mid']);
  });

  it('keeps the sun where the sea glitter and the sky dome expect it', () => {
    expect(SUN_POSITION).toEqual([60, 35, -280]);
    expect(SUN_POSITION[1]).toBeGreaterThan(0); // above the horizon, or the sunset reads as dusk
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/palettes.test.ts`
Expected: FAIL — `Failed to resolve import "./palettes"`.

- [ ] **Step 3: 建 `src/palettes.ts` 并改所有引用**

把 `src/sea-fallback.ts` 里的 `SEA_PALETTE`、`src/clouds-fallback.ts` 里的 `CLOUD_PALETTE`、`src/sky-webgpu.ts` 里的 `SKY_TOP`/`SKY_HORIZON`/`SKY_SUN` 三组字面量**整块剪走**到新文件，值不改一个字符；`SUN_POSITION` 取自 `src/sky-sunset.ts:4`。`src/world.ts:27` 的私有副本删掉，改 import。

不做兼容 re-export：五个调用点一次性改 import 路径即可，留 shim 会让 Task 6.6 的删除变难。

同时把 `src/clouds-fallback.ts` 导出的 `type CloudHandle` 移到 `src/clouds-compute.ts`，`clouds-fallback.ts` 反向 import 该类型（Task 6.6 会删掉整个文件，类型留在 `clouds-compute.ts` 才不会被一起删）。

- [ ] **Step 4: 全量验证**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS — 85 个既有测试 + 新增 3 个全绿，`tsc` 无输出。任何一条海面/云的颜色断言变红，说明搬运时改了值。

- [ ] **Step 5: Commit**

```bash
git add -A src scripts docs
git commit -m "refactor: single source for palettes and sun direction"
```

---

## Task 6.6: 后端统一到 TSL（`forceWebGL` 兜底，删除并行 GLSL）

**Files:**
- Modify: `src/renderer.ts`、`src/main.ts`、`src/world.ts`、`src/far-field.ts`、`src/sky-webgpu.ts`、`scripts/smoke.mjs`
- Delete: `src/sea-fallback.ts`、`src/clouds-fallback.ts`、`src/sky-sunset.ts`（`initSunsetLights` 先搬进新 `src/lights.ts`）
- Test: `src/world.test.ts`、`src/sea.test.ts`、`src/clouds.test.ts`、`src/far-field.test.ts`

**Interfaces:**
- Consumes: `src/palettes.ts`（Task 6.5）
- Produces: `createRenderer(canvas): Promise<{ renderer: any; backend: Backend; postSupported: boolean }>`；`initWorld(scene: THREE.Scene): Promise<WorldHandles>`（**去掉 `backend` 形参**）；`initFarField(scene: THREE.Scene): FarFieldHandle`（**去掉 `seaKind` 形参**）；`initSunsetLights(scene: THREE.Scene): void` 从 `./lights` 导出。

- [ ] **Step 1: 改 `src/renderer.ts` 的双路径为 forceWebGL**

```ts
// 兜底不再换渲染器，只换后端：同一份 TSL 在 WebGL2 上编译成 GLSL。
const mod = await import('three/webgpu');
const renderer = new (mod as any).WebGPURenderer({ canvas, antialias: true, forceWebGL: !wantGPU });
await renderer.init();
const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2';
```

`?backend=webgl2` 解析成 `wantGPU = false`。只有 `import('three/webgpu')` 本身抛错才退到经典 `THREE.WebGLRenderer`，此时返回 `postSupported: false`（后期不可用，HUD 显示 `POST OFF`），不允许静默降级。

- [ ] **Step 2: 改 `src/world.ts`、`src/far-field.ts`、`src/main.ts` 去掉分支**

`initWorld` 不再按 backend 选实现：`import('./sea-fft')` / `import('./clouds-compute')` 成为唯一路径，try/catch 保留只为在控制台打出**带模块名的**致命错误并 rethrow（不再静默换成 Gerstner/精灵）。`seaKind`/`cloudKind` 字段保留在 `WorldHandles` 上（QA 钩子和 HUD 在用），值恒为 `'fft'` / `'tsl'`。

`initFarField(scene)` 只留 snap 分支：`snapToPeriod` 对海面生效，云与天空仍随相机滑动。`SEA_NAMES` 收敛成单个 `'sea-fft'`。

`main.ts` 两条路径合成一条：`initSunsetLights(scene)` + `await initSunsetSkyTSL(scene)`，`initWorld(scene)`、`initFarField(scene)` 同步改调用。

- [ ] **Step 3: 删除三个文件并修 `scripts/smoke.mjs`**

`src/sky-sunset.ts` 里的 `initSunsetLights` 搬进 `src/lights.ts`（内容不动），随后删除 `src/sky-sunset.ts`。`scripts/smoke.mjs:3-21` 的 `modules` 数组删掉三个已删文件、加上 `src/palettes.ts` / `src/lights.ts` / 本计划新增文件，否则 `npm run smoke` 会报 missing。

- [ ] **Step 4: 改测试**

- `src/world.test.ts`：原 `describe('initWorld (webgl2)')` 的 `expect(seaKind).toBe('gerstner')` → `'fft'`，`cloudKind` `'sprite'` → `'tsl'`；`FrameGovernor` 那段不动。
- `src/sea.test.ts`：删掉 `describe('sea (webgl2 fallback)')` 整块，保留 `SEA_PALETTE` 相关断言（现在从 `./palettes` 引）。
- `src/clouds.test.ts`：删掉 fallback 的 describe 与 `CLOUD_SPRITE_COUNT === 12` 一条。
- `src/far-field.test.ts`：所有 `initFarField(scene, 'fft' | 'gerstner')` 调用改成 `initFarField(scene)`；删掉 Gerstner 连续滑动那条（它测的行为已不存在）。

- [ ] **Step 5: 验证并提交**

Run: `npx vitest run && npx tsc --noEmit && npm run build && npm run smoke`
Expected: 全绿（测试数从 88 降到约 74，属预期），`smoke ok`。

人工：`npm run dev` 后分别用默认与 `?backend=webgl2` 打开，两者画面应**逐像素级接近**（同色板同代码），控制台无 `PostProcessing` 弃用告警、无 `ShaderMaterial is not compatible`。

```bash
git commit -am "refactor: unify both backends on TSL via forceWebGL, drop parallel GLSL"
```

---

## Task 16: 后期处理管线（bloom + 远距模糊 + SMAA）

**Files:**
- Create: `src/post.ts`, `src/post.test.ts`
- Modify: `src/main.ts`（渲染调用、pixelRatio、降档联动）、`src/world.ts`（`applyQuality` 转发）

**Interfaces:**
- Produces:
  - `POST_HIGH: PostFx` / `POST_LOW: PostFx`
  - `usePost(search: string): boolean` — `?post=0` 为 false，默认 true
  - `focusDistanceFor(cam: {x,y,z}, plane: {x,y,z}): number` — 夹在 `[12, 60]`
  - `clampFx(fx: PostFx): PostFx` — strength `[0,2]`、radius `[0,1]`、threshold `[0,1]`、focalLength `[50,2000]`、bokehScale `[0,3]`、NaN → 默认值
  - `initPost(renderer: any, scene: THREE.Scene, camera: THREE.PerspectiveCamera): PostHandle`
  - `PostHandle { render(): void; focusTo(cam, plane): void; setQuality(high: boolean): void; setFx(p: Partial<PostFx>): void; dispose(): void; readonly fx: PostFx }`
  - `PostFx { bloom: boolean; bloomStrength: number; bloomRadius: number; bloomThreshold: number; dof: boolean; focusDistance: number; focalLength: number; bokehScale: number }`

- [ ] **Step 1: 写失败测试** `src/post.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { POST_HIGH, POST_LOW, usePost, focusDistanceFor, clampFx } from './post';

describe('post presets', () => {
  it('drops depth of field and keeps bloom in the low preset', () => {
    expect(POST_HIGH.dof).toBe(true);
    expect(POST_LOW.dof).toBe(false);
    expect(POST_LOW.bloom).toBe(true);
  });

  it('blooms only the sun disc, never the flat sky', () => {
    // horizon #ff9a5a sits near 0.35 luminance; the sun disc is 2.4x. Threshold between them.
    expect(POST_HIGH.bloomThreshold).toBeGreaterThan(0.5);
    expect(POST_HIGH.bloomThreshold).toBeLessThan(1.5);
  });
});

describe('usePost', () => {
  it('is on by default and off for ?post=0', () => {
    expect(usePost('')).toBe(true);
    expect(usePost('?backend=webgl2')).toBe(true);
    expect(usePost('?post=0')).toBe(false);
  });
});

describe('focusDistanceFor', () => {
  it('focuses on the aircraft, not on the sea', () => {
    expect(focusDistanceFor({ x: 0, y: 40, z: 0 }, { x: 0, y: 40, z: -30 })).toBeCloseTo(30, 5);
  });

  it('clamps a nose-dive camera that would focus past the plane', () => {
    expect(focusDistanceFor({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -900 })).toBe(60);
  });
});

describe('clampFx', () => {
  it('keeps tuning in range and survives NaN', () => {
    const fx = clampFx({ ...POST_HIGH, bloomStrength: Number.NaN, bokehScale: 99 });
    expect(fx.bloomStrength).toBe(POST_HIGH.bloomStrength);
    expect(fx.bokehScale).toBe(3);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/post.test.ts`
Expected: FAIL — `Failed to resolve import "./post"`.

- [ ] **Step 3: 实现 `src/post.ts`**

节点链（唯一正确的顺序，参数全部 `[PLACEHOLDER]`）：

```ts
const pipeline = new THREE.RenderPipeline(renderer);          // r183 起 PostProcessing 只是别名
const scenePass = pass(scene, camera, { samples: 0 });        // 兼容模式会强杀 MSAA，显式 0 再补 SMAA
const color = scenePass.getTextureNode('output');             // HalfFloat，>1 的高光留给 bloom 高通
const glow = bloom(color, fx.bloomStrength, fx.bloomRadius, fx.bloomThreshold);
const lit = color.add(glow);                                  // bloom() 只返回辉光，必须叠加
const image = dof(lit, scenePass.getViewZNode(), uniform(fx.focusDistance), fx.focalLength, fx.bokehScale); // dof() 返回成片，绝不能再 add
pipeline.outputColorTransform = false;                        // 交给 SMAA 之后的 renderOutput
pipeline.outputNode = smaa(renderOutput(image));
```

要点：

- `dof()` 的 CoC 是**对称**的（`abs(signedDist)`），离焦点更近也会糊。焦点必须钉在机身上（≈`CAM_DISTANCE` 30），否则机头先糊。
- 天空穹 `depthWrite:false` → 深度恒 1.0 → `viewZ = -2000` → CoC 拉满：太阳变成一团软光，正是晚霞要的观感，不需要额外参数。
- `bloom()` 内部把入参包成 `uniform`，运行时可调；但**换 `outputNode` 结构**必须 `pipeline.needsUpdate = true`（本计划从不换结构，只调参数）。
- `POST_LOW` 额外 `bloomPass.setResolutionScale(0.5)` 并整段跳过 `dof`——低画质设备上 dof 是纯亏。
- `initPost` 返回的 `render()` 调 `pipeline.render()`；`dispose()` 调 `pipeline.dispose()` 并置空引用。

- [ ] **Step 4: 接进 `src/main.ts`**

- `const post = usePost(location.search) && postSupported ? initPost(r, scene, camera) : null;`
- 帧循环末尾 `post ? post.render() : r.render(scene, camera);`
- 每帧 `post?.focusTo(camera.position, farField 用的 plane 位置)`——相机到机身距离即焦距。
- `setPixelRatio(Math.min(devicePixelRatio, post ? 1.5 : 2))`：竖屏 dpr2 下 HalfFloat RT 会到 2880×5120，bloom 吃十几毫秒。
- 既有降档路径（`FrameGovernor` → `world.applyQuality(false)`）追加 `post?.setQuality(false)`。

- [ ] **Step 5: 跑测试 + 截图验收 + 提交**

Run: `npx vitest run src/post.test.ts && npx tsc --noEmit`
Expected: PASS。

人工：`?backend=webgpu` 与 `?backend=webgl2` 各截一张 390×844，确认①太阳有光晕②机身不糊、远处云与海面糊③字幕/HUD 不发白（若发白就是双 sRGB，检查 `outputColorTransform`）。移动端低画质档再截一张确认 dof 已关。

```bash
git add -A src && git commit -m "feat: WebGPU post pipeline with bloom, distance blur and SMAA"
```

---

## Task 7: 卡通着色（`gradientMap` 色标）

**Files:**
- Create: `src/toon.ts`, `src/toon.test.ts`
- Modify: `src/plane.ts`（`buildPlaceholder()` 与 GLB 换装的 `applyLivery` 遍历）

**Interfaces:**
- Produces:
  - `TOON_BANDS = 3`、`TOON_RAMP: readonly [string, string, string]`
  - `makeGradientMap(THREE: typeof import('three'), colors: readonly string[]): THREE.DataTexture` — 宽 = `colors.length`、高 1、`RGBAFormat`/`UnsignedByteType`、`minFilter` 与 `magFilter` = `THREE.NearestFilter`、`generateMipmaps = false`、`colorSpace = THREE.NoColorSpace`
  - `bandIndex(v: number, bands: number): number` — `clamp(floor(v * bands), 0, bands - 1)`，`NaN → 0`
  - `toonify(THREE, root: THREE.Object3D, ramp: THREE.DataTexture): number` — 遍历树，把每个带 `.color` 的 `MeshStandardMaterial` 换成 `new MeshToonNodeMaterial({ color, map, transparent, opacity, side, name })` 并挂上 `gradientMap`，返回替换个数

**不做什么：** 不给海面和体积云套用。`src/sea-fft.ts:611-615` 的分带是按波高 × `ndl` 手写的三档 `smoothstep`，云是体积密度积分——两者都不是光照项，加一层全局量化只会出等高线。`MeshToonNodeMaterial` 也碰不到 `MeshBasicNodeMaterial`。

- [ ] **Step 1: 写失败测试** `src/toon.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { TOON_BANDS, TOON_RAMP, makeGradientMap, bandIndex, toonify } from './toon';

describe('bandIndex', () => {
  it('is a step function, not a lerp — that is the whole look', () => {
    expect(bandIndex(0.0, 3)).toBe(0);
    expect(bandIndex(0.34, 3)).toBe(1);
    expect(bandIndex(0.67, 3)).toBe(2);
  });

  it('pins the ends so the highlight never wraps to shadow', () => {
    expect(bandIndex(1, 3)).toBe(2);
    expect(bandIndex(-2, 3)).toBe(0);
    expect(bandIndex(Number.NaN, 3)).toBe(0);
  });
});

describe('makeGradientMap', () => {
  it('is a nearest-filtered 1D ramp with no mipmaps (three requires it for gradientMap)', () => {
    const tex = makeGradientMap(THREE, TOON_RAMP);
    expect(tex.image.width).toBe(TOON_BANDS);
    expect(tex.image.height).toBe(1);
    expect(tex.minFilter).toBe(THREE.NearestFilter);
    expect(tex.magFilter).toBe(THREE.NearestFilter);
    expect(tex.generateMipmaps).toBe(false);
    expect(tex.colorSpace).toBe(THREE.NoColorSpace);
  });
});

describe('toonify', () => {
  it('swaps every standard material on the aircraft for a toon node material', () => {
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: '#efeadb' })));
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: '#2f6b4e' })));
    const ramp = makeGradientMap(THREE, TOON_RAMP);
    expect(toonify(THREE, root, ramp)).toBe(2);
    root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material & { isNodeMaterial?: boolean; gradientMap?: unknown };
      if (!m) return;
      expect(m.isNodeMaterial).toBe(true);
      expect(m.gradientMap).toBe(ramp);
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/toon.test.ts`
Expected: FAIL — `Failed to resolve import "./toon"`.

- [ ] **Step 3: 实现 `src/toon.ts` 并在 `src/plane.ts` 调用**

`TOON_RAMP` 从 `src/plane.ts` 现有 `LIVERY` 取三段：暗部（`dark_trim` 系）、中间调（`livery_red` 系）、亮部（`livery_white` 系），都走 `palettes.ts`。`bandIndex` 只是为了让「色标是硬台阶」这件事被单测钉住。

`src/plane.ts` 两处接线：

- `buildPlaceholder()`（:69 起）末尾 `toonify(THREE, g, ramp)`；
- GLB 分支的材质遍历（:45 之后那段按 `mat.name` 涂装的白模替换）末尾同样 `toonify(THREE, root, ramp)`，保证导入模型也被换掉。

- [ ] **Step 4: 验证**

Run: `npx vitest run src/toon.test.ts src/plane.test.ts && npx tsc --noEmit`
Expected: PASS。`plane.test.ts` 若断言了 `MeshStandardMaterial` 需同步改为 `isNodeMaterial`。

人工：截图确认机身 3 档硬边（不是渐变），并且海面分带**没有变化**——若海面出现等高线，说明误把 toon 套到了海面。

- [ ] **Step 5: Commit**

```bash
git add -A src && git commit -m "feat: toon shading via 3-step gradient map on the aircraft"
```

---

## Task 8: 失速（风格化，不是气动）

**Files:**
- Create: `src/stall.ts`, `src/stall.test.ts`
- Modify: `src/game.ts`（`FlightState` 加 `stall`，`stepFlight` 里用前向向量的下沉量、掉速）、`src/feel.ts`（`update` 的 ctx 加 `stall01`，buffet）、`src/hud.ts`（`HudReadout` 加 `stall01`）

**Interfaces:**
- Produces:
  - `STALL = { AOA_CRIT: 0.42, NOSE_DROP: 0.55, DRAG: 12, BUFFET01: 0.35 } as const`
  - `MAX_PITCH_PROXY = 1.2` — 镜像 `FLIGHT.MAX_PITCH`，避免 `stall.ts → game.ts` 循环依赖，单测断言两者相等
  - `stall01(pitch: number, speed01: number): number`
  - `FlightState` 新增 `stall: number`；`HudReadout` 新增 `stall01: number`

**口径（rev.1 的争议点）：** 项目没有升力/重力模型（`stepFlight` 纯输入驱动，`pos.y` 硬钳在 `[6, 46]`）。所以这不是「真实失速」，而是**风格化失速**：过大的抬头 + 过低的速度 → 前向向量被压向下、速度往下掉、机翼抖。这样它在任何代码路径上都成立，也不需要在 `stepFlight` 里造一套气动。

`stall01` 的确切形状（单测按这个定值）：

```ts
const aoa = clamp(pitch / MAX_PITCH_PROXY, 0, 1);
const t = clamp((aoa - STALL.AOA_CRIT) / (1 - STALL.AOA_CRIT), 0, 1) * Math.sqrt(clamp(1 - speed01, 0, 1));
return smoothstep01(t);   // 3t² - 2t³；clamp 与 smoothstep01 都必须把 NaN 收敛到 0
```

- [ ] **Step 1: 写失败测试** `src/stall.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { STALL, MAX_PITCH_PROXY, stall01 } from './stall';
import { FLIGHT } from './game';

describe('stall01', () => {
  it('only exists above the critical angle of attack', () => {
    expect(stall01(0, 1)).toBe(0);
    expect(stall01(0.2, 0.9)).toBe(0);
  });

  it('bites hard when the nose is up and the airspeed is gone', () => {
    expect(stall01(0.9, 0.1)).toBeGreaterThan(0.5);
  });

  it('stays recoverable: levelling off with speed clears it', () => {
    expect(stall01(0.05, 0.9)).toBe(0);
    expect(stall01(0.9, 0.9)).toBeLessThan(stall01(0.9, 0.1));
  });

  it('is monotonic in pitch and NaN-safe', () => {
    let prev = -1;
    for (let p = 0; p <= FLIGHT.MAX_PITCH; p += 0.05) {
      const v = stall01(p, 0.3);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(stall01(Number.NaN, 0.5)).toBe(0);
    expect(stall01(0.9, Number.NaN)).toBe(0);
  });

  it('mirrors FLIGHT.MAX_PITCH without importing it', () => {
    expect(MAX_PITCH_PROXY).toBe(FLIGHT.MAX_PITCH);
    expect(STALL.AOA_CRIT).toBeGreaterThan(0);
    expect(STALL.AOA_CRIT).toBeLessThan(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/stall.test.ts`
Expected: FAIL — `Failed to resolve import "./stall"`.

- [ ] **Step 3: 实现 `src/stall.ts` 并接进 `src/game.ts`**

`stepFlight` 里算出前向向量之后：

```ts
const stall = stall01(state.pitch, speed01);
state.stall = stall;
_fwd.y = _fwd.y * (1 - stall) - STALL.NOSE_DROP * stall;   // 鼻头被压下去，哪怕玩家一直拉杆
normalize(_fwd);
state.speed -= STALL.DRAG * stall * dt;                    // 掉速；下一帧的 speed01 继续喂给 stall01 → 自锁
```

`speed01` 用现有的 `(speed - MIN_SPEED) / (MAX_SPEED - MIN_SPEED)`。

- [ ] **Step 4: 加一条行为测试并跑全量**

在 `src/game.test.ts` 追加：

```ts
it('drops altitude when the stick is held full up at high pitch', () => {
  const s = createFlightState();
  s.pos.y = 200;                       // room to fall (Task 10 raises the ceiling to 240)
  s.speed = FLIGHT.MIN_SPEED;          // slow: no energy to trade
  for (let i = 0; i < 240; i += 1) stepFlight(s, 1 / 60, { x: 0, y: 1 });
  expect(s.stall).toBeGreaterThan(0.3);
  expect(s.pos.y).toBeLessThan(200);
});
```

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS。若这条测试在 `ALT_MAX 46` 下先被地板钳住，说明 Task 10 必须先落——按计划顺序执行（Task 10 在其后，但这条测试直接设 `pos.y = 200`，绕开钳位上限不会干扰）。

- [ ] **Step 5: 接 HUD/手感并提交**

`src/feel.ts` 的 `update` ctx 增加 `stall01`，用它叠一层 buffet（`TRAUMA_DECAY` 不变，buffet 单独一个正弦项，幅度 `STALL.BUFFET01 * stall01`）；`hud.ts` 的 `HudReadout` 加 `stall01`，在速度条旁渲染一个 `STALL` 警告块，`stall01 > 0.5` 时闪烁。

```bash
git add -A src && git commit -m "feat: stylised stall with nose drop, drag and buffet"
```

---

## Task 9: 导演系统（相机参数注入）

**Files:**
- Create: `src/director.ts`, `src/director.test.ts`
- Modify: `src/camera-rig.ts`（常量 → `CameraTuning`，新增 `setTuning`）、`src/game.ts`（每帧接导演输出）

**Interfaces:**
- Produces（`camera-rig.ts`）:
  - `interface CameraTuning { fovKick: number; bankFollow: number; distance: number; height: number }`
  - `CAMERA_TUNING: CameraTuning` — 默认值 = 现有常量（`fovKick: CAM_FOV_KICK` 9、`bankFollow: CAM_BANK_FOLLOW` 0.28、`distance: CAM_DISTANCE` 30、`height: CAM_HEIGHT` 6.8）
  - `clampTuning(t: Partial<CameraTuning>): CameraTuning` — `fovKick [0, 9]`、`bankFollow [0, 0.5]`、`distance [12, 60]`、`height [2, 20]`、NaN → 默认
  - `initCameraRig(camera, tuning?: Partial<CameraTuning>): CameraRigHandle`，`CameraRigHandle` 新增 `setTuning(t: Partial<CameraTuning>): void`
- Produces（`director.ts`）:
  - `interface DirectorInput { speed01: number; bank: number; stall01: number; inCloud01: number; dive01: number }`
  - `interface DirectorOutput { fovExtra: number; bankFollow: number; traumaHit: number }`
  - `DIRECTOR = { FOV_BASE: 6, FOV_DIVE: 3, ROLL_DIVE: 0.45, HIT_STALL: 0.6, HIT_CLOUD: 0.25, HIT_DIVE: 0.35 } as const`
  - `directorCurve(input: DirectorInput): { fovExtra: number; bankFollow: number }` — 纯函数，无状态
  - `createDirector(): { update(dt: number, input: DirectorInput): DirectorOutput; reset(): void }` — 只负责**边沿**：状态跨过阈值的那一帧才给 `traumaHit`，之后再给 0

**为什么不复用 `CAM_FOV_KICK` 的语义：** rev.1 的「俯冲 +6°」若直接加上去会变成 9+6=15°，与验收「≤9°」自相矛盾。修正后：**基准降到 6**，导演只在 `[0, 3]` 内加增量，总偏移恒 ≤9°，`clampTuning` 再兜一道。基准从 9 降到 6 是刻意的——正是这 3° 的余量让俯冲有"往前窜"的观感。

- [ ] **Step 1: 写失败测试** `src/director.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { DIRECTOR, directorCurve, createDirector } from './director';
import { CAM_FOV_KICK } from './camera-rig';

const calm = { speed01: 0.3, bank: 0, stall01: 0, inCloud01: 0, dive01: 0 };

describe('directorCurve', () => {
  it('stays inside the caps no matter the input', () => {
    const wild = { speed01: 1, bank: 1.05, stall01: 1, inCloud01: 1, dive01: 1 };
    const out = directorCurve(wild);
    expect(out.fovExtra).toBeGreaterThanOrEqual(0);
    expect(out.fovExtra).toBeLessThanOrEqual(3);          // 9 - 6 = 3 headroom under CAM_FOV_KICK
    expect(out.bankFollow).toBeGreaterThanOrEqual(0.28);
    expect(out.bankFollow).toBeLessThanOrEqual(0.5);
  });

  it('widens the follow on a dive and tightens it when calm', () => {
    expect(directorCurve({ ...calm, dive01: 1 }).bankFollow)
      .toBeGreaterThan(directorCurve(calm).bankFollow);
    expect(directorCurve(calm)).toEqual({ fovExtra: 0, bankFollow: 0.28 });
  });

  it('keeps the director inside the camera rig FOV cap', () => {
    expect(DIRECTOR.FOV_BASE + DIRECTOR.FOV_DIVE).toBeLessThanOrEqual(CAM_FOV_KICK);
  });

  it('survives NaN input without poisoning the camera', () => {
    expect(directorCurve({ speed01: Number.NaN, bank: 0, stall01: 0, inCloud01: 0, dive01: 0 }))
      .toEqual({ fovExtra: 0, bankFollow: 0.28 });
  });
});

describe('createDirector', () => {
  it('hits on the frame a stall starts, then goes quiet', () => {
    const d = createDirector();
    expect(d.update(1 / 60, calm).traumaHit).toBe(0);
    const hit = d.update(1 / 60, { ...calm, stall01: 0.8 }).traumaHit;
    expect(hit).toBeCloseTo(DIRECTOR.HIT_STALL, 6);
    expect(d.update(1 / 60, { ...calm, stall01: 0.8 }).traumaHit).toBe(0);   // no per-frame retrigger
  });

  it('resets so a second stall hits again', () => {
    const d = createDirector();
    d.update(1 / 60, { ...calm, stall01: 0.8 });
    d.reset();
    expect(d.update(1 / 60, { ...calm, stall01: 0.8 }).traumaHit).toBe(DIRECTOR.HIT_STALL);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/director.test.ts`
Expected: FAIL — `Failed to resolve import "./director"`.

- [ ] **Step 3: 改 `src/camera-rig.ts` 为参数注入**

`src/camera-rig.ts:156-157` 与 `:164-165` 里的 `CAM_BANK_FOLLOW` / `CAM_FOV_KICK` 换成 `tuning.bankFollow` / `tuning.fovKick`，`:22` / `:25` 的 `CAM_DISTANCE` / `CAM_HEIGHT` 在 `applyPose` 里换成 `tuning.distance` / `tuning.height`。原常量**保留导出**（`camera-rig.test.ts` 与 `fly-loop.test.ts` 在用），只作为默认值来源。单测里的 `0.28` 在实现时请写成 `CAM_BANK_FOLLOW`（此处为可读性保留字面量）。

- [ ] **Step 4: 接进 `src/game.ts`**

每帧顺序：`director.update(dt, {speed01, bank, stall01, inCloud01, dive01})` → `rig.setTuning({ fovKick: Math.min(CAM_FOV_KICK, DIRECTOR.FOV_BASE + out.fovExtra), bankFollow: out.bankFollow })` → `feel.addTrauma(out.traumaHit)`。`dive01` 取 `clamp(-_fwd.y * 2, 0, 1)`。

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS，含既有 `fly-loop.test.ts` 的「相机在机尾后方 / 看向飞机」两条（`setTuning` 默认值等于旧常量，画面不跳）。

- [ ] **Step 5: Commit**

```bash
git add -A src && git commit -m "feat: director layer feeding camera tuning and trauma"
```

---

## Task 10: 穿云（升限 + raymarch 起点钳制）

**Files:**
- Create: `src/in-cloud.ts`, `src/in-cloud.test.ts`
- Modify: `src/game.ts`（`FLIGHT.ALT_MAX` / `START_Y`）、`src/clouds-compute.ts`（导出 `slabRayT` 并在图里用）、`src/hud.ts`（白雾罩）、`src/main.ts`（把 `inCloud01` 传给 HUD）

**Interfaces:**
- Produces:
  - `IN_CLOUD = { FADE_IN: 40, FADE_OUT: 40 } as const`
  - `cloudDensityAt(y: number): number` — 0..1，`[CLOUD_BOTTOM, CLOUD_TOP]` 内为 1，边缘 `FADE_IN` / `FADE_OUT` 线性收边
  - `inCloud01(y: number): number` — 同上但走 `smoothstep`，用于视觉与音效
  - `slabRayT(camY: number, dirY: number, tMax: number): { tStart: number; tEnd: number }` — 视线与云板 [95, 265] 的相交区间，**起点钳在 ≥ 0**
  - `HudHandle.setWhiteout(v: number): void` — 0..1 白雾不透明度

**决定（rev.1 的三选一）：** 采纳方案 A——`ALT_MIN 6`、`ALT_MAX 46 → 240`、`START_Y 30 → 60`。理由：太阳仰角只有约 7°（`SUN_POSITION [60, 35, -280]`），抬升飞机**不会**把太阳压到地平线以下，构图不变；云板 95–265 一头扎进去还能保住玩家原本要的「飞行中体积云」。代价是失去贴浪飞行的近景，但 `ALT_MIN` 仍然是 6，想贴浪随时可以俯冲。方案 B（压低云板到 15–55）会让云海糊在海天线上，与 Task 11/12 抢同一片像素；方案 C（放弃穿云换 godrays）等于删掉需求。

`START_Y = 60` 刻意压在 `CLOUD_BOTTOM` 之下，开屏是「低空掠海 → 抬头进云」的即时可玩动线，而不是一睁眼白屏。

- [ ] **Step 1: 写失败测试** `src/in-cloud.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { cloudDensityAt, inCloud01, IN_CLOUD } from './in-cloud';
import { slabRayT } from './clouds-compute';
import { CLOUD_BOTTOM, CLOUD_TOP } from './clouds-compute';
import { FLIGHT } from './game';

describe('flight envelope reaches the cloud slab', () => {
  it('can actually climb into the clouds on device, not just in the pure function', () => {
    const camY = FLIGHT.ALT_MAX + 6.8;                       // CAM_HEIGHT
    expect(camY).toBeGreaterThan(CLOUD_BOTTOM);
    expect(FLIGHT.START_Y + 6.8).toBeLessThan(CLOUD_BOTTOM);  // no white screen on frame 0
  });
});

describe('inCloud01', () => {
  it('is zero on the deck and one in the middle of the slab', () => {
    expect(inCloud01(30)).toBe(0);
    expect(inCloud01(CLOUD_BOTTOM)).toBe(0);
    expect(inCloud01(180)).toBeGreaterThan(0.5);
    expect(inCloud01(Number.NaN)).toBe(0);
  });

  it('has hysteresis so hovering on the boundary does not strobe', () => {
    const edge = CLOUD_BOTTOM + IN_CLOUD.FADE_IN * 0.5;
    expect(cloudDensityAt(edge)).toBeGreaterThan(0);
    expect(cloudDensityAt(CLOUD_BOTTOM - 1)).toBe(0);
    expect(cloudDensityAt(CLOUD_TOP + 1)).toBe(0);
  });
});

describe('slabRayT', () => {
  it('starts at the camera when the camera is already inside the slab', () => {
    expect(slabRayT(180, 0, 2000).tStart).toBe(0);
  });

  it('starts ahead of the camera when looking up from the deck', () => {
    const { tStart, tEnd } = slabRayT(30, 0.9, 2000);
    expect(tStart).toBeGreaterThan(0);
    expect(tEnd).toBeGreaterThan(tStart);
  });

  it('returns an empty span when the ray never reaches the slab', () => {
    const { tStart, tEnd } = slabRayT(0, -1, 2000);
    expect(tEnd).toBeLessThanOrEqual(tStart);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/in-cloud.test.ts`
Expected: FAIL — `Failed to resolve import "./in-cloud"` 与 `slabRayT is not a function`。

- [ ] **Step 3: 实现 `src/in-cloud.ts` 与 `clouds-compute.ts` 的 `slabRayT`**

`slabRayT` 用标准 slab 相交，返回 `{ tStart: max(0, tNear), tEnd: min(tMax, tFar) }`；`clouds-compute.ts` 里现有 unrolled 步进的起点由它给出，替换掉「`tBottom` 直接当起点」那段——相机一进云板，`tBottom` 就是负数，不钳制等于把整个积分翻到相机背后。

- [ ] **Step 4: 改飞行包线并接白雾**

`src/game.ts:35-54` 的 `FLIGHT`：`ALT_MAX: 240`、`START_Y: 60`（`ALT_MIN: 6` 不动）。`game.test.ts:12-13` 与 `:88-89` 引用的是常量本身，无需改。

`src/hud.ts` 新增 `setWhiteout(v)`：一个 `position:absolute;inset:0;background:#e8dfd6;opacity:0;pointer-events:none` 的层，`v` 直接写 `style.opacity`。`main.ts` 每帧 `hud.setWhiteout(inCloud01(camera.position.y))`。

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS。`clouds.test.ts` 若断言了具体步数/起点，按 `slabRayT` 的新语义更新。

- [ ] **Step 5: 截图验收 + Commit**

人工：450×800 视口，从 `START_Y 60` 起飞 → 抬头持续爬升 → 进云 → 出云。确认：①进云时整屏均匀发白（不是一块一块）②出云后海天线重新接上③在 `ALT_MAX 240` 顶住时 HUD 的 STALL 块亮起而不是静止不动。

```bash
git add -A src && git commit -m "feat: fly-through clouds, raise ceiling to 240m, clamp raymarch start"
```

---

## Task 11: 地平线锁定（共享 haze 数学，不加新 mesh）

**Files:**
- Create: `src/horizon.ts`, `src/horizon.test.ts`
- Modify: `src/sea-fft.ts`（`src/sea-fft.ts:648-655` 的字面量改引常量）

**Interfaces:**
- Produces:
  - `HORIZON = { HAZE_NEAR: 110, HAZE_FAR: 520, GLOW_POW: 9, GLOW_GAIN: 0.42 } as const`
  - `horizonHaze(dist: number): number` — `smoothstep(HAZE_NEAR, HAZE_FAR, dist)`，`NaN → 0`
  - `horizonGlow(sunDot: number): number` — `pow(max(sunDot,0), GLOW_POW) * GLOW_GAIN`

**删掉 rev.1 的光圈 mesh：** 半径 1500 的环落在 `Fog(60, 700)` 之外、海面 600 m 之外、天空穹 800 之外——三层都不覆盖它，结果是一条悬空的亮线，而且它会在海面自己已经完全 haze 的位置再压一条边。地平线**已经存在**（`src/sea-fft.ts:648-655` 把海的远缘混到天空穹的**同一个**颜色上），所以这一项的交付物是：把那套数学抽成可测的纯函数、证明它在新的升限下仍然饱和、**不新增任何几何**。

升限提到 240 m 后最坏情况是俯视 600 m 外的海缘，视线距离 `sqrt(600² + 240²) ≈ 646 m`：`horizonHaze` 在 520 m 就饱和到 1，所以远缘依旧必然落在天空色上。海面材质是 `fog: false`，`Fog` 只作用在飞机与云上，因此 `Fog.far = 700` 不需要动。

- [ ] **Step 1: 写失败测试** `src/horizon.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { HORIZON, horizonHaze, horizonGlow } from './horizon';

describe('horizonHaze', () => {
  it('is cleanly attached at both ends', () => {
    expect(horizonHaze(0)).toBe(0);
    expect(horizonHaze(HORIZON.HAZE_NEAR)).toBe(0);
    expect(horizonHaze(HORIZON.HAZE_FAR)).toBe(1);
  });

  it('has saturated before the sea patch ends, at every reachable altitude', () => {
    const seaEdgeAtCeiling = Math.hypot(600, 240);   // SEA_PATCH_SIZE/2, FLIGHT.ALT_MAX
    expect(seaEdgeAtCeiling).toBeGreaterThan(HORIZON.HAZE_FAR);
    expect(horizonHaze(seaEdgeAtCeiling)).toBe(1);
  });

  it('is NaN-safe so a bad camera frame cannot paint the sea sky-coloured', () => {
    expect(horizonHaze(Number.NaN)).toBe(0);
    let prev = -1;
    for (let d = 0; d <= 700; d += 10) {
      const v = horizonHaze(d);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('horizonGlow', () => {
  it('peaks at the sun and vanishes away from it', () => {
    expect(horizonGlow(1)).toBeCloseTo(HORIZON.GLOW_GAIN, 6);
    expect(horizonGlow(0)).toBe(0);
    expect(horizonGlow(Number.NaN)).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/horizon.test.ts`
Expected: FAIL — `Failed to resolve import "./horizon"`。

- [ ] **Step 3: 实现并在 `src/sea-fft.ts` 里引用**

`horizonHaze` / `horizonGlow` 是**参考实现**（单测钉住数值），shader 侧把 `110`/`520`/`9`/`0.42` 换成 `HORIZON.HAZE_NEAR` 等常量——`smoothstep(110, 520, dist)` 在 TSL 里接受裸数字，所以常量可以直接内联进节点图，不需要传 uniform。

- [ ] **Step 4: 验证**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: PASS，`sea.test.ts` 20 条全绿（若它断言了 haze 常量值，改成引 `HORIZON`）。

人工：在 240 m 升限俯视截图，海天线必须**看不见任何一条直边**。

- [ ] **Step 5: Commit**

```bash
git add -A src && git commit -m "refactor: share horizon haze math, prove it saturates at the new ceiling"
```

---

## Task 12: 太阳路（参数化既有 glint）

**Files:**
- Create: `src/sun-road.ts`, `src/sun-road.test.ts`
- Modify: `src/sea-fft.ts`（`src/sea-fft.ts:617-630` 的 glint 段）

**Interfaces:**
- Produces:
  - `SUN_ROAD = { WIDTH_DEG: 25, STRETCH: 1.6, BASE: 1.5, NARROW: 96 } as const`
  - `roadMask(azimuthDiff: number): number` — `smoothstep(cos(WIDTH_DEG°), 1, cos(az))`：太阳正下方 1，超出 ±25° 为 0，`NaN → 0`
  - `sunRoadGain(spec: number, azimuthDiff: number, nearFade: number): number` — `spec * BASE * nearFade * (1 + STRETCH * roadMask(azimuthDiff))`
  - `azimuthDiff(sunX: number, sunZ: number, viewX: number, viewZ: number): number` — 水平面夹角（弧度，0..π）

**不做什么：** 不加第二个高光项。海面已经有 `spec = pow(dot(reflect(-sunDir, n), viewDir), 96)` 与同一套 `nearFade`，指数 96 是调试出来的（170 会碎成噪点，`src/sea-fft.ts:617-630` 的注释记着这段历史）。这一项只在既有项上乘一个**方位角门限**，让高光从「一片闪」收成「一条朝太阳的路」。

- [ ] **Step 1: 写失败测试** `src/sun-road.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { SUN_ROAD, roadMask, sunRoadGain, azimuthDiff } from './sun-road';

const DEG = Math.PI / 180;

describe('roadMask', () => {
  it('is 1 under the sun and 0 outside the road width', () => {
    expect(roadMask(0)).toBeCloseTo(1, 6);
    expect(roadMask((SUN_ROAD.WIDTH_DEG + 5) * DEG)).toBe(0);
  });

  it('falls off monotonically and is NaN-safe', () => {
    let prev = 1.0001;
    for (let d = 0; d <= 80 * DEG; d += 2 * DEG) {
      const v = roadMask(d);
      expect(v).toBeLessThanOrEqual(prev);
      expect(v).toBeGreaterThanOrEqual(0);
      prev = v;
    }
    expect(roadMask(Number.NaN)).toBe(0);
  });
});

describe('azimuthDiff', () => {
  it('is zero looking straight at the sun and pi looking away', () => {
    expect(azimuthDiff(0, -1, 0, -1)).toBeCloseTo(0, 6);
    expect(azimuthDiff(0, -1, 0, 1)).toBeCloseTo(Math.PI, 6);
  });
});

describe('sunRoadGain', () => {
  it('rewards looking at the sun and cancels a dead specular', () => {
    expect(sunRoadGain(0.5, 0, 1)).toBeGreaterThan(sunRoadGain(0.5, 60 * DEG, 1));
    expect(sunRoadGain(0, 0, 1)).toBe(0);
  });

  it('keeps the near fade, so the deck does not sparkle underfoot', () => {
    expect(sunRoadGain(0.5, 0, 0)).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/sun-road.test.ts`
Expected: FAIL — `Failed to resolve import "./sun-road"`。

- [ ] **Step 3: 实现并接进 shader**

`src/sea-fft.ts:617-630` 的 `glint = smoothstep(0.42,0.78,sparkle*0.5+0.5) * spec * 1.5 * nearFade` 改为 `... * sunRoadGain(spec, az, nearFade)`，其中 `az = azimuthDiff` 的 TSL 等价式（`acos(dot(normalize(vec2(sunDir.x,sunDir.z)), normalize(vec2(fragDir.x,fragDir.z))))`）。`sparkle` 噪声保留不动。

- [ ] **Step 4: 验证**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS。

人工：朝太阳看 → 一条从脚下延伸出去的窄光路；转 90° → 整片海面只剩细碎反光，没有光路。

- [ ] **Step 5: Commit**

```bash
git add -A src && git commit -m "feat: constrain sea glitter into a sun road"
```

---

## Task 13: 字幕 + HUD 容器修正

**Files:**
- Create: `src/subtitles.ts`, `src/subtitles.test.ts`
- Modify: `src/hud.ts`（root 挂载点与 CSS 定位）、`index.html`（`#wrap{position:relative}`）、`src/main.ts`（字幕时序）

**Interfaces:**
- Produces:
  - `interface SubLine { id: string; zh: string; en?: string; dur: number; cue: string }`
  - `SUB_LINES: readonly SubLine[]` — 5 条中文，`cue` 取 `'takeoff' | 'stall' | 'cloud' | 'low' | 'dive'`
  - `createCues(): { nextLine(cue: string): string | null; reset(): void }` — 每条只出一次，没有对应行时返回 `null`
  - `fadeAlpha(tSinceShow: number, dur: number): number` — 前 0.4 s 淡入、后 0.6 s 淡出，中间 1
  - `initSubtitles(el: HTMLElement): { show(id: string): void; update(dt: number): void; dispose(): void }`

**顺带修的 bug：** `src/hud.ts` 目前 `doc.body.append(root)`，而 `.porco-hud{position:fixed;inset:0}` 铺满整个视口——可画布只是居中一个 9:16 的盒子（`index.html` 的 `#wrap`）。桌面宽窗下 HUD 会散到画布外的黑边上，字幕尤其明显。改成挂到 `#wrap` 并把定位换成 `absolute`。

- [ ] **Step 1: 写失败测试** `src/subtitles.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { SUB_LINES, createCues, fadeAlpha } from './subtitles';

describe('SUB_LINES', () => {
  it('ships five Chinese lines with sane durations', () => {
    expect(SUB_LINES).toHaveLength(5);
    for (const l of SUB_LINES) {
      expect(l.zh.length).toBeGreaterThan(2);
      expect(l.dur).toBeGreaterThan(1);
      expect(l.dur).toBeLessThan(8);
    }
  });
});

describe('createCues', () => {
  it('fires each line once and only on its own cue', () => {
    const cues = createCues();
    const first = cues.nextLine('takeoff');
    expect(first).not.toBeNull();
    expect(cues.nextLine('takeoff')).toBeNull();
    expect(cues.nextLine('nothing-happened')).toBeNull();
  });

  it('can be reset for a second sortie', () => {
    const cues = createCues();
    const id = cues.nextLine('takeoff');
    cues.reset();
    expect(cues.nextLine('takeoff')).toBe(id);
  });
});

describe('fadeAlpha', () => {
  it('fades in, holds, fades out, and never exceeds 1', () => {
    expect(fadeAlpha(0, 3)).toBe(0);
    expect(fadeAlpha(1.5, 3)).toBe(1);
    expect(fadeAlpha(3, 3)).toBe(0);
    expect(fadeAlpha(99, 3)).toBe(0);
    expect(fadeAlpha(Number.NaN, 3)).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/subtitles.test.ts`
Expected: FAIL — `Failed to resolve import "./subtitles"`。

- [ ] **Step 3: 实现 `src/subtitles.ts` 并修 HUD 挂载**

`initSubtitles(el)` 在 `el` 内建一个底部居中的 `<div class="porco-sub">`，`update(dt)` 推进计时并写 `style.opacity`。

`src/hud.ts`：`doc.body.append(root)` → `(doc.getElementById('wrap') ?? doc.body).append(root)`；`CSS` 里 `.porco-hud` 的 `position:fixed` → `position:absolute`。`index.html` 的 `#wrap` 加 `position:relative`。

- [ ] **Step 4: 验证**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS。

人工：桌面 1600×900 与手机 390×844 各一张截图——HUD 四角必须**贴着 9:16 画布的角**，字幕在画布底部居中，不越界。

- [ ] **Step 5: Commit**

```bash
git add -A src index.html && git commit -m "feat: subtitles, and mount the HUD inside the canvas box"
```

---

## Task 14: 音画同步

**Files:**
- Modify: `src/audio.ts`（新增 `pulse` 与三个纯函数）、`src/audio.test.ts`、`src/game.ts`（触发点）

**Interfaces:**
- Produces:
  - `busGainDb(slider01: number, duckDb: number): number` — `clamp(dbFromSlider(slider01) + duckDb, SLIDER_FLOOR_DB, 0)`，**证明 duck 不会把滑块值写回去**
  - `duckGain(tSinceOn: number, rampS: number): number` — 0.25 s 内线性到 `DUCK_DB`，松开后 0.25 s 内回到 0
  - `cloudWind01(inCloud01: number): number` — 云内风噪增益，`[0.35, 1]`
  - `AudioHandle.pulse(kind: 'stall' | 'dive' | 'cloud' | 'line'): void`
    - `stall` → `playSfx('sting')` + `duck(true)`，0.25 s 后 `duck(false)`
    - `dive` → `setIntensity(1)`
    - `cloud` → 风噪总线 gain 升到 `cloudWind01(1)`
    - `line` → `playSfx('ui')`

**为什么 `pulse` 几乎不进单测：** `audio.test.ts` 现在只测纯函数（没有 WebAudio 桩），值不值得为它造一套 `AudioContext` mock？不值得——所有会算错的算术（dB 相加、包络、钳位）都搬到纯函数里了，`pulse` 只剩「调哪个方法」的胶水，靠人工听。

- [ ] **Step 1: 写失败测试**（追加到 `src/audio.test.ts`）

```ts
import { busGainDb, duckGain, cloudWind01, DUCK_DB, DUCK_RAMP_S, SLIDER_FLOOR_DB } from './audio';

describe('busGainDb', () => {
  it('ducks under the slider without ever overwriting it', () => {
    const open = dbFromSlider(0.8);
    expect(busGainDb(0.8, DUCK_DB)).toBeCloseTo(open + DUCK_DB, 6);
    expect(busGainDb(0.8, 0)).toBeCloseTo(open, 6);
  });

  it('clamps at the floor instead of -Infinity', () => {
    expect(busGainDb(0, DUCK_DB)).toBe(SLIDER_FLOOR_DB);
    expect(busGainDb(1, 3)).toBe(0);
  });
});

describe('duckGain', () => {
  it('reaches the duck depth inside the ramp and recovers in time', () => {
    expect(duckGain(0, DUCK_RAMP_S)).toBe(0);
    expect(duckGain(DUCK_RAMP_S, DUCK_RAMP_S)).toBeCloseTo(DUCK_DB, 6);
    expect(duckGain(DUCK_RAMP_S * 3, DUCK_RAMP_S)).toBe(DUCK_DB);   // held while on
    expect(duckGain(Number.NaN, DUCK_RAMP_S)).toBe(0);
  });
});

describe('cloudWind01', () => {
  it('only pushes the wind up, never mixes it away', () => {
    expect(cloudWind01(0)).toBeCloseTo(0.35, 6);
    expect(cloudWind01(1)).toBeCloseTo(1, 6);
    expect(cloudWind01(0.5)).toBeGreaterThan(0.35);
    expect(cloudWind01(Number.NaN)).toBeCloseTo(0.35, 6);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/audio.test.ts`
Expected: FAIL — `busGainDb is not a function`。

- [ ] **Step 3: 实现三个纯函数与 `pulse`**

`pulse` 只在 `state() === 'live'` 时动作；不新建总线、不新建计时器（复用现有 `duck` 的 ramp 调度）。触发点在 `src/game.ts`：`stall01` 越过 0.5 → `pulse('stall')`；`dive01` 越过 0.6 → `pulse('dive')`；`inCloud01` 越过 0.5 → `pulse('cloud')`；字幕 `showCue` 时 → `pulse('line')`。全部走 Task 9 已有的边沿检测，不重复每帧触发。

- [ ] **Step 4: 验证**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS，`dbFromSlider` 原有 4 条不变（回归保护）。

- [ ] **Step 5: 人工听 + Commit**

人工：拉满 MASTER → 失速 → 音乐先掉 12 dB 再回；把 MASTER 拉到 0 后再失速，必须**真静音**（不是又冒出声音）。

```bash
git add -A src && git commit -m "feat: gameplay-driven audio pulses on top of the existing duck"
```

---

## Task 15: 竖屏 QA

**Files:**
- Create: `src/portrait.ts`, `src/portrait.test.ts`, `docs/PORTRAIT_QA.md`
- Modify: `src/main.ts`（`syncAspect` 用 `portraitAspect`）、`src/camera-rig.ts`（`CAMERA_TUNING` 微调）、`src/hud.ts`（安全区）、`index.html`

**Interfaces:**
- Produces:
  - `PORTRAIT = { ASPECT: 9 / 16, SAFE_TOP: 0.10, SAFE_BOTTOM: 0.14, LOWER_THIRD: 0.62 } as const`
  - `portraitAspect(w: number, h: number): number` — 宽高比大于 9:16 时夹到 9:16；`w/h` 非法（0、NaN）→ 9:16
  - `lowerThirdY(viewH: number): number` — `viewH * LOWER_THIRD`
  - `hudSafeArea(aspect: number): { top: number; bottom: number }` — 按视口高度的比例给出上下安全边

**rev.1 的测试为什么跑不起来：** `src/main.ts` 在模块顶层就 `document.getElementById`，vitest 的 node 环境没有 `document`，import 即抛；而且 `camera` 是 `boot()` 里的局部变量，测试摸不到。所以判据不能是 `expect(camera.aspect).toBeLessThan(1)`，而要下沉成 `portraitAspect()` 的纯函数测试。

- [ ] **Step 1: 写失败测试** `src/portrait.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { PORTRAIT, portraitAspect, lowerThirdY, hudSafeArea } from './portrait';

describe('portraitAspect', () => {
  it('keeps a phone in portrait exact', () => {
    expect(portraitAspect(1080, 1920)).toBeCloseTo(PORTRAIT.ASPECT, 6);
  });

  it('clamps a desktop window to story portrait instead of stretching', () => {
    expect(portraitAspect(2560, 1440)).toBe(PORTRAIT.ASPECT);
  });

  it('never produces NaN or a zero-width frustum', () => {
    expect(portraitAspect(0, 0)).toBe(PORTRAIT.ASPECT);
    expect(portraitAspect(Number.NaN, 1920)).toBe(PORTRAIT.ASPECT);
  });
});

describe('lowerThirdY', () => {
  it('puts the aircraft below the middle third line', () => {
    expect(lowerThirdY(1280)).toBeCloseTo(1280 * PORTRAIT.LOWER_THIRD, 6);
    expect(lowerThirdY(1280)).toBeGreaterThan(1280 / 2);
  });
});

describe('hudSafeArea', () => {
  it('reserves room for a notch and a bottom bar', () => {
    const area = hudSafeArea(PORTRAIT.ASPECT);
    expect(area.top).toBeGreaterThan(0);
    expect(area.bottom).toBeGreaterThan(area.top);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/portrait.test.ts`
Expected: FAIL — `Failed to resolve import "./portrait"`。

- [ ] **Step 3: 实现 `src/portrait.ts` 并接线**

`src/main.ts` 的 `syncAspect()` 改用 `portraitAspect(bufferWidth, bufferHeight)`；`index.html` 的 `#game` 保持 `aspect-ratio:9/16`；`src/hud.ts` 用 `hudSafeArea` 设 `padding-top/bottom`。

- [ ] **Step 4: 真机跑分并写 `docs/PORTRAIT_QA.md`**

记录四栏：设备 / 后端（`__porco.backend`）/ 平均 fps / 是否降档（`world.quality`、`post.fx.dof`）。验收线：PC WebGPU ≥55 fps，Android WebGL2 ≥30 fps。

- [ ] **Step 5: Commit**

```bash
git add -A src index.html docs && git commit -m "feat: portrait aspect, safe area and QA evidence"
```

---

## 执行顺序

| 顺序 | Task | 依赖 | 说明 |
|---|---|---|---|
| 1 | 6.5 | — | 纯搬运，可单独 PR |
| 2 | 6.6 | 6.5 | 破窗任务：它红则全计划停 |
| 3 | **16** | 6.6 | 后期先落，后面所有配色/明度都在有 bloom 的前提下调 |
| 4 | 7 | 16 | toon 的亮部要比对 bloom 之后的高光 |
| 5 | 8 | 7 | 失速改前向向量，与着色无关但共享 HUD |
| 6 | 9 | 8 | 导演吃 `stall01` |
| 7 | 10 | 9 | 升限 240 后失速才有下坠空间 |
| 8 | 11 | 10 | 新升限下的海天线验收 |
| 9 | 12 | 11 | 同一片海面，先定边再定光 |
| 10 | 13 | — | 与飞行无关，可并行 |
| 11 | 14 | 8,10,13 | 三个触发源都在前面 |
| 12 | 15 | 全部 | 收口 |

## 风险

- **6.6 是单点失败。** `forceWebGL` 若在你的安卓机上起不来（节点材质编译报错 / 首帧超时），后面 10 个任务全部要退回「双实现」。先做 6.6，用 `?backend=webgl2` 在目标机上跑一轮再往下走。
- **后期与像素比相乘。** 竖屏 dpr2 下 HalfFloat RT 是 2880×5120。本计划把开后期时的 pixelRatio 上限压到 1.5；若仍超预算，先砍 `dof`（`POST_LOW` 已经这么做），**不要**砍 `smaa`——关掉 MSAA 又不补 SMAA 会满屏锯齿。
- **穿云与雾。** `inCloud01` 的白雾是 DOM 层，不是体积雾。它不会跟着云一起飘，靠 `shadow/base` 两档 opacity 撑着观感；如果截图里「白得像贴纸」，把 `CLOUD_STEP_ALPHA` 抬高再补一层低透明度体积雾，两件事分开调。
- **`bloom()` 与 `dof()` 的返回值语义相反**（前者只给辉光要叠加，后者给成片）。这是这套 API 最容易写错的地方，`src/post.ts` 里已用注释标死；改 `outputNode` 结构后必须 `needsUpdate = true`。
