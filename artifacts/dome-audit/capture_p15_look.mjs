/**
 * Dome-cloud Task 6 — P2 soft/flat switchable looks (uLook output branch),
 * same protocol as Task 0.5/3/4/5.
 *
 * Protocol (docs/superpowers/reviews/2026-11-09-dome-cloud-p1-review.md §1/§4):
 *   URL    http://[::1]:5173/?qa=frozen&pos=0,240,-300&dome={1|0} [&cloudlook=flat] [&post=0]
 *          IPv6 literal — vite binds IPv6-only; Chrome races IPv4/6 on localhost.
 *   viewport 1384x772, deviceScaleFactor 1 → #frame fills height at 9:16,
 *          canvas drawing buffer 434x772 centered (rect 474.875,0,434.25,772).
 *   wait   boot ready (__porco.qa + __porco.scene) AND location.href still carries
 *          qa=frozen AND pos AND dome AND the extra params (stale __porco false-ready guard)
 *   wait   #boot-status computed opacity reaches '0' (6s fade + .6s transition)
 *   step   qa.step(0)                    (zero frames advanced, spawn pose)
 *   present 2 rounds of qa.stepFrame(0) + 2 rAF
 *   shot   Page.captureScreenshot, retry on timeout / <150KB partial frame
 *
 * Frames (new names — never overwrite baseline or earlier P1.5/P2 frames; ITER env
 * appends a suffix so calibration probes never touch the canonical record frames):
 *   p15-look-soft-on.png      ?qa=frozen&pos=0,240,-300&dome=1            (soft, post on)
 *   p15-look-soft-off.png     ?qa=frozen&pos=0,240,-300&dome=0            (cloud mask)
 *   p15-look-flat-on.png      ...&dome=1&cloudlook=flat                   (flat, post on)
 *   p15-look-flat-off.png     ...&dome=0&cloudlook=flat                   (cloud mask)
 *   p15-look-soft-nopost.png  ...&dome=1&post=0                           (edge eyeball, §12.3)
 *   p15-look-flat-nopost.png  ...&dome=1&cloudlook=flat&post=0            (edge eyeball, §12.3)
 *
 * Env: BASE (origin), OUT_DIR, VIEW_W, VIEW_H, ITER (frame-name suffix, default '').
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
const ITER = process.env.ITER ?? '';

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

/** One loaded page, boot settled, presented at spawn pose. extra = additional query string (''). */
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

// ---- soft / flat on-off pairs (post on) + post=0 edge-eyeball pair (§12.3) ---
const triple = [
  { name: `p15-look-soft-on${ITER}`, dome: 1, extra: '' },
  { name: `p15-look-soft-off${ITER}`, dome: 0, extra: '' },
  { name: `p15-look-flat-on${ITER}`, dome: 1, extra: '&cloudlook=flat' },
  { name: `p15-look-flat-off${ITER}`, dome: 0, extra: '&cloudlook=flat' },
  { name: `p15-look-soft-nopost${ITER}`, dome: 1, extra: '&post=0' },
  { name: `p15-look-flat-nopost${ITER}`, dome: 1, extra: '&cloudlook=flat&post=0' },
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

const payload = {
  protocol: {
    url: `${BASE}?qa=frozen&${POSE}&dome={1|0}[&cloudlook=flat][&post=0]`,
    viewport: [VIEW_W, VIEW_H],
    deviceScaleFactor: 1,
    present: 'qa.step(0) + 2x stepFrame(0) + 2x rAF',
    iterSuffix: ITER,
  },
  results,
  errors,
};
fs.writeFileSync(path.join(OUT, `capture-p15-look${ITER}.json`), JSON.stringify(payload, null, 2));
if (errors.length > 0) {
  console.log('CAPTURE ERRORS:', errors.join(' | '));
  process.exitCode = 1;
} else {
  console.log('capture-p15-look done:', Object.keys(results).join(', '));
}
