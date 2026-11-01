# 帧级验收 run 2 — 天穹彩度、两条改动、三处口径

**为什么这份存在。** run 1 把四态采全并对了门，但它有三条结论在本轮被推翻：

1. 天穹「彩度不足」被当成整体调色板问题，实际是**太阳辉光太宽** + **云的高光色太淡**，两处都能改；
2. 海面饱和与云覆盖两条失败项，用的是 `ref_gap_measure.bands_fixed()`——一个 docstring 里
   写着「Never quote a sea metric that came from here」的废弃口径；
3. A-cruise 的 sky gate 拿 ref-01 的绝对值卡，而两者构图不同源，卡不过去不是缺陷。

本文记录两条改动、重测的数字、构图差异的算术，以及由此定下的 gate 适用范围。

## 1. 改动

两条，都在 `dsh` 浏览器里逐次 reload + `qa.step(180)` + 截图验证，相机位置每轮确认一致
（`[0, 66.8, -98.099]`，`elapsed` 3）。

| 文件 | 改动 | 依据 |
| --- | --- | --- |
| `src/horizon.ts` | `GLOW_POW` 9 → 48 | 竖屏水平 FOV 只有 36°，`cos^9` 在整屏范围内不低于 0.28，暖白把上半天空洗平 |
| `src/palettes.ts` | `pink` `0xffb3c1` → `0xde80ac` | 云的高光色原本是 L\* 80.4 / C\* 29.8，是整条云色链里彩度最低的一个 |

`pink` 的新值按 L\* 65 / C\* 45 反解得出。**这已经接近 sRGB 的边界**：同样的 C\* 45 若把
L\* 提到 80，反解出的 R 线性值到 1.23，超出色域会被裁掉，所以「又亮又艳的粉」在 sRGB 里
不存在，只能牺牲亮度换彩度。

## 2. 天穹 gate（同尺寸对比）

用 `sky_band_probe.sky_report()`，即 handoff 里 `C*med ≥ 38` 的真实口径
（顶部 22% × 横向 36–56% 的 strip）。before / after 都取 448×797 的浏览器截图，
`content_crop` 后 292×518，避免跨尺寸比较：

| 帧 | `edge_strip` | `C_med_strip` | `L_med_strip` | `value_swing_strip` | `sat_strip` |
| --- | --- | --- | --- | --- | --- |
| before（pow 9 / pink ff） | 0.0000 | 24.9 | 65.2 | −0.097 | 0.287 |
| **after（pow 48 / pink de）** | 0.0000 | **32.9** | 54.0 | −0.153 | **0.388** |
| ref-01 | 0.0571 | 45.5 | 63.2 | +0.135 | 0.478 |
| 门槛 | ≥0.035 | ≥38 | — | >0 | — |

净变化：`C_med_strip` **+8.0**，`sat_strip` **+0.101**。代价是 `L_med_strip` −11.2，
`value_swing_strip` 更负（−0.097 → −0.153）。

**协议帧（516×917 crop）的 `C_med_strip` 是 22.1，与同尺寸 before 的 24.9 不等。**
比例量虽然稳健，strip 覆盖的实际像素内容仍随分辨率变化，**跨尺寸的数字不可直接相减**。

## 3. 为什么 A-cruise 过不了 sky gate：构图

从 `__porco.qa.describe()` 取到的实际值：

```
plane  [0, 60, -138]      camera [0, 66.8, -98.099]
fov    61.64              canvas 448x797
```

相机俯角 = atan(6.8 / 39.9) ≈ **−9.7°**，视野顶部 elevation ≈ **+21.1°**。
云带 `CLOUD_BAND` 是 95–480 m，相机在 66.8 m——**相机在云带下方，且向下看**。

顶部能看到的是多远处的云顶：

| 距离 | 云顶（480 m）仰角 |
| --- | --- |
| 300 m | 54.0° |
| 600 m | 34.6° |
| 1000 m | 22.4° |
| 1200 m | 19.0° |

视野顶 21.1°，所以**只有 1000 m 以外的云顶才进画面**——又远又薄，`edge_strip` 自然是 0。
ref-01 是云中滑翔，云贴脸，顶部 44.9% 是云（run 2 实测），两边的顶部根本不是同一种东西。

## 4. 决定：A-cruise 的 sky gate 改为回归检查

**不拿 ref-01 的 `C_med_strip ≥ 38` / `edge_strip ≥ 0.035` 卡 A-cruise。** 理由如上：
A-cruise 是低空贴海巡航，顶部是空天空；ref-01 是云中滑翔，顶部半屏是云。用同一把尺子量
两种构图，只会逼着去扭相机仰角或云带高度，那是拿 gate 反向绑架设计。

替代口径：

- `C_med_strip` / `sat_strip`：对 A-cruise 只做**回归检查**——不低于本轮基线（32.9 / 0.388）
  减去容差，防止后续改动悄悄把它改回去；
