# 四条修复记录 — slab 积分 / 天穹玫瑰带 / 云空气透视 / 云体色调

**基准提交：** `17bdff1`（改前）→ 本记录对应 `6a41567`（改后）
**环境：** three 0.186.0、WebGPU 后端、vite dev 5199
**验收：** `npx tsc --noEmit` 干净、`npx vitest run` 261 通过（改前 250）、`npm run build` 通过
**证据图：** `artifacts/archive/dome-cloud-era/docs-qa/clouds-alt60-before.png` / `clouds-alt60-after.png`（对 ref-01 的姿态）、`artifacts/archive/dome-cloud-era/docs-qa/slab-alt200-before.png` / `slab-alt200-after.png`（alt=200，slab 内部）

> 本记录只覆盖四条确认项。云体仍比 ref-01 的 body 暗（见 §5）、cream 顶永不渲染、`PUFF_SHAPE.aspect` 1.45 vs 1.95 等**未动**，它们是独立待定项，需要各自 A/B 才能改。

---

## 0. 结论速览

| # | 项 | 改前 | 改后 |
|---|---|---|---|
| 1 | slab 进入/离开区间 | 相机在带内向下看会越过底面继续积分，alt=200 一片糊白 | 与 `slabRayT` 语义一致，261 个测试锁住 |
| 2 | 天穹玫瑰带 | dome 只有两段 lerp，中间带丢失，可见天空跨一条橙→紫直线 | `SKY_STOPS` 单源四级，玫瑰带回到 13° 附近 |
| 3 | 云空气透视 | 云 `fog=false`，远处维持全对比度，880 m 重绕一帧内闪现 | 距离→霾色渐近；puff 加 `alphaTest` 不再写透明深度 |
| 4 | 云体色调斜坡 | 0.33–0.62 死区全部落到单一 `base` | base→pink 变成 0.26 宽斜坡 |

---

## 1. slab 积分：错的是图，不是 JS

改前 `createTslCloudMaterial` 用 `max(abs(dir.y), 0.002)` 守除数，**抹掉了符号**。相机在带内（`CLOUD_BAND.bottom..top`）向下看时，`t1` 取到的是向上那侧的交点，于是行进越过底面继续积分 —— 那里 `hFrac` 被 clamp 到 0，`profileDensity(0)` 恰好是满密度 `base = 0.92`，一路积到底就是 alt=200 的糊白卡片。

先加的两个测试（inside-down、全包线 property）**一次就绿了**，因为 `slabRayT` 从来是对的。这说明"在 JS 里测镜像"抓不到这类 bug —— 校验必须针对**图**。

- `SLAB_MIN_DIR_Y = 1e-6`：epsilon 只负责保命，不负责量值；
- shader 改用 `TSL.select(lessThan(abs(dir.y), eps), eps, dir.y)`，符号保留；
- `shaderSlabSpan()` 逐节点照抄 gcd 图，`in-cloud.test.ts` 拿它跟 `slabRayT` 对拍。**它第一版故意照抄 shipped 的 `abs()` → 等价性测试红**，这才是根因确认而不是猜测；
- `slabRayT` 只把平行分支的 `camY <= top` 改成 `< top`：恰好 `y = top` 时竖向 profile 为 1.0、`profileDensity` 为 0，图那边的饱和交点本来就答 0。

## 2. 天穹玫瑰带：坐标用错了，不是少了一段

原 dome 只有 `mix(horizon, top, smoothstep(-0.02, 0.55, h))` 两段；canvas fallback 却有五段。但把 `SKY_STOPS` 抽成单源后实拍，辉光带反而从 L\*77.4 掉到 **L\*56.3** —— 真因浮出来：

- canvas 的**屏幕行**被当成 dome 的**仰角**用了；
- 玫瑰带因此落在水线上方 6°，正好在地平线辉光的地盘里；
- 而可见天空（55° 竖 FOV、地平线在约 18°）整段跨在 `#ff9a5a → #6b4fa1` 的直线上 —— 那条直线就是审计里的"灰扑扑交叉"。

