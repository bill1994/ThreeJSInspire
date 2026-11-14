# 参考实现归档：painted valley

本目录是**第三方代码的原样归档**，不是我们的源码，也不参与构建。它的作用是让
`src/bg-cumulus*.ts` 里那些「参考 clouds.js:NNN」的注释和 `PAINT_CONSTANTS` 的
「与参考逐项一致」契约**可被验证**，而不是指向一台已经不存在的机器。

## 出处

| 项 | 值 |
|---|---|
| 项目 | Painted valley — <https://patch.gg/blendi/painted-valley> |
| 作者 | blendi (Patch) |
| 取回地址 | `https://patch.gg/api/v1/projects/blendi/painted-valley/repo/file?path=src%2Fvalley%2Fclouds.js` |
| commit | `e523a37e6c86df433a960a46702b09776e73a0e2`（main，Release 1.1.1） |
| 归档日期 | 2026-11-14 |
| 原始路径 | `src/valley/clouds.js`（本目录下同名保存，内容逐字未改） |
| 大小 | 19414 字节 / 471 行 |

> 上一台机器上的本地副本 `G:\DSHProject\refs\painted-valley\` 已随换机丢失，且从未进过
> 本仓库的 git 历史。本归档就是为了让这件事不再发生第二次。

## 许可证

**MIT，Copyright (c) 2026 Patch** —— 全文见同目录 `LICENSE`。MIT 允许复制与再分发，
条件是随附版权与许可声明；本目录的 `LICENSE` 与本文的出处表就是那个条件。
`LICENCE-NOTES.md` 另注明「src/valley/ 由 Patch 为本 block 编写，代码 MIT，其绘制内容 CC0」。

## 我们用它的哪部分

只抄**结构和结构常数**，颜色一个都没抄（色表全部来自本项目自己的昼夜轨道）。
逐行对应见 `docs/superpowers/specs/2026-11-13-painted-valley-style-alignment.md:55-78`
与 `docs/superpowers/plans/2026-11-14-bg-cumulus-baked-raymarch.md`。

- `paint()`（参考 `:279-310`）→ `src/bg-cumulus-paint.ts` 的 `PAINT_CONSTANTS` + `paintMixJs`
- `map()` / `heap()` / `cumulus()` / `billowTexture()`（参考 `:23-190`）→ `src/bg-cumulus-layout.ts`
- `faceDir()` + march（参考 `:312-364`）→ `src/bg-cumulus.ts`

## 明确**不抄**的部分（工程裁定，不是遗漏）

| 参考的做法 | 我们的做法 | 原因 |
|---|---|---|
| `PER_CLOUD = 44` / `MAX_CLOUDS = 14` puff 预算 | 每朵 ≤16、总数 ≤9 | 该尺寸在本机 AMD 驱动上编译挂死（`9cd92d1`） |
| `t = (520 − ro.y)/rd.y`、`tEnd` 14500/56000、霾长 46000 | `uSlabStartY` 由布局 `minBase` 派生、`tEnd = maxDistance + 1000`、霾 12000 | 520 是人家的云底高度，不是步数；14 km 厚云场换到我们 300–900 m 云底、3–7 km 距离带会整层切平 |
| `uLit` 白天中性白 | 色表全部来自本项目轨道 | 主 spec §7 第 4 条 |
| `faceDir()` 的 t 轴符号 | `rd.y` 与 `st.y` **同号**（参考是**反号**） | 参考在 WebGL 下烘焙；我们在 WebGPU 下，立方体 RT 行序不同。`6dc9dab` 取证过：按参考的符号会被地平线门整面弃掉。**这是有意的平台补偿，不要"对齐参考"改回去。** |

## 怎么刷新

```bash
curl -s "https://patch.gg/api/v1/projects/blendi/painted-valley/repo/file?path=src%2Fvalley%2Fclouds.js" \
  | python -c "import json,sys; open('docs/reference/painted-valley/clouds.js','w',encoding='utf-8',newline='\n').write(json.load(sys.stdin)['text'])"
```

刷新后跑 `npx vitest run src/bg-cumulus-paint.test.ts` —— 契约测试会告诉你参考是否变了。
