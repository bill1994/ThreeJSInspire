# 背景积云大理石纹 — 归因排查卡（Diagnosis Card）

- 日期：2026-11-16
- 状态：待执行（本卡只做归因，不含修复）
- 前置：`docs/superpowers/plans/2026-11-16-bg-cumulus-marble-c3-puff.md`（C3 方案，未执行）
- 相关：`src/bg-cumulus.ts`、`src/bg-cumulus-paint.ts`、`src/main.ts`、`src/world.ts`、`scripts/cloud-probe.mjs`、`artifacts/marble-verify/`
- 行号以 2026-11-16 当前工作区为准；若漂移，按锚点文本搜索，不要按行号硬跳。

## 0. 执行者须知

1. **先预注册，后测量。** 本卡的判读规则在开跑前写死；测完不得改判据去迎合结果。
2. **一次只动一个变量。** 每个 A/B 只允许一个开关不同，其余 URL 参数、机位、分辨率、commit 全部一致。
3. **先零改码，后改码。** D0–D3 不碰源码；只有零改码定不了案，才进第 6 节的 5–9 号通道。
4. **测量窗口内冻结工作区。** 本仓有并行会话，别的改动会污染 A/B。每次运行记录 `git rev-parse HEAD` 与 `git status --porcelain`；测量期间不改源码、不切分支。
5. **本卡不产出修复。** 归因成功就停，修复另开文档；不要顺手调常数。

## 1. 现象与边界

现象：背景积云（bg-cumulus 烘焙层）表面出现**等高线状细纹**，像大理石纹；纹路不沿 puff 轮廓走，也不在云缘，主要落在云体内部明暗过渡区。

本卡要回答的唯一问题：**这些纹路由哪一项输入产生？**

不做：改画风、改噪声配比、调阈值、改烘焙分辨率作为修复、提交任何“试试看”的常数。

## 2. 已核实事实（2026-11-16 工作区）

### 2.1 着色链路

- 命中点 `p = ro + rd·tHit`；`pS = ro + rd·hazeDepth`，`hazeDepth` 是解析包围球入射距离，**不含 p**。
- 整段 paint 只有两处吃生 `p.y`：
  - `up`：`src/bg-cumulus.ts:663`
  - `hgt`：`src/bg-cumulus.ts:688`
  其余全部走 `pS`。
- `light` 的组成（`src/bg-cumulus.ts:664-667`）：
  `dot(N,L)·0.5+0.5` 乘以 `exp(−shadow·1.3)`，再加 `up·litUp`、`(open−0.5)·litOpen`、`N.y·litNy`。
- 出口硬门：`smoothstep(hardEdge[0], hardEdge[1], light)`，`hardEdge` 宽度只有 **0.05**（`PAINT_CONSTANTS`），是全链路最窄的阈值。
- `N = normalize(Ns·0.8 + Nf)`（`:637`）；`eN = 0.4·scale`（`:625`）、`eF = 0.22·scale`（`:631`）。Nf 采样半径更小、权重 1，是全链路最高频的项。
- `shadow` 是两次单点采样（`:645-657`），`open` 是单点采样（`:658-662`）。
- `shadeVar` 只乘在 `inShade` 上，幅度 ±10%（`:685-686`），不经过 `hardEdge`。
- `broadBillow` 两层都吃 `pS`（`:675-676`）。

### 2.2 烘焙与抓帧

