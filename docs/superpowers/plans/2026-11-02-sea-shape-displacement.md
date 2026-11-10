# 海面形状改造方案（2026-11-02）— 水平位移 · Jacobian · 移动端档位

**目标：** 把海面从"纯高度场"升级成"带水平位移的可形变表面"，让浪尖前倾、锐化、能折叠；
同时为移动端定出可跑的档位，不靠降画质糊过去。

**参考实现：** `noniv/web-ocean`（MIT）。它的顶点着色器已经解决了我方 S5 被否决的那个自反馈问题，
本方案沿用其结构，不照搬其规模。

**范围：** 只碰 `src/sea-fft.ts`、`src/sun-road.ts`（常量）、`src/palettes.ts`（如需）、
`artifacts/cloud-audit/recompute_sea_bands.py`。不碰云、天穹、后处理链。

---

## 0. 硬约束

1. **移动端要能跑。** 一切新增开销必须在 `quality === 'low'` 时降到可接受量级。
2. **不回退后处理合约。** `post.ts` 的 bloom 阈值 0.82、K4 算出的余量 0.063 不许被悄悄吃掉。
3. **调色单源 / 双后端 TSL / 单输出所有者** 三条老合约不动。
4. **不许出现采样自反馈。** 位移改变了顶点位置，但任何采样都只能用位移前的坐标。

---

## 1. 先解决自反馈：引入拉格朗日坐标

S5 被否决的原因是：

```
uvShort = worldPos.xz / SEA_FOLLOW_STEP      // worldPos 跟着 positionNode 走
positionNode = vec3(positionLocal.x, h, positionLocal.z)
```

`noniv/web-ocean` 的做法是让**位移和采样都用位移前的坐标**：

```wgsl
var xz = inst.xy + g * spacing;              // 拉格朗日坐标
disp = sample(dispTex, xz * cascInvL[c]);    // 用 xz 采样
world = vec3f(xz.x + disp.x, disp.y, xz.y + disp.z);
o.xz = xz;                                   // 着色继续用 xz
```

**我方可以直接照搬，且不需要额外 attribute。** `src/sea-fft.ts` 的几何是
`PlaneGeometry(...).rotateX(-π/2)` 烘平的、网格只有平移没有旋转缩放，所以
`positionGeometry` 本身就是那个 `xz`：

```ts
const baseLocal = TSL.positionGeometry;                       // 位移前，平面坐标
const baseWorld = TSL.modelWorldMatrix.mul(TSL.vec4(baseLocal, 1)).xyz;  // 世界系拉格朗日坐标
const uvShort = baseWorld.xz.div(SEA_FOLLOW_STEP);
const uvLong  = baseWorld.xz.div(SEA_LONG_PATCH);
```

### 必须一起改的地方（漏一处就回到自反馈）

`worldPos` 目前在着色器里有 6 处消费方，全部要换成 `baseWorld`：

| 用途 | 现状 |
| --- | --- |
| `uvShort` / `uvLong` | `sea-fft.ts:651-652` |
| detail bump 坐标 | `detailPos` |
| sparkle 噪声坐标 | `worldPos.x.mul(1.7)` |
| foam 噪声坐标 | `worldPos.x.mul(0.33)` |
| `dist`（霾 / 细节淡出） | `length(worldPos - cameraPos)` |
| `fragDir`（太阳路方位） | `normalize(worldPos - cameraPos)` |

**Phase 0 就是这条**：只换坐标、不加位移，视觉应完全不变（帧哈希不变）。这一步做完再谈形状。

---

## 2. 通道预算

短域需要 8 个标量，正好两张 RGBA16F：

| 纹理 | R | G | B | A |
| --- | --- | --- | --- | --- |
| 短域 `disp` | `Dx` | `Dz` | `h` | `jxz` |
| 短域 `deriv` | `dh/dx` | `dh/dz` | `jxx` | `jzz` |
| 长域 `long` | `h` | `dh/dx` | `dh/dz` | — |

推导（逐模式，`λ` = choppiness）：

```
Dx  = i·λ·(kx/|k|)·h        Dz  = i·λ·(ky/|k|)·h
jxx = h·(-λ·kx²/|k|)        jzz = h·(-λ·ky²/|k|)        jxz = h·(-λ·kx·ky/|k|)
J   = (1+jxx)(1+jzz) - jxz²
```

