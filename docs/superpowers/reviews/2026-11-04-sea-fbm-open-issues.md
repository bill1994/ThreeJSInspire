# 海面 FBM 色带 — 未解决问题清单

> 计划：[2026-11-03-sea-fbm-band-continuity.md](../plans/2026-11-03-sea-fbm-band-continuity.md)
> 执行记录（21 条 ruling + 完整台账）：[2026-11-04-sea-fbm-band-continuity-execution.md](2026-11-04-sea-fbm-band-continuity-execution.md)
> 状态：Task 0-6 完成，独立 review 的 1 Critical + 4 Important 已修并带测试。**325 测试全绿。**

## 一、需要你拍板的（不是 bug，是取舍）

### 1. `?sea=fbm` 切不切

**默认仍是 `?sea=fft`**（旧色带）。开关是交付物，aesthetic 判定归你。

| 看什么 | 路径 |
|---|---|
| FBM 色带 | `artifacts/sea-audit/fbm-final-2026-11-04.png` |
| 默认路径（修 C1 后应恢复四档） | `artifacts/sea-audit/fbm-ab-fft-AFTER-2026-11-04.png` |
| 两版并排 | `artifacts/sea-audit/fbm-ab-*.png` |
| 色带调试视图（去掉光照/雾/笔触） | `?sea=fbm&sea-debug=shape` |

切之前建议先确认：FBM 侧的**色带与浪形是否对得上**（Review Focus #1 无证据，见下面 M4）。

### 2. 性能绝对门没验

`perf-2026-11-04.md` 标了 `INSUFFICIENT_EVIDENCE`：headless 只有 SwiftShader，没有真实 GPU。
实测相对值 **+25%**（软渲染 640×360），真机预计更小但未验证。

**真机复测沿用该文件的冻结协议**（`?qa=frozen` + `step(1)` + `gl.finish()`）。超预算的回退已实现：`setQuality(false)` → octaves 4→2。

## 二、Review 判为 Minor、未修（5 条）

| # | 问题 | 影响 | 建议 |
|---|---|---|---|
| **M1** | 「TS↔GPU 位级一致」**结构性做不到**：`Math.sin` vs GPU `sin`、float64 `Math.PI`。实测 0.0022 是量化噪声，不是 parity | 无可见影响 | 后续 parity 断言改成**分位口径**，别再追求逐点相等 |
| **M2** | `artifacts/sea-audit/band_continuity.py` 第 54 行还硬编码着 FFT 的 stops `(0.44, 0.56, 0.68)` | 重跑 `--recompute` 会给出着色器已不画的配置的数字 | 改成按 `--source fft\|fbm` 选 stops |
| **M3** | fade/crest 公式**存在两份**（`sea-fbm.ts` 的纯函数 + `sea-fft.ts` 的内联），只有 TS 侧被测 | 改 TS 不会影响 GPU，纯函数测试会给假绿 | 长期应收敛成一份，或加 readback 覆盖 |
| **M4** | Review Focus 三条**无证据**：① 色带与几何的 0.15 耦合没测；② 「最高 octave 波长 ≥ 3× 色带间距」没有数字（`edgeSpacing` 算了但没断言）；③ 首帧编译 ≤100 ms 没测 | 潜在回归无人看守 | 优先补 ②（纯函数，最便宜） |
| **M5** | 小项：`Object.is(FBM_GRADIENTS[i], fround(...))` 恒真；seed 上界测试是 2²⁴ 而计划写 2¹⁸；`fbm-diff-map.js` / `fbm-readback-probe.js` 各泄漏一个 `PlaneGeometry` | 无 | 顺手清理 |

## 三、计划里被证伪的两条假设（已记录，供下次写计划参考）

1. **ridged FBM 到不了 `edgeCoherence 0.85`**——实测上限 0.733，闭环封盖是结构性的。改用计划 §1.3 的 wavegrid 备选（0.884）。`ridged` 变体保留可换，但它的 TS/TSL 一致性只由一条 finite/range 测试护着。
2. **rAF 帧间隔测不到片元成本**——被 60 Hz vsync 钉死在 16.7 ms。改用冻结帧 `step(1)` + `gl.finish()`。

## 四、已修复的（review 记录，便于回溯）

| # | 问题 | 修法 | 提交 |
|---|---|---|---|
| **C1** | Task 4 把全局 `SEA_BAND_STOPS` 改成 FBM 标定，`shapeFft` 还用旧场 → **出厂默认被静默切成两档**（deep 0% / crest 0% / mid 77%），回退锚点失效 | 拆 `SEA_BAND_STOPS_FFT` / `_FBM`，按 `uBandSource` 选，`bandStopsFor()` 3 条测试 | `4b3da98` |
| **I1** | 逐层淡出全到 0 时 `sum/norm` = 0/0 → NaN，地平线附近可达（60 m/px ≈ 512 m） | 退回最粗一级（`fbmWeightedRidge` + shader `TSL.select`），3 条测试 | `4b3da98` |
| **I2** | TS 侧 `fbmRidgeField` 有同款 0/0，且 wavegrid 分支没记 `r0` | 同一兜底 + 远处 occupancy 漂移钉成测试 | `9384ab0` |
| **I3** | readback 探针 4×4 8-bit，量化 3.9e-3 **大于** 5e-3 门 → 系统性误差也能 PASS | 32×32 + 中心 8×8 平均（噪声 ~4.9e-4），门收到 2e-3 | `9384ab0` |
| **I4** | `variant: 'ridged'` 的 TS 喂 pre-warp、TSL 喂 post-warp，第 2 层起是两个场 | TS 改 post-warp + finite/range 测试 | `9384ab0` |

## 五、复现与验证

```bash
npx vitest run                      # 325 tests
npx tsc --noEmit
npm run build && npm run smoke

# 色带连续性指标（近场/远场）
python artifacts/sea-audit/band_continuity.py --recompute
python artifacts/sea-audit/band_continuity.py --image artifacts/sea-audit/fbm-final-2026-11-04.png

# TS↔GPU 一致性（需有头浏览器 + ?sea=fbm）
node artifacts/sea-audit/cdp-capture.mjs --url 'http://localhost:5173/?sea=fbm'
# 探针脚本：artifacts/sea-audit/fbm-readback-probe.js（页面内执行）
```

## 六、下一步建议（按性价比）

1. **补 M4-②**（`edgeSpacing` 断言）——纯函数，半小时，补上「最高 octave 波长 ≥ 3× 色带间距」这条硬规则
2. **真机复测性能**——`perf-2026-11-04.md` 的协议现成
3. **看图决定 `?sea=fbm`**——这是唯一需要审美判断的
4. 顺手清 M2/M5
