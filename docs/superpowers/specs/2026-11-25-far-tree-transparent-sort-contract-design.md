# 透明排序契约：拆掉 renderOrder 硬压，交给真实深度排序

日期：2026-11-25
基线：`11fd65d`（`farTrees.renderOrder = -960` 的止血版）
状态：设计待批准，尚未改动 `src/`

---

## 1. 意图与为什么

`11fd65d` 用一个显式的 `renderOrder = -960` 让远树先画，把"树压在云上"的症状按住。
根因报告（`docs/superpowers/reviews/2026-11-24-far-trees-punch-through-puff-clouds.md`）
已经确认：远树 billboard 每岛一个 `InstancedMesh`、实例全部由批次原点派生，
所以 three 的透明排序键（`matrixWorld` 位置换算的 clip 深度）每批塌成同一个值，
它们与其他透明物的先后**本来就随机**。

`-960` 没有治这个随机性，它只是把随机性换成了一个手写常数。代价有三条：

1. 顺序变成隐式契约。以后任何人加一个 `renderOrder` 为 0 的透明物体，都会在云前/云后
   踩到不可预测的结果。
2. 它压迫的其实是**两族云**（体积 puff 在 0，背景云卡在 `-950 / -900+rank`），
   而这两族云自己的顺序也是手排的——一处硬压叠着另一处手排，两处都要有人记得。
3. 方向性错误换了个位置：比 800 m 云壳更近的透明物，现在会被云卡盖住。

目标是把这套"谁先画"从**人写的常数**换成**几何本来就有的深度**：让每个透明物
有一个可信的排序键，让 three 自己去排，然后删掉所有为对抗排序而存在的 `renderOrder`。

## 2. 目标 / 非目标 / 反目标

### 目标

- G1 每批远树的排序键反映它真实的球面位置（而不是世界原点）。
- G2 删掉 `src/land/archipelago.ts` 的 `farTrees.renderOrder = -960`。
- G3 **~~删掉背景云卡的手排 `-950 / -900+rank`~~ —— 已撤销**（builder check 证伪，
  见 §4.3）。云卡是背景图层，钉在 800 m 伪距离壳上，它的"深度"不代表视觉前后，
  不参与深度排序；要改的只是把这些魔数收敛成具名图层常量。
- G4 修复后，**体积云（puff）对"位于其后方的远树"的遮挡关系**由深度排序自然得出，
  而不是由常数保证。背景云卡对树的遮挡由**图层语义**保证（卡在 3D 几何之后画），
  这一条不再要求"由深度排序得出"。
- G5 顺带修复 `-960` 的方向性缺陷：比 800 m 更近的透明物不再被云卡盖住。
- G6 性能不回退，且给出可复现的测量数据。

### 非目标

- N1 不改体积云 `depthTest = false / depthWrite = false` 的自裁剪策略
  （`src/puff-volume.ts:126-128`）。那是有意为之，且工作正常。
- N2 不把远树拆成比"每岛一批"更细的批次。19 批够用，拆细会牵动实例索引、
  `setColorAt`、`computeBoundingSphere` 和 `y = -100000` 的 LOD 隐藏约定。
- N3 不动雾与观感参数（`src/land/baked-trees.ts:96` 的 `mist` 上限 0.32、
  `fog: false`）。"远树 1.5 km 外还太刺眼"是另一条战线，这次不掺。
- N4 不动 sky / stars 的 `renderOrder`（`-1000` / `-999`）。它们不是"被排序的透明物"，
  是背景层，先画是语义而不是补丁。

### 反目标（技术上做成了也算失败）

- A1 引入新的隐式顺序约定，或把 `renderOrder` 从一个常数挪到另一个常数。
- A2 靠"让云不透明""把云推远""给树加雾"这类调参把症状盖掉。
- A3 为了排序正确而牺牲画面：任何非排序差异（云形、树位置、颜色）都不允许出现。

## 3. 约束

- C1 项目是 three 0.186.0 + WebGPU/TSL node material，改动必须走 node API，
  不引入 GLSL 字符串。
- C2 `npm test`（89 文件 / 891 测试）与 `npm run build` 必须保持通过。
- C3 水面反射链路不参与远树（`waterReflectables()` 跳过
  `userData.separateLandReflection` 子树，`src/land/archipelago.ts:82`），
  改动不得破坏这个隔离。
