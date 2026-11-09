# 穹顶云（体积云层）设计 — 2026-11-09

**状态：DRAFT，待批准。批准前不写产品代码。**

**一句话：** 在相机上方的空域里放一层真正的 raymarched 体积云——会极慢地翻涌、有厚度、有自阴影和银边——第 1 阶段只做「可信的云本体」，第 2 阶段再做吉卜力式风格化上色。

**分支：** `rebuild/sea-dome-reset`（在它上面新开一条实现分支）

> **修订记录：** 2026-11-09 首版过了一遍独立 builder 审查，修掉 6 处与代码事实冲突的地方（相机远平面、降档判据、涌动量级、接口缺相机/调色、DOF 与深度、烘焙与档位耦合）。修订处标 `[R1]`。

---

## 0. 这份文档解决什么

`rebuild/sea-dome-reset` 上，海已经重建完成（stylized FFT ocean + 近场细八度），**穹顶云自 2026-11-06 的删除型重构（`4c66328`）之后一直是空的**。INDEX 里「活下来的云是唯一的云」指的就是近景 puff。

本文件讨论的是**把那一层加回来**，但**不是恢复旧实现**。旧实现是 `clouds-compute.ts` 的 slab 体积云（`CLOUD_BAND.top = 480`、12 步 ray march、`CLOUD_PALETTE`），已经被否过一次；这次按新目标重做。

---

## 1. 意图与为什么

用户要的东西，原话拆开是三条：

1. **真的体积云**——不是 billboard、不是云卡、不是贴图幕。飞过去要有厚度和视差。
2. **一层层会翻涌**——分层、缓慢地演化，像真的天气。
3. **手机上能跑**——验收机是旗舰。

之所以现在做：海的面已经立住了，画面缺的只剩「上面那块天」。没有它，天际线以上是空的，飞机再真也只是在贴纸上飞。

**形态是自由的**——用户明确说过参考图里的是**已经实现的 puff 云**，不是穹顶云的目标形态，可以自由发挥、往风格化靠。

---

## 2. 目标 / 非目标 / 反目标

### 目标

- 相机上方出现**连续的体积云层**，天际线以上铺满，近处能感到压顶，远处融进地平线霾。
- 云**真的在翻涌**，但**很慢**——用户原话「快了就不像真云了」。
- 云底有明暗分离：背光面脏紫、受光边暖、迎光处有银边。
- 旗舰手机**稳定 30 fps**。
- 与现有 puff 云、天穹、海面**光照方向和色调一致**，不出现「两层云打架」。

### 非目标（明确不做）

- ❌ **不做穿云**。相机永远在云层下方（用户拍板）。
- ❌ **不做云影投到海面/地面**（第二版再说）。
- ❌ **不做天气系统**：无降水、无雷暴、无云量随剧情变化。
- ❌ **不做 WebGL 回退**。项目本身 WebGPU-only（`src/renderer.ts:36-50`）。
- ❌ **不在 P1 做风格化上色**。P1 输出物理可信的连续密度。

### 反目标（做出来就算失败）

- 看起来像**一张贴图 / 一团雾幕**：没有视差、没有内部结构、没有明暗。
- 云**涌动太快**，像快进的延时摄影；或者**慢到像静止**。
- 云的边界露出**盒子的直边**，或 march 出**层状条纹 / 环带**。
- 手机上掉到 30 以下。
- 云的颜色/光向和现有 puff 云**对不上**，一眼两层。
- 云把**天穹的颜色顶掉**。

---

## 3. 约束（代码事实，不是偏好）

