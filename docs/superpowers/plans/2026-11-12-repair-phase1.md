# 修复清单 Phase 1（FLT-01/02/03 + DOME-01）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 关掉修复清单 [`2026-11-11-audit-repair-list.md`](2026-11-11-audit-repair-list.md) §1 的四条 P0 阻塞：真实 GLB 上螺旋桨动起来（FLT-01）、低档裁剪接自动路径（FLT-02）、失速预告拆预警/事件两态（FLT-03）、地平线 patch 拿到可复核的验收门（DOME-01）。

**Architecture:** FLT-01 在 `setProp` 里就地合成兜底 pivot（GLB 实测三节点均为场景根、无旋转、躺 GLB 世界 Z 轴 x=0/y=0.25 线上——`Object3D.attach()` 保世界变换，旋转轴零猜测）；FLT-02 是 main.ts 两处接线的源码 pin；FLT-03 拆纯函数决策 + 新 cue id + HUD 三态；DOME-01 补 world 只读计数 accessor + 重抓 on/off 帧过 `analyze_horizon.py` 门，门不过沿固定二分树走材质路径。

**Tech Stack:** TypeScript 5.5 · three 0.186.0（WebGPU-only）· Vitest 2.1 · Vite 6 · Python 量具（PIL/numpy）

**Spec:** [`plans/2026-11-11-audit-repair-list.md`](2026-11-11-audit-repair-list.md) §1（四条的判据/修法/验收原文）＋ [`specs/2026-11-10-flight-feel-improvement-design.md`](../specs/2026-11-10-flight-feel-improvement-design.md)（失速预告 P0-5 语义）＋ [`plans/2026-11-10-dome-cloud-p15-p2-horizon.md`](2026-11-10-dome-cloud-p15-p2-horizon.md) Task 7（patch 契约）。

## Global Constraints

- three 0.186.0，WebGPU-only；`src/renderer.ts` 非 WebGPU 后端抛错，不得引入 WebGL 回退。
- 每条修复 fail-first：先写会红的测试，跑红，再实现。
- 单测文件与被测模块同名；源码 pin 走 `import.meta.glob('./x.ts', { query: '?raw' })` + `toMatch`（仓库既有 tripwire 风格）。
- 门禁：`npx tsc --noEmit` = 0；`npx vitest run` 全绿后才许 commit。提交信息 scope：`fix(flight):` / `test(dome):`。
- 浏览器采集协议：`?qa=frozen` + `qa.step(n)`（main.ts:436-439），dev server 走 `http://[::1]:5173`（vite IPv6-only，Chrome localhost 会竞速失败——porco 采集配方已知坑）。
- 竖屏 434×772、fov 60、`--rect 474.875,0,434.25,772` 为画布裁切口径（analyze_horizon.py 用法见其文件头）。
- `artifacts/` 只放证据和仪器，不放叙述；证据帧必须随代码一起 commit（修复清单判定口径 1）。

## Review Focus

1. **GLB 再次换资产、prop 节点改名** → 兜底静默失效回到 no-op：`ensurePropPivot` 找不到任何 prop 节点时必须 `console.warn` 一次（不再无声）；浏览器门的 ROI 差值比率钉住真实资产路径。→ Task 1 的 warn-once 测试 + 采集门。
2. **NaN throttle / dt=0** → 不得写入 NaN 透明度、不得旋转：clamp01 前先把非有限 throttle 归一为 0。→ Task 1 的 NaN 用例。
3. **game 为 null**（initGame 失败 catch，main.ts:238）时质量变更块不得炸：`game?.setQuality` 可选链；init 处的一次性对齐必须放在 try 块内赋值成功之后。→ Task 2 的源码 pin。
4. **stall_warn one-shot 与 event 覆盖**：warn 弹出 3s 内 event 到来，`sub.show('stall')` 顶掉 warn 行（预期行为）；`cues.nextLine('stall_warn')` 自身一次性。→ Task 3 的 subtitles 用例。
5. **采集污染**：horizon 门必须在 dome 材质 fog=false 现状下抓（patch 在 1300–1700 m，fog 回归会全糊成雾色、门数字失真）；读数前先目检帧内无雾色。→ Task 4 步骤 4 的前置目检。

