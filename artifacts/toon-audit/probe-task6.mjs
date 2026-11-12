/**
 * Toon-look-toggle Phase 1 Task 6 Gate 6 — repro dual-channel byte-level replay
 * (ab-evidence-task6/repro-gate6.json).
 *
 * GATE: a toonAmount!=0 session's exportColorState must replay BYTE-IDENTICALLY
 * through BOTH repro channels (spec gate 6: "exportColorState 含 toon 状态，
 * URL/console 双通道照旧可重放"):
 *
 *   1. ORIGINAL  tab ?toon=0.35&qa=frozen&pos=0,60,-300  (horizon-low seam
 *                 machine, 0 cruise frames) -> boot -> boot-fade -> PRESENT ->
 *                 capture frame F. exportColorState() -> repro URL line +
 *                 console line.
 *   2. URL       fresh tab on `${urlLine}&qa=frozen&pos=0,60,-300`. The repro
 *                URL line carries the COLOR state (sun/trackpatch/hazelock/toon)
 *                — its scope per formatColorRepro; qa=frozen + pos are the
 *                capture-protocol parameters appended identically to hold the
 *                camera/sim state fixed so the byte compare isolates color
 *                state. -> boot -> fade -> PRESENT -> capture -> byte-compare
 *                vs F. State-level check: exportColorState().toon === 0.35.
 *   3. CONSOLE   fresh tab on ?qa=frozen&pos=0,60,-300 (DEFAULT color state) ->
 *                 boot -> fade -> eval the repro console line verbatim
 *                 (qa.setSun(...); qa.setTrackPatch(null); qa.lockHaze(false);
 *                 qa.setToon(0.3500);) -> PRESENT (frame push fans the palette
 *                 via the toonVersion gate) -> capture -> byte-compare vs F.
 *
 * Method notes:
 *   - Byte compare in Node (Buffer.equals) — the primary gate. On MISMATCH the
 *     original tab's in-page diff API localizes the divergence (forensics).
 *   - PNGs go to task6-scratch/ (untracked scratch, task4-* precedent); the
 *     evidence JSON records sha256 + bytes + verdicts.
 *   - Same-session pairing: all three tabs in this one run (Task 1 ruling).
 *
 * Env: CDP, BASE, OUT (default ab-evidence-task6), SCRATCH (default task6-scratch).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CDP = process.env.CDP ?? 'http://127.0.0.1:9222';
const BASE = process.env.BASE ?? 'http://[::1]:5173/';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const OUT = path.join(HERE, process.env.OUT ?? 'ab-evidence-task6');
const SCRATCH = path.join(HERE, process.env.SCRATCH ?? 'task6-scratch');
const POSE_QS = 'sun=12,-8&qa=frozen&pos=0,60,-300';
const TOON = '0.35';

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SCRATCH, { recursive: true });
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

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
    // CDP WS connect can wedge forever under tab churn (first gate-6 run hung
    // ~14 min here) — bound it like every other CDP call
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws connect timeout (10s)')), 10000);
      this.ws.onopen = () => { clearTimeout(timer); resolve(); };
      this.ws.onerror = (e) => { clearTimeout(timer); reject(new Error('ws connect error')); };
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
    // An occluded/minimized Chrome window throttles rAF to a stop — the PRESENT
    // round (stepFrame + 2x rAF) then hangs forever (the first gate-6 run wedged
    // ~14 min here, misread as a WS wedge). Bring the tab/window to front so
    // document.visibilityState is 'visible' before any rAF-dependent step.
    await this.send('Page.bringToFront');
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

  /** Wait for qa hook + a URL substring (replay URLs carry their own params). */
  async waitBoot(includes, timeoutMs = 90000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const ok = await this.eval(`
        return Boolean(window.__porco && window.__porco.qa && window.__porco.qa.frozen === true)
          && location.href.includes('${includes}');
      `).catch(() => false);
      if (ok) return true;
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

  async shotBytes() {
    for (let i = 1; i <= 3; i++) {
      try {
        const res = await this.send('Page.captureScreenshot', {
          format: 'png', fromSurface: true, captureBeyondViewport: false,
        });
        const buf = Buffer.from(res.data, 'base64');
        if (buf.length < 150 * 1024) throw new Error(`suspicious PNG ${buf.length} bytes`);
        return buf;
      } catch (err) {
        console.log(`[shot attempt ${i} failed] ${String(err).slice(0, 160)}`);
        await sleep(2000);
      }
    }
    throw new Error('screenshot failed after 3 tries');
  }

  async present() {
    // Standard PRESENT round (capture protocol: 2x stepFrame(0) + 2 rAF).
    // ENVIRONMENT CONTRACT: the capture Chrome must be launched with
    // --disable-features=CalculateNativeWinOcclusion — a window born into
    // Chrome's native occlusion tracker on this desktop gets stuck
    // visibilityState 'hidden' FOREVER (even foreground+topmost), rAF never
    // fires and this await hangs; with the tracker disabled the window reads
    // 'visible' and rAF fires instantly. Guarded below so a bad environment
    // fails LOUD instead of hanging 120s.
    const vis = await this.eval(`
      for (let i = 0; i < 2; i++) {
        window.__porco.qa.stepFrame(0);
        await new Promise(r => requestAnimationFrame(r));
        await new Promise(r => requestAnimationFrame(r));
      }
      return document.visibilityState;
    `);
    if (vis !== 'visible') throw new Error(`page not visible after PRESENT (${vis}) — relaunch capture Chrome with --disable-features=CalculateNativeWinOcclusion`);
  }

  async close() {
    await fetch(`${CDP}/json/close/${this.target.id}`).catch(() => {});
    this.ws.close();
  }
}