**泡沫通道让位。** 现在 `texShort.a` 是静态泡沫 mask。拿到 `J` 之后泡沫应当由折叠驱动
（`noniv/web-ocean` 就是这么做的），静态 mask 可以退休。

### 只给短域加位移

长涌域（37–2048 m）坡度缓、`λ·a` 量级小，Jacobian ≈ 0。位移集中在小尺度陡波上，
所以**长域继续只出高度和坡度，不带位移、不带 Jacobian**。移动端省一半 fetch，物理上也站得住。

纹理内存：2 张 → 3 张 128² RGBA16F，**262 KB → 393 KB**（含 mip ×1.33 → ~524 KB）。可忽略。

---

## 3. 法线：坡度要除以 Jacobian

现在是 `nx = texShort.g + texLong.g` 直接相加。有位移之后必须修正：

```
sl   = vec2(sxTotal, szTotal) / vec2(max(1+jxx, 0.15), max(1+jzz, 0.15))
nrm  = normalize(vec3(-sl.x, 1, -sl.y))
```

没有这一步，浪尖处法线会爆掉——因为顶点被压缩后，单位水平距离上的高度变化变大了。
下限 0.15 是防止完全折叠时除零（参考实现用的是同一个数）。

detail bump 仍然叠在 `sl` 之后、`normalize` 之前。

---

## 4. mip 链 + 方差 LUT（移动端关键）

### 现状是个缺陷

`sea-fft.ts:872,877`：

```
tex.minFilter = THREE.LinearFilter;
tex.generateMipmaps = false;
```

**海面纹理没有任何 mip。** 远处一个像素覆盖几十个 texel 时，采样的是最细那一层的若干点 ——
这是走样，不是细节。

### 但不能只开 mip

对 `(h, sx, sz)` 做 box mip，均值是对的，**方差会丢**。方差丢了 → 远处高光瓣变窄 →
本该"随距离变宽的一片光"变成"一堆硬闪点"。

参考实现为此维护了一张 LEAN 矩纹理（`sx², sz², sx·sz`）。**移动端不抄这张纹理**，改用一个更便宜的办法：

> 谱是平稳的（统计均匀）。所以"被某层 mip 滤掉多少坡度方差"只是**mip 层级的函数**，
> 不是位置的函数 —— 一张 8 个 float 的小表就够了。

CPU 侧在 `buildPhillipsSpectrum` 之后顺带算出每个 mip 层的剩余方差，上传成一个 uniform 数组。
着色器按 `lod` 插值取值，加到粗糙度上再算高光。

比矩纹理省一张 128² RGBA，也比逐像素矩便宜；精度上只丢"逐像素的各向异性"，保留"随距离正确变宽"。

### 移动端收益

`minFilter = LinearMipmapLinearFilter` 之后，远处读低层 mip，**带宽和缓存命中同时变好**。
这一条在低档上不只是画质，是净赚。

---

## 5. 泡沫改由折叠驱动

```
J = (1+jxx)(1+jzz) - jxz·jxz
foam = smoothstep(J_HI, J_LO, J)      // J 越接近 0 越接近折叠
```

阈值按实测的 `J` 分布定，不拍脑袋。时间演化（衰减 / 顺风漂移 / 新鲜度）需要一张 history 纹理，
**本轮不做**，列为后续任务。

---

## 6. 移动端档位

项目已有 `world.quality: 'high' | 'low'` 与各模块的 `setQuality(high)`（`post.ts:278`、
`clouds-compute.ts:591`、`puff-cloud.ts:576`）。海面按同一模式接入。

| 项 | high | low | 理由 |
| --- | --- | --- | --- |
| 网格段数 | **436**（3.67 m，2.00 样本/λ） | **220**（7.27 m） | 低档靠 mip + 法线细节补近场 |
| 位移 + Jacobian | 开 | **开** | 这是本次改造的核心，不能砍 |
| 长域位移 | 无 | 无 | 本来就不带 |
| detail bump（3 次 `mx_noise`） | 开 | **关** | 见下 |
| sparkle 噪声 | 开 | 开 | 便宜且是太阳路的来源 |
| foam 噪声 | 开 | 关 | 改用 `J` 近似 |
| 纹理 mip | 开 | 开 | 低档更需要 |

