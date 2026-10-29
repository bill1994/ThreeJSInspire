# Phase-B 九项改进 Plan — 技术路径评审（WebGPU 优先）

**被评审文档：** `docs/superpowers/plans/2026-10-29-phaseB-nine-improvements.md`（423 行，Task 7–15）
**评审基准：** 仓库实际代码（three 0.186.0，`three/webgpu` + `three/tsl`）、r186 源码 API
**评审时间：** 2026-10-29

---

## 0. 结论速览

整体方向可行，模块拆分（纯函数 + 单一接入点）与现有 `game/world/far-field` 分层一致，值得照此执行。但有 **3 个阻塞项**会直接导致"写完跑不出现象"，另有 6 处需要修正。最大缺口不在文档里：**9 项没有一项是后期处理，而你现在一行后期都没有。**

| 任务 | 判定 | 说明 |
|---|---|---|
| T7 Toon 管线 | ⛔ 需重做设计 | 全局色带量化是错误抽象，且够不到真正该做 toon 的机身 |
| T8 失速 Stall | ⚠️ 可做，需定义 | 现有飞行模型无重力，失速会"贴地滑行" |
| T9 Director | ⚠️ 可做，需去重 | FOV kick 已存在（±9°），再 +6° 会撞验收上限 |
| T10 穿云 | ⛔ 不可行（按现参数） | 相机永远进不了云层：飞机上限 46 m，云底 95 m |
| T11 海天线 | ⛔ 不可行（按现参数） | 半径 1500 落在雾/海面/天穹之外，会变成悬空亮线 |
| T12 阳光路 | ⚠️ 已存在约 60% | `sea-fft.ts` 已有 pow(96) glint，应参数化而非叠加 |
| T13 字幕 | ✅ 可行 | HUD 是 DOM，成本低；只需修挂载容器 |
| T14 音画联动 | ✅ 可行 | 与现有 `musicDuck` 设计一致 |
| T15 竖屏 QA | ⚠️ 测试不可执行 | `portrait.test.ts` 拿不到 `camera`，会 import 失败 |
| （缺）后期处理 | ❌ 遗漏 | 见 §3，这是用户明确要的东西 |

---

## 1. 阻塞项（不改就不要开工）

### 1.1 T10「飞行中体积云」在当前参数下永远不触发

**证据链：**

- `src/game.ts` `FLIGHT = { ALT_MIN: 6, ALT_MAX: 46, START_Y: 30, ... }`，`stepFlight` 末尾硬夹 `if (pos.y > ALT_MAX) pos.y = ALT_MAX;`
- 相机高度 = 飞机 y + `CAM_HEIGHT`（`camera-rig.ts` = 6.8）→ 相机 y ∈ **[12.8, 52.8]**
- `src/clouds-compute.ts:18-19`：`CLOUD_BOTTOM = 95`、`CLOUD_TOP = 265`
- `src/clouds-fallback.ts`：Sprite 云 y = 128–300

→ `inCloud01(camY)` 在真机上**恒为 0**。plan 里的测试 `inCloud01(180) > 0.5` 只测纯函数，测不出"这个函数永远不会被以 180 调用"。这是典型"单测全绿、现场没有"的失效。

**三条出路，必须选一条写进 plan（现在是空的）：**

| 方案 | 改动 | 收益 | 代价 |
|---|---|---|---|
| **A. 抬升飞行包线** | `ALT_MAX 46 → 240`、`START_Y 30 → 120`，云层 95–265 不动 | T8 俯冲、T10 穿云同时成立，改动最小 | 失去贴海飞；近景浪花/foam 退出视野，T12 的 `nearFade` 要重调 |
| **B. 压低云层** | `CLOUD_BOTTOM/TOP → 15/55`，成"云海" | 不用改飞行包线 | 云海横在海平线上，会挡掉太阳盘与金色阳光路，与 T11/T12 **直接冲突**；`CLOUD_NOISE_SCALE`、`CLOUD_STEP_ALPHA`、构图全套重调 |
| **C. 换表现（推荐）** | 删掉穿云，改成"云隙光/云影"：用已有的 `GodraysNode`（`examples/jsm/tsl/display/GodraysNode.js`）在云层上打光柱 | 零物理改动、构图最稳、成本最低，仍是"云"的叙事 | 不是用户原话里的"穿云" |

