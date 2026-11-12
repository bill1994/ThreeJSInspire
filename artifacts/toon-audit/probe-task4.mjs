/**
 * Toon-look-toggle Phase 1 Task 4 — one-off probe: cross-session pixel diff of the
 * ?toon=0 frames vs the Task 0 baseline (expected: the Task 1 root-caused isolated
 * ±1/255 GPU jitter signature, byte-compare is not the instrument — Task 2 §门1),
 * the ?toon=1 horizon-low expected-change evidence (palette hardening reaching the
 * puff + dome-cloud + dome-horizon deck/patch consumers), and the exportColorState
 * repro round-trip (URL with &toon= replays the same toonAmount; qa.setToon live
 * lever bumps the palette in the same session).
 *
 * Method notes:
 *   - PNG decode in-page (CDP), canvas rect crop x[475,909) y[0,772) = 434x772
 *     (capture sidecar canvas), same as analyze-task3-dome.mjs.
 *   - UI exclusion rects NOT needed here: the toon=0 pair differs only by GPU
 *     jitter (sky pixels), the toon=1 pair is a count-only expected-change record.
 *   - Repro round-trip: load ?toon=0.35, read qa.exportColorState() (URL line +
 *     .toon field), open THAT repro URL in a fresh tab, read back .toon; then
 *     qa.setToon(1) live → step → .toon === 1 and repro carries qa.setToon(1.0000).
 *
 * Env: CDP, BASE, OUT (default ab-evidence-task4).
 */
import fs from 'node:fs';
import path from 'node:path';

const CDP = process.env.CDP ?? 'http://127.0.0.1:9222';
const BASE = process.env.BASE ?? 'http://[::1]:5173/';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const OUT = path.join(HERE, process.env.OUT ?? 'ab-evidence-task4');
const POSES = ['baseline-ref-level', 'baseline-horizon-low', 'baseline-night-sun12-8'];

fs.mkdirSync(OUT, { recursive: true });
const b64 = (file) => fs.readFileSync(file).toString('base64');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function newTab(url) {
  const res = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`newTab ${res.status}: ${await res.text()}`);
  return res.json();
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
    // horizon band rows [yA,yB): where the dome-horizon deck/patch ring lives
    diffBand: (a, b, yA, yB) => {
      const x = window.__pix[a], y = window.__pix[b];
      let diffPixels = 0, sum = 0, maxDelta = 0;
      for (let row = yA; row < yB; row++) for (let col = 0; col < 434; col++) {
        const i = (row * 434 + col) * 4;
        let changed = false;
        for (let ch = 0; ch < 3; ch++) {
          const d = Math.abs(x[i + ch] - y[i + ch]);
          if (d > 0) { changed = true; sum += d; if (d > maxDelta) maxDelta = d; }
        }
        if (changed) diffPixels++;
      }
      return { bandPixels: (yB - yA) * 434, diffPixels, maxDelta, meanDelta: diffPixels ? sum / diffPixels : 0 };
    },
  };
  return 'api-ready';
