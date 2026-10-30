# 云团散布（puff scatter）方法与实施计划

- 日期：2026-10-30
- 状态：**已定方法，未实施**（等下一次一起动手）
- 前置：`puff-cloud.ts` 的造型已按 ref-01 重做（评审 §9），当前 `PUFF_SHAPE.width = 22`、`aspect = 1.45`
- 关联：`docs/superpowers/reviews/2026-10-30-cloud-sea-sun-audit-review.md` §7.2 / §8 / §9

---

## 0. 用户要求（原话拆条）

1. 垂直方向随机分布；
2. 但**不能太高到天上**，也**不能低到海面**（不许穿海）；
3. 水平方向也随机；
4. 但**不能太密集**，否则全挤在一块；
5. 想出一个 scatter 方法，写进文档，到时候一起实施。

---

## 1. 现状为什么不满足这四条（都是实测/推导，不是感觉）

`puffLayout(seed, count)` 现在的做法：前半数云塞进近带 `x ±70, z -80..-350`，后半撒满走廊；`y` 独立均匀落在 `PUFF_Y_MIN..PUFF_Y_MAX = 38..75`；另有一条 `|x|<45 && |z|<150 → z -= 150` 的出生点净空 hack。

### 1.1 穿海 + 顶穿云层：`y` 跟云的尺寸无关

按 `PUFF_SHAPE` 推：局部高度 31.9 m，实测几何 bbox 高度上界 38.3 m（含 lump 变形与瓣缩放），即半高 **19.15 m**。

| scale | 世界半高 | `y=38` 时云底 | `y=75` 时云顶 | 低于海面 | 侵入云层(`≥95`) |
|---|---|---|---|---|---|
| 1.6 | 30.6 | 7.4 | 105.6 | — | 10.6 |
| 2.0 | 38.3 | −0.3 | 113.3 | 0.3 | 18.3 |
| 2.4 | 46.0 | −8.0 | 121.0 | 8.0 | 26.0 |
| **2.6** | **49.8** | **−11.8** | **124.8** | **11.8** | **29.8** |

**结论：最大档的云底比海平面低 11.8 m，云顶捅进体积云层 29.8 m。** 两条都违反要求 2。

而且几何可行性本身就打架：海面净空 8 m 到云层底 95 m 只有 **87 m** 可用，扣掉两端只剩 `halfH ≤ 43.5` → **scale 上限 2.27**，而现在的 `s ∈ [1.6, 2.6]` 上限超了。

### 1.2 挤成一堆：近带的容量被占满

`scale 2.6` 时云的世界半宽 = `11 × 2.6 = 28.6 m`，两朵不重叠要中心距 **≥ 57 m**。
近带 `140 m × 270 m = 37800 m²`，按 57 m 网格只放得下 **2 × 4 = 8 个**不重叠位。
而现在的布局往里塞了 **7 朵**——**87% 占位**，视觉上必然叠成一坨（对照 `live/puff-v4-cruise.png` 左侧那簇）。

违反要求 4。

### 1.3 出生点 hack 会破坏间距

`z -= 150` 是把云**推走**而不是剔除，推完之后可能正好撞上另一朵，且让近带承诺的位置失效。要换成「剔除」，不要「平移」。

### 1.4 没有真正的垂直随机

`y` 虽然均匀随机，但范围 38..75（37 m）比云自己还矮（最大 99.6 m），所以"随机"体现在重叠方式上，不体现在构图上。

---

## 2. 方法

三个机制组合，各解决一件事：

| 机制 | 解决 | 技术 |
|---|---|---|
| **A. 尺寸驱动的高度带** | 不穿海、不顶穿 | 每朵云按自己的 `halfH` 求可行 `y` 区间 |
| **B. Z 向环面抖动网格** | 不密集 | 网格保证最小间距；网格沿 Z 正好铺满 tile，天然可循环 |
| **C. 相干覆盖掩码** | 不像白噪声 | 低频噪声在**环面坐标**上采样，成片留白/成片成簇 |

**明确不做的：** 垂直方向不强制两两间距。可用竖直带只有 87 m，而一朵云就 60~100 m 高，再硬塞竖直间距会让大部分云被拒。竖直方向靠 A 的自由浮动 + B 的水平错开即可；竖直重叠恰恰是云团该有的厚度。

---

### 2.1 A — 尺寸驱动的高度带

先把几何造出来拿到真实尺寸，再散点（**顺序要反过来**，现在是先散点后建模）：

