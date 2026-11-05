# sea-audit — 哪些还能跑，哪些已经死了

这个目录里同时躺着三个时代的东西（FFT 海 / FBM 色带 / Gerstner 分带表面），
文件名不区分。**动手抓帧之前先看这张表**，别拿一个死的镜像去量一个不存在的 shader。

状态图例与 `docs/superpowers/INDEX.md` 一致。

| 文件 | 状态 | 用途 / 为什么 |
| --- | --- | --- |
| `cdp-capture.mjs` | **LIVE** | 无头 Chromium + 裸 CDP 抓帧。WebGPU 画布在应用内嵌浏览器里到不了合成器，只能走它。`--eval` 把 JS 文件当异步函数体执行，`return` 的对象会被打印 |
| `eval-wind.js` | **LIVE** | 把世界风向投影成屏幕方向，喂给 `band_continuity.py --wind-screen` |
| `eval-lowq.js` | **LIVE** | `qa.setQuality(false)` 在冻结帧里够不到调速器，这是直接扳手（注释里「材质异步重建」已过期：现在只缓动 uniform） |
| `eval-perf-webgpu.js` | **LIVE** | 水面 fragment 成本探针，离屏 RT + 批量斜率 + 隐水对照。协议来自 `fragment-cost-2026-11-05.md`。**必须带 `--browser <Chrome>`**：headless Edge 131 拿不到 WebGPU（退回 webgl2），`?backend=webgpu` 则 QA 钩子起不来。**藏水必须摘场景图，不能设 `visible`**——`bands.update()` 每帧重写它 |
| `light-before-2026-11-05.png` / `light-after-2026-11-05.png` | **LIVE** | Task 5 光照项前后同一机位同一冻结步数的对照帧（`?alt=8&qa=frozen&post=0`，40 步） |
| `band_continuity.py` | **LIVE（只剩 png 模式）** | 分带占比 / 边缘度量。Task 7 的「四带各 > 5%」闸门用它。`--recompute` 已删除，见下 |
| `fragment-cost-2026-11-05.md` | **LIVE** | 本机标定报告 + 冻结协议。文中「仪器坏了」那段已过期（`buildSurfaceMaterial` 现在接受注入的 THREE 命名空间） |
| `skim-shaded-2026-11-05.png` | **LIVE** | 着色后 skim 帧，唯一一张还代表当前实现的画面 |
| `perf-webgpu-2026-11-05.png` | **LIVE** | `eval-perf-webgpu.js` 复测跑通的帧（`?alt=8&qa=frozen&post=0`，Chrome headless WebGPU）。数：有水 3.704 ms / 藏水 3.017 ms @ 4096×7279 |

## 已归档（`artifacts/archive/sea-fft-fbm-era/`）

| 文件 | 为什么死 |
| --- | --- |
| `fbm-readback-probe.js` | `import('/src/sea-fft.ts')` + `/src/sea-fbm.ts` → 两个文件在 `f9a73d5` 删除，当前构建 404 |
| `fbm-diff-map.js` | 同上，且量的 `graph.ridge` 已不存在 |
| `eval-perf-rAF.js`（原 `eval-perf.js`） | rAF 被 vsync 钉在 16.7 ms，看不见 fragment 成本；要对照的 fft/fbm 两个实现都没了 |
| `eval-perf-glfinish.js`（原 `eval-perf-frozen.js`） | `renderer.getContext()` + `gl.finish()` 是 WebGL 路径，`WebGPURenderer` 没有 `getContext()` |

## `band_continuity.py --recompute` 为什么被删

它镜像 `sea-fft.ts` 的 Phillips 谱和 `SEA_BAND_STOPS` 分带模型。那个实现连同
`src/sea-metrics.ts` 一起删了，而现在的着色是**按高度 smoothstep 的 ramp，没有 band
index 这回事**——所以 `--recompute` 会算出极权威、极漂亮的错误数字。

要那段数学就回 git 拿：`git show 4d7f6d3~:artifacts/sea-audit/band_continuity.py`。
`png` 模式在删改前后对同一张 `skim-shaded-2026-11-05.png` 输出**逐字节相同**，
所以那次手术没动到还活着的度量。