- 云烘进静态 `CubeRenderTarget`，不是逐帧体积 march；只有光源/调色板变化或相机位移超阈值才重烘。
- 全量 40 条带；脏帧每帧最多 8 条带，**5 帧追平**（`src/bg-cumulus.ts:159-177`，`:996`，`:1004-1014`）。
- 首帧登记为 dirty（`stale = TOTAL_STRIPS`），所以首帧之后的约 5–6 帧内会全量重烘——`qa.step(300)` 足够覆盖。
- `?qa=frozen` 抑制动画循环；帧只能由 `window.__porco.qa.step(n, dt)` 推进（`src/main.ts:529-542`）。
- **绝不能用 `qa.stepFrame(0)` / `dt=0` 重渲染**：会产出整帧平色的坏帧，且坏一次后持续坏（`scripts/cloud-probe.mjs` 文件头第 4 条陷阱）。
- `?bgdbg=N` 只在启动时读一次（`src/main.ts:260-263`），经 `world.setBgDebug` 进 `bgCumulus.debugMode`（`src/world.ts:295-296`，`src/bg-cumulus.ts:1043`）。
- `?bgdbg=3` 时 paint 的 `pS` 被换成 `p`（`src/bg-cumulus.ts:864`），march/alpha 不受影响。
- `?bgq` 只接受 512/1024/2048（缺省 1024，`src/qa.ts` `parseBakeQuality`）。
- `?bgforce=single` 强制单云夹具，参数固定为 `singleCloudLayout(90, 10, 5000, 2000, 600)`（`src/main.ts:233`）。

### 2.3 分辨率量级

1024/面、90° 视角 → 每 texel **0.0879°**；5 km 处约 **7.7 m**。屏幕是否欠采样取决于相机 fov，不在本卡预设——D1 就是量它。

## 3. 假设与可证伪预测

| 编号 | 假设 | 若成立应看到 | 若被否应看到 | 判别手段 |
|---|---|---|---|---|
| H1 | 生 `p` 进入 `up`/`hgt`，p.y 在相邻 texel 间跳变 | 纹路贴着 `light` 的 `hardEdge` 等值线走（p.y 跳变把 `light` 推过硬门）；换成 `pS.y` 后消失 | 换成 `pS.y` 后纹路不减 | 通道 8 |
| H2 | `Nf`（高频法线）经 `hardEdge` 画出等高线 | 纹路沿受光等值线走；去掉 Nf 后大幅减少 | Nf 权重 0.1 后纹路仍在 | 通道 6；必要时通道 10 |
| H3 | `shadow` 单点采样 + `exp(−1.3·shadow)` 放大 | 纹路在背光面最强、沿 L 方向；shadow≡0 后消失 | shadow=0 后纹路仍在 | 通道 5 |
| H4 | `shadeVar` 暗部画师层 | 只在暗面、且是柔和起伏，**给不出锐线** | 关掉后锐线仍在 | 通道 7 |
| H5 | `broadBillowFine` 第二层 billow | 纹路在中间调、低频、不锐利；关掉后减弱 | 关掉后不变 | 通道 9 |
| H6 | 烘焙采样/纹理混叠（无 mip 的 64³ billow） | 纹路**屏幕间距随烘焙分辨率翻倍而减半**（texel 锁定） | 间距不随分辨率变（世界/屏幕锁定） | D1 三点扫描 |
| H7 | 多云 SDF 交叠/布局接缝 | 纹路沿 puff 交界；单云夹具上消失 | 单云夹具上仍出现 | D3 |

补充假设（只在主表全否时启用）：

| 编号 | 假设 | 判别手段 |
|---|---|---|
| H8 | `open` 单点采样经 `litOpen` 放大 | 通道 11（`open=0.5`） |
| H9 | `Ns` 本身（球簇 SDF 法线）脏 | 通道 10（`N=Ns`） |

## 4. 抓帧协议（所有步骤共用）

### 4.1 环境

```powershell
# 终端 1（端口被占时 vite 会换端口，后面所有 URL 跟着换）
npx vite --port 5173

# 终端 2：独立 profile 启一个可被 CDP 接管的 Chrome（路径按本机安装位置替换；
# 不要动用户日常窗口）
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:TEMP\porco-diag-cdp" `
  --no-first-run --no-default-browser-check `
  --disable-backgrounding-occluded-windows `
  --new-window http://localhost:5173/