所以 `SKY_STOPS` 现在带两个位置字段：`at`（dome 仰角，0 = 水线，1 = h 0.55 ≈ 33°）与 `canvasY`（fallback 行）。dome 从地平线开始逐级折叠，`t = 0` 恒等于 `SKY_PALETTE.horizon`；below-horizon 的 `#8c4a5e` **只给 canvas**，否则海天接缝会冒出灰带。

## 3. 云空气透视

云与 dome 都是 `fog = false`（unlit 分档材质，线性雾只会把颜色抹平），于是 700–880 m 的云保持全对比度贴在已雾化的天空上。最响的是重绕：`far-field.ts` 每 1000 m 把 z 从 `planeZ+120` 瞬移到 `planeZ−880`，880 m 处一片云约 108 px 宽，一帧内出现。

- `horizon.ts`：`CLOUD_HAZE = {NEAR:260, FAR:860, MAX:0.78, DOME_MAX:0.55, CROWN_LO:0.05, CROWN_HI:0.45}`、`cloudHaze(dist)`、`domeCloudHaze(dirY, dist)`；
- `palettes.ts`：`HAZE_COLOR = SKY_PALETTE.horizon`（= `SEA_PALETTE.haze`），天/海/云收敛到同一值；
- dome 是恒距 780 m 的壳，纯距离雾会把整座塔连塔冠一起洗掉 —— 那会打掉 v2 task 4 挣来的"受光顶 vs 背后天空 ΔL\* ≥ 15"。所以按**仰角**加权：水线全雾、约 27° 以上不雾，顺带软化了 `CLOUD_BAND.bottom` 那道刀切；
- `CLOUD_HAZE.FAR = 860 < 880`，`horizon.test.ts` 直接钉这条：重绕落地时必须已站在渐近线上，这是这个数字存在的全部理由；
- puff 另加 `material.alphaTest = 0.02`。NodeMaterial 会编译成 `smoothstep(alphaTest, alphaTest + fwidth, a)` + discard，淡出到 alpha≈0 的片元不再写深度、不再从后面的塔上挖掉自己的轮廓。

## 4. 云体色调斜坡

`band1 = smoothstep(0.30, 0.33)`、`band2 = smoothstep(0.62, 0.66)` —— 两个 0.04 宽的窄窗，中间 0.33–0.62 整整三分之一区间全部落到唯一色 `base`（L\*23.6），24→80 的中间调没有任何输入能选中。

改为 `0.22..0.30` 与 `0.34..0.60`，`base → pink` 从硬边变成斜坡。下面 4 级 posterise 仍负责卡通分档 —— 逐样本窄窗是在做同一件事的第二遍，跳掉中间是它的副作用。`CLOUD_PALETTE` 一个字节没动：暗 base 是 B5 的有据决策，动它需要单独 A/B。

## 5. 未闭合项（未动，需要另行决策）

- **云体仍偏暗**：结构上比 ref-01 的 body（L\*40）低。根因是 B5 的 palette 决策，不是斜坡；要改得单独跑 A/B。
- **cream 顶永不渲染**：`b3 · clamp(n.y, 0, 1) · 0.45`，6.97° 太阳高度下 b3 只在 `n.y ≈ 0.12` 的侧翼成立，贡献 ≈ 0.05。
- **塔底刀切**：`profileDensity` 在底面取满，雾只是软化。
- `PUFF_SHAPE.aspect` 1.45 vs ref 1.95（承重：`hi = 95 − halfH` 会变负）；
- `post.ts` 的 `bokehScale 1.1` 无效；`SKY_PALETTE.sun` 无任何源文件引用。
- **alphaTest 的挖洞修复无法用静态截图证明** —— 它只在相机穿进云、puff 淡出到 alpha≈0 的那几百毫秒里有观感差异。逻辑与测试可证，像素不可证，按未验证记。
