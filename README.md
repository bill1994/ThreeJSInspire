# Porco Sunset Dogfight

竖屏（720 × 1280）日落空战原型。Three.js r186，WebGPU 优先、WebGL2 自动回退
（同一套 TSL 代码，WebGL2 走 `forceWebGL`）。飞机模型由 Blender 构建并导出为单文件 GLB。

> **当前基线：`rebuild/sea-dome-reset`（HEAD `2f05b25`，2026-11-09）。**
> 2026-11-06 做了一次删除型重构：删光海面（`src/sea/`、`sun-road.ts`、`SEA_PALETTE`）、穹顶云
> 残留（`CLOUD_PALETTE`、穹顶雾常量）与相关文档/证据，近景 puff 云没动。
> 2026-11-07 海面按 [`stylized-fft-ocean.md`](docs/superpowers/plans/2026-11-06-stylized-fft-ocean.md)
> 重建（WebGPU-only：世界取模 IFFT 场 + 同心方环 + 四档平涂 + 太阳路 + 细八度），云按
> [`puff-cluster-cloud.md`](docs/superpowers/plans/2026-11-02-puff-cluster-cloud.md) 重做；
> 昼夜天空与海霾/太阳联动在 11-08 落地。穹顶云仍待重做。
> 启动条 `sky + sea + puffs`（海或云动态装配，挂不上时自动退化到 `sky + puffs` 或 `sky only`）。
> 状态与去留以 [`docs/superpowers/INDEX.md`](docs/superpowers/INDEX.md) 为准。

## 运行

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # tsc --noEmit && vite build
npm test             # vitest run（47 个文件 / 396 个用例，2026-11-09 实测全绿）
npm run smoke        # 结构自检：模块、资源、GLB 魔数
```

> Vite 在本机只监听 `::1`，浏览器请用 `http://localhost:5173`。若 `127.0.0.1` 打不开不是 bug。

## QA 开关

| 开关 | 作用 |
| --- | --- |
| `?backend=webgl2` | 强制走 WebGL2（`forceWebGL`） |
| `?backend=webgpu` | 强制 WebGPU；探针失败时**直接报错而不是回退**，用来暴露真实的 WebGPU 问题 |
| `?post=0` | 关掉后处理管线（bloom / 景深 / SMAA），排查管线问题时用 |
| `?alt=<米>` | 出生高度覆盖。近景云带在 `ALT_MIN`–`ALT_MAX` 之间，爬升一整个周期才到，调云不必每次爬 |
| `?pos=x,y,z` | 直接摆飞机位置，抓帧可复现 |
| `?puff=0` | 藏掉近景云场，做 paired on/off 差分 |
| `?palette=<sunset\|roseDawn\|tealNoon\|violetDusk>` | 调色预设（`src/visual-presets.ts`）：日落原帧 / 玫瑰拂晓 / 青昼 / 紫暮。`sunset` = 无补丁原帧 |
| `?postfx=<sunset\|glowSoft\|crisp\|noDof>` | 后处理预设：原帧 / 柔光 / 脆亮 / 真关 DOF（`noDof` 摘节点，不是置零糊弄） |
| `?bloom=<0..1>` / `?dof=0\|1` | 单旋钮覆盖：bloom 阈值 / DOF 诚实开关（预设之上再盖一层） |
| `?cam=<lowChase\|highWide\|acro\|dist,height>` | 追机位：预设或 `距离,高度`（如 `?cam=18,3.5`），fovKick/bank 仍归导演逐帧驱动 |
| `?fov=<30..100>` | 基准垂直 FOV（默认 60），竖屏构图重调时用 |
| `?qa=frozen` | 停掉动画循环，帧完全可复现（配合 `__porco.qa.step()` 手动推进） |

页面左下角的启动条显示 `backend · worldLabel`（默认 `sky + sea + puffs`，
海或云挂不上时自动退化为 `sky + puffs` 或 `sky only`），6 秒后淡出
（元素仍在 DOM 里，可 `document.querySelector('#boot-status').textContent` 读回来）。