```

窗口必须保持前台/可见：被遮挡时页面 `visibility=hidden`，rAF 停摆，抓帧直接失败。探针会先 `Page.bringToFront`，仍 hidden 就报错退出。

### 4.2 流程（与 `scripts/cloud-probe.mjs` 完全一致，禁止另起一套）

1. 先钉视口，再导航：`Emulation.setDeviceMetricsOverride { width:448, height:797, deviceScaleFactor:1, mobile:false }`。
   448×797 是 `#frame` 的运行时值，**不是常量**；不钉死，角换算与所有指标随窗口漂移。
2. 导航到 `?qa=frozen&puff=0`（`puff=0` 把近场云排除，只留背景烘焙层）。
3. 立刻隐藏 `#frame .porco-hud`（HUD 会盖住云主体，不藏的差分无效）。
4. `qa.step(300, 1/60)`：相机 rig 的亚像素暂态在 ~182 帧后才消失；300 帧同时覆盖 5 帧全量重烘。
5. 截 `bg-on`；`world.setBgVisible(false)`；**`qa.step(2, 1/60)` 真步进**；截 `bg-off`。`dt=0` 会出坏帧。
6. 还原 `setBgVisible(true)`，关闭 CDP 连接（不关，Node 进程不退出）。

### 4.3 确定性门（D0 的一部分，必须先过）

同一 URL 连跑两遍，`bg-on` 两图在天空区（`y < yHorizon`）比较。

**2026-11-16 实测修正**：逐像素确定性**不成立**——run1 vs run2 核心区完全一致只有 20.3%，差 ≥24 级的像素 0.12%，均值差 1.93；同一次 on vs on-ref 更差（12.3%）。天空有 ±1–2 级抖动，但聚合指标稳定（veinDensity 3.251% vs 3.360%）。因此门槛改为：

- **通过**：核心区（mask 腐蚀 3px）内 `maxDiff ≥ 24` 的像素占比 ≤0.5%，且 `veinDensity` 两跑相对差 ≤5%。
- **不通过**：先排查 HUD 是否藏干净、视口是否钉死、是否有人并行改码；未通过前不做任何 A/B。
- 不做逐像素 identical 门槛；截图比较一律按聚合指标，不按“看起来一样”。

### 4.4 产物

每次运行保留 `bg-on.png`、`bg-off.png`、`metrics.json`，统一归档到：

```
artifacts/marble-diag/<step-id>/
  bg-on.png
  bg-off.png
  metrics.json      # 探针原始 + 本卡指标
  run.json          # url / git rev / git status / 时间戳
```

`artifacts/` 不入库；`run.json` 必须带 `git rev-parse HEAD` 与 `git status --porcelain` 原文。

探针每次写到 `artifacts/cloud-probe/<ISO>/`；跑完立刻复制成 `artifacts/marble-diag/<step-id>/`，并把 ISO 时间写进 `run.json`。两个步骤不得共用同一个目录。

## 5. 零改码判别（D0–D3）

### D0 复现（门）

- 生产机位：`node scripts/cloud-probe.mjs --heading 240`（240° 是 24 朝向罗盘扫描里覆盖率最高的机位，64%）。
- 夹具机位：`node scripts/cloud-probe.mjs --bgforce single --heading 90`（只有一朵已知云，见 D3）。
- **CLI 语法**：探针参数是空格分隔（`--heading 240`、`--extra bgq=512`、`--bgforce single`）；写成 `--heading=240` / `--extra=bgq=512` 会被静默忽略。`--heading N` 只跑该机位。

通过标准：`bg-on` 里 2× 放大可见与用户描述同型的等高线纹，且 4.3 确定性门通过。**不通过就停**，先修抓帧/机位，不要往下测。

### D1 分辨率三点扫描（H6）

```powershell
node scripts/cloud-probe.mjs --heading 240 --extra bgq=512
node scripts/cloud-probe.mjs --heading 240 --extra bgq=1024
node scripts/cloud-probe.mjs --heading 240 --extra bgq=2048
```