| 约束 | 出处 | 影响 |
|---|---|---|
| three **0.186.0** | `package.json` | **核心 `three/tsl` 有** `texture3D` / `interleavedGradientNoise` / `mrt` / `velocity` / `depthPass`。**`traa` 与 `RaymarchingBox` 不在核心导出里**——`traa` 在 `three/addons/tsl/display/TRAANode.js`，`RaymarchingBox` 在 `three/addons/tsl/utils/Raymarching.js`。P1 都不依赖它们；P2 若上 half-res + 时序才需要走 addons 路径 |
| **WebGPU-only** | `src/renderer.ts:36-50` | compute 可用；不用做双后端 |
| 竖屏 **9:16**，fov **60°** | `src/portrait.ts`、`src/main.ts:65` | 采样预算按竖屏算 |
| **相机 far = 2000 m** `[R1]` | `src/main.ts:65` | **云的水平半径不能超过 ~1900 m**，否则被裁 |
| 场景现有尺度 `[R1]` | 天穹壳 R=800（`sky-webgpu.ts:270`）、海最外环 1900（`sea/rings.ts:31`） | 云不能比世界大一个量级，否则和它们脱节 |
| **DPR 上限 1.5** | `src/main.ts:221` | 典型 buffer ≈ 717×1275 ≈ 91 万像素 |
| 飞行高度 **6 / 240** | `src/game.ts:99-100` | 云底必须 > 240 |
| **单一太阳** | `src/palettes.ts` 的 `SUN_DIRECTION`、`src/sun-state.ts` | 云吃同一个 sunDir |
| **调色单源** | `src/palettes.ts` / `src/sky-track.ts` | 色带从现有单源取 |
| 模块挂载契约 | `src/world.ts:145-164` | `init*(scene, renderer, sunDir)` → handles，try/catch，失败只丢自己 |
| **降档判据 `[R1]`** | `src/world.ts:63` `SLOW_FRAME_MS = 24`，连续 `SLOW_FRAME_LIMIT` 帧触发 | 24 ms ≈ 42 fps。**30 fps（33 ms）在 high 档必然被判慢** |
| mobile UA 启动即 low | `src/world.ts:179` | 手机上 governor 已无可降 |
| 后处理链 | `src/post.ts:6` | `pass → bloom → dof → smaa`；**dof 只在桌面 high 开**（`post.ts:76` vs `post.ts:88`） |
| **无 GPU 帧计时基线** | 旧 `clouds-technical-note`（`git show a842657:`）明写 | 性能门要么先造仪器，要么不成立 |

---

## 4. 已经定下的（用户拍板）

1. **形态自由**，不参照现有 puff 的造型，可以往风格化靠。
2. **先做云，再做风格化上色**——分两阶段，P1 不承诺好看。
3. **相机永远在云下方**，不做穿云。
4. **涌动必须很慢**。
5. **验收机是旗舰 Android + Chrome（Android）**。
6. **要真的体积**，不接受 billboard / 云卡。
7. **云带下限 12° 可接受**，但要保留后期调低的余地。

---

## 5. 设计决定（本澄的判断，可以推翻）

### 5.1 云层几何 `[R1 重算]`

- **云底 `H_BASE = 380 m`、云顶 `H_TOP = 1150 m`**，厚度 770 m。
  - 底卡 380：飞行上限 240，留 140 m 余量。
- **水平半宽 `HALF_EXTENT = 1800 m`**（不是原来的 6000）。
  - **原因：`camera.far = 2000`。** 6 km 的盒子会被整块裁掉，一像素都不出。1800 留 200 m 给斜角射线和后续微调。
- **距离淡出：1200 m 开始融进地平线霾，1800 m 前完全消失。** 这样盒子的边永远在「已经完全透明」的地方，看不见直线。
- 云**随相机平移**（保持环面），**不随相机旋转**（否则没有视差）。

**几何检查**（竖屏 fov 60°，画面顶端 = 仰角 30°，巡航 60 m，高差 320 m）：

| 云底水平距离 | 仰角 | 观感 |
|---|---|---|
| 320 m | 45° | 已出画 |
| 554 m | 30° | 压住画面顶边 |
| 1 200 m | 15° | 上半屏天花板（这里开始淡出） |
| 1 500 m | 12° | 接近完全淡出 |
| 1 800 m | 10.1° | 已经透明，看不见边 |

**这个取舍必须记住：** 云带实际占据约 **12°~30°** 的仰角区间，**再往下是天空**，不是云墙压地平线。原因是远平面不允许我们把云推到 3°。如果成片后觉得「云太飘、不压地平线」，唯一的解法是把 `camera.far` 提到 4000+ 并重核海面 depth hook 和 DOF —— **那是另一个决定，P1 不做。**

- **云底不能是平的 380 m 面**：近处抬头会变成一块灰板。`baseShape` + `detail` 必须把云底侵蚀出下垂的瓣，允许局部降到 ~300 m。

### 5.2 密度场：三层

| 层 | 形式 | 分辨率 | 作用 |
|---|---|---|---|
| `weatherMap` | 2D R8 平铺 | 512² | 云块位置、覆盖度、分层 |
| `baseShape` | 3D R8 Perlin-Worley | **128³**（两档共用） | 骨架、大瓣 |
| `detail` | 3D R8 平铺 Worley | 32³ | 侵蚀边缘 |

