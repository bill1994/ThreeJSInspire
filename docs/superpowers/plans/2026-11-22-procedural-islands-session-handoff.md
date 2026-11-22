# ThreeJSInspire 岛群与植被交接 · 2026-11-22

**从这里接手。** 岛群、近岸倒影和手绘草坡已推送到 `new-reset`。当前停在空中植被预览，用户尚未确认这版风格。先让用户看从海上接近草坡的过程，再依据反馈决定继续调画面，还是定位新版增加的长帧。原计划要求每个阶段提供可操作预览，由用户看过后继续。

仓库位于 `D:/stylize-plan/ThreeJSInspire`。交接前核对到本地 HEAD 与 `origin/new-reset` 均指向 `11cd77f`，创建本文前工作区干净。新会话先执行 `git status -sb`，保留之后产生的全部未提交修改。[GitHub 代码基线](https://github.com/bill1994/ThreeJSInspire/commit/11cd77fa30957dc5b5f09591b62000b76a20fb61) · [原计划及各阶段验收条件](2026-11-20-procedural-islands-plan-handoff.md)

## 先看同一条航线

先打开下列链接。若 5181 没有服务，在 PowerShell 中运行以下命令。新克隆缺少依赖时先执行 `npm.cmd ci`。预览需要支持 WebGPU 的浏览器。

```powershell
Set-Location D:/stylize-plan/ThreeJSInspire
npm.cmd run dev -- --host 127.0.0.1 --port 5181 --strictPort
```

| 入口 | 观察重点 |
| --- | --- |
| [110 米高空，新版手绘草坡](http://127.0.0.1:5181/?land=archipelago&pass=aerial&grasslook=paint&tod=12&todspeed=0) | 飞机还在海上时看整面坡的冷暖、坡顶草簇和树冠剪影；越岸时看近景细节接入。 |
| [110 米高空，上版草坡](http://127.0.0.1:5181/?land=archipelago&pass=aerial&grasslook=meadow&tod=12&todspeed=0) | 同机位、同正午对照。页面右下角可切换版本或重飞。 |
| [16 米贴地，新版手绘草坡](http://127.0.0.1:5181/?land=archipelago&pass=meadow&grasslook=paint&tod=12&todspeed=0) | 看单簇草的疏密、叶片受风方向、飞机掠过后的弯折与回弹。 |

对照时用上面的完整 URL。`pos` 会覆盖航线起点；`pass=meadow` 选择低空航线，`grasslook=meadow` 选择上版外观。省略 `land` 默认进入纯海空场景。

## 已做到哪里

| 阶段 | 已交付与记录 |
| --- | --- |
| 0–1 | 纯海空性能基线、固定种子单岛、海岸过渡、飞机与相机地形净空。[基线](../reviews/2026-11-21-island-baseline.md) · [单岛](../reviews/2026-11-21-single-island.md) |
| 2 | 分块植被、风与航迹扰动、草叶／树叶／沙粒，以及三条低空路线。[植被互动](../reviews/2026-11-21-island-vegetation.md) |
| 3 | 固定岛组、程序化岛群、Worker 流送与回收、简化倒影，另有返航与缺块检查。[岛群](../reviews/2026-11-21-archipelago.md) |
| 3 后的视觉迭代 | 先改善近树首次绘制和贴地草丛，再增加中景草簇，并让坡面和草叶共用受光与风纹。[低空迭代](../reviews/2026-11-21-meadow-flight.md) · [最新空中对照](../reviews/2026-11-21-aerial-field-shading.md) |
| 4 | 待做。按原计划在明确型号的低端电脑和高端手机上测试热机、跨区、快速转向与昼夜切换，记录 60 FPS 目标和 30 FPS 保底表现。 |

## 当前判断与下一步

用户想要从空中也能读出草地起伏、接近吉卜力或《塞尔达》气质的植被着色。上版同时受草块距离和高度裁剪影响，高空只剩平滑底色。最新版把成片的明暗与风纹画在地形上，中景草簇随岛载入，近景互动叶片按空间距离过渡。看视觉反馈时，先区分是整坡色块、坡顶轮廓，还是贴地叶片需要调整，才能选对实现位置。

**性能还有回退。** 同一台 Ryzen 5 3500X／RX 5600 OEM，Chrome WebGPU，高画质、450 × 800 绘制缓冲，三分钟跨岛测得超过 50 ms 的帧由上版 9 帧增至新版 46 帧，其中 39 帧集中在第一分钟。两版最长均为 91.7 ms。新版近岸缺岛数为零，峰值驻留 23 岛。第一分钟的长帧尚未逐帧归因。如果用户认可画面，建议先抓这一分钟的时间线，分别核对首次绘制、主线程上传和 GPU 耗时，再决定如何优化。上次生产构建和 874 项测试通过。[复测口径与原始数据入口](../reviews/2026-11-21-aerial-field-shading.md)

## 实现入口与复测

- 预览入口、参数和起飞机位在 `src/main.ts`。远景草坡与树冠着色在 `src/land/field-shading.ts`，中景草簇在 `field-cover.ts`，近景草块、树木实例与距离切换在 `vegetation.ts`，后两者同属 `src/land/`。
- 岛的生成数据与传输布局在 `src/land/archipelago-data.ts`，加载、回收、近远树切换和倒影在 `src/land/archipelago.ts`。
- 常规验证运行 `npm.cmd test` 和 `npm.cmd run build`。录制和性能探针还需要一个使用独立配置目录、已在本机 9347 端口开启远程调试的 Chromium，以及运行在 5181 的项目预览。

```powershell
# 同机位固定步长画面对照
node scripts/archipelago-probe.mjs http://127.0.0.1:5181 http://127.0.0.1:9347 --aerial
# 实时三分钟跨岛帧间隔采样
node scripts/archipelago-probe.mjs http://127.0.0.1:5181 http://127.0.0.1:9347 --live
```

评审文档和脚本已随代码推送。录像、截图、原始采样位于本机 `artifacts/`，该目录由 Git 忽略。在同一台机器上可直接打开[最近一次左右对照录像](../../../artifacts/archipelago-2026-11-21T08-55-44-189Z/aerial-comparison.mp4)。换机器时可用探针重新生成对照帧和采样。

## 可复制到新会话

> 请先读 `D:/stylize-plan/ThreeJSInspire/docs/superpowers/plans/2026-11-22-procedural-islands-session-handoff.md`，从当前工作区继续，保留全部未提交修改。请先打开 110 米同航线的手绘草坡和上版对照，让我看从海上接近岛屿时植被的变化。我看过后再决定继续调着色，还是先查第一分钟的长帧。后续仍按阶段给我看可操作预览。