```ts
export interface PuffSize {
  /** 世界半宽（局部 bbox 半宽 × scale）。 */
  halfW: number;
  /** 世界半高。 */
  halfH: number;
}

const SEA_CLEAR = 8;      // 云底距海面的最小净空
const DECK_BOTTOM = 95;   // = CLOUDS.CLOUD_BOTTOM，云层底，别自己另写一份

function yBand(size: PuffSize): [number, number] | null {
  const lo = SEA_CLEAR + size.halfH;
  const hi = DECK_BOTTOM - size.halfH;
  return hi > lo ? [lo, hi] : null;   // null = 这朵云太大，装不进这一层
}
```

`scale` 先按 `yBand` 反解上限再取值：

```ts
// 由 halfH_local 反解：2 * halfH_local * s <= DECK_BOTTOM - SEA_CLEAR
const S_MAX_FIT = (DECK_BOTTOM - SEA_CLEAR) / (2 * halfHLocal);  // 当前几何 ≈ 2.27
const s = min(wantScale, S_MAX_FIT);
```

`yBand` 返回 `null` 就**换一个 scale 重试**，而不是硬夹——硬夹会让云贴在海面上或贴着云层底，边界感全露。

竖直分布用轻度下偏（参考图云底压在水平线上）：

```ts
const u = rand();
const y = lo + (hi - lo) * Math.pow(u, VERTICAL_BIAS);  // VERTICAL_BIAS = 1.6
```

`VERTICAL_BIAS = 1.0` 就是纯均匀；> 1 往下压。**这一档是观感旋钮，默认 1.6。**

---

### 2.2 B — Z 向环面抖动网格

走廊是 `x ∈ [-PUFF_X_SPAN, +PUFF_X_SPAN]`、`z` 以 `PUFF_FIELD_DEPTH = 1000` 为**周期**（`wrapPuffZ` 已经在做取模，所以把布局按环面生成，运行期回收**自动保持间距**，不需要重散点）。

网格要沿 Z **正好整除** tile，否则接缝处间距会破：

```ts
const MIN_GAP = 57;                       // 由 2 × max(halfW) 推，见 §2.4
const cellsZ = Math.round(PUFF_FIELD_DEPTH / MIN_GAP);   // 1000/57 = 17.5 -> 18
const cellZ  = PUFF_FIELD_DEPTH / cellsZ;                // 55.6 m，始终整除，接缝无缝
const cellsX = Math.floor((2 * PUFF_X_SPAN) / MIN_GAP);  // 260/57 = 4
const cellX  = (2 * PUFF_X_SPAN) / cellsX;               // 65 m
```

每格一朵，位置 = 格心 + 抖动；抖动幅度必须受控，否则相邻两朵会跑进彼此：

```
// 沿某轴相邻两格，各抖 ±j，最坏靠近 2j；要求 格距 - 2j >= MIN_GAP
j = (cell - MIN_GAP) / 2
```

Z 向按环面取模，X 向夹在 `[-PUFF_X_SPAN, PUFF_X_SPAN]`。

> 为什么用抖动网格而不是 Poisson disc：
> Poisson disc 的 `goodSamples` 要写环面距离（`dz = min(|dz|, D-|dz|)`），且数量不定；
> 网格 + 定向抖动**可证**最小间距、数量确定、接缝天然无缝，代码量 1/3。
> procedural-gen 的 `references/noise.md` 把两者并列推荐，这里选网格是因为 tile 必须整除。

---

### 2.3 C — 相干覆盖掩码

网格只是让格子不挤；**哪些格子有云**才决定构图。用随机丢弃会得到白噪声，所以用低频噪声：

```
// 环面坐标：z 映射到圆，噪声就在柱面上连续，跨 seam 无痕
const a = (2 * Math.PI * z) / PUFF_FIELD_DEPTH;
mask = fbm2(x * MASK_FREQ + R * cos(a), R * sin(a))   // MASK_FREQ ≈ 1/320, R ≈ 1.7
```

`MASK_FREQ = 1/320` → 特征尺度约 320 m：一屏能看见一团 bank + 一片晴空，正是 ref-01 的构图（左侧大团、中间柱子、中间留白）。

**取哪 N 个格子**：把 `cellsX × cellsZ` 个格子的 mask 值排序，取前 N（N = `PUFF_COUNT_*`）。
这样**数量仍然确定**（`PUFF_COUNT_HIGH = 14` 的语义不变），但分布成簇而不是均匀撒盐；网格又保证了簇内不重叠。

---

### 2.4 `MIN_GAP` 怎么定

不用拍脑袋，从实际最大尺寸推：

```ts
const MIN_GAP = 1.15 * 2 * maxHalfW;   // 留 15% 余量，允许轻微咬合（云团本来就该互相咬）
```

