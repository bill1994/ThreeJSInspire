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
 * `?dome=0` 关掉穹顶云层；其它值（含缺省）一律当开。
 *
 * 门 1（云层覆盖率）的唯一量法就是同机位开/关两帧做差，没有这个开关量不了。
 */
export function parseDomeVisible(raw: string | null | undefined): boolean {
  return raw !== '0';
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
 * 时同样省掉整个 `trackpatch` 段（fresh URL 加载即默认轨道，语义等价）。
 */
export function formatColorRepro(
  azDeg: number,
  elDeg: number,
  patch: DebugTrackPatch | null,
  hazeLocked: boolean,
  haze: Vec3 | null,
  awayEdge: Vec3 | null,
): string {
  const url =
    `?sun=${f4(azDeg)},${f4(elDeg)}` +
    (patch ? `&trackpatch=${encodeURIComponent(JSON.stringify(patch))}` : '') +
    `&hazelock=${hazeLocked ? 1 : 0}` +
    (haze ? `&haze=${vec3Param(haze)}` : '') +
    (awayEdge ? `&away=${vec3Param(awayEdge)}` : '');
  const consoleCmd =
    `qa.setSun(${f4(azDeg)}, ${f4(elDeg)}); ` +
    `qa.setTrackPatch(${JSON.stringify(patch)}); ` +
    `qa.lockHaze(${hazeLocked});` +
    (haze && awayEdge ? ` qa.setHazeEndpoints(${vec3Array(haze)},${vec3Array(awayEdge)});` : '');
  return `${url}\n${consoleCmd}`;
}

// ---- dome-cloud P1.5/P2/horizon 计划 Task 2：云形态档位 + 太阳项证伪开关 --------------------

/**
 * `?cloudlook=flat` → 平顶云形态档；其它值（含缺省）一律默认 `'soft'`。
 *
 * 与 `parseDomeVisible` 同一套字面量纪律的反向版：唯一显式取值才改变默认，
 * 缺省画面完全不变。本任务只提供 parser，`?cloudlook` 的消费接线在后续任务
 * （Task 6）；现在 main.ts 不 import 它，是刻意的。
 */
export function parseCloudLook(raw: string | null | undefined): 'soft' | 'flat' {
  return raw === 'flat' ? 'flat' : 'soft';
}

/**
 * `?sunoff=1` → 归零穹顶云的太阳色项（门 4 的证伪开关，spec §11.2）。
 *
 * 真时启动先调一次 `world.setSunColor([0,0,0])`，且 main.ts `syncSun` 的逐帧
 * `setSunColor(sunColorFor(el))` 被跳过——太阳项彻底归零而不是调暗，A/B 两帧
 * 差分才能把「云上光影来自太阳项」钉死。只动 `setSunColor` 这一个消费端；
 * 灯光、海霾、天空轨道照常，不引入第二个光源。
 */
export function parseSunOff(raw: string | null | undefined): boolean {
  return raw === '1';
}