---

### Task 1: FLT-01 — 螺旋桨兜底 pivot（真实 GLB 无 prop_spin）

> 状态（2026-11-12）：✅ 已完成并提交（`e59728f`），单元门 + 浏览器门（3.91×）均过。Task 2/3 已完成（本轮待提交），Task 4 未动。

**Files:**
- Modify: `src/plane.ts:290-302`（setProp）＋新增模块级 `ensurePropPivot`
- Modify: `src/plane.test.ts:107-120`（删除「no-op 是预期」用例，换成兜底用例）
- Create: `artifacts/plane-audit/capture-prop.mjs`（浏览器门采集，仿 `artifacts/dome-audit/capture_*.mjs` 结构）

**Interfaces:**
- Consumes: `propSpinRate(t)` / `propOpacity01(t)`（plane.ts 既有，:295/:301 在用；实测 `propOpacity01(0)=0.1`、`propOpacity01(1)=0.35`）。GLB 实测节点（binary JSON chunk 解析，2026-11-11）：`prop_blade_0` mesh14 t=[0,0.25,4.34]、`prop_blade_1` mesh15 同位、`prop_spinner` mesh16 t=[0,0.25,4.62]，均无 rotation/scale、parent 均为空（场景根）——自旋轴 = GLB 世界 Z 过 (0, 0.25) 线。
- Produces: `ensurePropPivot(root: THREE.Object3D): THREE.Group | null`（模块级纯 helper：找 `prop_spinner` ?? `prop_blade_0` ?? `prop_blade_1`；全无 → null；有 → 新建 `prop_spin` Group 在锚点位置、`attach()` 收编三节点，返回 pivot）。

- [x] **Step 1: 写失败的测试**（替换 plane.test.ts:107-120 整个用例）✅ 2026-11-12 已完成：兜底 pivot 用例 + warn-once 用例已在 `src/plane.test.ts` 落地并曾跑红

```ts
it('drives blades via a synthesized pivot when the GLB has no prop_spin (FLT-01)', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const scene = new THREE.Scene();
  const plane = await initPlane(scene);
  const spin = plane.group.getObjectByName('prop_spin');
  spin?.parent?.remove(spin); // 模拟 GLB 换装吞掉占位 prop 组
  plane.setProp(1, 0.1);
  const pivot = plane.group.getObjectByName('prop_spin');
  expect(pivot).not.toBeNull(); // 兜底建出了 pivot
  const b0 = plane.group.getObjectByName('prop_blade_0') as THREE.Mesh;
  expect(b0.parent).toBe(pivot);
  expect(pivot!.rotation.z).not.toBe(0);
  expect((b0.material as THREE.MeshStandardMaterial).opacity).toBeCloseTo(0.35, 9);
  plane.setProp(Number.NaN, Number.NaN);
  expect(Number.isFinite(pivot!.rotation.z)).toBe(true); // NaN 不转不写坏
  plane.dispose();
});

it('stays a true no-op and warns once when the asset has no prop nodes at all', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const scene = new THREE.Scene();
  const plane = await initPlane(scene);
  const spin = plane.group.getObjectByName('prop_spin');
  spin?.parent?.remove(spin); // 连 prop_blade_* 一起消失
  plane.setProp(0.7, 0.016);
  plane.setProp(0.7, 0.016);
  expect(plane.group.getObjectByName('prop_spin')).toBeNull();
  expect(warn).toHaveBeenCalledTimes(1);
  plane.dispose();
});
```

- [x] **Step 2: 跑红** ✅ 2026-11-12 已完成

Run: `npx vitest run src/plane.test.ts`
Expected: FAIL（第一条 pivot 为 null——兜底分支不存在）