**涌动量级 `[R1 修正]`**——原来写的「0.008 m/s」是错的，按字面 30 秒只动 0.24 m，在 1 km 外约 0.26 像素，等于静止。

改成**世界空间速度**，按「30 秒能看出来变了」反推：

| 层 | 世界速度 | 换算 UV/s | 30 s 位移 | 1 km 处屏幕位移 |
|---|---|---|---|---|
| `detail` | **0.35 m/s**（贴图 tile 400 m） | 0.000875 | 10.5 m | ≈ 12 px |
| `weatherMap` | **0.40 m/s**（tile 8000 m） | 0.00005 | 12 m | ≈ 13 px |

- 「翻涌」不靠平移，靠 **detail 的侵蚀阈值缓慢呼吸 + 轻微垂直剪切**。平移只负责「飘」。
- 这两个数是**起点**，不是终值。验收由用户肉眼看 30 秒定夺（见门 3）。

### 5.3 March

- 自写 slab 相交，**不用 `RaymarchingBox`**（它假设盒内等步长，对 770 m 厚、1.8 km 远的层太浪费）。
- 步长**按单调递增的权重曲线归一化到实际射程**，**不用「12 m 起、60 m 封顶」这种固定序列**——验算过：28 步里让步长从 12 m 指数涨到 60 m 封顶，总和最多 28×60 = 1680 m，**压不住 1800 m 的射程**，那条原写法是错的。
- 可测契约：**首步 ≤ 20 m · 单调不减 · 总和精确等于射程**。
- 步数：**high 28 / low 16**。
- 早退：`1 - alpha < 0.02` 或 α 饱和。
- 每像素 `interleavedGradientNoise` 起始偏移，打散粗步长的分层。

### 5.4 光照（P1 只做这一套）

相机在云下 → 看到的几乎全是**背光面**，刚好简化：

```
transmittance = exp(-σ · 沿太阳方向 light march 累积)
phase         = HG(g=0.6) + HG(g=-0.3)
powder        = 1 - exp(-2σ)
rgb           = ambient + sunColor · transmittance · phase · powder
```

- `ambient` 取 `sky-track` 的 `cloudHaze` + `cloudBands[4]`（`src/sky-track.ts:58-59`）。
- 银边 = `transmittance` 在薄处自然升高，不另加 emissive。
- light march **high 4 / low 2 步**，只在密度超阈值的片元上做。
- **必须随太阳仰角联动**（`setCloudPalette` 每帧灌，见 §5.7）。否则 `?sun=` / `?sunspin=` 的夜档验收下，云会是一块参考档的紫。

### 5.5 合成

- `BackSide` 盒 mesh，`transparent: true`、`depthWrite: false`、`depthTest: true`。
- 顶点随相机平移（§5.7 拿相机）。
- **DOF 已知问题 `[R1]`**：`depthWrite: false` → 桌面 high 档里云拿到远平面深度 → 被按最大 CoC 整层糊掉。三个选项（写近似深度 / 把云排除出 dof / 接受）P1 都不定，**先按「接受」跑，用 `?post=0` 量门 2/门 4**，糊不糊留到看片再定。

### 5.6 质量档 `[R1 简化]`

**只烘一套 128³**（R8 = 2.1 MB，手机上也不是负担）。两档只差采样成本：

| | high | low |
|---|---|---|
| 步数 | 28 | 16 |
| detail octave | 2 | 1 |
| light march | 4 | 2 |

**不在 `setQuality` 里重烘纹理**——那会把卡顿放在机器已经卡的时刻。

### 5.7 接口 `[R1 补相机/调色]`

```ts
export interface DomeCloudHandles {
  update(t: number, sunDir: THREE.Vector3, view?: WorldView): void;
  setCloudPalette(bands: readonly Vec3[], haze: Vec3): void;
  setQuality(high: boolean): void;
  setVisible(visible: boolean): void;
  readonly ready: boolean;
}

export async function initDomeCloud(
  scene: THREE.Scene,
  renderer: unknown,
  sunDir: THREE.Vector3,
): Promise<DomeCloudHandles>;
```

