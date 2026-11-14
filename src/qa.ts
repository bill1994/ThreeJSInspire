/**
 * src/qa.ts — 抓帧用的纯解析器（无 DOM、无 THREE）。
 *
 * 验收里有三条必须逐帧看（穿云无硬切边、不凭空消失、白雾平滑进出），而布局每调一次
 * 云的位置就会变，靠「飞过去碰运气」不可复现。所以摆位和开关都要能从 URL 给定。
 *
 * debug color panel（计划 2026-11-09）在解析器之外追加两块同样无 DOM 的纯逻辑：
 * `?debug=color` 的补丁/锁解析，和 `exportColorState` 复现串的格式化
 * （`formatColorRepro`）。状态本体留在 main.ts 闭包层，这里只放可单测的纯函数。
 */
import type { DebugTrackPatch, Vec3 } from './sky-track';

export interface Pos {
  x: number;
  y: number;
  z: number;
}

/** `?pos=x,y,z` → 三个有限数，否则 null（宁可忽略也不要把飞机扔到 NaN）。 */
export function parsePos(raw: string | null | undefined): Pos | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const parts = raw.split(',');
  if (parts.length !== 3) return null;
  // 空分量必须拒绝：Number('') 是 0，?pos=1,,3 会把飞机静默按到海平面。
  if (parts.some((p) => p.trim().length === 0)) return null;
  const nums = parts.map((p) => Number(p.trim()));
  if (!nums.every((n) => Number.isFinite(n))) return null;
  return { x: nums[0], y: nums[1], z: nums[2] };
}

/** `?puff=0` 关掉近景云场；其它值（含缺省）一律当开。 */
export function parsePuffVisible(raw: string | null | undefined): boolean {
  return raw !== '0';
}

/**
 * `?bg=0` 关掉背景云（穹顶 + 地平线环，layer-reduction Task 4 起改名）；其它值
 * （含缺省）一律当开。旧名 `?dome=` 仍是兼容别名——由 `resolveBgVisible` 裁决
 * （`?bg=` 有值优先，缺省回落 `?dome=`）。
 *
 * 门 1（云层覆盖率）的唯一量法就是同机位开/关两帧做差，没有这个开关量不了。
 */
export function parseBgVisible(raw: string | null | undefined): boolean {
  return raw !== '0';
}

/**
 * legacy 名字：`?dome=0` 的底层解析器，`resolveBgVisible` 的回落通道仍读它。
 * dome 本体已删，`?dome=` 作为兼容别名保留（bg-first 之外的旧 URL 仍走这条回落
 * 通道，见 `resolveBgVisible`），解析器随别名留作回落通道的单测锚点。
 */
export function parseDomeVisible(raw: string | null | undefined): boolean {
  return raw !== '0';
}

/**
 * `?bg=` 优先、`?dome=` 兼容别名：bg 有值（非空字符串）用 bg，否则回落 dome。
 * 空串不算「有值」——`?bg=`（没给值）不接管，旧 `?dome=0` 继续生效。只给
 * `?dome=` 的旧 URL 行为逐位不变，A/B 门 1 采集不受改名影响。
 */
export function resolveBgVisible(
  bgRaw: string | null | undefined,
  domeRaw: string | null | undefined,
): boolean {
  if (typeof bgRaw === 'string' && bgRaw.length > 0) return parseBgVisible(bgRaw);
  return parseDomeVisible(domeRaw);
}

/** `?bgq=` 烘焙分辨率（bg-cumulus Task 5）：512/1024/2048 三档，clamp + 缺省 1024。 */
export function parseBakeQuality(raw: string | null | undefined): 512 | 1024 | 2048 {
  if (raw === null || raw === undefined || raw === '') return 1024;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1024;
  if (n <= 640) return 512;
  if (n <= 1536) return 1024;
  return 2048;
}

/** `?sea=0` 关掉海面；其它值（含缺省）一律当开。 */
export function parseSeaVisible(raw: string | null | undefined): boolean {
  return raw !== '0';
}

/** `?sea=debug` 进假色模式；真当且仅当显式 `debug`。 */
export function parseSeaDebug(raw: string | null | undefined): boolean {
  return raw === 'debug';
}

/**
 * `?sea=nochop` — QA A/B 验收钩子（细八度计划 Task 1）：关掉 C1 chop 级联对
 * 图形的贡献，用来证明「近场结构来自 C1 波场」。只闸 `c1Gate`、**不停派发**，
 * 与 `setQuality(false)`（会连带改 tierGain 并停 C1 dispatch）不同；chopOverride
 * 已保证换档后仍生效（`setQuality` 只在无覆盖时才写档位隐含门值）——A/B 不再
 * 依赖冻结采集流程。
 */
export function parseSeaNoChop(raw: string | null | undefined): boolean {
  return raw === 'nochop';
}

