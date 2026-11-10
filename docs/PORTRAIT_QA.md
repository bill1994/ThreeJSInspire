# PORTRAIT_QA — 竖屏验收记录（Phase B Task 15）

验收线：PC WebGPU ≥ 55 fps，Android WebGL2 ≥ 30 fps；降档路径（`FrameGovernor` → `world.applyQuality(false)` + `post.setQuality(false)`）不崩溃。

## 证据表

| 设备 | 后端 (`__porco.backend`) | 平均 fps（HUD 读数） | 画质档 (`world.quality`) | 降档触发 |
|---|---|---|---|---|
| Windows 桌面 Chrome 内嵌视图（IAB，ZCode 桌面端），390×844 视口 | `webgpu` | 51–134 fps（后台节流时读数偏低，持续前台 89–134） | `high`（`post.fx.dof: true`，bloom 全参） | 否 |
| Windows 桌面 Chrome 内嵌视图，720×1280 视口 | `webgpu` | 46–94 fps（同上，后台节流会冻结帧循环，见下） | `high` | 否 |
| Windows 桌面 Chrome 内嵌视图，1600×900 宽窗 | `webgpu` | 52 fps+ | `high`（HUD 锚定画布盒，letterbox 无散落） | 否 |

- PC WebGPU ≥ 55 fps：**达成**（持续前台时）。
- Android WebGL2 ≥ 30 fps：**待真机**——本环境无 Android 设备，Mali/Adreno 上的 `forceWebGL` 节点材质编译与 raymarch 步数衰减（12→8 步、FFT 128→64）尚未实测。

## 已知测量限制

1. **IAB 后台节流**：浏览器窗格被遮挡时 Chromium 把 rAF 节流到零——页面 `document.hidden === false` 但帧循环停摆（页面可见、模拟冻结、fps 读数停在最后一帧）。每次强制截图推进一帧（dt 钳制 0.1 s），因此上面的 fps 读数在"后台"状态下不代表真实稳态。真机测试不受此影响。
2. **fps 读数来源**：HUD 状态行的指数平滑均值（`fps += (1/d - fps) * 0.08`），不是 `renderer.info` 的逐帧统计。

## 人工验收截图清单（本轮已取证，见 SDD ledger）

- 进云整屏均匀发白、出云海天线复接（Task 10）
- 240 m 升限满杆 STALL 块亮起 + 鼻头下坠（Task 8/10）
- 海天线 240 m 俯瞰无直边（Task 11）
- 太阳路 vs 转 90° 后碎光（Task 12）
- 1600×900 宽窗 HUD 贴画布盒、开屏字幕（Task 13）

## 调色 Debug 面板用例（`?debug=color`，2026-11-09 计划）

dev-only 调色板的人工 QA 动线（计划 [`superpowers/plans/2026-11-09-debug-color-panel.md`](superpowers/plans/2026-11-09-debug-color-panel.md)；每个控件↔复现命令的完整对照表在该计划文末）：

1. **开面板**：URL 追加 `?debug=color`（可与其它 QA 参数叠加，如 `?qa=frozen&debug=color`），右上角挂出面板；无参数时无面板、console 无报错（动态 import，加载失败只 console.error，游戏不受影响）。
2. **拖仰角**：太阳组 elevation° 滑杆从 6.97 连续拖到 −8（或点关键帧按钮一键跳档），天空／海／灯／星／纱连续跟随；等价命令 console `qa.setSun(<az>, <el>)`、URL `?sun=<az>,<el>`。
3. **锁 haze**：海面组勾「haze 锁」（行高亮 + console.warn 一次）→ 两端点拾色器启用 → 调 haze／awayEdge 端点，海霾定住不再跟太阳；解锁后恢复每帧跟随。等价 `qa.lockHaze(on)` + `qa.setHazeEndpoints([haze],[awayEdge])`。
4. **导出复现**：点「复制复现命令」→ 文本框与剪贴板得到两行命令（URL 通道／console 通道）。**双通道各跑一遍**：新开无痕窗口粘贴 URL 重载、或在 console 粘贴 qa 命令序列，两者画面应一致（Task 2 验收实测一致）。

验收证据：`artifacts/debug-color/`（`verify-task2.json` 11/11、`repro-lines.txt`、11 张 PNG）。整体验收 ①（默认画面不改，同会话 A/B 字节级）与 ④（build + 面板 chunk 独立）的实测记录见计划进度段。

## 待主人补验

- Android 真机跑分（`?backend=webgl2` 一轮 + 默认 WebGPU 一轮）
- 音频听感（Task 14：失速 duck、MASTER=0 真静音）
- 手感：相机滞后、buffet 幅度、STALL 闪烁节奏是否舒服
