/**
 * Toon-look-toggle Phase 1 Task 2 Step 6 — sky band_count gate + pixel-diff
 * quantification (toon-look A/B evidence for ab-evidence-task2/).
 *
 * BAND_COUNT METHOD (documented per the task contract) — MASKED-RUN analysis:
 *   1. The captured full-page PNGs (1384x772, DPR 1) are decoded IN PAGE from
 *      data URLs and cropped to the game canvas rect x[475,909) y[0,772) —
 *      434x772, the same rect the sidecars record (canvas [434,772]).
 *   2. CHANGE MASK: pixel = |toon1 - control| > 0 (any RGB channel). Task 2
 *      quantizes ONLY the skyColorTsl outlet (sky dome + sea reflection), so
 *      toon1-vs-control differences isolate exactly the quantized pixels —
 *      the tuning panel, clouds (Task 3/4 scope), aircraft, HUD and stars are
 *      BIT-IDENTICAL between the two runs and drop out of the mask.
 *   3. Per column x (all 434, step 2): maximal vertical mask-runs inside the
 *      SKY window y ∈ [16, 290) (all three poses keep the horizon below 290);
 *      runs ≥ MIN_MASK_RUN(8px) are "sky spans". The SEA window y ∈ [310, 700)
 *      gets the same treatment as supplementary sea-inheritance evidence.
 *   4. Per sky span: PLATEAUS = maximal runs of IDENTICAL 8-bit luminance
 *      (Rec.709 on sRGB bytes — tone mapping is monotone, posterize structure
 *      survives display encoding) with length ≥ MIN_RUN(4px); adjacent plateaus
 *      < GAP_MIN(6/255) apart merge — the 8-bit stair of a SMOOTH gradient
 *      steps ≤2/255 and collapses, posterize anchors are ≥15/255 apart.
 *   5. band_count(pose) = MAX plateau count over all sky spans; the SAME spans
 *      are measured on the control image as the negative control.
 *   GATE: toon=1 sky band_count ≥ 3 with the control flat by contrast.
 *
 * KNOWN READING NOTES (2026-11-13 run):
 *   · Control band counts are NOT zero — the reference sky ramp is itself
 *     piecewise-flat (smoothstep stops), and the translucent tuning panel +
 *     cloud-fringe blends change legitimately in toon1 (the sky behind them is
 *     quantized). The clean-sky window x[70,200) and the column profiles are
 *     the discriminating evidence: the control ramp holds no ≥8px flat runs
 *     (values step every 1-2 rows), toon1 holds flat anchor levels.
 *   · Transitions between toon levels span 4-6 rows, not 1: the horizon
 *     deck/veil overlays (dome-horizon, unquantized — Task 4 scope) add a
 *     smooth gradient on top of the quantized dome, so sharpSteps stays 0
 *     while the plateau LEVELS remain distinct (e.g. ref-level x=70:
 *     control 149→155 continuous vs toon1 138×19 rows then 170×12).
 *
 * PIXEL-DIFF method: same in-page decode; per pose, per channel abs-diff over
 * the cropped canvas — {diffPixels, maxDelta, meanDeltaOverDiff} for the pairs
 *   A) toon0 (Task-2 code, ?toon=0)  vs Task 0 committed baseline   [cross-session jitter evidence]
 *   B) toon0                          vs no-param control twin      [same-session: expect 0]
 *   C) toon1                          vs no-param control twin      [variant change scale]
 *
 * Env: CDP (default 127.0.0.1:9222), BASE (default http://[::1]:5173/),
 *      HERE (script dir — PNG inputs relative to it), OUT (default ab-evidence-task2).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CDP = process.env.CDP ?? 'http://127.0.0.1:9222';
const BASE = process.env.BASE ?? 'http://[::1]:5173/';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const OUT = path.join(HERE, process.env.OUT ?? 'ab-evidence-task2');
const MIN_RUN = 4;
const GAP_MIN = 6;
const MIN_MASK_RUN = 8;
// Clean-sky window: canvas x ∈ [70, 200) — right of the HUD speed arc, left of
// the tuning panel (~x205+; the panel is translucent, so the quantized sky
// behind it legitimately changes those pixels and pollutes full-width stats).
const CLEAN_WINDOW_X = [70, 200];

const POSES = ['baseline-ref-level', 'baseline-horizon-low', 'baseline-night-sun12-8'];
const SKY_WINDOW = [16, 290];
const SEA_WINDOW = [310, 700];
const IMAGES = {
  baseline: (p) => path.join(HERE, 'baseline', `${p}.png`),
  toon0: (p) => path.join(HERE, 'task2-toon0', `${p}.png`),
  control: (p) => path.join(HERE, 'task2-control', `${p}.png`),
  toon1: (p) => path.join(HERE, 'task2-toon1', `${p}.png`),
};

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
  const lum255 = (d, i) =>
    (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);

  // plateaus over one pixel span [yA, yB) of one column: maximal runs of
  // identical 8-bit luminance (>= MIN_RUN), adjacent values < GAP_MIN merged
  // (one anchor's 8-bit dither through tone mapping).
  // sharpSteps = adjacent LONG (>=8px) plateaus connected through <=2 transition
  // rows with a value jump >= GAP_MIN — the flat/flat/JUMP posterize signature.
  // A smooth gradient never produces it (its identical-value runs are 1-3 rows
  // and its plateaus connect through multi-row ramps).
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

  // masked-run analysis over one window: change mask from toon1-vs-control,
  // per-column maximal mask-runs >= MIN_MASK_RUN, band metric on both images
  const maskedRunAnalysis = (yLo, yHi, xLo, xHi) => {
    const t1 = window.__pix.toon1;
    const ct = window.__pix.control;
    const spans = []; // {x, yA, yB, len}
    for (let x = (xLo || 0); x < (xHi || 434); x += 2) {
      let y = yLo;
      while (y < yHi) {
        if (Math.abs(t1[(y * 434 + x) * 4] - ct[(y * 434 + x) * 4]) > 0 ||
            Math.abs(t1[(y * 434 + x) * 4 + 1] - ct[(y * 434 + x) * 4 + 1]) > 0 ||
            Math.abs(t1[(y * 434 + x) * 4 + 2] - ct[(y * 434 + x) * 4 + 2]) > 0) {
          const yA = y;
          while (y < yHi) {
            const i = (y * 434 + x) * 4;
            const changed = Math.abs(t1[i] - ct[i]) > 0 || Math.abs(t1[i + 1] - ct[i + 1]) > 0 || Math.abs(t1[i + 2] - ct[i + 2]) > 0;
            if (!changed) break;
            y++;
          }
          if (y - yA >= ${MIN_MASK_RUN}) spans.push({ x, yA, yB: y, len: y - yA });
        } else y++;
      }
    }
    const perSpan = spans.map((s) => ({
      ...s,
      toon1: spanBands(t1, s.x, s.yA, s.yB),
      control: spanBands(ct, s.x, s.yA, s.yB),
    }));
    const c1 = perSpan.map((s) => s.toon1.plateaus.length);
    const c0 = perSpan.map((s) => s.control.plateaus.length);
    const s1 = perSpan.map((s) => s.toon1.sharpSteps);
    const s0 = perSpan.map((s) => s.control.sharpSteps);
    // representative spans: the max-sharp-step toon1 span + median + last
    const byCount = [...perSpan].sort((a, b) => b.toon1.sharpSteps - a.toon1.sharpSteps || b.toon1.plateaus.length - a.toon1.plateaus.length);
    const samples = byCount.length ? [byCount[0], byCount[Math.floor(byCount.length / 2)], byCount[byCount.length - 1]] : [];
    return {
      spans: perSpan.length,
      bandCountMax: c1.length ? Math.max(...c1) : 0,
      controlBandCountMax: c0.length ? Math.max(...c0) : 0,
      bandCountDist: c1.reduce((m, c) => { m[c] = (m[c] || 0) + 1; return m; }, {}),
      controlBandCountDist: c0.reduce((m, c) => { m[c] = (m[c] || 0) + 1; return m; }, {}),
      sharpStepsMax: s1.length ? Math.max(...s1) : 0,
      sharpStepsSum: s1.reduce((a, b) => a + b, 0),
      controlSharpStepsMax: s0.length ? Math.max(...s0) : 0,
      controlSharpStepsSum: s0.reduce((a, b) => a + b, 0),
      sampleSpans: samples.map((s) => ({
        x: s.x, yA: s.yA, yB: s.yB, len: s.len,
        toon1Plateaus: s.toon1.plateaus.map((p) => p.val + 'x' + p.len).join(' '),
        controlPlateaus: s.control.plateaus.map((p) => p.val + 'x' + p.len).join(' '),
        toon1SharpSteps: s.toon1.sharpSteps,
        controlSharpSteps: s.control.sharpSteps,
      })),
    };
  };

  const diff = (a, b) => {
    let diffPixels = 0, maxDelta = 0, sum = 0;
    for (let i = 0; i < a.length; i += 4) {
      for (let ch = 0; ch < 3; ch++) {
        const d = Math.abs(a[i + ch] - b[i + ch]);
        if (d > 0) { diffPixels++; sum += d; maxDelta = Math.max(maxDelta, d); }
      }
    }
    return { diffPixels, maxDelta, meanDelta: diffPixels ? sum / diffPixels : 0 };
  };

  window.__pix = window.__pix || {};
  // functions never survive returnByValue — park the API on window instead
  window.__api = {
    load: async (key, b64) => { window.__pix[key] = await loadCropped(b64); return true; },
    analyze: (win, xwin) => maskedRunAnalysis(win[0], win[1], xwin && xwin[0], xwin && xwin[1]),
    diff: (a, b) => diff(window.__pix[a], window.__pix[b]),
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

  try {
    await send('Runtime.enable');
    await send('Page.enable');
    await new Promise((r) => setTimeout(r, 1500));

    const ready = await evalInPage(PAGE_ANALYZE);
    if (ready !== 'api-ready') throw new Error('page api failed to install');
    const result = {
      protocol: {
        method: 'see script header — masked-run band analysis',
        minRun: MIN_RUN, gapMin: GAP_MIN, minMaskRun: MIN_MASK_RUN,
        skyWindow: SKY_WINDOW, seaWindow: SEA_WINDOW, cleanWindowX: CLEAN_WINDOW_X,
        canvasRect: [475, 0, 434, 772],
        images: {},
      },
      poses: {},
    };
    const hashes = {};

    for (const pose of POSES) {
      for (const [key, pathOf] of Object.entries(IMAGES)) {
        const file = pathOf(pose);
        const b64 = fs.readFileSync(file).toString('base64');
        hashes[`${key}/${pose}`] = { sha256: sha256(file), bytes: fs.statSync(file).size };
        await evalInPage(`return window.__api.load('${key}', '${b64}');`);
      }
      const sky = await evalInPage(`return window.__api.analyze([${SKY_WINDOW}]);`);
      const clean = await evalInPage(`return window.__api.analyze([${SKY_WINDOW}], [${CLEAN_WINDOW_X}]);`);
      const sea = await evalInPage(`return window.__api.analyze([${SEA_WINDOW}]);`);
      const dA = await evalInPage(`return window.__api.diff('toon0', 'baseline');`);
      const dB = await evalInPage(`return window.__api.diff('toon0', 'control');`);
      const dC = await evalInPage(`return window.__api.diff('toon1', 'control');`);
      result.poses[pose] = { sky, cleanSkyWindow: clean, sea, diffs: { toon0_vs_task0Baseline: dA, toon0_vs_control: dB, toon1_vs_control: dC } };
      console.log(`[${pose}]`);
      console.log(`  CLEAN-SKY x${JSON.stringify(CLEAN_WINDOW_X)} spans=${clean.spans}  toon1 band_count max=${clean.bandCountMax} dist=${JSON.stringify(clean.bandCountDist)}`);
      console.log(`       control same spans max=${clean.controlBandCountMax} dist=${JSON.stringify(clean.controlBandCountDist)}`);
      console.log(`       SHARP-STEPS toon1 max/sum=${clean.sharpStepsMax}/${clean.sharpStepsSum}  control max/sum=${clean.controlSharpStepsMax}/${clean.controlSharpStepsSum}`);
      for (const s of clean.sampleSpans) {
        console.log(`       span x=${s.x} y[${s.yA},${s.yB}) toon1: ${s.toon1Plateaus}`);
        console.log(`                     control: ${s.controlPlateaus}`);
      }
      console.log(`  SKY(all) spans=${sky.spans}  toon1 max=${sky.bandCountMax}  control max=${sky.controlBandCountMax}`);
      console.log(`  SEA spans=${sea.spans}  toon1 max=${sea.bandCountMax}  control max=${sea.controlBandCountMax} (supplementary)`);
      console.log(`  toon0 vs task0-baseline: ${JSON.stringify(dA)}`);
      console.log(`  toon0 vs control twin  : ${JSON.stringify(dB)}`);
      console.log(`  toon1 vs control twin  : ${JSON.stringify(dC)}`);
    }

    result.images = hashes;
    fs.writeFileSync(path.join(OUT, 'band-profile.json'), JSON.stringify(result, null, 2));
    console.log(`[ok] band-profile.json -> ${OUT}`);
  } finally {
    await fetch(`${CDP}/json/close/${target.id}`).catch(() => {});
    ws.close();
  }
}

main().catch((err) => {
  console.error('ANALYSIS FAILED:', err);
  process.exitCode = 1;
});
