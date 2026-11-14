# bg-cumulus 可见性与变体 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让烘焙积云在玩家实际视野里成立（出生视角可见、方位/角宽与布局一致、全天空不被泛白污染），再把散落与形状变体做到"有层级"。

**Architecture:** 先建一把可信的尺子（确定性抓帧 + 差分度量），再用它钉住三个已观测缺陷（方位偏移、全天空泛白、内部大理石噪声），最后才动 `bg-cumulus-layout` 的散落与变体。所有验收都是数字，不是"看着更好"。

**Tech Stack:** TypeScript 5.5 / three 0.186（WebGPU + TSL）/ Vite 6 / Vitest 2；探针脚本走 Node 内置 `WebSocket` + CDP，无新依赖。

**Spec:** `docs/superpowers/plans/2026-11-14-bg-cumulus-baked-raymarch.md`（本计划的规格基线；本计划只改它的观感与散落层，不改 raymarch 结构）

---

## 背景：本计划为什么从"建尺子"开始

2026-11-14 的排查中，本计划作者用肉眼 + 单次截图得出过**两个错误结论**，两次都是量具的问题：

1. 看到 `bg=0/1` 差分只有 0.184% 像素，断言"烘焙层等于不在"——实际差分图被 **HUD 遮挡**（`.porco-hud` 盖住了云的主体，占画面上半右半）。
2. 看到云是"150px 的圆球"，断言"横向被压 4.4 倍"——实际那是**被画面边缘裁掉的大云**的可见部分；撤掉 HUD 后它横跨左半边。

同一条链路上还有一个**真实但轻微**的现象：烘焙层开启时整片天空有一层 5–10 级的均匀泛白（`near < uTexel` 软边 alpha 在整屏泄漏），它会把任何基于阈值统计的覆盖率算高。

因此任务的顺序是：**尺子 → 标定 → 修观测到的缺陷 → 才谈美观**。

### 已确认的观测事实（作为任务验收的起点值）

| 观测 | 值 | 度量方式 |
|---|---|---|
| 出生视角天空的云覆盖 | 阈值 >24 下只剩左边缘 ≈2.5° 残片，其余为空 | HUD 隐藏后 `setBgVisible` 差分 |
| 转向 az≈338 后云的存在性 | 有，横跨 ≥132px 并被左边缘裁切 | 同上 |
| 全天空泛白 | 每行均值 3–10 级；阈值 >8 时报 14.84%，其中绝大部分是这层泛白而非云 | 同上，逐行幅值剖面 |

## Global Constraints

- **预算硬顶**：`BG_CLOUD_LOOP_MAX = 9` 云、`BG_PUFF_LOOP_MAX = 16` puff/云。**不得提高**——本机实测（单卡 NVIDIA RTX 3060，2026-11-14）：全量 14 云 × 44 puff 的 TSL 展开让着色器编译器挂起 >25 s（`9cd92d1`；当时归因"AMD 驱动"是误记，本机无 AMD 硬件——挂死就发生在 3060 上），9×16 后全量首烘 3.2 s。变体只能花在"形状多样性"上，不能花在"数量"上；要涨预算须单独立项实测（量 init 时间 + 首访冒烟），不许顺手删顶。
- **无新依赖**：`package.json` 的 `dependencies` / `devDependencies` 保持原样。探针脚本用 Node 内置 `WebSocket`、`fetch`。
- **确定性**：`layoutClouds(seed)` 必须是 `(seed) => CloudLayout[]` 的纯函数，同 seed 同输出；所有新约束都要有钉死种子的测试。
- **关云零成本**：`?bg=0` 时不得挂载模块、不得首烘、不得分配烘焙目标。
- **既有绿灯不得破**：`npx tsc --noEmit` 为 0，`npx vitest run` 全绿（**当前基线 68 文件 / 718 测试**——本计划写作时为 708，HUD 折叠改动后 +7，PAINT_CONSTANTS 对照测试（`3b525a9`）再 +3，以 718 对账；2026-11-14 深夜实测）。
- **竖屏画幅**：`#frame` 是 `width:min(100vw,56.25vh);aspect-ratio:9/16`（`index.html:12`；同一行还有 `max-width:560px`——大窗口下宽度封顶，探针按 CDP 钉死口径不受影响），**448×797 不是常量**，是当前窗口下的运行时值。探针必须用 CDP `Emulation.setDeviceMetricsOverride` 钉死 448×797 / dsf 1 / mobile false，否则所有角换算与覆盖率门槛随窗口漂移。垂直 FOV 60° → 水平 FOV ≈ 35.96°（`2·atan(tan30°·448/797)`）。
- **不动 puff 层**：近场 `puff-cloud` 是另一条链路，本计划不碰它的视觉参数。

## Review Focus

以下五类输入/状态规格未覆盖，但真人一定会遇到；每条都在对应任务的测试里钉住。

1. **相机贴边/穿场**：相机位移跨越 `REBAKE_METRES`（250 m）时的重烘窗口里，天空不得闪黑或闪出一帧空心 —— 期望是"旧图继续用到新图完成"。→ Task 7 Step 6。
2. **地平线以下与陡下视**：向下俯冲时 `dir.y < 0` 必须整片不采云，且不得把云的镜像倒影画在海面以上。→ Task 3 Step 3 加烘焙侧源码断言（`rd.y.lessThan(0.002).discard()`）+ 复用同处天空侧门断言。
3. **极端伏角（`?bgq=2048` + 9 云 × 16 puff）**：编译不得超预算挂钩，首帧不得卡死 —— 期望与 1024 同构，只是更慢。→ Task 7 Step 5 矩阵。
4. **夜间/低太阳**（`?tod=2`、`?tod=20`）：云的 `uUnder`/`uShade` 分支不得出现纯黑或纯白弧面。→ Task 7 Step 5 矩阵。
5. **窗口缩放/DPR 变化**：烘焙视口的 save/restore 必须在 resize 后仍然正确（`6dc9dab` 刚修过一次同类问题，别回归）。→ Task 7 Step 5 缩放组（判据见该步：比**角宽**，不比像素覆盖率）。

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/cloud-metrics.ts` | 纯函数：掩码、包围盒、角换算、覆盖率。无 DOM。 | Create |
| `src/cloud-metrics.test.ts` | 上述纯函数的单测 | Create |
| `scripts/cloud-probe.mjs` | CDP 驱动：起页 → 定步 → 两张截图 → 页面内解码差分 → 写 JSON + PNG | Create |
| `src/bg-cumulus-layout.ts` | 散落与变体（仰角一等参数、长宽比分层、puff 半径幂律） | Modify |
| `src/bg-cumulus-layout.test.ts` | 布局约束测试 | Modify |
| `src/bg-cumulus.ts` | 烘焙：面→方向对齐、软边泛白、可强制布局 | Modify |
| `src/bg-cumulus.test.ts` | 烘焙单测 | Modify |
| `src/qa.ts` | `parseBgForce` 等新 URL 参数 | Modify |
| `src/world.ts` | 透传 `bgForceLayout` → `forceLayout` | Modify |
| `artifacts/cloud-probe/<stamp>/` | 每次探针的 metrics.json + png | Create（产物，不入库） |

---

### Task 1: 测量台（纯函数 + CDP 探针）

**Files:**
- Create: `src/cloud-metrics.ts`
- Test: `src/cloud-metrics.test.ts`
- Create: `scripts/cloud-probe.mjs`

**Interfaces:**
- Produces（**所有矩形一律半开区间 `[x0,x1) × [y0,y1)`**，`bbox` 的返回值也一样——同名字段绝不允许两种语义）:
  - `type RgbaImage = { data: Uint8ClampedArray; width: number; height: number }`
  - `type Rect = { x0: number; y0: number; x1: number; y1: number }`（半开）
  - `diffMask(a: RgbaImage, b: RgbaImage, threshold: number): Uint8Array`
  - `bbox(mask: Uint8Array, width: number, height: number, region: Rect): (Rect & { count: number }) | null`
  - `angularWidthDeg(pixelWidth: number, canvasWidth: number, canvasHeight: number, vFovDeg: number): number`
  - `angularHeightDeg(pixelHeight: number, canvasHeight: number, vFovDeg: number): number`
  - `coverageFraction(mask: Uint8Array, width: number, region: Rect): number`
- Consumes: 无（纯函数）

- [ ] **Step 1: 写失败测试**

```ts
// src/cloud-metrics.test.ts
import { describe, expect, it } from 'vitest';
import { angularHeightDeg, angularWidthDeg, bbox, coverageFraction, diffMask, type RgbaImage } from './cloud-metrics';

