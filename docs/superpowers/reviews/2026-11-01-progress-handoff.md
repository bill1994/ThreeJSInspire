# 2026-11-01 — 进度交接（推送前注记）

这一批 8 个提交把「尺子」做完、把两处显性缺陷止血，并在海面饱和上卡住一个明确的矛盾点。
留给下一次会话的第一件事写在最后一节。

## 1. 已落地

| 提交 | 内容 | 验证 |
| --- | --- | --- |
| `020a857` | 审计脚本收敛成 `audit.py` 单入口，摘掉 scipy，状态映射统一到 `states.py` | `audit.py --parity` PASS 102/0 |
| `40785e6` | 长涌域加种子盐（S2）+ toon 分档断点下移（S1）；补 `heightField` / `measureCombinedRms` | RMS 0.4733 → 0.3401；`lit` 面积 0.0077 → 0.0954；`crest` 0 → 0.0132 |
| `45e7c37` | 五份审计文档回填 S1/S2/K5/T5 完成状态；记录 DOF 整帧纯色现场 | — |
| `01d74d0` | DOF 六个 RT 在首次编译前按 drawingBuffer 尺寸定型 | 首帧 std 0 → 55.7，不同亮度值 1 → 536 |
| `f2ddb50` | DOF 复盘文档写清根因与被证伪的两条假设 | — |
| `f1973e0` | `TOON_RAMP` 背光档压暗，机身与日晕分离 | 机身/背景色差 28 → 71（满量程 765） |
| `deaba66` | 四态冻结帧首次完整验收（run 1） | 见下节 |
| `c2d027b` | 补齐 K3 / T4 口径，验收文档定稿 | 见下节 |

测试门：`npx vitest run` 26 files / 264 tests；`npx tsc --noEmit` 干净；`audit.py --parity` PASS。

## 2. 冻结帧验收（run 1）结论

口径：`?alt=<ALT>&qa=frozen`，隐藏 HUD，步进与出帧分处不同宏任务（后处理链对这个顺序敏感，
两个顺序各自稳定但结果不同，哈希：`2fd3aafece46` 同任务 / `647b608a6f7c` 跨任务）。

**通过**：海 S4（`sea_sparkle_rel` 0.06049 → 0.02204）。

**未通过**（按缺口排序）：

1. 海面饱和 `sea_sat_mean ≤ 0.55`：四态 0.631 / 0.656 / 0.630 / 0.703，全 ✗。
2. 太阳路峰值 `sunroad_ratio 2.4–3.0`：四态 1.44 / 1.57 / 1.06 / 2.02，全 ✗。
3. 天穹 `edge_strip ≥ 0.035`：A / B / C 都是 **0.0000**（ref-01 0.0571）——不是结构弱，是没有结构。
4. 天穹暖色彩度 `C*med ≥ 38`：四态 20.1–29.3（ref-01 45.5）。
5. 天穹亮度梯度**方向反了**：`value_swing_strip` 参考 +0.135，四态 −0.048 … −0.177（地平线比天顶亮）。
6. 云 `coverage 0.45–0.58`：0.277；`cloudHF` 参考 0.005，A 0.000 / D 0.001。

## 3. 卡住的点：海面饱和的根因

> **2026-11-02 已解**：这里的"凸包矛盾"是量测假象，管线一直是忠实的。
> 结论、公式与复现见 `2026-11-02-tonemap-hull-resolution.md`，工具是
> `artifacts/cloud-audit/tonemap_unfold.py`。下文保留原始记录。

上一轮记录过 A-cruise 近场水是 `#261858`（H 253 / S 0.727 / V 0.345）。本轮做了两组对照：

- **隐藏海面 mesh**：底部变成 `#f2985e`，即 `SEA_PALETTE.haze`（`#ff9a5a`）只差色调映射压暗 →
  管线对亮部忠实。
- **把 deep/mid/lit/crest 全换成 `0x808080`**：水面渲染成 `#757575`，S = 0.000 → 管线对灰忠实，无额外染色。

因此矛盾是硬的：`src/sea-fft.ts:699-782` 的颜色链只有 `mix` 与 `add`，输入全部来自 `SEA_PALETTE`，
输出必须落在这些颜色的凸包内；而 `deep` 的线性 G（0.0253）是所有调色板色里最低的，实测像素的线性
G 是 0.0088 —— **在凸包外**。B 通道又几乎分毫不差地等于 `deep`（0.0953 vs 0.0976）。

即：B 像单次 sRGB 解码，G 像被额外压掉约 65%。已排除加性项（fresnel / glitter / foam / haze 都是
凸组合或加法，只会降饱和）、DOF、SMAA、bloom（阈值 0.82）、fog（`material.fog = false`）。

**没有动调色板**：在根因未知时改 `SEA_PALETTE` 只能让数字落进门槛，V 和 hue 会一起漂，而且那一级
仍在，下一次重采就会翻回去。

## 4. 下一次会话的第一件事

> **已作废**：单变量实验不用做了，它只会把一个假象解释成另一个假象。实际执行的是
> "求逆色调映射后重新拟合凸包"，见 `2026-11-02-tonemap-hull-resolution.md` §2。
> 下一步变成一次美术方向拍板（同文 §6）。

单变量实验：**只把 `SEA_PALETTE.deep` 改成纯红，其余不动**，按 run 1 的口径重采 A-cruise，量近场。

- 近场变红 → `deep` 确实是底色，矛盾在还没读到的一级（优先查 post 的输出链，不是 sea 着色）；
- 近场仍是暗紫 → 有东西绕过了 `SEA_PALETTE`，直接从那里定位。

定位之后再谈海面饱和的结构性改造，顺序仍按：海面饱和 → 太阳路峰值 → 天穹（K3 与梯度倒置同根）
→ 云 T1/T4。

## 5. 复现命令

```
python artifacts/cloud-audit/audit.py --parity
npm run dev -- --port 5199 --strictPort      # 浏览器开 http://localhost:5199/?alt=60&qa=frozen
npx tsc --noEmit && npx vitest run
```

冻结帧与 `measure.json` 在 `artifacts/cloud-audit/protocol-2026-11-01/`；采集契约在
`artifacts/cloud-audit/protocol/capture-protocol.json`。
