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

## DSH 侧安装位置（别装错）

**DSH 不扫描 `.claude/skills`** —— 那个目录是给 Claude Code 用的。DSH 的 `skill-filesystem` 有两个用户侧内置根，都会全量扫进模型 catalog：

| 根 | 路径 | 说明 |
|---|---|---|
| user-agents（共享池） | `%USERPROFILE%\.agents\skills` | 多 agent 共用；`DSH_AGENTS_HOME` 可覆盖 |
| DSH 用户库 | `%USERPROFILE%\.dsh\skills` | skills-management 的 `installedDir`；「已安装」视图管理这里 |

两个根地位相同，模型都能调。**实体只放一份**，本仓库统一放共享池 `~/.agents/skills/`，避免两处副本各自漂移。改完靠宿主 watcher 热生效，无需重启。

上游 13 个已全部装入共享池（含本项目不用的 `threejs-react-three-fiber`，池是全局的，保留不影响本项目）：

```powershell
# 全量更新
$tmp = "$env:TEMP\threejs-skills-upstream"
git clone --depth 1 https://github.com/CloudAI-X/threejs-skills.git $tmp
Copy-Item "$tmp\skills\*" -Destination "$env:USERPROFILE\.agents\skills" -Recurse -Force
```

已装版本：上游 main `0e18186`（2026-10-19）。

共享池中的 `threejs-fundamentals` / `threejs-materials` / `threejs-lighting` / `threejs-loaders` / `threejs-animation` 与上表"上游未装"一栏互补——`.claude/skills` 里没装的那些，DSH 侧已经有了，不必再对照替换。

单个技能想对模型隐藏：在 `SKILL.md` frontmatter 加 `disable-model-invocation: true`（也可在 skills-management 详情页开关）。

## 第二批：threejs-game-skills

来源 https://github.com/majidmanzarpour/threejs-game-skills（main `8286774`，2026-09-27，MIT）。
9 个 skill，同样装在共享池 `~/.agents/skills/`。它是**游戏向**的，不是 API 速查。

| skill | 本项目价值 | 说明 |
|---|---|---|
| `threejs-qa-release` | **高** | 补上项目当前唯一硬缺口：画面级验证。`scripts/inspect-threejs-canvas.mjs` 给截图、canvas 非空白像素、颜色熵/边缘密度/亮度对比、`renderer.info` 预算行、多 viewport、console 报错 |
| `threejs-aaa-graphics-builder` | **高** | 10 类视觉评分卡 + technical-art 预算 + shader cookbook；自带 3 张校准锚图。日落海面/体积云正对口径 |
| `threejs-debug-profiler` | **高** | 双后端（WebGPU / WebGL2 回退）是 bug 高发区；playbook 覆盖空白画布、runtime、resize、移动端输入、draw call/内存/着色器成本 |
| `threejs-gameplay-systems` | 中 | `references/game-feel.md`、`genre-design.md`、`physics-engine-selection.md` 有参考价值。**但它打包了整套 Vite+TS 脚手架**（`assets/threejs-vite-game/`、`scripts/create_threejs_game.py`），本项目结构已自立，不要跑 |
| `threejs-game-ui-designer` | 中 | 与项目自研同名 skill 冲突，见下 |
| `threejs-game-director` | 低 | 总控路由，只在"整包做游戏/大改"时用 |
| `threejs-3d-generator` | 条件 | 需 `TRIPO_API_KEY`（当前 MISSING） |
| `threejs-image-generator` | 条件 | 需 `GEMINI_API_KEY`（当前 MISSING） |
| `threejs-audio-generator` | 条件 | 需 `ELEVENLABS_API_KEY`（当前 MISSING） |

### 冲突与保护

- **`threejs-gameplay-systems` 脚手架**：`create_threejs_game.py` 会铺一套通用 `src/{core,entities,game,systems,utils}`，与项目现有的 `sea-fft` / `clouds-compute` / `camera-rig` / `feel` / `hud` 结构不同。只用它的 references，不要用它建工程。
- **`threejs-game-ui-designer` 同名两份**：共享池是上游版（生效），`.claude/skills/` 是项目自研版（DSH 不读，Claude Code 读）。改 HUD 时先确认读的是哪份。
- **`threejs-gameplay-systems` 的 game feel 建议** 与项目已有 `src/feel.ts` 可能分歧：以现有实现为准，skill 只作参考，不要反向重写。

### 跑 QA 前的前置依赖

`inspect-threejs-canvas.mjs` 依赖 `@playwright/test` + `pngjs`，本项目尚未安装。且脚本注释要求用带 GPU 的 chromium，不是 headless shell：

```powershell
npm i -D @playwright/test pngjs
npx playwright install --no-shell chromium
node "$env:USERPROFILE\.agents\skills\threejs-qa-release\scripts\inspect-threejs-canvas.mjs" --url http://localhost:5173
```

竖屏基准用 `--mobile`（脚本内 device profile），配合项目已有的 `?backend=webgl2` 逐条验回退路径。