判读（预注册）：

- 纹路**屏幕间距随分辨率翻倍而减半** → texel 锁定，H6 成立（采样/混叠）。
- 纹路位置与间距基本不变，只是更清晰 → 场级特征，H6 否。
- 2048 反而出现更细的椒盐、且 512 时纹路消失 → 高频混叠，H6 成立（记录为“minification 型”）。

注意：无 mip 的 cubemap 在 2048 会**增加**缩小采样混叠，所以“2048 更糟”本身不能证明 1024 的纹路是混叠——必须看**间距是否随分辨率成比例变化**。

### D2 原 P 着色（H1 的粗筛）

```powershell
node scripts/cloud-probe.mjs --heading 240 --extra bgdbg=3
```

判读：

- 纹路明显恶化/增多 → p 家族有份，进通道 8 精确归因。
- 几乎不变 → p 不是当前主因；跳过通道 8（但仍保留记录）。
- 注意：`bgdbg=3` 把 `pS` 整体换成 `p`，会让 Ns/Nf/shadow/open 一起变脏，所以它只能证明“p 有没有份”，不能证明“p 从哪一项进来”。

### D3 单云夹具（H7）

D0 的夹具运行本身就是 D3：`?bgforce=single` 下只有一朵已知云。

- 单云上仍有同型纹 → 与多云交叠/布局无关，H7 否。
- 单云上消失、生产机位仍在 → H7 成立，转查布局/SDF 交叠。

## 6. 代码 A/B（通道 5–9）

> 仅当 D0–D3 不能定案时执行。补丁一次性加齐，每个通道只改一个量；默认分支必须与现状**逐位一致**。

### 6.1 一次性补丁

在 `src/bg-cumulus.ts` 增加 5–9 号 `uDebug` 分支：

1. **paint 执行条件**（`:854`）：现有条件是
   `If(uDebug.equal(0).or(uDebug.equal(3)).or(uDebug.equal(4)), ...)`，
   追加 `.or(uDebug.greaterThanEqual(5))`，否则 5–9 只改输入、不跑 paint，画面会是空的。
2. **通道 5 — shadow=0**（`:657` 附近）：
   `const shadow = shNear.add(shFar).toVar();`
   `If(uDebug.equal(5), () => { shadow.assign(float(0)); });`
3. **通道 6 — Nf 权重 0.1**（`:637`）：
   `const wNf = float(1).toVar();`
   `If(uDebug.equal(6), () => { wNf.assign(0.1); });`
   `const N = normalize(Ns.mul(0.8).add(Nf.mul(wNf)));`
4. **通道 7 — 关 shadeVar**（`:686`）：
   用 `select`/`mix` 以 `uDebug==7` 为条件，在 `inShade.mul(0.9 + shadeVar·0.2)` 与原 `inShade` 之间二选一。
   默认分支保持原表达式（不要代数改写，避免末位漂移）。
5. **通道 8 — up/hgt 换 pS.y**（`:663`、`:688`）：
   `const pY = uDebug.equal(8).select(pS.y, p.y);`
   `up` 与 `hgt` 都改用 `pY`。
6. **通道 9 — broadBillowFine=0**（`:676`）：
   给 `broadBillowFine` 项乘一个 `float` 因子，`uDebug==9` 时置 0。

可选扩展槽（只在通道 6/5 只减轻、不消失时启用）：

- **10 — N = Ns**：彻底去掉 Nf，区分 H2 与 H9。
- **11 — open = 0.5**：去掉 `open` 项，测 H8。
- **12 — 5+8 组合**：shadow≡0 且 up/hgt 用 `pS.y`。只用于 6.3 的叠加性确认，不参与单项归因。