- `view` 直接复用 `world.ts` 已有的 `WorldView`（海面在用，含 camera 与 radPerPixel）。`world.update` 现在只把它喂给 sea，**这里要加一路给云**。
- `setCloudPalette` 照抄 `main.ts:300` 给 puff 的 `setCloudPalette` 做法，每帧灌。
- **云自己管平移**，不挂 `far-field.ts` 的名字白名单（那里的正则 `^puff-\d+$` 是给 puff 的）。
- 抓帧开关 **`?dome=0`**：照 `src/qa.ts` 的 `parsePuffVisible` 加 `parseDomeVisible`。**验收门 1 靠开/关两帧做差，没有它跑不了。**

---

## 6. 分阶段

### P1 — 云本体（本设计主体）

形态 + 光照 + 涌动三件事成立。颜色有明暗分离就算过，允许丑。

### P2 — 风格化上色（另开一份计划）

- 输出端 posterize 到 4 档（沿用 `puff-cloud.ts` 的 `puffBandIndex` 思路）
- 色带接 `PUFF_BAND_COLORS` 同一单源
- 边缘做颗粒/dither，消掉「体积云太滑」的现代感

---

## 7. 验收门（P1）

| # | 门 | 量法 |
|---|---|---|
| 1 | 天际线以上是连续云层 | `?dome=0` 开关帧做差，`artifacts/cloud-audit/puff-coverage.py` 口径 |
| 2 | 受光/背光有分离 | 云带内 `cloud_tone_span ≥ 0.2`（口径取自 `git show a842657:` 的旧云技术说明） |
| 3 | 涌动「很慢」但**不是静止** | 固定机位 30 s 序列：云带区帧间平均绝对差落在 **2~12 / 255** 区间；单帧跳变 < 1.5 / 255。**阈值首轮待校准**，最终以用户看 30 秒的判定为准 |
| 4 | 无层状条纹 | `row_stripes` 量具（`artifacts/sea-review/measure*.py`）：行均值梯度 > 3 的行不得成片 |
| 5 | 无缝 | 云环面边界、地平线融合处截图目检，不得见直线 |
| 6 | 性能 `[R1 重定义]` | **手机 low 档 ≥ 30 fps**（真机实测，不看 governor，因为它已无档可降）；**桌面 high 档 < 24 ms**（不触发 `SLOW_FRAME_MS`） |

> 门 6 之所以要拆成两个标准：`SLOW_FRAME_MS = 24` 意味着 high 档在 30 fps 必然判慢，而手机上启动即 low、governor 已无可降。**「high 档 30 fps 不降档」在现有代码里是自相矛盾的**，所以按档分别定义。

**量门 2/4 时用 `?post=0` 直出**，避开 DOF 的整层糊（§5.5）。

---

## 8. 留给 builder 的

- 噪声组合与参数（Perlin-Worley 权重、Worley 细胞数）
- 步长增长函数，并验算 28 步能否覆盖 1800 m（§5.3）
- compute 烘焙实现；以及是否改预生成资源
- 边界融化曲线
- 上采样/是否 half-res + `traa`（**先测，不先做**）
- 门 3 阈值的校准
- §5.5 的 DOF 取舍

---

## 9. 已知风险

1. **带宽**：3 层纹理 × 28 步 × 91 万像素，移动端瓶颈是带宽不是算力。
2. **没有帧计时基线**：旧文档明写「本仓库没有任何 GPU 帧计时基线」。门 6 要真跑，计划里得先排一个计时仪器。
3. **云带下限 12°**：受 `camera.far = 2000` 限制，云到不了地平线，只能融进霾。
   **可调范围分两段**（云底距相机高差 320 m，仰角 = atan(320 / 距离)）：
   - **免费段（不动 far）**：淡出终点可在 1700~1900 m 之间调，云带下限在 **9.6°~10.8°** 之间。再往下没有了。
   - **付费段（动 far）**：要压到 **6°** 需要水平距离 ≈ 3050 m → `camera.far ≥ 3100`；压到 **3°** 需要 ≈ 6100 m。动 far 会牵动海面 depth hook（`sea/rings.ts` 最外环 1900）、DOF CoC、以及可能的 z-fighting，**是另一个决定，单独评估**。
4. **DOF 糊云**：桌面 high 档整层按最大 CoC 糊，P1 先接受。
5. **与 puff 云一致性**：一套 mesh 一套体积，边缘处理不同，容易「一眼两层」。
6. **P1 一定丑**：计划内。P1 验收标准里没有「好看」。
