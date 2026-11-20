import type { HeadlightMode } from './headlight';
/**
 * src/hud.ts — HUD DOM, created from code (index.html stays untouched).
 *
 * Layout zones at the logical 720x1280 portrait frame:
 *   top-left     speed readout + throttle bar      (inside safe-area insets)
 *   top-right    audio mixer panel                 (only pointer-events:auto region)
 *   bottom-left  status line + hint                (inside safe-area insets)
 *   the centre column is deliberately kept empty so the sun disc and the plane
 *   silhouette stay unobstructed.
 *
 * Reads are event-driven: text is written only when the value actually changes, so
 * the loop does no DOM churn and no string allocation per frame.
 */
import type { BusName as Bus } from './audio';
import { hudSafeArea } from './portrait';

export interface HeadlightControl { get(): HeadlightMode; set(mode: HeadlightMode): void }

export interface TimeOfDayControl {
  get(): number;
  set(hours: number): void;
}

/** Slider defaults, shared with game.ts so the mixers and the audio graph agree. */
export const HUD_BUS_DEFAULTS: Record<Bus, number> = {
  master: 0.8,
  music: 0.62,
  sfx: 0.75,
  ambience: 0.5,
  ui: 0.7,
};

export interface HudReadout {
  speed: number;
  speed01: number;
  throttle: number;
  bank: number;
  climb: number;
  mode: string;
  fps: number;
  audioState: string;
  /** 0..1 stylised stall intensity; > 0.5 flashes the STALL block. */
  stall01: number;
  /** P0-5 stall warning: flashes the STALL block one beat before stall01. */
  stallWarn: boolean;
}

export interface HudHandle {
  element: HTMLElement;
  update(readout: HudReadout): void;
  setVisible(visible: boolean): void;
  /**
   * HUD 折叠（2026-11-14）：常态是右上角一枚 `+ UI` 芯片，点开才是完整面板。
   * 外部只通过这里改状态——按钮与外部入口写同一个 `applyCollapsed`，不会打架。
   */
  setCollapsed(collapsed: boolean): void;
  isCollapsed(): boolean;
  /**
   * 0..1 white fog over the frame — the fly-through-clouds cue (DOM layer, not
   * volumetrics). `tintCss` 可选：兜底纱随太阳方位着色（`veilTintCss`），
   * 缺省保持出厂米色。
   */
  setWhiteout(v: number, tintCss?: string): void;
  /**
   * P2-2 G 黑边：dive 改出瞬间的 0.25s 暗角（DOM 径向渐变层，不是后期）。
   * FOV 回弹不走这里——rig 的 fovKick 跟 speed01，改出掉速自动 eases back。
   */
  setG(v: number): void;
  dispose(): void;
}

const BUS_ROWS: Array<{ bus: Bus; label: string }> = [
  { bus: 'master', label: 'MASTER' },
  { bus: 'music', label: 'MUSIC' },
  { bus: 'sfx', label: 'SFX' },
  { bus: 'ambience', label: 'AMB' },
  { bus: 'ui', label: 'UI' },
];

