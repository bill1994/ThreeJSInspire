# DOF 云糊修复 spike

## 实测前提（Task 0.5 已先关 dome 雾）
关雾后 dome 的 NodeMaterial.fog=false 已落地，云的真实颜色/coverage 不再被雾色污染。

## 结论（先在代码里 spike 验证，再决定是否合入）
**本 spike 是「全局关远景 DOF」，不可能做到「只云不关海」**（云 depthWrite=false，深度缓冲共用远平面值，post 阶段无法按区域 mask）。

## 钳制方向（避免写反）
DepthOfFieldNode 内部（`node_modules/three/examples/jsm/tsl/display/DepthOfFieldNode.js:375`）：
  signedDist = viewZNode.negate().sub(focusDistanceNode);
viewZ 是负值，远的 viewZ 更负。
- 要钳制「远距离过大的 CoC」，需给传进去的 viewZ 加一个下限：
  viewZ.clamp(largeNegative, 0)
  或者等价写法：viewZ.max(largeNegative)
  这样太远（更负）的点会被「夹回」到 largeNegative 对应的 CoC。
- 不要写成 `.min(positiveClamp)`——方向完全错。
- 不要写成 `.min(-largeNegative)`——虽然数值上同义，但容易被误读为「全图最大 CoC」。

## 验证方法
spike 后抓 `?post=1` vs `?post=0` 同机位帧：
- 云的边缘是否还被 DOF 糊得看不清分层？
- 海面远景是否也被「牺牲」掉了？（预期：是，全局关）
- banding_flips 是否劣化？

## 源码路径
dof Node 的源码位置：`node_modules/three/examples/jsm/tsl/display/DepthOfFieldNode.js`，
不是 `src/nodes/display/`。参考时别找错目录。
