# 陆地 B2 · 单块 512m 实验体（导出面 + 接缝零）

**日期**：2026-11-13
**性质**：B2 的任务级计划（把 roadmap `plans/2026-11-05-land-flight-0-to-1.md:99` 的 B2 里程碑压成一次可验收的实验）
**上游**：[`plans/2026-11-13-painted-valley-look-master.md`](2026-11-13-painted-valley-look-master.md) 附录 A0（导出面）／A1–A3（外观依据）
**外观依据**：`G:\DSHProject\refs\painted-valley`（`src/lib/ground.js`、`src/lib/glsl.js:249-319`、`src/valley/floor.js`）——**这份依据不因任何仓库变动而失效**

> ⚠ **行动仓待钉**（2026-11-13 核）：roadmap 指定的 `G:\DSHProject\ThreeJSInspire-reconstruct` **当前不在磁盘上**，`origin` 也没有 `reconstruct` 分支（现有：`master` / `rebuild/sea-dome-reset` / `feat/dome-cloud-volumetric`）。
> 本计划的**内容不依赖仓库位置**；开工前只需拍板一件事：新分支开在哪个仓。推荐见 Task 0。

---

## Goal

在一块 **512 m × 512 m** 的地形补丁上，同时钉死两件事：

1. **导出面**：B2 交给着色层的东西，恰好是 A0 那张表——`heightAt(x,z)` 纯函数、解析法线、`slope`、世界锚定 mask、世界锚定 UV。
2. **接缝为零**：同一世界位置，无论由哪个 chunk 采样，得到的每个输入都**逐位相等**。

**不追求**：全省地形、流送、LOD、植被、最终着色。这一块只要能证明「导出面成立 + 边界看不出来」。

| 项 | 本计划 | 留给后续 |
| --- | --- | --- |
| 范围 | 512 m，4×4 个 128 m chunk | 全省 ring 流送（B2 后半） |
| 生成 | 同步生成（16 chunk） | Worker + 时间切片 + 双缓冲 |
| LOD | **单档** | 3 档 chunk LOD |
| 着色 | 诊断材质（硬边 + 软体块，**无笔触**） | B3 三段式正式实现 |
| 烘焙 | **不烘** | 布局图 1024²/8 km（A2） |

## Architecture

```
Task 1 field.ts        heightAt / 参数 / 纯函数         ← 一切的唯一真源
        │
Task 2 patch.ts        128m 格子 → 4×4 网格（共享晶格）  ← 接缝由「晶格共享」保证，不靠容差
        │
Task 3 normals.ts      解析法线 + slope + 单一 eps       ← 不读网格法线
        │
Task 4 masks.ts        世界锚定 mask / UV（暂用程序生成）  ← 禁 per-chunk 种子
        │
Task 5 debug-shading   硬边 + 软体块（诊断用，不是 B3）
        │
Task 6 抓帧 + 判据      四道接缝检查（两项本阶段可测，两项延后）
```

**顺序不可换**：2 依赖 1 的纯函数；3 必须从 1 算而不是从 2 的网格算；5 只用来让接缝**看得见**，不是交付物。

## Tech Stack

Three.js r186（WebGPU 优先 / WebGL2 回退）、TSL、Vitest、Vite 8、`?qa=frozen` 抓帧、`npm run smoke` 预算探针。

## Spec

### 参数（全部单源，写在一个导出对象里）

```ts
export const TERRAIN = {
  PATCH_METRES: 512,
  CHUNK_METRES: 128,        // 4×4
  LATTICE_METRES: 2,        // 每 chunk 65×65 顶点
  NORMAL_EPS_METRES: 1.0,   // 中央差分唯一步长
  FBM_OCTAVES: 5,
  FBM_LACUNARITY: 1.97,
  FBM_GAIN: 0.5,
  WARP_AMPLITUDE: 0.15,     // × 最低频特征尺寸，必须 ≪ 1
  MASK_TILE_METRES: 31,     // 与参考仓 strokeCoord2 的 31 对齐
} as const;
```

