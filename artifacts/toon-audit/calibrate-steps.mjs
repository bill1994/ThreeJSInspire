/**
 * Toon-look-toggle Phase 1 Task 2 Step 3 — TOON_STEPS anchor calibration.
 *
 * Collects the reference-key sky luminance PROFILE in the FUNCTION's own space
 * (skyColorJs linear output, pre-tonemap — the space the outlet posterize
 * operates in) by importing the vite-served PURE mirror modules inside the page:
 *
 *     const m = await import('/src/sky-color-js.ts')   // pure TS, no three
 *     const st = await import('/src/sky-track.ts')
 *
 * — zero reimplementation, the exact code the TSL side mirrors. No PNG frames,
 * no render: the outlet lives upstream of tone mapping (renderer.ts ACES/
 * Neutral), so display-pixel luminance would calibrate the WRONG space.
 *
 * Sampling: uniform dome grid az 0..355 step 5 (72) × el -10..90 step 2.5 (41)
 * at the reference keyframe (skyTrackAt(REFERENCE_ELEVATION_DEG)), sun =
 * SUN_DIRECTION, includeDisc=false (the diffuse field the anchors band; the
 * disc is a ~0.5° solid angle that lands in the top bucket regardless — stats
 * for includeDisc=true are recorded as reference only).
 *
 * Output steps.json:
 *   protocol / sampleCount / lumWeights
 *   profile  { min, max, mean, percentiles{p1..p99}, histogram(24 bins) }
 *   discTrue { min, max }            — includeDisc=true reference stats
 *   proposed { method, anchors }     — equal-population quantile spread
 *   myCall   { anchors, quantileOf } — plan initial values mapped onto the data
 *
 * Env: BASE (default http://[::1]:5173/), CDP (default 127.0.0.1:9222),
 *      OUT (default alongside this script). Headed Chrome required only for
 *      same-origin module import (any live page on the dev server origin).
 */
import fs from 'node:fs';
import path from 'node:path';

const CDP = process.env.CDP ?? 'http://127.0.0.1:9222';
const BASE = process.env.BASE ?? 'http://[::1]:5173/';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const OUT = process.env.OUT ?? HERE;

const CALIB = `
  const sc = await import('/src/sky-color-js.ts');
  const st = await import('/src/sky-track.ts');
  const pal = await import('/src/palettes.ts');
  const hz = await import('/src/horizon.ts');

  const LUMW = [0.2126, 0.7152, 0.0722];
  const lum = (v) => LUMW[0] * v[0] + LUMW[1] * v[1] + LUMW[2] * v[2];
  const dirFromAzEl = hz.sunDirectionFromAzEl;

  const refP = st.REFERENCE_ELEVATION_DEG;
  const state = st.skyTrackAt(refP);
  const sun = pal.SUN_DIRECTION;
  const refState = st.skyTrackAt(st.REFERENCE_ELEVATION_DEG);
  const refParams = refState.preetham;

  const lumsFalse = [];
  const lumsTrue = [];
  for (let az = 0; az < 360; az += 5) {
    for (let el = -10; el <= 90; el += 2.5) {
      const dir = dirFromAzEl(az, el);
      lumsFalse.push(lum(sc.skyColorJs(dir, sun, state, sun, refParams, false)));
      lumsTrue.push(lum(sc.skyColorJs(dir, sun, state, sun, refParams, true)));
    }
  }
  return { lumsFalse, lumsTrue, refElevation: refP, sun: [...sun] };
`;

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

function profile(lums, bins = 24) {
  const sorted = [...lums].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const percentiles = {};
  for (const p of [1, 5, 10, 25, 40, 50, 60, 75, 90, 95, 99]) percentiles[`p${p}`] = percentile(sorted, p);
  const histogram = new Array(bins).fill(0);
  const span = max - min || 1e-9;
  for (const v of lums) histogram[Math.min(bins - 1, Math.floor(((v - min) / span) * bins))] += 1;
  return {
    min,
    max,
    mean: lums.reduce((a, b) => a + b, 0) / lums.length,
    percentiles,
    histogram: histogram.map((count, i) => ({
      lo: min + (span * i) / bins,
      hi: min + (span * (i + 1)) / bins,
      count,
    })),
  };
}

// Equal-population spread: 6 anchors at these population quantiles — the two
// extremes pulled toward the data edge so the ramp covers the whole span.
const PROPOSED_QUANTILES = [1, 20, 40, 60, 80, 98];

const MY_CALL = [0.02, 0.08, 0.18, 0.32, 0.52, 0.75];

async function newTab(url) {
  const res = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`newTab ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  const target = await newTab(`${BASE}?qa=frozen`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
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
      setTimeout(() => reject(new Error(`timeout ${method}`)), 60000);
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
    // wait for the page to settle enough to serve module imports (document ready)
    const t0 = Date.now();
    for (;;) {
      const ready = await evalInPage(`return document.readyState;`).catch(() => 'loading');
      if (ready === 'complete' || Date.now() - t0 > 30000) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    const { lumsFalse, lumsTrue, refElevation, sun } = await evalInPage(CALIB);
    const prof = profile(lumsFalse);
    const sortedFalse = [...lumsFalse].sort((a, b) => a - b);
    const proposed = {
      method: `equal-population quantiles ${JSON.stringify(PROPOSED_QUANTILES)} of the diffuse-sky luminance distribution`,
      anchors: PROPOSED_QUANTILES.map((q) => Number(percentile(sortedFalse, q).toFixed(4))),
    };
    const myCallQuantile = {};
    for (const a of MY_CALL) {
      const below = sortedFalse.filter((v) => v <= a).length;
      myCallQuantile[a] = Number(((below / sortedFalse.length) * 100).toFixed(1));
    }
    const payload = {
      generatedAt: new Date().toISOString(),
      protocol: {
        base: BASE,
        cdp: CDP,
        space: 'skyColorJs linear output (outlet space, pre-tonemap) — display pixels would calibrate the wrong space',
        modules: 'vite-served /src/sky-color-js.ts + /src/sky-track.ts imported IN PAGE — zero reimplementation',
        grid: 'az 0..355 step 5 × el -10..90 step 2.5 (72×41 = 2952 dirs)',
        state: `skyTrackAt(REFERENCE_ELEVATION_DEG = ${refElevation}), sun = SUN_DIRECTION ${JSON.stringify(sun)}`,
        lumWeights: 'Rec.709 [0.2126, 0.7152, 0.0722]',
      },
      sampleCount: lumsFalse.length,
      profile: prof,
      discTrue: { min: Math.min(...lumsTrue), max: Math.max(...lumsTrue) },
      proposed,
      myCall: { anchors: MY_CALL, quantileOf: myCallQuantile },
    };
    const outPath = path.join(OUT, 'steps.json');
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
    console.log(`[ok] steps.json written: ${outPath}`);
    console.log(`profile: min=${prof.min.toFixed(4)} max=${prof.max.toFixed(4)} mean=${prof.mean.toFixed(4)}`);
    console.log(`proposed anchors: ${JSON.stringify(proposed.anchors)}`);
    console.log(`my-call quantile map: ${JSON.stringify(myCallQuantile)}`);
  } finally {
    await fetch(`${CDP}/json/close/${target.id}`).catch(() => {});
    ws.close();
  }
}

main().catch((err) => {
  console.error('CALIBRATION FAILED:', err);
  process.exitCode = 1;
});