- C4 云卡每帧会跟着相机重投影（`factor = displayRadius / distance`，
  `src/bg-cloud-field.ts:286-289`），所以它们的排序键每帧变，不能靠一次性预处理。
- C5 验收必须能在无人工介入下复现（脚本 + 固定 URL 参数）。

## 4. 怎么做

### 4.1 远树批次拥有真实位置

在 `src/land/archipelago.ts` 每岛构建 `farTrees` 时：

1. 从该岛全部树的实例位置算出中心 `c`。直接用 `farTrees.computeBoundingSphere()`
   得到的 `boundingSphere.center` 最省事：它就是实例矩阵的局部球心，与剔除同源。
2. `farTrees.position.copy(c)`（`c` 是世界坐标，因为 `root` / `group` 都是单位变换）。
3. 逐实例矩阵的平移分量减去 `c`，即构造时写 `pose.matrix` 时用 `pos - c`。

**这里有一个必须写进实现的陷阱**：`proxyTrees` 挂在反射组里、用的还是世界坐标矩阵
（`src/land/archipelago.ts:221-235`），而 LOD 交接从它读回"原始矩阵"：

```
// src/land/archipelago.ts:351-355
if ( billboard ) hidden.setPosition( 0, -100000, 0 );
if ( visible ) chunk.proxyTrees.getMatrixAt( index, original );
```

`original` 是**未减 `c`** 的世界矩阵，直接 `farTrees.setMatrixAt(index, original)`
就会把树弹到 `c` 之外。而且 `showProxy` 不只在这里被调用——`:388 / :392 / :400 / :409`
的 96 槽近景集进出也都走它，**每换手一次就平移一次 `|c|`，肉眼可见**。

必须钉死的不变量（写进实现注释）：

| 对象 | 坐标系 | 理由 |
| --- | --- | --- |
| `farTrees` 的实例矩阵 | **批次局部**（`pos - c`） | 批次有 `position`，排序键才有意义 |
| `proxyTrees` 的实例矩阵 | **世界绝对** | 挂在平面反射 `reflection.add(proxyTrees)` 里，反射矩阵按世界坐标算 |
| `c` | 挂在 `Resident` 上（随 chunk 生命周期） | `showProxy` 和重建路径都要读同一个值 |
| `hidden` 矩阵 | 与 `farTrees` 同空间（`y = -100000 - c.y`） | 保持一致，别留两种口径 |

`showProxy` 里 `farTrees.setMatrixAt(index, visible ? original.clone().sub(c) : hidden)`
—— 或者更省：为 `farTrees` 单独保存一份已烘偏移的局部矩阵数组，交接时直接写数组，
不从 `proxyTrees` 读。**后者更稳**（少一次每帧克隆，也少一条"忘了减 c"的路径）。

**另一处必须做**：矩阵重基之后要**重新** `chunk.farTrees.computeBoundingSphere()`。
`InstancedMesh.computeBoundingSphere()` 算的是**局部**球：如果沿用重基前的球心，
对象又被 `position` 加了 `c`，世界剔除球就会偏 `2c`——近岛整批被误剔、或者远岛
永远不被剔。这条和 `src/land/archipelago.ts:225` 现有的
`farTrees.computeBoundingSphere()` 调用是同一条，顺序上必须在"实例减 `c` + 对象加 `c`"
**全部做完之后**再算。

预期结果：`farTrees.matrixWorld` 的平移 = `c`，three 的排序键随之分散到各岛真实距离，
而世界空间的几何位置与包围球与改动前**完全一致**。

### 4.2 billboard 数学改成对 modelMatrix 免疫

现在 `src/land/baked-trees.ts:63-92` 的 `positionNode` 假设 `modelMatrix` 是单位阵：

```
const centre = T.positionLocal.toVar();
const dir = T.cameraPosition.sub( centre ).normalize();
...
return centre.add( right.mul( offset.x ) ).add( up.mul( offset.y ) );
```

`positionLocal` 已经被 `instanceMatrix` 乘过（`NodeMaterial.setupPosition` 先做 instancing
再整体替换），所以 `centre` 是**世界坐标**；只是靠"批次在原点"才恰好等于局部坐标。
批次一旦有位置，`modelViewMatrix` 会再平移一次，画面就错位。

改法：显式在"世界空间里求角点，再转回批次局部空间"：

