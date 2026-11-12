/**
 * FLT-01 browser gate — prop fallback on the REAL GLB (no prop_spin node).
 *
 * Protocol (task-1-brief.md Step 6):
 *   URL    http://[::1]:5173/?qa=frozen&pos=0,120,-300
 *          IPv6 literal — vite binds IPv6-only; Chrome races IPv4/6 on localhost.
 *   pose   spawn pose: the flight model starts at CRUISE_SPEED, so the synthesized
 *          pivot spins near full rate and the blur blades sit at propOpacity01(1).
 *   viewport 1384x772, deviceScaleFactor 1 → canvas strip ~434x772 centred
 *          (#frame is a 9/16 letterbox; the 3D scene lives only inside it).
 *   wait   boot ready (__porco.qa + __porco.scene) AND location.href still carries
 *          qa=frozen AND pos (stale __porco false-ready guard)
 *   wait   #boot-status computed opacity reaches '0'
 *   step   qa.step(0) + PRESENT -> shot prop-t0.png
 *          qa.step(STEPS, 1/60) chunked + PRESENT -> shot prop-t600.png
 *   diff   both PNGs decoded IN THE PAGE (Image -> canvas -> ImageData), per-pixel
 *          d = (|dr|+|dg|+|db|)/3, meaned over:
 *            roi         — prop disc box (pinned constant, centred on the nose)
 *            canvas      — canvas strip only, HUD DOM rows excluded  (strict denominator)
 *            full        — whole viewport, HUD DOM rows excluded     (brief's literal
 *                          denominator; the zero-diff letterbox dilutes it ~3.2x)
 *          HUD rows come from bounding rects of .porco-hud instrument/text children
 *          and #boot-status. `.porco-whiteout` / `.porco-g` are full-canvas fog
 *          layers — NEVER excluded by rect (their rect is the whole scene).
 *   gate   PASS iff roiMean >= 3 x canvasMean (strict denominator), recorded with
 *          both ratios in the sidecar.
 *
 * ROI pinning (brief: 首抓后钉坐标写进脚本常量): leave PROP_ROI null for the first
 * run — it derives a box from the projected pivot centre, prints the rect and sets
 * roiPinned:false in the sidecar without judging the gate. Pin the printed rect
 * into PROP_ROI and re-run for the official measurement.
 *
 * Frames (NEW names — never overwrite earlier frames): prop-t0.png / prop-t600.png.
 * Env: BASE, OUT_DIR, VIEW_W, VIEW_H, STEPS.
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
const POSE = 'pos=0,120,-300';
const STEPS = Number(process.env.STEPS ?? 600); // 10 s at 1/60
const STEP_CHUNK = 50; // qa.step() is one CDP eval; chunk so software-raster frames cannot blow the eval timeout
const GATE_FACTOR = 3;

/**
 * Pinned prop ROI in screenshot px {x, y, w, h} — pinned after the first capture
 * (artifacts/plane-audit/prop-t0-auto.png): projected pivot centre lands at
 * (692, 398) and drifts to (692, 377) by t600 (gentle climb, chase-cam lag), so
 * the box centres on (692, 390); the blade sweep (~46 px across) stays inside at
 * both ends. Derived boxes: first run used the auto 195x195 box at the same centre.
 */
