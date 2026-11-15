// Task 5 交叉检查用抓图器（scratch，不入库）。相对 shot.mjs 只加三件事：
//   1. 导航后等 __porco 真正就绪，最多 40 s，并打印进度/页面异常；
//   2. 把 CDP 的 exceptionThrown / console 错误打出来（shot.mjs 只报 "Uncaught"）；
//   3. 就绪探活失败时给出页面真实状态，而不是在旧 execution context 上调 step。
//
//   node artifacts/cloud-probe/scratch/shot2.mjs <out.png> [extraQuery] [heading]
//
// extraQuery 形如 "&toon=1"；heading 给 197 即与探针 A/B 同一机位。
import { writeFileSync } from 'node:fs';

const CDP = process.env.CLOUD_PROBE_CDP || 'http://127.0.0.1:9333';
const OUT = process.argv[2] || 'artifacts/cloud-probe/scratch/shot2.png';
const EXTRA = process.argv[3] || '';
const HEADING = process.argv[4] ? Number(process.argv[4]) : null;
const URL_APP = `http://localhost:5173/?qa=frozen&puff=0${EXTRA}`;
const VIEWPORT = { width: 448, height: 797, deviceScaleFactor: 1, mobile: false };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`${CDP}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) throw new Error('no page target');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const pending = new Map();
const logs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res } = pending.get(m.id);
    pending.delete(m.id);
    res(m);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push(`EXCEPTION ${m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text ?? ''}`.slice(0, 400));
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
    logs.push(`CONSOLE ${(m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')}`.slice(0, 400));
  }
};
const send = (method, params = {}) => new Promise((res) => {
  const id = ++seq;
  pending.set(id, { res });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) {
    const d = r.result.exceptionDetails;
    throw new Error(`page eval failed: ${d.exception?.description ?? d.text ?? 'unknown'}`.slice(0, 800));
  }
  return r.result?.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', VIEWPORT);
let originBefore = null;
try { originBefore = await evaluate('performance.timeOrigin'); } catch { /* old context */ }
await send('Page.navigate', { url: URL_APP });

// 导航竞态：Page.navigate 返回后旧 execution context 可能仍活着，__porco 还是
// 上一版页面 —— 那样抓到的是旧 shader 的帧，A/B 全废。必须等 timeOrigin 变化
// （真重载）才认就绪。
let ready = false;
for (let i = 0; i < 160; i += 1) {
  try {
    const o = await evaluate('performance.timeOrigin');
    const fresh = o !== null && o !== originBefore;
    if (fresh && await evaluate('!!(window.__porco && window.__porco.qa && window.__porco.qa.step && window.__porco.world)')) {
      ready = true;
      break;
    }
  } catch {
    // navigation tears down the old execution context; retry
  }
  if (i % 20 === 0) console.log(`[wait] ${(i * 0.25).toFixed(1)}s ...`);
  await sleep(250);
}
if (!ready) {
  const state = await evaluate('({url:location.href, ready:document.readyState, porco:!!window.__porco, qa:!!window.__porco?.qa})').catch((e) => e.message);
  console.error('[shot2] NOT READY', JSON.stringify(state));
  console.error(logs.slice(-12).join('\n'));
  ws.close();
  process.exit(1);
}
console.log('[shot2] ready');

const DEADZONE_PX = 4;
const STEER_RADIUS_PX = 120;
const HEADING_TOL_DEG = 1.0;
const wrap180 = (deg) => { let d = deg % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d; };
const cameraAz = '(() => { const e = window.__porco.camera.matrixWorld.elements; const az = Math.atan2(-e[8], e[10]) * 180 / Math.PI; return ((az % 360) + 360) % 360; })()';
const qaStep = (n) => evaluate(`window.__porco.qa.step(${n}, 1/60); 'ok'`);

async function canvasCenter() {
  const r = await evaluate(`(() => { const r = document.querySelector('#frame canvas').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  return r;
}
async function steer(center, s) {
  const mag = Math.min(1, Math.abs(s));
  const dx = (s < 0 ? -1 : 1) * (mag <= 0 ? 0 : DEADZONE_PX + mag * (STEER_RADIUS_PX - DEADZONE_PX));
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: center.x, y: center.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x + dx, y: center.y, button: 'left', buttons: 1, pointerType: 'mouse' });
}
async function releaseSteer(center) {
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: center.x, y: center.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
}
async function turnToAz(center, targetDeg) {
  for (let i = 0; i < 300; i += 1) {
    const az = await evaluate(cameraAz);
    const err = wrap180(targetDeg - az);
    if (Math.abs(err) <= HEADING_TOL_DEG) {
      await qaStep(60);
      const az2 = await evaluate(cameraAz);
      if (Math.abs(wrap180(targetDeg - az2)) <= HEADING_TOL_DEG) return az2;
      continue;
    }
    const strength = Math.min(1, Math.max(0.15, Math.abs(err) / 8));
    await steer(center, err > 0 ? strength : -strength);
    await qaStep(1);
    await releaseSteer(center);
    await qaStep(5);
  }
  throw new Error(`turnToAz(${targetDeg}) did not converge`);
}

// 无 heading 时不需要 300 帧 rig 收敛；连渲 300 帧会把 GPU 打进坏状态（纯橙清屏）。
await qaStep(HEADING !== null ? 300 : 3);
await evaluate(`(() => { const els = document.querySelectorAll('#frame .porco-hud');
  for (const el of els) el.style.visibility = 'hidden'; return els.length; })()`);
if (HEADING !== null) {
  const az = await turnToAz(await canvasCenter(), HEADING);
  console.log(`[shot2] heading -> az=${az.toFixed(2)}°`);
}
await qaStep(2);
await sleep(300);
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
if (shot.error) throw new Error(`captureScreenshot failed: ${JSON.stringify(shot.error)}`);
if (!shot.result?.data) throw new Error('captureScreenshot returned no data');
writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
console.log(`[shot2] -> ${OUT} (${URL_APP})`);
if (logs.length) console.log(`[shot2] page logs (${logs.length}):\n${logs.slice(-8).join('\n')}`);
ws.close();
