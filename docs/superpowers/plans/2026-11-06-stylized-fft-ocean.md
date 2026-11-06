# 风格化 FFT 海面（无限世界）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用「世界坐标取模的 FFT 位移场 + 同心方环几何 + 四档平涂」重建海面，在沿 -Z 无界飞行下不重复、不滑动、不闪，且只跑 WebGPU。

**Architecture:** 位移场是世界锚定的周期函数（两谱频段不相交：C0 [128, 1024] m、C1 [32, 128] m，LCM 3072 m），按 `mod(worldXZ, L)` 采样，相位演化 `h̃₀·e^{iωt}` 每帧在首个 compute pass 注入 `t`（全场唯一时间入口）；几何是四条同心方环（≈7.5k 三角形），按每环 `mipLod` 低通采样，网格连续平移、**不需要 snapOrigin**；着色只由 C0 高度驱动的四档色带 + 复用天穹函数做反射；泡沫来自**求和后**的 Jacobian，半分辨率一次算完。世界总装仍走 `src/world.ts`，海自己管取模与 tow，不进 `far-field.ts`。

**Tech Stack:** TypeScript + Vite + three 0.186.0（`WebGPURenderer` + `three/tsl` compute）+ vitest。

**Spec:** 无独立 spec。本 plan 的需求来源是 2026-11-06 的 Technical Artist 分析与主人的三条决定（① 不要 WebGL 回退 ② 风格化 FFT + 无限世界 ③ 先建场与测量、再反解配色）。**所有推测集中在「待确认假设」，执行前必须逐条过。**

## 待确认假设（执行前主人逐条点头）

1. **「不要回退」= 删掉 WebGL2 兜底，WebGPU 不可用时直接报错。** 若只是想「不再为回退维护双路径」，Task 1 可以退化成保留 `forceWebGL` 但不加分支。
2. **风格化 = 四档硬边平涂 + 金色太阳路**，不做 caustics / 水下 / 折射（沿用已删除 spec 的口径）。
3. **配色走「反解」不走「先物理后调」**：band 颜色由测出的覆盖率 + `solve-ramp.py` 反解 NeutralToneMapping 得到，不在线性空间手调。
4. **泡沫不存历史**（瞬时泡沫）。若后面要浪冠拖尾，另开任务加相机锚定 RT。
5. **细节级不用 FFT**，用 4 m 重复法线贴图 + 足迹滤波。
6. **太阳可动 = 限制在黄昏带 3°–15°**（Task 7）。理由是 `bloomThreshold` 0.82 只在那个仰角带里量过，超出这个带必须重做整套亮度表。若要全天候太阳，Task 7 得先拆成「量化管线」和「放开仰角」两步。
7. **「物理 → 感知空间量化」的天空不在本计划内。** 本计划仍用四站手写 ramp；Task 7 只动日盘、辉光和太阳方向。把 `SKY_STOPS` 换成物理采样是另一份计划，否则这个 plan 会从 12 个 Task 涨到 16 个。
8. **近场全细节几何半径 128 m（RINGS 表重排）。** 原表（cell 6.4/25.6/128/300，segs 40/50/25/2）在任何一致口径下都推不通：R0 的外径/cell/格数互相矛盾（span 512 需 80 格，span 256 需 cell 12.8），R3 的 `segs=2` 连 300 m 带宽都盖不住，且 `segs²×2` 直算 9458 会挂掉自己 `< 9000` 的测试。重排依据：预算 < 9000 + 采样规则 `cell ≤ 0.205·λ`（≈4.9 采样/波长）+ 位移带下限 32 m。全细节区每扩大一倍，三角形按平方增长——要更大就得另立预算。

## Global Constraints

- three **0.186.0**；只用 TSL，不写 GLSL，不写 `ShaderMaterial` / `onBeforeCompile`。
- 除 `.test.ts` 外**不得静态** `import 'three/webgpu' | 'three/tsl'`，一律 `await import()`。
- **WebGPU only**：不出现 `forceWebGL`、不出现经典 `WebGLRenderer` 兜底；初始化失败直接 throw。
- 竖屏 720×1280；`camera.far = 2000`；天穹半径 800、`depthWrite = false`、`renderOrder = -1000`。
- `TONE_MAPPING = { mode: 'neutral', exposure: 1.0 }`；bloom 阈值 高 0.82 / 低 0.85。
- 海材质 **必须** `fog = false`（`scene.fog` 是 `#c96a7a` 60–700，与地平线 `#ff9a5a` 不同色）。
- `SEA_PALETTE.haze === SKY_PALETTE.horizon` 是硬契约，单测钉住。
- `SUN_POSITION = [60, 35, -280]` 是**默认**太阳；`SUN_DIRECTION` 归一化，默认仰角 6.97°。运行时仰角钳制在 **3°–15°**（`DUSK_BAND`，Task 7）。
- 角预算 `CANONICAL_RAD_PER_PIXEL = 6.014e-4`（= 2tan(30°)/1920）。
- 级联 tile **1024 / 192 m**，N = 256，`LCM = 3072 m`；频段不相交：**C0 = [128, 1024] m、C1 = [32, 128] m**，单一分界波数 `2π / BAND_SPLIT_METRES`，`BAND_SPLIT_METRES = 128`。
- 几何环 cell **6.4 / 25.6 / 128 / 200 m**，每环 `mipLod 0 / 3 / 5 / 5`、频段下限 `floorMetres 32 / 128 / 640 / 1024`；hole 剔除后总三角形 **7496**。R0 采 C0+C1，R1–R3 只采 C0。
- 几何位移带下限 **32 m = 4.878 × R0.cell**（≈4.9 采样/波长）；更短波由细节法线贴图承担。
- **CHOPPINESS = 0.8**（Tessendorf χ；单模符号判据：正 χ 压缩波峰）。
- 谱生产值：`windSpeed = 9 m/s`、`windDirRad = 0.212`（≈12°，太阳方位，对齐太阳路）、`seed = 20261106`、`PHILLIPS_A = 1.0`、`SPREAD_EXP = 1`、`ℓ = tile/100`；**DC 与 Nyquist 自共轭单元显式置零**。
- **不使用 `snapOrigin`**；网格连续平移，位移按世界坐标取模求值。
- 帧间隔 ≤ 33.3 ms（移动端档）；draw call 只许减不许增。
- 每个 Task 单独 commit，英文 conventional 风格。

