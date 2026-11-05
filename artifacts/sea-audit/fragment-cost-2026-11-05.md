# Sea fragment-cost spike（plan Next action 2，2026-11-05）

## 要回答什么

设计 R2：海是 fragment-bound，M10 估 ~5 M transcendentals/帧，而**没有人量过手机**。着色
（逐像素法线、浪花）在写细之前需要知道每像素的价格。本报告给的是这台机器上的标定，不是手机。

## 测量环境（冻结声明）

- Chrome + WebGPU（`backend=webgpu`），本地 `vite dev`，`?alt=8&qa=frozen`（`elapsed=0`，同一帧反复重绘）
- 屏幕缓冲 453×805、dpr 1；标定用**离屏 `RenderTarget` 4096×7279（29.8 Mpx）**
- **不用 canvas 直接测**：canvas 的 present 会合并未呈现的帧，同一帧连投 32 次仍只算一次的量
  （实测 batch 8/32 斜率 0.26 ms/帧，与 10 倍几何量无关），那次尝试作废，记录在此以免后人重踩
- 测法：`queue.onSubmittedWorkDone()` 每次同步一次太贵（固定 ~5 ms），改成**批量斜率**
  `(t(56) − t(8)) / 48`，取 3 次中位数，测前先跑 6 帧热身
- **对照组**：把六条带各复制 10 份（共 60 个重合的环）塞进场景 → 0.77 ms 变 1.46 ms（×1.9）。
  同步深度测试不会随深度增加，所以这证明**工具确实能看到新增工作量**；重合副本靠 early-z
  只加顶点与提交开销，这也顺便说明几何侧很便宜

## 结果

| 口径 | 总像素 | 水像素 | 整帧 | 水（平涂材质） | 水（真材质） | 场本身 |
|---|---|---|---|---|---|---|
| 出货尺寸 | 0.365 M | 0.232 M | 0.70–0.82 ms | — | — | **测不到**（< 噪声，反复变号） |
| 标定尺寸 | 29.8 M | 19.0 M | 3.010 ms | 3.060 ms | 3.755 ms | **0.70 ms** |
| 全屏平凡四边形 | 13.1 M | 13.1 M | 0.396 ms | — | — | 常数开销 ~0.3 ms/帧横在上面 |

- 水的**几何 + 覆盖**几乎免费：平涂材质只比无海多 0.05 ms。
- 水的**逐像素场**（5 趟 Gerstner 精确高度 + base ramp + crest 色窗）：
  **19.0 M 水像素 → 0.70 ms，即 ~37 ns / 1000 水像素**（≈27 Gpx/s 的场着色）。
- 换算到出货缓冲：0.232 M 水像素 → **~0.009 ms**，相对 16.7 ms 的帧预算是千分之一量级。

## 失败的仪器（必须记下）

想顺带量「每趟波多少钱」，于是从页面里 `import('/src/sea/surface-material.ts')` 现场重建
`trains=0..5` 的材质换上去。结果 2.91–3.08 ms 一条直线，且和**平涂材质**同价——说明那些重建
出来的材质里 `colorNode` 根本没生效（那是另一个模块实例，且只喂了一个 `Color` 构造器当 THREE
命名空间）。**所以这条平坦曲线不是「多趟波免费」的证据，是仪器坏了**。要量每趟波的价格，得让
`buildSurfaceMaterial` 接受外部传入的 THREE 命名空间，或者干脆在 `scripts/` 里跑一个真模块。

## 结论

1. **在这台机器上，海不是瓶颈。** 出货尺寸下整帧 0.7–0.8 ms、水场 < 0.1 ms，60 fps 的预算
   几乎没被动过。设计 M10 担心的「每帧 5 M transcendentals」在这个 GPU 上是个零头。
2. **线性外推（是模型，不是测量）**：手机 GPU 的填充吞吐量级取 1/10，1080×2400 屏约 40% 是水
   ≈1 M 水像素 → 现价 ~0.4 ms；若法线 + 浪花把场的工作量乘 3，约 1.2 ms。相对 16.7 ms 仍宽裕。
   **这个数不能当验收依据**——R2 的「没有人量过手机」依然成立，只是风险从「可能是悬崖」降到
   「大概不是」。
3. **真正省时的杠杆不是 `uTrains`。** 掩码只影响画面（Task 6 审核 I2 已认定它不省毫秒），本
   标定又从另一侧确认：成本跟着**水像素数 × 场求值次数**走。要保手机帧率，先动 drawing buffer
   分辨率，再动「每像素评估几趟波」，最后才是颜色窗。
4. 后续（法线 / 浪花）的预算做法：每个新增的逐像素项，按 ~37 ns/1000 水像素的现价乘系数估算，
   真机复测时沿用本文件的冻结协议（离屏 RT + 批量斜率 + 几何对照）。

## 复测（2026-11-05 晚，仪器已修）

「失败的仪器」那节的病因已经不在：`buildSurfaceMaterial(THREE_NS, opts)` 现在接受外部注入的
THREE 命名空间。同时补了一个按本文件冻结协议写的探针 `eval-perf-webgpu.js`
（离屏 RT + 批量斜率 + **隐水对照**，对照不成立就自报「仪器瞎了」）。

在本机跑通（Chrome headless，`backend=webgpu`，`?alt=8&qa=frozen&post=0`，40 步）：

| | ms/帧 @ 4096×7279 |
|---|---|
| 有水 | 3.704（三次 4.079 / 3.704 / 3.600） |
| 藏水 | 3.017（三次 3.544 / 3.017 / 2.946） |
| **水面成本** | **0.687** |

对照报告里「场本身 0.70 ms」——**两个独立仪器在同一个数量级上对上了**，所以这个数可以当
基线继续用。注意这里的 0.687 是「几何 + 覆盖 + 逐像素场」的总价（藏水只去掉这整块），
不是纯场价。

一个坑记下来：**headless Edge 131 在这台机器上拿不到 WebGPU**（页面退回 `webgl2`，
`?backend=webgpu` 则连 QA 钩子都起不来）。`cdp-capture.mjs` 必须带
`--browser "C:/Program Files/Google/Chrome/Application/chrome.exe"`。

## 复现

```js
// in page, after ?qa=frozen
const THREE = await import('/node_modules/three/build/three.webgpu.js');
const rt = new THREE.RenderTarget(4096, 7279, { depthBuffer: true });
// batch slope: (t(56) - t(8)) / 48, sync with renderer.backend.device.queue.onSubmittedWorkDone()
```

或者直接跑已经封装好上面这套的探针：
`node artifacts/sea-audit/cdp-capture.mjs --browser <chrome> --url "http://localhost:5173/?alt=8&qa=frozen&post=0" --steps 40 --eval artifacts/sea-audit/eval-perf-webgpu.js --out artifacts/sea-audit/perf-webgpu-2026-11-05.png`