const STYLE_ID = 'porco-hud-style';
const CSS = `
.porco-hud{position:absolute;inset:0;pointer-events:none;font-family:ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif;
  color:#f7efe2;text-shadow:0 1px 2px rgba(0,0,0,.55);-webkit-font-smoothing:antialiased;z-index:10;
  padding:max(14px,env(safe-area-inset-top)) max(14px,env(safe-area-inset-right)) max(14px,env(safe-area-inset-bottom)) max(14px,env(safe-area-inset-left));
  box-sizing:border-box;display:flex;flex-direction:column;justify-content:space-between;user-select:none}
.porco-hud__top,.porco-hud__bottom{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
.porco-hud__bottom{align-items:flex-end}
.porco-panel{background:rgba(18,14,20,.46);border:1px solid rgba(255,205,160,.26);border-radius:10px;
  padding:9px 11px;backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px)}
.porco-status{font-size:11px;line-height:1.5;letter-spacing:.12em;opacity:.9;font-variant-numeric:tabular-nums}
/* SC1: speed reads as an instrument arc instead of a stat card. No panel background. */
.porco-arc-wrap{display:flex;flex-direction:column;align-items:flex-start;
  filter:drop-shadow(0 1px 3px rgba(0,0,0,.55))}
.porco-arc{width:clamp(92px,21vw,128px);height:auto;overflow:visible;margin-bottom:-4px}
.porco-arc__track{fill:none;stroke:rgba(255,255,255,.16);stroke-width:5;stroke-linecap:round}
.porco-arc__fill{fill:none;stroke:#ffb066;stroke-width:5;stroke-linecap:round;
  stroke-dasharray:151;stroke-dashoffset:151;transition:stroke-dashoffset .08s linear}
.porco-arc__fill--cool{stroke:#8ee6c8;stroke-dasharray:107;stroke-dashoffset:107}
.porco-speed__value{font-size:clamp(20px,3.4vh,30px);font-weight:700;line-height:1;letter-spacing:.02em;
  font-variant-numeric:tabular-nums;margin-top:-6px}
.porco-speed__unit{font-size:9px;letter-spacing:.22em;opacity:.62;margin-top:1px}
.porco-status b{font-weight:700;color:#ffd9a8}
.porco-hint{font-size:10px;letter-spacing:.14em;opacity:.52;margin-top:5px}
.porco-credit{font-size:8px;letter-spacing:.1em;opacity:.34;margin-top:3px}
.porco-mixer{pointer-events:auto;display:flex;flex-direction:column;gap:5px;min-width:clamp(140px,38vw,196px)}
.porco-mixer__row{display:flex;align-items:center;gap:7px;font-size:9px;letter-spacing:.16em;opacity:.86}
.porco-mixer__row span{width:46px;flex:none}
.porco-mixer input[type=range]{-webkit-appearance:none;appearance:none;flex:1;height:16px;background:transparent;margin:0}
.porco-mixer input[type=range]::-webkit-slider-runnable-track{height:3px;border-radius:2px;background:rgba(255,255,255,.24)}
.porco-mixer input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:13px;height:13px;margin-top:-5px;
  border-radius:50%;background:#ffb066;border:1px solid rgba(0,0,0,.35)}
.porco-mixer input[type=range]::-moz-range-track{height:3px;border-radius:2px;background:rgba(255,255,255,.24)}
.porco-mixer input[type=range]::-moz-range-thumb{width:13px;height:13px;border-radius:50%;background:#ffb066;border:none}
.porco-mixer__state{font-size:9px;letter-spacing:.16em;opacity:.55}
.porco-time{display:flex;flex-direction:column;gap:7px;padding-bottom:10px;margin-bottom:3px;
  border-bottom:1px solid rgba(255,205,160,.22)}
.porco-time__heading,.porco-time__ticks{display:flex;justify-content:space-between;font-size:11px;letter-spacing:.04em}
.porco-time output{font-variant-numeric:tabular-nums;color:#ffd9a8}
.porco-time__ticks{font-size:9px;opacity:.65}
.porco-time input[type=range]{min-height:28px;width:100%;cursor:ew-resize;touch-action:none}
.porco-time__presets{display:flex;gap:4px}
.porco-time__presets button{flex:1;min-height:30px;padding:2px 4px;border:1px solid rgba(255,205,160,.25);
  border-radius:5px;background:rgba(255,255,255,.05);color:inherit;font:inherit;font-size:10px;cursor:pointer}
.porco-time input:focus-visible,.porco-time button:focus-visible{outline:2px solid #ffb066;outline-offset:2px}
.porco-stall{margin-top:8px;display:inline-block;padding:3px 9px;border-radius:6px;font-size:11px;font-weight:700;
  letter-spacing:.24em;color:#ffd2c4;background:rgba(182,54,41,.55);border:1px solid rgba(255,124,94,.5);
  opacity:0;transition:opacity .12s linear}
.porco-stall--on{opacity:1;animation:porco-stall-blink .5s steps(1,end) infinite}
.porco-stall--warn{opacity:.55}
@keyframes porco-stall-blink{0%,60%{opacity:1}61%,100%{opacity:.25}}
.porco-whiteout{position:absolute;inset:0;background:#e8dfd6;opacity:0;pointer-events:none}
.porco-g{position:absolute;inset:0;opacity:0;pointer-events:none;
  background:radial-gradient(ellipse at center,transparent 52%,rgba(2,2,6,.78) 100%)}
/* 折叠（2026-11-14）：常态只留一枚 + UI 芯片；点开才是完整面板，同一位上换成 − 收回。
   两态用同一个按钮——目标不跳位，玩家不用重新瞄准。 */
.porco-hud__right{display:flex;flex-direction:column;align-items:flex-end;gap:6px}
.porco-hud__toggle{pointer-events:auto;appearance:none;-webkit-appearance:none;font:inherit;color:inherit;
  cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;
  min-width:44px;min-height:44px;padding:0 12px;box-sizing:border-box;
  background:rgba(18,14,20,.46);border:1px solid rgba(255,205,160,.26);border-radius:10px;
  backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);
  font-size:10px;letter-spacing:.18em;text-transform:uppercase;
  transition:background .12s linear,border-color .12s linear}
.porco-hud__toggle:hover{background:rgba(38,28,38,.62);border-color:rgba(255,205,160,.5)}
.porco-hud__toggle:active{background:rgba(60,42,40,.7)}
.porco-hud__toggle:focus-visible{outline:2px solid #ffb066;outline-offset:2px}
.porco-hud__toggle-glyph{font-size:15px;font-weight:700;line-height:1;color:#ffb066}
.porco-hud__toggle-label{line-height:1}
.porco-hud:not(.porco-hud--collapsed) .porco-hud__toggle-label{display:none}
/* 折叠态只藏仪器与混音台。STALL 警告与字幕是信息，不是装饰——一起藏掉就是拿安全换清爽。 */
.porco-hud--collapsed .porco-arc-wrap,
.porco-hud--collapsed .porco-mixer,
.porco-hud--collapsed .porco-hud__bottom{display:none}
@media (prefers-reduced-motion: reduce){
  .porco-hud__toggle{transition:none}
}
`;