- 顶点世界坐标必须是 `LATTICE_METRES` 的整数倍（由 chunk 原点 + 索引算出，**不做任何平移抖动**）。
- `heightAt` 只读 `(x, z)` 与上面的常量；**不许** `Math.random`、`Date`、模块级可变状态、闭包计数器。

### 导出面（A0 的代码形状）

| 导出 | 签名 | 消费者 |
| --- | --- | --- |
| `heightAt` | `(x: number, z: number) => number` | B2 顶点、B3、相机、飞机碰撞 |
| `terrainNormalAt` | `(x: number, z: number) => [number, number, number]` | B3 硬边 / 软体块 |
| `terrainSlopeAt` | `(x: number, z: number) => number` | B3 坡向夸张 |
| `fieldMaskAt` | `(x: number, z: number) => { field: number; forest: number }` | B3 田野色 / 树篱 |
| `uvWorld` | `(x: number, z: number) => [number, number]` | 笔触层（B3 才有，但约定现在定） |

**禁止**：`patch` 把网格顶点法线、chunk id、per-chunk 随机种子交给着色层。法线一律由 B3 调 `terrainNormalAt` 现算。

## Global Constraints

1. TSL 节点材质；禁 `ShaderMaterial` / `onBeforeCompile`。
2. 禁静态 `import 'three/webgpu'`（保持 `await import()`）。
3. `heightAt` / `terrainNormalAt` / `fieldMaskAt` 必须是**纯函数**（同输入同输出，跨实例一致）。
4. 禁 per-chunk 随机：`src/terrain/*` 内出现 `Math.random` 即为失败。
5. 接缝判据用**逐位相等**（`Object.is`），不用容差。容差只用于抓帧后的 ΔL* 判据。
6. 顶点世界坐标落在共享晶格上；chunk 原点 = `n × CHUNK_METRES`。
7. 除飞机外全场禁量化（A3）：诊断材质的硬边必须 `smoothstep` + `fwidth`，不得用 `step` 造色阶。
8. 地形 opaque 预算 **1.8 ms**（roadmap §7 表）；抓帧时用 `frame-stats` 记录。
9. 开关：`?land=0` 必须回到与 `0c68700` **逐位相同**的帧（byte gate）。
10. 不烘布局图（A2 门），不抄参考仓的 6.2 km backdrop 与米制数值。

## Review Focus

- **逐位相等是不是真的逐位**：测试要断言 `Object.is(a, b)`，不是 `Math.abs(a-b) < 1e-6`。容差会把「晶格错位」这种真 bug 藏起来。
- **eps 是否单源**：`NORMAL_EPS_METRES` 只许有一处定义；B3 不许自带 eps。
- **法线是否真的没读网格**：诊断材质里若出现 `normalLocal` / `normalWorld`，即为违约。
- **世界锚定是否真的锚定**：`fieldMaskAt` / `uvWorld` 的签名里不许出现 chunk/局部坐标。
- **诊断材质别偷偷长成 B3**：它只画两种东西（硬边 + 软体块），加笔触就超出本计划。

---

## Task 0 · 前置：仓库与基线

**目的**：把「在哪做」和「跟谁比」定死，否则后面所有判断都没有落点。

- [x] 0.1 拍板行动仓（**已定 2026-11-13：主仓新分支**）：
  - ✅ 采用：**主仓新分支** `feat/land-b2`，从 `0c68700` 切。
  - 理由见下方「为什么推荐主仓」。
- [x] 0.2 建分支 + 打基线 tag（`land-B2-base` → `0c68700`）。⚠ 建分支时未切换：工作树有 3 个未提交的 sky 相关改动（`src/main.ts` +10、`src/sky-webgpu.ts` +69、`src/sky-color-js.test.ts` +41），不属于本计划，切换前需先落定。
- [ ] 0.3 抓基线帧：`?palette=sunset&postfx=sunset&cam=sunset&fov=60&qa=frozen`，落 `artifacts/look-baseline/2026-11-13-land-before/`。
- [ ] 0.4 记录 `npm test` 当前总数（作为本计划结束时的对比）。

**为什么推荐主仓**：

