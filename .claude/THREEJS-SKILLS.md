# Three.js Skill 覆盖映射

项目：ThreeJSInspire（three 0.186.0，Vite + TS，无 React）

## 已装 skill

本仓库自研（r186 对齐）：
- `threejs-scene-setup` — renderer / 渲染循环 / resize / 场景图
- `threejs-gltf-loading` — GLTFLoader、进度、克隆、释放、动画
- `threejs-materials-lighting` — 材质与灯光速查表
- `threejs-game-ui-designer` — 游戏 UI 方向

上游引入（CloudAI-X/threejs-skills，MIT，r186）：
- `threejs-geometry` — 内置几何、BufferGeometry、InstancedMesh、BatchedMesh、Points/Lines、morph、释放
- `threejs-textures` — 色彩空间、UV、KTX2/WebP、渲染目标、env map
- `threejs-shaders` — ShaderMaterial GLSL、onBeforeCompile、TSL
- `threejs-postprocessing` — EffectComposer、UnrealBloom、OutputPass、RenderPipeline
- `threejs-interaction` — raycast、OrbitControls、TransformControls、gizmo、instance 拾取
- `threejs-performance` — renderer.info、merge/instance/batch/LOD、填充率、阴影冻结、着色器预编译
- `threejs-asset-pipeline` — gltf-transform inspect/validate/optimize、Draco/meshopt/quantize、KTX2

## 上游未装（及其本仓库替代）

上游 skill 的 "See Also" 会引用这些名字，按下表映射到本仓库已有 skill，**不要**以为缺失：

| 上游名 | 本仓库替代 |
|---|---|
| `threejs-fundamentals` | `threejs-scene-setup` |
| `threejs-materials` / `threejs-lighting` | `threejs-materials-lighting`（合体） |
| `threejs-loaders` | `threejs-gltf-loading` |
| `threejs-animation` | 暂无（需要时再装） |
| `threejs-react-three-fiber` | 不适用，本项目无 React，不装 |

补齐命令（按需）：
```bash
npx skills add https://github.com/CloudAI-X/threejs-skills --skill threejs-animation -y
```

## 重叠与优先级

- **`threejs-performance` vs `performance-optimization`**：前者 three.js 专用（draw call、填充率、GPU 内存计数器）；后者引擎中立方法论（帧预算、profiler 流程、对象池）。three.js 项目优先前者，方法论层面参考后者。
- **`threejs-textures` vs `threejs-materials-lighting`**：贴图采样/编码/内存看前者，材质参数与光照配比看后者。
- **`shader-programming`（通用）vs `threejs-shaders`**：先看通用 GLSL 基础，落到 three.js 的 uniform/材质注入/TSL 看后者。

## 来源

全部取自 https://github.com/CloudAI-X/threejs-skills（main，MIT），SKILL.md 原文未改写。
更新：重新下载对应目录的 `SKILL.md` 覆盖即可。