## Review Focus

1. **太阳路碎成闪点**：相机 7 m 掠海、太阳仰角 6.97°，镜面反射点在 **57 m**，细节法线最细纹素是 0.47 px——不做足迹滤波，整条金路会变成噪点。归属 Task 8 的 `detailWeight()`。
2. **飞远之后接缝/抖动**：fp32 在 10⁶ m 处 ulp = 0.0625 m，rebase 量子必须是 `LCM` 的整数倍，否则水面整体跳一下。归属 Task 5 的 `REBASE_QUANTUM`。
3. **FOV kick 与 DPR 变化**：垂直 fov 从 60 到 69、DPR 变化都会改角预算，级联死亡距离判据随之失效——按 60°/1920 定的表在 69° 下会露出重复。归属 Task 2 + Task 5 的 `cascadeIsValid`。
4. **冻结帧不可复现**：`?qa=frozen` 下 `dt` 为 0，FFT 必须用累计 `elapsed`，用墙钟则两次抓帧不同。归属 Task 11。
5. **地平线色缝**：海若漏设 `fog = false`，远水收敛到紫红、天空收敛到橙，出现一条全宽色缝。归属 Task 8 的材质断言。

---

### Task 1: WebGPU-only 化（删回退）

**Files:**
- Modify: `src/renderer.ts`（整文件重写，95 → ~30 行）
- Modify: `src/main.ts:21,109-111,132-133,169,187,194-198`
- Modify: `src/game.ts:29,402`（删 `Backend`）
- Modify: `src/module-graph.test.ts`（守卫理由改写，断言保留）
- Test: `src/renderer.test.ts`

**Interfaces:**
- Produces: `createRenderer(canvas: HTMLCanvasElement): Promise<{ renderer: any }>`；`TONE_MAPPING` / `applyToneMapping` 原样保留。
- Consumes: 无。

- [ ] **Step 1: 写失败测试**

在 `src/renderer.test.ts` 追加源码扫描（照 `module-graph.test.ts` 的 `import.meta.glob(..., { query: '?raw' })` 写法）：

```ts
it('has no WebGL fallback left', () => {
  const src = sources['./renderer.ts'];
  expect(src).not.toMatch(/forceWebGL/);
  expect(src).not.toMatch(/WebGLRenderer/);
  expect(src).not.toMatch(/postSupported/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/renderer.test.ts`
Expected: FAIL —— 三处 `toMatch` 各命中一次

- [ ] **Step 3: 重写 `src/renderer.ts`**

删 `Backend`、`forcedBackend`、`postSupported`、`forceWebGL`、`WebGLRenderer` 兜底。新签名：

```ts
export async function createRenderer(canvas: HTMLCanvasElement): Promise<{ renderer: any }>
```

内部：`await import('three/webgpu')` → `new WebGPURenderer({ canvas, antialias: true })` → `await renderer.init()` → `setPixelRatio(min(dpr,2))` → `applyToneMapping` → 断言 `renderer.backend.isWebGPUBackend === true`，否则 `throw new Error('WebGPU backend unavailable')`。

- [ ] **Step 4: 修 `main.ts` / `game.ts` 接线**

删 `backend` 变量、`postSupported` 变量与 `usePost(...) && postSupported` 的守卫（改成 `usePost(...)`）。`setStatus` 与 `__porco` 里的 `backend` 字段删掉；`describe()` 同步删 `backend`。`game.ts` 删 `Backend` 类型与 `GameOptions.backend`。

- [ ] **Step 5: 跑全量闸门**

Run: `npx tsc --noEmit && npx vitest run && node scripts/smoke.mjs`
Expected: tsc exit 0；vitest 全绿；`smoke ok`

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor: drop the WebGL2 fallback, WebGPU only"
```

---

### Task 2: 角预算纯函数

**Files:**
- Create: `src/view-budget.ts`
- Test: `src/view-budget.test.ts`

**Interfaces:**
- Produces: `CANONICAL_RAD_PER_PIXEL: number`、`perPixelRadians(fovDeg: number, bufferHeightPx: number): number`（非法输入返回 `NaN`）。
- Consumes: 无。

- [ ] **Step 1: 写失败测试**

```ts
expect(perPixelRadians(60, 1920)).toBeCloseTo(6.014e-4, 9);
expect(perPixelRadians(69, 1920)).toBeGreaterThan(perPixelRadians(60, 1920));
expect(perPixelRadians(60, 2880)).toBeLessThan(perPixelRadians(60, 1920));
expect(Number.isNaN(perPixelRadians(Number.NaN, 1920))).toBe(true);
expect(Number.isNaN(perPixelRadians(60, 0))).toBe(true);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/view-budget.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