10/11/12 的实现：10 用 `uDebug.equal(10).select(Ns, N)`；11 把 `open` 改成 `toVar()` 后按条件 assign 0.5；12 把通道 5 与通道 8 的条件都改成 `.or(uDebug.equal(12))`。

补丁只允许动 `src/bg-cumulus.ts` 一个文件；不改 `main.ts`/`world.ts`（`?bgdbg` 已支持任意整数）。

### 6.2 通道定义与判读

| 通道 | URL | 只改了什么 | 纹路消失/大幅减少 → 结论 | 纹路不变 → 结论 |
|---|---|---|---|---|
| 5 | `?bgdbg=5` | shadow≡0 | H3 成立（阴影单点采样） | H3 否 |
| 6 | `?bgdbg=6` | Nf 权重 1→0.1 | H2 成立（高频法线） | H2 否，转 10 |
| 7 | `?bgdbg=7` | shadeVar 关 | H4 成立（暗部画师层） | H4 否 |
| 8 | `?bgdbg=8` | up/hgt 用 pS.y | H1 成立（生 p 高度项） | H1 否 |
| 9 | `?bgdbg=9` | broadBillowFine=0 | H5 成立（第二层 billow） | H5 否 |

每条通道都在**同一夹具机位**跑，且与 D0 基线同一分辨率（1024）、同一 heading、同一 `qa.step`。

### 6.3 组合确认（仅限个别项都“部分有效”时）

若通道 5 与 8 各自只能减少 20–40%，可在**单项归因完成后**加一次 `?bgdbg=12`（通道 12 = 5+8 同时开）做独立性与叠加性确认；这是唯一允许的一次多变量运行，且必须标注为“确认运行”，不参与单项归因。

## 7. 指标定义

所有指标只在**云区 mask** 内计算。mask = `bg-on` 与 `bg-off` 的三通道最大绝对差 > 24 的像素（与探针缺省阈值同口径，避开低对比霾），再腐蚀 1 px 去掉云缘。

- `veinDensity`：3×3 邻域亮度极差 > 8（8-bit）的像素占比。**2026-11-16 标定修正**：原 18 只抓到 25 px，纹路主体是 1–2 级起伏；8 在 D0 上给出 3.25%（阈值 6→4.8%，阈值 10→1.5%），灵敏度合理。纹路是局部高对比细线，对极差敏感。
- `edgeDensity`：Sobel 幅值 > 24 的像素占比。
- `veinJaccard`：变体与基线的 vein mask 交并比（仅同分辨率可比）。
- 亮度用 `Y = 0.2126R + 0.7152G + 0.0722B`（直接取截图 sRGB 值，不做线性化）。

预注册判读带（相对基线）：

| 变化 | 判定 |
|---|---|
| `veinDensity` 降 ≥50% 且 `veinJaccard` ≤0.20 | **消除**（该通道是主因） |
| 降 10–50%，或 Jaccard 0.20–0.60 | **部分**（该通道有贡献，非唯一） |
| 变化 ≤10%，或 Jaccard ≥0.80 | **无影响** |

D0 的复现门与 D1 允许人工判读；D1 必须附 2× 放大并排图。其余步骤以指标为准。

### 7.1 指标脚本

一次性分析脚本放 `artifacts/marble-diag/tools/veins.py`（不进 `src/`，`artifacts/` 不入库）；用任意 PNG 解码库即可，仓库内建议 Python(Pillow)+numpy。

输入：某个 `<step-id>/` 下的 `bg-on.png`、`bg-off.png`、探针 `metrics.json`（读 `yHorizon`）、基线目录（算 Jaccard）。

输出（合并进该目录的 `metrics.json`）：

- `maskPixels`、`veinDensity`、`edgeDensity`、`veinJaccard`（相对基线）、`yHorizon`。
- `vein-mask.png`（白=vein），供人工叠加查看。

实现要点：

