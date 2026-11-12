/**
 * Toon-look-toggle Phase 1 Task 6 Gate 2 — three-region quantization measurement
 * + horizon seam flip check + transition-frame check (ab-evidence-task6/).
 *
 * INSTRUMENT SELECTION follows artifacts/toon-audit/README.md pointer table
 * (Task 5 ledger — choosing the wrong instrument systematically under-reads a
 * region; Task 3 proved column-plateau band_count under-reads the volumetric
 * dome):
 *
 *   sky / sea   column profile + band_count (Task 2 method: masked-run analysis,
 *               clean-sky window x[70,200), sky y[16,290), sea y[310,700)).
 *               Control band_count nonzero is a KNOWN reading (the reference ramp
 *               is piecewise-flat) — the discriminating evidence is the PROFILE
 *               SHAPE (control continuous ramp vs toon1 flat anchor levels) plus
 *               the sharpSteps flat/flat/JUMP signature.
 *   dome/cloud  NOT measured here — the attribution+gradient+profile+目检
 *               quadruple runs via analyze-task3-dome.mjs with env overrides
 *               (CONTROL=matrix/control TOON0=matrix/toon0 TOON1=matrix/toon1
 *               NODOME=matrix/nodome FRAMES=matrix/frames OUT=ab-evidence-task6);
 *               this script only records the pointer.
 *   seam        analyze_horizon_isolation.py caliber: HUD-hidden frames
 *               (captured by capture-toon-matrix.mjs seam pair), explicit render
 *               flush (capture protocol PRESENT round), isolation band = ONE
 *               waterline row pinned from the control frame (low-variance row
 *               with the max upward 2-row step whose sky side is a >=18-row
 *               smooth run; the caliber's original variance-min detector and a
 *               plain max-step variant both mislocked — history in the
 *               horizonRow comment below; the retired max|d luma/d row| of
 *               analyze_horizon.py is NOT used), control frame judged with the
 *               same instrument on the SAME pinned row. Flip verdict is
 *               DIFFERENTIAL: regression = flip(toon1) && !flip(control) — an
 *               absolute sea>sky reading at the waterline is a reference-look
 *               property (sunset sea road); per-frame excess (sea − sky
 *               median) is recorded for both frames.
 *   transition  ?toon=0.5 ref-level frame (Review Focus 1): sky still measures
 *               >= 2 tiers (not mushed back to a continuous gradient), diff vs
 *               control/toon1 finite (NaN guard is unit-tested at Task 2; here
 *               the frame-level sanity is finite diff stats).
 *
 * Cross-session supplements (Task 1 ruling: jitter excluded from gates):
 *   toon0 vs Task 0 committed baseline — expected isolated ±1/255 GPU jitter
 *   signature (byte-compare instrument retired at Task 2; the task4-toon0
 *   sidecar's raw "A/B gate FAILED" text is that RETIRED instrument's output,
 *   not a regression — the ruling context lives in hashes.json gates blocks).
 *   toon0 vs task4-toon0 (prior session) — sha256 chain continuity.
 *
 * GATES (recorded with explicit pass/fail):
 *   sky   toon1 clean-sky bandCountMax >= 3, control contrast recorded
 *   sea   toon1 sea bandCountMax >= 3 (masked spans; control contrast recorded)
 *   seam  DIFFERENTIAL rule: FAIL only if flip(toon1) && !flip(control) — the
 *         flip must not be INTRODUCED by quantization. The control frame IS
 *         judged with the same instrument; if it flips too, that sea>sky
 *         reading is a pre-toon reference-look property (sunset sea road) and
 *         the gate PASSes (per-frame excess recorded for both)
 *   trans toon05 clean-sky bandCountMax >= 2
 *
 * Env: CDP, BASE, HERE (PNG inputs relative), OUT (default ab-evidence-task6),
 *      MATRIX (default matrix).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CDP = process.env.CDP ?? 'http://127.0.0.1:9222';
const BASE = process.env.BASE ?? 'http://[::1]:5173/';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const OUT = path.join(HERE, process.env.OUT ?? 'ab-evidence-task6');
const MATRIX = path.join(HERE, process.env.MATRIX ?? 'matrix');
const MIN_RUN = 4;
const GAP_MIN = 6;
const MIN_MASK_RUN = 8;
const SKY_WINDOW = [16, 290];
const SEA_WINDOW = [310, 700];
const CLEAN_WINDOW_X = [70, 200]; // right of HUD arc, left of tuning panel (Task 2)
const PANEL_RECT = [198, 73, 424, 214]; // UI exclusion (Task 3) — seam rows sit below y214
const HUD_RECT = [0, 58, 140, 196];
// seam detector column band (canvas coords): RIGHT of the aircraft — the left
// band x[60,180) is contaminated by the plane (wing/fuselage rows ~375-460,
// first run's step detector locked onto the wing edge at row 415). x[340,420)
// is clean scene from row 240 down to 408 (the right float enters at 412).
const SEAM_COLS = [340, 420];
const SEAM_ROWS = [240, 408];
const POSES = ['baseline-ref-level', 'baseline-horizon-low', 'baseline-night-sun12-8'];

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const img = (dir, pose) => path.join(MATRIX, dir, `${pose}.png`);
const committed = (pose) => path.join(HERE, 'baseline', `${pose}.png`);

// ---- analysis source (runs in page; method code shared with analyze-band-count.mjs) ----

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
  const lum255 = (d, i) => (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);

  const spanBands = (d, x, yA, yB) => {
    const runs = [];
    for (let y = yA; y < yB; y++) {
      const v = Math.round(lum255(d, (y * 434 + x) * 4));
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
    const longIdx = runs.map((r, i) => (r.len >= 8 ? i : -1)).filter((i) => i >= 0);
    let sharpSteps = 0;
    for (let k = 0; k + 1 < longIdx.length; k++) {
      const a = longIdx[k];
      const b = longIdx[k + 1];
      let gap = 0;
      for (let m = a + 1; m < b; m++) gap += runs[m].len;
      if (gap <= 2 && Math.abs(runs[b].val - runs[a].val) >= ${GAP_MIN}) sharpSteps++;
    }
    return { plateaus, sharpSteps };
  };

  const maskedRunAnalysis = (variantKey, controlKey, yLo, yHi, xLo, xHi) => {
    const v = window.__pix[variantKey];
    const ct = window.__pix[controlKey];
    const spans = [];
    for (let x = (xLo || 0); x < (xHi || 434); x += 2) {
      let y = yLo;
      while (y < yHi) {
        const i = (y * 434 + x) * 4;
        const changed = Math.abs(v[i] - ct[i]) > 0 || Math.abs(v[i+1] - ct[i+1]) > 0 || Math.abs(v[i+2] - ct[i+2]) > 0;
        if (changed) {
          const yA = y;
          while (y < yHi) {
            const j = (y * 434 + x) * 4;
            const ch = Math.abs(v[j] - ct[j]) > 0 || Math.abs(v[j+1] - ct[j+1]) > 0 || Math.abs(v[j+2] - ct[j+2]) > 0;
            if (!ch) break;
            y++;
          }
          if (y - yA >= ${MIN_MASK_RUN}) spans.push({ x, yA, yB: y, len: y - yA });
        } else y++;
      }
    }
    const perSpan = spans.map((s) => ({
      ...s,
      variant: spanBands(v, s.x, s.yA, s.yB),
      control: spanBands(ct, s.x, s.yA, s.yB),
    }));
    const cV = perSpan.map((s) => s.variant.plateaus.length);
    const cC = perSpan.map((s) => s.control.plateaus.length);
    const sV = perSpan.map((s) => s.variant.sharpSteps);
    const sC = perSpan.map((s) => s.control.sharpSteps);
    const byCount = [...perSpan].sort((a, b) => b.variant.sharpSteps - a.variant.sharpSteps || b.variant.plateaus.length - a.variant.plateaus.length);
    const samples = byCount.length ? [byCount[0], byCount[Math.floor(byCount.length / 2)], byCount[byCount.length - 1]] : [];
    return {
      spans: perSpan.length,
      bandCountMax: cV.length ? Math.max(...cV) : 0,
      controlBandCountMax: cC.length ? Math.max(...cC) : 0,
      bandCountDist: cV.reduce((m, c) => { m[c] = (m[c] || 0) + 1; return m; }, {}),
      sharpStepsMax: sV.length ? Math.max(...sV) : 0,
      sharpStepsSum: sV.reduce((a, b) => a + b, 0),
      controlSharpStepsMax: sC.length ? Math.max(...sC) : 0,
      controlSharpStepsSum: sC.reduce((a, b) => a + b, 0),
      sampleSpans: samples.map((s) => ({
        x: s.x, yA: s.yA, yB: s.yB, len: s.len,
        variantPlateaus: s.variant.plateaus.map((p) => p.val + 'x' + p.len).join(' '),
        controlPlateaus: s.control.plateaus.map((p) => p.val + 'x' + p.len).join(' '),
        variantSharpSteps: s.variant.sharpSteps,
        controlSharpSteps: s.control.sharpSteps,
      })),
    };
  };

  // diff takes ImageData VALUES (the __api wrapper resolves keys — same shape
  // as analyze-band-count.mjs; resolving twice was the first run's bug)
  const diff = (x, y) => {
    let diffPixels = 0, maxDelta = 0, sum = 0;
    for (let i = 0; i < x.length; i += 4) {
      for (let ch = 0; ch < 3; ch++) {
        const d = Math.abs(x[i + ch] - y[i + ch]);
        if (d > 0) { diffPixels++; sum += d; maxDelta = Math.max(maxDelta, d); }
      }
    }
    return { diffPixels, maxDelta, meanDelta: diffPixels ? sum / diffPixels : 0 };
  };

  // ---- seam instruments (horizon-isolation caliber) ----
  const median = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  // horizon row = the row with the max upward 2-row luminance STEP whose
  // SKY side is a sustained smooth run: >= SMOOTH_RUN rows immediately above
  // all with variance < 25 (the sky gradient band), variance of the row
  // itself < 25. Two earlier detectors failed on this scene and are kept as
  // history in the first-run notes: pure variance-min lands on whichever
  // smooth row the search window starts at; plain max-step under var<25
  // locks onto sea wave-lane boundaries (row 343, step 9.8) or the aircraft
  // (row 415, step 25 — left band). The smooth-run-above requirement is what
  // separates the sky->far-sea discontinuity from within-sea edges; the p15
  // gates record horizon_row 293-300 for this pose (corroboration).
  const horizonRow = (key) => {
    const d = window.__pix[key];
    const [xLo, xHi] = ${JSON.stringify(SEAM_COLS)};
    const SMOOTH_RUN = 18, VAR_MAX = 25;
    const rowMean = (y) => {
      let s = 0;
      for (let x = xLo; x < xHi; x++) s += lum255(d, (y * 434 + x) * 4);
      return s / (xHi - xLo);
    };
    const rowVar = (y) => {
      let s = 0, s2 = 0;
      for (let x = xLo; x < xHi; x++) { const v = lum255(d, (y * 434 + x) * 4); s += v; s2 += v * v; }
      const m = s / (xHi - xLo);
      return s2 / (xHi - xLo) - m * m;
    };
    const vars = {}, means = {};
    for (let y = ${SEAM_ROWS[0]}; y < ${SEAM_ROWS[1]}; y++) { vars[y] = rowVar(y); means[y] = rowMean(y); }
    let best = { row: -1, step: -Infinity };
    const table = [];
    for (let y = ${SEAM_ROWS[0] + 20}; y < ${SEAM_ROWS[1]}; y++) { // +20 = SMOOTH_RUN(18) + 2 (step lookback)
      let smoothAbove = true;
      for (let k = y - SMOOTH_RUN; k < y; k++) if (vars[k] >= VAR_MAX) { smoothAbove = false; break; }
      const step = means[y] - means[y - 2];
      table.push({ y, mean: Math.round(means[y] * 10) / 10, v: Math.round(vars[y] * 100) / 100, step: Math.round(step * 10) / 10, smoothAbove });
      if (smoothAbove && vars[y] < VAR_MAX && step > best.step) best = { row: y, step };
    }
    return { row: best.row, step: Math.round(best.step * 100) / 100, rowTable: table };
  };
  const seamMeasure = (key, hr) => {
    const d = window.__pix[key];
    const [xLo, xHi] = ${JSON.stringify(SEAM_COLS)};
    const skyVals = [], seaVals = [];
    for (let y = hr - 7; y < hr - 1; y++) for (let x = xLo; x < xHi; x++) skyVals.push(lum255(d, (y * 434 + x) * 4));
    for (let y = hr + 2; y < hr + 8; y++) for (let x = xLo; x < xHi; x++) seaVals.push(lum255(d, (y * 434 + x) * 4));
    const sky = median(skyVals), sea = median(seaVals);
    // isolation band: vertical luminance profile across the waterline at sample columns
    const profiles = [80, 217, 350].map((x) => {
      const col = [];
      for (let y = hr - 16; y < hr + 16; y++) col.push(Math.round(lum255(d, (y * 434 + x) * 4)));
      return { x, rows: [hr - 16, hr + 16], values: col };
    });
    return { skyMedianLum: Math.round(sky * 100) / 100, seaMedianLum: Math.round(sea * 100) / 100, seaOverSky: Math.round((sea / Math.max(sky, 1e-6)) * 1000) / 1000, flip: sea > sky + 0.5, profiles };
  };

  window.__pix = {};
  window.__api = {
    load: async (key, b64) => { window.__pix[key] = await loadCropped(b64); return true; },
    analyze: (variantKey, controlKey, win, xwin) => maskedRunAnalysis(variantKey, controlKey, win[0], win[1], xwin && xwin[0], xwin && xwin[1]),
    diff: (a, b) => diff(window.__pix[a], window.__pix[b]),
    horizonRow,
    seamMeasure,
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

  const result = {
    protocol: {
      method: 'see script header — README pointer-table instrument selection',
      minRun: MIN_RUN, gapMin: GAP_MIN, minMaskRun: MIN_MASK_RUN,
      skyWindow: SKY_WINDOW, seaWindow: SEA_WINDOW, cleanWindowX: CLEAN_WINDOW_X,
      seam: { caliber: 'analyze_horizon_isolation.py discipline (HUD hidden + explicit flush + isolation band + control frame)', cols: SEAM_COLS, rowSearch: SEAM_ROWS, detector: 'low-variance row with the max upward 2-row luminance step (sky->far-sea discontinuity); p15 gates record horizon_row 293-300 for this pose — corroborated; the retired analyze_horizon.py max-gradient detector is NOT used' },
      canvasRect: [475, 0, 434, 772],
      cloudRegion: 'measured by analyze-task3-dome.mjs (attribution+gradient+profile quadruple) via env overrides -> ab-evidence-task6/band-profile.json; NOT band_count',
    },
    gates: {},
    poses: {},
    transition: {},
    seam: {},
    supplements: {},
  };
  const hashes = {};
  const load = async (key, file) => {
    hashes[key] = { sha256: sha256(file), bytes: fs.statSync(file).size };
    await evalInPage(`return window.__api.load('${key}', '${fs.readFileSync(file).toString('base64')}');`);
  };

  try {
    await send('Runtime.enable');
    await send('Page.enable');
    await new Promise((r) => setTimeout(r, 1500));
    if ((await evalInPage(PAGE_ANALYZE)) !== 'api-ready') throw new Error('page api failed to install');

    // ---- per-pose sky/sea regions ----
    for (const pose of POSES) {
      await load(`control/${pose}`, img('control', pose));
      await load(`toon0/${pose}`, img('toon0', pose));
      await load(`toon1/${pose}`, img('toon1', pose));
      await load(`baseline/${pose}`, committed(pose));
      const task4File = path.join(HERE, 'task4-toon0', `${pose}.png`);
      if (fs.existsSync(task4File)) await load(`task4toon0/${pose}`, task4File);

      const sky = await evalInPage(`return window.__api.analyze('toon1/${pose}', 'control/${pose}', [${SKY_WINDOW}], [${CLEAN_WINDOW_X}]);`);
      const skyAll = await evalInPage(`return window.__api.analyze('toon1/${pose}', 'control/${pose}', [${SKY_WINDOW}]);`);
      const sea = await evalInPage(`return window.__api.analyze('toon1/${pose}', 'control/${pose}', [${SEA_WINDOW}]);`);
      const dBase = await evalInPage(`return window.__api.diff('toon0/${pose}', 'baseline/${pose}');`);
      const dCtl = await evalInPage(`return window.__api.diff('toon0/${pose}', 'control/${pose}');`);
      const dTask4 = fs.existsSync(task4File)
        ? await evalInPage(`return window.__api.diff('toon0/${pose}', 'task4toon0/${pose}');`)
        : null;

      result.poses[pose] = {
        skyCleanWindow: sky,
        skyAllWindows: skyAll,
        seaWindow: sea,
        supplements: {
          toon0_vs_task0Baseline: dBase,
          toon0_vs_control_sameRun: dCtl,
          toon0_vs_task4Toon0_xSession: dTask4,
          toon0_xSession_sha: hashes[`task4toon0/${pose}`] ?? null,
        },
      };
      const skyPass = sky.bandCountMax >= 3;
      const seaPass = sea.bandCountMax >= 3;
      result.gates[pose] = { sky: skyPass ? 'PASS' : 'FAIL', sea: seaPass ? 'PASS' : 'FAIL' };
      console.log(`[${pose}]`);
      console.log(`  SKY clean x${JSON.stringify(CLEAN_WINDOW_X)}: toon1 bandCountMax=${sky.bandCountMax} ctrl=${sky.controlBandCountMax} sharpSteps max/sum=${sky.sharpStepsMax}/${sky.sharpStepsSum} ctrl=${sky.controlSharpStepsMax}/${sky.controlSharpStepsSum} -> ${skyPass ? 'PASS' : 'FAIL'}`);
      console.log(`  SEA y${JSON.stringify(SEA_WINDOW)}: toon1 bandCountMax=${sea.bandCountMax} ctrl=${sea.controlBandCountMax} sharpSteps max/sum=${sea.sharpStepsMax}/${sea.sharpStepsSum} ctrl=${sea.controlSharpStepsMax}/${sea.controlSharpStepsSum} -> ${seaPass ? 'PASS' : 'FAIL'}`);
      for (const s of sky.sampleSpans.slice(0, 2)) {
        console.log(`    sky span x=${s.x} y[${s.yA},${s.yB}) toon1: ${s.variantPlateaus}`);
        console.log(`                        control: ${s.controlPlateaus}`);
      }
      console.log(`  toon0 vs Task0-baseline: ${JSON.stringify(dBase)} | vs control: ${JSON.stringify(dCtl)}${dTask4 ? ` | vs task4-toon0: ${JSON.stringify(dTask4)}` : ''}`);
    }

    // ---- transition frame (Review Focus 1) ----
    const t05File = img('toon05', 'baseline-ref-level');
    if (fs.existsSync(t05File)) {
      await load('toon05', t05File);
      const tSky = await evalInPage(`return window.__api.analyze('toon05', 'control/baseline-ref-level', [${SKY_WINDOW}], [${CLEAN_WINDOW_X}]);`);
      const dT0 = await evalInPage(`return window.__api.diff('toon05', 'toon0/baseline-ref-level');`);
      const dT1 = await evalInPage(`return window.__api.diff('toon05', 'toon1/baseline-ref-level');`);
      const finite = Number.isFinite(dT0.diffPixels) && Number.isFinite(dT0.maxDelta) && Number.isFinite(dT1.diffPixels);
      result.transition = {
        skyCleanWindow: tSky,
        diff_vs_toon0: dT0,
        diff_vs_toon1: dT1,
        finiteStats: finite,
        gate: { tiersAtHalf: tSky.bandCountMax >= 2 ? 'PASS' : 'FAIL', noNaN: finite ? 'PASS' : 'FAIL' },
      };
      console.log(`[transition toon=0.5 ref-level] sky bandCountMax=${tSky.bandCountMax} ctrl=${tSky.controlBandCountMax} | vs toon0 ${JSON.stringify(dT0)} | vs toon1 ${JSON.stringify(dT1)}`);
    } else {
      result.transition = { skipped: 'toon05 frame not found' };
    }

    // ---- seam flip check (Review Focus 3, isolation caliber) ----
    const seamCtlFile = img('seam-control', 'baseline-horizon-low');
    const seamT1File = img('seam-toon1', 'baseline-horizon-low');
    if (fs.existsSync(seamCtlFile) && fs.existsSync(seamT1File)) {
      await load('seam-control', seamCtlFile);
      await load('seam-toon1', seamT1File);
      const hrC = await evalInPage(`return window.__api.horizonRow('seam-control');`);
      const hrT = await evalInPage(`return window.__api.horizonRow('seam-toon1');`);
      // PIN one waterline row for the whole pair (isolation caliber: same
      // instrument band on both frames). The camera is identical between the
      // two frames, so the waterline is geometrically the same row; letting
      // each frame free-run its own row (first run: 300 vs 307 — toon1's sea
      // texture onset differs) breaks the sky/sea band symmetry. The control
      // frame's detection is pinned; toon1's independent detection is kept
      // as a consistency check.
      const hr = hrC.row;
      const mC = await evalInPage(`return window.__api.seamMeasure('seam-control', ${hr});`);
      const mT = await evalInPage(`return window.__api.seamMeasure('seam-toon1', ${hr});`);
      // Gate (Review Focus 3): "量化后地平线行若「海亮过天」即撕裂" — the flip
      // must not be INTRODUCED by quantization. The absolute sea>sky property
      // at the waterline is a reference-look feature (sunset sea road): the
      // CONTROL frame is judged with the same instrument, and the regression
      // condition is flip(toon1) && !flip(control). The sea-over-sky excess
      // (sea − sky) is recorded for both frames as the directional evidence.
      const introduced = mT.flip && !mC.flip;
      result.seam = {
        pinnedHorizonRow: hr,
        control: { detectedRow: hrC.row, detectedStep: hrC.step, ...mC },
        toon1: { detectedRow: hrT.row, detectedStep: hrT.step, rowAgreement: Math.abs(hrT.row - hrC.row) <= 8 ? 'OK' : 'DIVERGENT', ...mT },
        rowTableControl: hrC.rowTable,
        verdict: {
          controlFlip: mC.flip,
          toon1Flip: mT.flip,
          seaOverSkyExcessControl: Math.round((mC.seaMedianLum - mC.skyMedianLum) * 100) / 100,
          seaOverSkyExcessToon1: Math.round((mT.seaMedianLum - mT.skyMedianLum) * 100) / 100,
          gate: introduced ? 'FAIL (quantization introduced the sea-over-sky flip)' : 'PASS (no flip introduced by quantization)',
          note: 'absolute sea>sky at the waterline exists in the control too (reference-look sunset sea road); the gate judges the toon-introduced regression, excess values recorded for both frames',
        },
      };
      console.log(`[seam] pinned horizon row=${hr} (control detected ${hrC.row} step ${hrC.step}; toon1 detected ${hrT.row} step ${hrT.step})`);
      console.log(`  control: sky=${mC.skyMedianLum} sea=${mC.seaMedianLum} flip=${mC.flip} excess=${result.seam.verdict.seaOverSkyExcessControl}`);
      console.log(`  toon1  : sky=${mT.skyMedianLum} sea=${mT.seaMedianLum} flip=${mT.flip} excess=${result.seam.verdict.seaOverSkyExcessToon1}`);
      console.log(`  gate: ${result.seam.verdict.gate}`);
      for (const p of mT.profiles) console.log(`  toon1 col x=${p.x}: ${p.values.join(',')}`);
    } else {
      result.seam = { skipped: 'seam pair not found (capture with SKIP_SEAM unset)' };
    }

    result.hashes = hashes;
    // overall gate summary
    result.gatesSummary = {
      sky: Object.values(result.gates).every((g) => g.sky === 'PASS') ? 'PASS' : 'FAIL',
      sea: Object.values(result.gates).every((g) => g.sea === 'PASS') ? 'PASS' : 'FAIL',
      seam: result.seam?.verdict?.gate?.startsWith('PASS') ? 'PASS' : 'FAIL',
      transition: result.transition?.gate ? (Object.values(result.transition.gate).every((v) => v === 'PASS') ? 'PASS' : 'FAIL') : 'SKIPPED',
      cloud: 'see ab-evidence-task6/band-profile.json (analyze-task3-dome.mjs quadruple)',
    };
    fs.writeFileSync(path.join(OUT, 'region-profile.json'), JSON.stringify(result, null, 2));
    console.log(`[ok] region-profile.json -> ${OUT}`);
    console.log(`[gates] ${JSON.stringify(result.gatesSummary)}`);
  } finally {
    await fetch(`${CDP}/json/close/${target.id}`).catch(() => {});
    ws.close();
  }
}

main().catch((err) => {
  console.error('ANALYSIS FAILED:', err);
  process.exitCode = 1;
});
