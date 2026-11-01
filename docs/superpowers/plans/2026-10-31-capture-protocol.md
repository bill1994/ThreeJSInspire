# 采集协议（2026-10-31）

**目标：** 让每一帧"现场证据"可复现。同一个状态独立加载两次，必须逐字节相同；否则帧级指标测的是随机数，不是 shader。

**背景：** 在此之前的所有帧级指标都带抖动——同高度同机位换一个朝向，云覆盖在 `0.338 / 0.564 / 0.633` 之间摆，海 `sunroad_ratio` 在 `1.18 / 2.61 / 3.38` 之间摆。改完一个参数，分不清是改动生效、还是飞机刚好转了个角度。这不是精度问题，是**判据失效**。

---

## Global Constraints

1. **一个状态一个 URL**：状态由 URL 参数 + 输入序列 + 步数唯一确定，不许"凭感觉飞一下截一张"。
2. **只走冻结模式**：`?qa=frozen` 抑制 `renderer.setAnimationLoop`，画面只由 `qa.step()` 推进。普通模式（不带动画循环）保留给真机手飞。
3. **步长固定 `1/60`**：`elapsed = frames / 60`，不累积墙钟时间。
4. **HUD 默认隐藏**：DOM 的矩形卡与滑块会让天穹带的 `edgeDensity` 虚高（带 HUD 0.0700，去掉 0.0235），必须显式记录是否隐藏。
5. **改状态必须写下观测值**：期望的 `elapsed / plane / camera / dive01` 入表，否则运行时没人能判断该帧是不是想要的那个状态。

## Review Focus

1. **状态定义与实际不符**：B（俯冲）最初写成 600 帧，实际 10 s 已经贴海（`y=7.02`、`dive01 0.015`），根本不是俯冲态。**步数必须由观测值反推，不能想象。**
2. **只 present 一轮会截到空白帧**：`qa.stepFrame(0) + 2×rAF` 需要**两轮**，一轮拿到的是 5 KiB 的全黑 PNG。
3. **`steer` 在 `pointerup` 之前一直有效**：所以输入态只需一次 `pointermove`，不需要持续喂事件；反过来，忘了 `pointerup` 会污染下一个状态。
4. **`pointerId` 要固定**：换 id 会让 `activeId` 判定错乱，输入态直接不生效。
5. **平流不是确定性的**：不冻结时，云的位置每次刷新都不同——这正是过去"5 团 / 3.6%"和"4 团 / 15.5%"打架的原因。

---

## 1. 实现

`src/main.ts` 把每帧逻辑抽成 `stepFrame(dt)`，并在 `window.__porco.qa` 上暴露：

| 成员 | 语义 |
|---|---|
| `frozen` | `?qa=frozen` 时为 true，动画循环未启动 |
| `revision` | `THREE.REVISION`（实测 `186`） |
| `elapsed` | 已推进的模拟秒数 |
| `step(count, dt = 1/60)` | 推进 `count` 帧，返回 elapsed |
| `stepFrame(dt)` | 单帧 |
| `farField` | 跟随器句柄（原循环私有，现暴露） |
| `describe()` | 一份可直接写入 sidecar 的冻结状态快照 |

`describe()` 记录：`revision / backend / post / quality / elapsed / plane / camera.pos / camera.fov / camera.aspect / canvas / dpr`。

## 2. 状态表

| 状态 | URL | 输入 | 帧数 | 观测（elapsed / plane / dive01） |
|---|---|---|---|---|
| `A-cruise` | `?alt=60&qa=frozen` | 无 | 600 | 10 / `[0, 60, -460]` / 0 |
| `B-dive` | `?alt=200&qa=frozen` | 下拖 40 px | 90 | 1.5 / `[0, 176.4, -67.8]` / 0.728 |
| `C-bankdive` | `?alt=220&qa=frozen` | 左拖 95 + 下拖 40 | 90 | 1.5 / `[-34.9, 194.8, -51.8]` / 0.775 |
| `D-skim` | `?alt=60&qa=frozen` | 下拖 72 px | 180 | 3 / `[0, 7.0, -135.3]` / 0.498 |

## 3. 采集步骤（可照抄）

```js
// 1. 加载 http://localhost:5174/?alt=<ALT>&qa=frozen
// 2. 等 window.__porco.qa 出现（最多 6 s）
const qa = window.__porco.qa;
document.querySelector('.porco-hud').style.display = 'none';   // 4. 隐藏 HUD
// 5. 派发输入（仅输入态）
const cv = window.__porco.renderer.domElement, r = cv.getBoundingClientRect();
const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
const ev = (t, x, y) => cv.dispatchEvent(new PointerEvent(t, {
  pointerId: 23, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true,
  clientX: x, clientY: y, buttons: 1, button: 0 }));
ev('pointerdown', cx, cy);
ev('pointermove', cx - 95, cy + 40);
// 6. 步进
qa.step(90, 1 / 60);
// 7. present：两轮，缺一不可
for (let i = 0; i < 2; i++) { qa.stepFrame(0); await new Promise(r => requestAnimationFrame(r)); await new Promise(r => requestAnimationFrame(r)); }
// 8. 读 describe() 写 sidecar，再截图
```

## 4. 验收门

同一状态**独立加载两次**，PNG 逐字节比对。

```
python artifacts/cloud-audit/protocol/compare_repeats.py
```

实测结果：

| 状态 | 结果 | meanAbsDiff | maxDiff |
|---|---|---|---|
| `A-cruise` | **PASS** | 0 | 0 |
| `C-bankdive` | **PASS** | 0 | 0 |

**含输入驱动的 C 在内，两次独立加载逐字节相同。** 门成立。

## 5. 产物

| 文件 | 内容 |
|---|---|
| `artifacts/cloud-audit/protocol/capture-protocol.json` | 协议、状态定义、观测值、门结果 |
| `artifacts/cloud-audit/protocol/*.png` | 四个状态的现场帧 |
| `artifacts/cloud-audit/protocol/*.repeat.png` | 复现帧（只留 A、C 两对做门证） |
| `artifacts/cloud-audit/protocol/compare_repeats.py` | 门脚本 |

## 6. 加新状态

1. 先按 URL + 输入 + 帧数跑一次，读 `describe()`。
2. **确认观测值符合意图**（尤其 `dive01` 和 `y`），不符合就调帧数——不是调状态名。
3. 写进 `capture-protocol.json` 的 `states`。
4. 截两次，跑门脚本；不 byte-identical 就不要引用这个状态的任何数字。

## 7. 验证矩阵

1. `npx tsc --noEmit`
2. `npx vitest run`（256）
3. `node scripts/smoke.mjs`（普通模式仍走真实动画循环）
4. `python artifacts/cloud-audit/protocol/compare_repeats.py`
5. 目检：四个状态各一张，确认不是空白帧（空白帧约 5 KiB，正常帧 180–300 KiB）

## 8. 不做

- 不引入 Playwright/Puppeteer：当前用浏览器工具 + 页面内驱动即可，不新增依赖。
- 不改普通模式的帧序：`stepFrame` 只是把原循环体搬了个家，逻辑未变。