注意太阳方位：`SUN_POSITION = [60, 35, -280]`，仰角仅 ≈7°。抬升飞机**不会**把太阳压到地平线下（地平线不随高度移动），所以方案 A 在构图上是安全的；真正的代价是近景海面细节。

### 1.2 T11 地平线环半径 1500 与现有场景自相矛盾

**证据链：**

- `src/main.ts`：`scene.fog = new THREE.Fog('#c96a7a', 60, 700)`，相机 `far = 2000`
- `src/sea-fft.ts:542`：`SEA_PATCH_SIZE = 1200` → 海面半宽只有 **600 m**
- 天穹：`sky-sunset.ts` / `sky-webgpu.ts` 半径 **800**，`depthWrite: false`
- `sea-fft.ts:648-655`：海面远处 `haze = smoothstep(110, 520, dist)` 拉到 1，且 `hazeColor` 逐项复刻天穹的 `horizonGlow = pow(cos,9)*0.42`，注释明写"so the sea's far edge lands on **exactly** the sky dome's colour"

→ 半径 1500 的环带在**雾外（>700）、海面外（>600）、天穹外（>800）**。它不会"补上"地平线，而是浮在空腔上成为一条悬空亮线；验收项"horizon 与 sea patch 接缝无裂缝"在 1500 半径下物理上不可能满足。

更关键的是：**现在这条地平线已经存在**，且是刻意做到无缝的。计划要加的东西，现有实现已经用更便宜的方式解决了。

**如果要保留 T11：** 半径必须 = `SEA_PATCH_SIZE / 2`（600），颜色取 `SEA_PALETTE.haze`（不是新色 `#e8907a`），用与 `far-field.ts` 相同的 `snapToPeriod` 平移，并显式 `depthTest: false` + `renderOrder` 控制。即便如此收益也接近为零，**建议降级为 P2 或删掉**。

### 1.3 T7 全局色带量化是错误抽象，且够不到该用 toon 的机身

两个独立问题（原第 3 条「WebGL2 路无灯」是误判，已在下方勘误）：

1. **重复分带。** 海面已经在做分带，而且是"按浪高"而不是"按亮度"：`sea-fft.ts:611-615` 用 `hNorm*0.62 + ndl*0.38` 走 3 级 `smoothstep` 混 `SEA_PALETTE` 四色，注释写明了为什么不能量化法线（lumpy Gaussian → leopard-spot）。再叠一层全局 `quantize` 是**二次分桶**，会在两套阈值交界处产生等高线式断层（contour banding），屏幕上是一条条硬边。
2. **toon 材质够不到该用的人。** 海/云是 `MeshBasicNodeMaterial`（unlit），`MeshToonNodeMaterial` 管不着；真正该换 toon 的是 `plane.ts:72-79` 的占位机（`MeshStandardMaterial`）。r186 确实自带 toon：`MeshToonNodeMaterial` + `gradientMap`（`nodes/functions/ToonLightingModel.js` 里走 `builder.material.gradientMap` → `materialReference('gradientMap','texture')`，无 map 时退化成 `smoothstep(0.7 ± fwidth)` 两段）。**正确做法是给机身铺一张 3px、`NearestFilter` 的 1D gradient map**，而不是手写 `quantize3`。
3. **~~WebGL2 路没有灯~~ —— 误判，已勘误。** `src/sky-sunset.ts:51` 的 `initSunsetSky` 末尾就在调 `initSunsetLights(scene)`，所以**两条路径都有** `DirectionalLight` + `HemisphereLight`；`main.ts` 的 webgpu 分支只是自己也调了一次（重复调用 `initSunsetLights`，与 T7 无关）。因此 T7 **不需要**为 WebGL2 补灯光。rev.2 的 Task 6.6 把两条路径合成一条后，这个分叉干脆不存在了。

**重写建议：** `toon.ts` 只保留纯函数（gradient map 生成、`bandIndex`、`toonify`），删掉 `quantize3` 全局量化；机身统一换 `MeshToonNodeMaterial` + gradient map（Task 6.6 之后两条路径是同一份代码，不再需要 `MeshToonMaterial` 分支）；海/云保持现状。Test 换成有意义的断言（ramp 长度、`NearestFilter`/`NoColorSpace`、`NaN` 兜底），`quantize3(0.62,3)===0.5` 这种测了也没人用的断言可以删。

---

## 2. 需要修正但不阻塞