### 移动端真正的瓶颈不是纹理

当前海面着色器**每像素 5 次 `mx_noise_float`**：`d0`、`dX`、`dZ`（detail bump 三抽头）、
`sparkle`、`foamNoise`。低档关掉 detail bump 少 3 次，正好补贴位移带来的额外 fetch。
**先砍 ALU，再砍分辨率** —— 位移带来的 fetch 是 2 次半精度采样，比 3 次梯度噪声便宜得多。

### 段数不能写死

`SEA_GEOMETRY_SEGMENTS` 目前是模块常量、几何在 `initSeaFft` 里建一次。改造后：
按初始检测到的档位选段数；运行期切档时重建几何（190k → 48k 顶点，重建是毫秒级，只在切档时发生）。

---

## 7. 验收门

| # | 门 | 怎么量 |
| --- | --- | --- |
| G1 | **高度分布偏度** | choppy 波的 `h` 是负偏的（尖峰宽谷）。CPU 复算给偏度，目标从 0 走到 −0.3 ~ −0.8 |
| G2 | **折叠率** | `J < 0` 的面积占比落在 0.1%–3%：0 说明位移没生效，>3% 说明过冲 |
| G3 | 网格采样率 | 已有测试 `2*quad <= seaFinestWavelength`，低档也要满足或明确豁免 |
| G4 | 远场走样 | `noise_audit.speckle_count` 不因 mip 上升；`seaHF` 不升 |
| G5 | bloom 余量 | 重跑 `post.ts:45-58` 的线性亮度表，峰值仍 < 0.82 |
| G6 | 移动端预算 | 三角形数、每像素噪声次数、纹理字节数 —— 三项写成脚本。帧时间**标 unmeasurable**（无 GPU timing） |

---

## 8. 分阶段（每阶段独立可回滚）

| 阶段 | 内容 | 视觉变化 | 风险 |
| --- | --- | --- | --- |
| **P0** | 铺开拉格朗日坐标，6 处消费方全换 | **无**（帧哈希应不变） | 低；漏改一处会立刻看出来 |
| **P1** | 纹理开 mip + 方差 LUT | 远场变干净 | 低 |
| **P2** | 短域位移 + Jacobian 法线 | **浪形出现** | 中；法线一改，高光峰值会动 |
| **P3** | 泡沫由 `J` 驱动 | 泡沫长在折叠处 | 低 |
| **P4** | 低档档位接入 + 几何重建 | 移动端可跑 | 中 |
| **P5**（可选） | 补一级更细的涟漪 | 近场更碎 | 需重新评估扫描 |

**P0 是最重要的一步**：它不是形状改造，是把地基换成"采样与位移解耦"。做完之后 P2 才是安全的。

---

## 9. 已知风险

1. **K4 的 bloom 余量只有 0.063。** Jacobian 修正会让浪尖法线更陡、高光更尖。
   P2 必须同跑亮度表，否则整片天空会突然开始 bloom。
2. **patch 边缘。** 水平位移最大 `λ·a`（λ=1 时约 0.34 m），相对 3.67 m 网格可忽略，
   但要确认 `SEA_FOLLOW_STEP` 吸附时不会在网格边缘露出未位移的缝。
3. **两域相位关系。** 短域带位移、长域不带，两域的高度仍相加，位移只来自短域。
   物理上可接受（choppiness 集中在短波），但目检要确认没有"长涌被短波推着走"的错位感。
4. **低档关掉 detail bump 后近场会不会太空。** 需要 A/B 图确认；若太空，改用单抽头
   （1 次噪声）而不是三抽头。

---

## 10. 不做

- 不上 GPU compute FFT（我方每域 128²，CPU 算完上传是可控的）。
- 不上 6 级联到毫米级（相机最低掠海 ~7 m，亚像素）。
- 不上 CDLOD 四叉树（地平线 520 m 就被霾吃掉，1600 m 均匀网格够用）。
- 不做时间演化的泡沫 history（单独任务）。
- 不动调色板、不动 tone map。
