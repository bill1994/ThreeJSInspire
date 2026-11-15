// scratch 截图器（不进 src/，也不进 scripts/）：只做「钉视口 → 导航 frozen → 藏 HUD →
// 截图」这一件事，给 Task 5 的分量隔离实验当眼睛用。探针一次要 60-100 s（4 帧差分 +
// 26 个量），这里 15-20 s 就能出一张同机位的原图，改一行 shader 看一眼就够。
//
//   node artifacts/cloud-probe/scratch/shot.mjs <out.png> [extraQuery]
//
// extraQuery 形如 "&toon=0"，原样拼到 URL 末尾。
import { writeFileSync } from 'node:fs';

const CDP = process.env.CLOUD_PROBE_CDP || 'http://127.0.0.1:9333';
const OUT = process.argv[2] || 'artifacts/cloud-probe/scratch/shot.png';
const EXTRA = process.argv[3] || '';
const URL_APP = `http://localhost:5173/?qa=frozen&puff=0${EXTRA}`;
const VIEWPORT = { width: 448, height: 797, deviceScaleFactor: 1, mobile: false };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pageWs() {
  const list = await (await fetch(`${CDP}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no page target');
  return page.webSocketDebuggerUrl;
}

const ws = new WebSocket(await pageWs());
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = (e) => rej(new Error(`ws error ${e?.message ?? ''}`));
});
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(`${msg.error.message} ${msg.error.data ?? ''}`)) : res(msg.result);
  }
};
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', VIEWPORT);
await send('Page.navigate', { url: URL_APP });
// 等 qa 门面就绪（WebGPU 初始化 + 首帧）——固定 sleep 不够可靠。
for (let i = 0; i < 40; i += 1) {
  const ready = await send('Runtime.evaluate', {
    expression: `!!(window.__porco && window.__porco.qa && window.__porco.qa.step)`,
    returnByValue: true,
  });
  if (ready.result.value) break;
  await sleep(250);
}
// ---- 转向（从 cloud-probe.mjs 复制的脉冲舵，scratch 工具允许重复） ----
const DEADZONE_PX = 4;
const STEER_RADIUS_PX = 120;
const HEADING_TOL_DEG = 1.0;
const TURN_SETTLE_STEPS = 60;
const STEP_DT = 1 / 60;

const wrap180 = (deg) => { let d = deg % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d; };

function cameraAzFn() {
  const c = window.__porco.camera;
  const e = c.matrixWorld.elements;
  const az = (Math.atan2(-e[8], e[10]) * 180) / Math.PI;
  return ((az % 360) + 360) % 360;
}

async function evalPage(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`page eval failed: ${r.exceptionDetails.text}`);
  return r.result.value;
}

const qaStep = (n) => evalPage(`window.__porco.qa.step(${n}, ${STEP_DT}); 'ok';`);

async function canvasCenter() {
  const r = await evalPage(`(() => { const r = document.querySelector('#frame canvas').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  return { cx: r.x + r.w / 2, cy: r.y + r.h / 2 };
}

async function steer(center, s) {
  const mag = Math.min(1, Math.abs(s));
  const px = mag <= 0 ? 0 : DEADZONE_PX + mag * (STEER_RADIUS_PX - DEADZONE_PX);
  const dx = s < 0 ? -px : px;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: center.cx, y: center.cy, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.cx + dx, y: center.cy, button: 'left', buttons: 1, pointerType: 'mouse' });
}

async function releaseSteer(center) {
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: center.cx, y: center.cy, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
}

async function turnToAz(center, targetDeg) {
  for (let i = 0; i < 300; i += 1) {
    const az = await evalPage(`(${cameraAzFn.toString()})()`);
    const err = wrap180(targetDeg - az);
    if (Math.abs(err) <= HEADING_TOL_DEG) {
      await qaStep(TURN_SETTLE_STEPS);
      const az2 = await evalPage(`(${cameraAzFn.toString()})()`);
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
// 协议同探针：先步进 300 帧让相机 rig 暂态收敛，再真步进 2 帧重渲染（绝不能用 dt=0）。
await qaStep(300);
await evalPage(`(() => { const els = document.querySelectorAll('#frame .porco-hud');
  for (const el of els) el.style.visibility = 'hidden'; return els.length; })()`);
// 可选第三参：目标朝向（度）。给 197 就和探针 A/B 同一机位，不给就保持出生朝向。
const HEADING = process.argv[4] ? Number(process.argv[4]) : null;
if (HEADING !== null) {
  const az = await turnToAz(await canvasCenter(), HEADING);
  console.log(`heading -> az=${az.toFixed(2)}°`);
}
await qaStep(2);
await sleep(300);
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log(`shot -> ${OUT} (${URL_APP})`);
ws.close();