/**
 * `?sunspin=<deg/s>` → 太阳匀速自转速度（度/秒）。
 *
 * 2026-11-08 联动验收杠杆：让天空的太阳盘/光晕与海面的太阳映射一起转，
 * 肉眼或 `qa.step()` 抓帧都能直接验证二者是否同步。缺省、非法、非正数
 * 一律 0（默认画面完全不变）；上限 360 deg/s 防 typo 把太阳转成频闪。
 */
export function parseSunSpin(raw: string | null | undefined): number {
  if (typeof raw !== 'string' || raw.length === 0) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, 360);
}

// ---- ?debug=color 面板通道（debug color panel 计划 Task 1）------------------------------

/**
 * `?debug=color` — 拉起调试取色面板；真当且仅当显式 `color`（与 `parseSeaDebug`
 * 同一套字面量约定：缺省、`0`、别的词都不算开）。
 */
export function parseDebugColor(raw: string | null | undefined): boolean {
  return raw === 'color';
}

/**
 * `?trackpatch=<JSON>` → 轨道补丁。只接受 JSON **普通对象**（非 null、非数组），
 * 其余（坏 JSON、数字、字符串）一律 null——解析失败绝不抛错打断启动。
 * 字段合法性不做深校验：多余字段会被 `applySkyTrack` 忽略，类型错误由面板侧自检。
 */
export function parseTrackPatch(raw: string | null | undefined): DebugTrackPatch | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as DebugTrackPatch;
}

/** `?hazelock=1` → 锁定海霾端点；其它值（含缺省）一律 false。 */
export function parseHazeLock(raw: string | null | undefined): boolean {
  return raw === '1';
}

/**
 * `?haze=r,g,b` / `?away=r,g,b` → 线性 RGB 三分量（调试端点，S4）。
 * 与 `parsePos` 同一套纪律：恰好三分量、全有限数、空分量拒绝，否则 null。
 */
export function parseLinearVec3(raw: string | null | undefined): Vec3 | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const parts = raw.split(',');
  if (parts.length !== 3) return null;
  if (parts.some((p) => p.trim().length === 0)) return null;
  const nums = parts.map((p) => Number(p.trim()));
  if (!nums.every((n) => Number.isFinite(n))) return null;
  return [nums[0], nums[1], nums[2]];
}

const f4 = (n: number): string => n.toFixed(4);

const vec3Param = (v: Vec3): string => `${f4(v[0])},${f4(v[1])},${f4(v[2])}`;

const vec3Array = (v: Vec3): string => `[${f4(v[0])},${f4(v[1])},${f4(v[2])}]`;

/**
 * `exportColorState().repro` 的两条复现命令（R14/S4）：第一行 URL，第二行控制台。
 * 线性浮点一律 `toFixed(4)`；haze/awayEdge 为 null 时省掉 `haze/away` 两段，
 * 控制台也不追加 `setHazeEndpoints`——回放「未锁定」的默认路径；patch 为 null
 * 时同样省掉整个 `trackpatch` 段（fresh URL 加载即默认轨道，语义等价）；
 * toonAmount 为 0 时省掉 `&toon=` / `qa.setToon(...)` 整段（toon-look Phase 1
 * Task 4，同一省略先例——0 就是默认画面，回放 fresh URL 语义等价）。
 */
export function formatColorRepro(
  azDeg: number,
  elDeg: number,
  patch: DebugTrackPatch | null,
  hazeLocked: boolean,
  haze: Vec3 | null,
  awayEdge: Vec3 | null,
  toonAmount = 0,
): string {
  const url =
    `?sun=${f4(azDeg)},${f4(elDeg)}` +
    (patch ? `&trackpatch=${encodeURIComponent(JSON.stringify(patch))}` : '') +
    `&hazelock=${hazeLocked ? 1 : 0}` +
    (haze ? `&haze=${vec3Param(haze)}` : '') +
    (awayEdge ? `&away=${vec3Param(awayEdge)}` : '') +
    (toonAmount !== 0 ? `&toon=${f4(toonAmount)}` : '');
  const consoleCmd =
    `qa.setSun(${f4(azDeg)}, ${f4(elDeg)}); ` +
    `qa.setTrackPatch(${JSON.stringify(patch)}); ` +
    `qa.lockHaze(${hazeLocked});` +
    (haze && awayEdge ? ` qa.setHazeEndpoints(${vec3Array(haze)},${vec3Array(awayEdge)});` : '') +
    (toonAmount !== 0 ? ` qa.setToon(${f4(toonAmount)});` : '');
  return `${url}\n${consoleCmd}`;
}

// ---- P1.5/P2/horizon 计划 Task 2：云形态档位 + 太阳项证伪开关 ------------------------------