const solid = (w: number, h: number, rgb: [number, number, number]): RgbaImage => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    data[i * 4] = rgb[0]; data[i * 4 + 1] = rgb[1]; data[i * 4 + 2] = rgb[2]; data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h };
};

describe('cloud-metrics', () => {
  it('diffMask 只标出超过阈值的像素', () => {
    const a = solid(4, 1, [10, 10, 10]);
    const b = solid(4, 1, [10, 10, 10]);
    b.data[0] = 40; // 第 0 像素差 30
    const m = diffMask(a, b, 24);
    expect(Array.from(m)).toEqual([1, 0, 0, 0]);
  });

  it('bbox 在给定区域内给出紧包围盒与像素数（半开区间：x1/y1 指向最后一个像素的下一个）', () => {
    const img = solid(10, 10, [0, 0, 0]);
    const mask = diffMask(solid(10, 10, [0, 0, 0]), img, 24);
    // 手工点亮 (2,3)-(5,6)
    for (let y = 3; y <= 6; y += 1) for (let x = 2; x <= 5; x += 1) mask[y * 10 + x] = 1;
    const b = bbox(mask, 10, 10, { x0: 0, y0: 0, x1: 10, y1: 10 });
    expect(b).toEqual({ x0: 2, y0: 3, x1: 6, y1: 7, count: 16 });
  });

  it('bbox 在空掩码上返回 null', () => {
    expect(bbox(new Uint8Array(100), 10, 10, { x0: 0, y0: 0, x1: 10, y1: 10 })).toBeNull();
  });

  it('角宽用精确 gnomonic 式：垂直 FOV 60°、448×797，整幅一半 224px → 18.43°（不是 18°）', () => {
    // 近轴近似会把 18.43 读成 18.03，2.4% 的误差会直接吃掉 Task 3 的 ±2° 判定余量
    expect(angularWidthDeg(224, 448, 797, 60)).toBeCloseTo(18.43, 1);
    const full = angularWidthDeg(448, 448, 797, 60);
    expect(full).toBeCloseTo(35.96, 1);
  });

  it('角高换算：797 像素整幅 = 60°', () => {
    expect(angularHeightDeg(797, 797, 60)).toBeCloseTo(60, 5);
  });

  it('coverageFraction 只统计区域内（半开区间，2×2 区域含 4 px）', () => {
    const mask = new Uint8Array(100).fill(0);
    mask[0] = 1; mask[1] = 1; // 区域 [0,2)×[0,2) 共 4 px 里 2 px
    expect(coverageFraction(mask, 10, { x0: 0, y0: 0, x1: 2, y1: 2 })).toBe(0.5);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/cloud-metrics.test.ts`
Expected: FAIL — `Failed to resolve import "./cloud-metrics"`

- [ ] **Step 3: 实现 `src/cloud-metrics.ts`**

七个导出按上面签名实现。所有矩形半开：`for (let y = r.y0; y < r.y1; ...)`。

- `angularWidthDeg(px, W, H, vFov)` = `2·atan( tan(vFov/2) · (px/H) )`（gnomonic 精确式，等价于先算水平 FOV 再按像素比例取角；**不要**用 `hFov·px/W` 的近轴近似，224px 上它差 2.4%）。
- `angularHeightDeg(px, H, vFov)` = `2·atan( tan(vFov/2) · (px/H) )`（同式，整幅时回到 vFov）。
- `diffMask` 取三通道最大绝对差 `> threshold`。
- `bbox` 返回半开边界与 `count`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/cloud-metrics.test.ts`
Expected: PASS（7 个测试）

- [ ] **Step 5: 写探针脚本 `scripts/cloud-probe.mjs`**

约定（这些是抓帧协议，写进脚本头部注释。**每一条都是踩过的坑**）：

- 连接 `http://127.0.0.1:9222/json/list`，取标题含 `Porco` 的 page target。
- **先钉视口再导航**：`Emulation.setDeviceMetricsOverride { width: 448, height: 797, deviceScaleFactor: 1, mobile: false }`。448×797 来自 `#frame` 的 CSS（`min(100vw,56.25vh)` + `aspect-ratio:9/16`），**不是常量**——不钉死，角换算与所有覆盖率门槛都随窗口漂移，跟"确定性抓帧"直接矛盾。
- 导航 `http://localhost:5173/?qa=frozen&puff=0`（`puff=0` 保证近场云不参与差分）。
- 等待 `window.__porco`；随后 `Runtime.evaluate` 隐藏 HUD：`document.querySelector('#frame .porco-hud').style.visibility='hidden'`。**不藏 HUD 的差分是无效的**——`.porco-hud` 会盖住云的主体（2026-11-14 实测：0.184% vs 真实的 15%）。
- `qa.step(180, 1/60)` 定步；`world.setBgVisible(true)` → `Page.captureScreenshot` → 再 `setBgVisible(false)` → 再截一张。
- **解码与差分在页面内做**（浏览器原生解 PNG，零依赖）：两张 base64 PNG 以 `data:` URL 交给 `Image.decode()`，画进 `OffscreenCanvas` 的 2D 上下文，`getImageData` 后调用度量函数。度量模块用 `await import('/src/cloud-metrics.ts')` 直接取（**dev server 会编译 TS，页面内 import 可用**——本会话已用同一手法验证过 `layoutClouds`）；若将来把探针指向打包产物，则退化为把函数体内联进注入字符串。
- 输出 `artifacts/cloud-probe/<ISO 时间戳>/metrics.json` 与两张 PNG。**字段清单（一次定全，后续任务只加不改名）**：

| 字段 | 用途 | 消费者 |
|---|---|---|
| `viewport` | 实际生效的 448×797 / dsf | 全部任务对账 |
| `coverageSky` / `coverageAll` / `coverageRegion`（`region` 定义见下） | 覆盖率 | Task 4/5/6/7 |
| `bbox`（半开） | 云的紧包围盒 | Task 3/4 |
| `centroidAzDeg` | 标定云的质心方位 | Task 3 |
| `angularWidthDeg` / `angularWidthRatio` | 渲染角宽 / 布局角宽 | Task 3/7 |
| `rowProfile`（每 20 行均值） | 逐行幅值，区分云与全天空泛白 | Task 4 |
| `hfEnergy` | 掩码内 4 邻域绝对差均值 | Task 5 |
| `headingMatrix`（24 朝向 × `{ coverage, visible }`） | 罗盘扫描 | Task 7 |
| `frameP50Ms` | 帧时间 | Task 7 |
| `frameP95Ms` | 帧时间 p95（与 P50 同一采样窗） | Task 7 |

**`region` 口径同样要钉死**：`coverageSky` = 画布内 `y ∈ [0, yHorizon)` 的上半幅，`yHorizon` 取该帧海天线所在行（由 `metrics.json` 记录，不猜）；`coverageAll` = 整块画布；`coverageRegion` = 显式传入的矩形。三个数都写进 JSON，读的人不用反推。

- [ ] **Step 6: 冒烟跑一次，确认能出数**

Run: `npx vite --port 5173` （另开终端；Chrome 需带 `--remote-debugging-port=9222`）
Run: `node scripts/cloud-probe.mjs`
Expected: 生成 `artifacts/cloud-probe/*/metrics.json`；`coverageSky` 为 1–25% 的有限数，`bbox` 命中左边缘条

- [ ] **Step 7: Commit**

```bash
git add src/cloud-metrics.ts src/cloud-metrics.test.ts scripts/cloud-probe.mjs
git commit -m "test(cloud): deterministic capture probe and pure metrics helpers"
```

---

### Task 2: 单云标定台（可强制布局）

**Files:**
- Modify: `src/qa.ts`（新增 `parseBgForce`）
- Modify: `src/world.ts:178-188`（`initWorld` 五参签名 + `BgCumulusLike` + 透传）
- Modify: `src/main.ts:219`（五参实调，`opts` 是第 5 位）
- Modify: `src/bg-cumulus.ts:130`（`opts` 新增 `forceLayout`）
- Test: `src/qa.test.ts`（追加用例）

**Interfaces:**
- Consumes: `CloudLayout`（既有）、`layoutClouds`（既有）
- Produces:
  - `parseBgForce(raw: string | null | undefined): 'single' | null`
  - `initBgCumulus(renderer, opts: { seed: number; sunDir?; quality?; bands?; haze?; forceLayout?: CloudLayout[] })`
  - `initWorld(scene, sunLight?, renderer?, sunDirLive?, opts?)` —— **五参，`opts` 在第 5 位**（`world.ts:178-188`）。`opts` 追加 `bgForceLayout?: CloudLayout[]`，透传给 `initBgCumulus` 的 `forceLayout`。
    ⚠️ 这里写错不会报错：`opts` 掉进 `sunDirLive` 的位置后，`bgForceLayout` 静默丢失，探针永远量不到那朵标定云，而 tsc 全绿。照抄前先数一遍参数位置。

- [ ] **Step 1: 写失败测试**

```ts
// src/qa.test.ts 追加
describe('parseBgForce', () => {
  it('single 才生效', () => {
    expect(parseBgForce('single')).toBe('single');
    expect(parseBgForce('Single')).toBeNull();
    expect(parseBgForce('')).toBeNull();
    expect(parseBgForce(null)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/qa.test.ts -t parseBgForce`
Expected: FAIL — `parseBgForce is not defined`

- [ ] **Step 3: 实现解析与透传**

`qa.ts` 里按既有 `parseBgVisible` 的写法加 `parseBgForce`（严格等值 `'single'`）。`main.ts` 在 `parseBgForce(...) === 'single'` 时构造 `singleCloudLayout(90, 10, 5000, 2000, 600)`，作为 `initWorld` 的 `bgForceLayout` 传入；`world.ts` 原样转给 `initBgCumulus` 的 `forceLayout`。**不要在 `world` 句柄上开新方法** —— 标定用的夹具走构造参数，不进运行时 API。

- [ ] **Step 4: 加单云布局并让探针能选它**

在 `bg-cumulus.ts` 里：`const layouts = opts.forceLayout ?? layoutClouds(opts.seed)`。在 `bg-cumulus.ts` 导出一个测试夹具：

```ts
export function singleCloudLayout(azDeg: number, elevDeg: number, distMetres: number, widthMetres: number, heightMetres: number): CloudLayout[]
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/qa.test.ts src/bg-cumulus.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/qa.ts src/qa.test.ts src/world.ts src/bg-cumulus.ts
git commit -m "feat(cloud): forced single-cloud layout for calibration probes"
```

---

### Task 3: 方位/仰角对齐（用标定台钉住并修）

**Files:**
- Modify: `src/bg-cumulus.ts:365-391`（面→方向）
- Modify: `scripts/cloud-probe.mjs`（加 `centroidAzDeg` / `angularWidthRatio`）
- Test: `src/bg-cumulus.test.ts`（追加投影一致性用例）
- Test: `src/sky-webgpu.test.ts`（门护栏）

**Interfaces:**
- Consumes: `singleCloudLayout`（Task 2）
- Produces: `bakeFaceDirection(face: number, st: { x: number; y: number }): { x: number; y: number; z: number }` —— 把 TSL 里的面→方向公式抽成可单测的纯函数，烘焙侧改为用它生成同样的节点

- [ ] **Step 1: 写失败测试**

```ts
describe('face → direction 与立方图采样约定一致', () => {
  it('+Z 面中心指向 (0,0,1)，+X 面中心指向 (1,0,0)', () => {
    expect(bakeFaceDirection(4, { x: 0, y: 0 })).toEqual({ x: 0, y: 0, z: 1 });
    expect(bakeFaceDirection(0, { x: 0, y: 0 })).toEqual({ x: 1, y: 0, z: 0 });
  });

  it('侧面竖直轴净符号为正：+Z 面上方样本 y>0', () => {
    // 符号链：GL 规范 +Z 面 tc = −y（tc 正方向朝下）；而 WebGPU 附件行 0 在顶，
    // 渲染时的 uv.y 与采样 t 反号。两次取反相消，净结果就是 rd.y 与 st.y 同号。
    // 这条是 6dc9dab 已取证修复的链路（bg-cumulus.ts:382-383「t 轴取反」），
    // 本测试只负责钉住"别再翻回去"。
    expect(bakeFaceDirection(4, { x: 0, y: 0.5 }).y).toBeGreaterThan(0);
  });

  it('六个面中心方向互异且为单位向量', () => {
    const centers = [0, 1, 2, 3, 4, 5].map((f) => bakeFaceDirection(f, { x: 0, y: 0 }));
    for (const d of centers) expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 6);
    const keys = centers.map((d) => `${d.x},${d.y},${d.z}`);
    expect(new Set(keys).size).toBe(6);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/bg-cumulus.test.ts -t "face → direction"`
Expected: FAIL — `bakeFaceDirection is not defined`

- [ ] **Step 3: 加两条回归护栏（源码断言，跟 `sky-moon.test.ts` 同风格）**

```ts
// src/sky-webgpu.test.ts 追加
it('云合成门同时乘住 alpha 与 premultiplied 的源 RGB（关云后不得残留云色）', async () => {
  const src = await readFile(new URL('./sky-webgpu.ts', import.meta.url), 'utf8');
  const gateDecl = src.indexOf('const gate = cloudOnNode.mul(step(0.0, dirNode.y))');
  expect(gateDecl).toBeGreaterThan(-1);
  const body = src.slice(gateDecl, gateDecl + 400);
  expect(body).toContain('cloudS.rgb.mul(gate)');
  expect(body).toContain('skyC.mul(a.oneMinus())');
});

it('地平线以下整片不采云（俯冲时不得把镜像倒影画到海面以上）', async () => {
  const src = await readFile(new URL('./sky-webgpu.ts', import.meta.url), 'utf8');
  expect(src).toContain('cloudOnNode.mul(step(0.0, dirNode.y))');
});

// src/bg-cumulus.test.ts 追加
it('烘焙侧同样在地平线以下 discard，且用链式 .discard()（If 包裹会吞掉整片输出）', async () => {
  const src = await readFile(new URL('./bg-cumulus.ts', import.meta.url), 'utf8');
  expect(src).toMatch(/rd\.y\.lessThan\(0\.002\)\.discard\(\)/);
  expect(src).not.toMatch(/If\(\s*rd\.y\.lessThan/);
});
```

- [ ] **Step 4: 抽出纯函数并接到 TSL**

把 `bg-cumulus.ts:371-391` 的掩码链搬进 `bakeFaceDirection`，TSL 侧用同一组常量生成节点（不复制数字：常量定义为 `FACE_AXIS` 表，两处都读它）。

- [ ] **Step 5: 跑单测确认通过**

Run: `npx vitest run src/bg-cumulus.test.ts src/sky-webgpu.test.ts`
Expected: PASS

- [ ] **Step 6: 探针标定（这一步决定成败）**

用 `?bgforce=single` 跑探针，量渲染云的质心方位。期望：`|azMeasured − 90| ≤ 2`、`angularWidthRatio` ∈ [0.8, 1.2]。

若不符：**只剩一个怀疑点**——`BAKE_FACES` 的面序与 `CubeRenderTarget` 的面序是否同一套（顺序查 `bg-cumulus.ts:529` 的 `BAKE_FACES[Math.floor(cursor / STRIPS_PER_FACE)]` 与 `setRenderTarget(crt, face)` 的 face 编号）。把结论写进提交信息，修完重跑，直到数字进区间。

> ⚠️ **不要去动侧面的竖直轴符号**。`rd.y` 用 `+st.y` 是 `6dc9dab` 取证修复并验证过的结果（`bg-cumulus.ts:382-383` 的「t 轴取反」注释就是那次取证的记录，当时的失败症状是"云全烘在地平线以下、天空侧永远 gate 成 0"）。翻回去会把已修好的链路重新弄坏。

- [ ] **Step 7: Commit**

```bash
git add src/bg-cumulus.ts src/bg-cumulus.test.ts
git commit -m "fix(cloud): face-to-direction conformance with cube sampling convention"
```

---

### Task 4: 全天空泛白（软边 alpha 泄漏）

**Files:**
- Modify: `src/bg-cumulus.ts:405-451`（march 与 alpha 收尾）
- Test: `src/bg-cumulus.test.ts`（追加 `veilGain` 纯函数用例）

**Interfaces:**
- Produces: `veilAlpha(nearSlack: number, texelSlack: number, insideBound: boolean): number` —— 取代内联表达式，`insideBound === false` 时恒为 0。
  （两个入参都是**无量纲的角量**：`nearSlack = nearDistance / tHit`、`texelSlack = 3 / size`。数学上自洽，但名字里带 `Metres` 会骗人，故不这么叫。）

- [ ] **Step 1: 写失败测试**

```ts
describe('软边 alpha 只在本云包围球内成立', () => {
  it('包围球外一律 0（不许整屏泛白）', () => {
    expect(veilAlpha(0.5, 3, false)).toBe(0);
  });
  it('球内按 near/texel 衰减', () => {
    expect(veilAlpha(1.5, 3, true)).toBeCloseTo(0.5, 6);
  });
  it('球内达到或超过 texel 时也是 0', () => {
    expect(veilAlpha(4, 3, true)).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/bg-cumulus.test.ts -t "软边 alpha"`
Expected: FAIL — `veilAlpha is not defined`

- [ ] **Step 3: 实现并在 march 里带上"是否进过包围球"标志**

`bgMap` 的返回值从 `vec3(d, base, scale)` 扩成 `vec4(d, base, scale, inside)`，`inside` 在包围球内分支里 assign 1、外部 assign 0。march 循环每步用 **any-pass** 累积：`insideBound.assign(max(insideBound, info.w))`。

> 这里必须 any-pass 而不是"最后一步胜出"：球内出球（穿球而过但没命中云体）也是一种合法的软边来源，用最后一步会把它切成硬边。字面上它更保守（更容易产生微量 alpha），但配合 Step 5 的"背后云 = 0"验收，泄漏不会回来。

`alpha` 收尾改成 `veilAlpha(near, uTexel, insideBound)`。

- [ ] **Step 4: 跑单测确认通过**

Run: `npx vitest run src/bg-cumulus.test.ts`
Expected: PASS

- [ ] **Step 5: 探针验收**

用 `?bgforce=single` + 一朵在 az 180（相机背后）的云跑探针。期望：`coverageSky === 0`（阈值 12 下零像素）。当前基线请先跑一次记进提交信息。

- [ ] **Step 6: Commit**

```bash
git add src/bg-cumulus.ts src/bg-cumulus.test.ts
git commit -m "fix(cloud): confine soft-edge alpha to the owning bound sphere"
```

---

### Task 5: 内部纹理（大理石/蠕虫状色斑降级）

> **2026-11-14 实测修正**：本任务上一稿把病灶猜成「`lump` 噪声频率太高」、指标用「4 邻域高频能量」。当晚逐条证伪后重写 —— 原指标对真实现象几乎无响应（掩码内 1px 能量 0.549 → 0.544，改了法线采样间距都没动），真正的病灶与判据见下。

**已定位的事实（固定机位 A/B，同一朝向 az≈197、同一朵 mid 云）**

| 调整 | 结果 | 结论 |
|---|---|---|
| `dF1..4` 的 `fine` 1→0（细八度不进法线） | 纹路不变 | 细八度不是主因 |
| `hardEdge` [0.55,0.6] → [0.3,0.8] | 纹路不变、甚至更清楚 | 硬边宽度不是主因 |
| `shadowNearW/FarW` 归零（关自阴影） | 纹路不变 | 自阴影不是主因 |
| march 步长 `max(d·0.5, 30)` → `max(d·0.35, 8)` | 纹路不变（轮廓更碎） | 步进不是主因 |
| **尾段 `mix(uUnder, col, smoothstep(underMix, hgt + light))` 关掉** | **纹路完全消失** | **病灶确认** |
| `underScale` 2.2 → 9（只放宽高度归一化） | 纹路变淡但仍在 | 高度不是唯一驱动，`light` 也在推 |
| `?toon=1` vs `0` | 天空带高频 +47% | toon 只是放大器，不是源头 |

**病灶**：`bg-cumulus.ts` 的 `paintTsl` 尾段——`hgt = (p.y − base) / (scale × underScale)` 与 `light` 相加后，落进 `underMix` 这个窄窗（默认 `[−0.2, 0.5]`），把颜色往最暗的 `uUnder` 混。命中点 `p.y` 来自一颗被 billow 位移过的球堆表面，相邻像素高度差可达上百米 → `hgt` 在窗内反复穿越 → 颜色在 `uUnder` 与 `col` 之间画出等高线状的「蠕虫」。`light` 侧的法线同样来自这个颠簸场，两者叠加把这个窗口变成了可见的斑纹。

**Files:**
- Modify: `src/bg-cumulus.ts:360-362`（`paintTsl` 尾段：`hgt` 与最后的 `mix`）
- Modify: `src/bg-cumulus-paint.ts:34-35`（`underMix` / `underScale`，仅当尾段改法需要新常数时）
- Modify: `scripts/cloud-probe.mjs`（输出**带尺度**的能量谱）
- Test: `src/cloud-metrics.test.ts`（追加 `bandEnergyInMask`）
- Test: `src/bg-cumulus.test.ts`（钉住尾段不再裸用 `p.y` 当高度）

**Interfaces:**
- Produces: `bandEnergyInMask(img: RgbaImage, mask: Uint8Array, width: number, height: number, step: number): number` —— 掩码内、行/列间隔 `step` 的平均绝对差。**`step=1` 不是判据**（该现象在 1px 尺度没有信号），判据取 `step ∈ {4, 8}`。

- [ ] **Step 1: 写失败测试**

```ts
it('bandEnergyInMask：同一幅图在不同间距上的响应不同', () => {
  const flat = solid(16, 16, [100, 100, 100]);
  const mask = new Uint8Array(256).fill(1);
  expect(bandEnergyInMask(flat, mask, 16, 16, 4)).toBe(0);

  // 4px 周期的竖条：step=4 应接近 0，step=2 应有明显响应
  const stripes = solid(16, 16, [0, 0, 0]);
  for (let y = 0; y < 16; y += 1) for (let x = 0; x < 16; x += 1) {
    const v = Math.floor(x / 4) % 2 === 0 ? 200 : 20;
    const i = (y * 16 + x) * 4;
    stripes.data[i] = v; stripes.data[i + 1] = v; stripes.data[i + 2] = v;
  }
  expect(bandEnergyInMask(stripes, mask, 16, 16, 4)).toBeLessThan(1);
  expect(bandEnergyInMask(stripes, mask, 16, 16, 2)).toBeGreaterThan(50);
});

it('尾段不许拿命中点高度当云底混色的唯一输入（源码护栏）', async () => {
  const src = await readFile(new URL('./bg-cumulus.ts', import.meta.url), 'utf8');
  // 允许出现 hgt，但最后那次 mix 必须已经被低通量替换（实现决定形态，此处只钉"不再裸用"）
  expect(src).toMatch(/underLow|smoothedHgt|underTint/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/cloud-metrics.test.ts src/bg-cumulus.test.ts`
Expected: FAIL — `bandEnergyInMask is not defined`

- [ ] **Step 3: 实现 `bandEnergyInMask` 并跑通过**

Run: `npx vitest run src/cloud-metrics.test.ts`
Expected: PASS

- [ ] **Step 4: 记录基线（固定机位）**

打开 `?puff=0`，用本计划 Task 1 的转向程序把朝向停在 az≈197（mid 云在 194.1），隐藏 HUD，取云内部的 `bandEnergyInMask(step=4)` 与 `(step=8)`。写进提交信息。**只在与基线相同的朝向上比较**——换朝向的差异会盖过改动。

- [ ] **Step 5: 改尾段（三选一，但**不是等价的三选一**）**

按 2026-11-14 实测排序（同一机位 A/B）：

| 路径 | 代价 | 实测 / 预判 | 结论 |
|---|---|---|---|
| **A. 低通高度** | 每像素多 2–4 次 `bgMap`（现有 12 次 → +17–33% 烘焙着色） | 未实测；机制对症 | 保住"云底发暗"时选它 |
| **B. 改由竖直法线 `N.y` 驱动** | 零（`N.y` 已在算） | **实测更差**：暗部蠕虫更密，多尺度能量 0.95 → 2.36 | **不要单独用**——`N` 来自同一条颠簸面 |
| **C. 把 `underMix` 窗挪到主值域外** | 零 | 窄窗 × 噪声 = 更多次穿越 = 更锐的等高线 | **只有做完 A 之后**才能拿它做收尾；单独用会加重 |

另测两条，用于界定问题边界：

- **把 billow 从着色探针摘掉**（`bgMap` 加 `detail` 参数、探针传 0）：不加采样，蠕虫**部分**改善但仍存在 → 说明起伏源不止 billow，13 颗球的 `smin` 合并本身就已经够颠。
- **`uUnder` 权重压低 + 窗口放宽**：零成本、零风险、可逆，把"看得见的斑纹"降成"一层很淡的暗调"；代价是云底暗得很含蓄。**若只想先止丑，选它。**（注意：这不是 C 的"挪窗"，是放宽。）

实现取自 A 或上表最后一条，二者都必须满足 Step 6 的判据。

> **2026-11-14 深夜追记：最便宜那条已试过并失败，别重复。**
> 把 `uUnder` 占比封顶到 0.45、窗口放宽容差（`UNDER_TINT` 方案）后实测：
> - **受光区干净了**，但**背光那一瓣的蠕虫仍在**；
> - 把权重压到 0.25，纹路没少，云底却几乎不暗了 —— 变成"用抹平观感换掉症状"。
>
> 结论：**降对比不是修复**，它只是把病灶淹没在低对比里，而低对比本身是观感损失。该改动已完整回滚，未进入代码。**决策：直接走低频驱动（方案 A 的"低频"形态），不要再试降对比。**
>
> 低频驱动的落点（比邻域采样便宜得多）：
> - `uClouds` 里已经存着每朵云的包围球 `(cx, cy, cz, r)`，`bgMap` 内部拿得到 `cl.y` / `cl.w`。
> - 新增一个只做 9 次 `length()` 的小函数 `cloudSpan(p) -> vec2(boundBottom, boundHeight)`（不进 puff 循环，成本远低于再加 4 次 `bgMap`）。
> - 尾段改成 `hgtSmooth = (p.y − boundBottom) / (boundHeight × k)`：`p.y` 的 ±50 m 抖动摊在 ~11 km 的包围球尺度上 → 等价噪声趋零，等高线消失，而"底的云更暗、顶更亮"的语义**原样保住**（甚至比参考更物理：暗的是整朵云的底，不是某颗球的底）。
> - 验收同 Step 6。

- [ ] **Step 6: 复测 + 目视 A/B 并 Commit**

判据：`bandEnergyInMask(step=4)` 相对基线 **下降 ≥40%**；`coverageSky` 变化 ≤10%；固定机位放大 4× 目视无蠕虫，且云底仍能看出偏暗。

```bash
git add src/bg-cumulus.ts src/bg-cumulus-paint.ts src/cloud-metrics.ts src/cloud-metrics.test.ts src/bg-cumulus.test.ts
git commit -m "fix(cloud): stop the under-base tint from contouring on the noisy surface height"
```

---

### Task 6: 散落（仰角一等参数 + 长宽比分层）

**Files:**
- Modify: `src/bg-cumulus-layout.ts:14-48`（常量）、`:187-313`（`buildOnce`）
- Test: `src/bg-cumulus-layout.test.ts`

**Interfaces:**
- Consumes: 既有 `CloudLayout`
- Produces:
  - `CloudLayout` 新增 `elevDeg: number`（云体中点的仰角，度）
  - 若干新常量：`ELEV_RANGE`、`ASPECT_RANGE`、`PUFF_RADIUS_SKEW`

- [ ] **Step 1: 写失败测试**

```ts
describe('散落：仰角与长宽比分层', () => {
  it('seed 7 的布局里至少一朵云仰角 ≥ 25°', () => {
    const cs = layoutClouds(7);
    expect(cs.some((c) => c.elevDeg >= 25)).toBe(true);
  });

  it('仰角落在 [3, 45] 且与 base/distance 自洽', () => {
    for (const c of layoutClouds(7)) {
      expect(c.elevDeg).toBeGreaterThanOrEqual(3);
      expect(c.elevDeg).toBeLessThanOrEqual(45);
      const derived = (Math.atan2(c.base + c.heightMetres / 2 - 70, c.distanceMetres) * 180) / Math.PI;
      expect(Math.abs(derived - c.elevDeg)).toBeLessThan(1);
    }
  });

  it('长宽比不全挤在两端：至少一朵 ∈ [2, 3]、至少一朵 ∈ [1.5, 2]', () => {
    const aspects = layoutClouds(7).map((c) => c.widthMetres / c.heightMetres);
    expect(aspects.some((a) => a >= 2 && a <= 3)).toBe(true);
    expect(aspects.some((a) => a >= 1.5 && a < 2)).toBe(true);
  });

  it('边到边空档全部落在 [10, 45]（这次量边，不是量中心）', () => {
    const cs = [...layoutClouds(7)].sort((a, b) => a.azimuthDeg - b.azimuthDeg);
    for (let i = 0; i < cs.length; i += 1) {
      const a = cs[i];
      const b = cs[(i + 1) % cs.length];
      const span = b.azimuthDeg - a.azimuthDeg + (b.azimuthDeg <= a.azimuthDeg ? 360 : 0);
      const hwA = (Math.atan2(a.widthMetres / 2, a.distanceMetres) * 180) / Math.PI;
      const hwB = (Math.atan2(b.widthMetres / 2, b.distanceMetres) * 180) / Math.PI;
      const edgeGap = span - hwA - hwB;
      expect(edgeGap).toBeGreaterThanOrEqual(10);
      expect(edgeGap).toBeLessThanOrEqual(45);
    }
  });

  it('确定性：同 seed 两次调用逐字节相同', () => {
    expect(JSON.stringify(layoutClouds(7))).toBe(JSON.stringify(layoutClouds(7)));
  });

  it('罗盘 24 个 15° 扇区里，云覆盖 <5% 的扇区 ≤ 4（Task 7 的门就建在这上面）', () => {
    const cs = layoutClouds(7);
    const halfWidthDeg = (c: (typeof cs)[number]): number =>
      (Math.atan2(c.widthMetres / 2, c.distanceMetres) * 180) / Math.PI;
    const covered = (deg: number): boolean =>
      cs.some((c) => {
        const d = (((deg - c.azimuthDeg + 540) % 360) - 180);
        return Math.abs(d) <= halfWidthDeg(c);
      });
    const emptySectors = Array.from({ length: 24 }, (_, i) => {
      const center = i * 15;
      let hit = 0;
      for (let k = 0; k < 150; k += 1) if (covered(center - 7.5 + k * 0.1)) hit += 0.1;
      return hit < 0.75;
    }).filter(Boolean).length;
    expect(emptySectors).toBeLessThanOrEqual(4);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/bg-cumulus-layout.test.ts`
Expected: FAIL — `elevDeg` 不存在 / 仰角约束不满足

- [ ] **Step 3: 改 `buildOnce`：仰角先抽，`base` 反解**

每朵云的 `Spec` 增加 `elevDeg`，按 kind 从 `ELEV_RANGE_BY_KIND` 抽（本任务阶段只有两种 kind，先按 `tower: [8, 25]`、`mid: [3, 45]` 取值——`mid` 要能上到 25° 以上，Task 7 的 `altocumulus ≥ 30°` 用例才可能先立住），再由 `base = 70 + dist·tan(elevDeg) − height/2` 反解，最后把 `elevDeg` 写回 `CloudLayout`。抽 puff 半径时改成幂律 `rMax·(0.3 + 0.7·rand()^PUFF_RADIUS_SKEW)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/bg-cumulus-layout.test.ts`
Expected: PASS

- [ ] **Step 5: 探针确认没有把云搬到看不见的地方**

Run: `node scripts/cloud-probe.mjs`
期望：`coverageSky` 不下降（与 Task 5 的复测值相比 ±10% 内）。若下降，先查 `layoutWindow` 的 `minBase`/`maxDistance` 是否随高仰角云变得过大（`tEnd` 涨 → 步长预算被稀释）。

- [ ] **Step 6: Commit**

```bash
git add src/bg-cumulus-layout.ts src/bg-cumulus-layout.test.ts
git commit -m "feat(cloud): elevation as a first-class layout parameter with aspect tiers"
```

---

### Task 7: 形状变体（不涨数量的多样性）

**Files:**
- Modify: `src/bg-cumulus-layout.ts`（新增 kind 与参数表）
- Modify: `scripts/cloud-probe.mjs`（`--url` / `--viewport` / 24 朝向矩阵）
- Test: `src/bg-cumulus-layout.test.ts`（追加 kind 分布用例）

**Interfaces:**
- Produces: `type CloudKind = 'humilis' | 'mediocris' | 'congestus' | 'castellanus' | 'altocumulus'`
- `CloudLayout.kind` 由 `'tower' | 'mid'` 拓宽为 `CloudKind`

> **区间一律闭区间**：表里写 `1.5–2` 就是 `[1.5, 2]`，测试用 `toBeGreaterThanOrEqual(1.5)` + `toBeLessThanOrEqual(2)`，不要混用 `toBeLessThan(2)` —— 开闭不一致会让"表对"和"测试过"变成两回事。
>
> **RED 时的裁决规则**：`seed 7` 是 `world.ts:222` 钉死的生产种子，**不许改**。测试不过就调表（区间/权重），不调 seed。

- [ ] **Step 1: 写失败测试**

```ts
describe('变体：形状多样性，数量与预算不变', () => {
  it('seed 7 至少出现 3 种 kind', () => {
    expect(new Set(layoutClouds(7).map((c) => c.kind)).size).toBeGreaterThanOrEqual(3);
  });
  it('每朵云 puff 数 ≤ 16、云数 ≤ 9（AMD 编译预算）', () => {
    const cs = layoutClouds(7);
    expect(cs.length).toBeLessThanOrEqual(9);
    for (const c of cs) expect(c.puffs.length).toBeLessThanOrEqual(16);
  });
  it('变体各有自己的长宽比与仰角区间（闭区间，与表一致）', () => {
    for (const c of layoutClouds(7)) {
      const aspect = c.widthMetres / c.heightMetres;
      if (c.kind === 'congestus') {
        expect(aspect).toBeGreaterThanOrEqual(1.5);
        expect(aspect).toBeLessThanOrEqual(2);
      }
      if (c.kind === 'humilis') {
        expect(aspect).toBeGreaterThanOrEqual(3);
        expect(aspect).toBeLessThanOrEqual(5);
      }
      if (c.kind === 'altocumulus') expect(c.elevDeg).toBeGreaterThanOrEqual(30);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/bg-cumulus-layout.test.ts -t 变体`
Expected: FAIL

- [ ] **Step 3: 实现 kind 表**

五种 kind 的 puff 数、长宽比区间、仰角区间按下表取值（**全闭区间**），`cumulus()` 的调用参数由表驱动；`tower`/`mid` 保留为 `congestus`/`mediocris` 的别名以免下游类型报错。

| kind | puff | 长宽比（闭） | 仰角（闭） |
|---|---|---|---|
| `humilis` | 8–10 | [3, 5] | [3, 8]° |
| `mediocris` | 11–14 | [2.5, 4] | [8, 16]° |
| `congestus` | 14–16 | [1.5, 2] | [10, 25]° |
| `castellanus` | 12–16 | [2.5, 3.5] | [15, 30]° |
| `altocumulus` | 6–8 | [3.5, 4.5] | [30, 45]° |

> Task 6 的两条长宽比断言（`[2,3]` 与 `[1.5,2]`）在这一步之后必须仍然成立：把 `mediocris` 的上半段压在 `[2.5, 4]` 里保证前者，`congestus` 的 `[1.5, 2]` 保证后者。若 RED，先看是不是 kind 抽样权重把它们抽没了 —— 调权重，不调 seed。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/bg-cumulus-layout.test.ts`
Expected: PASS

- [ ] **Step 5: 全量绿 + 探针矩阵终点验收**

Run: `npx tsc --noEmit && npx vitest run`

`scripts/cloud-probe.mjs` 需要支持 `--url` 与 `--viewport`，按下表跑五组，结果全部写进 `metrics.json`：

| 组 | 调用 | 通过条件 |
|---|---|---|
| 稳态 | 默认 `?qa=frozen&puff=0` | `coverageSky ≥ 25%`（region 口径见 Task 1）；`emptySectors ≤ 4`（定义见下）；标定云方位误差 ≤ 2°、`angularWidthRatio` ∈ 0.8–1.2；`frameP50Ms ≤ 16.7`、`frameP95Ms ≤ 33.3`（双口径，接 baked 计划 Task 6 遗留的正式门——p95 放宽到两条 vsync 是容忍条带追平窗口的瞬时尖峰） |
| 空场 | `?bgforce=single`（云在 az 180，相机背后） | `coverageSky === 0` |
| 精细档 | `?bgq=2048` | 指标有限且非零；首帧不超时（探针 30 s 内出数） |
| 夜间 | `?tod=2` 与 `?tod=20` | 云掩码内无纯黑（所有通道 0）与纯白（所有通道 255）像素 |
| 缩放 | `--viewport 900x600` 与 `--viewport 600x1000` | 同一朵云的 `centroidAzDeg` 与 `angularWidthDeg` 与稳态组相差 ≤ 10%，且掩码不出现左右镜像或重复云 |

**`emptySectors` 的定义（必须钉死，否则门是橡皮筋）**

罗盘 24 个**扇区**（每 15°，中心 0°/15°/…/345°）。某扇区的**云角覆盖** = 该 15° 区间内被任一朵云的角跨度覆盖的角度总量（由 `layoutClouds` 的方位角与 `atan(width/2 / dist)` 半宽算出，**纯布局层、确定性、不经过渲染**）。`emptySectors` = 角覆盖 < 0.75°（即 < 5%）的扇区数。

判定基线（seed 7 实测，本计划写作时算过）：总角覆盖 240.8°，空档总量 119.2°、7 档均 17.0°；点采样口径只有 **15/24**，扇区口径是 **23/24**。门设在 20 时，口径不同就差出一个"过/不过"——所以这里只认扇区口径，且以 `emptySectors ≤ 4` 表达（等价于 ≥20/24，但不受朝向网格起点影响）。

**渲染层只验忠实度，不验绝对数**：探针另有 6 个抽检朝向，要求渲染覆盖率与同朝向的布局预测覆盖率相差 ≤ 20%。这样"布局好不好"和"管线准不准"分开判，改散落时不会和渲染 bug 互相甩锅。

- [ ] **Step 6: 重烘窗口不闪空**

在探针里加一步：从出生起连续 `qa.step(2, 1/60)` 直到累计位移 > 300 m（必然跨过一次 `REBAKE_METRES = 250`），每一步记录 `coverageSky`。期望：**最小值 ≥ 稳态值的 50%**。若跌破，问题在 `recentre` 的 `stale = TOTAL_STRIPS` 重置窗口——烘焙未完成前应继续用旧立方图，而不是清空。

- [ ] **Step 7: Commit**

```bash
git add src/bg-cumulus-layout.ts src/bg-cumulus-layout.test.ts
git commit -m "feat(cloud): five cumulus variants within the 9x16 compile budget"
```

---

## 审核修正记录（2026-11-14 第二稿）

上一稿经外部审核，逐条对过源码后的处置：

| 项 | 处置 | 落点 |
|---|---|---|
| H1 `initWorld` 五参 | 采纳。实签名 `initWorld(scene, sunLight?, renderer?, sunDirLive?, opts?)`（`world.ts:178-188`），文档原写四参会让 `opts` 掉进 `sunDirLive` 且**不报错** | Task 2 Files + Interfaces（带警告块） |
| H2 视口未钉 | 采纳。`448/797` 在 `src/`、`index.html` 里 grep 不到，是 `#frame` 的 CSS 运行时值 | Global Constraints + Task 1 Step 5（`Emulation.setDeviceMetricsOverride`） |
| H3 24 朝向口径未钉 | 采纳，并补算了实测值：seed 7 是 **7 朵**不是 9 朵；总覆盖 240.8°、空档 119.2°、7 档均 **17.0°**；点采样 **15/24**、扇区口径 **23/24**——门设 20 时口径直接决定生死 | Task 1（region 口径）+ Task 6 新测试 + Task 7 Step 5（`emptySectors ≤ 4` 定义） |
| M1 Review Focus #2 零覆盖 | 采纳。补两条源码断言：天空侧 `step(0.0, dirNode.y)`、烘焙侧 `rd.y.lessThan(0.002).discard()` 且必须是链式形式 | Review Focus 逐条加了"→ 落点" + Task 3 Step 3 |
| M2 metrics 字段与探针 Files 脱节 | 采纳。字段清单一次定全（含 `centroidAzDeg`/`hfEnergy`/`headingMatrix`/`frameP50Ms`），Task 3/5/7 的 Files 补上 `scripts/cloud-probe.mjs` | Task 1 Step 5 表格 + 各任务 Files |
| M3 GL 约定注释错误 | 采纳。GL 规范 +Z 面 `tc = −y`（tc 正方向朝下），原注释写反；**断言本身不动**，删掉怀疑点 (b) 并加显式禁令："不要翻侧面竖直轴，`6dc9dab` 已取证修好" | Task 3 Step 1/6 |
| M4 基线 708 | 采纳。写作时确为 708，HUD 折叠 +7 后现为 715，已改为 715 并注明来源 | Global Constraints |
| M5 区间开闭与 seed 可达性 | 采纳。全表闭区间，断言改 `>=`/`<=`；补裁决规则：`seed 7` 是 `world.ts:222` 的生产种子，**调表不调 seed** | Task 7 提示块 + Step 1/3 |
| M6 缩放判据弱 | 采纳。改判 `centroidAzDeg` + `angularWidthDeg` 的**角量**一致性（≤10%）并查镜像/重复，不再拿像素覆盖率当代理 | Task 7 Step 5 表 |
| 低危：近轴近似 | 采纳。改用 gnomonic 精确式 `2·atan(tan(vFov/2)·px/H)`；测试期望值从 18 改为 **18.43**（224px 上半幅） | Task 1 Interfaces/Step 1/Step 3 |
| 低危：`bbox` 与 `region` 语义不一 | 采纳。全部矩形统一半开 `[x0,x1)`，`bbox` 返回值同步改，测试期望 `x1=6,y1=7` | Task 1 Interfaces/Step 1/3 |
| 低危：`veilAlpha` 参数名 | 采纳。改名 `nearSlack` / `texelSlack`（无量纲），注释写明传入的是角量 | Task 4 Interfaces |
| 低危：`insideBound` "后者胜出" | 采纳改为 any-pass 累积（`max(insideBound, info.w)`），并写明取舍理由 | Task 4 Step 3 |
| 低危：测试名"正交"名实不符 | 采纳。改名"六个面中心方向互异且为单位向量" | Task 3 Step 1 |
| 低危：探针需内联度量函数 | **不采纳**（技术上不成立）。dev server 会编译 TS，页面内 `await import('/src/cloud-metrics.ts')` 直接可用——本会话已用同一手法在页面里成功 import 过 `/src/bg-cumulus-layout.ts` 并调用 `layoutClouds(7)`。已在 Task 1 Step 5 写明该结论并保留"若指向打包产物则退化为内联"的退路 | Task 1 Step 5 |

> **执行前审计补记（2026-11-14 深夜，主线上实测）**：真实基线 **718** 非 715——23:25 同批提交里 `3b525a9`（PAINT_CONSTANTS 对照）在 HUD +7 之上再 +3，上表 M4 只记了前者；Global Constraints 已改为 718。代码锚点（`world.ts:178-188` 五参、`world.ts:222` seed 7、`main.ts:219` 五参实调、`bg-cumulus.ts:130/380-385`、常量 9×16/250/40、`bg-cumulus-layout.ts:14/187`、qa 钩子）全部复验命中；工作树干净，HEAD 即本计划提交。

## 验收口径（给复核者）

- **"更好看"必须落成数字**：每个任务的收尾都跑 `node scripts/cloud-probe.mjs`，把 `metrics.json` 的关键字段抄进提交信息。没有数字的"看起来好了"一律不算通过。
- **三个已知陷阱写进探针的头部注释**：抓帧必须隐藏 `.porco-hud`（否则差分被遮成 0.184%）；视口必须 `Emulation.setDeviceMetricsOverride` 钉死 448×797（否则角换算随窗口漂移）；贴着画面边缘的云按"被裁切"处理，角宽只对完整落在画幅内的云计分。
- **失败即停**：任何一步的探针指标不达目标，不要继续下一个任务 —— 后面的散落/变体都建立在同一把尺子上。
