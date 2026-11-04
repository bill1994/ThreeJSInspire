# Porco Sunset Dogfight

竖屏（720 × 1280）日落海面空战原型。Three.js r186，WebGPU 优先、WebGL2 自动回退
（同一套 TSL 代码，WebGL2 走 `forceWebGL`）。飞机模型由 Blender 构建并导出为单文件 GLB。

> **当前基线：`reconstruct`。海是缺的。**
> FFT 海面与体积云穹顶在 2026-11-04 被删除，正在用参数化 Gerstner 重建（计划 7 个 Task，
> 落地 1 个）。所以现在跑起来是 **天 + 近景云 + 飞机**，脚下没有水面，启动条显示 `sky + puffs`。
> 状态与去留请先读 [`docs/superpowers/INDEX.md`](docs/superpowers/INDEX.md)。

## 运行

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # tsc --noEmit && vite build
npm test             # vitest run（28 个文件 / 244 个用例）
npm run smoke        # 结构自检：模块、资源、GLB 魔数
```

> Vite 在本机只监听 `::1`，浏览器请用 `http://localhost:5173`。若 `127.0.0.1` 打不开不是 bug。

## QA 开关

| 开关 | 作用 |
| --- | --- |
| `?backend=webgl2` | 强制走 WebGL2（`forceWebGL`） |
| `?backend=webgpu` | 强制 WebGPU；探针失败时**直接报错而不是回退**，用来暴露真实的 WebGPU 问题 |
| `?post=0` | 关掉后处理管线（bloom / 景深 / SMAA），排查管线问题时用 |
| `?alt=<米>` | 出生高度覆盖。云的 slab 在 95–265 m，爬升一整个周期才到，调云不必每次爬 |
| `?pos=x,y,z` | 直接摆飞机位置，抓帧可复现 |
| `?puff=0` | 藏掉近景云场，做 paired on/off 差分 |
| `?qa=frozen` | 停掉动画循环，帧完全可复现（配合 `__porco.qa.step()` 手动推进） |

页面左下角的启动条显示 `backend · worldLabel`（现在是 `sky + puffs`），6 秒后淡出
（元素仍在 DOM 里，可 `document.querySelector('#boot-status').textContent` 读回来）。

浏览器控制台里有只读调试句柄：

```js
__porco.backend      // 'webgpu' | 'webgl2'
__porco.scene        // THREE.Scene
__porco.camera       // PerspectiveCamera
__porco.game.pose()  // 飞机的实时世界坐标
__porco.world        // { update, dispose, quality, blobs, setPuffVisible }
__porco.qa.step(60)  // 冻结态下手动推 60 帧
__porco.qa.describe()// 抓帧所需的全部可复现信息 + renderer.info
```

## 结构

