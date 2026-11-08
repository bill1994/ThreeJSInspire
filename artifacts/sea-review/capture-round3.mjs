/**
 * Fine-octave round-3 acceptance captures (plan 2026-11-08-sea-nearfield-octave Task 4).
 *
 * Same CDP chain as capture.mjs (11-07 round 1), two viewport conventions:
 *  - sea legs at 720x1280 (canvas strip x∈[80,640), the round-1 measure.py geometry);
 *  - the A3 sun-road budget frame at 448x797 so the canvas fills the page
 *    (measure_bands.py / A3-r2.png convention,出货态 = post ON).
 *
 * New levers exercised here: `?sea=nochop` (c1Gate A/B, Task 1) and
 * `__porco.qa.setQuality(false)` (low-tier residue check).
 *
 * Env: VIEW_W/VIEW_H (default 720x1280), ONLY, PREFIX (default 'round3-'),
 *      BASE (default http://localhost:5193/).
 */
import fs from 'node:fs';
import path from 'node:path';

const CDP = 'http://127.0.0.1:9222';
const BASE = process.env.BASE ?? 'http://localhost:5193/';
const OUT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const VIEW_W = Number(process.env.VIEW_W ?? 720);
const VIEW_H = Number(process.env.VIEW_H ?? 1280);
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const PREFIX = process.env.PREFIX ?? 'round3-';

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
    await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
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
          : p.exceptionDetails ? `[exception] ${p.exceptionDetails.text}` : '';
        if (text) this.logs.push(text);
      }
    };
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    await this.send('Emulation.setDeviceMetricsOverride', { width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1, mobile: false });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout ${method}`)); } }, 120000);
    });
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (res.exceptionDetails) throw new Error(`page eval: ${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description ?? ''}`);
    return res.result.value;
  }
  async waitBoot(timeoutMs = 90000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const ready = await this.eval('return Boolean(window.__porco && window.__porco.qa && window.__porco.scene);').catch(() => false);
      if (ready) return true;
      await sleep(500);
    }
    return false;
  }
  async shot(name) {
    const res = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
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
  { name: 'H240-alt240', url: '?alt=240&qa=frozen&post=0&puff=0', frames: 300 },
  { name: 'H120-alt120', url: '?alt=120&qa=frozen&post=0&puff=0', frames: 300 },
  { name: 'H060-alt60', url: '?alt=60&qa=frozen&post=0&puff=0', frames: 300 },
  { name: 'H020-alt20', url: '?alt=20&qa=frozen&post=0&puff=0', frames: 180 },
  { name: 'H007-alt7', url: '?alt=7&qa=frozen&post=0&puff=0', frames: 180 },
  { name: 'SKIM-dive7', url: '?alt=60&qa=frozen&post=0&puff=0', frames: 180, drag: 72 },
  { name: 'H007-grazing', url: '?alt=7&qa=frozen&post=0&puff=0', frames: 180, freecam: [0, 3, 60, 0, 1.2, -80] },
  // A/B: c1Gate=0 without stopping dispatch (Task 1 hook) — proves the near-field
  // structure comes from the C1 wave field (whole-gate granularity: sub-band AND
  // fine band together; the fine band's separate share is the 62.3% slope-variance
  // test + the vertex low-pass, per plan Task 4 judgement 1).
  { name: 'H007-nochop', url: '?alt=7&qa=frozen&post=0&puff=0&sea=nochop', frames: 180 },
  { name: 'H020-nochop', url: '?alt=20&qa=frozen&post=0&puff=0&sea=nochop', frames: 180 },
  // Low tier: c1Gate is REWRITTEN to 0 by setQuality — fine band has no path to
  // the image, so this frame must match the pre-fix low tier byte-for-byte.
  { name: 'H007-lowtier', url: '?alt=7&qa=frozen&post=0&puff=0', frames: 180, lowtier: true },
  // A3 sun-road budget machine (出货态): post ON, freecam to the plan-A pose.
  { name: 'A3-round3', url: '?qa=frozen', frames: 8, freecam: [-90, 42, 200, -90, 2, -50] },
  { name: 'A3-nochop', url: '?qa=frozen&sea=nochop', frames: 8, freecam: [-90, 42, 200, -90, 2, -50] },
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

    if (st.lowtier) await session.eval('window.__porco.qa.setQuality(false);');

    if (st.drag) {
      await session.eval(`
        const cv = window.__porco.renderer.domElement, r = cv.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const ev = (t, x, y) => cv.dispatchEvent(new PointerEvent(t, {
          pointerId: 23, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true,
          clientX: x, clientY: y, buttons: 1, button: 0 }));
        ev('pointerdown', cx, cy);
        ev('pointermove', cx, cy + ${st.drag});
      `);
    }

    await session.eval(`window.__porco.qa.step(${st.frames}, 1/60);`);

    if (st.freecam) {
      const [x, y, z, ax, ay, az] = st.freecam;
      await session.eval(`
        const q = window.__porco;
        q.game.update = () => {};
        q.camera.position.set(${x}, ${y}, ${z});
        q.camera.up.set(0, 1, 0);
        q.camera.lookAt(${ax}, ${ay}, ${az});
        q.camera.updateProjectionMatrix();
        for (let i = 0; i < 8; i++) q.qa.stepFrame(1/60);
        await new Promise(r => requestAnimationFrame(r));
        await new Promise(r => requestAnimationFrame(r));
      `);
    } else {
      await session.eval(PRESENT);
    }

    const desc = await session.eval(`
      const q = window.__porco;
      const d = q.qa.describe();
      return { ...d, quality: q.world?.quality ?? null, backend: q.renderer?.backend?.isWebGPUBackend === true ? 'webgpu' : 'other' };
    `);
    const shot = await session.shot(name);
    results[name] = { url: st.url, frames: st.frames, drag: st.drag ?? null, freecam: st.freecam ?? null, lowtier: st.lowtier ?? false, viewport: [VIEW_W, VIEW_H], shot, desc, logs: session.logs.slice(-12) };
    console.log(JSON.stringify({ name, bytes: shot.bytes, camera: desc.camera?.pos, canvas: desc.canvas, quality: desc.quality, backend: desc.backend, logs: results[name].logs.slice(0, 3) }));
  } catch (err) {
    results[name] = { url: st.url, error: String(err), logs: session.logs.slice(-12) };
    console.log(JSON.stringify({ name, error: String(err), logs: session.logs.slice(-8) }));
  } finally {
    await session.close().catch(() => {});
  }
}
fs.writeFileSync(path.join(OUT, `capture-round3${VIEW_W !== 720 ? `-${VIEW_W}w` : ''}.json`), JSON.stringify(results, null, 2));
console.log('round3 capture done');