浏览器控制台里有只读调试句柄：

```js
__porco.backend      // 'webgpu' | 'webgl2'
__porco.scene        // THREE.Scene
__porco.camera       // PerspectiveCamera
__porco.game.pose()  // 飞机的实时世界坐标
__porco.world        // { update, dispose, quality, clouds, blobs, setPuffVisible }
__porco.qa.step(60)  // 冻结态下手动推 60 帧
__porco.qa.describe()// 抓帧所需的全部可复现信息 + renderer.info
```

## 结构

| 文件 | 职责 |
| --- | --- |
| `src/main.ts` | 唯一的组合根：渲染器 → 天空 → 世界 → 游戏 → 动画循环 |
| `src/renderer.ts` | WebGPU 探测 + WebGL2 回退，`?backend=` 覆盖 |
| `src/world.ts` | 世界总装：天穹 + 海面（`import()` 动态装配，缺 WebGPU 时自动降级为 sky only）+ 近景云 + `FrameGovernor`（连续 60 帧超 24 ms 降档） |
| `src/sea/material.ts` | 海面组装：同心方环 mesh + 四档平涂 + debug 假色覆盖率 + 细八度 C1 门 |
| `src/sea/fft-cpu.ts` / `fft-gpu.ts` | 海面临时 IFFT 场（CPU 基准 + GPU TSL 节点材质） |
| `src/sea/water-shading.ts` | 水体光学层（fresnel / 深度着色） |
| `src/sea/sun-road.ts` | 太阳路（反太阳方向高光 knee + 背阳天空端压暗） |
| `src/sea/foam.ts` / `rings.ts` / `bands.ts` / `spectrum.ts` / `cascades.ts` / `fine-band.ts` / `rings-mesh.ts` | 泡沫覆盖、同心方环几何、高度色带、Phillips 谱、级联八度、4–27.5 m 细带八度、环 mesh 组装 |
| `src/sky-webgpu.ts` | TSL 落日天穹 + 永不黑屏的 canvas 渐变背景（WebGPU 优先，WebGL2 下走 forceWebGL） |
| `src/sky-preetham.ts` / `sky-color-js.ts` | Preetham 能量场与 JS 镜像（TSL 着色的参考实现，逐通道 ≤1e-6 parity 钉死） |
| `src/sky-track.ts` / `stars.ts` | 昼夜天空调色板轨道（day-night Task 1–7） + 种子化星点层 |
| `src/sun-state.ts` | 运行时太阳状态（方向/辐亮度），天空/海/霾/灯随轨道联动的唯一锚 |
| `src/lights.ts` | 日落光照，后端无关；轨道 setter（`setSunLook` / `setAmbience` / `setSunDirection`） |
| `src/palettes.ts` | 全部颜色的单源：`SKY_PALETTE` / `SEA_PALETTE` / `WAKE_FOAM` / 机库涂装 + 自由调色预设 `PALETTE_PRESETS` |
| `src/visual-presets.ts` | 自由发挥入口：调色/后处理/机位预设 → 现有管线（`?palette` / `?postfx` / `?cam`），默认全部等于原帧 |
| `src/horizon.ts` | 天穹辉光/日盘的纯函数参考实现（JS 镜像，被 TSL 天穹与多个模块引用） |
| `src/far-field.ts` | 把天穹壳拖到飞机下方、近景云环面回收 |
| `src/puff-cloud.ts` | 近景云材质与装配 |
| `src/puff-field.ts` | 近景云簇散布与回收：方形环面窗口 + 抖动网格 + 相干覆盖掩码（纯函数，同 seed 深相等） |
| `src/puff-shape.ts` | 单朵云的几何：竖直主轴大瓣 + 肩瓣，合并成一个 mesh |
| `src/in-cloud.ts` | 「相机离最近的云多近」，驱动 HUD 白雾、相机扰动与台词 |
| `src/plane.ts` | GLB 加载 + 三级姿态包装 + 占位机（缺资源也能飞） |
| `src/input.ts` | Pointer Events 单一通路，4 px 死区，径向死区 |
| `src/camera-rig.ts` | 跟随相机：死区、指数平滑、FOV kick |
| `src/director.ts` | 相机作为导演：接管/交还，不拥有常量 |
| `src/spiral.ts` / `src/stall.ts` / `src/skim.ts` | 三个玩法判据：螺旋俯冲 / 失速 / 掠海 |
| `src/feel.ts` | trauma 抖动 + 翼尖尾迹池 |
| `src/hud.ts` | DOM HUD（安全区锚定，不挡画面）+ 音量滑块 |
| `src/audio.ts` | WebAudio 总线（Master ← Music/SFX/Ambience/UI），自适应音乐，侧链 duck；**无采样文件，全是合成都** |
| `src/subtitles.ts` | 剧情字幕，每次出击每句最多一次 |
| `src/post.ts` | bloom / 距离模糊 / SMAA |
| `src/toon.ts` | 飞机专用的三级 gradient-map toon 着色 |
| `src/portrait.ts` / `src/qa.ts` | 竖屏比例契约 / 抓帧参数解析（纯函数） |

