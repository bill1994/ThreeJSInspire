/**
 * day-night planB Phase 1 Task 3 — one-off probe: static ?tod= wiring smoke.
 *
 * Poses (all frozen captures, canvas crop 434x772 like analyze-task3-dome.mjs):
 *   tod12        ?tod=12&qa=frozen&alt=60            → sun el≈65, az≈288.24 (noon arc top)
 *   tod0         ?tod=0&qa=frozen&alt=60             → sun el≈−65, az≈108.24 (midnight arc bottom)
 *   prec-AB      ?tod=12&sun=180,7&qa=frozen&alt=60  → ?sun= wins: az≈180, el≈7
 *   prec-BA      ?sun=180,7&tod=12&qa=frozen&alt=60  → reverse param order, same verdict
 *   frozen-speed ?tod=12&todspeed=5&qa=frozen&alt=60 → step 1 vs step 61: az/el/version immobile
 *                                                      (B2: ?todspeed stays write-only);
 *                                                      then runtime qa.setTod(0/12) moves the sun
 *                                                      (B2 "set takes effect": setAzEl version bump
 *                                                      + direct syncSun fan-out under frozen);
 *                                                      then on the prec-AB page qa.setTod(12)
 *                                                      documents the runtime last-write-wins
 *                                                      judgment call (overrides a boot ?sun=).
 *   luminance    sky/sea band means for tod12 vs tod0 vs the tracked no-param baseline
 *                (task2 context: ?tod=12 sky is EXPECTED bloomier than the 0.82 reference
 *                budget — recorded, not treated as a defect; Task 4 fixes the budget).
 *
 * The no-param byte-identity gate runs separately via capture-baseline.mjs
 * CMP_DIR=baseline ONLY=baseline-ref-level (see report).
 *
 * PNGs are local twins (not committed); this JSON summary is the committed evidence.
 *
 * Env: CDP, BASE, OUT (default task3-tod-wiring).
 */
import fs from 'node:fs';
import path from 'node:path';

const CDP = process.env.CDP ?? 'http://127.0.0.1:9222';
const BASE = process.env.BASE ?? 'http://[::1]:5173/';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const OUT = path.join(HERE, process.env.OUT ?? 'task3-tod-wiring');
const VIEW_W = 1384;
const VIEW_H = 772;
const MIN_BYTES = 150 * 1024;

fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newTab(url) {
  const res = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`newTab ${res.status}: ${await res.text()}`);
  return res.json();
}

class Session {
  constructor(target) {
    this.target = target;
    this.logs = [];
    this.nextId = 1;
    this.pending = new Map();
  }