- [x] **Step 3: 实现**（plane.ts）✅ 2026-11-12 已完成：`ensurePropPivot` + `propWarned` + NaN 归一 + 双叶材质收集，见提交 e59728f
  1. 模块级新增 `ensurePropPivot`（注释写明 GLB 实测节点表与轴结论）；找不到锚点返回 null。
  2. `initPlane` 闭包加 `let propWarned = false`。
  3. `setProp` 改为：pivot 找不到 → `ensurePropPivot(root)` → 仍 null 则 warn-once + return；throttle 在 clamp01 前先 `Number.isFinite(throttle01) ? throttle01 : 0` 归一。
  4. 透明度写法从单 disc 改为收集 `prop_blade_0`/`prop_blade_1` 两个材质（`Set` 去重引用）统一写 `propOpacity01(t)`——真 GLB 两叶可能是独立材质，只写一叶会闪 asymmetry。占位路径（prop_spin 已存在）行为不变。

- [x] **Step 4: 跑绿** ✅ 2026-11-12 已完成：`src/plane.test.ts` 全绿（含既有占位用例不回归）

Run: `npx vitest run src/plane.test.ts`
Expected: PASS（含 :96-103 既有占位用例不回归）

- [x] **Step 5: 全量门禁** ✅ 2026-11-12 已验证：`tsc --noEmit` = 0；`vitest run` 65 文件 / 657 用例全绿

Run: `npx tsc --noEmit` → 0；`npx vitest run` → 全绿

- [x] **Step 6: 浏览器门（真实 GLB 路径）** ✅ 2026-11-12 PASS：`capture-prop.json` ratios.roiOverCanvas = 3.91（门线 3×），pivot rotationZ 10s 转 169.09°，`glbMissingWarnSeen: false`

`capture-prop.mjs`：`?pos=0,120,-300&qa=frozen`，抓 `qa.step(0)` 与 `qa.step(600)` 两帧；量 prop ROI（居中，机头桨盘区，首抓后钉坐标写进脚本常量）t0→t30 的 mean|diff|，与全帧 mean|diff|（排除 HUD DOM 行）比对。**门：prop ROI ≥ 3 × 全帧均差**（静止场景里只有桨在转，比率达不到即兜底未生效——依次查 console 是否 `[porco] GLB missing`、`ensurePropPivot` 是否命中）。数字记 `artifacts/plane-audit/capture-prop.json` sidecar，帧入库。

- [x] **Step 7: Commit** ✅ 2026-11-12 已提交：`e59728f fix(flight): prop fallback for GLB without prop_spin pivot (FLT-01)`

```bash
git add src/plane.ts src/plane.test.ts artifacts/plane-audit
git commit -m "fix(flight): prop fallback for GLB without prop_spin pivot (FLT-01)"
```

---

### Task 2: FLT-02 — 低档裁剪接自动路径

**Files:**
- Modify: `src/main.ts:417-420`（质量变更块）＋ `src/main.ts:222-238`（initGame 成功后一次性对齐）
- Test: `src/sky-sun-sea-linkage.test.ts`（追加 describe，沿用其 ?raw 源码 pin 风格）

**Interfaces:**
- Consumes: `game: GameHandles | null`（main.ts:124）、`world.quality: 'high' | 'low'`、`game.setQuality(high)`（feel L2/L3 spray/mist + streaks 200→100 裁剪；行为已被 `flight-p2accept.test.ts` 钉住）。governor 降档与移动端启动降档都走 `world.applyQuality`（world.ts:244-253），main.ts:417 的帧循环块是唯一能观察到 `world.quality` 变化的自动路径。
- Produces: 无新 API——纯接线。

- [x] **Step 1: 写失败的测试**（sky-sun-sea-linkage.test.ts 追加）✅ 2026-11-12 已完成：两条 pin 先红后绿