### 2.1 T9 Director 与现有实现撞车
`camera-rig.ts` 已有 `CAM_FOV_KICK = 9` 且 `applyPose` 里就是 `fov = baseFov + CAM_FOV_KICK * speed01` —— **FOV kick 已经存在且已经是 9°**。T9 再 "+6° 俯冲" 会叠到 15°，而 T9 自己的验收写 "fovKick ≤ 9°"，自相矛盾。
`CAM_BANK_FOLLOW = 0.28` 是模块常量、不是参数，所以"0.28 → 0.45"必须把 rig 签名改成可注入（plan 说了 modify camera-rig，但没写要改签名）。
**建议：** 删掉 rig 内的硬编码，让 rig 只接受 `{ fovKick, bankFollow }`，由 director 统一输出并 clamp；验收改成"总 FOV 偏移 ≤ 9°"。

### 2.2 T12 阳光路已经存在
`sea-fft.ts:617-630` 与 `sea-fallback.ts:143-148` 已有 `spec = pow(max(dot(reflect(-sunDir, normal), viewDir), 0), 96)` + 噪声 sparkle + `nearFade`，注释记录了从 170 降到 96 的调参史（170 时路会碎成散点）。**再加一条高光项 = 双重叠加、过曝。**
真实缺口只有三个：① ±25° 方位收窄；② 纵向拉伸（沿太阳方位的 anisotropy）；③ 双后端同参。所以 T12 应该是"给现有 glint 加参数"，`sun-road.ts` 导出的应是 `glintParams` 而不是新 `glitter()`。
测试 `glitter(1,...) > glitter(0,...)` 是恒真断言（单调函数），删掉。

### 2.3 T8 失速撞上"无重力"飞行模型
`stepFlight` 是纯输入驱动：pitch/bank 指数逼近输入目标后 clamp，位置沿机头积分，最后硬夹 `y ∈ [6, 46]`。没有升力/重力项。因此"失速机头下掉"只能表现为叠加在输入 pitch 上的偏移，而 `ALT_MIN = 6` 意味着以 0.3 rad/s 下坠约 0.2 s 就贴地滑行 —— 读起来像熨地板。
**要么**在 plan 里明确这是风格化处理（俯冲只改 pitch + 屏幕倾斜 + 抖振，不追求真实高度变化），**要么**在 `stepFlight` 里加一个独立的 `vy` 项。现在文档两边都没写。

### 2.4 T15 的验收测试跑不起来
`expect(camera.aspect).toBeLessThan(1)` 写在 `src/portrait.test.ts`：`main.ts` 顶层就 `document.getElementById(...)`，vitest 默认 `environment: node` 无 DOM，**import 即抛**；而且 `camera` 是 `boot()` 内的局部变量，测试根本拿不到。
这与 plan 自己第 19 行的原则（"纯函数可测"）冲突。**建议**把构图规则提成纯函数，例如 `portraitAspect(w, h)`、`lowerThirdY(fovDeg, dist)`、`safeInsets(aspect)`，只测这些；DOM 断言交给 `scripts/smoke.mjs` 或人工截图链。

### 2.5 HUD/字幕挂载点与会话框错位（T13 + T15）
`hud.ts:91` `root.className = 'porco-hud'`，`hud.ts:179` `doc.body.append(root)`，CSS 是 `position: fixed; inset: 0` —— HUD 铺满**整个浏览器视口**。但 canvas 是 `width: min(100vw, 56.25vh); aspect-ratio: 9/16` 的居中窄框（`index.html`）。
→ 在桌面宽窗口下，"底部居中"的字幕/提示会落在窗口底部中心，而游戏画面在中间那条 9:16 竖条里，字幕与画面完全脱开。T13 的"字幕区在安全区内"和 T15 的"中央列留空"都会踩这个坑。
**修法：** HUD 改挂到 `#wrap` 内的一个 `position: absolute; inset: 0` 容器（尺寸跟随 `#game` 的 client rect），或直接用 `#game.getBoundingClientRect()` 计算定位。