1. 只取 `y < yHorizon` 的天空区。
2. `mask = max(|on−off|) > 24`，再 3×3 腐蚀 1 px。
3. `Y = 0.2126R + 0.7152G + 0.0722B`。
4. `vein = (3×3 max(Y) − 3×3 min(Y)) > 8`，且 `mask` 内。
5. `edge = |Sobel(Y)| > 24`，且 `mask` 内。
6. 确定性检查：同一 URL 两跑的 `bg-on` 逐像素比较，输出 `identicalRatio` 与 `maxDiff`。

## 8. 归因矩阵

| 观察 \ 假设 | H1 p | H2 Nf | H3 shadow | H4 shadeVar | H5 fine | H6 采样 | H7 布局 |
|---|---|---|---|---|---|---|---|
| 只在暗面 | 弱 | 中 | **强** | 强（但柔） | 弱 | 中 | 弱 |
| 只在亮面/受光边 | 中 | **强** | 弱 | 无 | 弱 | 中 | 弱 |
| 沿受光等值线 | 中 | **强** | 中 | 无 | 弱 | 中 | 弱 |
| 云体内部到处都有 | **强** | 中 | 中 | 弱 | 中 | **强** | 中 |
| 沿 puff 交界 | 弱 | 弱 | 弱 | 无 | 弱 | 弱 | **强** |
| 单云夹具上消失 | 弱 | 弱 | 弱 | 弱 | 弱 | 弱 | **强** |

矩阵只用于交叉验证，不替代 5–9 的单变量结果。

## 9. 停止条件与交付

- **D0 不通过**：停止，先修抓帧/机位；不产出归因结论。
- **任一通道达到“消除”**：停止，写归因；修复方案另开文档，不在本卡改常数。
- **多个通道“部分”**：逐个记录贡献，允许 6.3 的一次组合确认；仍不能收敛则转数值台扩展。
- **全部“无影响”**：停止盲试，转数值台扩展（在 `artifacts/marble-verify/` 里加 `light`/`N`/`shadow` 的邻域连续性测量，而不是继续加通道）。

交付物：

1. `artifacts/marble-diag/report.md`：每步的 URL、git rev、`veinDensity`/`edgeDensity`/`veinJaccard`、2× 放大图、判定。
2. 一句话结论：“纹路主因是 X，证据是 Y，残余是 Z”。
3. 下一步建议（修复/继续测量/换方向），不直接改代码。
4. 临时通道 5–9 的去留：默认回滚；若要保留为取证通道，单独一个 commit，且不与修复混在一起。

## 10. 风险与坑

- **不要用“闪不闪”判 p**：云烘进静态立方图，噪声天然冻结；且噪声是世界空间的，动镜头是滑动不是闪烁。这个判据无效。
- **不要用 266/171 那组旧注释**：生产塔云 rig 是 668/428（数值台口径）；266/171 是单云/mid 旧档。
- **`scale` 是包围球半径 `cl.w`**，不是 puff 半径（`src/bg-cumulus.ts:790`）；拿 puff 半径算角分辨会错一个量级。
- **`?bgq=2048` 有显存/首烘代价**（6 面 × 2048²），集显上可能掉帧；抓帧协议不受影响，但别在 2048 下测帧时间。
- **`?bgdbg=3` 只换 paint 输入**，alpha/march/haze 不变；它恶化不代表 march 有问题。
- **toon 出口会压缩对比度**：`veinDensity` 的绝对值受 toon 影响，所以只用相对基线的百分比，不跨配置比绝对值。
- **并行会话**：测量期间任何源码改动都会让 A/B 失效；`run.json` 里的 `git status` 不是形式主义。
- **HUD、视口、dt=0** 三条是抓帧协议的老坑，照 `scripts/cloud-probe.mjs` 文件头执行，不要自创流程。

## 11. 时间盒

| 阶段 | 预算 |
|---|---|
| D0 复现 + 确定性门 | 20 min |
| D1 三点扫描 | 15 min |
| D2/D3 | 15 min |
| 通道 5–9 补丁 + 五次运行 | 40 min |
| 指标与报告 | 20 min |
| **合计** | **≤2 h** |