  async open() {
    this.ws = new WebSocket(this.target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (!msg.id && (msg.method === 'Runtime.consoleAPICalled' || msg.method === 'Runtime.exceptionThrown')) {
        const p = msg.params;
        const text = p.type === 'warn' || p.type === 'error'
          ? `[${p.type}] ${(p.args || []).map((a) => a.value ?? a.description ?? '').join(' ')}`
          : p.exceptionDetails
            ? `[exception] ${p.exceptionDetails.text} ${p.exceptionDetails.exception?.description ?? ''}`
            : '';
        if (text) this.logs.push(text);
      }
    };
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1, mobile: false,
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout ${method}`));
        }
      }, 120000);
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`page eval: ${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description ?? ''}`);
    }
    return res.result.value;
  }

  async waitBoot(qs, timeoutMs = 90000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const ready = await this.eval(`
        return Boolean(window.__porco && window.__porco.qa && window.__porco.scene)
          && window.__porco.qa.frozen === true
          && location.href.includes('${qs}');
      `).catch(() => false);
      if (ready) return true;
      await sleep(500);
    }
    return false;
  }

  async waitBootStatusFade(timeoutMs = 30000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const opacity = await this.eval(`
        const b = document.querySelector('#boot-status');
        return b ? getComputedStyle(b).opacity : 'gone';
      `).catch(() => null);
      if (opacity === '0' || opacity === 'gone') return opacity;
      await sleep(500);
    }
    return 'timeout';
  }

  async shot(name) {
    for (let i = 1; i <= 3; i++) {
      try {
        const res = await this.send('Page.captureScreenshot', {
          format: 'png', fromSurface: true, captureBeyondViewport: false,
        });
        const file = path.join(OUT, `${name}.png`);
        fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
        const bytes = fs.statSync(file).size;
        if (bytes < MIN_BYTES) throw new Error(`suspicious PNG ${bytes} bytes (< ${MIN_BYTES}) — partial frame`);
        return { file, bytes, tries: i };
      } catch (err) {
        console.log(`[shot attempt ${i} failed] ${String(err).slice(0, 160)}`);
        await sleep(2000);
      }
    }
    throw new Error('screenshot failed after 3 tries');
  }

  async close() {
    await fetch(`${CDP}/json/close/${this.target.id}`).catch(() => {});
    this.ws.close();
  }
}

const PRESENT = `
  for (let i = 0; i < 2; i++) {
    window.__porco.qa.stepFrame(0);
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => requestAnimationFrame(r));
  }
`;

const SUN = `(() => {
  const s = window.__porco.qa.getSun();
  return { az: s.azimuthDeg, el: s.elevationDeg, version: s.version, dir: [s.x, s.y, s.z].map(v => Number(v.toFixed(6))), dirElFromY: Number((Math.asin(Math.min(Math.max(s.y, -1), 1)) * 180 / Math.PI).toFixed(4)) };
})()`;

/** Circular az distance in degrees (az wrap conventions differ: SunState (-180,180] vs solarAzimuthFor [0,360)). */
const azDist = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180);

/** Band-mean luminance (0..255) over the canvas crop 434x772; bands split sky/sea. */
const LUMA = `
  window.__lumaB64 = async (b64) => {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('decode failed'));
      im.src = 'data:image/png;base64,' + b64;
    });
    const c = document.createElement('canvas');
    c.width = 434; c.height = 772;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 475, 0, 434, 772, 0, 0, 434, 772);
    const px = ctx.getImageData(0, 0, 434, 772).data;
    const bands = { skyTop: [0, 150], skyMid: [150, 350], horizon: [350, 500], sea: [500, 772] };
    const out = {};
    for (const [name, [yA, yB]] of Object.entries(bands)) {
      let sum = 0, n = 0;
      for (let y = yA; y < yB; y++) for (let x = 0; x < 434; x++) {
        const i = (y * 434 + x) * 4;
        sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
        n++;
      }
      out[name] = Number((sum / n).toFixed(2));
    }
    return out;
  };
