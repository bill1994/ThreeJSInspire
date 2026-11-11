/**
 * Dome-cloud Task 9 acceptance + Task 8 DOF verification (14 + 2 frames).
 *
 * Protocol (same as Task 0.5/3/4/5/6):
 *   URL    http://[::1]:5173/?qa=frozen&pos=0,240,-300&dome={1|0} [&cloudlook=flat] [&sunoff=1] [&post=0]
 *   viewport 1384x772, deviceScaleFactor 1 → canvas 434x772 centered (rect 474.875,0,434.25,772).
 *   wait   boot ready + #boot-status fade '0'
 *   quality qa.setQuality(high) BEFORE present (post graph syncs on next stepFrame)
 *   step   qa.step(0) for t0 / qa.step(1800) for t30 (30s at 1/60)
 *   present 2 rounds of qa.stepFrame(0) + 2 rAF
 *   shot   Page.captureScreenshot, retry on timeout / <150KB partial frame
 *
 * Matrix (plan Task 9 Step 3 + Task 8 Step 4 merged — one server boot):
 *   soft high  on@0 / off@0 / on@1800 / off@1800   (4 = 2 on-off pairs)
 *   soft low   on@0 / off@0 / on@1800 / off@1800   (4)
 *   flat high  t0 / t30  (dome=1, no off — compare vs soft)
 *   flat low   t0 / t30
 *   sunoff high t0 / sunoff low t0  (gate 4)
 *   Task 8: soft-high-nopost + flat-high-nopost (?post=0 pair, banding check)
 *
 * Names are canonical record frames — never overwrite P1 or earlier P1.5 frames.
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
const POSE = 'pos=0,240,-300';
const STEPS_30S = 1800;

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
      }
    };
    await this.send('Page.enable');
    await this.send('Runtime.enable');
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

  async waitBoot(dome, extra, timeoutMs = 90000) {
    const t0 = Date.now();
    let probeLogged = false;
    while (Date.now() - t0 < timeoutMs) {
      const ready = await this.eval(`
        return Boolean(window.__porco && window.__porco.qa && window.__porco.scene)
          && location.href.includes('qa=frozen')
          && location.href.includes('${POSE}')
          && location.href.includes('dome=${dome}');
      `).catch(() => false);
      if (ready) return true;
      if (!probeLogged) {
        probeLogged = true;
        const probe = await this.eval(
          'return JSON.stringify({url: location.href, qa: Boolean(window.__porco?.qa)});',
        ).catch((e) => '[probe error] ' + String(e).slice(0, 200));
        console.log('[waitBoot probe]', probe);
      }
      await sleep(500);
    }
    return false;
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
        if (bytes < MIN_BYTES) throw new Error(`suspicious PNG ${bytes} bytes (< ${MIN_BYTES})`);
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

const DESCRIBE = `
  const q = window.__porco;
  const d = q.qa.describe();
  return { ...d, quality: q.world?.quality ?? 'n/a' };
`;

/** Open one tab, set quality, step to `steps`, present, shoot `name`. Returns {session open} for t0/t30 pairs via keepOpen. */
async function captureOne({ name, dome, extra = '', high, steps = 0, session: reuse = null }) {
  let s = reuse;
  let owned = false;
  if (!s) {
    const target = await newTab(`${BASE}?qa=frozen&${POSE}&dome=${dome}${extra}`);
    s = new Session(target);
    await s.open();
    const ready = await s.waitBoot(dome, extra);
    if (!ready) throw new Error('boot timeout (or URL drifted)');
    await s.waitBootStatusFade();
    owned = true;
  }
  // Quality BEFORE present: post graph re-syncs on the next stepFrame.
  await s.eval(`window.__porco.qa.setQuality(${high ? 'true' : 'false'});`);
  await s.eval(`window.__porco.qa.step(${steps}, 1/60);`);
  await s.eval(PRESENT);
  const desc = await s.eval(DESCRIBE);
  if (String(desc.quality) !== (high ? 'high' : 'low')) {
    throw new Error(`quality lever missed: want ${high ? 'high' : 'low'}, got ${desc.quality}`);
  }
  const shot = await s.shot(name);
  return { session: s, owned, desc, shot };
}

const results = {};
const errors = [];

