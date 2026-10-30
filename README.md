# Porco Sunset Dogfight

竖屏（720 × 1280）日落海面空战原型。Three.js r186，WebGPU 优先、WebGL2 自动回退，
真 FFT 海面 + 体积云（TSL），回退路径是解析 Gerstner 海 + billboard 云，飞机模型由 Blender
构建（`assets/blend/porco-fighter-v001.blend`）并导出为单文件 GLB。

## 运行

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # tsc --noEmit && vite build
npm test             # vitest run
npm run smoke        # 结构自检：模块、资源、GLB 魔数
```

> Vite 在本机只监听 `::1`，浏览器请用 `http://localhost:5173`。若 `127.0.0.1` 打不开不是 bug。

## QA 开关

| 开关 | 作用 |
| --- | --- |
| `?backend=webgl2` | 强制走 WebGL2 回退路径（Gerstner 海 + sprite 云 + GLSL 天穹），用来验收「没有 WebGPU 的设备」 |
| `?backend=webgpu` | 强制 WebGPU；探针失败时**直接报错而不是回退**，用来暴露真实的 WebGPU 问题 |

页面左下角的启动条会显示 `backend · seaKind sea · cloudKind clouds`，6 秒后淡出（元素仍在 DOM 里，
可以 `document.querySelector('#boot-status').textContent` 读回来）。

浏览器控制台里还有一个只读的调试句柄：

```js
__porco.backend      // 'webgpu' | 'webgl2'
__porco.scene        // THREE.Scene
__porco.camera       // PerspectiveCamera
__porco.game.pose()  // 飞机的实时世界坐标
__porco.world        // { update, dispose, seaKind, cloudKind, quality }
```

## 结构

| 文件 | 职责 |
| --- | --- |
| `src/main.ts` | 唯一的组合根：渲染器 → 天空 → 世界 → 游戏 → 动画循环 |
| `src/renderer.ts` | WebGPU 探测 + WebGL2 回退，`?backend=` 覆盖 |
| `src/sky-sunset.ts` | GLSL 落日天穹（WebGL2 路径）+ 共用光照 |
| `src/sky-webgpu.ts` | TSL 落日天穹 + 永不黑屏的 canvas 渐变背景 |
| `src/world.ts` | 海面 + 云的总装，含 `FrameGovernor`（连续 60 帧超 24 ms 降档） |
| `src/sea-fft.ts` | CPU FFT 海面 → RGBA16F 贴图 → TSL 位移/法线/toon 着色 |
| `src/sea-fallback.ts` | 4 波解析 Gerstner 海（GLSL），世界坐标求值 |
| `src/clouds-compute.ts` | 云层板体积 raymarch（TSL，12 步 / 低档 8 步） |
| `src/clouds-fallback.ts` | billboard 云团（顶点着色器展开） |
| `src/far-field.ts` | 把海面/云壳/天穹拖到飞机下方（FFT 海按 400 m 波周期吸附） |
| `src/plane.ts` | GLB 加载 + 三级姿态包装 + 占位机（缺资源也能飞） |
| `src/input.ts` | Pointer Events 单一通路，4 px 死区，径向死区 |
| `src/camera-rig.ts` | 跟随相机：死区、指数平滑、FOV kick |
| `src/feel.ts` | trauma 抖动 + 翼尖尾迹 |
| `src/hud.ts` | DOM HUD（安全区锚定，不挡画面）+ 音量滑块 |
| `src/audio.ts` | WebAudio 总线（Master ← Music/SFX/Ambience/UI），自适应音乐，侧链 duck |
| `src/game.ts` | 飞行模型（纯函数 `stepFlight`）+ 装配 |

## 关键约束（改代码前先读）

1. **WebGPU 下不可用 `ShaderMaterial` / `onBeforeCompile`**。自定义着色必须走 TSL 节点材质，
   颜色必须传线性分量：`new THREE.Color(hex)` 后再取 `.r/.g/.b`，直接塞 sRGB 数值会发白。
2. **FFT 海面是 400 m 周期的平铺贴图**（`SEA_FOLLOW_STEP`）。`far-field.ts` 按整周期吸附网格，
   所以平铺周期、`TEX_REPEAT`、几何尺寸三者必须自洽；改一个就要连带改 `src/sea.test.ts` 与
   `src/far-field.test.ts`。
3. **竖屏不拉伸**：`camera.aspect` 严格等于 drawingBuffer 比例，任何钳位都会造成压缩变形。
   竖向构图由 `index.html` 里 canvas 的 9:16 CSS 盒子负责。
4. **缺资源必须还能玩**：GLB 404 / 音频被浏览器拦截 / 没有 WebGPU，都必须降级而不是白屏。

## 资源

- `assets/blend/porco-fighter-v001.blend` — Blender 源文件（含 `ASSET-NOTES` 文本块，记录轴向/尺寸/涂装）
- `assets/porco-fighter.glb` — 导出件（Y-up，机头 +Z，27 个 mesh，6 个材质，无贴图）
- `public/assets/porco-fighter.glb` — 运行期同源副本（`/assets/porco-fighter.glb`）

轴向：模型在 Blender 里烘焙成 Z-up、机头 -Y，glTF 导出器转换成 Y-up、机头 +Z；`plane.ts`
再用内层 `rotation.y = π` 把它对齐到飞行方向 -Z。改模型时不要动这个约定。

## 致谢 / Credits

- **Savoia S.21 比例参考** — [FEDERICOFELICI](https://sketchfab.com/FEDERICOFELICI)，
  [Savoia S.21](https://sketchfab.com/3d-models/savoia-s21-3418b01468474872939971466704bbc7)，
  **CC-BY 4.0**。本项目的 `porco-fighter-v002` 只借用它的机身/支柱高翼/推进式螺旋桨**比例关系**，
  几何全部自建，不包含该模型的任何网格数据；模型本身不随本项目分发。
  署名保留是 CC-BY 的要求，也是这一批"像但不是同一个"设计的出处说明。

## 已知不足（原型阶段接受）

- **近场 10–30 m 是软涌浪，不是碎浪**：要 256² 的 FFT 才能出碎浪，实测 14.77 ms/帧，
  超出 16.67 ms 预算，所以封顶 128²。
- **远处 sparkle 会聚成圆形亮斑**：glitter 项在斜视角度下的高光聚集，调参可缓解，未根治。
- **WebGL2 兜底路径的水天线是一条可见直线**：那条路径的太阳圆盘比 WebGPU 更亮更大，
  海面 haze 是按自己的太阳调的；功能上没问题，观感上不如 WebGPU 路径。
- **没有战斗内容**：本计划只到「可飞、可看、可听」的垂直切片。
