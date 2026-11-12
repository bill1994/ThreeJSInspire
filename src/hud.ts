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
.porco-stall{margin-top:8px;display:inline-block;padding:3px 9px;border-radius:6px;font-size:11px;font-weight:700;
  letter-spacing:.24em;color:#ffd2c4;background:rgba(182,54,41,.55);border:1px solid rgba(255,124,94,.5);
  opacity:0;transition:opacity .12s linear}
.porco-stall--on{opacity:1;animation:porco-stall-blink .5s steps(1,end) infinite}
.porco-stall--warn{opacity:.55}
@keyframes porco-stall-blink{0%,60%{opacity:1}61%,100%{opacity:.25}}
.porco-whiteout{position:absolute;inset:0;background:#e8dfd6;opacity:0;pointer-events:none}
.porco-g{position:absolute;inset:0;opacity:0;pointer-events:none;
  background:radial-gradient(ellipse at center,transparent 52%,rgba(2,2,6,.78) 100%)}
`;

export function initHud(opts: { onBusChange?: (bus: Bus, slider01: number) => void } = {}): HudHandle {
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

  const topRight = doc.createElement('div');
  topRight.append(mixer);

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
