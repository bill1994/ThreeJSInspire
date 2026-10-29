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
}

export interface HudHandle {
  element: HTMLElement;
  update(readout: HudReadout): void;
  setVisible(visible: boolean): void;
  /** 0..1 white fog over the frame — the fly-through-clouds cue (DOM layer, not volumetrics). */
  setWhiteout(v: number): void;
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
.porco-speed__value{font-size:clamp(26px,4.6vh,44px);font-weight:700;line-height:1;letter-spacing:.02em;font-variant-numeric:tabular-nums}
.porco-speed__unit{font-size:10px;letter-spacing:.22em;opacity:.7;margin-top:2px}
.porco-bar{width:clamp(90px,26vw,150px);height:5px;margin-top:7px;border-radius:3px;background:rgba(255,255,255,.16);overflow:hidden}
.porco-bar__fill{height:100%;width:0;border-radius:3px;background:linear-gradient(90deg,#ffb066,#ff6a3d);transition:width .08s linear}
.porco-bar__fill--cool{background:linear-gradient(90deg,#8ee6c8,#38a9d6)}
.porco-status{font-size:11px;line-height:1.5;letter-spacing:.12em;opacity:.9;font-variant-numeric:tabular-nums}
.porco-status b{font-weight:700;color:#ffd9a8}
.porco-hint{font-size:10px;letter-spacing:.14em;opacity:.52;margin-top:5px}
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
@keyframes porco-stall-blink{0%,60%{opacity:1}61%,100%{opacity:.25}}
.porco-whiteout{position:absolute;inset:0;background:#e8dfd6;opacity:0;pointer-events:none}
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

  // ---- top-left: speed + throttle
  const speedPanel = doc.createElement('div');
  speedPanel.className = 'porco-panel porco-speed';
  const speedValue = doc.createElement('div');
  speedValue.className = 'porco-speed__value';
  speedValue.textContent = '0';
  const speedUnit = doc.createElement('div');
  speedUnit.className = 'porco-speed__unit';
  speedUnit.textContent = 'KM/H';
  const speedBar = doc.createElement('div');
  speedBar.className = 'porco-bar';
  const speedFill = doc.createElement('div');
  speedFill.className = 'porco-bar__fill';
  speedBar.append(speedFill);
  speedPanel.append(speedValue, speedUnit, speedBar);

  // alt readout + throttle bar live in the same panel column
  const throttlePanel = doc.createElement('div');
  throttlePanel.className = 'porco-panel';
  throttlePanel.style.marginTop = '8px';
  const throttleLabel = doc.createElement('div');
  throttleLabel.className = 'porco-speed__unit';
  throttleLabel.textContent = 'AIRSPEED';
  const throttleBar = doc.createElement('div');
  throttleBar.className = 'porco-bar';
  const throttleFill = doc.createElement('div');
  throttleFill.className = 'porco-bar__fill porco-bar__fill--cool';
  throttleBar.append(throttleFill);
  throttlePanel.append(throttleLabel, throttleBar);

  // STALL warning, beside the speed panels; invisible until the stall bites.
  const stallWarn = doc.createElement('div');
  stallWarn.className = 'porco-stall';
  stallWarn.textContent = 'STALL';

  const topLeft = doc.createElement('div');
  topLeft.append(speedPanel, throttlePanel, stallWarn);

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
  status.className = 'porco-panel porco-status';
  status.textContent = '';
  const hint = doc.createElement('div');
  hint.className = 'porco-hint';
  hint.textContent = 'DRAG TO STEER';
  const bottomLeft = doc.createElement('div');
  bottomLeft.append(status, hint);

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
  let lastStallOn = false;
  let lastWhiteout = -1;

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
        speedFill.style.width = `${w}%`;
      }
      const t01 = Number.isFinite(r.throttle) ? Math.min(Math.max(r.throttle, 0), 1) : 0;
      const tw = Math.round(t01 * 100);
      if (tw !== lastThrottleWidth) {
        lastThrottleWidth = tw;
        throttleFill.style.width = `${tw}%`;
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
      const stallOn = Number.isFinite(r.stall01) && r.stall01 > 0.5;
      if (stallOn !== lastStallOn) {
        lastStallOn = stallOn;
        stallWarn.className = stallOn ? 'porco-stall porco-stall--on' : 'porco-stall';
      }
    },
    setVisible(visible: boolean): void {
      root.style.display = visible ? '' : 'none';
    },
    setWhiteout(v: number): void {
      // Quantised to 1/200 so a noisy per-frame value cannot churn style writes.
      const o = Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0;
      const q = Math.round(o * 200) / 200;
      if (q !== lastWhiteout) {
        lastWhiteout = q;
        whiteout.style.opacity = String(q);
      }
    },
    dispose(): void {
      root.remove();
      const style = doc.getElementById(STYLE_ID);
      if (style) style.remove();
      sliders.length = 0;
    },
  };
}

export { BUS_ROWS, defaultHudReadout };

function defaultHudReadout(): HudReadout {
  return { speed: 0, speed01: 0, throttle: 0, bank: 0, climb: 0, mode: 'CRUISE', fps: 0, audioState: 'AUDIO : OFF', stall01: 0 };
}
