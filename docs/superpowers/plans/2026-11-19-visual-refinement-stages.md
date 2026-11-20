# 画面优化分阶段计划

用户已确认合并后的范围，并要求每阶段先预览。每阶段完成后暂停后续实现，等待画面反馈。

1. **云覆盖与构图（用户已确认）**：合并原①/⑥；极远云兜底正常飞行视角的 360° 覆盖，空间云保留视差和雾后回收；调整大、中、小尺度比例。保留 puff 单朵造型，改善横向组合。提供旧/新布局对照。
2. **海面形体与夜间可读性（用户已确认）**：合并原②/⑧与④；基础波浪明暗、短浪花、远近细节层级、夜间水体/反射/泡沫分开控制。
3. **全天色彩与飞机可读性（用户已确认）**：协调天空/两类云/海面/飞机的时段配色，改善飞机中午过亮、夜间轮廓弱的问题；调整清晰度层级。
4. **尾迹、风絮及动态稳定性（用户已确认）**：低频连续路径扰动、年龄扩散、宽度/透明度变化；避免逐帧随机抖动；检查俯冲、翻滚、穿云、遮挡和细节闪烁。
5. **反射（天空与远云环境反射，用户已确认）**：先接天空与远云环境反射；根据收益和帧耗决定局部低分辨率平面反射，SSR 仅作为可选对照。
6. **前照灯（已实现，等待画面反馈）**：飞机灯源、柔边空气光束、海面/puff 的局部照明响应；夜间开关，避免全屏泛白。

所有阶段保留已认可的云形和风格化方向。每阶段交付真实浏览器预览、检查结果及局限；不自动推送 GitHub。

2026-11-20 用户追加的夜间云倒影与云散布调整已实现，等待画面反馈。预览 `/night-cloud-lab.html`；记录见 `../reviews/2026-11-20-night-reflection-cloud-scatter.md`。

2026-11-20 第二轮反馈：已改为屏幕外补云，修正云心透出后层的问题，并接入飞机/puff 平面反射及未来地形的显式接入口。当前预览 `/cloud-water-lab.html`；记录见 `../reviews/2026-11-20-offscreen-clouds-object-reflection.md`。等待本轮画面反馈。

2026-11-20 第三轮反馈：puff 倒影减淡与远端柔化，补云同时避开本体和倒影视域，并扩大远端云带。最新对照 `/puff-reflection-lab.html`；记录见 `../reviews/2026-11-20-puff-reflection-softness.md`。

2026-11-20 录屏反馈：调整两类云的排列。远景兜底缩小占幅并错开间距、宽度和高度，puff 增加大中小层次与相近云底。最新预览 `/cloud-layout-lab.html`；记录见 `../reviews/2026-11-20-cloud-layout-video-review.md`。等待构图观感反馈。

第一阶段预览：本机 Vite `/cloud-composition-lab.html`；检查记录见 `../reviews/2026-11-19-cloud-composition-stage1.md`。

第二阶段预览：本机 Vite `/sea-refinement-lab.html`；检查记录见 `../reviews/2026-11-19-sea-refinement-stage2.md`。

第三阶段预览：本机 Vite `/scene-grade-lab.html`；检查记录见 `../reviews/2026-11-19-scene-grade-stage3.md`。

第四阶段预览：本机 Vite `/motion-style-lab.html`；检查记录见 `../reviews/2026-11-19-motion-style-stage4.md`。

第五阶段预览：本机 Vite `/cloud-reflection-lab.html`；检查记录见 `../reviews/2026-11-19-cloud-reflection-stage5.md`。本轮采用低分辨率远云环境图；局部平面反射与 SSR 暂不加入。第六阶段预览：本机 Vite `/headlight-lab.html`；检查记录见 `../reviews/2026-11-19-headlight-stage6.md`。六阶段均已提供实现，本阶段等待画面确认。