`;

async function loadPose(qs, frames, shotName) {
  const target = await newTab(`${BASE}?${qs}`);
  const session = new Session(target);
  await session.open();
  try {
    if (!(await session.waitBoot(qs))) throw new Error(`boot timeout: ${qs}`);
    const fade = await session.waitBootStatusFade();
    const elapsed = await session.eval(`return window.__porco.qa.step(${frames}, 1/60);`);
    await session.eval(PRESENT);
    let shot = null;
    if (shotName) shot = await session.shot(shotName);
    return { session, elapsed, fade, shot };
  } catch (err) {
    await session.close().catch(() => {});
    throw err;
  }
}

const payload = { protocol: { base: BASE, cdp: CDP, viewport: [VIEW_W, VIEW_H], deviceScaleFactor: 1, stepDt: 1 / 60 }, poses: {}, errors: [] };

try {
  // ---- tod12 / tod0: static boot wiring endpoints -----------------------------
  for (const [name, qs, want] of [
    ['tod12', 'tod=12&qa=frozen&alt=60', { az: 288.2448, el: 65 }],
    ['tod0', 'tod=0&qa=frozen&alt=60', { az: 108.2448, el: -65 }],
  ]) {
    const { session, fade, shot, elapsed } = await loadPose(qs, 1, name);
    const sun = await session.eval(`return ${SUN}`);
    payload.poses[name] = {
      url: `${BASE}?${qs}`, frames: 1, elapsed, bootStatusFade: fade,
      png: shot ? `${name}.png` : null, pngBytes: shot?.bytes ?? null,
      sun, want, verdict: azDist(sun.az, want.az) <= 0.02 && Math.abs(sun.el - want.el) <= 0.02 ? 'PASS' : 'FAIL',
      logs: session.logs.slice(-6),
    };
    console.log(`[${name}]`, JSON.stringify(payload.poses[name]));
    await session.close().catch(() => {});
  }

  // ---- precedence: ?sun= beats ?tod=, both param orders ------------------------
  for (const [name, qs] of [
    ['prec-AB', 'tod=12&sun=180,7&qa=frozen&alt=60'],
    ['prec-BA', 'sun=180,7&tod=12&qa=frozen&alt=60'],
  ]) {
    const { session, fade, elapsed } = await loadPose(qs, 1, null);
    const sun = await session.eval(`return ${SUN}`);
    payload.poses[name] = {
      url: `${BASE}?${qs}`, frames: 1, elapsed, bootStatusFade: fade,
      sun, want: { az: 180, el: 7 },
      verdict: azDist(sun.az, 180) <= 0.02 && Math.abs(sun.el - 7) <= 0.02 ? 'PASS' : 'FAIL',
    };
    console.log(`[${name}]`, JSON.stringify(payload.poses[name]));
    await session.close().catch(() => {});
  }

  // ---- pre-existing collapse control: legacy ?sun= night pose, NO tod ----------
  {
    const qs = 'sun=12,-8&qa=frozen&alt=60';
    const { session } = await loadPose(qs, 1, null);
    const sun = await session.eval(`return ${SUN}`);
    payload.poses['night-legacy-sun'] = {
      url: `${BASE}?${qs}`, sun,
      note: 'PRE-EXISTING (control): dome-cloud.ts:504 update() copies the light-derived (clamped el>=2) direction back into the shared live sun vector, so any el<2 state collapses to +2 in sun.direction while SunState az/el bookkeeping stays at the requested values. Same signature in the tracked baseline-night-sun12-8.json (elevationDeg -8, dir y +0.0349) captured before Task 3 — not a Task 3 regression. dirElFromY≈+2 here proves it without tod in the URL.',
      dirElFromY: sun.dirElFromY,
    };
    console.log('[night-legacy-sun]', JSON.stringify(payload.poses['night-legacy-sun']));
    await session.close().catch(() => {});
  }

  // ---- frozen + todspeed=5: immobile; then runtime setTod lever ----------------
  {
    const qs = 'tod=12&todspeed=5&qa=frozen&alt=60';
    const { session, fade } = await loadPose(qs, 1, 'frozen-speed');
    const at1 = await session.eval(`return ${SUN}`);
    await session.eval('return window.__porco.qa.step(60, 1/60);');
    await session.eval(PRESENT);
    const at61 = await session.eval(`return ${SUN}`);
    const immobile = at1.az === at61.az && at1.el === at61.el && at1.version === at61.version;
    // Runtime lever (frozen page): setTod must move the sun via setAzEl version bump
    // + direct syncSun — B2 "set takes effect immediately, no auto-advance".
    await session.eval('window.__porco.qa.setTod(0);');
    await session.eval(PRESENT);
    const atMidnight = await session.eval(`return ${SUN}`);
    await session.eval('window.__porco.qa.setTod(12);');
    await session.eval(PRESENT);
    const atNoon = await session.eval(`return ${SUN}`);
    payload.poses['frozen-speed'] = {
      url: `${BASE}?${qs}`, bootStatusFade: fade,
      atStep1: at1, atStep61: at61,
      immobileVerdict: immobile ? 'PASS' : 'FAIL',
      setTod0: atMidnight, setTod12: atNoon,
      setTodVerdict: Math.abs(atMidnight.el - -65) <= 0.02 && Math.abs(atNoon.el - 65) <= 0.02 && atNoon.version > at61.version ? 'PASS' : 'FAIL',
    };
    console.log('[frozen-speed]', JSON.stringify(payload.poses['frozen-speed']));
    await session.close().catch(() => {});
  }

  // ---- judgment-call record: setTod overrides a boot ?sun= (last write wins) ---
  {
    const qs = 'tod=12&sun=180,7&qa=frozen&alt=60';
    const { session } = await loadPose(qs, 1, null);
    const boot = await session.eval(`return ${SUN}`);
    await session.eval('window.__porco.qa.setTod(12);');
    await session.eval(PRESENT);
    const after = await session.eval(`return ${SUN}`);
    payload.poses['setTod-over-sun'] = {
      url: `${BASE}?${qs}`, bootSun: boot, afterSetTod12: after,
      note: 'judgment call: runtime qa.setTod is an explicit last write and overrides a boot ?sun= pin; ?sun= precedence is a boot-time URL arbitration only',
    };
    console.log('[setTod-over-sun]', JSON.stringify(payload.poses['setTod-over-sun']));
    await session.close().catch(() => {});
  }

  // ---- luminance bands: tod12 vs tod0 vs tracked no-param baseline -------------
  await sessionEvalLuma();
  async function sessionEvalLuma() {
    await sessionLuma('tod12', `${BASE}?tod=12&qa=frozen&alt=60`, 'tod=12&qa=frozen&alt=60');
    await sessionLuma('tod0', `${BASE}?tod=0&qa=frozen&alt=60`, 'tod=0&qa=frozen&alt=60');
    // No-param reference: reuse the tracked baseline PNG (no reload needed).
    const baseB64 = fs.readFileSync(path.join(HERE, 'baseline', 'baseline-ref-level.png')).toString('base64');
    const target = await newTab(`${BASE}?qa=frozen&alt=60`);
    const session = new Session(target);
    await session.open();
    try {
      await session.waitBoot('qa=frozen&alt=60');
      await session.eval(LUMA);
      payload.poses['luma-no-param-baseline-file'] = {
        source: 'artifacts/toon-audit/baseline/baseline-ref-level.png (tracked, pre-Task-3)',
        bands: await session.eval(`return window.__lumaB64('${baseB64}');`),
      };
    } finally {
      await session.close().catch(() => {});
    }
  }
  async function sessionLuma(name, url, qs) {
    const target = await newTab(url);
    const session = new Session(target);
    await session.open();
    try {
      if (!(await session.waitBoot(qs))) throw new Error(`boot timeout: ${qs}`);
      await session.waitBootStatusFade();
      await session.eval('return window.__porco.qa.step(1, 1/60);');
      await session.eval(PRESENT);
      await session.eval(LUMA);
      const res = await session.send('Page.captureScreenshot', {
        format: 'png', fromSurface: true, captureBeyondViewport: false,
      });
      payload.poses[`luma-${name}`] = { url, bands: await session.eval(`return window.__lumaB64('${res.data}');`) };
      console.log(`[luma-${name}]`, JSON.stringify(payload.poses[`luma-${name}`]));
    } finally {
      await session.close().catch(() => {});
    }
  }
} catch (err) {
  payload.errors.push(String(err).slice(0, 400));
}

fs.writeFileSync(path.join(OUT, 'probe-task3-tod.json'), JSON.stringify(payload, null, 2));
if (payload.errors.length > 0) {
  console.log('PROBE ERRORS:', payload.errors.join(' | '));
  process.exitCode = 1;
} else {
  console.log('probe-task3-tod done');
}