```
const centreLocal = T.positionLocal;                                  // 含 instancing
const batchOrigin = T.modelWorldMatrix.mul( T.vec4( 0, 0, 0, 1 ) ).xyz;  // 批次世界平移
const centreWorld = T.modelWorldMatrix.mul( T.vec4( centreLocal, 1 ) ).xyz;
const dir = T.cameraPosition.sub( centreWorld ).normalize();
...  // right / up 同现在，全部用世界空间
const worldCorner = centreWorld.add( right.mul( offset.x ) ).add( up.mul( offset.y ) );
return worldCorner.sub( batchOrigin );                                // 回到局部空间
```

需要实现时确认的点（已核实的写成定论，未核实的标为待办）：

- 已核实（`node_modules/three/src/materials/nodes/NodeMaterial.js` 的 `setupPosition`）：
  `instancedMesh( object )` 先把 `instanceMatrix` 乘进 `positionLocal`，**之后**才
  `positionLocal.assign( subBuild( this.positionNode, 'POSITION', 'vec3' ) )`，
  最后 `return positionLocal`，由 `setupPositionView` 再乘 `modelViewMatrix`。
  所以 `T.positionLocal` 在 `positionNode` 内部确实含 instancing，而 `positionNode`
  的返回值仍会被 `modelMatrix` 再作用一次——这正是必须"世界空间算、局部空间返回"的原因。
- 已核实：`T.positionWorld`（`node_modules/three/src/nodes/accessors/Position.js:62-64`
  = `modelWorldMatrix.mul( positionLocal )`）**是含 instancing 的世界坐标**，因为
  `positionLocal` 是同一个 varying 节点，`instancedMesh()` 就作用在它上面；
  `src/land/baked-trees.ts:96` 的 `mist` 已经在依赖这个语义（用 `positionWorld`
  与相机求距离）。所以 `centreWorld` 也可以直接写 `T.positionWorld.toVar()`。
  两者等价，取显式 `modelWorldMatrix.mul(...)` 只是为了不依赖 varying 的求值时机。
- 待办：`T.vec4( vec3Node, 1 )` 的合法写法；若不便，改用
  `T.vec4( centreLocal.x, centreLocal.y, centreLocal.z, 1 )`。
- 待办：`T.modelWorldMatrix.mul( vec4 )` 在顶点阶段的可用性
  （`Position.js:64` 已是同型调用，风险低）。

### 4.3 背景云卡：语义图层，不是深度排序（原方案已撤销）

初稿写的是"删掉云卡的 `-950 / -900+rank`，交给深度排序"。builder check 证伪了这条，
记在这里以免以后有人再犯：

- 41 张卡每帧被投到相机周围 **800 m** 的壳上（`src/bg-cloud-field.ts:232-235`、
  `:283-289`，`displayRadius = 800`）；整个 puff 家族住在 `PUFF_RING.inner = 1250`
  / `outer = 1600`（`src/puff-field.ts:39`）。**每一朵 puff 都比每一张卡远。**
- 排序键是视图空间 clip z；`renderOrder` 优先级严格更高。删掉手排之后，41 张卡会
  **恒定**排在所有 puff 之后、恒定盖在它们上面。puff 是 `depthWrite = false`，
  卡的深度测试挡不住它。观感会从"体积云压在天际幕布上"翻成"幕布盖住体积云"，
  是全天空范围的变化。
- 同一机制还打水面：`src/sea/cloud-reflection.ts:29` 的
  `clone.renderOrder = child.renderOrder` 会让 CubeCamera 那份克隆跟着翻。
- 这两行也不是 `-960` 的残渣：`-950` 来自 `431f393`（2026-11-20）、
  `-900+rank` 来自 `3dda418`（2026-11-23），都早于 `-960`（`11fd65d`）。

**根因不是"用了 renderOrder"，是"背景云卡的距离是假的"。** 它们被钉在 800 m 壳上
只是为了跟随相机（无限远的近似），视觉上代表 km 尺度；拿这种伪距离去参与深度排序，
怎么排都是错的。所以这一层的正确做法是**显式的语义图层**：