/**
 * `?cloudlook=flat` → 平顶云形态档；其它值（含缺省）一律默认 `'soft'`。
 *
 * 与 `parseBgVisible` 同一套字面量纪律的反向版：唯一显式取值才改变默认，
 * 缺省画面完全不变。原消费端（穹顶侧的 `world.setCloudLook` 接线）已随穹顶云链
 * 删除；parser 保留导出（单测仍锚定字面量纪律），是否连测试一并退役留待后续
 * 裁定——main.ts 现在不 import 它。
 */
export function parseCloudLook(raw: string | null | undefined): 'soft' | 'flat' {
  return raw === 'flat' ? 'flat' : 'soft';
}

/**
 * `?sunoff=1` → 归零背景云的太阳色项（门 4 的证伪开关，spec §11.2）。
 *
 * **bg-cumulus Task 5（2026-11-14）**：旧 patch 层的太阳色项随层退场，
 * world.setSunColor 现为 no-op——本开关对背景云的 A/B 能力已失效，等新层的
 * 等效证伪杠杆（光照方向归零档）在 Task 6 矩阵里重立后再接。开关保留：
 * setSunColor 仍是 main syncSun 的既有通道，海霾/天空轨道照常。
 */
export function parseSunOff(raw: string | null | undefined): boolean {
  return raw === '1';
}

// ---- toon-look Phase 1 计划 Task 1：uToon 总闸 ---------------------------------------------

/**
 * `?toon=<0..1>` → 三渲二总闸强度。与 parseSunSpin 同一套数字纪律，但语义不同：
 * toon 的有效域就是 [0,1]，越界数字是「超范围」而不是「垃圾」——clamp 而不是
 * 拒绝（'1.5'→1、'-0.2'→0）。缺省、空串、非有限数一律 0：默认画面逐位不变。
 * 消费接线在 sky-webgpu 共享 uniform 组（uToon，本任务注入、下游 Task 2/3 接）。
 */
export function parseToon(raw: string | null | undefined): number {
  if (typeof raw !== 'string' || raw.length === 0) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

// ---- free-play visual presets (2026-11-13 loosening) -------------------------------
// `?palette=<sunset|roseDawn|tealNoon|violetDusk>` — unknown/null → null (shipped
// sunset, no patch). `?postfx=<sunset|glowSoft|crisp|noDof>` — same discipline.
// `?bloom=<0..1>` — single-knob threshold override (validated, else null).
// `?dof=0|1` — honest DOF on/off (null = preset decides). `?cam=<preset|dist,height>`
// — chase framing override, partial allowed (`?cam=18,` keeps height).
// `?fov=<30..100>` — base vertical FOV override (portrait default 60).

/** `?palette=<name>` → preset key, else null (no patch = shipped sunset). */
export function parsePaletteName(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const name = raw.trim();
  return name === 'sunset' || name === 'roseDawn' || name === 'tealNoon' || name === 'violetDusk'
    ? name
    : null;
}

/** `?postfx=<name>` → preset key, else null (shipped sunset). */
export function parsePostFxName(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const name = raw.trim();
  return name === 'sunset' || name === 'glowSoft' || name === 'crisp' || name === 'noDof'
    ? name
    : null;
}

/** `?bloom=<0..1>` → threshold override, else null (never throws). */
export function parseBloomThreshold(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

/** `?dof=0|1` → false/true, else null (preset decides). */
export function parseDofEnabled(raw: string | null | undefined): boolean | null {
  if (raw === '0') return false;
  if (raw === '1') return true;
  return null;
}

/** `?cam=<preset|dist,height>` → raw string passthrough (resolved in visual-presets). */
export function parseCamRaw(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return raw.trim();
}

/** `?fov=<30..100>` → base FOV override, else null. */
export function parseFov(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 30 || value > 100) return null;
  return value;
}

// ---- day-night planB Phase 1 计划 Task 1：tod 状态解析 --------------------------------------

/**
 * `?tod=<0..24>` → time-of-day 状态（小时）。与 parseSunSpin 同一套不抛错纪律，
 * 但域是 [0,24] 闭区间且越界**拒绝**而不是 clamp：24.5 是「超范围」不是「可夹成
 * 午夜」——夹取会把用户输错伪装成合法值，null 让 main.ts 回退到反解默认
 * TOD_DEFAULT_H（17.59）。缺省、空串、非数字同为 null。本任务只存状态；
 * syncSun 的消费接线在后续任务。
 */
export function parseTod(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 24) return null;
  return value;
}

/**
 * `?todspeed=<hours/s>` → tod 的推进速度（小时/秒，≥0）。与 parseSunSpin 同一套
 * 数字纪律：缺省、空串、非有限数、负数一律缺省 0——默认画面完全不变；非负数
 * 原样放行（上界归消费任务管：现在没人读它，夹不夹都不影响画面）。
 */
export function parseTodSpeed(raw: string | null | undefined): number {
  if (typeof raw !== 'string' || raw.length === 0) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value;
}