- `edge_strip` / `value_swing_strip`：**对 A-cruise 不适用**，两条都依赖「视野内有云」这个前提；
- 云相关的 `coverage` / `tone_levels` 仍按全画面口径正常卡（见 §5）。

若将来相机仰角或云带高度变了，这两条 gate 要重新评估是否恢复。

## 5. 三处测量口径（run 1 的结论要打折看）

本轮查 `measure.json` 的来源时发现，其中三个数不可用于对外结论：

**`sea_sat_mean`（run 1 报 0.631 / 0.656 / 0.630 / 0.703，全 ✗）**

来自 `ref_gap_measure.measure()` → `bands_fixed(a)["sea"]`，即固定 70% 行分带。该函数
docstring 原文：「SUPERSEDED by content_bands.bands(). … **Never quote a sea metric that came
from here.**」权威口径 `content_bands.bands()` 会逐列找地平线，找不到就返回 `None` 而不是猜：

| 帧 | 权威地平线 | 权威 sea 判定 |
| --- | --- | --- |
| A-cruise | 0.592 | 可用 |
| B-dive | 0.997 | **UNUSABLE（海面只剩 2 行，门槛 39）** |
| C-bankdive | 0.960 | **UNUSABLE（32 行 < 39）** |
| D-skim | 0.528 | 可用 |

**run 1 引用了 B-dive / C-bankdive 的海面饱和度，而这两帧按权威口径根本没有可用海面区域。**
另外 `sea_sat_mean` 不在 `audit.py --parity` 的 102 个 pinned 值里——`ref_gap_protocol.sea_block()`
不产出这个字段，所以 parity PASS 对它零保障。

**`cloud_coverage`（run 1 报 0.277 vs 目标 0.45–0.58）**

0.277 是 `bands_fixed` 的 25–62% 行段**内部**的覆盖率。全画面口径
（`ref_gap_protocol.cloud_block()`）实测：

| 帧 | 全画面 coverage | 目标 0.45–0.58 |
| --- | --- | --- |
| A-cruise | **0.519** | **在范围内** |
| B-dive | 0.343 | 偏低 |
| C-bankdive | 0.274 | 偏低 |
| D-skim | 0.787 | 偏高 |

**A-cruise 这条实际是过的。**

**`measure.json` 本身复现不出来**

用当前代码重算 A-cruise 的 `bands_fixed` 海面饱和度得 0.650，json 里是 0.631。该快照要么
由旧版代码生成，要么截图换过。**一份对不上的基线比没有基线更危险**，引用前先跑一遍
`audit.py --parity` 并核对。

## 6. 已验证的负结果（别再试一遍）

| 试过的 | 结果 | 处置 |
| --- | --- | --- |
| `GLOW_GAIN` 0.42 → 0.30 | top30 C\* 29.4 → 29.6，几乎无收益 | 回退 |
| `sunTint` 改橙 `(1.0, 0.55, 0.18)` | top30 C\* +0.5，但破坏 `sea-fft.ts` 里「verbatim 复制天空辉光」的约定 | 回退 |
| `CLOUD_BAND.top` 480 → 700 | top30 C\* 28.9 → 28.8，云密度在 waist 以上已衰减 | 回退 |
| `band2` 0.34..0.60 → 0.50..0.72 | **未执行**：云最外层 `lightAmt ≈ 0.7~1.0`，无论窗口怎么设都是满 pink | 放弃 |
| `pink` `0x9f4d7c`（L\* 45 / C\* 41） | C\* 31.5 且 `edge_strip` 0.0313，但 L\* 掉到 49.6（ref 63.2） | 改用 `0xde80ac` |

`pink` 的取舍是硬的：云暗下去彩度和边缘都上来，但 L\* 掉；云亮回去 L\* 恢复，边缘归零。
sRGB 里没有「又亮又艳」的粉，这一点是色彩空间约束，不是参数没调对。

## 7. 复现

```
python artifacts/cloud-audit/audit.py --parity
python artifacts/cloud-audit/sky_band_probe.py
npm run dev -- --port 5199 --strictPort
# http://localhost:5199/?alt=60&qa=frozen
#   .porco-hud {display:none}
#   __porco.qa.step(180)   → elapsed 3, camera [0, 66.8, -98.099]
#   截图（渲染与出帧分处不同宏任务，见 run 1 §1）
npx tsc --noEmit && npx vitest run
```

本轮对比图存 `artifacts/cloud-audit/qa-shots/`：

- `glow-before-pow9.png` — pow 9 / pink `0xffb3c1`（改动前）
- `glow-after-pow48.png` — pow 48 / pink `0xffb3c1`（只改辉光）
- `glow-after-pow48-darkpink.png` — pow 48 / pink `0xde80ac`（当前）

测试门：`npx tsc --noEmit` 干净；`npx vitest run` 26 files / 264 tests 全过。