export function initHud(opts: { onBusChange?: (bus: Bus, slider01: number) => void; timeOfDay?: TimeOfDayControl; headlight?: HeadlightControl } = {}): HudHandle {
  const doc = document;
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    doc.head.append(style);
  }

  const root = doc.createElement('div');
  root.className = 'porco-hud';
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'off');

  // whiteout layer first, so every HUD element paints above the fog
  const whiteout = doc.createElement('div');
  whiteout.className = 'porco-whiteout';
  root.append(whiteout);
  // P2-2 G 黑边层：白纱之下、HUD 之下——暗角只压画面，不压字。
  const gLayer = doc.createElement('div');
  gLayer.className = 'porco-g';
  root.append(gLayer);

  // ---- top-left: speed as an instrument arc (SC1). No panel: the arc, the number and the
  // throttle ring float on the frame. `porco-panel` is now used only by the mixer.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SPEED_ARC_LEN = 151;   // pi * 48, the outer radius below
  const THROTTLE_ARC_LEN = 107; // pi * 34, the inner ring
  const arcPath = (r: number): string => `M${60 - r} 66 A${r} ${r} 0 0 1 ${60 + r} 66`;

  const speedArc = doc.createElementNS(SVG_NS, 'svg') as SVGElement;
  speedArc.setAttribute('class', 'porco-arc');
  speedArc.setAttribute('viewBox', '0 0 120 72');
  const speedTrack = doc.createElementNS(SVG_NS, 'path') as SVGElement;
  speedTrack.setAttribute('class', 'porco-arc__track');
  speedTrack.setAttribute('d', arcPath(48));
  const throttleArc = doc.createElementNS(SVG_NS, 'path') as SVGElement;
  throttleArc.setAttribute('class', 'porco-arc__fill porco-arc__fill--cool');
  throttleArc.setAttribute('d', arcPath(34));
  const speedFill = doc.createElementNS(SVG_NS, 'path') as SVGElement;
  speedFill.setAttribute('class', 'porco-arc__fill');
  speedFill.setAttribute('d', arcPath(48));
  speedArc.append(speedTrack, throttleArc, speedFill);

  const speedValue = doc.createElement('div');
  speedValue.className = 'porco-speed__value';
  speedValue.textContent = '0';
  const speedUnit = doc.createElement('div');
  speedUnit.className = 'porco-speed__unit';
  speedUnit.textContent = 'KM/H';

  const speedPanel = doc.createElement('div');
  speedPanel.className = 'porco-arc-wrap';
  speedPanel.append(speedArc, speedValue, speedUnit);

  // STALL warning: an edge pulse plus a word, no red block.
  const stallWarn = doc.createElement('div');
  stallWarn.className = 'porco-stall';
  stallWarn.textContent = 'STALL';

  const topLeft = doc.createElement('div');
  topLeft.append(speedPanel, stallWarn);

  // ---- top-right: audio mixer (the only interactive region)
  const mixer = doc.createElement('div');
  mixer.className = 'porco-panel porco-mixer';
  let refreshTime = (): void => {};
  if (opts.timeOfDay) {
    const control = opts.timeOfDay;
    const time = doc.createElement('div');
    time.className = 'porco-time';
    const heading = doc.createElement('label');
    heading.className = 'porco-time__heading';
    heading.htmlFor = 'porco-time-of-day';
    heading.textContent = '时间';
    const readout = doc.createElement('output');
    heading.append(readout);
    const input = doc.createElement('input');
    input.id = 'porco-time-of-day';
    input.type = 'range';
    input.min = '0'; input.max = '24'; input.step = String(1 / 60);
    input.setAttribute('aria-label', '时间');
    refreshTime = () => {
      const h = Math.min(24, Math.max(0, control.get()));
      const minutes = Math.round(h * 60);
      const label = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
      if (readout.value !== label) readout.value = label;
      if (Math.round(Number(input.value) * 60) !== minutes) input.value = String(minutes / 60);
      if (input.getAttribute('aria-valuetext') !== label) input.setAttribute('aria-valuetext', label);
    };
    const selectTime = (h: number) => { control.set(h); refreshTime(); };
    input.addEventListener('input', () => selectTime(Number(input.value)));
    const ticks = doc.createElement('div');
    ticks.className = 'porco-time__ticks';
    for (const label of ['00:00', '06:00', '12:00', '18:00', '24:00']) {
      const tick = doc.createElement('span'); tick.textContent = label; ticks.append(tick);
    }
    const presets = doc.createElement('div');
    presets.className = 'porco-time__presets';
    for (const [label, h] of [['清晨', 7], ['正午', 12], ['夕阳', 17.59], ['夜晚', 0]] as const) {
      const button = doc.createElement('button'); button.type = 'button'; button.textContent = label;
      button.addEventListener('click', () => selectTime(h)); presets.append(button);
    }
    // Slider drags and keyboard adjustments must never steer the aircraft.
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'keydown', 'keyup']) {
      time.addEventListener(type, event => event.stopPropagation());
    }
    time.append(heading, input, ticks, presets);
    mixer.append(time);
    refreshTime();
  }
  let refreshHeadlight = (): void => {};
  if (opts.headlight) {
    const control = opts.headlight, label = doc.createElement('label'), select = doc.createElement('select');
    label.className = 'porco-time'; label.textContent = '前照灯';
    select.id = 'porco-headlight'; select.setAttribute('aria-label', '前照灯');
    select.style.cssText = 'min-height:32px;background:#27323e;color:#f4e4cf;border:1px solid #887c6e;border-radius:5px';
    for (const [value, text] of [['auto', '自动 · 夜间亮灯'], ['on', '开启'], ['off', '关闭']] as const) {
      const option = doc.createElement('option'); option.value = value; option.textContent = text; select.append(option);
    }
    refreshHeadlight = () => { if (select.value !== control.get()) select.value = control.get(); };
    select.addEventListener('change', () => { control.set(select.value as HeadlightMode); refreshHeadlight(); });
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'keydown', 'keyup']) label.addEventListener(type, event => event.stopPropagation());
    label.append(select); mixer.append(label); refreshHeadlight();
  }
  const mixerState = doc.createElement('div');
  mixerState.className = 'porco-mixer__state';
  mixerState.textContent = 'AUDIO : TAP TO ENABLE';
  const sliders: Array<{ bus: Bus; input: HTMLInputElement }> = [];
  const defaults = HUD_BUS_DEFAULTS;
  for (const row of BUS_ROWS) {
    const line = doc.createElement('div');
    line.className = 'porco-mixer__row';
    const label = doc.createElement('span');
    label.textContent = row.label;
    const input = doc.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '1';
    input.step = '0.01';
    input.value = String(defaults[row.bus]);
    input.setAttribute('aria-label', `${row.label} volume`);
    input.addEventListener('input', () => {
      const v = Number.parseFloat(input.value);
      opts.onBusChange?.(row.bus, Number.isFinite(v) ? v : 0);
    });
    line.append(label, input);
    mixer.append(line);
    sliders.push({ bus: row.bus, input });
  }
  mixer.append(mixerState);

  // 折叠开关：常态 = 折叠（芯片显示 + UI），点开换成 −。一个按钮两态，位置不变。
  // 只用 aria-expanded 表达开合——按钮同时藏仪表、混音台和底栏，指 aria-controls 到其中
  // 任何一个都是半个真话，读屏用户反而拿到错的预期。
  const hudToggle = doc.createElement('button');
  hudToggle.type = 'button';
  hudToggle.className = 'porco-hud__toggle';
  const hudToggleGlyph = doc.createElement('span');
  hudToggleGlyph.className = 'porco-hud__toggle-glyph';
  const hudToggleLabel = doc.createElement('span');
  hudToggleLabel.className = 'porco-hud__toggle-label';
  hudToggle.append(hudToggleGlyph, hudToggleLabel);

  const topRight = doc.createElement('div');
  topRight.className = 'porco-hud__right';
  topRight.append(hudToggle, mixer);

  // ---- bottom-left: status + hint
  const status = doc.createElement('div');
  status.className = 'porco-status';
  status.textContent = '';
  const hint = doc.createElement('div');
  hint.className = 'porco-hint';
  hint.textContent = 'DRAG TO STEER';
  // CC-BY attribution for the aircraft's proportions reference. It has to be visible in the
  // running build, not only in the README — the licence covers distribution of the work that
  // was derived from it, and that work is what ships in the GLB.
  const credits = doc.createElement('div');
  credits.className = 'porco-credit';
  credits.textContent = 'S.21 PROPORTIONS · FEDERICOFELICI · CC-BY 4.0';
  const bottomLeft = doc.createElement('div');
  bottomLeft.append(status, hint, credits);

  const top = doc.createElement('div');
  top.className = 'porco-hud__top';
  top.append(topLeft, topRight);
  const bottom = doc.createElement('div');
  bottom.className = 'porco-hud__bottom';
  bottom.append(bottomLeft);

  root.append(top, bottom);
  // Anchor to the canvas box (#frame carries #game's exact rectangle), not the
  // viewport — a desktop-wide window must not scatter the HUD onto the letterbox.
  const host = doc.getElementById('frame') ?? doc.getElementById('wrap') ?? doc.body;
  host.append(root);

  // Notch/home-bar insets as a fraction of the frame height (portrait.ts), never
  // smaller than the platform's own safe-area insets. Recomputed on resize so a
  // rotation mid-session re-anchors the HUD instead of keeping the boot-time box.
  const applySafeArea = (): void => {
    const frameH = host.clientHeight || 16;
    const frameW = host.clientWidth || 9;
    const area = hudSafeArea(frameW / frameH);
    root.style.paddingTop = `max(${Math.round(area.top * frameH)}px, env(safe-area-inset-top))`;
    root.style.paddingBottom = `max(${Math.round(area.bottom * frameH)}px, env(safe-area-inset-bottom))`;
  };
  applySafeArea();
  window.addEventListener('resize', applySafeArea);

  // ---- 折叠态（2026-11-14）：常态折叠成 + UI 芯片，点开是完整面板，再点 − 收回。
  // 状态只在这里改；外部要改走 handle 的 setCollapsed。位置固定在右上角，两态同一目标。
  let collapsed = true;
  const applyCollapsed = (): void => {
    root.classList.toggle('porco-hud--collapsed', collapsed);
    hudToggleGlyph.textContent = collapsed ? '+' : '−';
    hudToggleLabel.textContent = collapsed ? 'UI' : '';
    hudToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    const label = collapsed ? 'Show HUD' : 'Hide HUD';
    hudToggle.setAttribute('aria-label', label);
    hudToggle.title = label;
  };
  hudToggle.addEventListener('click', () => {
    collapsed = !collapsed;
    applyCollapsed();
  });
  applyCollapsed();

  // last-written values, so the loop only touches the DOM on real changes
  let lastSpeed = -1;
  const lastBankDeg = { v: Number.NaN };
  const lastClimb = { v: Number.NaN };
  const lastFps = { v: Number.NaN };
  const lastMode = { v: '' };
  let lastStatus = '';
  let lastAudio = '';
  let lastSpeedWidth = -1;
  let lastThrottleWidth = -1;
  let lastStallCls = 'porco-stall';
  let lastWhiteout = -1;
  let lastTint = '';
  let lastG = -1;

  return {
    element: root,
    update(r: HudReadout): void {
      refreshTime();
      refreshHeadlight();
      const kmh = Math.round((Number.isFinite(r.speed) ? r.speed : 0) * 3.6);
      if (kmh !== lastSpeed) {
        lastSpeed = kmh;
        speedValue.textContent = String(kmh);
      }
      const s01 = Number.isFinite(r.speed01) ? Math.min(Math.max(r.speed01, 0), 1) : 0;
      const w = Math.round(s01 * 100);
      if (w !== lastSpeedWidth) {
        lastSpeedWidth = w;
        speedFill.style.strokeDashoffset = String(SPEED_ARC_LEN * (1 - s01));
      }
      const t01 = Number.isFinite(r.throttle) ? Math.min(Math.max(r.throttle, 0), 1) : 0;
      const tw = Math.round(t01 * 100);
      if (tw !== lastThrottleWidth) {
        lastThrottleWidth = tw;
        throttleArc.style.strokeDashoffset = String(THROTTLE_ARC_LEN * (1 - t01));
      }
      const bankDeg = Math.round((Number.isFinite(r.bank) ? r.bank : 0) * (180 / Math.PI));
      const climb = Math.round((Number.isFinite(r.climb) ? r.climb : 0) * 10) / 10;
      const frame = Math.round(Number.isFinite(r.fps) ? r.fps : 0);
      // Only rebuild the status string when a number the player can read actually
      // changed — otherwise the loop would allocate a string 60x/s for nothing.
      if (bankDeg !== lastBankDeg.v || climb !== lastClimb.v || frame !== lastFps.v || r.mode !== lastMode.v) {
        lastBankDeg.v = bankDeg;
        lastClimb.v = climb;
        lastFps.v = frame;
        lastMode.v = r.mode;
        const dir = bankDeg > 0 ? 'R' : bankDeg < 0 ? 'L' : '-';
        const text = `${r.mode} · ${dir}${Math.abs(bankDeg)}° · ${climb >= 0 ? '+' : ''}${climb.toFixed(1)} m/s · ${frame} fps`;
        if (text !== lastStatus) {
          lastStatus = text;
          status.textContent = text;
        }
      }
      if (r.audioState !== lastAudio) {
        lastAudio = r.audioState;
        mixerState.textContent = r.audioState;
      }
      // FLT-03 三态：事件态 --on 闪烁 > 预警态 --warn 常亮暗态 > 基态（warn 不吞 event）。
      const stallCls =
        Number.isFinite(r.stall01) && r.stall01 > 0.5
          ? 'porco-stall porco-stall--on'
          : r.stallWarn === true
            ? 'porco-stall porco-stall--warn'
            : 'porco-stall';
      if (stallCls !== lastStallCls) {
        lastStallCls = stallCls;
        stallWarn.className = stallCls;
      }
    },
    setVisible(visible: boolean): void {
      root.style.display = visible ? '' : 'none';
    },
    /** 折叠/展开 HUD 外壳。常态折叠；外部调用（QA、后续自动收起）只走这里。 */
    setCollapsed(v: boolean): void {
      if (v !== collapsed) {
        collapsed = v;
        applyCollapsed();
      }
    },
    isCollapsed(): boolean {
      return collapsed;
    },
    setWhiteout(v: number, tintCss?: string): void {
      // Quantised to 1/200 so a noisy per-frame value cannot churn style writes.
      const o = Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0;
      const q = Math.round(o * 200) / 200;
      if (q !== lastWhiteout) {
        lastWhiteout = q;
        whiteout.style.opacity = String(q);
      }
      // 纱色沿用同一套防抖：只在变化时写样式。
      if (tintCss && tintCss !== lastTint) {
        lastTint = tintCss;
        whiteout.style.background = tintCss;
      }
    },
    setG(v: number): void {
      // 白纱同款量化防抖：game 侧还有 0.01 门，双保险。
      const o = Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0;
      const q = Math.round(o * 200) / 200;
      if (q !== lastG) {
        lastG = q;
        gLayer.style.opacity = String(q);
      }
    },
    dispose(): void {
      root.remove();
      window.removeEventListener('resize', applySafeArea);
      const style = doc.getElementById(STYLE_ID);
      if (style) style.remove();
      sliders.length = 0;
    },
  };
}

export { BUS_ROWS, defaultHudReadout };

function defaultHudReadout(): HudReadout {
  return { speed: 0, speed01: 0, throttle: 0, bank: 0, climb: 0, mode: 'CRUISE', fps: 0, audioState: 'AUDIO : OFF', stall01: 0, stallWarn: false };
}
