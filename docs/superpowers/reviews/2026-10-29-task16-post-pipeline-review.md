# Phase-B Task 6.5 / 6.6 / 16 — 执行前审核（rev.3）

**被审核文档：** `docs/superpowers/plans/2026-10-29-phaseB-nine-improvements.md`（Task 6.5 / 6.6 / 16）
**审核基准：** 仓库实际代码（three 0.186.0，`three/webgpu` + `three/tsl`）+ `node_modules/three` 源码
**审核时间：** 2026-10-29
**结论：** 可以照做，但有 1 处会让 SMAA 质量下降的技术错误、1 处批次依赖被漏写。已在实现中修正，其余按原文执行。

---

## 0. 结论速览

| 项 | 判定 | 处理 |
|---|---|---|
| Task 6.5 调色板抽取 | ✅ 可执行 | 按原文执行 |
| Task 6.5 的测试断言 | ⚠️ 与"原样搬运"自相矛盾 | 改断言，值不动 |
| Task 6.6 后端统一 | ✅ 可执行 | 按原文执行 |
| Task 6.6 是 Task 16 的前置 | ⚠️ plan 只说"16 先落"，未说明 6.6 是硬前置 | 已按 6.5 → 6.6 → 16 顺序执行 |
| Task 16 节点链 | ❌ `smaa(renderOutput(...))` 是 FXAA 配方 | 改为 `smaa(image)`，见 §2 |
| Task 16 其余 | ✅ 可执行 | 按原文执行 |

---

## 1. Task 6.5：测试断言与"值不改一个字符"冲突

plan 的 Step 3 要求"值不改一个字符"，但 Step 1 的测试断言：

```ts
const HEX = /^#[0-9a-f]{6}$/i;
for (const css of [...Object.values(SKY_PALETTE), ...Object.values(SEA_PALETTE), ...Object.values(CLOUD_PALETTE)]) {
  expect(css).toMatch(HEX);
}
```

实际值不是同一种形态：

- `SKY_TOP/HORIZON/SUN` 是 CSS 字符串（`'#6b4fa1'`，`sky-webgpu.ts:19-21`）
- `SEA_PALETTE` / `CLOUD_PALETTE` 是**数字**（`0x1a1a38`、`0x4a3370`），因为消费方签名要 number：
  - `sea-fallback.ts:171` `function glslColor(hex: number): string`
  - `sea-fft.ts:554` `function col(hex: number): THREE.Color`

按 plan 的断言，要么测试必红，要么把值改成字符串（同时破坏两个 `hex: number` 消费者）。

**处理：** 保留数字原值，测试改为"两种形态都能确定性 round-trip 成 6 位 hex，且总数 14"。这条断言仍然挡得住 8 位 ARGB 和拼错的短值，只是不再强迫统一类型。

## 2. Task 16：`smaa(renderOutput(...))` 是错的（唯一实质技术错误）

plan 的 Step 3（以及 review §3.2 / §3.5②）写：

```ts
pipeline.outputColorTransform = false;
pipeline.outputNode = smaa(renderOutput(image));
```

理由是"SMAA/FXAA 需要 sRGB 输入"。**SMAA 不需要，只有 FXAA 需要。**

证据：

1. `node_modules/three/examples/jsm/tsl/display/SMAANode.js:729` —— `smaa()` 是线性空间滤波器，官方 addons 文档与 `threejs-postprocessing` skill 的 Pass Order 都写明："FXAA needs sRGB input so it follows OutputPass, while SMAA works in linear space and must run before it."
2. `node_modules/three/src/renderers/common/RenderPipeline.js:190-201`：`outputColorTransform === true`（默认）时，pipeline 会**自动**把 `outputNode` 包进 `renderOutput(outputNode, toneMapping, outputColorSpace)`：

```js
let outputNode = this.outputNode;
if ( this.outputColorTransform === true ) {
    outputNode = renderOutput( outputNode, toneMapping, outputColorSpace );
}
```

所以正确链路是 `smaa(image)` + 保持默认 `outputColorTransform`，由 pipeline 在 SMAA **之后**做 tone mapping 与 sRGB 编码。

