/**
 * Sea review capture — drives the running page through CDP (no new deps).
 * Frozen QA states only, so every frame is reproducible from its URL + step count.
 */
import fs from 'node:fs';
import path from 'node:path';

const CDP = 'http://127.0.0.1:9222';
const BASE = 'http://127.0.0.1:5190/';
const OUT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const VIEW_W = Number(process.env.VIEW_W ?? 720);
const VIEW_H = Number(process.env.VIEW_H ?? 1280);
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const PREFIX = process.env.PREFIX ?? '';

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
    while (Date.now() - t0 < timeoutMs) {
      const ready = await this.eval(
        'return Boolean(window.__porco && window.__porco.qa && window.__porco.scene);',
      ).catch(() => false);
      if (ready) return true;
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

async function describe() {
  return await session.eval(`
    const q = window.__porco;
    const d = q.qa.describe();
    const seaMeshes = q.scene.children.filter(o => o.name && o.name.startsWith('sea-r'));
    const whiteout = document.querySelector('.porco-whiteout');
    return {
      ...d,
      boot: document.querySelector('#boot-status')?.textContent ?? null,
      seaMeshCount: seaMeshes.length,
      seaMeshVisible: seaMeshes.map(m => m.visible),
      seaMeshPos: seaMeshes.map(m => m.position.toArray().map(v => +v.toFixed(1))),
      whiteoutOpacity: whiteout ? whiteout.style.opacity : null,
      gpu: Boolean(navigator.gpu),
      backend: q.renderer?.backend?.isWebGPUBackend === true ? 'webgpu' : 'other',
    };
  `);
}

const states = [
  { name: 'H240-alt240', url: '?alt=240&qa=frozen&post=0&puff=0', frames: 300 },
  { name: 'H120-alt120', url: '?alt=120&qa=frozen&post=0&puff=0', frames: 300 },
  { name: 'H060-alt60', url: '?alt=60&qa=frozen&post=0&puff=0', frames: 300 },
  { name: 'H060-post-on', url: '?alt=60&qa=frozen&puff=0', frames: 300 },
  { name: 'H020-alt20', url: '?alt=20&qa=frozen&post=0&puff=0', frames: 180 },
  { name: 'H007-alt7', url: '?alt=7&qa=frozen&post=0&puff=0', frames: 180 },
  { name: 'SKIM-dive7', url: '?alt=60&qa=frozen&post=0&puff=0', frames: 180, drag: 72 },
  { name: 'H020-debug', url: '?alt=20&qa=frozen&post=0&puff=0&sea=debug', frames: 180 },
  { name: 'H020-sea-off', url: '?alt=20&qa=frozen&post=0&puff=0&sea=0', frames: 180 },
  { name: 'H007-grazing', url: '?alt=7&qa=frozen&post=0&puff=0', frames: 180, freecam: [0, 3, 60, 0, 1.2, -80] },
  { name: 'H007-topdown', url: '?alt=7&qa=frozen&post=0&puff=0', frames: 180, freecam: [0, 35, 45, 0, 0, -20] },
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

    const desc = await describe();
    const shot = await session.shot(name);
    results[name] = { url: st.url, frames: st.frames, drag: st.drag ?? null, freecam: st.freecam ?? null, viewport: [VIEW_W, VIEW_H], shot, desc, logs: session.logs.slice(-12) };
    console.log(JSON.stringify({ name, bytes: shot.bytes, plane: desc.plane, camera: desc.camera.pos, canvas: desc.canvas, aspect: desc.camera.aspect, boot: desc.boot, gpu: desc.gpu, backend: desc.backend, seaMeshCount: desc.seaMeshCount, calls: desc.render.calls, tris: desc.render.triangles, logs: results[name].logs.slice(0, 4) }));
  } catch (err) {
    results[name] = { url: st.url, error: String(err), logs: session.logs.slice(-12) };
    console.log(JSON.stringify({ name, error: String(err), logs: session.logs.slice(-8) }));
  } finally {
    await session.close().catch(() => {});
  }
}
fs.writeFileSync(path.join(OUT, `capture${PREFIX ? '-' + PREFIX.replace(/-$/, '') : ''}.json`), JSON.stringify(results, null, 2));