const DIFF_API = `
  const loadImage = (b64) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = 'data:image/png;base64,' + b64;
  });
  const loadCropped = async (b64) => {
    const img = await loadImage(b64);
    const c = document.createElement('canvas');
    c.width = 434; c.height = 772;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 475, 0, 434, 772, 0, 0, 434, 772);
    return ctx.getImageData(0, 0, 434, 772).data;
  };
  window.__pix = {};
  window.__api = {
    load: async (key, data) => { window.__pix[key] = await loadCropped(data); return true; },
    diff: (a, b) => {
      const x = window.__pix[a], y = window.__pix[b];
      let diffPixels = 0, maxDelta = 0, sum = 0;
      const samples = [];
      for (let p = 0, i = 0; p < 434 * 772; p++, i += 4) {
        let changed = false;
        for (let ch = 0; ch < 3; ch++) {
          const d = Math.abs(x[i + ch] - y[i + ch]);
          if (d > 0) { changed = true; sum += d; if (d > maxDelta) maxDelta = d; }
        }
        if (changed) {
          diffPixels++;
          if (samples.length < 8) samples.push({ x: p % 434, y: Math.floor(p / 434), a: [x[i], x[i+1], x[i+2]], b: [y[i], y[i+1], y[i+2]] });
        }
      }
      return { diffPixels, maxDelta, meanDelta: diffPixels ? sum / diffPixels : 0, samples };
    },
  };
  return 'api-ready';
`;

async function bootAndShoot(url, includes, label, { skipShot = false } = {}) {
  const target = await newTab(url);
  const session = new Session(target);
  await session.open();
  try {
    const ok = await session.waitBoot(includes);
    if (!ok) throw new Error(`${label}: boot timeout (or URL drifted)`);
    const fade = await session.waitBootStatusFade();
    let bytes = null;
    if (!skipShot) {
      await session.present();
      bytes = await session.shotBytes();
    }
    const state = JSON.parse(await session.eval(`return JSON.stringify(window.__porco.qa.exportColorState());`));
    console.log(`[${label}]${bytes ? ` shot ${bytes.length} bytes sha=${sha256(bytes).slice(0, 12)}` : ' (boot only)'} fade=${fade} toon=${state.toon}`);
    return { session, bytes, state };
  } catch (err) {
    await session.close().catch(() => {});
    throw err;
  }
}