当前几何：`maxHalfW = 11 × S_MAX_FIT = 11 × 2.27 = 25 m` → `MIN_GAP = 57 m`。
`cellsZ = 18`、`cellsX = 4` → 72 个候选格，取 14 → **占位 19%**，疏而没有空到假。

---

### 2.5 出生点净空

```
if (hypot(x - START_X, wrappedZ(z) - START_Z) < SPAWN_CLEAR) 丢弃该格
```

**丢弃，不平移**（§1.3）。`SPAWN_CLEAR ≈ 120 m`，约为两朵云的中心距。
丢弃后总数少一朵是可接受的——`PUFF_COUNT` 的语义从"必须 14 朵"降为"目标 14 朵"。

---

## 3. 接口与代码改动

| 位置 | 改动 |
|---|---|
| `puff-cloud.ts` | 新增 `PuffSize`、`puffScatter(seed, sizes, opts)`；`puffLayout` 保留为薄封装或直接删除 |
| `initPuffClouds` | **顺序颠倒**：先 `buildPuffGeometry` 拿到每朵的 bbox → 再 `puffScatter` 定位置 |
| `PUFF_Y_MIN/MAX` | 废弃（改由 `halfH` 推）。导出常量保留一版做兼容，标注 deprecated |
| `wrapPuffZ` | 不改。环面布局 + 现有取模 = 间距保持 |
| 单测 | `puff-cloud.test.ts` 的布局断言全部重写，见 §4 |

`puffScatter` 保持**纯函数**（只吃 `seed` 和尺寸数组，不读全局随机、不读时间），
这样 §4 的每条不变量都能在 vitest 里直接断言。

---

## 4. 不变量（写成单测，这是这次改动的验收）

1. **确定性**：同 seed 同尺寸 → 深相等。
2. **最小间距（含环面）**：任意两朵 `hypot(dx, toroidalDz) >= MIN_GAP`，
   其中 `toroidalDz = min(|dz|, D - |dz|)`。**这条是重点**，必须按环面距离断言，否则接缝处的挤叠查不出来。
3. **不穿海**：每朵 `y - halfH >= SEA_CLEAR`。
4. **不顶穿**：每朵 `y + halfH <= DECK_BOTTOM`。
5. **不出走廊**：`|x| <= PUFF_X_SPAN`，`z ∈ [-D, 0]`（或 tile 内）。
6. **出生点净空**：`hypot(x - START_X, z - START_Z) >= SPAWN_CLEAR`。
7. **占位率**：`count / (cellsX * cellsZ) ∈ [0.12, 0.35]`——防两边跑偏（挤成一坨 / 稀到假）。
8. **回收保持间距**：对每个 `planeZ` 采样 `wrapPuffZ` 后重跑第 2 条。
   这条钉住"环面布局 + 取模回收 = 间距不变"这个依赖关系，是整套方法成立的前提。
9. **尺寸可行性**：`scale` 取不到能塞进 `yBand` 的值时抛错而不是返回 NaN。

---

## 5. 实施步骤

1. `buildPuffGeometry` 之后 `computeBoundingBox()`，把 `halfW/halfH × scale` 收进 `PuffSize`。
2. 写 `puffScatter` 纯函数（网格 + 抖动 + 掩码取前 N + 净空剔除）。
3. 先写 §4 的 9 条单测（红），再实现到绿。
4. `initPuffClouds` 改成先建模后散点。
5. 实拍三机位对照：`?alt=60` 平飞 / `?alt=200` 云中 / 俯冲。判据：
   - 视野内不超过 2 朵互相咬合；
   - 云底不切海面（截图上云与水之间始终有天空或海面）；
   - 有一片可辨的晴空缺口。
6. `npx vitest run` + `node scripts/smoke.mjs`。

---

## 6. 不做 / 待定

- **不做**流场式分布（云带沿风向拉长）。风向对齐海风是 audit plan §2.4 的事，跟散布正交。
- **不做**垂直方向的两两间距（§2 已说明原因）。
- **待定**：`VERTICAL_BIAS`、`MASK_FREQ`、`SPAWN_CLEAR` 三个观感旋钮的默认值，实拍后定。
- **待定**：`PUFF_COUNT` 的语义（"必须" vs "目标"）。本方案按"目标"设计；若要保持"必须 14 朵"，Net 空剔除要改成「换相邻格」，复杂度上一个台阶。
- **依赖未决**：云层底 `DECK_BOTTOM = 95` 是否保留。评审 §8.4 建议把两个 slab 合成一个 30→480 m 的单层；若采纳，`DECK_BOTTOM` 变化会直接改 `yBand`，这份散布方案要跟着调一个常数。**这个决定应该在散布实施之前定下来。**
