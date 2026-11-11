/** Task 9 perf gate (proxy): live page, frameStats after settle, high then low. */
import fs from 'node:fs';
import path from 'node:path';

const CDP = 'http://127.0.0.1:9222';
const BASE = process.env.BASE ?? 'http://[::1]:5173/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newTab(url) {
  const res = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`newTab ${res.status}`);
  return res.json();
}

const target = await newTab(`${BASE}?pos=0,240,-300&dome=1`);
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
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}`)); } }, 60000);
});
const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(`page eval: ${res.exceptionDetails.text}`);
  return res.result.value;
};
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1384, height: 772, deviceScaleFactor: 1, mobile: false });

// wait for boot
const t0 = Date.now();
while (Date.now() - t0 < 90000) {
  const ok = await evaluate(`return Boolean(window.__porco && window.__porco.qa && window.__porco.scene);`).catch(() => false);
  if (ok) break;
  await sleep(500);
}
// high: assert boot tier, settle 12 s live, read stats
const qh = await evaluate(`return window.__porco.scene ? window.__porco.qa.describe().quality : null;`).catch(() => null);
console.log('QUALITY_BOOT', JSON.stringify(qh));
await evaluate(`window.__porco.qa.setQuality(true);`);
await sleep(12000);
const high = await evaluate(`return window.__porco.qa.frameStats();`);
console.log('HIGH', JSON.stringify(high));
// low: switch tier, assert, settle 12 s, read stats
await evaluate(`window.__porco.qa.setQuality(false);`);
const q = await evaluate(`return window.__porco.scene ? window.__porco.qa.describe().quality : null;`).catch(() => null);
console.log('QUALITY_AFTER_SWITCH', JSON.stringify(q));
await sleep(12000);
const low = await evaluate(`return window.__porco.qa.frameStats();`);
console.log('LOW', JSON.stringify(low));
await fetch(`${CDP}/json/close/${target.id}`).catch(() => {});
ws.close();