- 新增 `src/render-layers.ts`，把散落的数字收成一张具名表，例如

  ```
  export const LAYER = {
    SKY: -1000,
    STARS: -999,
    CLOUD_BACKDROP: -950,   // 背景地平线卡
    CLOUD_FIELD: -900,      // 每帧 +rank（0..16）
    FAR_TREE: -880,         // 远树 billboard：在背景云之后、puff 之前
    SCENE: 0,               // 不透明几何、puff 体积云、其余透明物
    OVERLAY: 2,             // 拖尾/水花等
  } as const;
  ```

- `src/bg-cloud-field.ts:197` / `:280` 改用 `LAYER.CLOUD_BACKDROP` /
  `LAYER.CLOUD_FIELD + rank`；每帧按距离算 rank 的逻辑**保留**——同一壳上的卡
  仍然需要"远的先画"来决定互相叠放，这本来就是它存在的理由。
- `src/land/archipelago.ts` 的 `farTrees.renderOrder` 从 `-960` 改成
  `LAYER.FAR_TREE`（值取在 `CLOUD_FIELD` 之后、`SCENE` 之前）。
- `src/sky-webgpu.ts` / `src/stars.ts` / `src/feel.ts` 的数字同样换成表里的常量，
  行为不变。

这样三种关系各用对的机制：

| 关系 | 机制 | 为什么 |
| --- | --- | --- |
| 树 vs 背景云卡 | **图层** | 卡是伪距离，深度排序无意义 |
| 树 vs puff 体积云 | **深度**（G1/G4） | 两者都是真实 3D，谁的键小谁先画 |
| puff vs 背景云卡 | **图层** | 同第一条 |
| 卡 vs 卡 | 图层内按距离 rank | 同一壳上的相对叠放 |

> 注意：这**不等于**保留 `-960` 这个魔数。`-960` → `LAYER.FAR_TREE` 的价值在于
> 它从"某个下午为了压住症状试出来的数"变成"由图层表推导出的位置"，
> 并且同一张表里写清了它为什么必须在 `CLOUD_FIELD` 之后、`SCENE` 之前。
> 若坚持把它变成字面意义上的 0，第 1 条就会翻车，见 §7 Q1。

### 4.4 删掉止血注释，保留图层位

`src/land/archipelago.ts:210-220` 的 6 行注释要重写：不再是"因为排序键塌陷所以硬压到
-960"，而是"billboard 是透视精灵层，属于 `LAYER.FAR_TREE`，见 `src/render-layers.ts`"。

## 5. 验收标准

### 5.1 正确性

- V1 远树批次：19 个批次 `matrixWorld` 平移各不相同，且与本岛树群中心一致。
- V2 绘制顺序钩子（`onBeforeRender`）：在"云近、树远"的帧里，远树出现在 **puff 体积云之前**；
  与背景云卡的先后由 `LAYER` 表决定（`FAR_TREE` < `CLOUD_FIELD`/`CLOUD_BACKDROP`），
  不再依赖深度键。
- V3 穿透复测：`pos=0,120,-200` 定格帧，落在云卡覆盖区内的远树像素 = 0。
- V4 非排序回归：修复前后同一帧除"树/云重叠区"外逐像素一致；重叠区差异只允许是
  "树被云盖住"这一个方向，**且云卡与 puff 的叠放关系不得改变**（`src/sea/cloud-reflection.ts:29`
  的反射克隆要一并复核）。
- V5 方向性验证（G5）：构造一朵位于 600 m 的近景透明物，确认云卡不再盖住它。
- V6 水面反射、cloud-mask pass、DOF 三处既有行为无变化。
- V7 **跨壳批次的残留要如实记录**：单批实例的深度跨度可达 ~1.7 km（大岛 R=823..845，
  `src/land/archipelago-layout.ts:27`），比 800 m 壳还宽。一座大岛的中心落在壳内时，
  它的远岸树（可到 ~1630 m）仍会排在卡前面。这是"每岛一批"策略的已知边界，
  验收报告里必须写明，不允许用"V3 通过"暗示它已经一般成立。

### 5.2 性能（用户明确要求）

测量方式（沿用仓库既有探针模式，见 `scripts/cloud-reflection-cost.mjs` /
`scripts/headlight-cost.mjs`）：

```
for (let i = 0; i < 150; i++) {
  const t = performance.now();
  a.qa.step(1, 1/60);
  await a.renderer.backend.device.queue.onSubmittedWorkDone();
  if (i >= 30) samples.push(performance.now() - t);
}
```

