/**
 * FLT-03 browser gate — stall warn/event two-cue split on the live frame loop.
 *
 * Protocol (repair-phase1.md Task 3 Step 5):
 *   URL    http://[::1]:5173/?qa=frozen&pos=0,120,-300
 *   pose   spawn at altitude 120: room to pull up, bleed speed and stall.
 *   lever  two-stage stick (CDP Input.dispatchMouseEvent on #game):
 *          press canvas centre, drag up PULL_MED px and HOLD — gentle climb
 *          bleeds speed through STALL_SPEED + STALL_WARN_MARGIN (warn edge);
 *          on warn, drag further to PULL_FULL px (full pull-up) and HOLD —
 *          stall01 spikes past 0.5 (event edge). Rationale (2026-11-12 ego
 *          runs): single full pull snaps straight to the event (warn zone
 *          crossed within one frame, warn line never fires); single gentle
 *          pull zooms to a pushover dive without ever stalling. Pointer
 *          stays captured the whole run (release only after post frame).
 *   poll   qa.step(2, 1/60) + PRESENT, then read DOM ground truth:
 *            .porco-sub textContent  (subtitle line)
 *            .porco-stall className  (HUD stall block)
 *   edges  warn:  text contains '速度在掉'  -> shot stallwarn-warn.png
 *          event: text contains '机头太仰'  -> shot stallwarn-event.png
 *          post:  +60 steps after event    -> shot stallwarn-post.png
 *   gate   PASS iff warn frame shows warn text + porco-stall--warn
 *          AND event frame shows stall text + porco-stall--on.
 *
 * Frames (NEW names): stallwarn-warn.png / stallwarn-event.png / stallwarn-post.png.
 * Env: BASE, OUT_DIR, VIEW_W, VIEW_H.
 */
import fs from 'node:fs';
import path from 'node:path';

const CDP = 'http://127.0.0.1:9222';
const BASE = process.env.BASE ?? 'http://[::1]:5173/';
const OUT = process.env.OUT_DIR
  || path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const VIEW_W = Number(process.env.VIEW_W ?? 1384);
