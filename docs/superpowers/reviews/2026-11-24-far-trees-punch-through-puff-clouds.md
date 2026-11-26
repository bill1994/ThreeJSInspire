# 远景树 "穿透" puff 云 —— 根因报告（2026-11-24）

## 结论

远景树**不是** billboard 深度算错。billboard 的深度几何是正确的（`positionNode` 全量重建位置，
`T.positionLocal` 已含 instanceMatrix）。真正的病是两件事叠在一起：

1. **puff 云（volume 挡）完全退出深度系统**：`depthTest = false`、`depthWrite = false`，
   它只用 `viewportDepthTexture` 在"自己绘制的那一刻"采样场景深度来自裁剪
   （`src/puff-volume.ts:126-128`、`src/puff-volume.ts:100`）。
2. **远树整批的透明排序键退化成世界原点**：每岛一个 `InstancedMesh`
   （`src/land/archipelago.ts:210`），`matrixWorld` 在 `(0,0,0)`，19 个批次
   `setFromMatrixPosition` 取到同一个向量，排序键必然完全相同。**修复前这些批次的
   `renderOrder` 也都是 0**，与 puff 相同，于是队列只能去比那个退化的 z：
   `reversePainterSortStable` 按 z 降序 → **云先画、树整批最后画**。

> 这个前提很重要：`renderOrder` 相同才会去比距离。修复后树被放进 `LAYER.FAR_TREE`
> （`-960`）、体积云仍在 `SCENE`（`0`），两者 `renderOrder` 不同，**距离根本不参与比较**，
> 树恒定先画。重基的收益只作用于"19 个树批次彼此之间"，不是"树 vs 云"。

于是：云画的时候深度里还没有树 → 裁剪看不到树 → 云照常铺满；随后树（`depthTest = true`
但云没留深度）无条件覆盖云的像素 → 树从云里透出来。

一句话：**谁先画谁赢，而真实帧里永远是云先、树后。**

## 适用前提（2026-11-26 补充）

这条 bug 只存在于 **`?treelook=baked` 且未加 `?treelod=hard`** 的组合里：

- `src/main.ts:237-238` 只在 `treelook=baked|coastal` 时才走这套路径，且
  `src/land/archipelago.ts:61` 的 `oaks = treeLook === 'baked' ? ... : null` 把
  `coastal` 排除在外——`billboard` 为 `null` 时远树用的是 `distant`
  （`MeshLambertNodeMaterial`，不透明）。
- `src/land/archipelago.ts:75` 的 `fade = !!oaks && fadeLod`，而
  `src/land/baked-trees.ts:62` 的 `transparent: fade`：`?treelod=hard` 会让 billboard
  材质变回不透明。

也就是说，默认 `original` 外观、`coastal` 外观、以及 `?treelod=hard` 下，远树都在
**不透明队列**里先于所有透明物绘制并写深度，云还没画，不存在被打穿的问题。
本次修复只影响 `treelook=baked` 的 fade 路径。

## 实测数据（同一机位、同一帧、只改一处）

机位：`?pos=0,120,-200` → 相机 `(0, 127, -170)`、fov 61.64、aspect 0.563、far 2000。
把一朵真实 puff（`puff-field` 第 12 个子级，blobSize 半宽 85 / 半高 72 / 半深 47）放在
相机前方 670 m、对准远景岛的树线（树线实测 1104–1950 m）。

测量区：canvas 坐标 `x 190…370, y 240…390`（180×150，覆盖云体与树线）。

| 状态 | 区内"树绿"像素 | 说明 |
| --- | --- | --- |
| 现状（云 `depthWrite/depthTest=false`，树后画） | **2591** | 病态 |
| 只改：树先画（`renderOrder = -1`，云不动） | **2176** | 云正确盖住树 |
| 只改：云 `depthWrite = depthTest = true`（顺序不动） | **2169** | 深度测试正确拒绝树 |

- 穿透量 = `2591 − 2176 = 415` 个"树绿"像素；把两个状态的像素逐点比对，**1544 px 不同**。
- 两个独立修法收敛到同一数值区间（2169 / 2176 ± 7），互为交叉验证。
- 重复测量稳定：`2176 → 2591 → 2176 → 2591`。

## 证据链

**1. 绘制顺序（`onBeforeRender` 埋点实测）**

```
PUFF0 PUFF1 TREE0 TREE1 TREE2 TREE4
```

**2. 排序键（投影矩阵实算）**

> **更正（2026-11-26）**：这里早先记录的 `-831.6` 与 `+3208 … +6368` 无法复现。
> 按本报告自己写的相机 `(0, 127, -170)` 复算，世界原点落在相机**后方** 170 m，
> 视空间 `z_view = +170`、`w = -170`，于是
> `z_clip = -1.00005 × 170 − 0.2 ≈ -170.2`；puff 在 1300 m 处约 `+1300`。
> 下面保留"键相同"的结论，因为它由 `matrixWorld` 全在原点直接推出，不依赖具体数值；
> 但具体数字以复算为准。