## 关键约束（改代码前先读）

1. **WebGPU 下不可用 `ShaderMaterial` / `onBeforeCompile`**。自定义着色必须走 TSL 节点材质，
   颜色必须传线性分量：`new THREE.Color(hex)` 后再取 `.r/.g/.b`，直接塞 sRGB 数值会发白。
2. **引导图里不许静态 `import 'three/webgpu'`**。`renderer.ts` 保留了一个经典 `WebGLRenderer`
   兜底，静态导入会让它永远不可达（链接期就抛）。需要 WebGPU 构建的地方一律 `await import()`。
   `src/module-graph.test.ts` 守着这条。
3. **竖屏不拉伸**：`camera.aspect` 严格等于 drawingBuffer 比例，任何钳位都会造成压缩变形。
   竖向构图由 `index.html` 里 canvas 的 9:16 CSS 盒子负责。
4. **缺资源必须还能玩**：GLB 404 / 音频被浏览器拦截 / 没有 WebGPU，都必须降级而不是白屏。
5. **色彩单源**：`palettes.ts`。`HAZE_COLOR === SKY_PALETTE.horizon` 是硬契约
   （远景要溶解进同一个地平线色）；`SUN_POSITION === [60, 35, -280]` 是**默认种子**，
   不再是钉死值——`?sun=` / tod / 调色预设都会动它，`sunDirectionFor()` 保证三路联动。
   自由发挥走 `?palette=` 预设或 `src/visual-presets.ts`，关系不断就行，具体色号随便换。
6. **后处理契约**：bloom 阈值 0.82 是**纪律**（阈值永远压在天空非盘峰值之上），不是数字崇拜。
   换天空就重跑 `sky-color-js.test.ts` 的 bloom 预算；`?postfx=` / `?bloom=` / `?dof=` 就是给你调的。
   `noDof` 是诚实关 DOF（摘节点），别再把 `bokehScale` 置零糊弄了。
7. **相机**：`TUNING_RANGES` 已放宽为 distance `[6, 120]` / height `[1, 40]` /
   fovKick `[0, 15]` / bankFollow `[0, 1]`，默认 30/6.8/9/0.28 不变。`?cam=` / `?fov=` 随便玩，
   但 9:16 竖屏构图要连距离带高度一起重调；指数平滑核心不动。

## 资源

- `assets/blend/porco-fighter-v002.blend` — **当前** Blender 源文件（含 `ASSET-NOTES` 文本块，
  记录轴向/尺寸/涂装/改动清单）。真·可打开的 .blend。