const VIEW_H = Number(process.env.VIEW_H ?? 772);
const MIN_BYTES = 150 * 1024;
const POSE = 'pos=0,120,-300';
const MAX_ITERS = 600; // step(2) x 600 = 1200 steps = 20 s sim (warn ~4.7 s on medium)
const PULL_MED = 74; // steer.y ~ -0.6: gentle climb, speed bleeds through the warn margin
const PULL_FULL = 130; // > STEER_RADIUS_PX(120): full-deflection pull-up, spikes stall01 past 0.5

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

  async waitBoot(timeoutMs = 90000) {
    const want = `${BASE}?qa=frozen&${POSE}`;
    const t0 = Date.now();
    let probeLogged = false;
    while (Date.now() - t0 < timeoutMs) {
      const ready = await this.eval(`
        return Boolean(window.__porco && window.__porco.qa && window.__porco.scene)
          && location.href.includes('qa=frozen')
          && location.href.includes('${POSE}');
      `).catch(() => false);
      if (ready) return want;
      if (!probeLogged) {
        probeLogged = true;
        const probe = await this.eval(
          'return JSON.stringify({url: location.href, porco: typeof window.__porco, qa: Boolean(window.__porco?.qa), scene: Boolean(window.__porco?.scene), ready: document.readyState});',
        ).catch((e) => '[probe error] ' + String(e).slice(0, 200));
        console.log('[waitBoot probe]', probe);
      }
      await sleep(500);
    }
    return null;
  }

  async waitBootStatusFade(timeoutMs = 25000) {
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
        return { file: path.basename(file), bytes, tries: i };
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

/** DOM ground truth: subtitle line + stall block class + clock + altitude. */
const PROBE = `
  const q = window.__porco;
  const d = q.qa.describe();
  const sub = document.querySelector('.porco-sub');
  const stallEls = [...document.querySelectorAll('.porco-stall')].map((e) => e.className);
  return {
    elapsed: d.elapsed,
    plane: d.plane,
    subText: sub ? (sub.textContent ?? '') : '<no .porco-sub>',
    stallCls: stallEls,
  };
`;

const results = {};
const errors = [];

let done = false;
for (let attempt = 1; attempt <= 3 && !done; attempt++) {
  let s;
  try {
    s = new Session(await newTab(`${BASE}?qa=frozen&${POSE}`));
    await s.open();
    const url = await s.waitBoot();
    if (!url) throw new Error('boot timeout (or URL drifted)');
    const bootStatus = await s.waitBootStatusFade();
    await s.eval(`window.__porco.qa.step(0, 1/60);`);
    await s.eval(PRESENT);
    const start = await s.eval(PROBE);
    console.log('[start]', JSON.stringify(start));

    // Hold full pull-up: press canvas centre, drag up PULL_PX, keep held.
    const c = await s.eval(`
      const r = document.querySelector('#game').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    `);
    // Stage 1: gentle hold (medium pull-up).
    await s.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1,
    });
    await s.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: c.x, y: c.y - PULL_MED, button: 'left',
    });
    await s.eval(PRESENT);
    const held = await s.eval(PROBE);
    console.log('[stick held: medium]', JSON.stringify(held));

    let warn = null;
    let event = null;
    let wentFull = false;
    let iters = 0;
    for (let i = 0; i < MAX_ITERS && !event; i++) {
      iters = i + 1;
      await s.eval(`window.__porco.qa.step(2, 1/60);`);
      await s.eval(PRESENT);
      const p = await s.eval(PROBE);
      if (!warn && p.subText.includes('速度在掉')) {
        warn = p;
        warn.shot = await s.shot('stallwarn-warn');
        console.log('[warn edge]', JSON.stringify({ ...warn, shot: warn.shot }));
        // Stage 2: full pull-up — spike stall01 past 0.5 for the event edge.
        await s.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: c.x, y: c.y - PULL_FULL, button: 'left',
        });
        wentFull = true;
      }
      if (warn && !event && p.subText.includes('机头太仰')) {
        event = p;
        event.shot = await s.shot('stallwarn-event');
        console.log('[event edge]', JSON.stringify({ ...event, shot: event.shot }));
      }
    }
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y - PULL_FULL, button: 'left' });

    let post = null;
    if (event) {
      await s.eval(`window.__porco.qa.step(60, 1/60);`);
      await s.eval(PRESENT);
      post = await s.eval(PROBE);
      post.shot = await s.shot('stallwarn-post');
      console.log('[post +1s]', JSON.stringify({ ...post, shot: post.shot }));
    }

    const warnOk = Boolean(warn)
      && warn.stallCls.some((cls) => cls.includes('porco-stall--warn'));
    const eventOk = Boolean(event)
      && event.stallCls.some((cls) => cls.includes('porco-stall--on'));
    const verdict = warn && event
      ? (warnOk && eventOk ? 'PASS' : 'FAIL')
      : 'FAIL';
    if (!warn) errors.push('stallwarn: warn edge (速度在掉) never appeared in 10 s sim');
    if (warn && !event) errors.push('stallwarn: event edge (机头太仰) never appeared after warn');

    results.stallwarn = {
      attempt, bootStatus, iters, start, heldPullUp: held,
      warn, event, post,
      gate: {
        warnText: '速度在掉', warnClass: 'porco-stall--warn',
        eventText: '机头太仰', eventClass: 'porco-stall--on',
        warnOk, eventOk, verdict,
      },
      consoleLogs: s.logs,
    };
    console.log('[gate]', JSON.stringify({ warnOk, eventOk, verdict }));
    done = true;
  } catch (err) {
    console.log(JSON.stringify({ name: 'stallwarn', attempt, error: String(err).slice(0, 300) }));
    if (attempt === 3) errors.push(`stallwarn: ${String(err).slice(0, 200)}`);
  } finally {
    if (s) await s.close().catch(() => {});
  }
}

const payload = {
  protocol: {
    url: `${BASE}?qa=frozen&${POSE}`,
    viewport: [VIEW_W, VIEW_H],
    deviceScaleFactor: 1,
    lever: `CDP mouse press canvas-centre + drag up ${PULL_PX}px held (full pull-up)`,
    poll: `qa.step(2, 1/60) + PRESENT x${MAX_ITERS} (10 s sim); DOM ground truth .porco-sub / .porco-stall`,
    gate: 'warn frame text 速度在掉 + porco-stall--warn AND event frame text 机头太仰 + porco-stall--on',
    minBytes: MIN_BYTES,
  },
  results,
  errors,
};
fs.writeFileSync(path.join(OUT, 'capture-stallwarn.json'), JSON.stringify(payload, null, 2));
if (errors.length > 0) {
  console.log('CAPTURE ERRORS:', errors.join(' | '));
  process.exitCode = 1;
} else {
  console.log('capture-stallwarn done:', Object.keys(results).join(', '));
}
