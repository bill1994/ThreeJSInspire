/**
 * src/debug/color-panel.ts — ?debug=color 悬浮调色面板（计划 2026-11-09 Task 2）。
 *
 * 表现层纪律（R13）：只调 qa 层杠杆（setSun / rotateSun / setTrackPatch /
 * lockHaze / setHazeEndpoints / setChopGate / clearChopGate / setQuality /
 * exportColorState），不直碰 uniform、不直调 world/sea 句柄。唯一例外是只读
 * 展示：海常量表从各 sea 模块 import 真实 export，轨道滑杆初值用纯函数
 * skyTrackAt + applyTrackPatch 算出（与海常量同一"单一来源"纪律，不二次打字）。
 *
 * 颜色空间（约束④）：DOM 拾色器只有 sRGB 字节，写入前 srgbToLinear，显示时
 * linearToSrgbCss（srgbToLinear 的逐字节精确逆）。线性 Vec3 永不进 DOM；
 * console 回显的是 qa/exportColorState 的线性字节（与 formatColorRepro 同一套
 * toFixed(4) 格式），不做自己的转换。
 *
 * 默认路径（约束①）：本模块只在 ?debug=color 时被 main.ts 动态 import；
 * import 失败由 main.ts catch（console.error，游戏继续）。禁区位不暴露（约束⑤）：
 * bloomThreshold 只读展示，CASCADES 的 amplitudePeak 不渲染。
 */
import {
  applyTrackPatch,
  linearToSrgbCss,
  srgbToLinear,
  skyTrackAt,
  type DebugTrackPatch,
  type Vec3,
} from '../sky-track';
import { K4_MARGIN, SUN_ROAD } from '../sea/sun-road';
import { CREST_REFERENCE_METRES, WATER_OPTICS } from '../sea/water-shading';
import { CHOPPINESS } from '../sea/fft-gpu';
import { CASCADES } from '../sea/cascades';
import { RINGS } from '../sea/rings';
import { SEA_BAND_THRESHOLDS } from '../sea/bands';
import { SEA_FOAM_THRESHOLD } from '../sea/foam';

/** 面板消费的 qa 杠杆面（结构化类型——main.ts 的 qa 对象直接兼容）。 */
export interface PanelQa {
  setSun(azDeg: number, elDeg: number): void;
  rotateSun(deg: number): void;
  getSun(): { azimuthDeg: number; elevationDeg: number };
  setTrackPatch(p: DebugTrackPatch | null): void;
  lockHaze(on: boolean): void;
  setHazeEndpoints(haze: Vec3, awayEdge: Vec3): void;
  setChopGate(on: boolean): void;
  clearChopGate(): void;
  setQuality(high: boolean): void;
  exportColorState(): {
    sun: { az: number; el: number };
    patch: DebugTrackPatch | null;
    hazeLocked: boolean;
    haze: Vec3 | null;
    awayEdge: Vec3 | null;
    repro: string;
  };
}

type StyleMap = Partial<CSSStyleDeclaration>;

const FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

const f4 = (n: number): string => n.toFixed(4);

/** (−180,180] → [0,360)，方位滑杆的显示域。 */
const az360 = (deg: number): number => ((deg % 360) + 360) % 360;

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: StyleMap = {},
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node.style, style);
  if (text) node.textContent = text;
  return node;
}

interface SliderHandles {
  input: HTMLInputElement;
  value: HTMLSpanElement;
}

const ROW_STYLE: StyleMap = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  margin: '2px 0',
};
const LABEL_STYLE: StyleMap = { flex: '0 0 92px', color: '#aebad2' };
const VALUE_STYLE: StyleMap = { flex: '0 0 52px', textAlign: 'right', color: '#8fd0ff' };
const CONTROL_STYLE: StyleMap = { flex: '1 1 auto', minWidth: '0' };
const BUTTON_STYLE: StyleMap = {
  font: `10px/1.3 ${FONT}`,
  padding: '3px 7px',
  margin: '2px 4px 2px 0',
  background: '#1b2436',
  color: '#cfe0ff',
  border: '1px solid #44506b',
  borderRadius: '4px',
  cursor: 'pointer',
};