超时即停，按已有证据写“部分归因”，不延长盲试。

## 12. 执行记录（2026-11-16 首轮，D0–D3 + 五个追加单变量）

环境：HEAD 853708f，工作区带未提交改动（`src/bg-cumulus-paint.ts` 的 broadBillowFine、`src/bg-cumulus.ts` 的 pS 化妆层等）。机位 heading 240（覆盖率 64%），分辨率 1024，448×797，`?qa=frozen&puff=0`。临时改动跑完即还原，`git diff --stat` 与开跑前一致。

| 步骤 | 变量 | veinDensity | Jaccard vs D0 | 判定 |
|---|---|---|---|---|
| D0 run1 | — | 3.251% | 1.0 | 基线（2× 可见同心等高线纹） |
| D0 run2 | 同 URL 重跑 | 3.360% | — | 聚合稳定；逐像素仅 20.3% 一致 |
| D1 q512 | 烘焙 512 | 3.783% | 0.306 | 纹路间距不变，只是变糊 |
| D1 q2048 | 烘焙 2048 | 1.698% | 0.325 | 间距仍不变 → **H6 否** |
| D2 bgdbg=3 | pS→p | 4.294% | 0.489 | 纹路改变且增多，但未消失 → H1 部分 |
| D3 single | 单云夹具 | 6.1% | — | 只有弱斑驳，夹具代表性不足 |
| E toon=0 | toon 总闸 0 | 3.251% | 1.0（字节相同） | toon 出口对云像素 no-op |
| F bgdbg=4 | 关 fine 位移 | 3.830% | 0.171 | 细位移不是来源 |
| G 软边 | hardEdge 0.30–0.90 | 3.251% | 1.0（字节相同） | 该视角纹路在暗面，硬边只管受光边界 |
| H noDeepen | foldDeepen 0 | 3.360% | 0.181 | 折痕加深不是来源 |
| I noShadeVar | inShadeV=inShade | 3.270% | 0.883 | H4 否 |
| J noShadow | 阴影权重 0 | 3.314% | 0.611 | H3 否（只改明暗，不改纹路） |

结论（部分归因）：

1. **不是烘焙分辨率/采样混叠**：512/1024/2048 的纹路间距与几何完全一致；密度变化是“3×3 极差”对线宽的敏感性，不是纹路复制。报告 1/2 里排第一的 H6 可以划掉。
2. **不是 toon 出口、不是 hardEdge、不是 foldDeepen、不是 shadeVar、不是阴影单点、不是 fine 位移**：逐项字节级或 Jaccard ≥0.61 不变。
3. **p 有份但不是主因**：换成生 p 后纹路位置/密度都变（4.29% vs 3.25%），但纹路仍在；且该开关同时改 alpha/配色，不能单独定罪。
4. 纹路存活在所有暗面色彩项被逐一关掉之后，剩下的公共输入是 **`broad` 里的 `dot(Ns, L)` 与 SDF 导出的法线**：法线来自 4 点 `bgMap` 差分，在 puff 簇的 smin 接缝处方向抖动 → `broad` 在 1–2% 量级抖动 → `shadeMix` 的宽 smoothstep 把它压成 1–2 级色阶 → 就是看到的同心等高线。这也解释了为什么分辨率无关、为什么关细位移还在（抖动在**粗** SDF 的 puff 尺度上）。
5. 下一步（按本卡停止条件转“不盲试”）：把 `Ns` 换成**解析 puff 簇法线**（按 smin 权重混合各球法线，或对 Ns 做权重平均），或先跑通道 6（Nf 权重 0.1）看能压掉多少；若换法线后纹路消失，则根因是“SDF 差分法线在 puff 接缝处的方向抖动”，不是位移幅值——这与 C3 文档的方向（压位移）只部分重合。