async function one(name, dome, extra, high, steps = 0) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let r = null;
    try {
      r = await captureOne({ name, dome, extra, high, steps });
      results[name] = { name, dome, extra, high, steps, attempt, desc: r.desc, shot: r.shot };
      console.log(`[ok] ${name} quality=${r.desc.quality} elapsed=${r.desc.elapsed} bytes=${r.shot.bytes}`);
      await r.session.close();
      return;
    } catch (err) {
      console.log(JSON.stringify({ name, attempt, error: String(err).slice(0, 300) }));
      if (r?.session) await r.session.close().catch(() => {});
      if (attempt === 3) errors.push(`${name}: ${String(err).slice(0, 200)}`);
    }
  }
}

/** t0/t30 pair in ONE tab (same quality, same URL): shoot, step 1800, shoot. */
async function pair(name0, name30, dome, extra, high) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let s = null;
    try {
      const target = await newTab(`${BASE}?qa=frozen&${POSE}&dome=${dome}${extra}`);
      s = new Session(target);
      await s.open();
      const ready = await s.waitBoot(dome, extra);
      if (!ready) throw new Error('boot timeout (or URL drifted)');
      await s.waitBootStatusFade();
      await s.eval(`window.__porco.qa.setQuality(${high ? 'true' : 'false'});`);
      await s.eval(`window.__porco.qa.step(0, 1/60);`);
      await s.eval(PRESENT);
      const desc0 = await s.eval(DESCRIBE);
      if (String(desc0.quality) !== (high ? 'high' : 'low')) throw new Error(`quality lever missed: ${desc0.quality}`);
      const shot0 = await s.shot(name0);
      const elapsedAfterStep = await s.eval(`return window.__porco.qa.step(${STEPS_30S}, 1/60);`);
      await s.eval(PRESENT);
      const desc30 = await s.eval(DESCRIBE);
      const shot30 = await s.shot(name30);
      results[name0] = { name: name0, dome, extra, high, steps: 0, attempt, desc: desc0, shot: shot0 };
      results[name30] = { name: name30, dome, extra, high, steps: STEPS_30S, attempt, elapsedAfterStep, desc: desc30, shot: shot30 };
      console.log(`[ok] ${name0} quality=${desc0.quality} elapsed=${desc0.elapsed} bytes=${shot0.bytes}`);
      console.log(`[ok] ${name30} quality=${desc30.quality} elapsed=${desc30.elapsed} bytes=${shot30.bytes}`);
      await s.close();
      return;
    } catch (err) {
      console.log(JSON.stringify({ name: `${name0}/${name30}`, attempt, error: String(err).slice(0, 300) }));
      if (s) await s.close().catch(() => {});
      if (attempt === 3) errors.push(`${name0}/${name30}: ${String(err).slice(0, 200)}`);
    }
  }
}

// ---- Task 9 acceptance matrix (14) ----
await pair('p15-high-on-t0', 'p15-high-on-t30', 1, '', true);
await pair('p15-high-off-t0', 'p15-high-off-t30', 0, '', true);
await pair('p15-low-on-t0', 'p15-low-on-t30', 1, '', false);
await pair('p15-low-off-t0', 'p15-low-off-t30', 0, '', false);
await pair('p15-high-flat-t0', 'p15-high-flat-t30', 1, '&cloudlook=flat', true);
await pair('p15-low-flat-t0', 'p15-low-flat-t30', 1, '&cloudlook=flat', false);
await one('p15-high-sunoff-t0', 1, '&sunoff=1', true, 0);
await one('p15-low-sunoff-t0', 1, '&sunoff=1', false, 0);
// ---- Task 8 DOF pair (2): post on is p15-high-on-t0; these are the post=0 mates ----
await one('p15-high-soft-nopost-t0', 1, '&post=0', true, 0);
await one('p15-high-flat-nopost-t0', 1, '&cloudlook=flat&post=0', true, 0);

const payload = {
  protocol: {
    url: `${BASE}?qa=frozen&${POSE}&dome={1|0}[&cloudlook=flat][&sunoff=1][&post=0]`,
    viewport: [VIEW_W, VIEW_H],
    deviceScaleFactor: 1,
    present: 'qa.setQuality(high) + qa.step(n) + 2x stepFrame(0) + 2x rAF',
    steps30s: STEPS_30S,
  },
  results,
  errors,
};
fs.writeFileSync(path.join(OUT, 'capture-p15-p2-accept.json'), JSON.stringify(payload, null, 2));
if (errors.length > 0) {
  console.log('CAPTURE ERRORS:', errors.join(' | '));
  process.exitCode = 1;
} else {
  console.log('capture-p15-p2-accept done:', Object.keys(results).join(', '));
}