### 2.6 双后端 = 每项写两遍（最大的隐性成本）
`renderer.ts` 的 webgl2 兜底用的是**经典** `new THREE.WebGLRenderer(...)`。经典 WebGLRenderer 不支持 TSL、不支持 `RenderPipeline`、不支持节点材质 —— 所以 plan 里 9 项全都要求"双后端同画面语言"，等于每个效果都要维护 TSL + GLSL 两份实现（海/云/天已经是三套并行 GLSL 了）。
`WebGPURenderer` 支持 `{ forceWebGL: true }`（`WebGPURenderer.js:41/57`）走 `WebGLBackend`，同样输出 WebGL2，但**保留全套节点材质 + TSL + RenderPipeline**。
**建议新增一步（放在最前）：** 兜底改为 `new WebGPURenderer({ canvas, antialias: true, forceWebGL: true })`，然后可以删除 `sea-fallback.ts`(8.5K)、`clouds-fallback.ts`(7.6K)、`sky-sunset.ts`(2.2K) 三套 GLSL 并行实现，一次性把"双后端"成本砍掉，也让 §3 的后期处理在两条路上同时可用。注意 WebGL2 的 `fwidth` 是 GLSL ES 3.00 核心特性，节点材质的 toon 退化路径（`smoothstep(0.7 ± fwidth)`）不受影响。

---

## 3. 后期处理：现状 = 零，以及怎么接（本文重点）

### 3.1 现状审计结果：一行都没有

- `src/renderer.ts` 全文 31 行：只做后端探测，`WebGPURenderer({canvas, antialias:true})` → `await renderer.init()` → `setPixelRatio(min(dpr,2))`，失败回落经典 WebGLRenderer。没有 `RenderPipeline`、没有 `setRenderTarget`、没有 tone mapping、没有 color space 设置。
- `src/main.ts:164`：帧循环最后一句就是 `r.render(scene, camera);`，直接画到画布。
- 全仓 grep `postprocess|PostProcess|Bloom|EffectComposer|RenderPipeline|outline|bokeh|dof`（`src/**/*.ts`、`docs/**/*.md`、`scripts/*.mjs`、`index.html`）：**零命中**，唯一"命中"是 `clouds-compute.ts` 里 `windOffset` 包含 "dof" 的假阳性。

结论：没有 bloom、没有 DOF、没有描边、没有色彩分级。要加，得从零接。

### 3.2 最小可用接线

新建 `src/post.ts`（**只在 webgpu 后端构建**；webgl2 返回 `null` 走原来的 `r.render`）：

```ts
// src/post.ts
import * as THREE from 'three/webgpu';
import { pass, renderOutput, uniform } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';

export function initPost(renderer: any, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
  const pipeline = new (THREE as any).RenderPipeline(renderer); // r183 起 PostProcessing 只是弃用别名

  const scenePass = pass(scene, camera, { samples: 0 });        // 见 3.5①
  const color = scenePass.getTextureNode('output');             // PassNode.js:683
  const viewZ = scenePass.getViewZNode();                       // PassNode.js:729

  const glow = bloom(color, 0.7, 0.6, 0.82);                    // BloomNode.js:70 (input,strength,radius,threshold)
  const lit = color.add(glow);                                  // ⚠️ bloom() 只返回辉光，必须 add

  const focus = uniform(34);                                    // 相机→飞机 ≈ CAM_DISTANCE 30
  const image = dof(lit, viewZ, focus, 420, 1.1);               // ⚠️ dof() 返回成品，不能再 add

  pipeline.outputColorTransform = false;
  pipeline.outputNode = smaa(renderOutput(image));              // 先 tonemap/colorspace，再 SMAA
  pipeline.needsUpdate = true;

  return { render: () => pipeline.render(), focus, glow, dispose: () => pipeline.dispose() };
}
```

`src/main.ts` 只改两处：第 148 行 `initFarField(...)` 之后加一行

```ts
const post = backend === 'webgpu' ? initPost(r, scene, camera) : null;
```

第 164 行换成

```ts
if (post) post.render(); else r.render(scene, camera);
```

### 3.3 bloom 参数（针对这个日落场景）