1. `reconstruct` 当初的存在理由是「删掉海/穹顶再重建」。**主仓的海与穹顶已经重建完了**，这个理由没了。
2. 陆地判据依赖 `HAZE_FAR 520` 与天空/海面同框，主仓才有这些上下文；reconstruct 里看接缝是盲看。
3. 同仓 = 同一套 vitest、抓帧、`frame-stats`、`?qa=frozen`，少一套基础设施，也少一处会漂移的基线。

## Task 1 · `src/terrain/field.ts`

**文件**：`src/terrain/field.ts`、`src/terrain/field.test.ts`

- [ ] 1.1 先写测试（红）：
  - `heightAt(x, z)` 调两次 → `Object.is` 相等；
  - 两个互不相关的调用序列（先 A 后 B vs 先 B 后 A）→ 同点同值；
  - 源码扫描：模块内不含 `Math.random(`、`Date.`、`performance.now(`。
- [ ] 1.2 实现 fBm：`FBM_OCTAVES 5`、`FBM_LACUNARITY 1.97`、domain warp 幅度 `WARP_AMPLITUDE × 最低频特征尺寸`。
- [ ] 1.3 断言 warp 不破接缝：`heightAt` 里所有采样坐标都是 `(x, z)` 的确定性函数，无累积误差。
- [ ] 1.4 量生成成本：`heightAt` 单次调用均值（记录到计划末尾），用于估 67.6k 顶点的同步生成时间。

**门**：测试绿；源码扫描零命中；单次 `heightAt` ≤ 5 µs（否则同步生成会超 300 ms）。

## Task 2 · `src/terrain/patch.ts`（接缝的核心）

**文件**：`src/terrain/patch.ts`、`src/terrain/patch.test.ts`

- [ ] 2.1 先写测试（红）：相邻两个 chunk 的共享边顶点，`Object.is` **逐位相等**。
- [ ] 2.2 先写一个「故意错」的实现跑一遍（每 chunk 自带 0.5 m 偏移），确认测试**能红**——防止测试永绿。
- [ ] 2.3 实现：chunk 原点 = `(cx, cz) × CHUNK_METRES`；顶点世界坐标 = 原点 + `i × LATTICE_METRES`；共享边两侧算出**同一个浮点数**。
- [ ] 2.4 断言顶点坐标落在晶格上（`x % LATTICE_METRES === 0`，用整数运算避免浮点余数陷阱）。
- [ ] 2.5 4×4 patch 组装：16 个 `BufferGeometry`（或一个合并 geometry），暴露 `patchVertices()` 供测试与诊断材质使用。

**门**：逐位相等测试绿；构造性错版能红；16 chunk 同步生成 ≤ 300 ms。

## Task 3 · `src/terrain/normals.ts`

**文件**：`src/terrain/normals.ts`、`src/terrain/normals.test.ts`

- [ ] 3.1 先写测试（红）：
  - 平地场（`heightAt` 恒为 0）→ 法线 `(0,1,0)`，误差 ≤ 1e-9；
  - 线性斜坡场 → 法线与解析解一致（≤ 1e-6）；
  - 换 eps（临时改常量）→ 法线变化，证明 eps 真的参与计算。
- [ ] 3.2 实现中央差分：`n = normalize([h(x-e)-h(x+e), 2e, h(z-e)-h(z+e)])`，`e = NORMAL_EPS_METRES`。
- [ ] 3.3 `terrainSlopeAt = 1 - n.y`（或 `acos`，二选一并写死；B3 只吃这一个口径）。
- [ ] 3.4 断言：法线只依赖 `heightAt` 与 eps（源码层面不 import patch 模块）。

**门**：三组测试绿；`normals.ts` 不 import `patch.ts`（依赖方向单向）。

## Task 4 · `src/terrain/masks.ts`

**文件**：`src/terrain/masks.ts`、`src/terrain/masks.test.ts`

