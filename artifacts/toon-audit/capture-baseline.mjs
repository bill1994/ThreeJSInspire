/**
 * Toon-look-toggle Phase 1 Task 0 — uToon=0 baseline frames (gate-1 reference).
 *
 * Captures the CURRENT rendering (uToon does not exist yet) at three pinned poses.
 * Tasks 2/3/4/6 re-run this protocol with `?toon=0` (default) and compare the PNGs
 * BYTE-FOR-BYTE against these baselines — capture determinism is the whole point.
 * Nothing under src/ is touched by this script.
 *
 * Protocol (2026-10-31 capture protocol + dome-audit p15 + cloud-audit precedent):
 *   CDP    http://127.0.0.1:9222 — HEADED Chrome, default flags (headless has no
 *          WebGPU adapter on this machine: repair-phase1 task-1-report §2; a
 *          dedicated --user-data-dir avoids the "reuse running process" trap)
 *   BASE   http://[::1]:5173/ — vite binds IPv6-only; Chrome racing IPv4/6 on
 *          localhost FAILS, so the IPv6 literal is mandatory
 *   poses  three baseline poses, exact URLs recorded verbatim in each sidecar:
 *            ref-level    ?alt=60&qa=frozen             — reference look, level
 *                          flight (capture-protocol A-cruise: no input, 600 frames
 *                          → plane [0,60,-460]), DEFAULT sun
 *            horizon-low  ?qa=frozen&pos=0,60,-300      — low-altitude horizontal
 *                          camera (y=60, pitch 0°; dome-audit p15 pose), step 0
 *            night        ?sun=12,-8&alt=60&qa=frozen   — A-cruise machine, night
 *                          key: az 12° aligns with the default sun bearing
 *                          (atan2(60,280)≈12.1°), el −8° = night (plan Task 0 pins
 *                          the literal `?sun=12,-8`)
 *   viewport 1384x772, deviceScaleFactor 1 → canvas 434x772 (rect 474.875,0,434.25,772)
 *   wait   boot ready (__porco.qa + __porco.scene AND location.href still carries
 *          this pose's query — stale-__porco false-ready guard) AND #boot-status
 *          computed opacity reaches '0'
 *   hud    DEFAULT state — no HUD-hiding flags anywhere (task brief overrides the
 *          old capture-protocol HUD-hiding practice: future ?toon=0 A/B frames
 *          must reproduce this exact default, HUD status line included; frozen
 *          HUD values are deterministic — fps reads 60 at dt=1/60, 0 at dt=0)
 *   step   qa.step(N, 1/60) then 2 rounds of qa.stepFrame(0) + 2 rAF (a single
 *          present round can yield a blank frame — capture protocol Review Focus 2)
 *   shot   Page.captureScreenshot, retry on timeout / <150KB partial frame
 *   gate   pass 2 (PREFIX-independent second load of the same URLs) must be
 *          BYTE-IDENTICAL to pass 1 — the script enforces it and exits non-zero
 *          otherwise (capture protocol §4 acceptance gate)
 *
 * Frames (NEW names — never overwrite anything):
 *   baseline-ref-level.png      baseline-horizon-low.png      baseline-night-sun12-8.png
 *   + repeat-<name>.png second-load twins (stability gate evidence)
 *   + <name>.json sidecars {url, query, frames, desc=qa.describe() + backend/hud}
 *   + capture-baseline.json summary (protocol + both passes + byte-compare verdict)
 *
 * Env: BASE, OUT_DIR, VIEW_W, VIEW_H, ONLY (comma subset), SKIP_REPEAT=1.
 */
import fs from 'node:fs';
import path from 'node:path';

