# Post pipeline renders a flat frame on DOF (2026-11-01)

## 症状

桌面预设（`POST_HIGH`，`dof: true`）下，整帧输出是一块均匀的棕褐色，没有任何几何体、海面或天空结构。`?post=0` 同一场景同一时刻渲染正常。

- 复现：`npm run dev` → `http://localhost:5199/?qa=frozen&alt=60` → `__porco.qa.step(720, 1/60)` → 截图。
- 对比：`?qa=frozen&alt=60&post=0` → 场景完整（云、海、机身、天穹都在）。
- 截图体积是第一个信号：`post=1` 49 KiB（纯色），`post=0` 422 KiB（真实画面）。

## 隔离结论

把 `src/post.ts:55` 的 `dof: true` 临时改成 `false`（管线其余照旧：bloom + SMAA + tonemap），画面**立刻恢复**，449 KiB。

所以嫌疑落在 `dof()` 这一级，不在 `bloom()`、`smaa()`、`scenePass()` 或 `pipeline.outputNode` 的接线上。

## 已排除

- 调用签名没错：`three@0.186.0` 的 `examples/jsm/tsl/display/DepthOfFieldNode.js:572` 是
  `export const dof = (node, viewZNode, focusDistance = 1, focalLength = 1, bokehScale = 1)`；
  `src/post.ts:161` 的 `dof(lit, viewZ, focus, focal, bokeh)` 与之逐位对齐。
- 不是"环回读到空纹理"那种接线错误——`post=1` 的画面颜色**是场景的平均色**，说明采样到了真实内容，只是被摊平成均值。

## 环境（可能是关键变量）

- Chrome 152 / Electron 44.7.2，`three@0.186.0`（r186），WebGPU 后端。
- 适配器：`vendor: amd`, `arch: rdna-1`；WebGL2 侧同类信息是 `ANGLE (AMD, Radeon RX 5700, Direct3D11)`。
- 同一份代码在维护者的机器上（`artifacts/cloud-audit/protocol/*.png` 那批 1384x797 冻结帧）是**正常**的，所以这不是"代码从来就坏"，而是"在这块 GPU / 这个 Chrome 上坏"。

## 待查方向（未验证）

1. `DepthOfFieldNode.js:407` 的 64 抽样 `Loop` 在 D3D12/AMD 上的展开——驱动级别的着色器编译退化成常量输出是这类"整帧均值"最常见的原因；先用 `bokehScale: 0.6`（`POST_LOW`）与 `0` 各跑一次做二分。
2. `viewZ` 的来源（`src/post.ts` 里 `scenePass.getViewZNode()` 一路）在这条路径上是否拿到有效深度；如果 `CoC` 恒为 1，64 抽样会退化成"面积平均"，与观察到的纯色一致。
3. 把 `dof()` 换成恒等节点（`dof(lit, ...)` → `lit`）后逐级加回 bloom / SMAA，确认退化是加性的还是首次出现即全平。

## 对量测的影响

本机的帧级验收（海 S1/S3/S4、云 T2–T4、天穹 K1–K3、评分卡 SC1–SC6）**全部无法进行**，直到这条修好——`?post=0` 的帧与原冻结帧不同口径（没有 bloom / DOF / tonemap 顺序一致），拿它比 `sea_value_mean` 之类的绝对值没有意义。

在修好之前，能推进的只有 CPU 侧复算与常量/注释一致性（S1、S2、K5、T5 已按此完成）。