| 文件 | 职责 |
| --- | --- |
| `src/main.ts` | 唯一的组合根：渲染器 → 天空 → 世界 → 游戏 → 动画循环 |
| `src/renderer.ts` | WebGPU 探测 + WebGL2 回退，`?backend=` 覆盖 |
| `src/world.ts` | 世界总装（现在只装近景云）+ `FrameGovernor`（连续 60 帧超 24 ms 降档） |
| `src/sky-webgpu.ts` | TSL 落日天穹 + 永不黑屏的 canvas 渐变背景（两个后端共用这一份） |
| `src/lights.ts` | 日落光照，后端无关 |
| `src/palettes.ts` | 全部颜色的单源 |
| `src/horizon.ts` | 海天雾/辉光的纯函数参考实现（**当前无场景侧消费者**，是重建要对的契约） |
| `src/far-field.ts` | 把天穹壳拖到飞机下方、近景云环面回收 |
| `src/puff-cloud.ts` | 近景云材质与装配 |
| `src/puff-field.ts` | 近景云簇散布与回收：方形环面窗口 + 抖动网格 + 相干覆盖掩码（纯函数，同 seed 深相等） |
| `src/puff-shape.ts` | 单朵云的几何：竖直主轴大瓣 + 肩瓣，合并成一个 mesh |
| `src/in-cloud.ts` | 「相机离最近的云多近」，驱动 HUD 白雾、相机扰动与台词 |
| `src/sea/waves.ts` | **重建中**：Gerstner 波场纯数学（5 波列、解析法线、雅可比）。尚未接入渲染 |
| `src/plane.ts` | GLB 加载 + 三级姿态包装 + 占位机（缺资源也能飞） |
| `src/input.ts` | Pointer Events 单一通路，4 px 死区，径向死区 |
| `src/camera-rig.ts` | 跟随相机：死区、指数平滑、FOV kick |
| `src/director.ts` | 相机作为导演：接管/交还，不拥有常量 |
| `src/spiral.ts` / `src/stall.ts` / `src/skim.ts` | 三个玩法判据：螺旋俯冲 / 失速 / 掠海 |
| `src/feel.ts` | trauma 抖动 + 翼尖尾迹池 |
| `src/hud.ts` | DOM HUD（安全区锚定，不挡画面）+ 音量滑块 |
| `src/audio.ts` | WebAudio 总线（Master ← Music/SFX/Ambience/UI），自适应音乐，侧链 duck；**无采样文件，全是合成都** |
| `src/subtitles.ts` | 剧情字幕，每次出击每句最多一次 |
| `src/sun-road.ts` | 把海面现有高光变成朝太阳的一条路。**当前无场景侧消费者**，重建 Task 5 直接复用 |
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
5. **色彩单源**：`palettes.ts`。`SEA_PALETTE.haze === SKY_PALETTE.horizon` 是硬契约
   （海面远场要溶解进同一个地平线色），`SUN_POSITION === [60, 35, -280]` 也是钉死的。
6. **后处理契约**：bloom 阈值 0.82、K4 边距 0.063。改海面亮度时会撞这两条。

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

- [`docs/superpowers/INDEX.md`](docs/superpowers/INDEX.md) — **28 份文档的状态索引**。
  哪份是活计划、哪份是已放弃方向，先看它。
- `docs/superpowers/plans/2026-11-04-stylized-sea.md` — 当前任务清单（海面重建 7 个 Task）。
- `artifacts/` — 量测仪器与证据。可复现的冻结帧在 `cloud-audit/protocol*/`；
  已删实现的证据统一在 `artifacts/archive/`。
- 量测一律跑脚本，不靠眼睛：
  `python artifacts/cloud-audit/audit.py --parity` 出全表 + 对账门。

## 已知不足（原型阶段接受）

- **没有海**。这是重建进行中的状态，不是设计取舍。
- **没有战斗内容**。本计划只到「可飞、可看、可听」的垂直切片。
- **远处 sparkle 曾聚成圆形亮斑** —— 这一条属于已删除的 FFT 实现（glitter 项在斜视角高光聚集），
  随贴图一起消失，重建走解析法线后需重新验证，不能假定已根治。
- **WebGL2 兜底路径的地平线曾是一条可见直线**（旧路径太阳圆盘更亮更大）。随双后端统一为
  `forceWebGL` 后应已消除，未重新实测。
- **移动端真机未验**：Android WebGL2 ≥ 30 fps 仍是待验项，见 `docs/PORTRAIT_QA.md`。

## 致谢 / Credits

- **Savoia S.21 比例参考** — [FEDERICOFELICI](https://sketchfab.com/FEDERICOFELICI)，
  [Savoia S.21](https://sketchfab.com/3d-models/savoia-s21-3418b01468474872939971466704bbc7)，
  **CC-BY 4.0**。本项目的 `porco-fighter-v002` 只借用它的机身/支柱高翼/推进式螺旋桨**比例关系**，
  几何全部自建，不包含该模型的任何网格数据；模型本身不随本项目分发。
  署名保留是 CC-BY 的要求，也是这一批「像但不是同一个」设计的出处说明。
- **Uber-Stylized-Water**（MIT）— 重建海面的分层与 Anime 预设参照。