```ts
describe('FLT-02：低档裁剪接自动路径', () => {
  it('质量变更块在 post 之后同步扇出 game.setQuality', () => {
    const src = sources['./main.ts'];
    expect(src).toMatch(/world\.quality !== lastQuality[\s\S]{0,240}game\?\.setQuality\(lastQuality === 'high'\)/);
  });
  it('initGame 成功后按 world.quality 对齐一次（移动端启动即 low）', () => {
    const src = sources['./main.ts'];
    expect(src).toMatch(/game\.setQuality\(world\.quality === 'high'\)/);
  });
});
```

- [x] **Step 2: 跑红** ✅ 2026-11-12 已完成：两处接线不存在时 2 条 pin 皆红

Run: `npx vitest run src/sky-sun-sea-linkage.test.ts`
Expected: FAIL（两处接线都不存在）

- [x] **Step 3: 实现**（main.ts）✅ 2026-11-12 已完成：质量变更块加 `game?.setQuality`；try 内 `if (world)` 守住后一次性对齐（world 可为 null，直接 `.quality` 会炸 try）
  1. :417-420 块在 `post.setQuality(...)` 后加一行：`game?.setQuality(lastQuality === 'high'); // FLT-02：governor/移动端降档自动扇出到 feel 裁剪`。
  2. :222 `game = await initGame({...})` 之后（仍在 try 内）加：`game.setQuality(world.quality === 'high'); // FLT-02：首帧前对齐 world 档`。

- [x] **Step 4: 跑绿＋全量** ✅ 2026-11-12 已完成（单文件 26/26 + `tsc` 0；全量门禁待本轮统一跑）

Run: `npx vitest run src/sky-sun-sea-linkage.test.ts` → PASS；`npx tsc --noEmit` → 0；`npx vitest run` → 全绿（governor 在冻结采集里不可达，自动路径的行为面由既有 game.setQuality 用例 + 本 pin 合力覆盖）

- [x] **Step 5: Commit** ✅ 2026-11-12 已完成：全量 `tsc` 0 ＋ `vitest run` 65 文件 / 663 用例全绿（ FLT-02/03 新增 6 用例）

```bash
git add src/main.ts src/sky-sun-sea-linkage.test.ts
git commit -m "fix(flight): automatic low-tier cut reaches game.setQuality (FLT-02)"
```

---

### Task 3: FLT-03 — 失速预告拆预警/事件两态

**Files:**
- Modify: `src/game.ts:945-948`（cue 分派换新 id）＋新增导出纯函数
- Modify: `src/subtitles.ts:9`（`SubCue` union）＋ `:23` 后（cue 表新行）
- Modify: `src/hud.ts:102-106`（CSS）＋ `:306-311`（三态 className）
- Test: `src/game.test.ts`（纯函数）、`src/subtitles.test.ts`（新 cue）、`src/hud.test.ts`（三态 pin）

**Interfaces:**
- Produces: `export function stallCueId(stall01: number, stallWarn: boolean): 'stall' | 'stall_warn' | null`（game.ts 导出；`stall01 > 0.5` → `'stall'`；否则 `stallWarn` → `'stall_warn'`；否则 null）。
- subtitles 新行（插在 stall 行后）：`{ id: 'stall_warn', zh: '速度在掉——放平杆，让机头下来。', en: 'Speed bleeding — ease the stick forward.', dur: 3, cue: 'stall_warn' }`（dur 3 < stall 的 4：warn 先弹、event 顶掉，单行显示）。
- HUD 三态：`stall01 > 0.5` → `porco-stall porco-stall--on`（现有 blink 不动）；`stallWarn && stall01 <= 0.5` → `porco-stall porco-stall--warn`（新 CSS `.porco-stall--warn{opacity:.55}` 常亮暗态，紧挨 :105）；否则基态。HUD 读数 `r.stall01`/`r.stallWarn` 已在 :306-307 消费，readout 无需改。

- [x] **Step 1: 写失败的测试** ✅ 2026-11-12 已完成：三文件追加 pin＋行为用例