`;

async function main() {
  const result = { protocol: { cdp: CDP, base: BASE, canvasRect: [475, 0, 434, 772] }, toon0VsBaseline: {}, toon1Evidence: {}, reproRoundTrip: {} };

  // ---- part 1: pixel diffs ----------------------------------------------------------
  const target = await newTab(`${BASE}?qa=frozen`);
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
    if (res.exceptionDetails) throw new Error(`page eval: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    return res.result.value;
  };
  try {
    await send('Runtime.enable');
    await send('Page.enable');
    await sleep(1000);
    if ((await evalInPage(DIFF_API)) !== 'api-ready') throw new Error('api install failed');

    for (const pose of POSES) {
      await evalInPage(`return window.__api.load('toon0', '${b64(path.join(HERE, 'task4-toon0', pose + '.png'))}');`);
      await evalInPage(`return window.__api.load('base', '${b64(path.join(HERE, 'baseline', pose + '.png'))}');`);
      const d = await evalInPage(`return window.__api.diff('toon0', 'base');`);
      result.toon0VsBaseline[pose] = d;
      console.log(`[toon0 vs Task0-baseline] ${pose}: ${d.diffPixels} px, maxDelta=${d.maxDelta}${d.diffPixels ? ' ' + JSON.stringify(d.samples.slice(0, 3)) : ''}`);
    }

    // ---- toon1 expected-change evidence (horizon-low) ------------------------------
    await evalInPage(`return window.__api.load('toon1', '${b64(path.join(HERE, 'task4-toon1', 'baseline-horizon-low.png'))}');`);
    await evalInPage(`return window.__api.load('toon0hl', '${b64(path.join(HERE, 'task4-toon0', 'baseline-horizon-low.png'))}');`);
    const full = await evalInPage(`return window.__api.diff('toon1', 'toon0hl');`);
    // horizon deck/patch band: horizon-low camera (y=60, pitch 0) puts the horizon near mid-frame
    const band = await evalInPage(`return window.__api.diffBand('toon1', 'toon0hl', 340, 440);`);
    const skyBand = await evalInPage(`return window.__api.diffBand('toon1', 'toon0hl', 40, 200);`);
    result.toon1Evidence = { fullCanvas: full, horizonBand340to440: band, upperSkyBand40to200: skyBand };
    console.log(`[toon1 vs toon0 horizon-low] full: ${full.diffPixels} px (maxDelta=${full.maxDelta}) | horizon band y[340,440): ${band.diffPixels}/${band.bandPixels} px (maxDelta=${band.maxDelta}) | upper sky y[40,200): ${skyBand.diffPixels}/${skyBand.bandPixels} px (maxDelta=${skyBand.maxDelta})`);
  } finally {
    await fetch(`${CDP}/json/close/${target.id}`).catch(() => {});
    ws.close();
  }

  // ---- part 2: repro round-trip -----------------------------------------------------
  const rt = {};
  const probeTab = await newTab(`${BASE}?toon=0.35&qa=frozen&pos=0,60,-300`);
  const ws2 = new WebSocket(probeTab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws2.onopen = resolve; ws2.onerror = reject; });
  const pending2 = new Map();
  let nextId2 = 1;
  ws2.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending2.has(msg.id)) {
      const { resolve, reject } = pending2.get(msg.id);
      pending2.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };
  const send2 = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId2++;
      pending2.set(id, { resolve, reject });
      ws2.send(JSON.stringify({ id, method, params }));
      setTimeout(() => reject(new Error(`timeout ${method}`)), 120000);
    });
  const eval2 = async (expression) => {
    const res = await send2('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) throw new Error(`page eval: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    return res.result.value;
  };
  try {
    await send2('Runtime.enable');
    const t0 = Date.now();
    let ready = false;
    while (Date.now() - t0 < 90000 && !ready) {
      ready = await eval2(`return Boolean(window.__porco && window.__porco.qa && window.__porco.qa.frozen);`).catch(() => false);
      if (!ready) await sleep(500);
    }
    if (!ready) throw new Error('toon=0.35 probe boot timeout');
    const exported = await eval2(`return JSON.stringify(window.__porco.qa.exportColorState());`);
    const state1 = JSON.parse(exported);
    rt.sourceToon = state1.toon;
    rt.repro = state1.repro;
    const urlLine = state1.repro.split('\n')[0];
    rt.urlHasToon = /&toon=0\.3500$/.test(urlLine);
    rt.consoleHasSetToon = state1.repro.split('\n')[1].includes('qa.setToon(0.3500)');
    console.log(`[repro source] toon=${state1.toon} urlHasToon=${rt.urlHasToon} consoleHasSetToon=${rt.consoleHasSetToon}`);

    // replay: fresh tab on the repro URL line
    const replayTab = await newTab(`${BASE}${urlLine}`);
    const ws3 = new WebSocket(replayTab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws3.onopen = resolve; ws3.onerror = reject; });
    const pending3 = new Map();
    let nextId3 = 1;
    ws3.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending3.has(msg.id)) {
        const { resolve, reject } = pending3.get(msg.id);
        pending3.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    const send3 = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId3++;
        pending3.set(id, { resolve, reject });
        ws3.send(JSON.stringify({ id, method, params }));
        setTimeout(() => reject(new Error(`timeout ${method}`)), 120000);
      });
    const eval3 = async (expression) => {
      const res = await send3('Runtime.evaluate', {
        expression: `(async () => { ${expression} })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (res.exceptionDetails) throw new Error(`page eval: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
      return res.result.value;
    };
    try {
      await send3('Runtime.enable');
      const t1 = Date.now();
      let ready3 = false;
      while (Date.now() - t1 < 90000 && !ready3) {
        ready3 = await eval3(`return Boolean(window.__porco && window.__porco.qa);`).catch(() => false);
        if (!ready3) await sleep(500);
      }
      if (!ready3) throw new Error('replay boot timeout');
      const replayState = JSON.parse(await eval3(`return JSON.stringify(window.__porco.qa.exportColorState());`));
      rt.replayedToon = replayState.toon;
      rt.roundTripOk = replayState.toon === state1.toon;
      console.log(`[repro replay] toon=${replayState.toon} roundTripOk=${rt.roundTripOk}`);
    } finally {
      await fetch(`${CDP}/json/close/${replayTab.id}`).catch(() => {});
      ws3.close();
    }

    // live lever: qa.setToon(1) → version bump → next syncSun re-fans the palette
    await eval2(`window.__porco.qa.setToon(1); window.__porco.qa.step(3, 1/60); return true;`);
    const live = JSON.parse(await eval2(`return JSON.stringify(window.__porco.qa.exportColorState());`));
    rt.liveSetToon = live.toon;
    rt.liveReproHasSetToon = live.repro.split('\n')[1].includes('qa.setToon(1.0000)');
    console.log(`[live setToon(1)] toon=${live.toon} reproHasSetToon=${rt.liveReproHasSetToon}`);
  } finally {
    await fetch(`${CDP}/json/close/${probeTab.id}`).catch(() => {});
    ws2.close();
  }

  result.reproRoundTrip = rt;
  fs.writeFileSync(path.join(OUT, 'probe-task4.json'), JSON.stringify(result, null, 2));
  console.log(`[ok] probe-task4.json -> ${OUT}`);
}

main().catch((err) => {
  console.error('PROBE FAILED:', err);
  process.exitCode = 1;
});
