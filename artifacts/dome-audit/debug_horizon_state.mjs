/** Debug: read the dome-horizon mesh's live geometry + handles state in the page. */
import fs from 'node:fs';
import path from 'node:path';

const CDP = 'http://127.0.0.1:9222';
const BASE = process.env.BASE ?? 'http://[::1]:5173/';
const POSE = 'pos=0,60,-300';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newTab(url) {
  const res = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`newTab ${res.status}: ${await res.text()}`);
  return res.json();
}

class Session {
  constructor(target) { this.target = target; this.nextId = 1; this.pending = new Map(); }
  async open() {
    this.ws = new WebSocket(this.target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Emulation.setDeviceMetricsOverride', { width: 1384, height: 772, deviceScaleFactor: 1, mobile: false });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout ${method}`)); } }, 60000);
    });
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (res.exceptionDetails) throw new Error(`page eval: ${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description ?? ''}`);
    return res.result.value;
  }
  async close() { await fetch(`${CDP}/json/close/${this.target.id}`).catch(() => {}); this.ws.close(); }
}

const target = await newTab(`${BASE}?qa=frozen&${POSE}&dome=1`);
const s = new Session(target);
await s.open();
let ok = false;
for (let i = 0; i < 60 && !ok; i++) {
  ok = await s.eval(`return Boolean(window.__porco && window.__porco.qa && window.__porco.scene);`).catch(() => false);
  if (!ok) await sleep(500);
}
await sleep(6500); // boot fade
await s.eval(`window.__porco.qa.step(0, 1/60);`);
await s.eval(`
  for (let i = 0; i < 2; i++) { window.__porco.qa.stepFrame(0); await new Promise(r => requestAnimationFrame(r)); await new Promise(r => requestAnimationFrame(r)); }
`);

const info = await s.eval(`
  const scene = window.__porco.scene;
  const mesh = scene.getObjectByName('dome-horizon');
  if (!mesh) return { error: 'mesh not found' };
  const g = mesh.geometry;
  const pos = g.attributes.position.array;
  const col = g.attributes.color.array;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let maxA = 0;
  for (let i = 0; i < pos.length; i += 3) {
    minX = Math.min(minX, pos[i]); maxX = Math.max(maxX, pos[i]);
    minY = Math.min(minY, pos[i+1]); maxY = Math.max(maxY, pos[i+1]);
    minZ = Math.min(minZ, pos[i+2]); maxZ = Math.max(maxZ, pos[i+2]);
  }
  for (let i = 3; i < col.length; i += 4) maxA = Math.max(maxA, col[i]);
  const cam = window.__porco.camera ?? null;
  // camera world direction → yaw
  const d = new (Object.getPrototypeOf(cam.position).constructor ?? Object)(0,0,0);
  return {
    meshVisible: mesh.visible, renderOrder: mesh.renderOrder,
    parent: mesh.parent ? mesh.parent.type : null,
    sceneHasFog: Boolean(scene.fog),
    bbox: { minX, maxX, minY, maxY, minZ, maxZ },
    maxAlpha: maxA,
    camera: { pos: cam ? [cam.position.x, cam.position.y, cam.position.z] : null,
              dirHint: cam ? [cam.rotation.x, cam.rotation.y, cam.rotation.z] : null,
              fov: cam ? cam.fov : null },
    material: { transparent: mesh.material.transparent, fog: mesh.material.fog, mapSet: Boolean(mesh.material.map), vc: mesh.material.vertexColors, side: mesh.material.side },
    drawRange: { start: g.drawRange.start, count: g.drawRange.count },
  };
`);
console.log(JSON.stringify(info, null, 1));
await s.close();
