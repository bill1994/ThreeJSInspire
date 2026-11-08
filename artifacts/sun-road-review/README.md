# 太阳光路 / 背阳海面 取证帧（2026-11-07 复审补拍）

计划 `docs/superpowers/plans/2026-11-07-sun-road-sparkle-anti-solar.md` 引用的基线
（mid p95=226、far-sea p95=99 / p5=20、FALL mid p95=234）没有落盘。本目录补一组
可重放的帧和量测，用来核对那份计划的根因归因与验收门槛。

## 怎么拍的

- 采样时刻的 HEAD：`23cae89 feat(sea): continuous water optics with an azimuthal sunset sky`
- `npx vite --port 5199` → `http://localhost:5199/?qa=frozen`
- three 186 / WebGPU，画布 448×797（同为 9:16，计划用 720×1280；分带统计按高度比例，可比）
- 冻结法：`__porco.game.update = () => {}`（停掉机位驱动），手动摆机位，`__porco.qa.stepFrame(1/60)` × 8
- 后处理 A/B：`__porco.post.setFx({bloom,dof})`

| 帧 | 相机 | 后处理 |
|---|---|---|
| `A-base.png` | `(-90,42,200) → lookAt(-90,2,-50)`（计划 A 机位） | bloom+DOF（出货态） |
| `A-nobloom.png` | 同上 | 关 bloom |
| `A-nodof.png` | 同上 | 关 DOF |
| `A-raw.png` | 同上 | 关 bloom + DOF |
| `B-away.png` | `(90,42,-200) → lookAt(90,2,50)`（计划 B 机位） | 出货态 |

## 量测口径

`measurements.json` + `measure_bands.py`。亮度为 Rec709 加权后的 0–255 显示字节；
`blown%` = 任一通道 >240 的像素占比；分带是画布高度比例。
`sea-mid` = 0.45–0.62（纯海面，排除天空行），`mid` = 0.35–0.62（计划口径未定义，
这里两套都留）。

## 三条结论（详见评审文档）

1. A 帧 mid p95 = 230 / sea-mid = 233，与计划的 226 对得上——基线可信。
2. 但关掉 bloom 后 mid 只掉到 219（-11），关 DOF 掉到 228：**白纱的主体在片段图里，
   不在 bloom**（raw 帧仍 25% 像素过 240）。
3. B 帧远景海面已经是玫粉：`far-sea` 均值 (156,99,120)、天空边缘 (189,107,118)，
   红通道差 33。海面是在忠实反射天空的背阳色——压暗反射会把这个差值推到 ~50。
