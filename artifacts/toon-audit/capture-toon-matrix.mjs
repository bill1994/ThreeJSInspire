/**
 * Toon-look-toggle Phase 1 Task 6 — acceptance matrix capture (six-gate closure).
 *
 * Captures the FULL Task 6 matrix in ONE process run — control twin and variant
 * twins are captured back-to-back in the same Chrome session and byte-compared
 * IN-RUN (Task 1 ruling 2026-11-13: "对照 twin + 变体 twin 同一采集运行内抓取、
 * 运行内比对" — this operationalizes the ruling one notch tighter than the
 * Tasks 2-4 two-process runs: the pair shares one capture run, not just one
 * browser session).
 *
 * Per pose (matrix variants, all fresh tabs, all frames named `baseline-<pose>`):
 *   control    pose qs as-is                  -> matrix/control/baseline-<pose>.png
 *   toon0      pose qs + &toon=0              -> matrix/toon0/baseline-<pose>.png
 *              BYTE-COMPARED vs control IN-RUN  — GATE 1 primary instrument
 *   toon1      pose qs + &toon=1              -> matrix/toon1/baseline-<pose>.png
 *              (gate 2 variant frame)
 *   nodome     pose qs + &dome=0              -> matrix/nodome/baseline-<pose>.png
 *              (cloud occupancy mask source: |control − nodome| > 0, Task 3 method)
 *   toon05     ref-level + &toon=0.5          -> matrix/toon05/baseline-ref-level.png
 *              (transition frame, Review Focus 1)
 *   seam pair  horizon-low, HUD hidden (`.porco-hud` display:none — the
 *              analyze_horizon_isolation.py discipline: HUD hidden + explicit
 *              render flush + isolation band + control frame):
 *                matrix/seam-control/baseline-horizon-low.png
 *                matrix/seam-toon1/baseline-horizon-low.png (qs + &toon=1)
 *
 * Stability gate: control is re-loaded a second time (fresh tab) per pose and
 * byte-compared against pass 1 IN MEMORY — repeat PNGs are only written on
 * MISMATCH (forensics), otherwise the run records sha256 of both loads.
 *
 * Protocol (identical to capture-baseline.mjs — capture determinism is the point):
 *   CDP    http://127.0.0.1:9222 — HEADED Chrome (headless has no WebGPU adapter)
 *   BASE   http://[::1]:5173/ — vite binds IPv6-only, the literal is mandatory
 *   poses  ref-level (?alt=60&qa=frozen, 600 cruise frames) / horizon-low
 *          (?qa=frozen&pos=0,60,-300, 0 frames) / night (?sun=12,-8&alt=60&qa=frozen,
 *          600 frames) — exact URLs recorded verbatim in each sidecar
 *   viewport 1384x772, DPR 1 → canvas 434x772 (rect 474.875,0,434.25,772)
 *   hud    DEFAULT state for matrix variants (Task 0 protocol: A/B frames
 *          reproduce the default HUD); HUD hidden ONLY for the seam pair
 *          (isolation caliber requirement, recorded in their sidecars)
 *   shot   Page.captureScreenshot with retry on timeout / <150KB partial frame
 *
 * Outputs (under artifacts/toon-audit/):
 *   matrix/<variant>/baseline-<pose>.png + .json sidecars
 *     (sidecar: {url, query, variant, hudHidden, frames, desc, pngBytes, sha256})
 *   matrix/capture-matrix.json  — protocol + sha256 table + gate-1 byteCompare
 *     rows + stability rows + errors; exit non-zero if gate 1 or stability fails.
 *   matrix/frames/  — created EMPTY (analyzer FRAMES override target: Task 3's
 *     multi-frame flicker gate is NOT re-run here, the dome analyzer skips it)
 *
 * Env: BASE, OUT_ROOT (default <here>/matrix), ONLY (comma pose subset),
 *      SKIP_REPEAT=1, SKIP_SEAM=1, SKIP_NODOME=1.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CDP = 'http://127.0.0.1:9222';
const BASE = process.env.BASE ?? 'http://[::1]:5173/';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = process.env.OUT_ROOT ?? path.join(HERE, 'matrix');
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const SKIP_REPEAT = process.env.SKIP_REPEAT === '1';
const SKIP_SEAM = process.env.SKIP_SEAM === '1';
const SKIP_NODOME = process.env.SKIP_NODOME === '1';
const VIEW_W = 1384;
const VIEW_H = 772;
const MIN_BYTES = 150 * 1024; // under this the frame is almost certainly broken/partial
const STEP_DT = 1 / 60;
const CRUISE_FRAMES = 600; // capture-protocol A-cruise: elapsed 10, plane [0,60,-460]

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(path.join(ROOT, 'frames'), { recursive: true }); // empty on purpose — see header

const POSES = [
  { name: 'baseline-ref-level', qs: 'alt=60&qa=frozen', frames: CRUISE_FRAMES, seam: false },
  { name: 'baseline-horizon-low', qs: 'qa=frozen&pos=0,60,-300', frames: 0, seam: true },
  { name: 'baseline-night-sun12-8', qs: 'sun=12,-8&alt=60&qa=frozen', frames: CRUISE_FRAMES, seam: false },
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
    // ENV CONTRACT (capture-baseline.mjs header, Task 6): the capture Chrome
    // must be launched with --disable-features=CalculateNativeWinOcclusion —
    // a born-occluded window gets stuck visibilityState 'hidden', rAF stops
    // and the PRESENT round hangs (bringToFront does NOT clear it; only the
    // launch flag does). bringToFront stays as harmless belt-and-braces.
    await this.send('Page.bringToFront');
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

  async shotBytes() {
    for (let i = 1; i <= 3; i++) {
      try {
        const res = await this.send('Page.captureScreenshot', {
          format: 'png', fromSurface: true, captureBeyondViewport: false,
        });
        const buf = Buffer.from(res.data, 'base64');
        if (buf.length < MIN_BYTES) throw new Error(`suspicious PNG ${buf.length} bytes (< ${MIN_BYTES}) — partial frame`);
        return buf;
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

const HIDE_HUD = `
  const hud = document.querySelector('.porco-hud');
  if (!hud) return 'no-hud-root';
  hud.style.display = 'none';
  return 'hidden';
`;

/**
 * One loaded page, boot settled, stepped to the variant's frame count,
 * presented, (optionally HUD hidden after the boot fade), described.
 * Returns { bytes, desc, bootStatus }.
 */