const CDP = 'http://127.0.0.1:9222';
const BASE = process.env.BASE ?? 'http://[::1]:5173/';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const OUT = process.env.OUT_DIR ?? path.join(HERE, 'baseline');
const VIEW_W = Number(process.env.VIEW_W ?? 1384);
const VIEW_H = Number(process.env.VIEW_H ?? 772);
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const SKIP_REPEAT = process.env.SKIP_REPEAT === '1';
const MIN_BYTES = 150 * 1024; // under this the frame is almost certainly broken/partial
const STEP_DT = 1 / 60;
const CRUISE_FRAMES = 600; // capture-protocol A-cruise: elapsed 10, plane [0,60,-460]

fs.mkdirSync(OUT, { recursive: true });

const POSES = [
  { name: 'baseline-ref-level', qs: 'alt=60&qa=frozen', frames: CRUISE_FRAMES },
  { name: 'baseline-horizon-low', qs: 'qa=frozen&pos=0,60,-300', frames: 0 },
  { name: 'baseline-night-sun12-8', qs: 'sun=12,-8&alt=60&qa=frozen', frames: CRUISE_FRAMES },
];

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

  /** Ready means: qa hook alive on THIS page and the URL is exactly the pose we asked for. */
  async waitBoot(qs, timeoutMs = 90000) {
    const t0 = Date.now();
    let probeLogged = false;
    while (Date.now() - t0 < timeoutMs) {
      const ready = await this.eval(`
        return Boolean(window.__porco && window.__porco.qa && window.__porco.scene)
          && window.__porco.qa.frozen === true
          && location.href.includes('${qs}');
      `).catch((e) => { if (!probeLogged) { console.log('[waitBoot eval error]', String(e).slice(0, 200)); probeLogged = true; } return false; });
      if (ready) return true;
      if (!probeLogged) {
        probeLogged = true;
        const probe = await this.eval(
          'return JSON.stringify({url: location.href, porco: typeof window.__porco, qa: Boolean(window.__porco?.qa), frozen: Boolean(window.__porco?.qa?.frozen), scene: Boolean(window.__porco?.scene), ready: document.readyState});',
        ).catch((e) => '[probe error] ' + String(e).slice(0, 200));
        console.log('[waitBoot probe @' + Math.round((Date.now() - t0) / 1000) + 's]', probe);
      }
      await sleep(500);
    }
    return false;
  }

  /** Wall-clock determinism: wait out the 6s boot-status fade (+.6s transition). */
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
  };