const result = {
  protocol: {
    gate: 'exportColorState repro dual-channel byte-level replay (spec gate 6)',
    sourceUrl: `${BASE}?toon=${TOON}&${POSE_QS}`,
    poseChoice: 'night literal sun (?sun=12,-8): the repro format pins linear floats at toFixed(4) (debug-color-panel plan format) — the DEFAULT sun elevation is DERIVED (asin of a normalized vector, irrational) so a default-sun session is lossy at f4: replaying sun=12.0948,6.9684 flips ~2k sparkle/glitter pixels (bisect evidence task6-scratch/bisect.json: plain 832b78ef vs sun-rounded 6754d570, ~570-byte delta). The literal-sun session is exact at f4 and validates the toon repro chain itself.',
    poseQsAppendedToReplayUrl: 'qa=frozen&pos=0,60,-300 (capture-protocol parameters; repro URL scope = color state per formatColorRepro)',
    canvasRect: [475, 0, 434, 772],
    pairing: 'all three tabs in THIS run (same-session, Task 1 ruling)',
    chromeLaunch: 'porco Chrome needs --disable-features=CalculateNativeWinOcclusion on this desktop (born-occluded windows get stuck visibilityState hidden, rAF never fires — see Session.present note)',
  },
  original: {},
  urlChannel: {},
  consoleChannel: {},
  verdict: {},
  errors: [],
};