const PROP_ROI = { x: 642, y: 340, w: 100, h: 100 };

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
  async waitBoot(timeoutMs = 90000) {
    const want = `${BASE}?qa=frozen&${POSE}`;
    const t0 = Date.now();
    let probeLogged = false;
    while (Date.now() - t0 < timeoutMs) {
      const ready = await this.eval(`
        return Boolean(window.__porco && window.__porco.qa && window.__porco.scene)
          && location.href.includes('qa=frozen')
          && location.href.includes('${POSE}');
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

/** Prop + canvas + HUD state, all in screenshot px (deviceScaleFactor is 1). */
const PROBE = `
  const q = window.__porco;
  const d = q.qa.describe();
  const pivot = q.scene.getObjectByName('prop_spin');
  const canvas = document.querySelector('#game');
  const rect = canvas.getBoundingClientRect();
  let pivotInfo = null;
  let pivotPx = null;
  if (pivot) {
    pivotInfo = {
      childNames: pivot.children.map((c) => c.name),
      position: [pivot.position.x, pivot.position.y, pivot.position.z],
      rotationZ: pivot.rotation.z,
    };
    const v = q.camera.position.clone();
    pivot.getWorldPosition(v);
    v.project(q.camera);
    pivotPx = {
      x: rect.left + (v.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (1 - (v.y * 0.5 + 0.5)) * rect.height,
    };
  }
  const hudRects = [...document.querySelectorAll('.porco-hud > *:not(.porco-whiteout):not(.porco-g), #boot-status')]
    .map((el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return { sel: el.className || el.id, x: r.left, y: r.top, w: r.width, h: r.height, opacity: s.opacity, visibility: s.visibility };
    })
    .filter((r) => r.w > 0 && r.h > 0 && r.opacity !== '0' && r.visibility !== 'hidden');
  return {
    canvas: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    pivotFound: Boolean(pivot),
    pivotInfo,
    pivotPx,
    hudRects,
    plane: d.plane, camera: d.camera?.pos, elapsed: d.elapsed,
    gpu: Boolean(navigator.gpu),
    backend: q.renderer?.backend?.isWebGPUBackend === true ? 'webgpu' : 'other',
    frameStats: q.qa.frameStats(),
  };
`;

const DESCRIBE = `
  const q = window.__porco;
  const d = q.qa.describe();
  return {
    ...d,
    gpu: Boolean(navigator.gpu),
    backend: q.renderer?.backend?.isWebGPUBackend === true ? 'webgpu' : 'other',
  };
`;

/**
 * Decode two PNGs in the page and diff them. Screenshot px == CSS px (dpr 1).
 * Row-excluded means: a row is skipped when it intersects any HUD rect. The three
 * denominators share one pass; ROI ∩ HUD rows is skipped too.
 */
function diffEval(b64a, b64b, roi, hudRects) {
  const hud = JSON.stringify(hudRects);
  const box = JSON.stringify(roi);
  return `
    const load = (b64) => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image decode failed'));
      img.src = 'data:image/png;base64,' + b64;
    });
    const [imgA, imgB] = await Promise.all([load('${b64a}'), load('${b64b}')]);
    const w = imgA.naturalWidth, h = imgA.naturalHeight;
    const grab = (img) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, w, h).data;
    };
    const a = grab(imgA), b = grab(imgB);
    const hud = ${hud};
    const rowBlocked = new Array(h).fill(false);
    for (const r of hud) {
      const y0 = Math.max(0, Math.floor(r.y)), y1 = Math.min(h - 1, Math.ceil(r.y + r.h));
      for (let y = y0; y <= y1; y++) rowBlocked[y] = true;
    }
    const roi = ${box};
    const acc = { roi: { s: 0, n: 0 }, canvas: { s: 0, n: 0 }, full: { s: 0, n: 0 } };
    for (let y = 0; y < h; y++) {
      const blocked = rowBlocked[y];
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const d = (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
        acc.full.s += d; acc.full.n += 1;
        if (blocked) continue;
        acc.canvas.s += d; acc.canvas.n += 1;
        if (x >= roi.x && x < roi.x + roi.w && y >= roi.y && y < roi.y + roi.h) {
          acc.roi.s += d; acc.roi.n += 1;
        }
      }
    }
    return {
      size: [w, h],
      mean: {
        roi: acc.roi.s / acc.roi.n,
        canvas: acc.canvas.s / acc.canvas.n,
        full: acc.full.s / acc.full.n,
      },
      pixels: { roi: acc.roi.n, canvas: acc.canvas.n, full: acc.full.n },
    };
  `;
}

function deriveRoi(pivotPx, canvasRect) {
  // Generous first-catch box around the projected pivot centre; refined and pinned
  // into PROP_ROI after eyeballing the t0 frame.
  const w = Math.round(canvasRect.width * 0.45);
  const h = w;
  return {
    x: Math.round(pivotPx.x - w / 2),
    y: Math.round(pivotPx.y - h / 2),
    w,
    h,
  };
}

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
    const probe0 = await s.eval(PROBE);
    if (!probe0.pivotFound) {
      throw new Error('no prop_spin pivot in the live scene — ensurePropPivot did not fire (check console for [porco] GLB missing)');
    }
    console.log('[probe t0]', JSON.stringify({
      pivot: probe0.pivotInfo, pivotPx: probe0.pivotPx, canvas: probe0.canvas,
      backend: probe0.backend, gpu: probe0.gpu, frameStats: probe0.frameStats,
      hudRects: probe0.hudRects,
    }));

    const roi = PROP_ROI ?? deriveRoi(probe0.pivotPx, probe0.canvas);
    const shot0 = await s.shot('prop-t0');

    const chunks = [];
    for (let i = 0; i < STEPS; i += STEP_CHUNK) {
      const n = Math.min(STEP_CHUNK, STEPS - i);
      const t0 = Date.now();
      const elapsed = await s.eval(`return window.__porco.qa.step(${n}, 1/60);`);
      chunks.push({ n, ms: Date.now() - t0, elapsed });
    }
    console.log('[step chunks]', JSON.stringify(chunks));
    await s.eval(PRESENT);
    const shot1 = await s.shot('prop-t600');
    const probe1 = await s.eval(PROBE);
    const desc1 = await s.eval(DESCRIBE);

    const b64a = fs.readFileSync(shot0.file).toString('base64');
    const b64b = fs.readFileSync(shot1.file).toString('base64');
    const diff = await s.eval(diffEval(b64a, b64b, roi, probe0.hudRects));

    const glbMissingWarnSeen = s.logs.some((l) => l.includes('GLB missing'));
    const roiMean = diff.mean.roi;
    const canvasMean = diff.mean.canvas;
    const fullMean = diff.mean.full;
    const verdict = PROP_ROI
      ? (glbMissingWarnSeen ? 'invalid' : (roiMean >= GATE_FACTOR * canvasMean ? 'PASS' : 'FAIL'))
      : 'unpinned-roi (first capture — pin PROP_ROI and re-run)';

    results.prop = {
      attempt, bootStatus, roi, roiPinned: Boolean(PROP_ROI), steps: STEPS, chunks,
      pivotAtT0: probe0.pivotInfo, pivotPxAtT0: probe0.pivotPx,
      pivotAtT600: probe1.pivotInfo, pivotPxAtT600: probe1.pivotPx,
      canvasRect: probe0.canvas, hudRects: probe0.hudRects,
      shotT0: shot0, shotT600: shot1, diff,
      ratios: { roiOverCanvas: roiMean / canvasMean, roiOverFull: roiMean / fullMean },
      gate: { factor: GATE_FACTOR, denominator: 'canvas (HUD rows excluded)', verdict, glbMissingWarnSeen },
      desc: desc1, consoleLogs: s.logs,
    };
    console.log(`[ok] prop t0/t600`, JSON.stringify({
      roi, roiMean, canvasMean, fullMean,
      roiOverCanvas: results.prop.ratios.roiOverCanvas,
      roiOverFull: results.prop.ratios.roiOverFull,
      verdict, glbMissingWarnSeen, pivotRotationZ: [probe0.pivotInfo.rotationZ, probe1.pivotInfo.rotationZ],
    }));
    done = true;
  } catch (err) {
    console.log(JSON.stringify({ name: 'prop', attempt, error: String(err).slice(0, 300) }));
    if (attempt === 3) errors.push(`prop: ${String(err).slice(0, 200)}`);
  } finally {
    if (s) await s.close().catch(() => {});
  }
}

const payload = {
  protocol: {
    url: `${BASE}?qa=frozen&${POSE}`,
    viewport: [VIEW_W, VIEW_H],
    deviceScaleFactor: 1,
    pose: 'spawn pose (CRUISE_SPEED); chase cam behind the tail; prop disc on the nose',
    present: 'qa.step(0) + 2x stepFrame(0) + 2x rAF',
    flightPair: `qa.step(${STEPS}, 1/60) chunked x${STEP_CHUNK} between t0 and t600`,
    gate: `prop ROI mean|diff| >= ${GATE_FACTOR} x canvas mean|diff| (HUD DOM rows excluded; strict denominator)`,
    minBytes: MIN_BYTES,
  },
  results,
  errors,
};
fs.writeFileSync(path.join(OUT, 'capture-prop.json'), JSON.stringify(payload, null, 2));
if (errors.length > 0) {
  console.log('CAPTURE ERRORS:', errors.join(' | '));
  process.exitCode = 1;
} else {
  console.log('capture-prop done:', Object.keys(results).join(', '));
}