| 对象 | `matrixWorld` 位置 | 透明排序键 clipZ |
| --- | --- | --- |
| 远树批次 ×19 | `(0,0,0)` | `-170.2`（19 个完全相同） |
| puff 云簇 | 各自真实位置 | `≈ +1300`（随距离不同） |

`src/renderers/common/RenderList.js:45` 的 `reversePainterSortStable` 先比 `groupOrder`、
再比 `renderOrder`、最后才按 z **降序**。修复前所有透明物 `renderOrder` 都是 0，
所以确实走到第三级；修复后树的 `-960` 与云的 `0` 不同，比较在第二级就结束了。

**3. 材质实测**

- 远树 billboard（19 批 / 778 实例）：`transparent=true, depthWrite=true, depthTest=true,
  side=FrontSide, alphaTest=0, renderOrder=0`。
- puff 云（出厂默认）：`MeshBasicNodeMaterial, transparent=true, depthWrite=false,
  depthTest=false, side=BackSide`。

**4. 出厂跑的就是 volume 云（不是 legacy）**

`src/qa.ts:20-27` 的 `visualQuery()` 给缺省参数补默认值 `pufflook: 'volume'`，
`src/main.ts:270` 读入、`src/main.ts:293` 传给 `parsePuffLook`。所以**不带 `?pufflook=` 打开游戏
= volume 云**；只有显式 `?pufflook=legacy` 才是 `depthWrite=true + depthTest=true` 的那条路。

**5. 为什么 legacy 挡下没有这个问题**

legacy 云 `depthWrite=true + depthTest=true`：云先画就写深度，树后画被深度测试直接拒绝
（上表第三行实测等价：2169）。也就是说这个 bug 是 **volume 挡专属**。

## 为什么"只有树"刺眼

远树 billboard 材质是 `fog: false`（`src/land/baked-trees.ts:62`），空气透视只靠
`mist = smoothstep(100,1600,dist) * 0.32`（`src/land/baked-trees.ts:96`）——上限只有 **0.32**。
所以 1500 m 外的树线仍是高对比的深色硬边，而同一距离的山体早被雾抹平了。
云上出现的是"清晰的深绿树冠"，一眼就能看见。

## 为什么这在实际游玩中频繁发生

- puff 云环 `PUFF_RING = { inner: 1250, outer: 1600 }`（`src/puff-field.ts:39`），
  实测相机距云 1260–1360 m。
- 远树 billboard 在 1440 m 开始显现、1950 m 满强度。
- 两条距离带天然重叠：**云几乎总是比远树近**，只要视线穿过一朵云，就能看到树线。

## 复现步骤

```
npx vite --port 5173 --strictPort
# 必须用 http://localhost:5173/（vite 只监听 ::1）
http://localhost:5173/?qa=frozen&land=archipelago&treelook=baked&todspeed=0&tod=12&pos=0,120,-200
```

`?qa=frozen` 会关掉动画循环（`src/main.ts:905`），必须手动推帧：

```js
const p = window.__porco;
p.qa.step(1, 0);
await p.renderer.backend.device.queue.onSubmittedWorkDone();
```

把 `puff-field` 的某个子级挪到相机前方对准树线，然后对比
`farTrees.renderOrder = -1` 与 `0` 两帧（相机在 `qa.step(1,0)` 下不漂移，两帧可逐像素比较）。

> 说明：**取证时唯一的人工干预是把一朵云挪进视线**（远景默认没有正好穿过树线的云）。
> 云与树的**深度关系**本身是真实的：云 670 m < 树 1104–1950 m，与游玩时的 1300 m < 1500 m 同序。

## 修法

### A. 让远树先画（推荐，一行）——**已升级为显式图层（2026-11-25）**

原始止血改动是在 `src/land/archipelago.ts:210` 创建 `farTrees` 之后加：

```ts
farTrees.renderOrder = -960;
```

实测 2591 → 2176（穿透消失）。等价做法：给 `puff-field` 的每个子级设 `renderOrder = 1`。

> **2026-11-25 更新 + 2026-11-26 更正**：这一行没有被拆掉，它被重命名并写进了契约。
> 远树批次重基到本岛树群中心，`showProxy` 同步改写局部矩阵，数值变成
> `LAYER.FAR_TREE`（`src/render-layers.ts`）。
>
> **更正**：早先我把它说成"重基之后树与云的先后交给 three 的深度排序"，**这是错的**。
> `renderOrder` 先于距离比较，树的 `-960` 与体积云的 `0` 不同，两者距离永远不会被比较。
> 重基的实际收益只有一个：19 个**同一图层**的树批次之间恢复由远到近的顺序。
> 树先于云，靠的仍然是这个图层值——它是必要条件，不是补丁。
>
> 下面对 `-960` 取值的论证仍然成立；只是它现在是图层契约的一部分。