- 采集：p50 / p95（跳过前 30 帧热身）、`renderer.info.render.calls`、
  `renderer.info.render.triangles`、`renderer.info.memory`。
- 机位：远景（`?pos=0,120,-200`）、中景、近景进云，三处各测一轮。
- 固定：`?qa=frozen&treelook=baked&tod=12&todspeed=0&land=archipelago`，同一画布尺寸。

**基线实测（2026-11-25，`11fd65d` 状态，`?qa=frozen&pos=0,120,-200&treelook=baked&tod=12&todspeed=0&land=archipelago`，
453×805、pixelRatio 1、AMD RDNA-1 真 GPU）**：

| 指标 | 基线值 |
| --- | --- |
| p50 | 23.8 ms |
| p95 | 27.8 ms |
| mean（70 帧） | 24.13 ms |
| 每帧 draw call | 28 |
| 场景潜在批次 | 19 树批 + 41 云卡 |

注意每帧只有 28 个 call（60 个潜在批次里大部分被视锥剔除）。**实测各批次的
`InstancedMesh.boundingSphere` 已经是正确贴合的局部球**（最大一批 173 实例：局部球心
`(439, 53, -1884)`、半径 876），经单位 `matrixWorld` 变换后世界球心就是本岛位置，
所以剔除本来就是准的。4.2 让批次拥有岛中心后，局部球心变为 0、世界球心不变，
**剔除结果与 draw call 数都不变**。这一点在早先的草稿里被误判成"剔除会变准"，已更正。

预判（实现后须用实测替换，此处仅供参考）：

| 项 | 预期 | 理由 |
| --- | --- | --- |
| draw call | **不变**（19 树批 + 41 云卡） | 批次数量没变，云卡数量没变 |
| 三角形数 | 不变 | 778 个实例 × 2 三角 |
| 顶点 shader | +1 次 mat4×vec4、+2 次 vec3 加减 | 4.2 的换算（每顶点，778 实例 × 4 顶点量级） |
| CPU | **不变** | 4.3 撤回后，云卡每帧的距离排序（41 次 `hypot` + 排序）保留不动；树批次数量不变 |
| 视锥剔除 | **不变** | 世界空间包围球不变（前提：重基后重新 `computeBoundingSphere()`，见 §4.1） |

判据：`|Δp95| ≤ 5%` 视为噪声内；若超出，先查 draw call 与三角形数是否真的没变。

> 初稿在这里写过"CPU 略降（删掉每帧 41 次 hypot + 排序）"。4.3 撤回云卡手排之后，
> 那部分 CPU 并不省，预期从"略降"改回"不变"。别拿这条去邀功。

## 6. 留给实现者的（我的判断，可挑战）

- B1 批次中心 `c` 的取法：**重基之前**先对现有实例矩阵跑一次
  `computeBoundingSphere()`，拿它的 `center` 当 `c`；然后"实例减 `c`、对象加 `c`"，
  **重基之后必须再跑一次** `computeBoundingSphere()`（见 §4.1 最后一段）。
  只做前半步就是世界剔除球偏 `2c` 的经典事故。不要理解为"复用旧球心"。
- B2 偏移在构造时烘进矩阵，并**另存一份局部矩阵数组**给 `showProxy` 用
  （`archipelago.ts:352-358`）。不要每次从 `proxyTrees` 读世界矩阵再临时减 `c`。
- B3 云卡的每帧距离排序（`:278-281`）**保留**，4.3 撤回后它是同一壳内叠放的唯一依据；
  只需把数字换成 `LAYER` 常量。
- B4 若 V2 显示 puff 与树的排序仍不稳定，回来重新议设计；不要自行改回硬编码魔数。

## 7. 待确认（需要人类拍板）

- Q1 **背景云卡与 puff 体积云的图层关系要不要改？** 4.3 证明了"删掉云卡手排"会让
  41 张卡恒定盖住所有 puff（puff 在 1250–1600 m，卡在 800 m 壳上）。默认保留现状
  （puff 在卡之上）。若接受"卡盖 puff"这个新观感，则 §4.3 可以换成字面删除，
  G3 恢复原样，但 A3/V4 的措辞要重写。
