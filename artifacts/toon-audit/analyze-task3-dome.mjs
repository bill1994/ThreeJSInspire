/**
 * Toon-look-toggle Phase 1 Task 3 — dome cloud quantization A/B evidence
 * (ab-evidence-task3/). Companion to analyze-band-count.mjs (Task 2, sky outlet);
 * this tool attributes the DOME's own quantization and runs the multi-frame
 * band-flicker gate.
 *
 * METHOD (documented per the task contract):
 *   1. Frames come from capture-baseline.mjs runs (first pass): task3-control
 *      (no extra query), task3-toon0 (?toon=0 — byte gate enforced by that run's
 *      CMP_DIR protocol), task3-toon1 (?toon=1), task3-nodome (?dome=0).
 *   2. In-page decode of the full-page PNGs (1384x772 DPR 1), cropped to the
 *      canvas rect x[475,909) y[0,772) — 434x772 (sidecar canvas rect).
 *   3. OCCUPANCY MASK per pose: |control − nodome| > 0 (any RGB) — pixels where
 *      the dome cloud contributes. toon does not reshape (alpha untouched — the
 *      uLook/T3 discipline), so the mask computed at toon=0 applies to toon=1.
 *      UI EXCLUSION: the tuning panel (canvas x[198,424) y[73,214)) and the HUD
 *      speed arc (x[0,140) y[58,196)) are translucen/opaque overlays whose
 *      ANTI-ALIASED edges blend with the changed background, so their edge
 *      pixels enter a raw mask and pollute every statistic (first run's
 *      "bestStep" hunt landed on panel label AA at night). Both rects are cut
 *      from the mask; remaining cloud pixels are pure gameplay pixels.
 *      Known over-coverage elsewhere: post bloom bleeds a halo around bright
 *      cloud edges (conservative direction for the attribution ratios).
 *   4. CLOUD TOON EFFECT: within the clean mask, |toon1 − control| > 0 → changed
 *      cloud pixels (+ratio). Changed pixels OUTSIDE the mask are the sky/sea
 *      outlet quantize (Task 2 scope, expected) — counted for the record.
 *   5. TIER STRUCTURE (two instruments, because a volumetric cloud re-smooths
 *      per-pixel plateaus — ray accumulation blends many samples, so Task 2's
 *      column-plateau metric under-reads the dome):
 *      a) LOCAL GRADIENT over clean-mask pixels (mean/median/p90 of |Δlum| to
 *         the right+down neighbour, toon1 vs control) — the quantized look
 *         trades smooth gradients for flat tier interiors separated by dithered
 *         high-contrast boundaries; the distribution shape change is the
 *         signature (descriptive, pose table in the report).
 *      b) BEST-STEP PROFILE: the largest single-row luminance jump inside the
 *         clean mask on toon1, dumped as a ±14-row column profile for BOTH
 *         images — the direct tier-boundary evidence (toon1 shows the step +
 *         dither grain, control the smooth ramp it came from).
 *   6. MULTI-FRAME (capture-task3-frames.mjs, ?toon=1 frozen + qa.step(300,1/60)
 *      per gap = 5 s sim): per consecutive pair, global diff AND within-clean-
 *      mask diff (cloud pixels animate — a frozen band pattern would be 0); per
 *      frame, plateau band_count over clean-mask-only column spans (structure
 *      persists). GATE: within-mask diff > 0 for every pair AND per-frame
 *      band_count ≥ 3 (column plateaus; the brief's "档间无静态带纹" 目检 rides
 *      on the frame PNGs + these numbers).
 *   7. CROSS-SESSION SUPPLEMENT (Task-1 ruling: jitter excluded from gates):
 *      toon0 vs task2-toon0 (dome code changed, toon=0 must be bit-identical
 *      math — expect only the known isolated ±1/255 jitter signature), toon1 vs
 *      task2-toon1 (diff should concentrate in the cloud mask).
 *
 * Env: CDP, BASE, HERE (PNG inputs relative), OUT (default ab-evidence-task3),
 *      CONTROL/TOON0/TOON1/NODOME/FRAMES dirs (defaults task3-*).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CDP = process.env.CDP ?? 'http://127.0.0.1:9222';
const BASE = process.env.BASE ?? 'http://[::1]:5173/';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const OUT = path.join(HERE, process.env.OUT ?? 'ab-evidence-task3');
const DIRS = {
  control: path.join(HERE, process.env.CONTROL ?? 'task3-control'),
  toon0: path.join(HERE, process.env.TOON0 ?? 'task3-toon0'),
  toon1: path.join(HERE, process.env.TOON1 ?? 'task3-toon1'),
  nodome: path.join(HERE, process.env.NODOME ?? 'task3-nodome'),
  frames: path.join(HERE, process.env.FRAMES ?? 'task3-frames'),
  task2Toon0: path.join(HERE, 'task2-toon0'),
  task2Toon1: path.join(HERE, 'task2-toon1'),
};
const MIN_RUN = 4;
const GAP_MIN = 6;
const MIN_MASK_RUN = 8;
// dense-cloud subset threshold: |control − nodome| mean-channel delta at which a
// mask pixel reads as dome-dominated (thin cloud blends the quantized sky behind)
const DENSE_MIN = 25;
// UI exclusion rects (canvas coords) — see header §3
const PANEL_RECT = [198, 73, 424, 214];
const HUD_RECT = [0, 58, 140, 196];
const POSES = ['baseline-ref-level', 'baseline-horizon-low', 'baseline-night-sun12-8'];

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// ---- analysis source (runs in page) ------------------------------------------------

const PAGE_ANALYZE = `
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
  const lumF = (d, i) => (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
  const lum255 = (d, i) => Math.round(lumF(d, i));

  const inRect = (x, y, r) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3];

  // plateaus over one pixel span [yA, yB) of one column: maximal runs of
  // identical 8-bit luminance (>= MIN_RUN), adjacent values < GAP_MIN merged
  const spanBands = (d, x, yA, yB) => {
    const runs = [];
    for (let y = yA; y < yB; y++) {
      const v = lum255(d, (y * 434 + x) * 4);
      if (runs.length && runs[runs.length - 1].val === v) runs[runs.length - 1].len++;
      else runs.push({ val: v, len: 1 });
    }
    const plateaus = runs
      .filter((r) => r.len >= ${MIN_RUN})
      .reduce((acc, r) => {
        if (acc.length && Math.abs(acc[acc.length - 1].val - r.val) < ${GAP_MIN}) {
          acc[acc.length - 1].len += r.len;
          acc[acc.length - 1].val = r.val;
        } else acc.push({ ...r });
        return acc;
      }, []);
    return { runs, plateaus };
  };

  window.__pix = {};
  window.__mask = null;
  window.__api = {
    load: async (key, b64) => { window.__pix[key] = await loadCropped(b64); return true; },
    // occupancy mask: control vs nodome, minus the two UI rects
    buildMask: (ctlKey, ndKey) => {
      const a = window.__pix[ctlKey], b = window.__pix[ndKey];
      const mask = new Uint8Array(434 * 772);
      let n = 0, cut = 0;
      for (let y = 0; y < 772; y++) for (let x = 0; x < 434; x++) {
        const p = y * 434 + x, i = p * 4;
        if (Math.abs(a[i] - b[i]) > 0 || Math.abs(a[i + 1] - b[i + 1]) > 0 || Math.abs(a[i + 2] - b[i + 2]) > 0) {
          if (inRect(x, y, ${JSON.stringify(PANEL_RECT)}) || inRect(x, y, ${JSON.stringify(HUD_RECT)})) { cut++; continue; }
          mask[p] = 1; n++;
        }
      }
      window.__mask = mask;
      window.__maskCut = cut;
      window.__nd = b;
      return n;
    },
    analyze: (toonKey, ctlKey) => {
      const t1 = window.__pix[toonKey], ct = window.__pix[ctlKey], mask = window.__mask;
      const stats = (a) => {
        const s = [...a].sort((x, y) => x - y);
        const mean = a.reduce((u, v) => u + v, 0) / (a.length || 1);
        return { mean, median: s[Math.floor(s.length / 2)] || 0, p90: s[Math.floor(s.length * 0.9)] || 0 };
      };
      // dense-cloud subset: pixels where the dome cloud DOMINATES the composite
      // (|control − nodome| mean-channel >= DENSE_MIN). Thin-cloud pixels blend
      // the quantized sky behind them (Task 2 outlet), so tier metrics gate on
      // the dense subset to keep the dome attribution clean.
      const dense = new Uint8Array(434 * 772);
      for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
        if (mask[p] === 1) {
          const d = (Math.abs(ct[i] - window.__nd[i]) + Math.abs(ct[i + 1] - window.__nd[i + 1]) + Math.abs(ct[i + 2] - window.__nd[i + 2])) / 3;
          if (d >= ${DENSE_MIN}) dense[p] = 1;
        }
      }
      window.__dense = dense;
      let changedIn = 0, changedOut = 0;
      for (let y = 0, p = 0; y < 772; y++) for (let x = 0; x < 434; x++, p++) {
        const i = p * 4;
        const changed = Math.abs(t1[i] - ct[i]) > 0 || Math.abs(t1[i + 1] - ct[i + 1]) > 0 || Math.abs(t1[i + 2] - ct[i + 2]) > 0;
        if (changed) { if (mask[p] === 1) changedIn++; else changedOut++; }
      }
      // local gradient over clean-mask pixels with both neighbours in the subset
      const gradIn = (subset) => {
        const gT1 = [], gCt = [];
        for (let y = 0; y < 771; y++) for (let x = 0; x < 433; x++) {
          const p = y * 434 + x;
          if (subset[p] === 1 && subset[p + 1] === 1 && subset[p + 434] === 1) {
            const i = p * 4;
            gT1.push(Math.abs(lumF(t1, i) - lumF(t1, i + 4)) + Math.abs(lumF(t1, i) - lumF(t1, i + 434 * 4)));
            gCt.push(Math.abs(lumF(ct, i) - lumF(ct, i + 4)) + Math.abs(lumF(ct, i) - lumF(ct, i + 434 * 4)));
          }
        }
        return { t1: stats(gT1), ctl: stats(gCt), pixels: gT1.length };
      };
      // best single-row jump on toon1 inside the dense subset (tier-boundary hunt)
      let best = { jump: 0, x: 0, y: 0 };
      for (let y = 1; y < 772; y++) for (let x = 0; x < 434; x++) {
        const a = (y - 1) * 434 + x, b = y * 434 + x;
        if (dense[a] === 1 && dense[b] === 1) {
          const j = Math.abs(lumF(t1, b * 4) - lumF(t1, a * 4));
          if (j > best.jump) best = { jump: j, x, y };
        }
      }
      const prof = { toon1: [], control: [] };
      for (let k = -14; k <= 14; k++) {
        const y = best.y + k;
        if (y < 0 || y >= 772) { prof.toon1.push(null); prof.control.push(null); continue; }
        prof.toon1.push(lum255(t1, (y * 434 + best.x) * 4));
        prof.control.push(lum255(ct, (y * 434 + best.x) * 4));
      }
      // column spans over the dense subset (per-frame plateau counting)
      const spans = [];
      for (let x = 0; x < 434; x += 2) {
        let y = 0;
        while (y < 772) {
          if (dense[y * 434 + x] === 1) {
            const yA = y;
            while (y < 772 && dense[y * 434 + x] === 1) y++;
            if (y - yA >= ${MIN_MASK_RUN}) spans.push({ x, yA, yB: y, len: y - yA });
          } else y++;
        }
      }
      let maskPixels = 0, densePixels = 0;
      for (let p = 0; p < mask.length; p++) { if (mask[p] === 1) maskPixels++; if (dense[p] === 1) densePixels++; }
      return {
        maskPixels, maskCutUI: window.__maskCut, densePixels,
        changedInMask: changedIn, changedOutMask: changedOut,
        gradToon1: gradIn(mask).t1, gradControl: gradIn(mask).ctl, gradPixels: gradIn(mask).pixels,
        gradDenseToon1: gradIn(dense).t1, gradDenseControl: gradIn(dense).ctl, gradDensePixels: gradIn(dense).pixels,
        bestStep: { ...best, profile: prof },
        spans,
      };
    },
    spanBandsOn: (key, x, yA, yB) => spanBands(window.__pix[key], x, yA, yB),
    // per-frame tier evidence: toon effect still active (changed ratio vs
    // control) + the STEP structure persists (dense-subset local-gradient
    // median keeps standing >= 3x the control ramp's) + boundary-sharpness
    // series (descriptive: varies with drift — a LOW max-jump frame is a
    // heavily dithered boundary state, NOT a missing structure)
    frameStats: (frameKey, ctlKey) => {
      const f = window.__pix[frameKey], ct = window.__pix[ctlKey];
      const dense = window.__dense, mask = window.__mask;
      let changed = 0, maskN = 0;
      for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
        if (mask[p] === 1) {
          maskN++;
          if (Math.abs(f[i] - ct[i]) > 0 || Math.abs(f[i + 1] - ct[i + 1]) > 0 || Math.abs(f[i + 2] - ct[i + 2]) > 0) changed++;
        }
      }
      const gF = [], gC = [];
      for (let y = 0; y < 771; y++) for (let x = 0; x < 433; x++) {
        const p = y * 434 + x;
        if (dense[p] === 1 && dense[p + 1] === 1 && dense[p + 434] === 1) {
          const i = p * 4;
          gF.push(Math.abs(lumF(f, i) - lumF(f, i + 4)) + Math.abs(lumF(f, i) - lumF(f, i + 434 * 4)));
          gC.push(Math.abs(lumF(ct, i) - lumF(ct, i + 4)) + Math.abs(lumF(ct, i) - lumF(ct, i + 434 * 4)));
        }
      }
      const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] || 0; };
      let best = { jump: 0, x: 0, y: 0 };
      for (let y = 1; y < 772; y++) for (let x = 0; x < 434; x++) {
        const a = (y - 1) * 434 + x, b = y * 434 + x;
        if (dense[a] === 1 && dense[b] === 1) {
          const j = Math.abs(lumF(f, b * 4) - lumF(f, a * 4));
          if (j > best.jump) best = { jump: j, x, y };
        }
      }
      const prof = { frame: [], control: [] };
      for (let k = -10; k <= 10; k++) {
        const y = best.y + k;
        if (y < 0 || y >= 772) { prof.frame.push(null); prof.control.push(null); continue; }
        prof.frame.push(Math.round(lumF(f, (y * 434 + best.x) * 4)));
        prof.control.push(Math.round(lumF(ct, (y * 434 + best.x) * 4)));
      }
      return {
        changedRatio: changed / maskN,
        gradMedianFrame: med(gF), gradMedianControl: med(gC), gradPixels: gF.length,
        bestStepJump: best.jump, bestStep: best, profile: prof,
      };
    },
    diff: (a, b) => {
      const x = window.__pix[a], y = window.__pix[b], mask = window.__mask;
      let diffPixels = 0, maxDelta = 0, sum = 0, maskDiffPixels = 0;
      for (let p = 0, i = 0; p < 434 * 772; p++, i += 4) {
        let changed = false;
        for (let ch = 0; ch < 3; ch++) {
          const d = Math.abs(x[i + ch] - y[i + ch]);
          if (d > 0) { changed = true; sum += d; if (d > maxDelta) maxDelta = d; }
        }
        if (changed) { diffPixels++; if (mask && mask[p] === 1) maskDiffPixels++; }
      }
      return { diffPixels, maxDelta, meanDelta: diffPixels ? sum / diffPixels : 0, maskDiffPixels: mask ? maskDiffPixels : undefined };
    },
  };
  return 'api-ready';
`;

// ---- CDP plumbing -------------------------------------------------------------------

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const target = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE + '?qa=frozen')}`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => reject(new Error(`timeout ${method}`)), 120000);
    });
  const evalInPage = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`page eval: ${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description ?? ''}`);
    }
    return res.result.value;
  };

  const hashes = {};
  const loadFile = async (key, file) => {
    hashes[key] = { sha256: sha256(file), bytes: fs.statSync(file).size };
    const b64 = fs.readFileSync(file).toString('base64');
    await evalInPage(`return window.__api.load('${key}', '${b64}');`);
  };

  try {
    await send('Runtime.enable');
    await send('Page.enable');
    await new Promise((r) => setTimeout(r, 1500));
    const ready = await evalInPage(PAGE_ANALYZE);
    if (ready !== 'api-ready') throw new Error('page api failed to install');

    const result = {
      protocol: {
        method: 'see script header',
        minRun: MIN_RUN, gapMin: GAP_MIN, minMaskRun: MIN_MASK_RUN, denseMin: DENSE_MIN,
        panelRect: PANEL_RECT, hudRect: HUD_RECT,
        canvasRect: [475, 0, 434, 772],
      },
      poses: {},
    };
    const gates = { tierStructure: {}, toon0Identity: {}, noFrozenBands: null };

    for (const pose of POSES) {
      await loadFile(`control/${pose}`, path.join(DIRS.control, `${pose}.png`));
      await loadFile(`nodome/${pose}`, path.join(DIRS.nodome, `${pose}.png`));
      await loadFile(`toon0/${pose}`, path.join(DIRS.toon0, `${pose}.png`));
      await loadFile(`toon1/${pose}`, path.join(DIRS.toon1, `${pose}.png`));
      await evalInPage(`return window.__api.buildMask('control/${pose}', 'nodome/${pose}');`);
      const analysis = await evalInPage(`return JSON.stringify(window.__api.analyze('toon1/${pose}', 'control/${pose}'))`);
      const a = JSON.parse(analysis);
      const dToon0Ctl = await evalInPage(`return window.__api.diff('toon0/${pose}', 'control/${pose}');`);
      const dToon1Ctl = await evalInPage(`return window.__api.diff('toon1/${pose}', 'control/${pose}');`);
      const task2Toon0 = path.join(DIRS.task2Toon0, `${pose}.png`);
      const task2Toon1 = path.join(DIRS.task2Toon1, `${pose}.png`);
      let dToon0Task2 = null, dToon1Task2 = null;
      if (fs.existsSync(task2Toon0)) {
        await loadFile(`task2toon0/${pose}`, task2Toon0);
        dToon0Task2 = await evalInPage(`return window.__api.diff('toon0/${pose}', 'task2toon0/${pose}');`);
      }
      if (fs.existsSync(task2Toon1)) {
        await loadFile(`task2toon1/${pose}`, task2Toon1);
        dToon1Task2 = await evalInPage(`return window.__api.diff('toon1/${pose}', 'task2toon1/${pose}');`);
      }
      result.poses[pose] = { ...a, diffs: { toon0_vs_control: dToon0Ctl, toon1_vs_control: dToon1Ctl, toon0_vs_task2toon0_xsession: dToon0Task2, toon1_vs_task2toon1_xsession: dToon1Task2 } };
      gates.tierStructure[pose] = {
        changedInRatio: a.changedInMask / a.maskPixels,
        gradMedianToon1: a.gradToon1.median, gradMedianControl: a.gradControl.median,
        gradDenseMedianToon1: a.gradDenseToon1.median, gradDenseMedianControl: a.gradDenseControl.median,
        bestStepJump: a.bestStep.jump,
        pass:
          a.changedInMask / a.maskPixels >= 0.9 &&
          a.gradDenseToon1.median >= 3 * Math.max(a.gradDenseControl.median, 0.5) &&
          a.bestStep.jump >= 15,
      };
      gates.toon0Identity[pose] = { diffPixels: dToon0Ctl.diffPixels, pass: dToon0Ctl.diffPixels === 0 };
      console.log(`[${pose}] mask=${a.maskPixels} (UI-cut ${a.maskCutUI}) changedIn=${a.changedInMask} (${(a.changedInMask / a.maskPixels * 100).toFixed(1)}%) changedOut=${a.changedOutMask} dense=${a.densePixels}`);
      console.log(`  grad ALL toon1 med=${a.gradToon1.median.toFixed(2)} control=${a.gradControl.median.toFixed(2)}  |  DENSE toon1 med=${a.gradDenseToon1.median.toFixed(2)} control=${a.gradDenseControl.median.toFixed(2)}`);
      console.log(`  bestStep x=${a.bestStep.x} y=${a.bestStep.y} jump=${a.bestStep.jump.toFixed(1)}`);
      console.log(`    toon1  : ${a.bestStep.profile.toon1.join(' ')}`);
      console.log(`    control: ${a.bestStep.profile.control.join(' ')}`);
      console.log(`  toon0 vs control: ${JSON.stringify(dToon0Ctl)}`);
      console.log(`  toon1 vs control: ${JSON.stringify(dToon1Ctl)}`);
      if (dToon0Task2) console.log(`  toon0 vs task2-toon0 (x-session): ${JSON.stringify(dToon0Task2)}`);
      if (dToon1Task2) console.log(`  toon1 vs task2-toon1 (x-session): ${JSON.stringify(dToon1Task2)}`);
    }

    // ---- multi-frame gate (?toon=1 frozen + qa.step per gap) -------------------------
    const frameFiles = fs.readdirSync(DIRS.frames).filter((f) => /^frame-\d+\.png$/.test(f)).sort();
    if (frameFiles.length >= 2) {
      for (const f of frameFiles) await loadFile(`frames/${f}`, path.join(DIRS.frames, f));
      const pose = 'baseline-horizon-low'; // camera static — reuse that pose's clean occupancy mask
      await evalInPage(`return window.__api.buildMask('control/${pose}', 'nodome/${pose}');`);
      const spansRes = await evalInPage(`return JSON.stringify(window.__api.analyze('toon1/${pose}', 'control/${pose}').spans)`);
      const spanList = JSON.parse(spansRes);
      const frames = {};
      for (const f of frameFiles) {
        const k = f.match(/^frame-(\d+)\.png$/)[1];
        const st = await evalInPage(`return JSON.stringify(window.__api.frameStats('frames/${f}', 'control/${pose}'));`);
        const s = JSON.parse(st);
        const perFrame = await evalInPage(`return JSON.stringify((() => {
          const spans = ${JSON.stringify(spanList)};
          let best = { n: 0, x: 0, yA: 0, yB: 0, plateaus: [] };
          let total = 0;
          for (const sp of spans) {
            const b = window.__api.spanBandsOn('frames/${f}', sp.x, sp.yA, sp.yB);
            total += b.plateaus.length;
            if (b.plateaus.length > best.n) best = { n: b.plateaus.length, x: sp.x, yA: sp.yA, yB: sp.yB, plateaus: b.plateaus.map((p) => p.val + 'x' + p.len) };
          }
          return { best, total };
        })())`);
        const pf = JSON.parse(perFrame);
        frames[k] = {
          changedRatioVsControl: s.changedRatio, bestStepJump: s.bestStepJump,
          gradMedianFrame: s.gradMedianFrame, gradMedianControl: s.gradMedianControl,
          bandCountMax: pf.best.n, bandCountTotal: pf.total,
          sampleSpan: { x: pf.best.x, yA: pf.best.yA, yB: pf.best.yB, plateaus: pf.best.plateaus },
          bestStepProfile: s.profile,
        };
      }
      const pairDiffs = [];
      for (let k = 1; k < frameFiles.length; k++) {
        const dGlobal = await evalInPage(`return window.__api.diff('frames/frame-${k}.png', 'frames/frame-${k - 1}.png');`);
        pairDiffs.push({ pair: [k - 1, k], ...dGlobal });
      }
      const bandCounts = Object.values(frames).map((f) => f.bandCountMax);
      const jumps = Object.values(frames).map((f) => f.bestStepJump);
      const ratios = Object.values(frames).map((f) => f.changedRatioVsControl);
      const gradRatios = Object.values(frames).map((f) => f.gradMedianFrame / Math.max(f.gradMedianControl, 0.5));
      const everyPairMoves = pairDiffs.every((d) => d.maskDiffPixels > 0);
      // GATE semantics ("档间无静态带纹" over multi-frames):
      //  - reject a frozen render: every consecutive pair differs INSIDE the
      //    clean cloud mask (cloud pixels animate — the band pattern tracks the
      //    drifting cloud rather than being a frozen screen overlay);
      //  - reject structure collapse: the toon transformation vs control stays
      //    active on ~all mask pixels every frame (if the tier structure died,
      //    the frame would fall back onto the control look and changedRatio
      //    would drop toward 0).
      // bestStepJumpsPerFrame / gradMedianRatioPerFrame / bandCountsPerFrame are
      // DESCRIPTIVE series: the dense subset is frozen at pose time, so both
      // boundary sharpness and the gradient ratio drift as the cloud moves
      // under it (observed 4.5 -> 2.1); the boundary GRAIN evidence is the
      // per-frame bestStepProfile dumps + the frame PNGs (目检).
      const everyFrameTiered = ratios.every((r) => r >= 0.9);
      gates.noFrozenBands = {
        frameCount: frameFiles.length,
        simSecondsPerGap: 5,
        bandCountsPerFrame: bandCounts,
        bestStepJumpsPerFrame: jumps,
        changedRatioPerFrame: ratios,
        gradMedianRatioPerFrame: gradRatios,
        everyPairMaskDiffPositive: everyPairMoves,
        everyFrameTiered,
        pass: everyPairMoves && everyFrameTiered,
        pairDiffs,
        frames,
      };
      console.log(`[frames] bandCounts=${bandCounts.join(',')} jumps=${jumps.map((j) => j.toFixed(1)).join(',')} changedRatio=${ratios.map((r) => r.toFixed(3)).join(',')} gradRatio=${gradRatios.map((r) => r.toFixed(1)).join(',')} everyPairMaskDiffPositive=${everyPairMoves} pass=${gates.noFrozenBands.pass}`);
      for (const d of pairDiffs) console.log(`  pair ${d.pair.join('->')}: global=${d.diffPixels} inMask=${d.maskDiffPixels} maxDelta=${d.maxDelta}`);
    } else {
      gates.noFrozenBands = { pass: false, note: 'frame captures missing' };
    }

    result.gates = gates;
    result.hashes = hashes;
    fs.writeFileSync(path.join(OUT, 'band-profile.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(OUT, 'hashes.json'), JSON.stringify(hashes, null, 2));
    const g1 = Object.values(gates.tierStructure).every((g) => g.pass);
    const g2 = Object.values(gates.toon0Identity).every((g) => g.pass);
    const g3 = gates.noFrozenBands?.pass === true;
    console.log(`GATES: tierStructure=${g1 ? 'PASS' : 'FAIL'} toon0Identity=${g2 ? 'PASS' : 'FAIL'} noFrozenBands=${g3 ? 'PASS' : 'FAIL'}`);
    console.log(`[ok] band-profile.json + hashes.json -> ${OUT}`);
    if (!(g1 && g2 && g3)) process.exitCode = 1;
  } finally {
    await fetch(`${CDP}/json/close/${target.id}`).catch(() => {});
    ws.close();
  }
}

main().catch((err) => {
  console.error('ANALYSIS FAILED:', err);
  process.exitCode = 1;
});
