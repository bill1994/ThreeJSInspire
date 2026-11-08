/** Fixed-camera pair: same viewpoint, two sea times. Is the wave field visibly moving? */
import fs from 'node:fs';
import path from 'node:path';

const CDP = 'http://127.0.0.1:9222';
const OUT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tab(url) {
  const r = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  return r.json();
}

async function run(name, extraSteps) {
  const target = await tab('http://127.0.0.1:5190/?alt=20&qa=frozen&post=0&puff=0');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 1;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const i = id++; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async (expression) => (await send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true,
  })).result?.value;

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 720, height: 1280, deviceScaleFactor: 1, mobile: false });
  for (let i = 0; i < 120; i++) {
    if (await evaluate('return Boolean(window.__porco?.qa);').catch(() => false)) break;
    await sleep(500);
  }
  await evaluate(`
    document.querySelectorAll('.porco-hud').forEach(e => e.style.display = 'none');
    const b = document.querySelector('#boot-status'); if (b) b.style.display = 'none';
    const q = window.__porco;
    q.qa.step(180, 1/60);
    q.game.update = () => {};
    q.camera.position.set(0, 12, 40);
    q.camera.up.set(0, 1, 0);
    q.camera.lookAt(0, 0.5, -60);
    q.camera.updateProjectionMatrix();
    q.qa.step(${extraSteps}, 1/60);
    for (let i = 0; i < 2; i++) {
      q.qa.stepFrame(0);
      await new Promise(r => requestAnimationFrame(r));
      await new Promise(r => requestAnimationFrame(r));
    }
  `);
  const desc = await evaluate('return window.__porco.qa.describe();');
  const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(shot.data, 'base64'));
  console.log(JSON.stringify({ name, elapsed: desc.elapsed, plane: desc.plane, cam: desc.camera.pos }));
  await fetch(`${CDP}/json/close/${target.id}`).catch(() => {});
  ws.close();
}

await run('MOTION-t3', 0);
await run('MOTION-t5', 120);