按 plan 的写法会怎样：先手动 tonemap+编码，再在 **sRGB 空间**跑 SMAA 的边缘检测。画面能出（不会像 review 担心的"发灰发暗"），但 SMAA 的 luma 阈值是按线性亮度调的，日落这种高动态范围场景里边缘检测会变钝、漏检，抗锯齿质量下降——属于"看起来能跑、实际上白装了 SMAA"。

**处理：** `pipeline.outputNode = smaa(image)`，不开 `outputColorTransform=false`，不包 `renderOutput`。其余（`bloom()` 必须 add、`dof()` 绝不能 add、`pass({samples:0})`）与 plan 一致。

## 3. 批次依赖：6.6 消费 6.5，16 消费 6.6

- Task 6.6 的 Interfaces 明确写 `Consumes: src/palettes.ts（Task 6.5）`，缺 6.5 无法开工。
- Task 16 的 `?backend=webgl2` 路径要跑后期，前提是 6.6 把兜底从经典 `WebGLRenderer` 换成 `WebGPURenderer({ forceWebGL: true })`——`RenderPipeline` 只认 `WebGPURenderer`。

所以"6.6 + 16"这个批次实际是 **6.5 + 6.6 + 16**。

## 4. 其他与原文不一致处（执行时按实际代码处理）

- `initSunsetSkyTSL` 实际签名是 `(THREE, scene)`（`sky-webgpu.ts:55`），plan 写 `(scene)`。
- `main.ts` 把 `backend` 也传给 `initGame`（`main.ts:123`），plan 的 Files 列表未列 `game.ts`；实际 `game.ts` 内没有按 backend 分支，保持传参即可。
- `clouds-compute.ts:12` 从 `clouds-fallback` 引 `CLOUD_PALETTE`，plan 只提到移动 `CloudHandle`；两处一起改。
- 删除三个 GLSL 文件后，`scripts/smoke.mjs` 的 `modules` 数组必须同步（plan 已提及）。

---

## 5. 执行结果

| Task | 提交 | 验证 |
|---|---|---|
| 6.5 调色板单一来源 | `65a592a` | 88/88 测试、`tsc` clean |
| 6.6 双后端统一到 TSL | `4c0ed16` | 80/80 测试、`tsc` clean、`build` ok、`smoke ok` |
| 16 bloom + 远距模糊 + SMAA | 见本次提交 | 88/88 测试、`tsc` clean、`build` ok、`smoke ok` |

代码层面 `sea-fallback.ts`(8.5K) / `clouds-fallback.ts`(7.6K) / `sky-sunset.ts`(2.2K) 三套并行 GLSL 已删除，双后端现在共用一条 TSL 路径。

## 6. 未验证项（必须由人工补）

截图验收没做，原因是浏览器不可用（DSH 内置浏览器缺少 Electron 二进制，`npx install-electron` 未安装），因此以下三条**没有任何证据**：

1. 太阳是否有光晕、海面 glint 是否被 bloom 放成糊光（风险见 review §3.7，先调 `bloomThreshold` 再动 `bloomStrength`）。
2. 机身是否始终在焦内（`focusDistanceFor` 的 clamp 区间 [12,60] 只是按 `CAM_DISTANCE ≈ 30` 推的，没有真机图）。
3. `?backend=webgpu` 与 `?backend=webgl2` 是否逐像素级接近。

人工验收命令（plan Step 5 原文）：

```powershell
npm run dev
# 打开 http://localhost:5173/?backend=webgl2 与 /?backend=webgpu 各截一张 390x844
# 对比：① 太阳光晕 ② 机身清晰、远处云海糊 ③ 字幕/HUD 不发白
# 若 HUD 发白：检查是否重复做了 sRGB 转换（现在 pipeline 统一负责，不手动 renderOutput）
# 若整屏灰雾：检查 dof 是否被误加（dof 返回成片，绝不能 add）
```

`window.__porco` 暴露了 `backend` / `postSupported` / `renderer`，可在控制台核对后期是否真的挂上。