```ts
// subtitles.test.ts 追加
it('stall_warn 是独立 cue：一次后归 null（FLT-03 预警态）', () => {
  const cues = createCues();
  expect(cues.nextLine('stall_warn')).toBe('stall_warn');
  expect(cues.nextLine('stall_warn')).toBeNull();
});

// game.test.ts 追加
describe('stallCueId（FLT-03）', () => {
  it('事件态优先，预警态次之，其余 null', () => {
    expect(stallCueId(0.6, false)).toBe('stall');
    expect(stallCueId(0.6, true)).toBe('stall');
    expect(stallCueId(0.3, true)).toBe('stall_warn');
    expect(stallCueId(0.3, false)).toBeNull();
  });
  it('分派点真的换用了 stall_warn（源码 pin）', () => {
    const src = sources['./game.ts'];
    expect(src).toMatch(/else if \(state\.stallWarn\) showCue\('stall_warn'\)/);
  });
});

// hud.test.ts 追加
describe('hud 失速带三态（FLT-03）', () => {
  it('预警态 --warn 常亮暗态、事件态 --on 闪烁，互不吞并', () => {
    const src = sources['./hud.ts'];
    expect(src).toMatch(/\.porco-stall--warn\{opacity:\.55\}/);
    expect(src).toMatch(/stallWarn === true[\s\S]{0,240}porco-stall--warn/);
    expect(src).toMatch(/porco-stall--on/);
  });
});
```

- [x] **Step 2: 跑红** ✅ 2026-11-12 已完成：3 文件红（函数未导出、表无行、class 不存在），4 用例失败

Run: `npx vitest run src/subtitles.test.ts src/game.test.ts src/hud.test.ts`
Expected: FAIL（函数未导出、表无行、class 不存在）

- [x] **Step 3: 实现** ✅ 2026-11-12 已完成：`stallCueId` 导出＋分派换 `stall_warn`＋旧注释改写；union＋表新行（dur 3）；HUD 三态＋CSS（`lastStallOn` 布尔换 `lastStallCls` 字符串缓存）
  1. game.ts 导出 `stallCueId`（签名如上）；:946-948 注释改写为「预警/事件双卡」语义（旧注释描述的是 one-shot 吃掉分支的 bug 语义，已过时）；:948 改 `else if (state.stallWarn) showCue('stall_warn');`。
  2. subtitles.ts：union 加 `'stall_warn'`，表加行（文案见 Interfaces）。
  3. hud.ts：CSS 加 `.porco-stall--warn{opacity:.55}`；:306-311 的二态改三态（warn 在 stall01≤0.5 且 stallWarn 时命中）。

- [x] **Step 4: 跑绿＋全量** ✅ 2026-11-12 已完成：三文件 26/26＋`tsc` 0（SUB_LINES 既有长度 pin 7→8 同步）；全量门禁待本轮统一跑

Run: `npx vitest run src/subtitles.test.ts src/game.test.ts src/hud.test.ts` → PASS；`npx tsc --noEmit` → 0；`npx vitest run` → 全绿

- [x] **Step 5: 浏览器门（帧循环消费证据）** ✅ 2026-11-12 PASS（ego-browser，WebGPU 真机；单拉满杆直达 event 会跳过 warn——warn 区一帧即过；改两段式拉杆后全序贯：medium(74px) warn @e=4.67「速度在掉」+`--warn` → full(130px) event @e=4.92「机头太仰」+`--on` → post @e=5.92 plane y=232.2；三帧 `stallwarn-{warn,event,post}.png`＋sidecar 入库）

`artifacts/plane-audit/capture-stallwarn.mjs`（已按两段式更新，PULL_MED=74/PULL_FULL=130）：dev server + 按住上拉逼失速（porco 采集配方），`?qa=frozen` 下逐 `qa.step` 抓三帧——stallWarn 事件沿后、stall>0.5 前（headless pin 实测 warn @2.12s、event @2.5s、hover @2.60s，复现时以帧内 readout 为准）断言：字幕 DOM 含「速度在掉」且 HUD class 含 `porco-stall--warn`；event 后同查 `stall` 行 + `--on`。数字/布尔记 sidecar `capture-stallwarn.json`。

