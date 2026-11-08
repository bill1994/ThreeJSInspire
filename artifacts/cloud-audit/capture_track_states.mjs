/**
 * Day-night track acceptance captures (2026-11-08 Task 8).
 *
 * Drives the frozen-QA page through CDP (same chain the 11-07 sea review proved:
 * headless Chrome + `__porco.qa.step`, no new deps). Captures the four day states
 * with the exact inputs recorded in protocol/capture-protocol.json plus the three
 * night keys at the A-cruise machine, so the ONLY variable per night frame is the
 * sun elevation.
 *
 * Env:
 *   PREFIX=repeat-  second independent load of the same states (byte-identical gate)
 *   ONLY=A-cruise-alt60,N-night-sun-8   subset
 *   BASE=http://127.0.0.1:5193/         dev server origin
 *
 * Night azimuth: atan2(SUN_POSITION[0], -SUN_POSITION[2]) = atan2(60, 280) —
 * computed here once, never a copied literal.
 */
import fs from 'node:fs';
import path from 'node:path';

const CDP = 'http://127.0.0.1:9222';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5193/';
const OUT = path.join(process.env.OUT_DIR ?? path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'protocol');
const VIEW_W = Number(process.env.VIEW_W ?? 1384);
const VIEW_H = Number(process.env.VIEW_H ?? 797);
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const PREFIX = process.env.PREFIX ?? '';

const AZ = (Math.atan2(60, 280) * 180) / Math.PI; // default sun bearing, degrees

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
    const t0 = Date.now();
    let logged = false;
    while (Date.now() - t0 < timeoutMs) {
      const ready = await this.eval(
        'return Boolean(window.__porco && window.__porco.qa && window.__porco.scene);',
      ).catch((e) => { if (!logged) { console.log('[waitBoot eval error]', String(e).slice(0, 200)); logged = true; } return false; });
      if (ready) return true;
      if (!logged) {
        logged = true;
        const probe = await this.eval(
          'return JSON.stringify({url: location.href, porco: typeof window.__porco, qa: Boolean(window.__porco?.qa), scene: Boolean(window.__porco?.scene), boot: (document.querySelector("#boot-status")||{}).textContent ?? null, ready: document.readyState});',
        ).catch((e) => '[probe error] ' + String(e).slice(0, 200));
        console.log('[waitBoot probe @' + Math.round((Date.now() - t0) / 1000) + 's]', probe);
      }
      await sleep(500);
    }
    return false;
  }

  async shot(name) {
    const res = await this.send('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: false,
    });
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
    return { file, bytes: fs.statSync(file).size };
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

const states = [
  // The four day states — inputs MUST match protocol/capture-protocol.json.
  { name: 'A-cruise-alt60', url: '?alt=60&qa=frozen', frames: 600 },
  { name: 'B-dive-alt200', url: '?alt=200&qa=frozen', frames: 90, drag: [0, 40] },
  { name: 'C-bankdive-alt220', url: '?alt=220&qa=frozen', frames: 90, drag: [-95, 40] },
  { name: 'D-skim-alt60', url: '?alt=60&qa=frozen', frames: 180, drag: [0, 72] },
  // Night keys — A-cruise machine, sun moved by ?sun (az,el), no other change.
  { name: 'N-dusk-sun0', url: `?sun=${AZ.toFixed(2)},0&alt=60&qa=frozen`, frames: 600 },
  { name: 'N-civil-sun-4', url: `?sun=${AZ.toFixed(2)},-4&alt=60&qa=frozen`, frames: 600 },
  { name: 'N-night-sun-8', url: `?sun=${AZ.toFixed(2)},-8&alt=60&qa=frozen`, frames: 600 },
];

let session;
const results = {};
for (const st of states) {
  if (ONLY && !ONLY.has(st.name)) continue;
  const name = PREFIX + st.name;
  const target = await newTab(BASE + st.url);
  session = new Session(target);
  try {
    await session.open();
    const ready = await session.waitBoot();
    if (!ready) throw new Error('boot timeout');

    await session.eval(`
      document.querySelectorAll('.porco-hud').forEach(e => { e.style.display = 'none'; });
      const b = document.querySelector('#boot-status'); if (b) b.style.display = 'none';
    `);

    if (st.drag) {
      const [dx, dy] = st.drag;
      await session.eval(`
        const cv = window.__porco.renderer.domElement, r = cv.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const ev = (t, x, y) => cv.dispatchEvent(new PointerEvent(t, {
          pointerId: 23, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true,
          clientX: x, clientY: y, buttons: 1, button: 0 }));
        ev('pointerdown', cx, cy);
        ev('pointermove', cx + ${dx}, cy + ${dy});
      `);
    }

    await session.eval(`window.__porco.qa.step(${st.frames}, 1/60);`);
    await session.eval(PRESENT);

    const desc = await session.eval(`
      const q = window.__porco;
      const d = q.qa.describe();
      const stars = q.scene.children.filter(o => o.name === 'sky_stars');
      const whiteout = document.querySelector('.porco-whiteout');
      return {
        ...d,
        stars: stars.length ? { opacity: stars[0].material.opacity, y: stars[0].position.y } : null,
        whiteoutOpacity: whiteout ? whiteout.style.opacity : null,
        gpu: Boolean(navigator.gpu),
        backend: q.renderer?.backend?.isWebGPUBackend === true ? 'webgpu' : 'other',
      };
    `);
    const shot = await session.shot(name);
    results[name] = { url: st.url, frames: st.frames, drag: st.drag ?? null, viewport: [VIEW_W, VIEW_H], shot, desc, logs: session.logs.slice(-12) };
    console.log(JSON.stringify({ name, bytes: shot.bytes, sun: desc.sun, stars: desc.stars, plane: desc.plane, camera: desc.camera?.pos, canvas: desc.canvas, boot: desc.boot, backend: desc.backend, logs: results[name].logs.slice(0, 4) }));
  } catch (err) {
    results[name] = { url: st.url, error: String(err), logs: session.logs.slice(-12) };
    console.log(JSON.stringify({ name, error: String(err), logs: session.logs.slice(-8) }));
  } finally {
    await session.close().catch(() => {});
  }
}
fs.writeFileSync(path.join(path.dirname(OUT), `capture-track${PREFIX ? '-' + PREFIX.replace(/-$/, '') : ''}.json`), JSON.stringify(results, null, 2));
console.log('capture-track done');