> **终值为什么是 `-960` 而不是 `-1`**：`-1` 只解决"树 vs puff 体积云"（puff 在 0）。
> 背景云卡在 `-950 / -900+rank`（`src/bg-cloud-field.ts:197` / `:280`），`-1` 仍然排在它们
> **之后**，所以"树压在背景云卡上"这一半根本没被覆盖。取 `-960` 落在星空 `-999`
> 与背景云卡 `-950` 之间：两族云都排在树之后，树写的深度又仍能被体积云的自裁剪读到。
> 代价见下节"顺序法的固有代价"。

- 优点：不动深度语义；树的 `depthWrite=true` 反过来还会让云的自裁剪看见树，
  树在云前时云被正确裁断。
- 反射风险已复核为 **0**：`waterReflectables()` 会跳过 `userData.separateLandReflection`
  的整棵子树，而 `archipelago` 组正是这样标的（`src/land/archipelago.ts:82`），
  所以远树批次根本不进主反射 pass。实测同一帧 fixed / buggy 两态的水面带
  差异 **0 像素**（云带 1519 像素），水面反射不受影响。

### B. 给云加深度（实测有效，但语义上更危险）

`src/puff-volume.ts:126-128` 改成 `depthWrite = true; depthTest = true;`。实测 2591 → 2169。

- 同一个 pass 里既把 `viewportDepthTexture` 当采样源、又往深度附件里写，属于
  WebGPU 的 feedback 组合；本次测试没炸，但不建议长期这么放。

### C. 恢复有意义的排序键（治本但重）

远树按岛 / 按 500 m 网格拆成更多批次，或每帧把批次的 `position` 挪到包围球中心
（需要把偏移烘进实例矩阵）。排序对了，A、B 都不必做。

### D. 治标：让远树别那么刺眼

`src/land/baked-trees.ts:96` 的 `mist` 上限从 `0.32` 提到接近 1，或打开 `fog`。
树和山体一起被雾吃掉后，穿透就只剩"雾里的一团深色"，不再抢眼。

## 第二层：背景云卡——修复前挡不住树，修复后反而恒定压住树

前面只讲了 puff 体积云。复核用户反馈"修完还是透"时，把两族云分别隐藏测了一遍
（`?qa=frozen&pos=0,120,-200&treelook=baked&tod=12&todspeed=0&land=archipelago`，画布 532×945）：

| 操作 | 变化像素 |
| --- | --- |
| 隐藏 `puff-field` 全部 25 个子级 | **0** |
| 隐藏 `bg_cloud_field` + `bg_cloud_backdrop`（41 张卡） | **360975**（全画幅 502740） |

即：**该机位画面上所有云都是背景云卡，不是 puff 体积云**。它们由同一套 puff 形状烘焙而来，
喊它"puff 云"不算错，但病根在另一套对象上：

- `src/bg-cloud-field.ts:20` `displayRadius: 800`：卡全部钉在距相机 800 m 的壳上；
- `:147` `material.depthWrite = false`：永不写深度；
- `:197` / `:280` `renderOrder = -950 / -900+rank`：排在所有常规几何之前。

**修复前**（树 `renderOrder = 0`，后画）：1104–1950 m 的远树 billboard
（`transparent=true` 但 `depthWrite=true`）后画时，800 m 处没有任何深度可以拦它，
**直接压在云卡上**。实测该帧远树像素 3063，全部落在云卡覆盖区内；
把远树 `renderOrder` 改到 `-960` 后降为 **0**。

**修复后**方向翻转：树先画并写下 1104–1950 m 的深度，云卡在 800 m 后画，通过深度测试
→ **卡恒定叠在远树上面**，与真实深度无关。于是远树的轮廓以 (1−α) 从卡里透出来。
这不是 alpha 参数没调好，而是 800 m 假距离壳的结构性后果：**任何比 800 m 远的物体
都会被它"更近"地压住**，包括本该在它前面的远树。要根治只能让卡的距离变真（拆壳）
或让卡参与深度（修法 B），两者都有代价。

同时排除了"puff 云太透"这个猜想：把相机放到离云 560 m、树线正好在云后，
云可见 / 云隐藏两帧取 18117 个云体像素做高通残差相关 —— **相关系数 0.00**，
残差 std 4.6（云）/ 4.2（背景）。云体是不透明的，透出来的不是云。

### 图层法的固有限制

