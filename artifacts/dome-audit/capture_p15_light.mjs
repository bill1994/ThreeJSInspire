/**
 * Dome-cloud Task 4 — P1.5 light march gate (3-tap march, density gate 0.12), same protocol as Task 0.5/Task 3.
 *
 * Protocol (docs/superpowers/reviews/2026-11-09-dome-cloud-p1-review.md §1/§4):
 *   URL    http://[::1]:5173/?qa=frozen&pos=0,240,-300&dome={1|0} [&sunoff=1]
 *          IPv6 literal — vite binds IPv6-only; Chrome races IPv4/6 on localhost.
 *   viewport 1384x772, deviceScaleFactor 1 → #frame fills height at 9:16,
 *          canvas drawing buffer 434x772 centered (rect 474.875,0,434.25,772).
 *   wait   boot ready (__porco.qa + __porco.scene) AND location.href still carries
 *          qa=frozen AND pos AND dome (stale __porco false-ready guard)
 *   wait   #boot-status computed opacity reaches '0' (6s fade + .6s transition)
 *   step   qa.step(0)                    (zero frames advanced, spawn pose)
 *   present 2 rounds of qa.stepFrame(0) + 2 rAF
 *   shot   Page.captureScreenshot, retry on timeout / <150KB partial frame
 *
 * Frames:
 *   p15-light-on.png     ?qa=frozen&pos=0,240,-300&dome=1            (dome visible, sun on)
 *   p15-light-off.png    ?qa=frozen&pos=0,240,-300&dome=0            (dome hidden — cloud-band mask)
 *   p15-light-sunoff.png ?qa=frozen&pos=0,240,-300&dome=1&sunoff=1   (sun term zeroed — gate 4)
 *   p15-light-t0.png / p15-light-t30.png  dome=1 drift pair (qa.step(1800), health check only)
 *
 * Env: BASE (origin), OUT_DIR, VIEW_W, VIEW_H.
 */
import fs from 'node:fs';
import path from 'node:path';

const CDP = 'http://127.0.0.1:9222';
const BASE = process.env.BASE ?? 'http://[::1]:5173/';
const OUT = process.env.OUT_DIR
  || path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const VIEW_W = Number(process.env.VIEW_W ?? 1384);
const VIEW_H = Number(process.env.VIEW_H ?? 772);
const MIN_BYTES = 150 * 1024; // under this the frame is almost certainly broken/partial
const POSE = 'pos=0,240,-300';
const STEPS_30S = 1800; // 30 s at 1/60 — the P1 drift pair interval

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

  /** Ready means: qa hook alive on THIS page and the URL is exactly the one we asked for. */
  async waitBoot(dome, extra, timeoutMs = 90000) {
    const want = `${BASE}?qa=frozen&${POSE}&dome=${dome}${extra}`;
    const t0 = Date.now();
    let probeLogged = false;
    while (Date.now() - t0 < timeoutMs) {
      const ready = await this.eval(`
        return Boolean(window.__porco && window.__porco.qa && window.__porco.scene)
          && location.href.includes('qa=frozen')
          && location.href.includes('${POSE}')
          && location.href.includes('dome=${dome}')
          && location.href.includes('${extra}');
      `).catch((e) => { if (!probeLogged) { console.log('[waitBoot eval error]', String(e).slice(0, 200)); probeLogged = true; } return false; });
      if (ready) return want;
      if (!probeLogged) {
        probeLogged = true;
        const probe = await this.eval(
          'return JSON.stringify({url: location.href, porco: typeof window.__porco, qa: Boolean(window.__porco?.qa), scene: Boolean(window.__porco?.scene), ready: document.readyState});',
        ).catch((e) => '[probe error] ' + String(e).slice(0, 200));
        console.log('[waitBoot probe @' + Math.round((Date.now() - t0) / 1000) + 's]', probe);
      }
      await sleep(500);
    }
    return null;
  }

  /** Wall-clock determinism: wait out the 6s boot-status fade (+.6s transition). */
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
    // Headless screenshot occasionally times out (~30s); the same pose succeeds on retry.
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

const DESCRIBE = `
  const q = window.__porco;
  const d = q.qa.describe();
  const whiteout = document.querySelector('.porco-whiteout');
  const boot = document.querySelector('#boot-status');
  return {
    ...d,
    whiteoutOpacity: whiteout ? whiteout.style.opacity : null,
    bootStatusOpacity: boot ? getComputedStyle(boot).opacity : null,
    gpu: Boolean(navigator.gpu),
    backend: q.renderer?.backend?.isWebGPUBackend === true ? 'webgpu' : 'other',
    domeVisible: Boolean(q.world?.dome?.visible ?? q.world?.dome),
  };
`;

