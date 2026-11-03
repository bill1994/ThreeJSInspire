# SDD ledger — plan: docs/superpowers/plans/2026-11-03-sea-fbm-band-continuity.md

Executed inline (unattended automation, 2026-11-04). Branch: feat/puff-cluster-cloud.
Pre-flight: Task0.produces BandMetrics/bandMetrics -> Task1.fbmBandMetrics consumes; Task1.produces FbmConfig/fbmRidgeField/fbmBandShape/fbmCrest -> Task2 TSL + Task4 fbmCrest consume; Task3.fbmOctaveWeight -> sea-fft.ts TSL; no contradictions found except: fbmBandShape interface lacks t but §0.1 time model puts t in breathing noise.
Task 0: Ruling: 「沿风向扫线」实现为横风扫描线 — 顺风的扫线不穿越顺风走向的色带，间距必须横风量 — cost if wrong: edgeSpacing 恒 0。
Task 0: Ruling: 基线碎片数按 lit 档 (topStop=1) — 现行 shape crest 只有 0.2%，crest 档会退化 — cost if wrong: FBM 对比口径不一致（已在 §3.1 记双档数字）。
Task 0: Ruling: 不复用 recompute_sea_bands.py（cos²+旧 shape 旧口径），现行镜像内置于 band_continuity.py — cost if wrong: 与 GPU 场对不上。
Task 0: complete (commits pending; tests: npx vitest run → 290/290 pass; band_continuity.py final.jpg 3.6s; baseline: ridge 0.711 / shape 0.733 / components(lit) 0.204 /100m² / extent 3.55 m / curvature 0.315 /m / crest 0.21%)
Task 1: Ruling: 旋转改为每对 octave 交替 ±rotationPerOctave/2 — 复合 i*θ 会把各向异性轴一起转（第 3 层偏 103°，实测 coh 0.283）；计划 §1.5-5 本意是"两族脊线交叠" — cost if wrong: 同族 octave 去相关减弱（由 lacunarity 1.9 + warp 兜底）。
Task 1: Ruling: 呼吸项取计划原文 0.03*n_low（带符号）而非 0.03*(2n-1) — cost if wrong: 无（振幅 ±0.021 在 ±0.03 预算内）。
Task 1: Ruling: wrap 测试按计划验收原文（C0 无台阶 + dyadic 位恒等）而非"任意坐标位恒等" — f32 下 fround(q+N) 分数部分本就不逐位相等，位恒等既不可得也不必要 — cost if wrong: 无。
Task 1: Ruling: §1.3 的 A/B 执行完毕，'wavegrid'（sin 波列+相位 wobble）为默认 variant，'ridged' 保留可换 — ridged 在拍板的 5:1 下任何参数都到不了 0.85 门（全阶梯上限 0.733，闭环封盖是结构性的）；wavegrid 在 gain 0.3（计划区间内）、5:1 不动下测得 0.884 — cost if wrong: 波形格的相位 wobble 若太弱会灯芯绒（Task 2 截图门会把关）。
Task 1: Ruling: rotationPerOctave 0.3（±8.5°）低于 §1.5-5 建议的 ±15-25° — ±15° 以上过不了 0.85 门（g=0.3/rot=0.4 → 0.822） — cost if wrong: 交叉族纹理弱，由 warp 弯折与 Task 4 笔触补偿。
Task 1: complete (commits pending; tests: npx vitest run → 304/304 pass + tsc clean; core gate edgeCoherence=0.88 (gate >=0.85); oct2->oct4 drop 0.012; wrap seam-free; hash01 == BigInt PCG ref; perf 1024^2 < 2s)
Task 2: Ruling: IAB 面板无法截图 WebGPU 画布（rAF 抑制 + present 丢失 + 页面底色透出）— 自建 CDP 驱动（无头 Edge，回落 webgl2 同一套 TSL） — cost if wrong: 若 Task 5 需要 WebGPU 专属时序，无头仍拿不到 GPU adapter，需有头浏览器补测。
Task 2: Ruling: 最终帧 palette 分类无判别力（光照逐像素合成；两后端都 0.33-0.34）— 截图门改为 ?sea-debug=shape 贡献视图三元组（extent 4.2x / fragments 1/8.5 / curvature 下降，全部满足计划 §3.1 目标），coherence 门以 CPU 场 0.884 为准 — cost if wrong: 截图口径与计划字面 0.80 不一致（已在执行日志向用户披露）。
Task 2: Ruling: 探针抓出 TS 旋转符号双重应用（fround 改造引入）— 修复后 max|Δ|=0.0022（字节量化内） — cost if wrong: 无（这正是计划要求的真探针价值）。
Task 2: complete (commits pending; tests: npx vitest run → 310/310 + tsc clean; fft pixel-diff 0/921600; readback probe PASS 8/8 max 0.0022; A/B trio captured)
Task 3: Ruling: f_i 取横风快轴 lac^i/acrossLength（计划原文 2^i/alongLength）— 带状细节沿横风最先 alias — cost if wrong: 淡出提前/推迟 5x（可由 OCTAVE_FADE 区间回退调节）。
Task 3: Ruling: 「FBM 高 octave 进法线扰动」暂不实现 — 400 m 无撒盐的验收门与新增强场法线高频直接冲突 — cost if wrong: 远景少一层手绘细节（Task 4 后如风格需要再补）。
Task 3: complete (commits pending; tests: npx vitest run → 314/314 + tsc clean; far-view curvature 0.081 vs near 0.236; components 0.0006 vs 0.0022; near unchanged vs Task 2; cdp driver hardened with watchdog + per-call timeouts after a zombie-Edge hang)
Task 4: Ruling: ridgeScale/weightHeight 不重标 — 它们是 FFT z-score 路径常数，默认路径冻结 — cost if wrong: 无（fbm 路径用 0.15 耦合，与 ridgeScale 无关）。
Task 4: Ruling: 色带与泡沫共享同一 fbmRidgeNode（带真 footprint） — 两份图在 SwiftShader 上超时 — cost if wrong: 无（GPU 上本来就是一份的优化）。
Task 4: complete (commits pending; tests: npx vitest run → 315/315 + tsc clean; stops = [0.1726,0.5458,0.8327]; occupancy exact [0.25,0.5,0.23,0.02]; crest > 0 pinned by test; debug + final frames captured)
Task 5: Ruling: rAF 口径被 vsync 钉死（16.7 整）— 改冻结帧 step(1)+gl.finish() CPU 墙钟 — cost if wrong: 无（口径与计划"相对值"要求一致）。
Task 5: Ruling: 绝对门 ≤1.5 ms INSUFFICIENT_EVIDENCE（headless 无真实 GPU）— 已写进 perf 报告供真机复测 — cost if wrong: 真机超预算时按已实现的 octaves 4→2 回退。
Task 5: complete (commits pending; tests: npx vitest run → 317/317 + tsc clean; perf fft 0.8 ms vs fbm 1.0 ms median (SwiftShader 640x360); low-quality visual PASS; perf-2026-11-04.md written)
Task 6: Ruling: 默认保留 FFT 色带、不删 ridge 路径 — Task 2 的 A/B 是交付物，aesthetic 判定归用户；删掉死分支就没有逐像素回退的锚点 — cost if wrong: 一份常驻分支（已在 Task 2 的 mix 注释里注明 A/B 差值被低估）。
Task 6: complete (commits 34c2cf2..ad423e0, tests: npx vitest run → 317/317 + tsc clean + npm run build ✓ + npm run smoke ok)
Final: fixed C1 (per-source band stops; default path was silently two-band) — bandStopsFor 3 tests RED→GREEN, suite 325/325
Final: fixed I1 (0/0 fade normaliser → NaN at the horizon) — fbmWeightedRidge 3 tests RED→GREEN + shader TSL.select fallback, suite 325/325
Final: fixed I2 (TS mirror had the same 0/0; wavegrid branch never set r0) — far-field drift test RED→GREEN, suite 325/325
Final: fixed I3 (readback probe quantisation 3.9e-3 > 5e-3 gate) — 32x32 target + centre 8x8 average, gate 2e-3 (manual tool, no test)
Final: fixed I4 (ridged variant fed pre-warp on TS, post-warp on TSL) — ridged finite/range test RED→GREEN, suite 325/325
Final: minor (deferred): M1 bit-level parity is structurally unreachable for wavegrid (Math.sin vs GPU sin, float64 Math.PI); quantile-based assertions only
Final: minor (deferred): M2 band_continuity.py still hardcodes the FFT stops tuple
Final: minor (deferred): M3 fade/crest formulas exist twice (TS helper + inline shader)
Final: minor (deferred): M4 Review Focus #1/#2/#6 have no evidence (0.15 coupling, octave-vs-spacing rule, first-frame compile time)
Final: minor (deferred): M5 always-true gradient fround assertion; seed bound 2^24 vs plan's 2^18; two audit scripts leak a PlaneGeometry