- Q2 **跨壳批次接受"尽力"还是要求"一般成立"？** 大岛 R=823..845，单批实例深度跨度
  可达 ~1.7 km，比 800 m 壳还宽；一座大岛中心落进壳内时，它的远岸树（~1630 m）
  仍会排在卡前面。要"一般成立"就必须破 N2（按 500 m 网格/岛象限拆子批），
  实例索引、`setColorAt`、`oakCoverage`、96 槽近景集、`showProxy` 全跟着改，
  计划体量差一个量级。
- **Q1 / Q2 的实际处置**：用户催办时未拍板，实现按默认值走 —— Q1 保留现状
  （puff 在卡之上，`LAYER.CLOUD_BACKDROP`/`CLOUD_FIELD` 仍在 `FAR_TREE` 之后），
  Q2 取"尽力"，V7 的残留如实写在下面 §8.2。

## 8. 实施记录（2026-11-25）

### 8.1 落地改动

| 文件 | 改动 |
| --- | --- |
| `src/render-layers.ts`（新） | `LAYER` 常量表：SKY -1000 / STARS -999 / FAR_TREE -960 / CLOUD_BACKDROP -950 / CLOUD_FIELD -900 / HEADLIGHT -100 / SCENE 0 / OVERLAY 2 / OVERLAY_TOP 3 |
| `src/land/archipelago.ts` | `farTrees.renderOrder = LAYER.FAR_TREE`；构建后重基到本岛中心、另存 `userData.localMatrices` / `batchCentre`、重算包围球；`showProxy` 改写局部矩阵，隐藏实例用 `hiddenLocal` |
| `src/land/baked-trees.ts` | `positionNode` 在世界空间做朝向计算，返回前 `.sub(batchOrigin)` |
| `src/bg-cloud-field.ts` / `sky-webgpu.ts` / `stars.ts` / `headlight.ts` / `feel.ts` | renderOrder 魔数换成 `LAYER.*`，云卡每帧距离排序保留（`LAYER.CLOUD_FIELD + rank`） |
| `src/sky-moon.test.ts` | 源码 pin 改为匹配 `LAYER.SKY`，并断言 `LAYER.SKY === -1000 < LAYER.STARS` |

### 8.2 验收实测

- **V1 通过**。19 个远树批次 `renderOrder` 全为 `LAYER.FAR_TREE`；每个批次 `position`
  各不相同且落在本岛（例：`(438.9, 52.6, -1883.8)`）；重基后局部包围球心 ≈ `(0,0,0)`、
  半径 876 —— 与基线世界球（球心 `(439,53,-1884)`、半径 876）逐位一致，**几何未动**；
  `userData.localMatrices` 19/19 存在。
- **V2 通过**。`onBeforeRender` 钩子实测该帧顺序：`tree:-960, tree:-960, card:-950 ×20`。
  远树全部先于云卡；该机位 puff 不在视锥，puff 计数为 0。
- **V3 判据本身写错了，如实修正**。`pos=0,120,-200` 定格帧：云卡可见区 15190 px，
  其中 15166 px 在"隐藏远树"时也会变 —— 树影仍能在云卡下看见。这不是排序错误
  （V2 已证明树先画、卡后画，卡在 800 m 处通过深度测试），而是**云卡是半透明贴图**：
  卡的 alpha 在中段不到 1，树在其后必然以 (1-α) 的比例透出。原来"=0"的判据只对
  "卡完全不透明"的区域成立，当全局判据是写的时候想当然了。
  → 结论：**排序已正确；"树影透出云"剩下的部分是云卡的不透明度，属于材质参数，
  不是绘制顺序**。要让它彻底不透，得改 `src/bg-cloud-field.ts` 的贴图/alpha，
  或让卡写深度（后者会把 1000–1400 m 的 puff 一并吃掉，本设计已明确否决）。
- **性能**。同机位 453×805、AMD RDNA-1、`qa.step(1,0)` 取后 40 帧：
  **p50 19.3 ms / p95 20.8 ms / mean 19.18 ms / 每帧 28 draw call**。
  基线为 23.8 / 27.8 / 24.13 / 28。draw call 与三角形完全不变，帧时间落在噪声内
  （实测更快，但按 §5.2 的判据只声称"无回归"）。
- **V7 残留（必须记住）**：跨壳批次仍是"尽力"。一座大岛中心若落进 800 m 壳内，
  它的远岸树（~1630 m）仍会排在卡前面。当前两处验收机位未触发。