/** One loaded page, boot settled, presented at spawn pose. extra = additional query string ('' or '&sunoff=1'). */
async function openSettled(dome, extra = '') {
  const target = await newTab(`${BASE}?qa=frozen&${POSE}&dome=${dome}${extra}`);
  const session = new Session(target);
  await session.open();
  const url = await session.waitBoot(dome, extra);
  if (!url) throw new Error('boot timeout (or URL drifted)');
  const bootStatus = await session.waitBootStatusFade();
  await session.eval(`window.__porco.qa.step(0, 1/60);`);
  await session.eval(PRESENT);
  const desc = await session.eval(DESCRIBE);
  return { session, bootStatus, desc };
}

function summarize(desc, bootStatus, shot, dome, extra) {
  return JSON.stringify({
    dome, extra, bytes: shot.bytes, tries: shot.tries, canvas: desc.canvas,
    plane: desc.plane, camera: desc.camera?.pos, sun: desc.sun?.elevationDeg,
    elapsed: desc.elapsed, backend: desc.backend, gpu: desc.gpu,
    bootStatusFade: bootStatus, domeVisible: desc.domeVisible,
  });
}

const results = {};
const errors = [];

// ---- triple 1: on / off / sunoff at spawn pose, elapsed 0 -------------------
const triple = [
  { name: 'p15-light-on', dome: 1, extra: '' },
  { name: 'p15-light-off', dome: 0, extra: '' },
  { name: 'p15-light-sunoff', dome: 1, extra: '&sunoff=1' },
];
for (const { name, dome, extra } of triple) {
  let done = false;
  for (let attempt = 1; attempt <= 3 && !done; attempt++) {
    let s;
    try {
      s = await openSettled(dome, extra);
      const shot = await s.session.shot(name);
      results[name] = { dome, extra, attempt, bootStatus: s.bootStatus, desc: s.desc, shot };
      console.log(`[ok] ${name}`, summarize(s.desc, s.bootStatus, shot, dome, extra));
      done = true;
    } catch (err) {
      console.log(JSON.stringify({ name, attempt, error: String(err).slice(0, 300) }));
      if (attempt === 3) errors.push(`${name}: ${String(err).slice(0, 200)}`);
    } finally {
      if (s) await s.session.close().catch(() => {});
    }
  }
}

// ---- pair 2: drift t0 / t30 (dome=1, step 1800 between) --------------------
{
  const name0 = 'p15-light-t0';
  const name30 = 'p15-light-t30';
  let done = false;
  for (let attempt = 1; attempt <= 3 && !done; attempt++) {
    let s;
    try {
      s = await openSettled(1);
      const shot0 = await s.session.shot(name0);
      const elapsedAfterStep = await s.session.eval(
        `return window.__porco.qa.step(${STEPS_30S}, 1/60);`,
      );
      await s.session.eval(PRESENT);
      const shot30 = await s.session.shot(name30);
      const desc30 = await s.session.eval(DESCRIBE);
      results[name0] = { dome: 1, extra: '', attempt, bootStatus: s.bootStatus, desc: s.desc, shot: shot0 };
      results[name30] = { dome: 1, extra: '', attempt, elapsedAfterStep, desc: desc30, shot: shot30 };
      console.log(`[ok] ${name0}`, summarize(s.desc, s.bootStatus, shot0, 1, ''));
      console.log(`[ok] ${name30} after step(${STEPS_30S}) elapsed=${elapsedAfterStep}`,
        summarize(desc30, s.bootStatus, shot30, 1, ''));
      done = true;
    } catch (err) {
      console.log(JSON.stringify({ name: `${name0}/${name30}`, attempt, error: String(err).slice(0, 300) }));
      if (attempt === 3) errors.push(`${name0}/${name30}: ${String(err).slice(0, 200)}`);
    } finally {
      if (s) await s.session.close().catch(() => {});
    }
  }
}

const payload = {
  protocol: {
    url: `${BASE}?qa=frozen&${POSE}&dome={1|0}[&sunoff=1]`,
    viewport: [VIEW_W, VIEW_H],
    deviceScaleFactor: 1,
    present: 'qa.step(0) + 2x stepFrame(0) + 2x rAF',
    driftPair: `qa.step(${STEPS_30S}, 1/60) between t0 and t30`,
    minBytes: MIN_BYTES,
  },
  results,
  errors,
};
fs.writeFileSync(path.join(OUT, 'capture-p15-light.json'), JSON.stringify(payload, null, 2));
if (errors.length > 0) {
  console.log('CAPTURE ERRORS:', errors.join(' | '));
  process.exitCode = 1;
} else {
  console.log('capture-p15-light done:', Object.keys(results).join(', '));
}
