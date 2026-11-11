# P1.5/P2 验收评审（Task 8 + Task 9）

- 日期：2026-11-11；分支 `feat/dome-cloud-volumetric`；基线 `0396032` + 本次工作树。
- 采集：`artifacts/dome-audit/capture_p15_p2_accept.mjs`，`?pos=0,240,-300` 竖条 434×772，
  9 tab 16 帧（soft 高/低 on/off @step0/1800 ＝8，flat 高/低 t0/t30＝4，
  sunoff 高/低＝2，Task 8 nopost soft/high-flat＝2），sidecar
  `capture-p15-p2-accept.json`。
- 量具：`artifacts/dome-audit/measure.py`（P1.5/P2 版：blob/edge_grad/row_peaks/sun-diff；
  旧 coverage/tone_span/banding_flips/drift 口径不变）。
- 质量：`npx tsc --noEmit` 0 error；`npx vitest run` 53 文件 540/540 PASS。

## 结论

- **Task 8（DOF 远端钳制）：通过。** 三证据：`src/post.ts` `DOF_FAR_VIEW_Z=-180` +
  `viewZ.max()` 钳制（云与远海 CoC 1.0→~0.1，150 m 内海面与 12–60 m 焦点 DOF 不动）；
  `src/post.test.ts` 3 断言；flat-high post=1 帧云带边界干净 posterized、无远端抹边。
  注：nopost 像素对（soft 38.1%/flips115、flat 14.0%）**判无效**——off 帧是 post=1 档，
  跨 post-tier 比较混入全局 tonemap/vignette 与未 tonemap 海面条纹，不能隔离 DOF。
- **Task 9（验收矩阵）：通过，带 3 条记录级观察项**（见门 6/备注，不阻塞）。
- **低档穹顶消失 bug：修毕。** 现象→根因→修复见 §低档 bug。
- **R17：关闭。** `main.ts` 头注释已重写（"海已删除"句无残留）；`qa.ts` nochop 文档已是正确行为；
  同义过期句残留在 `src/sea/material.test.ts:205`，本次已修正（chopOverride 钉住后换档不失效）。
- **R18：仍开放**（门 4"暗底"视觉语言，待对照 `ref-01-sunset-glide.png` 拍板）。

## 门 1–7 判定

| 门 | 帧对 | 结果 | 判定 |
|---|---|---|---|
| 1 soft on/off | high 28.272%（目标 28.363±3）/ low 31.143% | tone_span 99.76/97.47 | 通过 |
| 2 flat on/off | high 24.404% / low 24.286%，tone 63.88/64.87，flips 1/1 | 与 soft 同量级 | 通过 |
| 3 drift | high 11.391 / low 12.678（P1 基线 13.003 同量级） | 旧 2–12 区间已废，以 P1 基线为准 | 通过 |
| 4 sunoff 非零 | high sun_diff 51.195 frac 0.9982 / low 42.509 frac 0.999 | 天空行强响应 | 通过 |
| 5 soft/flat 基本不变 | high 28.3/24.4，low 31.1/24.3 | 同量级，无坍塌 | 通过 |
| 6 banding 不劣化 | 天空行 flips 两档皆 0；low-soft 9 flips **全在 y360–436 海面反射行**（海带幅值 low 5.09 vs high 1.71，天空 veil low 58.97） | 穹顶 march 壳层无条带；海面反射低档 shimmer 记观察项（海面档位特性，非穹顶） | 通过+观察 |
| 7 perf | HIGH p95 16.8 < 24 ✓（boot 档 assert=high）；LOW p95 16.8 < 33.3 ✓（assert=low）；600 帧 live 窗口零掉帧 | 本机桌面 1384×772；frameStats 测墙钟帧间隔，只能证无持续卡顿，移动端 ≥30fps 需真机 | 通过+备注 |

分布门（新增量具，记录口径）：low-soft blob=3（目标 3–8 ✓），high-soft blob=1——
掠射角下 veil 连成一片，属相机/连通性口径失配，**不为量具回调 Task 3 已冻结视觉**；
edge_grad_p95 high 11.08 / low 12.54；row_peaks high 10 / low 31 / flat 10–12 ✓。
flat drift 24.1（两档一致）：flat 量化使 band 边界随漂移翻转，属 flat 本身特性，记录。

## 低档 bug（Task 9 采集撞见）

- 现象：low-soft on/off coverage 0.117%，天空行 mean|d| 0.1（高档 83.21%/61.36）——
  低档整层 veil 消失，非 post/海面混淆（天空行隔离证伪）。
- 排查：steps 28→16 被排除（`{steps:28,oct:1}` 与 low-on 逐位相同 sha `7fdff2d4`）；
  `{steps:16,oct:2}` veil 回来（31.072%，天顶均色 ≈ 高档）——杀手是 `uOctaves` 值分的
  light 分支。veil 剖面天顶最强（rows0–50 mean|d| 137.99）＝ slab（排除 horizon patch）；
  `LoopNode`  bound 是 live uniform（`LoopNode.js:346/182`），排除" baked loop"假说。
- 根因：P1 单探针分支在掠射角恒自阴影——120 m 探针落点 deck 密（`DENSITY_SCALE=0.038` token
  增益下 trans≈0），ambient≈ 天空色 → 薄云隐身；3-tap 门控分支解出薄光学厚度 → veil 发光。
  加门修不彻底（veil 本体 den>0.12 但探针点自密），故**删分支、两档走同一密度门控 3-tap**；
  density 恒 blended（档位无关），`uOctaves` 只留步数/预算记录。
- 证明：`high-on-t0.png` 修复前后逐位相同（303723 B），高档路径数学不变；
  low-on-t0 253375 B veil 回来；全套 540 绿。

## 遗留观察（非阻塞）

1. 低档海面反射轻微 shimmer（幅值 5.09 vs 高档 1.71，y360–436）——海面档位范畴。
2. 日下点状竖列伪影：sunoff 帧消失 → sun 相关、预先存在、与 post 无关（nopost 亦有）。
3. Perf 口径：墙钟帧间隔；真机待测。