- `bloom()` 的 `strength/radius/threshold` 在构造函数里就被包成 `uniform`（`BloomNode.js:86-100`）→ 运行时可改 `glow.strength.value`，**不需要** `needsUpdate`。只有**换 outputNode 结构**才需要置 `pipeline.needsUpdate = true`（`RenderPipeline.js:82/232`）。
- `threshold = 0.82` 是按你的调色板选的：太阳盘 `pow(cos,220) * 2.4`、海面 glint `spec * 1.5` 都 >1 会被抓；`#ff9a5a` 地平线 ≈1.0 只会轻微呼吸；云金边介于两者之间，可调。
- **不需要开 tone mapping。** `pass()` 的 RT 是 `HalfFloatType`（`PassNode.js:246`），>1 的值在 pass 内不被裁掉，bloom 有真高光可抓。全仓目前没设 `toneMapping`（默认 NoToneMapping），**保持默认**；加 ACESFilmic 会把已经调过的日落 palette 洗淡。
- 想精确控制发光物体（比如"只要太阳和阳光路发光，云不要"）：走 MRT selective bloom —— `scenePass.setMRT(mrt({ output, emissive }))`，给 sea/sky 的 `MeshBasicNodeMaterial` 加 `emissiveNode`，然后只 bloom `emissive` 附件。因为这两块本来就是 unlit 节点材质，加这个成本很低，属于可选升级。

### 3.4「远距加点模糊」= dof 的非对称用法

`dof()` 的 CoC 是**对称**的：`signedDist = -viewZ - focus; CoC = smoothstep(0, focalLength, abs(signedDist))`（`DepthOfFieldNode.js:375-376`）—— 比焦点近的也会糊。所以不要指望它只糊远处，要靠**焦点的位置**把它变成"只糊远处"：

- 焦点设成相机到飞机的距离（`CAM_DISTANCE 30`，加上俯视分量 ≈ 31–34）→ 飞机永远最锐；
- 相机正下方的近景海面 |viewZ| ≈ 10–30 → 离焦点极近 → CoC≈0 → 基本不糊；
- 远处的海、云、天穹 200–600+ → CoC 拉满。

于是得到的就是"远距加一点模糊"，**不用自己写 shader**。天穹在 pass 里 `depthWrite: false`，深度停在 1.0 → `viewZ = -2000` → CoC 直接拉满，太阳会变成一团软光斑，跟 bloom 叠起来正是标准夕阳做法。

关键前提已经满足：海面远缘与天穹颜色是**刻意做成一模一样**的（`sea-fft.ts:648-655`），两者都在远距离 → CoC 与 bloom 对它们处理一致，**后期不会把那条缝撕开**。这是这个项目现在能安全上后期的原因，值得在 plan 里写明。

参数建议（9:16，竖向 fill rate 只有 16:9 的 56%）：
`focus ≈ 34`、`focalLength 380–450`、`bokehScale 1.0–1.3`。`bokehScale > 2` 会像失焦照片，不适合游戏画面。
另：`dof()` 的参数走 `nodeObject()`（`DepthOfFieldNode.js:572`），**传数字是常量**；想让焦点每帧跟随飞机抖动的距离，必须传 `uniform(...)`。

### 3.5 坑清单

1. **MSAA 会被静默关掉。** `pass()` 不传 `samples` 时用 `renderer.samples`（`PassNode.js:800`）；而 WebGPU **compatibility mode**（老 Android，`!device.features.has('core-features-and-limits')`）会把 `renderer._samples` 强制归 0（`WebGPUBackend.js:262`）→ 你写了 `antialias: true`，但 pass 里一点 MSAA 都没有。**建议：`{ samples: 0 }` + 末尾 `smaa()`**（移动端最划算，省显存省带宽），或桌面显式 `{ samples: 4 }` 并仍用 smaa 收尾。
2. **SMAA/FXAA 需要 sRGB 输入。** 必须 `pipeline.outputColorTransform = false` 且用 `renderOutput(...)` 包一层，跟 FXAA 同理；直接把 `smaa(scenePass)` 接上去会发灰发暗。
3. **`bloom()` 只返回辉光，`dof()` 返回成品。** 一个必须 `add`，一个绝不能 `add`。写反了画面会变成全屏灰雾／失去原图。
4. **`new THREE.PostProcessing(...)` 能用但会 warn**，r183 起已改名为 `RenderPipeline`（`PostProcessing.js` 是兼容子类）。新代码直接用 `RenderPipeline`。
5. **RenderPipeline 只能配 `WebGPURenderer`**（`RenderPipeline.js` 头注释："This module can only be used with `WebGPURenderer`"）。所以 §2.6 那条"兜底改 `forceWebGL: true`"是加后期的前置条件；只有改了，WebGL2 兜底路也能有 bloom/DOF。
6. **每帧 `render()` 无参**（`RenderPipeline.js:130`），要替换掉 `renderer.render(scene, camera)`，不能两者都调。

### 3.6 分档与预算