- `assets/porco-fighter-v002.glb` — 导出件（Y-up，机头 +Z，33 个 mesh，4532 三角面，6 个材质，无贴图）
- `public/assets/porco-fighter-v002.glb` — 运行期同源副本（`/assets/porco-fighter-v002.glb`），
  `smoke` 会校验它与归档件逐字节一致
- `assets/blend/porco-fighter-v001.blend` — v001 归档件，按「v001 永久保留」的裁决不动。
  ⚠️ **这个文件不是可加载的 .blend**：它 zstd 解压后是一个伪造的 `BLENDER17-01v050` 头，
  没有 `DNA1` / `ENDB` 块，Blender 4.2 直接报 `not a blend file`。v002 因此是**导入
  `assets/porco-fighter.glb`（v001 的真身）后重建**的，不是从它改的。
- `assets/porco-fighter.glb` — v001 归档 GLB（27 mesh / 6292 三角面），现仅作历史留档

轴向：模型在 Blender 里烘焙成 Z-up、机头 -Y，glTF 导出器转换成 Y-up、机头 +Z；`plane.ts`
再用内层 `rotation.y = π` 把它对齐到飞行方向 -Z。改模型时不要动这个约定。

## 证据与文档

- [`docs/superpowers/INDEX.md`](docs/superpowers/INDEX.md) — **25 份计划/设计/评审文档的状态索引**。
  哪份是活计划、哪份是已放弃方向，先看它。
- `docs/superpowers/plans/2026-11-02-puff-cluster-cloud.md` — 云的设计种子，下一轮云重做从这里读起。
- `artifacts/` — **已于 2026-11-16 清空并加入 .gitignore**（曾是 965 个入库文件 / 106 MB 的
  抓帧证据与一次性量测脚本）。旧帧仍可从 git 历史取回：
  `git show <rev>:artifacts/<path> > out.png`。探针产物此后一律不入库。
- 量测口径：**像素差分探针（`scripts/cloud-probe.mjs`）只当整帧回归报警器**，不再充当
  画面正确性判据——它测的是「开关某层后差了多少像素」，不是「画得对不对」。正确性判据
  走 `src/cloud-mask.ts` 的遮罩计数（云单独渲进 RT，覆盖像素精确计数）与布局/投影的
  解析式单测。

## 已知不足（原型阶段接受）

- **穹顶云仍待重做**（2026-11-06 随海面一起删除，近景 puff 云没动也没重做）。
  昼夜天空与海霾联动、海面风格化 FFT（含细八度）、太阳路 v2 都在；画面有天穹 + 海面 + 近景云 + 飞机。
  2026-11-06 的删除是主动推倒，不是设计取舍。
- **没有战斗内容**。本计划只到「可飞、可看、可听」的垂直切片。
- **WebGL2 兜底路径的地平线曾是一条可见直线**（旧路径太阳圆盘更亮更大）。随双后端统一为
  `forceWebGL` 后应已消除，未重新实测。
- **移动端真机未验**：Android WebGL2 ≥ 30 fps 仍是待验项，见 `docs/PORTRAIT_QA.md`。

## 致谢 / Credits

- **Savoia S.21 比例参考** — [FEDERICOFELICI](https://sketchfab.com/FEDERICOFELICI)，
  [Savoia S.21](https://sketchfab.com/3d-models/savoia-s21-3418b01468474872939971466704bbc7)，
  **CC-BY 4.0**。本项目的 `porco-fighter-v002` 只借用它的机身/支柱高翼/推进式螺旋桨**比例关系**，
  几何全部自建，不包含该模型的任何网格数据；模型本身不随本项目分发。
  署名保留是 CC-BY 的要求，也是这一批「像但不是同一个」设计的出处说明。
- **Uber-Stylized-Water**（MIT）— 分层水面与 Anime 预设的参照。海面实现已回归并沿用其分层水面的参考思路，致谢保留。