`perPixelRadians = (2 * Math.tan(fovDeg * Math.PI / 360)) / bufferHeightPx`；`fovDeg` 或 `bufferHeightPx` 非有限/≤0 时返回 `NaN`。`CANONICAL_RAD_PER_PIXEL = perPixelRadians(60, 1920)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/view-budget.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/view-budget.ts src/view-budget.test.ts && git commit -m "feat(sea): add the per-frame angular budget as a pure function"
```

---

### Task 3: 频谱与 CPU IFFT 参考实现

**Files:**
- Create: `src/sea/spectrum.ts`
- Create: `src/sea/fft-cpu.ts`
- Test: `src/sea/spectrum.test.ts`、`src/sea/fft-cpu.test.ts`

**Interfaces:**
- Produces: `dispersion(k: number, g?: number): number`；`phillips(kx, kz, windSpeed, windDirRad, tileMetres): number`；`buildSpectrum(opts: SpectrumOpts): Float32Array`（`[re, im]` 交织，N²）；`ifft2Cpu(re: Float32Array, im: Float32Array, N: number): { re, im }`。
- `interface SpectrumOpts { n: number; tileMetres: number; bandMetres: readonly [number, number]; windSpeed: number; windDirRad: number; seed: number }`。窗口按**波数**切：C0 保留 `|k| ≤ 2π/128`，C1 保留 `2π/128 < |k| ≤ 2π/32`——单一分界波数，构造上不相交。生产值见 Global Constraints。
- Consumes: 无。

- [ ] **Step 1: 写失败测试**