let original = null;
try {
  // ---- 1. original ----
  const orig = await bootAndShoot(`${BASE}?toon=${TOON}&${POSE_QS}`, `toon=${TOON}`, 'original');
  original = orig;
  const exported = orig.state;
  result.original = {
    url: `${BASE}?toon=${TOON}&${POSE_QS}`,
    pngBytes: orig.bytes.length,
    sha256: sha256(orig.bytes),
    toon: exported.toon,
    repro: exported.repro,
  };
  const [urlLine, consoleLine] = exported.repro.split('\n');
  // f4() formats 4 decimals — 'toon=0.3500' / 'qa.setToon(0.3500)'; check the
  // 4-decimal form (a naive 'qa.setToon(0.35)' substring check can never match
  // because '0.35' is followed by '00)' not ')')
  const t4 = Number(TOON).toFixed(4);
  if (!urlLine.includes(`toon=${t4}`) || !consoleLine.includes(`qa.setToon(${t4})`)) {
    throw new Error(`repro lines missing toon segment: url=${urlLine} console=${consoleLine}`);
  }
  fs.writeFileSync(path.join(SCRATCH, 'repro-original.png'), orig.bytes);
  console.log(`[repro url] ${urlLine}`);
  console.log(`[repro console] ${consoleLine}`);

  // ---- 2. URL channel ----
  const replayUrl = `${BASE}${urlLine}&${POSE_QS}`;
  const urlReplay = await bootAndShoot(replayUrl, `toon=${TOON}`, 'url-replay');
  result.urlChannel = {
    url: replayUrl,
    pngBytes: urlReplay.bytes.length,
    sha256: sha256(urlReplay.bytes),
    toon: urlReplay.state.toon,
    byteIdentical: orig.bytes.equals(urlReplay.bytes),
  };
  fs.writeFileSync(path.join(SCRATCH, 'replay-url.png'), urlReplay.bytes);
  await urlReplay.session.close().catch(() => {});
  console.log(`[gate6 URL channel] ${result.urlChannel.byteIdentical ? 'BYTE-IDENTICAL' : 'MISMATCH'}`);

  // ---- 3. console channel ----
  // Boot the DEFAULT-state page (no toon in URL), execute the repro console
  // line verbatim, PRESENT (the stepFrame drives syncSun: the setSun/setToon
  // version bumps re-fan the palette AND the unlocked haze recompute
  // overwrites the console line's f4-rounded endpoints with the exact
  // track-derived values), then capture.
  // The bare `qa.` binding: pasting `qa.setSun(...)` in a real DevTools console
  // throws ReferenceError — `qa` lives at window.__porco.qa only. Binding
  // convention per debug-color-panel task-2-report: `const qa = __porco.qa`
  // first ("验证按此绑定").
  const consoleTab = await bootAndShoot(`${BASE}?${POSE_QS}`, 'sun=12,-8', 'console-replay', { skipShot: true });
  const applyResult = await consoleTab.session.eval(`
    const qa = window.__porco.qa;
    ${consoleLine}
    await new Promise(r => setTimeout(r, 100));
    return window.__porco.qa.exportColorState().toon;
  `);
  await consoleTab.session.present();
  const consoleBytes = await consoleTab.session.shotBytes();
  const consoleState = JSON.parse(await consoleTab.session.eval(`return JSON.stringify(window.__porco.qa.exportColorState());`));
  result.consoleChannel = {
    url: `${BASE}?${POSE_QS}`,
    consoleCommand: consoleLine,
    appliedToon: applyResult,
    toon: consoleState.toon,
    pngBytes: consoleBytes.length,
    sha256: sha256(consoleBytes),
    byteIdentical: orig.bytes.equals(consoleBytes),
  };
  fs.writeFileSync(path.join(SCRATCH, 'replay-console.png'), consoleBytes);
  await consoleTab.session.close().catch(() => {});
  console.log(`[gate6 console channel] applied toon=${applyResult} ${result.consoleChannel.byteIdentical ? 'BYTE-IDENTICAL' : 'MISMATCH'}`);

  // ---- forensics on mismatch ----
  if (!result.urlChannel.byteIdentical || !result.consoleChannel.byteIdentical) {
    const api = await original.session.eval(DIFF_API);
    if (api === 'api-ready') {
      if (!result.urlChannel.byteIdentical) {
        await original.session.eval(`return window.__api.load('a', '${fs.readFileSync(path.join(SCRATCH, 'repro-original.png')).toString('base64')}');`);
        await original.session.eval(`return window.__api.load('b', '${fs.readFileSync(path.join(SCRATCH, 'replay-url.png')).toString('base64')}');`);
        result.urlChannel.pixelDiff = await original.session.eval(`return window.__api.diff('a', 'b');`);
        console.log(`[forensics URL] ${JSON.stringify(result.urlChannel.pixelDiff).slice(0, 400)}`);
      }
      if (!result.consoleChannel.byteIdentical) {
        await original.session.eval(`return window.__api.load('c', '${fs.readFileSync(path.join(SCRATCH, 'replay-console.png')).toString('base64')}');`);
        result.consoleChannel.pixelDiff = await original.session.eval(`return window.__api.diff('a', 'c');`);
        console.log(`[forensics console] ${JSON.stringify(result.consoleChannel.pixelDiff).slice(0, 400)}`);
      }
    }
  }

  result.verdict = {
    urlChannel: result.urlChannel.byteIdentical ? 'PASS' : 'FAIL',
    consoleChannel: result.consoleChannel.byteIdentical ? 'PASS' : 'FAIL',
  };
} catch (err) {
  result.errors.push(String(err).slice(0, 500));
} finally {
  if (original) await original.session.close().catch(() => {});
}

fs.writeFileSync(path.join(OUT, 'repro-gate6.json'), JSON.stringify(result, null, 2));
if (result.errors.length > 0 || Object.values(result.verdict).includes('FAIL')) {
  console.log('GATE6 ERRORS:', [...result.errors].join(' | '), JSON.stringify(result.verdict));
  process.exitCode = 1;
} else {
  console.log('gate6 done: dual-channel byte-level replay PASS -> repro-gate6.json');
}