| 档位 | pass samples | bloom | dof | smaa |
|---|---|---|---|---|
| 桌面 WebGPU | 4 | strength .70 / radius .60 / threshold .82 | focus 34 / focal 420 / bokeh 1.1 | ✓ |
| 移动 WebGPU | 0 | .55 / .55 / .85 + `setResolutionScale(0.5)`（`BloomNode.js:294`） | 关（或 bokeh .6） | ✓ |
| WebGL2 兜底 | — | 现状不做；改了 `forceWebGL` 后同上 | 同上 | ✓ |

粗算（portrait 1440×2560 逻辑像素）：bloom = 1 次高光 + 5 级 mip 模糊，桌面 iGPU 约 2.5–4 ms；dof = 2 次可分离模糊 + 合成，约 1.5–3 ms。**移动端 DOF 是最先该砍的预算。**
降档接口直接复用现有的 `FrameGovernor`：在 `world.applyQuality(high)` 旁边加 `post.setQuality(high)`，`high=false` 时把 bloom 降到半分辨率、DOF 关掉。

### 3.7 一个要现场验证的风险
海面 glint 的 `nearFade = clamp(dist * 0.02, 0, 1)` 本来是压制近处白抹的；bloom 会把这层 sparkle 放大成一片糊光。`threshold 0.82` 大概能挡住，但要真机看图再定；如果糊了，先在 threshold 上往上加，别急着降 strength。

---

## 4. 建议的 plan 修订清单

1. **新增 Task 6.5（P0，最优先）：** webgl2 兜底改用 `WebGPURenderer({ forceWebGL: true })`，删三套并行 GLSL 实现，统一 TSL。这项决定了后面 9 项的工作量和后期处理能否双路。
2. **新增 Task 16：** `src/post.ts` + `main.ts` 接线 + `setQuality` 降档，按 §3 的参数表落地。（用户明确要的东西目前完全不在计划里。）
3. **T10 前置决策：** 在 A/B/C 中选一条写进文档，并同步改 `FLIGHT` 常量与验收（当前验收测不出"永远不会触发"）。
4. **T11：** 半径改 600 或降级 P2；`#e8907a` 改用 `SEA_PALETTE.haze`。
5. **T7 重写：** 删全局量化，改 gradient map + toon 材质；删掉 `quantize3` 断言。（原第 3 条"给 WebGL2 补灯光"已勘误作废——两条路径本来都有灯。）
6. **T12 改性质：** "参数化现有 glint" 而非新增高光项；删恒真断言。
7. **T9 去重：** rig 的 `CAM_FOV_KICK/CAM_BANK_FOLLOW` 改为注入参数，总 FOV 偏移统一 clamp 到 9°。
8. **T15 拆分：** 纯函数测试（aspect/lower-third/safe-area）+ 截图链，别让 vitest import `main.ts`。
9. **T13/T15 前置修 HUD 容器：** `doc.body.append(root)` + `position: fixed; inset: 0` 与 9:16 画框错位。
10. **T8 写明口径：** 风格化 or 加 `vy` 项。
11. 全局约束补一条：**后期处理只在 `RenderPipeline` 上做，禁止在 WebGPU 路引入 `EffectComposer`**（后者只支持 WebGLRenderer）。

---

## 5. 怎么验证（不靠感觉）

- 双后端跑通：`?backend=webgpu` 与 `?backend=webgl2`（`renderer.ts` 的 QA 逃生口），`window.__porco` 能读到 `backend/scene/camera/renderer/world/game`。
- 后期是否真的生效：把 `pipeline.outputNode` 临时换成 `color`（无 bloom）对比帧；或把 `glow.strength` 设 0 截图对比。
- 成本：`renderer.info` + `performance.now()` 包住 `pipeline.render()`，PC 上单帧增量应落在 §3.6 的区间；移动端看 `FrameGovernor` 是否触发降档。
- 接缝：把相机拉到最高/最低、朝向太阳转 360°，检查海天交界是否仍然连贯（这是 e2e 截图，不是单测）。
- `npm run build`（`tsc --noEmit`）会覆盖 `three/addons/*` 的类型路径 —— 记得 `@types/three 0.186.0` 里 display 节点有类型，`RenderPipeline` 需要 `three/webgpu` 导出的类型，别用 `as any` 掩盖（`renderer.ts` 已经在 `any` 上松掉了，新代码别跟着松）。