`;

/** One loaded page, boot settled, stepped to the pose's frame count, presented. */
async function capturePose(session, pose) {
  const url = await session.waitBoot(pose.qs);
  if (!url) throw new Error('boot timeout (or URL drifted)');
  const bootStatus = await session.waitBootStatusFade();
  const elapsed = await session.eval(`return window.__porco.qa.step(${pose.frames}, ${STEP_DT});`);
  await session.eval(PRESENT);
  const desc = await session.eval(DESCRIBE);
  if (desc.backend !== 'webgpu' || !desc.gpu) {
    throw new Error(`renderer fell back: backend=${desc.backend} gpu=${desc.gpu} — baselines must come from WebGPU`);
  }
  const hudMaster = desc.ticker?.master ?? null;
  return { bootStatus, elapsed, desc, hudMaster };
}

function summarize(desc, bootStatus, shot, pose, elapsed) {
  return JSON.stringify({
    pose: pose.name, bytes: shot.bytes, tries: shot.tries, canvas: desc.canvas,
    plane: desc.plane, camera: desc.camera?.pos, sun: desc.sun,
    elapsed, quality: desc.quality, backend: desc.backend, gpu: desc.gpu,
    bootStatusFade: bootStatus, hudMaster: desc.ticker?.master,
  });
}

async function runPass(prefix) {
  const results = {};
  for (const pose of POSES) {
    if (ONLY && !ONLY.has(pose.name)) continue;
    const name = prefix + pose.name;
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      let session;
      try {
        const target = await newTab(`${BASE}?${pose.qs}`);
        session = new Session(target);
        await session.open();
        const { bootStatus, elapsed, desc, hudMaster } = await capturePose(session, pose);
        const shot = await session.shot(name);
        results[pose.name] = {
          url: `${BASE}?${pose.qs}`,
          query: pose.qs,
          frames: pose.frames,
          stepDt: STEP_DT,
          present: 'qa.step(N, 1/60) + 2x(stepFrame(0) + 2x rAF)',
          hud: 'default state (no hiding) — boot-status waited to opacity 0',
          viewport: [VIEW_W, VIEW_H],
          deviceScaleFactor: 1,
          png: `${name}.png`,
          pngBytes: shot.bytes,
          bootStatusFade: bootStatus,
          elapsed,
          desc,
          logs: session.logs.slice(-12),
        };
        fs.writeFileSync(
          path.join(OUT, `${name}.json`),
          JSON.stringify(results[pose.name], null, 2),
        );
        console.log(`[ok] ${name}`, summarize(desc, bootStatus, shot, pose, elapsed), `hudMaster=${hudMaster}`);
        ok = true;
      } catch (err) {
        console.log(JSON.stringify({ name, attempt, error: String(err).slice(0, 300) }));
        if (attempt === 3) throw new Error(`${name}: ${String(err).slice(0, 200)}`);
      } finally {
        if (session) await session.close().catch(() => {});
      }
    }
  }
  return results;
}

function byteCompare(first, second) {
  const rows = {};
  let all = true;
  for (const pose of POSES) {
    if (ONLY && !ONLY.has(pose.name)) continue;
    const a = path.join(OUT, `${pose.name}.png`);
    const b = path.join(OUT, `repeat-${pose.name}.png`);
    const identical = fs.readFileSync(a).equals(fs.readFileSync(b));
    rows[pose.name] = {
      first: path.basename(a),
      repeat: path.basename(b),
      byteIdentical: identical,
      firstBytes: fs.statSync(a).size,
      repeatBytes: fs.statSync(b).size,
    };
    if (!identical) all = false;
    console.log(`[repeat] ${pose.name}: ${identical ? 'BYTE-IDENTICAL' : 'MISMATCH'}`);
  }
  return { rows, allIdentical: all };
}

const payload = {
  protocol: {
    base: BASE,
    cdp: CDP,
    chrome: 'headed, default flags (WebGPU needs D3D12; headless has no adapter here)',
    poses: POSES,
    viewport: [VIEW_W, VIEW_H],
    deviceScaleFactor: 1,
    hud: 'default (no hiding) — future ?toon=0 A/B frames must reproduce this exact default',
    step: `qa.step(N, ${STEP_DT}) then 2 rounds of qa.stepFrame(0) + 2 rAF`,
    minBytes: MIN_BYTES,
    stabilityGate: 'pass 2 (repeat- prefix, independent load) byte-identical to pass 1',
  },
  first: null,
  repeat: null,
  compare: null,
  errors: [],
};

try {
  payload.first = await runPass('');
  if (!SKIP_REPEAT) {
    payload.repeat = await runPass('repeat-');
    payload.compare = byteCompare(payload.first, payload.repeat);
    if (!payload.compare.allIdentical) {
      payload.errors.push('stability gate FAILED: repeat frames not byte-identical — fix capture determinism before committing baselines');
    }
  }
} catch (err) {
  payload.errors.push(String(err).slice(0, 400));
}

fs.writeFileSync(path.join(OUT, 'capture-baseline.json'), JSON.stringify(payload, null, 2));
if (payload.errors.length > 0) {
  console.log('CAPTURE ERRORS:', payload.errors.join(' | '));
  process.exitCode = 1;
} else {
  const names = Object.keys(payload.first).join(', ');
  const gate = payload.compare ? `stability gate ${payload.compare.allIdentical ? 'PASS' : 'FAIL'}` : 'stability gate SKIPPED';
  console.log(`capture-baseline done: ${names}; ${gate}`);
}