- [x] **Step 6: Commit** ✅ 2026-11-12 全量 `tsc` 0 ＋ 65 文件 / 663 用例全绿，浏览器门 PASS（三帧＋sidecar）

```bash
git add src/game.ts src/game.test.ts src/subtitles.ts src/subtitles.test.ts src/hud.ts src/hud.test.ts artifacts/plane-audit
git commit -m "fix(flight): split stall warn/event cues and HUD states (FLT-03)"
```

---

### Task 4: DOME-01 — 地平线 patch 验收门

**Files:**
- Modify: `src/world.ts`（handle 新增只读 `horizonCount`）＋ `src/world.test.ts`（accessor pin）
- Commit 入库: `artifacts/dome-audit/capture_p15_horizon.mjs`、`artifacts/dome-audit/analyze_horizon.py`（已存在、untracked）
- Create: `artifacts/dome-audit/p15-horizon-{on,off}-t0-v2.png`（HEAD 重抓）＋ `p15-horizon-gate.json`（量门数字）

**Interfaces:**
- Produces: world handle 只读 `get horizonCount(): number`（返回 `domeHorizon?.count ?? 0`；dome-horizon 侧 `count` 即存活 spec 数 = 可见数，`dome-horizon.ts:89-90`）。
- 量具：`analyze_horizon.py on.png off.png --rect 474.875,0,434.25,772`（PIL/numpy；r7 带 = 水平线 ±5°、patch 探针带 rows150-300）。off 帧口径 = `?dome=0&puff=0`（两套云全关、含 horizon，穹顶计划 Review Focus 1）。

- [x] **Step 1: 写失败的测试**（world.test.ts 追加，源码 pin 风格）✅ 2026-11-12 已完成

```ts
it('exposes horizonCount so the DOME-01 gate can assert live patches', () => {
  const src = sources['./world.ts'];
  expect(src).toMatch(/get horizonCount\(\): number/);
  expect(src).toMatch(/domeHorizon\?\.count \?\? 0/);
});
```

- [x] **Step 2: 跑红** ✅ 2026-11-12 已完成：1 failed / 18 passed（accessor 不存在）

Run: `npx vitest run src/world.test.ts`
Expected: FAIL（accessor 不存在）

- [x] **Step 3: 实现**（world.ts handle 对象内加 getter，挨着其它 dome 透传）✅ 2026-11-12 已完成：`get horizonCount(): number { return domeHorizon?.count ?? 0; }`（`DomeHorizonLike.count` 已在 :184，另补 `WorldHandles.horizonCount` 接口声明，否则 tsc 2353）

- [x] **Step 4: 跑绿＋全量** ✅ 2026-11-12 已完成：`world.test.ts` 19/19 ＋ `tsc` 0 ＋ 全量 65 文件 / 664 用例全绿

- [x] **Step 5: 重抓 on/off 对（HEAD）** ✅ 2026-11-12 已完成（ego 真机，`?pos=0,60,-300&qa=frozen`，on `dome=1`/off `dome=0&puff=0`，各 `qa.step(0)`；on/off 两页 horizonCount 均为 8；目检带内无雾色糊）

vite dev server（`http://[::1]:5173`）；`?pos=0,60,-300&qa=frozen`，on = `&dome=1`、off = `&dome=0&puff=0`，各 `qa.step(0)` 抓一帧 → `p15-horizon-on-t0-v2.png` / `p15-horizon-off-t0-v2.png`；sidecar 记 url/steps/canvas/bytes/sha。**抓完先目检：带内无雾色**（fog=false 回归会让 1300-1700 m 全糊，门数字作废）。

- [x] **Step 6: 量门** ✅ 2026-11-12 已量：**FAIL**——探针带 max 4.60（门线 20），r7 带 0.14；唯一差值段是 deck 本体。数字已写 `p15-horizon-gate.json`（verdict: fail）