async function captureVariant(variant) {
  const url = `${BASE}?${variant.qs}`;
  const target = await newTab(url);
  const session = new Session(target);
  await session.open();
  try {
    const ok = await session.waitBoot(variant.qs);
    if (!ok) throw new Error('boot timeout (or URL drifted)');
    const bootStatus = await session.waitBootStatusFade();
    let hudHidden = false;
    if (variant.hideHud) {
      const state = await session.eval(HIDE_HUD);
      if (state !== 'hidden') throw new Error(`HUD hide failed: ${state}`);
      hudHidden = true;
    }
    const elapsed = await session.eval(`return window.__porco.qa.step(${variant.frames}, ${STEP_DT});`);
    await session.eval(PRESENT);
    const desc = await session.eval(DESCRIBE);
    if (desc.backend !== 'webgpu' || !desc.gpu) {
      throw new Error(`renderer fell back: backend=${desc.backend} gpu=${desc.gpu} — matrix frames must come from WebGPU`);
    }
    const bytes = await session.shotBytes();
    return { bytes, desc, bootStatus, hudHidden, elapsed, url, logs: session.logs.slice(-12) };
  } finally {
    await session.close().catch(() => {});
  }
}

async function captureStable(variant, dir, label) {
  let result = null;
  for (let attempt = 1; attempt <= 3 && !result; attempt++) {
    try {
      result = await captureVariant(variant);
    } catch (err) {
      console.log(JSON.stringify({ label, attempt, error: String(err).slice(0, 300) }));
      if (attempt === 3) throw new Error(`${label}: ${String(err).slice(0, 200)}`);
    }
  }
  const file = path.join(dir, `${variant.pose}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, result.bytes);
  const sidecar = {
    url: result.url,
    query: variant.qs,
    variant: variant.key,
    pose: variant.pose,
    hudHidden: result.hudHidden,
    frames: variant.frames,
    stepDt: STEP_DT,
    present: 'qa.step(N, 1/60) + 2x(stepFrame(0) + 2x rAF)',
    hud: variant.hideHud
      ? 'HIDDEN for this frame (.porco-hud display:none after boot fade — horizon-isolation caliber)'
      : 'default state (no hiding) — Task 0 protocol default',
    viewport: [VIEW_W, VIEW_H],
    deviceScaleFactor: 1,
    pngBytes: result.bytes.length,
    sha256: sha256(result.bytes),
    bootStatusFade: result.bootStatus,
    elapsed: result.elapsed,
    desc: result.desc,
    logs: result.logs,
  };
  fs.writeFileSync(path.join(dir, `${variant.pose}.json`), JSON.stringify(sidecar, null, 2));
  console.log(`[ok] ${label} ${variant.pose}: ${result.bytes.length} bytes sha=${sidecar.sha256.slice(0, 12)}${result.hudHidden ? ' hud=HIDDEN' : ''}`);
  return { bytes: result.bytes, sidecar };
}

const payload = {
  protocol: {
    base: BASE,
    cdp: CDP,
    chrome: 'headed, default flags (WebGPU needs D3D12; headless has no adapter here)',
    poses: POSES.map((p) => ({ name: p.name, qs: p.qs, frames: p.frames })),
    viewport: [VIEW_W, VIEW_H],
    deviceScaleFactor: 1,
    pairing: 'control + variants captured back-to-back in THIS single run; byte-compared in-run (Task 1 ruling, same-run form)',
    step: `qa.step(N, ${STEP_DT}) then 2 rounds of qa.stepFrame(0) + 2 rAF`,
    stabilityGate: 'control re-loaded per pose (fresh tab), byte-compared vs pass 1 in memory; repeat PNG written only on MISMATCH',
    gate1: '?toon=0 vs same-run control twin, byte-identical per pose',
    seamPair: 'horizon-low, .porco-hud display:none (horizon-isolation caliber: HUD hidden + explicit render flush + isolation band + control frame)',
  },
  frames: {},
  gate1: {},
  stability: {},
  errors: [],
};

function variantOf(pose, key, extraQs, hideHud = false) {
  return {
    key,
    pose: pose.name,
    qs: extraQs ? `${pose.qs}&${extraQs}` : pose.qs,
    frames: pose.frames,
    hideHud,
  };
}

try {
  for (const pose of POSES) {
    if (ONLY && !ONLY.has(pose.name)) continue;

    // ---- pass 1: control ----
    const control = await captureStable(variantOf(pose, 'control', ''), path.join(ROOT, 'control'), 'control');

    // ---- stability: control re-load (fresh tab), in-memory compare ----
    if (!SKIP_REPEAT) {
      const repeat = await captureStable(variantOf(pose, 'control', ''), path.join(ROOT, 'control'), 'control-repeat');
      const identical = control.bytes.equals(repeat.bytes);
      payload.stability[pose.name] = {
        byteIdentical: identical,
        firstSha256: sha256(control.bytes),
        repeatSha256: sha256(repeat.bytes),
      };
      if (!identical) {
        fs.writeFileSync(path.join(ROOT, `repeat-MISMATCH-${pose.name}.png`), repeat.bytes);
        payload.errors.push(`stability gate FAILED: ${pose.name} control repeat not byte-identical (repeat PNG kept for forensics)`);
      }
      console.log(`[stability] ${pose.name}: ${identical ? 'BYTE-IDENTICAL' : 'MISMATCH'}`);
    }

    // ---- toon0 (gate 1 variant twin) ----
    const toon0 = await captureStable(variantOf(pose, 'toon0', 'toon=0'), path.join(ROOT, 'toon0'), 'toon0');
    const g1 = control.bytes.equals(toon0.bytes);
    payload.gate1[pose.name] = {
      controlSha256: sha256(control.bytes),
      toon0Sha256: sha256(toon0.bytes),
      byteIdentical: g1,
    };
    console.log(`[gate1] ${pose.name}: toon0 vs control ${g1 ? 'BYTE-IDENTICAL' : 'MISMATCH'}`);
    if (!g1) payload.errors.push(`gate 1 FAILED: ${pose.name} toon0 not byte-identical to same-run control`);

    // ---- toon1 ----
    await captureStable(variantOf(pose, 'toon1', 'toon=1'), path.join(ROOT, 'toon1'), 'toon1');

    // ---- nodome (cloud occupancy mask source) ----
    if (!SKIP_NODOME) {
      await captureStable(variantOf(pose, 'nodome', 'dome=0'), path.join(ROOT, 'nodome'), 'nodome');
    }

    // ---- toon05 transition frame (ref-level only) ----
    if (pose.name === 'baseline-ref-level') {
      await captureStable(variantOf(pose, 'toon05', 'toon=0.5'), path.join(ROOT, 'toon05'), 'toon05');
    }

    // ---- seam isolation pair (horizon-low only, HUD hidden) ----
    if (pose.seam && !SKIP_SEAM) {
      const seamCtl = await captureStable(variantOf(pose, 'seam-control', '', true), path.join(ROOT, 'seam-control'), 'seam-control');
      const seamToon1 = await captureStable(variantOf(pose, 'seam-toon1', 'toon=1', true), path.join(ROOT, 'seam-toon1'), 'seam-toon1');
      payload.seamPair = {
        pose: pose.name,
        hudHidden: true,
        controlSha256: sha256(seamCtl.bytes),
        toon1Sha256: sha256(seamToon1.bytes),
        note: 'pair differs at toon=1 AND by design carries no HUD pixels (isolation caliber)',
      };
    }
  }
} catch (err) {
  payload.errors.push(String(err).slice(0, 500));
}

fs.writeFileSync(path.join(ROOT, 'capture-matrix.json'), JSON.stringify(payload, null, 2));
if (payload.errors.length > 0) {
  console.log('CAPTURE ERRORS:', payload.errors.join(' | '));
  process.exitCode = 1;
} else {
  console.log('capture-toon-matrix done: matrix/ populated; gate1 + stability recorded in capture-matrix.json');
}