function addRow(parent: HTMLElement, labelText: string): { row: HTMLDivElement; value: HTMLSpanElement } {
  const row = el('div', ROW_STYLE);
  const label = el('span', LABEL_STYLE, labelText);
  const value = el('span', VALUE_STYLE);
  row.append(label, value);
  parent.appendChild(row);
  return { row, value };
}

function addSlider(
  parent: HTMLElement,
  labelText: string,
  min: number,
  max: number,
  step: number,
  decimals: number,
  initial: number,
  apply: (v: number) => void,
  log: (v: number) => void,
  ac: AbortController,
  dataDcp: string,
): SliderHandles {
  const { row, value } = addRow(parent, labelText);
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(clamp(initial, min, max));
  input.dataset.dcp = dataDcp;
  Object.assign(input.style, CONTROL_STYLE);
  value.textContent = Number(input.value).toFixed(decimals);
  input.addEventListener(
    'input',
    () => {
      const v = input.valueAsNumber;
      if (!Number.isFinite(v)) return;
      value.textContent = v.toFixed(decimals);
      apply(v);
    },
    { signal: ac.signal },
  );
  input.addEventListener('change', () => log(input.valueAsNumber), { signal: ac.signal });
  row.insertBefore(input, value);
  return { input, value };
}

function addColor(
  parent: HTMLElement,
  labelText: string,
  initialHex: string,
  apply: (hex: string) => void,
  log: (hex: string) => void,
  ac: AbortController,
  dataDcp: string,
): HTMLInputElement {
  const { row, value } = addRow(parent, labelText);
  const input = document.createElement('input');
  input.type = 'color';
  input.value = initialHex;
  input.dataset.dcp = dataDcp;
  Object.assign(input.style, { ...CONTROL_STYLE, height: '20px', padding: '0' });
  value.textContent = initialHex;
  input.addEventListener(
    'input',
    () => {
      value.textContent = input.value;
      apply(input.value);
    },
    { signal: ac.signal },
  );
  input.addEventListener('change', () => log(input.value), { signal: ac.signal });
  row.insertBefore(input, value);
  return input;
}

function addButton(
  parent: HTMLElement,
  text: string,
  onClick: () => void,
  ac: AbortController,
  dataDcp: string,
): HTMLButtonElement {
  const button = el('button', BUTTON_STYLE, text);
  button.type = 'button';
  button.dataset.dcp = dataDcp;
  button.addEventListener('click', onClick, { signal: ac.signal });
  parent.appendChild(button);
  return button;
}

function note(parent: HTMLElement, text: string): HTMLDivElement {
  const n = el('div', { font: `10px/1.4 ${FONT}`, color: '#8fa2c4', margin: '2px 0 4px' }, text);
  parent.appendChild(n);
  return n;
}

function group(root: HTMLElement, title: string): { body: HTMLDivElement } {
  const wrap = el('div', { margin: '0 0 10px' });
  const heading = el(
    'div',
    {
      font: `600 11px/1.4 ${FONT}`,
      color: '#ffd9a0',
      borderBottom: '1px solid #3a4358',
      paddingBottom: '2px',
      marginBottom: '4px',
    },
    title,
  );
  const body = el('div', {});
  wrap.append(heading, body);
  root.appendChild(wrap);
  return { body };
}

/**
 * 挂载面板。返回 dispose()（移除 DOM + 解绑全部监听 + 停 sunspin）；
 * 动态 import 失败时 main.ts catch，本函数根本不会执行。
 */