`fft-cpu.test.ts`：对 N = 8 造单模 `exp(i k·x)`，断言 IFFT 回来是同一个模、相位符号正确；`Parseval`：`sum|f|² === N² * sum|F|²`（相对误差 < 1e-6）；Hermitian 输入返回**实数**（虚部最大绝对值 < 1e-6）。
`spectrum.test.ts`：`dispersion(k) === sqrt(9.81 * k)`；`phillips` 在 `k=0` 返回 0；同 seed 两次 `buildSpectrum` 深相等；**DC 与 Nyquist 行列全零**；band 外模式全零（探针：λ=96 m 的模只出现在 C1 谱、λ=128 m 的模只出现在 C0 谱）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/sea`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

`ifft2Cpu` 用直接 DFT（N ≤ 32，只作 oracle，不进生产路径），逆变换符号 `exp(+i2π n·j/N)`。`buildSpectrum` 用 Phillips 谱 + 固定 seed 的 mulberry32，生成 Hermitian 对；**先显式置零 DC 与 Nyquist 行列再配共轭**（偶数 N 的 Nyquist 自共轭规则与内部模不同，置零最简且风格化无损），最后按 `bandMetres` 的波数窗保留/清零。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/sea`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sea/spectrum.ts src/sea/fft-cpu.ts src/sea/*.test.ts && git commit -m "feat(sea): spectral coefficients and a CPU IFFT oracle"
```

---

### Task 4: GPU IFFT（TSL compute）

**Files:**
- Create: `src/sea/fft-gpu.ts`
- Test: `src/sea/fft-gpu.test.ts`（只测纯调度计划）

**Interfaces:**
- Produces: `fftPasses(N: number): number`（每轴 `log2(N)`，两轴合计）、`fftBufferBytes(N: number): number`（`N*N*2*4`）、`createIfft(renderer, opts: { n: number; tileMetres: number }): IfftHandle`。
- `interface IfftHandle { upload(h0: { re: Float32Array; im: Float32Array }): Promise<void>; compute(t: number): Promise<void>; readonly height: StorageTexture; readonly chop: StorageTexture; readonly slope: StorageTexture; readonly jacobian: StorageTexture; dispose(): void }`
- 通道契约：`height` R = h；`chop` RG = (Dx, Dz)；`slope` RG = (dh/dx, dh/dz)；`jacobian` RGB = (dxx, dzz, dxz)——水平位移偏导（dzx ≡ dxz）。`slope` 与 `jacobian` 分别是 Task 8 法线与 Task 9 泡沫的唯一来源。
- Consumes: Task 3 的约定（符号、归一化、中心索引修正）与 `dispersion`。

- [ ] **Step 1: 写失败测试**

```ts
expect(fftPasses(256)).toBe(16);          // 2 axes * log2(256)
expect(fftBufferBytes(256)).toBe(256 * 256 * 2 * 4);
expect(() => fftPasses(192)).toThrow();   // 非 2 的幂
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/sea/fft-gpu.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

`createIfft` 动态 `await import('three/webgpu')` + `three/tsl`。**相位演化打头**：`h̃(k,t) = h̃₀(k)·e^{iωt} + h̃₀*(−k)·e^{−iωt}`，`ω = dispersion(|k|)`，`k` 由纹理坐标按 tile 推出（中心索引修正），`t` 进 uniform——**这是全场唯一的时间入口**。8 个实场（h、Dx、Dz、dHx、dHz、dxx、dzz、dxz）都是 `h̃(k,t)` 乘一个逐模系数，两两打包成 4 张复纹理（h+Dx、Dz+dHx、dHz+dxx、dzz+dxz），各跑每轴 Stockham 蝶形，ping-pong 两张 `StorageTexture`（`NoColorSpace`、无 mip），每轴 log2(N) 次 dispatch，靠 ping-pong 落回首张缓冲；末尾一个打包 pass 写出 4 张输出纹理。输出另复制一份**带完整 mip 链的可采样纹理**（StorageTexture 不可直接过滤采样；一次 blit + generateMips），供 Task 8 按 `mipLod` 采样。`N` 非 2 的幂时 throw。

- [ ] **Step 4: 加运行时自检钩子**

在 `fft-gpu.ts` 导出 `selfCheck(renderer, N = 16): Promise<number>`：`compute(0)` 后回读 `height` 与 `ifft2Cpu(h0)` 逐元素比，返回最大绝对误差——**t=0 时相位演化必须恒等退化为 IFFT(h0)**，同时钉住时间约定；再以 `t = 5` 重跑，断言与 `t = 0` 结果不同（海在动）。**不进单测**（node 无 GPU），由 `__porco.qa` 手动调用。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/sea/fft-gpu.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/sea/fft-gpu.ts src/sea/fft-gpu.test.ts && git commit -m "feat(sea): GPU IFFT via TSL compute with a runtime self-check"
```

---

### Task 5: 级联表、几何环表与 rebase 量子

**Files:**
- Create: `src/sea/cascades.ts`
- Create: `src/sea/rings.ts`
- Test: `src/sea/cascades.test.ts`、`src/sea/rings.test.ts`

**Interfaces:**
- Produces:
  - `CASCADES: readonly { name, tileMetres, n, amplitudePeak, bandMetres }[]` —— 1024/256/0.45/[128, 1024]、192/256/0.10/[32, 128]（频段不相交）
  - `BAND_SPLIT_METRES = 128`
  - `cascadeIsValid(c, radPerPixel): boolean` —— `tileMetres > amplitudePeak / radPerPixel`
  - `LCM_METERS = 3072`、`REBASE_QUANTUM = 3072`
  - `RINGS: readonly { index, inner, outer, cell, segs, floorMetres, mipLod }[]`（口径：inner/outer 为半宽；`segs = 2·outer/cell`；hole 剔除 `|x|,|z| < inner` 的整格）—— `{0, 0, 128, 6.4, 40, 32, 0}`、`{1, 128, 512, 25.6, 40, 128, 3}`、`{2, 512, 1536, 128, 24, 640, 5}`、`{3, 1536, 1900, 200, 19, 1024, 5}`
  - `ringIsValid(r): boolean` —— `r.cell <= 0.205 * r.floorMetres`（floor 按 `4.878 × cell` 向上取整到表值，封顶 1024 = 谱最长波）
  - `ringTriangleCount(): number` —— 每环 `2 × (segs² − hole²)`，`hole = ⌊2·inner/cell⌋²`
- Consumes: Task 2 的 `perPixelRadians`。

- [ ] **Step 1: 写失败测试**

```ts
// Review Focus 3: 69° 下最苛刻的角预算
const rad69 = perPixelRadians(69, 1920);
for (const c of CASCADES) expect(cascadeIsValid(c, rad69)).toBe(true);

// 频段不相交：同一分界两侧，无缝隙无重叠
expect(BAND_SPLIT_METRES).toBe(128);
expect(CASCADES[0].bandMetres[0]).toBe(BAND_SPLIT_METRES);
expect(CASCADES[1].bandMetres[1]).toBe(BAND_SPLIT_METRES);
expect(CASCADES[1].bandMetres[0]).toBe(32);

// Review Focus 2: rebase 量子必须是 LCM 的整数倍
expect(LCM_METERS).toBe(3072);
expect(REBASE_QUANTUM % LCM_METERS).toBe(0);

// 几何：cell 采样规则、环间覆盖与预算
for (const r of RINGS) expect(ringIsValid(r)).toBe(true);
for (let i = 1; i < RINGS.length; i += 1) {
  expect(RINGS[i].inner).toBeLessThan(RINGS[i - 1].outer);
}
expect(ringTriangleCount()).toBe(7496);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/sea/cascades.test.ts src/sea/rings.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现两张表**

`CASCADES` 补 `bandMetres` 列，导出 `BAND_SPLIT_METRES = 128`。`RINGS`：`{0, 0, 128, 6.4, 40, 32, 0}`、`{1, 128, 512, 25.6, 40, 128, 3}`、`{2, 512, 1536, 128, 24, 640, 5}`、`{3, 1536, 1900, 200, 19, 1024, 5}`。`ringTriangleCount()` 按每环 `2 × (segs² − hole²)` 求和（直算 = 7496：3200 + 3000 + 1024 + 272）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/sea/cascades.test.ts src/sea/rings.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sea/cascades.ts src/sea/rings.ts src/sea/*.test.ts && git commit -m "feat(sea): cascade and ring tables with their validity rules"
```

---

### Task 6: 同心方环几何装配

**Files:**
- Create: `src/sea/rings-mesh.ts`
- Test: `src/sea/rings-mesh.test.ts`

**Interfaces:**
- Produces: `buildRingGeometry(ring: Ring): THREE.BufferGeometry`（环局部坐标，y = 0，XZ 平面）；`holeInset(ring: Ring): number` = `inner - cell`。
- Consumes: Task 5 的 `RINGS`。

- [ ] **Step 1: 写失败测试**

```ts
const g = buildRingGeometry(RINGS[0]);
expect(g.getAttribute('position').count).toBe(41 * 41);   // segs + 1
// 相邻环必须重叠至少一格，相切就是裂缝
for (let i = 1; i < RINGS.length; i += 1) {
  expect(holeInset(RINGS[i])).toBeLessThan(RINGS[i - 1].outer);
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/sea/rings-mesh.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

每环生成 `(segs+1)²` 个顶点的规则网格，跳过 `|x| < inner || |z| < inner` 的格子（方形洞），索引成三角。**不做 snap、不做 skirt。**

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/sea/rings-mesh.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sea/rings-mesh.ts src/sea/rings-mesh.test.ts && git commit -m "feat(sea): concentric square-ring geometry with one-cell overlap"
```

---

### Task 7: 天空（日盘 + 辉光收敛 + 太阳方向活起来）

**Files:**
- Modify: `src/horizon.ts`（`GLOW_POW` 48 → 120；`DISK_GAIN` 0 → 0.3；`DISK_HALF_ANGLE_DEG` 0.265 → 2.0；新增 `DUSK_BAND`、`clampSunElevation`、`sunDirectionFromAzEl`）
- Modify: `src/sky-webgpu.ts:87`（`vec3(...SUN_DIRECTION)` → `uniform`；`SkyTslHandle` 加 `setSunDirection`）
- Modify: `src/lights.ts`（返回值加 `setSunDirection`）
- Modify: `src/main.ts`（`?sun=az,el` 解析 + 每帧同步）
- Modify: `src/palettes.ts`（`SUN_POSITION` 语义改为「**默认**太阳」，注释改写）
- Modify: `src/palettes.test.ts`、`src/horizon.test.ts`
- Test: `src/horizon.test.ts`、`src/palettes.test.ts`

**Interfaces:**
- Produces:
  - `HORIZON.DUSK_BAND = { minDeg: 3, maxDeg: 15 }`
  - `clampSunElevation(deg: number): number`
  - `sunDirectionFromAzEl(azDeg: number, elDeg: number): readonly [number, number, number]`（单位向量，方位 0 = -Z）
  - `fwhmDegOfGlow(): number`（辉光半高全宽，度）
  - `SkyTslHandle.setSunDirection(dir: THREE.Vector3): void`
  - `initSunsetLights(scene): { sun: THREE.DirectionalLight; setSunDirection(dir: THREE.Vector3): void }`
- Consumes: `palettes.SUN_POSITION`（**只作默认值**）。

- [ ] **Step 1: 写失败测试**

```ts
// 辉光收敛：FWHM 从 19.4° 收到 ≤ 13°
expect(fwhmDegOfGlow()).toBeLessThanOrEqual(13);

// 日盘：风格化放大到 2°，不是真实的 0.53°
expect(HORIZON.DISK_GAIN).toBeGreaterThan(0);
expect(HORIZON.DISK_HALF_ANGLE_DEG).toBeCloseTo(2.0, 1);

// dusk 带钳制
expect(clampSunElevation(0)).toBe(3);
expect(clampSunElevation(90)).toBe(15);
expect(clampSunElevation(6.97)).toBeCloseTo(6.97, 6);

// 方位/仰角 → 单位向量
expect(Math.hypot(...sunDirectionFromAzEl(0, 6.97))).toBeCloseTo(1, 9);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/horizon.test.ts`
Expected: FAIL —— `fwhmDegOfGlow` / `clampSunElevation` 不存在，`DISK_GAIN` 为 0

- [ ] **Step 3: 改 `horizon.ts`，并同步改旧断言**

`GLOW_POW` 48 → 120、`DISK_GAIN` 0 → 0.3、`DISK_HALF_ANGLE_DEG` 0.265 → 2.0，新增 `DUSK_BAND` / `clampSunElevation` / `sunDirectionFromAzEl` / `fwhmDegOfGlow`。

⚠️ `horizon.test.ts` 里原有的 `it('is sized like a real sun, not a 9 degree blob')` 断言 `DISK_HALF_ANGLE_DEG` 在 `0.1..0.6`——**这条必须改成 `1.5..3.0`**，注释写明：这是一个**风格化放大**的日盘（约 4 倍真实角径），不是物理值。

- [ ] **Step 4: 改 `sky-webgpu.ts`，太阳方向变 uniform**

`const sunDir = vec3(...SUN_DIRECTION)` → `const sunDir = uniform(new THREE.Vector3(...SUN_DIRECTION))`；`SkyTslHandle` 加 `setSunDirection(dir)`（`.value.copy(dir)`）。`vec3(...)` 是编译期常量，不改这一行太阳永远动不了。

- [ ] **Step 5: 改 `lights.ts` 与 `main.ts`**

`initSunsetLights` 返回 `{ sun, setSunDirection }`；`main.ts` 解析 `?sun=az,el` → `clampSunElevation` → `sunDirectionFromAzEl`，**每帧把同一份 dir 同时喂给 sky 和 lights**（两份就漂）。

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run src/horizon.test.ts src/palettes.test.ts`
Expected: PASS

- [ ] **Step 7: 重测 bloom 亮度表**

日盘把太阳方向上的峰值从约 **0.73** 推到约 **0.97**，**越过 `bloomThreshold` 0.82，太阳开始泛光**——这是有意的。抓一帧量新峰值，写进 `post.ts` 的注释表；若整片天空跟着泛光，先降 `DISK_GAIN` 再考虑抬阈值。

Run: `npm run dev` → `?qa=frozen` 抓帧
Expected: 峰值 ≈ 0.97 ± 0.05；泛光只出现在日盘周围，天穹边缘不过曝

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(sky): stylized sun disc, tighter glow, live sun direction"
```

---

### Task 8: 位移采样 + 四档平涂 + 天穹反射

**Files:**
- Create: `src/sea/material.ts`
- Create: `src/sea/bands.ts`
- Test: `src/sea/bands.test.ts`、`src/sea/material.test.ts`（源码扫描）

**Interfaces:**
- Produces:
  - `bandIndexFromHeight(h: number, thresholds: readonly [number, number, number]): 0|1|2|3`
  - `detailWeight(texelMetres: number, distance: number, radPerPixel: number): number`——纹素屏占 `texelMetres / (distance · radPerPixel)` px：> 2 px 为 1、< 1 px 为 0，之间 smoothstep
  - `SEA_BAND_THRESHOLDS: readonly [number, number, number]`
  - `buildSeaMaterial(opts): NodeMaterial`
  - `interface SeaOcean { readonly time: number; update(camera: THREE.Vector3, radPerPixel: number, t: number): void; setQuality(high: boolean): void; setVisible(visible: boolean): void; setDebug(on: boolean): void; dispose(): void }`
  - `initSea(scene: THREE.Scene): Promise<SeaOcean>` —— 装 4 条环，mesh 名 `sea-r0..sea-r3`
- Consumes: Task 4 的 `height`/`chop`/`slope`/`jacobian` 采样纹理（带 mip 链）、Task 5 的 `CASCADES` / `RINGS`（`mipLod`、`floorMetres`）、Task 6 的 `buildRingGeometry`、`palettes.SKY_STOPS` / `SUN_DIRECTION`。

- [ ] **Step 1: 写失败测试**

```ts
// 四档单调
expect(bandIndexFromHeight(-1, T)).toBe(0);
expect(bandIndexFromHeight(1, T)).toBe(3);

// Review Focus 1: 太阳路镜面点 57 m，1.6 cm 纹素屏占 0.47 px → 必须归零
const rad = perPixelRadians(60, 1920);
expect(detailWeight(0.016, 57, rad)).toBe(0);
expect(detailWeight(0.016, 5, rad)).toBe(1);
expect(detailWeight(0.016, 20, rad)).toBeGreaterThan(0);
expect(detailWeight(0.016, 20, rad)).toBeLessThan(1);

// Review Focus 5: 海不吃 scene.fog
expect(sources['./sea/material.ts']).toMatch(/fog\s*=\s*false/);
// ?sea=debug 的假色开关随材质一起出生（Task 12 量覆盖率依赖它）
expect(sources['./sea/material.ts']).toMatch(/debugUniform/);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/sea/bands.test.ts src/sea/material.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 `bands.ts`**

`bandIndexFromHeight` 用三条阈值二分；阈值单源导出 `SEA_BAND_THRESHOLDS`，JS 与 TSL 两侧都读它。

- [ ] **Step 4: 实现 `material.ts`**

顶点：`p = mod(worldXZ, tileMetres)`，按本环 `mipLod` 低通采样（**R0 采 C0+C1，R1–R3 只采 C0**；`floorMetres` 以下的波已被 mip 滤掉，不产生欠采样闪烁）；几何同时应用垂直位移与 `CHOPPINESS ×` 水平位移（Tessendorf χ，单模符号判据：正 χ 压缩波峰）；相邻环重叠带内对两环的 mipLod 线性混合，防 LOD 内容接缝。片元：色带只由 **C0 高度** 驱动（各环判定一致）；法线来自 `slope` 纹理 + 细节法线贴图（`detailWeight` 足迹滤波）；反射方向 `reflect(viewDir, normal)` 代入**天穹同一个函数**（`smoothstep` ramp + `cos^48` 辉光），保证反射色与天空一致；`fog = false`；`debugUniform` 打开时输出假色（四档带各一纯色、泡沫品红）。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/sea/bands.test.ts src/sea/material.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/sea/material.ts src/sea/bands.ts src/sea/*.test.ts && git commit -m "feat(sea): world-mod displacement, four-band ramp, sky-matched reflection"
```

---

### Task 9: Jacobian 泡沫

**Files:**
- Create: `src/sea/foam.ts`
- Test: `src/sea/foam.test.ts`

**Interfaces:**
- Produces: `jacobianSummed(d: { dxx, dzz, dxz, dzx }): number`（四个偏导**先求和**再取行列式）；`foamThresholdFromP95(samples: readonly number[]): number`。
- Consumes: Task 4 的 `jacobian` 纹理（RGB = dxx/dzz/dxz；dzx ≡ dxz）。

- [ ] **Step 1: 写失败测试**

```ts
// 反 bug：逐级联行列式相乘 ≠ 求和后的行列式
const a = { dxx: 0.3, dzz: 0.2, dxz: 0.1, dzx: 0.05 };
const b = { dxx: -0.1, dzz: 0.4, dxz: -0.2, dzx: 0.15 };
const summed = {
  dxx: a.dxx + b.dxx, dzz: a.dzz + b.dzz,
  dxz: a.dxz + b.dxz, dzx: a.dzx + b.dzx,
};
expect(jacobianSummed(summed)).not.toBeCloseTo(
  jacobianSummed(a) * jacobianSummed(b), 3,
);
expect(jacobianSummed({ dxx: 0, dzz: 0, dxz: 0, dzx: 0 })).toBe(1);

// 阈值来自实测分位，不是字面量
const t = foamThresholdFromP95([0.01, 0.02, 0.05, 0.9]);
expect(t).toBeGreaterThan(0.05);
expect(t).toBeLessThan(0.9);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/sea/foam.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

`J = (1+dxx)(1+dzz) - dxz*dzx`。`foamThresholdFromP95` 取 `1 - J` 的 P95 与 P99 中点，返回阈值。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/sea/foam.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sea/foam.ts src/sea/foam.test.ts && git commit -m "feat(sea): Jacobian foam from summed derivatives, measured threshold"
```

---

### Task 10: 太阳路

**Files:**
- Create: `src/sea/sun-road.ts`
- Test: `src/sea/sun-road.test.ts`

**Interfaces:**
- Produces: `SUN_ROAD`（方位门限、近场淡出、峰值、`lowTierGain`）；`sunRoadGain(spec: number, azimuthDiff: number, nearFade: number): number`；`fresnel01(cosTheta: number): number`；`roadBudget(tier: 'high' | 'low'): number`。
- Consumes: `palettes.SUN_DIRECTION`、`post.POST_HIGH.bloomThreshold` / `post.POST_LOW.bloomThreshold`（阈值的单源）。

- [ ] **Step 1: 写失败测试**

```ts
expect(sunRoadGain(0.5, 0, 1)).toBeGreaterThan(sunRoadGain(0.5, 60 * DEG, 1));
expect(sunRoadGain(0, 0, 1)).toBe(0);
expect(sunRoadGain(0.5, 0, 0)).toBe(0);
expect(fresnel01(1)).toBeLessThan(fresnel01(0));   // 掠射更亮

// 双档预算：路面 99 分位必须离该档 bloom 阈值至少一个 K4 边距（0.063）
expect(roadBudget('high')).toBeCloseTo(0.82 - 0.063, 3);   // 0.757
expect(roadBudget('low')).toBeCloseTo(0.85 - 0.063, 3);    // 0.787
expect(roadBudget('low')).toBeGreaterThan(roadBudget('high'));
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/sea/sun-road.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

从 `a842657:src/sun-road.ts` 取回 `sunRoadGain` / `fresnel01` 的实现（`git show a842657:src/sun-road.ts`），**去掉**已删 FFT 海的 `specExponent` 等无消费者常量。

新增 `roadBudget(tier)`：从 `post.ts` 读该档 `bloomThreshold` 减去 `K4_MARGIN = 0.063`，**不要在这里重写阈值字面量**——阈值只有 `post.ts` 一个源。0.063 的出处是幸存文档 `docs/superpowers/plans/2026-10-31-sky-technical-note.md` 的 K4 标定（阈值压在云金色面 0.820 上），写进注释。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/sea/sun-road.test.ts`
Expected: PASS

- [ ] **Step 5: 两档分别量 99 分位**

只量**水面区域**（地平线以下）。日盘在天空、且 Task 7 之后故意越过阈值，不参与这条预算。

Run: `npm run dev` → 高档与低档各抓一帧冻结帧，量水面区域亮度的 99 分位
Expected: 高档 ≤ **0.757**、低档 ≤ **0.787**。超了先降 `SUN_ROAD.PEAK`，不要抬 `bloomThreshold`。

- [ ] **Step 6: 对齐两档观感**

低档阈值 0.85 高于高档 0.82 ⇒ **同一条路在高档会泛光、低档不会**，观感不一致。比较两档同一机位的路面亮度，若差 > 10%，引入 `SUN_ROAD.lowTierGain`（默认 1.0，低档实测值写进注释），并在 `sun-road.test.ts` 加一条断言：低档 gain 必须让路面落在 `roadBudget('low')` 之内。

- [ ] **Step 7: Commit**

```bash
git add src/sea/sun-road.ts src/sea/sun-road.test.ts && git commit -m "feat(sea): sun road with a per-tier bloom budget"
```

---

### Task 11: world / main 接线与 QA 开关

**Files:**
- Modify: `src/world.ts`（恢复 `WorldView`、`sea`、`setSeaVisible`）
- Modify: `src/main.ts`（`view-budget` 接线、`?sea=0`、`?sea=debug`、`describe()`、启动条）
- Modify: `src/qa.ts`（`parseSeaVisible`、`parseSeaDebug`）
- Modify: `src/far-field.ts`（文件头加一句「海不走这里」）
- Modify: `scripts/smoke.mjs`（白名单加回 `src/sea/*`）
- Test: `src/world.test.ts`、`src/qa.test.ts`

**Interfaces:**
- Produces: `WorldView { camera: THREE.Vector3; radPerPixel: number }`；`WorldHandles.update(t, dt, view?: WorldView)`、`readonly sea: SeaOcean | null`、`setSeaVisible(visible: boolean)`；`parseSeaVisible(raw): boolean`；`parseSeaDebug(raw): boolean`（真当且仅当 `raw === 'debug'`）。
- Consumes: Task 2 的 `perPixelRadians`、Task 8 的 `initSea` / `SeaOcean`。

- [ ] **Step 1: 写失败测试**

```ts
// Review Focus 4: 冻结帧用累计 elapsed，不是墙钟
const world = await initWorld(scene);
world.update(3.5, 1 / 60, { camera: new THREE.Vector3(0, 7, 0), radPerPixel: 6.014e-4 });
expect(world.sea?.time).toBe(3.5);

expect(parseSeaVisible('0')).toBe(false);
expect(parseSeaVisible(null)).toBe(true);
expect(parseSeaDebug('debug')).toBe(true);
expect(parseSeaDebug(null)).toBe(false);

// Review Focus 5: 海不吃 scene.fog（四条环逐条查）
const rings = scene.children.filter((o) => /^sea-r\d$/.test(o.name)) as THREE.Mesh[];
expect(rings.length).toBe(4);
for (const ring of rings) expect(ring.material).toMatchObject({ fog: false });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/world.test.ts src/qa.test.ts`
Expected: FAIL —— `sea` 为 null / `parseSeaVisible` 不存在

- [ ] **Step 3: 改 `world.ts`**

`initWorld` 里 dynamic import `./sea`，失败时 `sea = null` 并 `console.error`（不抛）。`applyQuality` / `dispose` / `update` 三处接 `sea`。`update` 传 `time`（累计 elapsed），不是 `performance.now()`。

- [ ] **Step 4: 改 `main.ts`**

`resize()` 之后读 `renderer.domElement.height`（drawing buffer）算 `radPerPixel`；`stepFrame` 里 `world?.update(elapsed, stepDt, { camera: camera.position, radPerPixel })`；`?sea=0` → `world?.setSeaVisible(false)`；`?sea=debug` → `world.sea?.setDebug(true)`；启动条改 `sky + sea + puffs`。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/world.test.ts src/qa.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(sea): mount the ocean in the world and feed it the live view budget"
```

---

### Task 12: 色彩反解与闸门

**Files:**
- Modify: `src/palettes.ts`（恢复 `SEA_PALETTE`，`haze` 指向 `SKY_PALETTE.horizon`）
- Modify: `src/palettes.test.ts`
- Modify: `README.md`、`docs/superpowers/INDEX.md`
- Test: `src/palettes.test.ts`

**Interfaces:**
- Produces: `SEA_PALETTE = { deep, mid, lit, crest, glitter, foam, haze }`，全部数值 hex。
- Consumes: Task 8 的 `SEA_BAND_THRESHOLDS`、Task 9 的泡沫遮罩。

- [ ] **Step 1: 先测量，再写测试**

在 `?sea=debug` 假色模式下（Task 8 产出 `debugUniform`、Task 11 接线）抓一帧，量出 deep/mid/lit/crest 各自占屏百分比；用 `python artifacts/ghibli-audit/solve-ramp.py` 从「屏上目标 L*」反解出线性色，转 hex。**这一帧的数字写进 `SEA_PALETTE` 的注释里。**

- [ ] **Step 2: 写失败测试**

```ts
expect('#' + SEA_PALETTE.haze.toString(16).padStart(6, '0'))
  .toBe(SKY_PALETTE.horizon.toLowerCase());
const ls = ['deep', 'mid', 'lit', 'crest'].map((k) => lstar(SEA_PALETTE[k]));
for (let i = 1; i < ls.length; i += 1) expect(ls[i]).toBeGreaterThan(ls[i - 1]);
expect(ls[0]).toBeGreaterThanOrEqual(18);   // 近黑门槛
expect(ls[3]).toBeLessThan(65);             // 不亮过地平线辉光
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/palettes.test.ts`
Expected: FAIL —— `SEA_PALETTE` 未导出

- [ ] **Step 4: 实现并跑通**

Run: `npx tsc --noEmit && npx vitest run && node scripts/smoke.mjs`
Expected: tsc exit 0；全绿；`smoke ok`

- [ ] **Step 5: 目检**

Run: `npm run dev` → 浏览器。Expected：启动条 `sky + sea + puffs`；海无接缝、无传送带滑动；太阳路成一条金路；带 `?sea=0` 不报错；`?qa=frozen` 下连抓两帧逐像素相同。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(sea): reverse-solved palette and the full green gate"
```

---

## 收尾核对（Self-Review 结论）

- **覆盖**：TA 分析的四个问题分别落到 Task 1（WebGPU-only）、Task 3-4（FFT 场：频段不相交、相位演化、导数纹理产出）、Task 5-6（级联与几何：RINGS v2 自洽表）、Task 7（天空：日盘/辉光/活太阳）、Task 8-10（着色/泡沫/太阳路：每环 mip 低通、χ 切比、debugUniform）、Task 11（接线：`?sea=debug`）、Task 12（反解与闸门）。
- **天空那一条的理由**：`GLOW_POW` 48 的辉光 FWHM 是 **19.4°**（实测：半高半角 9.71°），在 720×1280 竖屏上约 427×400 px，是真实太阳的 37 倍宽；而 `DISK_GAIN = 0` 意味着**根本没有日盘**。Task 7 把辉光收到 ≤13°、补一个 2° 的风格化日盘，并把 `SUN_DIRECTION` 从编译期常量变成 uniform。
- **Review Focus 五条**各自有测试：①→Task 8 `detailWeight`；②→Task 5 `REBASE_QUANTUM`；③→Task 2 + Task 5 `cascadeIsValid`；④→Task 11 `world.sea.time`；⑤→Task 8 源码扫描 + Task 11 逐环 `fog`。
- **型一致**：`radPerPixel` 在 Task 2 定义、Task 5 消费、Task 11 传入；`SeaOcean` 在 Task 8 的 Interfaces 里定义（`initSea` 同时产出）、Task 11 的 `WorldHandles` 引用；`SEA_BAND_THRESHOLDS` 在 Task 8 定义、Task 12 引用；`roadBudget` 在 Task 10 定义，从 `post.ts` 的 `bloomThreshold` 派生。新补的四条链：**时间**——Task 4 `compute(t)`（唯一入口）→ Task 8 `SeaOcean.update(…, t)` → Task 11 `world.update(elapsed, …)`；**导数**——Task 4 产出 `slope`/`jacobian` → Task 8 法线、Task 9 泡沫消费；**频段**——Task 5 `bandMetres`/`BAND_SPLIT_METRES` → Task 3 谱窗口、Task 8 每环采样规则；**debug**——Task 8 `debugUniform`/`setDebug`、Task 11 `parseSeaDebug` → Task 12 量测。
- **太阳路预算分两档**：`roadBudget('high') = 0.757`、`roadBudget('low') = 0.787`，都等于该档 `bloomThreshold − K4_MARGIN(0.063)`。阈值只有 `post.ts` 一个源，sea 侧不许重写字面量。
- **比例**：12 个 Task，代码块只出现在测试断言与签名上，没有代写实现体。
