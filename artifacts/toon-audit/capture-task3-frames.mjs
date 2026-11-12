/**
 * Toon-look-toggle Phase 1 Task 3 — multi-frame capture at ?toon=1 for the
 * band-flicker / IGN-dither gate (Step 5, "档间无静态带纹").
 *
 * METHOD: frozen pose (`?qa=frozen` suppresses the animation loop) plus
 * `qa.step(300, 1/60)` between captures — each step advances ELAPSED by 5 s,
 * which advances the cloud drift uniforms (detail 3.5 m/s, weather 2.0 m/s —
 * src/dome-cloud-field.ts DOME_DRIFT). So consecutive frames are deterministic
 * sim states in which the CLOUD MOVES while the IGN dither (static
 * screenCoordinate noise, dome-cloud.ts :355 `interleavedGradientNoise(xy, 0)`)
 * stays fixed — exactly the conditions "band positions must track the drifting
 * cloud, not a frozen screen pattern" needs. Camera is static (frozen pose,
 * no input), so the dome cloud footprint is identical across frames and the
 * occupancy mask computed by analyze-task3-dome.mjs applies to all of them.
 *
 * Frames (NEW dir, never overwrite): frame-<k>.png k=0..5, sidecar
 * capture-task3-frames.json {protocol, elapsed per frame, logs}.
 *
 * Env: CDP (default http://127.0.0.1:9222 — HEADED Chrome; headless has no
 *      WebGPU adapter), BASE (default http://[::1]:5173/), OUT_DIR,
 *      STEP_FRAMES (default 300 = 5 s sim per gap), FRAME_COUNT (default 6).
 */
import fs from 'node:fs';
import path from 'node:path';

const CDP = process.env.CDP ?? 'http://127.0.0.1:9222';
const BASE = process.env.BASE ?? 'http://[::1]:5173/';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const OUT = process.env.OUT_DIR ?? path.join(HERE, 'task3-frames');
const STEP_FRAMES = Number(process.env.STEP_FRAMES ?? 300);
const FRAME_COUNT = Number(process.env.FRAME_COUNT ?? 6);
const STEP_DT = 1 / 60;
const POSE_QS = `qa=frozen&pos=0,60,-300&toon=1`;

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
      width: 1384, height: 772, deviceScaleFactor: 1, mobile: false,
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
      const ready = await this.eval(`
        return Boolean(window.__porco && window.__porco.qa && window.__porco.scene)
          && window.__porco.qa.frozen === true
          && location.href.includes('toon=1');
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
        if (bytes < 150 * 1024) throw new Error(`suspicious PNG ${bytes} bytes — partial frame`);
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

const payload = {
  protocol: {
    base: BASE,
    cdp: CDP,
    poseQs: POSE_QS,
    viewport: [1384, 772],
    deviceScaleFactor: 1,
    stepFramesPerGap: STEP_FRAMES,
    stepDt: STEP_DT,
    simSecondsPerGap: STEP_FRAMES * STEP_DT,
    frameCount: FRAME_COUNT,
    driftNote: 'detail 3.5 m/s, weather 2.0 m/s (DOME_DRIFT) — cloud moves per gap; IGN dither is static screen noise',
    hud: 'default state — boot-status waited to opacity 0',
  },
  frames: [],
  errors: [],
};

let session;
try {
  const target = await newTab(`${BASE}?${POSE_QS}`);
  session = new Session(target);
  await session.open();
  const booted = await session.waitBoot();
  if (!booted) throw new Error('boot timeout (or URL drifted)');
  const bootStatus = await session.waitBootStatusFade();
  const desc0 = await session.eval('return JSON.stringify(window.__porco.qa.describe())');
  console.log(`[boot] frozen pose ready; bootStatusFade=${bootStatus}; desc=${String(desc0).slice(0, 220)}`);

  for (let k = 0; k < FRAME_COUNT; k++) {
    if (k > 0) {
      const elapsed = await session.eval(`return window.__porco.qa.step(${STEP_FRAMES}, ${STEP_DT});`);
      await session.eval(PRESENT);
      payload.frames.push({ frame: k, elapsed, action: `qa.step(${STEP_FRAMES}, ${STEP_DT}) + PRESENT` });
    } else {
      await session.eval(PRESENT);
      const elapsed = await session.eval('return window.__porco.qa.elapsed;');
      payload.frames.push({ frame: 0, elapsed, action: 'boot + PRESENT' });
    }
    const shot = await session.shot(`frame-${k}`);
    payload.frames[payload.frames.length - 1].pngBytes = shot.bytes;
    console.log(`[frame-${k}] elapsed=${payload.frames[payload.frames.length - 1].elapsed} bytes=${shot.bytes}`);
  }
  payload.logs = session.logs.slice(-12);
} catch (err) {
  payload.errors.push(String(err).slice(0, 400));
} finally {
  if (session) await session.close().catch(() => {});
}

fs.writeFileSync(path.join(OUT, 'capture-task3-frames.json'), JSON.stringify(payload, null, 2));
if (payload.errors.length > 0) {
  console.log('CAPTURE ERRORS:', payload.errors.join(' | '));
  process.exitCode = 1;
} else {
  console.log(`capture-task3-frames done: ${FRAME_COUNT} frames, ${STEP_FRAMES * STEP_DT}s sim per gap`);
}