`-960` 表达的是**图层**，不是深度。代价是：**任何排在 `LAYER.SCENE`(0) 的透明物都盖在云上面，
而云无法拒绝它**——体积云 `depthTest=false` + `depthWrite=false`，既不写深度也不做深度测试，
它只在自己绘制的那一刻采样一次已写好的场景深度来自裁剪，所以"比它晚画"的东西它一律看不见。

因此"树先于云"这件事必须写在 `src/render-layers.ts` 里，不能由几何距离保证。
要让几何自己保证，只有修法 B（让云参与深度），代价见上。

反方向是安全的：比云更近、且 `depthWrite=true` 的透明物（例如近岛树卡）先画并写下深度，
云卡后画时会被深度测试正确拒绝。实测两处机位无回归
（`treePx 14500 → 14500`、`8231 → 8231`，`pxChanged = 0`）。

## 截图（`artifacts/`）

| 文件 | 内容 |
| --- | --- |
| `puff-c-asis-zoom4x.png` | 现状（病态）：树冠清晰地印在云体上 |
| `puff-d-trees-first-zoom4x.png` | 同一帧，只把远树 `renderOrder` 改成 `-1`：云把树吃掉了 |
| `puff-b-asis.png` / `puff-e-trees-first.png` | 未放大的同机位对照 |
| `puff-m-cloud-over-trees.png` / `puff-o-cloud-island-zoom4x.png` | 离云 560 m 的取证帧：云体不透明，岛在其右侧边缘而非"透过来" |
| `puff-n-after-960.png` | `-960` 生效后的定格帧 |

## 代码状态

**已于 2026-11-26 11:40 提交并推送：`d0eb2df`**
（`refactor(land): sort far-tree batches by real distance instead of renderOrder`，
11 files changed / 498 insertions / 33 deletions），分支 `new-reset` 已与 `origin/new-reset` 同步。

内容：远树批次重基到本岛中心、`showProxy` 改写局部矩阵、billboard 的朝向数学改到世界空间、
`renderOrder` 数值收成 `LAYER.*`（新文件 `src/render-layers.ts`）。
改动的 `src/` 文件：`land/archipelago.ts`、`land/baked-trees.ts`、`render-layers.ts`（新）、
`bg-cloud-field.ts`、`sky-webgpu.ts`、`stars.ts`、`headlight.ts`、`feel.ts`、`sky-moon.test.ts`。
设计与验收：`docs/superpowers/specs/2026-11-25-far-tree-transparent-sort-contract-design.md` §8。

> **措辞更正**：这次改造不是"拆掉 `-960`、交回深度排序"——`-960` 仍然在，它变成了
> `LAYER.FAR_TREE`。重基让 19 个**同图层**批次之间恢复真实顺序；树与云的先后仍由图层值决定，
> 参见上面「图层法的固有限制」。

**云卡覆盖区的诚实修正**：定格帧里云卡可见 15190 px，其中 15166 px 在隐藏远树时会变化。
排序是对的（钩子证明树先画、卡后画，卡在 800 m 处通过深度测试），透出来的是云卡自身的
半透明 alpha。但要注意：**云卡被钉在 800 m，所以它对任何比 800 m 远的东西都"更近"**，
包括本该在它前面的远树——这是假距离壳的结构性后果，不是调一个材质参数就能了的事。
详见设计文档 §8.2 V3。

> **`d0eb2df` commit message 里有一个数字说反了，在此更正。** 那条消息写的是
> "a puff 667 m in front of the tree line hides 14233 of 14234 covered pixels"，
> 而定向测量（相机离云 560 m、云体覆盖 14234 px、隐藏整片远树）实测只有 **33 px**
> 发生变化（差值 > 40 的仅 14 px）。正确表述是：**14234 个覆盖像素里有 14201 个
> 完全不受远树影响**，云把树遮死了。两个数（14234 / 15190）来自两次不同机位的测量，
> 不应互相换算。

原始止血阶段的验证记录（保留）：

| 项 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npm test` | 89 文件 / 891 测试全部通过 |
| `npm run build` | `✓ built in 6.75s` |
| 运行时批次检查 | 19 个远树批次全部 `renderOrder = -960` |
| 绘制顺序钩子 | 修复后 `Mesh, Mesh, puff-12`（树先、云后）；修复前 `PUFF0 PUFF1 TREE0 …` |
| 同帧穿透复测（532×945，云投影包围盒 237,284,224,184） | 修复 **4430** / 临时改回 0 → **5032** / 再改回 → **4430**（可重复，差 602 px） |
| 云卡覆盖复测（pos=0,120,-200） | 树压在云卡上 3063 px → **-960 后 0 px**（口径为"卡不透明区"，见上面的修正） |
| 回归复测（pos=0,120,-200 与 -800,150,-1200） | 远树像素 14500→14500、8231→8231，`pxChanged = 0` |
| 水面反射复测 | 云带 1519 px 变化，**水面带 0 px** |