export function mountColorPanel(qa: PanelQa): { dispose(): void } {
  const ac = new AbortController();

  const root = el('div', {
    position: 'fixed',
    top: '8px',
    right: '8px',
    width: '308px',
    maxHeight: '94vh',
    overflowY: 'auto',
    zIndex: '10000',
    background: 'rgba(10, 13, 22, 0.92)',
    color: '#cfd6e4',
    font: `11px/1.45 ${FONT}`,
    padding: '8px',
    borderRadius: '6px',
    border: '1px solid #3a4358',
    boxSizing: 'border-box',
    textShadow: 'none',
  });
  root.id = 'debug-color-panel';

  // 当前方位（度，[0,360)）。滑杆动作一律读活值：仰角拖动保持"当前"方位。
  const azNow = (): number => az360(qa.getSun().azimuthDeg);

  // ---- 太阳组 ------------------------------------------------------------------------
  const sunGroup = group(root, '太阳（sun）');

  const elSlider = addSlider(
    sunGroup.body,
    'elevation°',
    -8,
    15,
    0.1,
    1,
    qa.getSun().elevationDeg,
    (v) => qa.setSun(azNow(), v),
    (v) => console.info(`[debug-panel] qa.setSun(${f4(azNow())}, ${v.toFixed(1)})`),
    ac,
    'elevation',
  );
  note(sunGroup.body, '＞6.97°＝参考档（轨道不扩展）');

  const azSlider = addSlider(
    sunGroup.body,
    'azimuth°',
    0,
    360,
    0.5,
    1,
    azNow(),
    (v) => qa.setSun(v, qa.getSun().elevationDeg),
    (v) => console.info(`[debug-panel] qa.setSun(${v.toFixed(1)}, ${f4(qa.getSun().elevationDeg)})`),
    ac,
    'azimuth',
  );

  const keyframeRow = el('div', { margin: '4px 0 2px' });
  sunGroup.body.appendChild(keyframeRow);
  for (const elDeg of [6.97, 0, -4, -8]) {
    addButton(
      keyframeRow,
      `${elDeg}°`,
      () => {
        qa.setSun(azNow(), elDeg);
        elSlider.input.value = String(elDeg);
        elSlider.value.textContent = elDeg.toFixed(1);
        console.info(`[debug-panel] qa.setSun(${f4(azNow())}, ${elDeg})（关键帧）`);
      },
      ac,
      'keyframe',
    );
  }

  // sunspin 播放/暂停（R16）：?sunspin 是启动期常量、无运行时 setter——面板内
  // 自带状态机，播放时每帧 qa.rotateSun(speed·dt)；只复用其单位（度/秒）与
  // ≤360 上限，速度滑杆 0..60。
  let spinning = false;
  let spinRaf = 0;
  let spinLastT = 0;
  const spinButton = addButton(
    keyframeRow,
    'sunspin: OFF',
    () => {
      if (spinning) stopSpin();
      else startSpin();
    },
    ac,
    'sunspin-toggle',
  );
  let spinSpeed = 10; // 度/秒；R16 上限 360（滑杆 0..60）
  const speedSlider = addSlider(
    sunGroup.body,
    'sunspin °/s',
    0,
    60,
    0.5,
    1,
    spinSpeed,
    (v) => {
      spinSpeed = Math.min(v, 360); // R16 上限
    },
    (v) => console.info(`[debug-panel] sunspin speed ${Math.min(v, 360).toFixed(1)}°/s`),
    ac,
    'sunspin-speed',
  );

  const syncAzDisplay = (): void => {
    const az = azNow();
    azSlider.input.value = String(az);
    azSlider.value.textContent = az.toFixed(1);
  };

  const updateSpinButton = (): void => {
    spinButton.textContent = spinning ? 'sunspin: ON' : 'sunspin: OFF';
    spinButton.style.background = spinning ? '#5a3a12' : BUTTON_STYLE.background as string;
  };

  const spinTick = (t: number): void => {
    if (!spinning) return;
    const dt = spinLastT ? Math.min((t - spinLastT) / 1000, 0.1) : 0;
    spinLastT = t;
    if (spinSpeed > 0 && dt > 0) qa.rotateSun(spinSpeed * dt);
    syncAzDisplay();
    spinRaf = requestAnimationFrame(spinTick);
  };

  function startSpin(): void {
    if (spinning) return;
    spinning = true;
    spinLastT = 0;
    console.info(`[debug-panel] sunspin ON — ${spinSpeed.toFixed(1)}°/s（每帧 qa.rotateSun(deg·dt)）`);
    spinRaf = requestAnimationFrame(spinTick);
    updateSpinButton();
  }

  function stopSpin(): void {
    if (!spinning) return;
    spinning = false;
    cancelAnimationFrame(spinRaf);
    console.info('[debug-panel] sunspin OFF');
    updateSpinButton();
  }

  // ---- 轨道组 ------------------------------------------------------------------------
  const trackGroup = group(root, '轨道（track patch）');

  // 滑杆初值 = 当前生效轨道状态：纯函数 skyTrackAt(当前仰角) + URL 补丁。
  // 补丁本体由面板本地持有（{...current, field} 整字段替换），只经
  // qa.setTrackPatch 写入。
  const base = applyTrackPatch(skyTrackAt(qa.getSun().elevationDeg), qa.exportColorState().patch);
  let patch: DebugTrackPatch = { ...(qa.exportColorState().patch ?? {}) };

  const pushPatch = (): void => {
    qa.setTrackPatch({ ...patch });
  };
  const logPatch = (): void => {
    console.info(`[debug-panel] qa.setTrackPatch(${JSON.stringify(patch)})`);
  };

  const scalar = (
    labelText: string,
    field: 'nightWeight' | 'glowGain' | 'glowPow' | 'awayGain' | 'discGain' | 'starOpacity',
    min: number,
    max: number,
    step: number,
    decimals: number,
  ): void => {
    addSlider(
      trackGroup.body,
      labelText,
      min,
      max,
      step,
      decimals,
      base[field],
      (v) => {
        patch = { ...patch, [field]: v };
        pushPatch();
      },
      () => logPatch(),
      ac,
      field,
    );
  };

  scalar('nightWeight', 'nightWeight', 0, 1, 0.01, 2);
  scalar('glowGain', 'glowGain', 0, 1, 0.01, 2);
  scalar('glowPow', 'glowPow', 60, 200, 1, 0);
  scalar('awayGain', 'awayGain', 0, 1, 0.01, 2);
  scalar('discGain', 'discGain', 0, 1, 0.01, 2);
  scalar('starOpacity', 'starOpacity', 0, 1, 0.01, 2);

  // floorLinear 三通道微调（线性值；关键帧量级 0..0.005，范围给到 0.02）。
  for (const [i, channel] of ['R', 'G', 'B'].entries()) {
    addSlider(
      trackGroup.body,
      `floor.${channel}`,
      0,
      0.02,
      0.0005,
      4,
      base.floorLinear[i],
      (v) => {
        const current: Vec3 = patch.floorLinear ?? base.floorLinear;
        const next: [number, number, number] = [...current];
        next[i] = v;
        patch = { ...patch, floorLinear: next };
        pushPatch();
      },
      () => logPatch(),
      ac,
      `floor-${channel.toLowerCase()}`,
    );
  }

  // 颜色拾取（约束④）：sRGB hex → srgbToLinear → patch；初值用 linearToSrgbCss
  // 逐字节逆变换回显，绝不把线性 Vec3 塞进 DOM。
  const colorField = (field: 'awayColor' | 'sunTint' | 'cloudHaze', labelText: string): void => {
    addColor(
      trackGroup.body,
      labelText,
      linearToSrgbCss(base[field]),
      (hex) => {
        patch = { ...patch, [field]: srgbToLinear(hex) };
        pushPatch();
      },
      () => logPatch(),
      ac,
      field,
    );
  };
  colorField('awayColor', 'awayColor');
  colorField('sunTint', 'sunTint');
  colorField('cloudHaze', 'cloudHaze');

  // 禁区（约束⑤）：bloom threshold 只读展示。
  const bloomRow = el('div', ROW_STYLE);
  bloomRow.append(
    el('span', LABEL_STYLE, 'bloomThreshold'),
    el('span', { color: '#ff9a76' }, `${base.bloomThreshold.toFixed(2)}（只读禁区，0.82＝参考档）`),
  );
  trackGroup.body.appendChild(bloomRow);

  // ---- 海面组 ------------------------------------------------------------------------
  const seaGroup = group(root, '海面（sea）');

  const lockRow = el('label', { ...ROW_STYLE, padding: '2px 4px', borderRadius: '4px' });
  const lockBox = document.createElement('input');
  lockBox.type = 'checkbox';
  lockBox.dataset.dcp = 'haze-lock';
  lockRow.append(lockBox, el('span', { color: '#aebad2' }, 'haze 锁（锁定后 syncSun 停止重算端点）'));
  seaGroup.body.appendChild(lockRow);

  const endpointsNote = note(seaGroup.body, '未锁定：端点被 syncSun 每帧重算（拾色器禁用）');

  // 端点本地副本：锁定瞬间从 qa.exportColorState 闭包缓存刷新；之后每次写都
  // 走 qa.setHazeEndpoints(haze, awayEdge)（一次必须同时给两端）。
  let endpoints: { haze: Vec3; awayEdge: Vec3 } | null = null;

  const refreshEndpointsFromQa = (): boolean => {
    const st = qa.exportColorState();
    if (!st.haze || !st.awayEdge) return false;
    endpoints = { haze: [...st.haze], awayEdge: [...st.awayEdge] };
    hazeInput.value = linearToSrgbCss(endpoints.haze);
    awayInput.value = linearToSrgbCss(endpoints.awayEdge);
    return true;
  };

  const hazeInput = addColor(
    seaGroup.body,
    'haze 端点',
    '#000000',
    (hex) => {
      if (!endpoints) return;
      const haze = srgbToLinear(hex);
      endpoints = { haze, awayEdge: endpoints.awayEdge };
      qa.setHazeEndpoints(haze, endpoints.awayEdge);
      console.info(
        `[debug-panel] qa.setHazeEndpoints([${haze.map(f4).join(',')}],[${endpoints.awayEdge.map(f4).join(',')}])`,
      );
    },
    (hex) => console.info(`[debug-panel] haze endpoint ${hex} → linear（qa.setHazeEndpoints）`),
    ac,
    'haze-color',
  );
  const awayInput = addColor(
    seaGroup.body,
    'awayEdge 端点',
    '#000000',
    (hex) => {
      if (!endpoints) return;
      const awayEdge = srgbToLinear(hex);
      endpoints = { haze: endpoints.haze, awayEdge };
      qa.setHazeEndpoints(endpoints.haze, awayEdge);
      console.info(
        `[debug-panel] qa.setHazeEndpoints([${endpoints.haze.map(f4).join(',')}],[${awayEdge.map(f4).join(',')}])`,
      );
    },
    (hex) => console.info(`[debug-panel] awayEdge endpoint ${hex} → linear（qa.setHazeEndpoints）`),
    ac,
    'away-color',
  );
  hazeInput.disabled = true;
  awayInput.disabled = true;

  lockBox.addEventListener(
    'change',
    () => {
      const on = lockBox.checked;
      qa.lockHaze(on); // qa 层在状态翻转时 warn 一次
      if (on) {
        const ok = refreshEndpointsFromQa();
        hazeInput.disabled = !ok;
        awayInput.disabled = !ok;
        endpointsNote.textContent = ok
          ? '已锁定：端点定住，可编辑（sea haze 不再跟太阳）'
          : '已锁定，但尚无端点缓存（先跑一帧再锁）';
        lockRow.style.background = 'rgba(120, 70, 20, 0.55)';
      } else {
        hazeInput.disabled = true;
        awayInput.disabled = true;
        endpointsNote.textContent = '未锁定：端点被 syncSun 每帧重算（拾色器禁用）';
        lockRow.style.background = '';
      }
      console.info(`[debug-panel] qa.lockHaze(${on})`);
    },
    { signal: ac.signal },
  );

  // 快捷按钮行。
  const seaButtonRow = el('div', { margin: '4px 0 2px' });
  seaGroup.body.appendChild(seaButtonRow);

  let nochop = false;
  const nochopButton = addButton(
    seaButtonRow,
    'nochop: OFF',
    () => {
      nochop = !nochop;
      if (nochop) qa.setChopGate(false);
      else qa.clearChopGate();
      nochopButton.textContent = `nochop: ${nochop ? 'ON' : 'OFF'}`;
      nochopButton.style.background = nochop ? '#5a3a12' : (BUTTON_STYLE.background as string);
      console.info(
        `[debug-panel] ${nochop ? 'qa.setChopGate(false)' : 'qa.clearChopGate()'}（与 ?sea=nochop 等价，换档不失效）`,
      );
    },
    ac,
    'nochop-toggle',
  );

  addButton(
    seaButtonRow,
    'quality high',
    () => {
      qa.setQuality(true);
      console.info('[debug-panel] qa.setQuality(true)');
    },
    ac,
    'quality-high',
  );
  addButton(
    seaButtonRow,
    'quality low',
    () => {
      qa.setQuality(false);
      console.info('[debug-panel] qa.setQuality(false)');
    },
    ac,
    'quality-low',
  );
  addButton(
    seaButtonRow,
    '?sea=debug 提示',
    () => {
      console.info('[debug-panel] sea 假色模式是启动期参数：URL 追加 &sea=debug 后重载页面');
    },
    ac,
    'sea-debug-hint',
  );

  // 海常量只读表（约束⑤）：真实 export，只展示、无滑杆；CASCADES 显式剔除
  // amplitudePeak（禁区字段不渲染）。
  note(seaGroup.body, '海常量（真实 export，只读）');
  const seaTable = el('div', {
    whiteSpace: 'pre-wrap',
    font: `10px/1.5 ${FONT}`,
    color: '#8fa2c4',
    margin: '0 0 6px',
    userSelect: 'all',
  });
  const cascadesSafe = CASCADES.map((c) => ({ name: c.name, tileMetres: c.tileMetres, bandMetres: c.bandMetres }));
  seaTable.textContent = [
    `SUN_ROAD ${JSON.stringify(SUN_ROAD)}`,
    `K4_MARGIN ${K4_MARGIN}`,
    `CREST_REFERENCE_METRES ${CREST_REFERENCE_METRES}`,
    `CHOPPINESS ${CHOPPINESS}`,
    `CASCADES ${JSON.stringify(cascadesSafe)}`,
    `RINGS ${JSON.stringify(RINGS)}`,
    `SEA_BAND_THRESHOLDS ${JSON.stringify(SEA_BAND_THRESHOLDS)}`,
    `SEA_FOAM_THRESHOLD ${SEA_FOAM_THRESHOLD}`,
    `WATER_OPTICS ${JSON.stringify(WATER_OPTICS)}`,
  ].join('\n');
  seaGroup.body.appendChild(seaTable);

  // ---- 导出组 ------------------------------------------------------------------------
  const exportGroup = group(root, '导出（repro）');

  const reproBox = document.createElement('textarea');
  reproBox.readOnly = true;
  reproBox.rows = 3;
  reproBox.dataset.dcp = 'repro-box';
  Object.assign(reproBox.style, {
    width: '100%',
    boxSizing: 'border-box',
    font: `10px/1.4 ${FONT}`,
    background: '#0b0f18',
    color: '#cfe3ff',
    border: '1px solid #3a4358',
    borderRadius: '4px',
    padding: '4px',
    whiteSpace: 'pre',
  } satisfies StyleMap);
  exportGroup.body.appendChild(reproBox);

  const refreshRepro = (): string => {
    const repro = qa.exportColorState().repro;
    reproBox.value = repro;
    return repro;
  };
  refreshRepro();

  addButton(
    exportGroup.body,
    '复制复现命令',
    () => {
      const repro = refreshRepro();
      console.info(`[debug-panel] repro（两行：URL / console）：\n${repro}`);
      navigator.clipboard
        .writeText(repro)
        .then(() => console.info('[debug-panel] repro 已写剪贴板'))
        .catch((err: unknown) => console.error('[debug-panel] 剪贴板不可用，请从文本框手动复制', err));
    },
    ac,
    'copy-repro',
  );

  document.body.appendChild(root);
  console.info('[debug-panel] mounted — ?debug=color（表现层只经 qa 杠杆）');

  return {
    dispose(): void {
      stopSpin();
      ac.abort();
      root.remove();
      console.info('[debug-panel] disposed');
    },
  };
}
