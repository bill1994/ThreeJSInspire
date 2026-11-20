# 15:53 天空与水面黑色虚线

用户截图显示天空一条竖直虚线，进入水面后随波浪弯曲。已在 `tod=15.883333333`、正常飞行与朝太阳方位的固定机位复现。

原因：`skyColorTsl` 的水平归一化方向点积 `cosAz` 在 GPU float32 运算中可能略大于 1。原 `(1-cosAz)*0.5` 因而略小于零，随后 `pow(away,1.2)` 产生 NaN。即使高空的权重随后乘零，NaN 仍会传播。天空、背景云空气颜色与海面天空反射共享这一函数，因此表现为太阳方位上的竖线和被波面扭曲的黑点。CPU 镜像 `antiSolarCool` 已有边界保护，之前纯 JS 测试没有暴露 GPU 差异。

修复仅在分数幂之前把 `away` 限制到 [0,1]，与 CPU 镜像一致。未修改时段配色、云排列或反射强度。

验证：

- 修复前记录：`artifacts/sea-sky-line-before-2026-11-20T07-45-35-188Z`；修复后：`artifacts/sea-sky-line-after-2026-11-20T07-46-45-655Z`。同一机位/时间，关闭物体反射、云层和直接渲染检查；浏览器错误均为 0。
- `scripts/sky-line-metrics.py` 的固定白天上方天空裁剪排除了 UI、云、水面与边框。正常机位异常暗像素由 38 到 0，向阳机位由 170 到 0。该阈值只适用于这个固定白天回归场景。
- 新增回归测试模拟 float32 归一化点积越界，并约束 GPU 分数幂前的保护。天空、Preetham、CPU 配色、海天联动和地平线相关 94 项测试通过；生产构建通过。
- 复查入口：`/?tod=15.883333333&todspeed=0&alt=60&headlight=off&bgmotion=spatial&bglook=form&bgwrite=replace&pufflook=volume&sealook=painted&bgq=512&toon=0&dof=0`。