Run: `python -I artifacts/dome-audit/analyze_horizon.py artifacts/dome-audit/p15-horizon-on-t0-v2.png artifacts/dome-audit/p15-horizon-off-t0-v2.png --rect 474.875,0,434.25,772`
**门：patch 带（水平线上方 9.7–16.3°，对应 rows≈240–400 一带）on/off max|diff| > 20 且超阈行 ≥ 2；投影矩形差值同向。** 数字写 `p15-horizon-gate.json`（连 verdict: pass/fail）。对照基线：修复前实测 max≈25/255、超阈 0 行（三审 2026-11-11 复跑）——门数字必须显著越过它。

- [x] **Step 7: 门不过 → 二分树** ✅ 2026-11-12 二分执行完毕，根因已定位（见 gate JSON `bisect`）：①挂载✓（mesh 在，on 可见/off 级联灭，count=8）；②顶点 alpha✓（itemSize 4 + vertexColors，纹理正常）；③renderOrder 2→3 只动 deck 排序（r7 0.14→10.5 是 deck 效应，patch 仍 5.6）；④depthTest:false 与 ro3 帧数字完全一致（深度没挡）。隔离帧（on 页内存藏 patch）证实 patch 在画：纯贡献 max 13.4/255、探针带 150 行全超 3 但 max 仅 5.6——**对比度不够，不是没画**。修法待拍板（降 HAZE_MIX / 加深剪影 / 提 alpha），落回后重跑 Step 5-6 ⏳
  1. console 有无 dome-horizon 挂载报错（world.ts:229-236 try/catch 只丢这层）；
  2. 顶点 RGBA alpha 是否真到 GPU：`geometry.attributes.color.itemSize === 4` + `material.vertexColors`（dome-horizon.ts:328/:347）；
  3. 合成顺序：transparent 排序按深度，patch（1300 m）可能被 renderOrder 1 的 deck 先画后盖 → 试 patch `renderOrder` 2→3 一帧对照（dome-horizon.ts:360）；
  4. 遮挡：试 `depthTest: false` 一帧对照（dome-horizon.ts:350）——若立刻显形，根因是深度写入方（海/陆）在前面。
  每步产出 on/off 帧与结论；查明根因后把修法落回 dome-horizon.ts 并重跑 Step 5-6，**不许只靠 depthTest:false 蒙混过关**（会透出被遮挡的海平线）。

- [x] **Step 8: Commit** ✅ 2026-11-12 已提交（`d84a9fc`；accessor＋量门帧＋二分对照帧＋gate JSON verdict:fail；修法待拍板）

```bash
git add src/world.ts src/world.test.ts artifacts/dome-audit/capture_p15_horizon.mjs artifacts/dome-audit/analyze_horizon.py artifacts/dome-audit/p15-horizon-*
git commit -m "test(dome): horizon patch on/off gate at 60m pose + world accessor (DOME-01)"
```

---

## Self-Review

1. **Spec coverage**：修复清单 §1 四条全部各有 Task；§4 账本回改已在 Phase 0 完成（2026-11-12，不属本计划）。
2. **Step scan**：每步单动作——测试步给全断言、实现步只给签名/常量/锚点行号、验证步给命令与期望。`ensurePropPivot` 的算法体是唯一的成段代码（GLB 实测数据钉死旋转轴，签名+测试不足以定它）。
3. **Type consistency**：`ensurePropPivot(root) → Group | null`、`stallCueId(stall01, stallWarn) → 'stall'|'stall_warn'|null`、`horizonCount: number` 三处在定义与使用处拼写一致。
4. **Review Focus**：五条各有归属测试（Task 1 warn-once + NaN、Task 2 可选链 pin、Task 3 subtitles one-shot、Task 5 目检在 Task 4 Step 5）。
5. **Proportion**：四 Task 与修复清单四条一一对应，无 step-level 之外的发挥。

## 执行顺序依赖

Task 1→2→3 独立可并行（不同文件面），Task 4 独立。建议按编号顺序执行：1（资产路径最险）→ 4（量门最可能触发二分，越早知道越好）→ 2 → 3。