- [ ] 4.1 先写测试（红）：同一世界点，经「chunk A 的局部查询」与「直接世界查询」得到相同 mask。
- [ ] 4.2 实现世界锚定程序的 mask（本阶段不烘）：`fieldMaskAt(x, z)` 用 `fBm(x/256, z/256)` 等，参数全部世界坐标；`forest` 同理。
- [ ] 4.3 `uvWorld(x, z) = [x / MASK_TILE_METRES, z / MASK_TILE_METRES]`，**只吃世界坐标**。
- [ ] 4.4 断言签名：三个函数只接受 `(x: number, z: number)`，不接受 chunk/局部参数（类型层面就挡住）。

**门**：跨 chunk 一致测试绿；签名无 chunk 形参。

## Task 5 · 诊断材质 `src/terrain/debug-shading.ts`

**目的**：让接缝**看得见**。它只画硬边 + 软体块，不做笔触、不烘——加笔触就变成 B3 了。

- [ ] 5.1 TSL 节点：`litW = dot(terrainNormalAt(x,z), sunDir)`；硬边 `smoothstep(edge-e, edge+e, litW)`，`e = 0.02`；软体块 `smoothstep(0.25, 0.85, litW)` 混两个色。
- [ ] 5.2 颜色只从 `palettes.ts` 取（单源），不新增十六进制字面量。
- [ ] 5.3 断言材质里**不出现** `normalLocal` / `normalWorld`（源码扫描测试）。
- [ ] 5.4 `?land=0` 时不挂载任何节点，帧与 `0c68700` 逐位相同。

**门**：5.1–5.4 全绿；抓帧能看到地形与接缝。

## Task 6 · 抓帧与四道接缝检查

**文件**：`artifacts/land-b2/<date>/`（帧 + sidecar + metrics + 结论）

- [ ] 6.1 抓三态：俯视看边（`?cam=highWide`）、掠射 1–5°（`?cam=lowChase`）、正常飞行（默认）。
- [ ] 6.2 **检查 1 · 边界色带连续**：沿接缝 1 像素带取 L*，两侧 ΔL* p95 ≤ 0.5。
- [ ] 6.3 **检查 2 · 无 chunk 依赖**：同一世界点由两个 chunk 采样，`heightAt`/法线/slope/mask **逐位相等**（测试已覆盖，抓帧只做人眼确认）。
- [ ] 6.4 **检查 3 · 掠射边宽**：俯角 1–5° 时硬边不得糊成宽带（`fwidth` 在掠射角会爆）；本阶段只**记录现象**，不设阈值。
- [ ] 6.5 **检查 4 · 烘焙显影**：不适用（本阶段不烘）。**记为延后**，理由写进结论。
- [ ] 6.6 结论表：四个检查 × 通过/延后/失败 + 证据路径。

**门**：检查 1 达标；检查 3 有录像/帧记录；检查 2 由测试背书。

## Task 7 · 硬化与交接

- [ ] 7.1 `?land=0` byte gate 复验（与基线帧逐位比对）。
- [ ] 7.2 记录地形 opaque GPU ms（`frame-stats`，预算 1.8 ms）。
- [ ] 7.3 打 tag `land-B2-spike`，写交接段：B3 可以依赖哪五个导出、哪个常数是唯一真源。
- [ ] 7.4 更新主案 §6 附录 A0 的「已实现」状态。

**门**：7.1 逐位相同；7.2 ≤ 1.8 ms 或写明超支原因。

---

## 回退

- 回退单位是 **commit + tag**（`land-B2-base` → `land-B2-spike`），不是分支。
- 任一 Task 失败：回到该 Task 之前的 commit，`?land=0` 保证默认帧不受影响。
- 中止条件（触发即停，不再往前）：Task 2 的逐位相等**做不到**（说明晶格假设错了，需要重设计而不是硬调）；或 Task 6 检查 1 反复不达标且原因指向 `heightAt` 本身不连续。

## 本计划明确不做

1. 流送 / ring / 卸载（B2 后半）。
2. LOD 与换档过渡（A4 检查 2 的完整版）。
3. Worker、时间切片、双缓冲。
4. 布局图烘焙（A2）。
5. 笔触层与 `paintCells`（B3）。
6. 植被（B4）、镜头重标定（B5）、WebGL2 硬化（B6）。
7. 参考仓的 6.2 km backdrop、米制距离带、白天顶光配色。
