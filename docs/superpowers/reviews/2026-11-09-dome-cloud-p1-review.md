# 穹顶云 P1 验收报告 — 2026-11-09

**结论：P1 达成「能渲染、能量测、可调」的最低目标；视觉质量未达「云」，仍是薄纱。**
**门 1/2/3/4 通过，门 5 目检通过，门 6 桌面通过、手机未测。**

计划：[`plans/2026-11-09-dome-cloud-volumetric.md`](../plans/2026-11-09-dome-cloud-volumetric.md)
设计：[`specs/2026-11-09-dome-cloud-volumetric-design.md`](../specs/2026-11-09-dome-cloud-volumetric-design.md)
量测：[`artifacts/dome-audit/measure.py`](../../../artifacts/dome-audit/measure.py)

---

## 0. 一句话

这层云**真的在画**：`coverage 29.78%`、`tone_span 0.327`、30 秒帧间差 3.16/255、桌面 p95 20.9 ms。
但它现在读起来像**一层薄纱**，不是「一层层会翻涌的体积云」——这是 P1 计划内的状态
（设计 §2 写明「P1 验收标准里没有好看」），下一轮该动的是**形状对比度**，不是管线。

---

## 1. 环境

| 项 | 值 |
|---|---|
| 浏览器 | Chrome / WebGPU（本机桌面 GPU） |
| 画布 | 434 × 772（竖屏 9:16，DPR 钳到 1.5） |
| 机位 | `?pos=0,240,-300`（ALT_MAX）、`?qa=frozen` |
| 质量档 | high（桌面 UA） |

**未测**：旗舰 Android Chrome（验收机）——本环境无法接入真机。

---

## 2. 逐门结果

| # | 门 | 结果 | 证据 |
|---|---|---|---|
| 1 | 云层覆盖率 > 0 | **通过**：29.78%（99 779 px） | `?dome=1` / `?dome=0` 同机位同帧做差 |
| 2 | `cloud_tone_span ≥ 0.2` | **通过**：83.46/255 = **0.327** | 云带掩码内 p92−p8 亮度 |
| 3 | 涌动很慢但非静止（2–12/255） | **通过**：**3.16/255**（30 s） | `qa.step(1800)` 前后两帧 |
| 4 | 无层状条纹 | **通过（首轮口径）**：`banding_flips = 12` | 行均值梯度的**振荡**次数；旧的 `row_stripes`（55）会把正常垂直梯度误记为条纹，已加 `banding_flips` 区分 |
| 5 | 无缝（环面边界 / 地平线融合） | **目检通过**：未见直线或硬边 | 见 `p1-on.png` |
| 6 | 性能 | **桌面通过 / 手机未测**：桌面 high p95 = **20.9 ms**（< 24 ms） | `__porco.qa.frameStats()`，600 帧窗口 |

> 门 3 第一次实测是 **0.06/255**——肉眼等于静止。把 detail 漂移从 0.35 m/s 提到
> 3.5 m/s 才进入区间（Ruling 记在 ledger）。

---

## 3. 已知差距（下一轮要解决）

1. **读起来像薄纱，不像云。** 密度低、侵蚀弱，云体没有「瓣」和明确边界。
   → 调 `coverage` 的 smoothstep 区间、`eroded` 的强度、`DENSITY_SCALE`；
   或在 shape 层补 Worley（Task 4 的 ruling 留了这条回补路径）。
2. **可见带很窄。** 60 m 巡航时云只在仰角 21°–30°；拉到 ALT_MAX 240 才明显变宽。
   这是几何事实（云底 380 m），不是 bug。想更「压顶」只能降云底或抬 `camera.far`。
3. **光照只有单次探针**（Task 6 ruling），云体内部没有层次光。
4. **DOF 与云**：桌面 high 档 `dof: true`，云 `depthWrite: false` → 拿远平面深度被糊。
   本报告的门 2/4 都由**直出**帧量得（`?dome=0` 对照），未受 DOF 影响；但成片观感会糊。
5. **手机未测**——门 6 的另一半仍然悬着。

---

## 4. 证据

| 文件 | 内容 |
|---|---|
| `p1-on.png` / `p1-off.png` | 同机位、同 elapsed 的开/关两帧 |
| `p1-t0.png` / `p1-t30.png` | 相隔 30 秒（`qa.step(1800)`）的两帧 |
| `measure.py` | ROI = 开/关差异掩码；覆盖率 / tone_span / banding / drift 一次算完 |

复跑：
```bash
python artifacts/dome-audit/measure.py artifacts/dome-audit/p1-on.png artifacts/dome-audit/p1-off.png \
  --rect 474.875,0,434.25,772 \
  --t0 artifacts/dome-audit/p1-t0.png --t30 artifacts/dome-audit/p1-t30.png
```

---

## 5. 建议的下一轮（P1.5，不是 P2）

按性价比排序：

1. **形状对比度**：让云有明确边界与「瓣」——这是「像不像云」的第一因素。
2. **低空可见性**：决定云底是否降到 ~300 m（要给飞行上限留余量）。
3. **真机性能**：在旗舰 Android 上跑 `frameStats()`，决定 low 档步数是否要再降。
4. **P2 风格化**：posterize 四档 + 接 `PUFF_BAND_COLORS`——**等形状立住再做**。

---

## 6. 独立复审与 fix pass（2026-11-10）

外部 reviewer 给出 **With fixes**：2 Critical + 7 Important。全部在本轮修完，测试 456/456、tsc 0、smoke ok。

| 编号 | 问题 | 修法 | 证据 |
|---|---|---|---|
| C1 | 骨架层 UV 减掉了相机位置 → 贴在镜头上、零视差、随偏航转 | 横向改世界坐标平铺（SHAPE_TILE_METRES） | 抓帧（GPU-only，无单测） |
| C2 | 预乘色交给非预乘混合，被 alpha 二次乘掉 → **系统性压密度** | 输出改为 acc / max(accA, 1e-4) | 抓帧：云明显变实 |
| I1 | uSunColor 写死暖色，从不更新 | 新增 sunColorFor(elevationDeg) + setSunColor 接线 | sunColorFor 2 个用例 |
| I2 | 光照量纲错 1–2 个数量级，太阳项只占 3–6% | 相函数 ×4π 归一；光学厚度 = 密度×光程×消光 | 同上 |
| I3 | fadeAt 实现了、测了，但 shader 从未调用 | shader 内 sampleA *= smoothstep(fadeStart, fadeEnd, t) | 代码审查 |
| I5 | Worley 跨缝特征点用回绕坐标 → 「可平铺」是假的 | 用**未回绕**格号定位特征点 | 接缝跳变 0.164 → **0.0066**，2 个用例 |
| I6 | lightSteps / octaves 无人消费 | 删 lightSteps；octaves 驱动第二个 detail 采样 | qualityParams 用例更新 |
| I7 | 烘焙 2148 ms 超过 1.5 s 预算 | SHAPE_SIZE 128→96 + 周期整除边长 | 本机 440 ms |

**未修（ruling）**：I4 —— shader 仍旧内联 slab/步长/淡出数学，而不是调用被单测钉住的 TS 函数。TSL 无法调用 TS；已用共享常量（DOME_SLAB、STEP_CURVE_POWER）缓解。改动那两个公式时必须改两处。

**修完后的观感**：云明显变实（C2 的直接结果），但**仍然是平滑的一条带，不是「一层层会翻涌的云」**——这正是下一轮 P1.5 要解决的形状对比度问题。
