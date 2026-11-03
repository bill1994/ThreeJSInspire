/**
 * Minimal CDP capture driver for the sea QA (plan 2026-11-03 Task 2/5).
 *
 * Why not the in-app browser pane: its WebGPU canvas never reaches the
 * compositor (rAF suppressed, screenshots show the page background), so a
 * WebGPU app cannot be screenshotted there. This driver launches the local
 * Chromium/Edge headless (new mode = real compositor, rAF alive, WebGPU with
 * --enable-unsafe-webgpu) and talks raw CDP over Node's global WebSocket —
 * no dependencies.
 *
 * Usage:
 *   node artifacts/sea-audit/cdp-capture.mjs --url "http://localhost:5173/?alt=7&qa=frozen&sea=fbm" \
 *     --out artifacts/sea-audit/shot.png [--steps 180] [--eval <js-file>] [--wait 8]
 *
 * --eval: a JS file whose contents are evaluated in the page AFTER stepping
 * (awaitPromise, returnByValue); its JSON result is printed to stdout.
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const URL_TARGET = arg('url');
const OUT = arg('out');
const STEPS = Number(arg('steps', '180'));
const EVAL_FILE = arg('eval');
const WAIT_S = Number(arg('wait', '8'));
const BROWSER = arg('browser', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
const PORT = Number(arg('port', '9223'));

const profile = await mkdtemp(join(tmpdir(), 'sea-qa-'));
const proc = spawn(BROWSER, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-angle=default',
  '--window-size=1280,720',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error('devtools target not found');
}

const target = await findTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let seq = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
};
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 1280, height: 720, deviceScaleFactor: 1, mobile: false,
});
await send('Page.navigate', { url: URL_TARGET });
await sleep(WAIT_S * 1000);

// wait for the frozen QA hook + correct URL (porco recipe pitfall 1)
const search = URL_TARGET.includes('?') ? URL_TARGET.slice(URL_TARGET.indexOf('?')) : '';
const ready = await send('Runtime.evaluate', {
  expression: `(async () => {
    for (let i = 0; i < 100; i++) {
      const q = window.__porco && window.__porco.qa;
      if (q && window.location.search === '${search}') {
        return true;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  })()`,
  awaitPromise: true,
  returnByValue: true,
});
if (ready.result.value !== true) throw new Error('qa hook never became ready');

// hide the HUD (capture protocol rule 4)
await send('Runtime.evaluate', {
  expression: `document.querySelectorAll('.porco-hud').forEach((el) => (el.style.display = 'none'))`,
});

// advance the frozen world (each stepFrame renders; post.render presents)
await send('Runtime.evaluate', {
  expression: `window.__porco.qa.step(${STEPS}, 1/60)`,
  returnByValue: true,
});
// two present rounds (capture protocol: a single present can be a blank frame)
await send('Runtime.evaluate', {
  expression: `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`,
  awaitPromise: true,
});
await send('Runtime.evaluate', {
  expression: `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`,
  awaitPromise: true,
});

let evalResult = null;
if (EVAL_FILE) {
  const expr = await readFile(EVAL_FILE, 'utf8');
  const res = await send('Runtime.evaluate', {
    expression: `(async () => { ${expr} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  evalResult = res.result?.value ?? null;
  if (res.exceptionDetails) {
    evalResult = { exception: res.exceptionDetails.exception?.description ?? 'unknown' };
  }
}

const shot = await send('Page.captureScreenshot', { format: 'png' });
await writeFile(OUT, Buffer.from(shot.data, 'base64'));

console.log(JSON.stringify({ out: OUT, steps: STEPS, evalResult, bytes: Buffer.byteLength(shot.data, 'base64') }));
ws.close();
proc.kill();
process.exit(0);
