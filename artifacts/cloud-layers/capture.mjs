/**
 * cloud-layer-reduction Task 9 — two-layer capture matrix + acceptance gates.
 *
 * Captures the FULL Task 9 matrix in one run against the established protocol
 * (toon-audit/capture-toon-matrix.mjs + dome-audit/capture_p15_*.mjs lineage):
 *
 *   CDP      http://127.0.0.1:9222 — HEADED Chrome (headless has no WebGPU adapter),
 *            launched with --disable-features=CalculateNativeWinOcclusion
 *            (born-occluded windows stall rAF; bringToFront does NOT clear it).
 *   BASE     http://[::1]:5173/ — vite binds IPv6-only, the literal is mandatory.
 *   frozen   ?qa=frozen + qa.step(N, 1/60) + 2x(qa.stepFrame(0) + 2 rAF) present,
 *            boot-status fade waited out first, WebGPU backend asserted per frame.
 *   viewport 1384x772, DPR 1.
 *   shot     Page.captureScreenshot, retry on timeout / <150KB partial frame.
 *
 * Matrix (plan Task 9 Step 1 + design §8; gates judged OFFLINE by inspection):
 *   A tod x layers (12) — default(6.97°) / ?tod=12 / ?tod=17.5 / ?tod=23,
 *     each with base / ?puff=0 / ?bg=0 (tod12+bg0 IS the design §6 isolation frame).
 *   B 360° sweep (16)   — REAL FLIGHT: CDP pointer-drag steering turns the
 *     plane a full right circle with a capture stop every ~45° (8 legs).
 *     Frame names carry the LEG, sidecars carry the ACTUAL settled heading
 *     (approximate — real flight, not a rotary stage). 8 frames both-layers +
 *     8 frames ?puff=0 (bg-only counting aid for the 8-14 gate).
 *   C alt pair (2)      — ?alt=10 (low band) + ?alt=240 (ALT_MAX).
 *   D through-cloud probe — two series in ONE tab (blob layout is plane-
 *     anchored): `probe/through-*` default cruise 0..3600 every 600 (negative
 *     evidence: veil must not leak in open air); `probe/intercept-*` game
 *     .setPose 40 m before the fattest blob's front surface on its own (x,y),
 *     probe every 10 steps for 240 — entry ramp = gate 4, interior peak =
 *     gate 2 三件套. .porco-whiteout opacity + plane pose logged per probe.
 *   E perf (3 segments, UNFROZEN) — render-perf-pass1 口径 discipline (§1.1):
 *     real rAF animation loop (frozen mode pushes fixed dt, not frame time),
 *     document.hasFocus()===true + describe().quality==='high' asserted before
 *     AND after each segment (failed assertion voids the segment), ring filled
 *     (>600 frames), then qa.frameStats() p50/p95. Segments: all-on / ?puff=0 /
 *     ?bg=0 in one Chrome session; renderer.info draw calls recorded for
 *     attribution. Gate: p95(all-on) <= 27.9 (2026-11-12 baseline).
 *
 * Outputs (under artifacts/cloud-layers/):
 *   matrix/<name>.png + .json sidecar per frame
 *     (sidecar: {url, query, group, frames, stepDt, present, heading?, viewport,
 *      deviceScaleFactor, pngBytes, sha256, elapsed, desc, logs})
 *   matrix/probe/through-XXXX.png + .json  (group D series)
 *   matrix/perf/<name>.json (group E, no PNG — frame-time evidence is numeric)
 *   matrix/capture-matrix.json — protocol + inventory + per-gate numeric records.
 *
 * Env: BASE, OUT_ROOT, ONLY (comma group subset: A,B,C,D,E), CRUISE_FRAMES.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CDP = 'http://127.0.0.1:9222';
const BASE = process.env.BASE ?? 'http://[::1]:5173/';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = process.env.OUT_ROOT ?? path.join(HERE, 'matrix');
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const VIEW_W = 1384;
const VIEW_H = 772;
// Broken-frame heuristic: a torn/partial capture varies between attempts or is
// structurally tiny. Night frames ~125 KB, in-cloud white frames shrink
// monotonically with depth (81 KB edge, 40 KB interior, <10 KB deep interior) —
// a byte floor CANNOT separate them from breakage. So: hard floor 8 KB (PNG
// structure sanity), plus an acceptance rule for flat frames: 3 attempts of
// IDENTICAL size = deterministic flat frame, accepted with a note.
const MIN_BYTES = 8 * 1024;
const STEP_DT = 1 / 60;
const CRUISE_FRAMES = Number(process.env.CRUISE_FRAMES ?? 600); // A-cruise: elapsed 10, plane [0,60,-460]
const PROBE_STEP = 150;
const PROBE_MAX = 3600;
const PERF_FILL_MS = 25000; // ~1200 frames at 48 fps — the 600-sample ring is fully stale-free

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newTab(url) {
  const res = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`newTab ${res.status}: ${await res.text()}`);
  return res.json();
}

class Session {
  constructor(target) {
    this.target = target;
    this.logs = [];
    this.nextId = 1;
    this.pending = new Map();
  }

  async open() {
    this.ws = new WebSocket(this.target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (!msg.id && (msg.method === 'Runtime.consoleAPICalled' || msg.method === 'Runtime.exceptionThrown')) {
        const p = msg.params;
        const text = p.type === 'warn' || p.type === 'error'
          ? `[${p.type}] ${(p.args || []).map((a) => a.value ?? a.description ?? '').join(' ')}`
          : p.exceptionDetails
            ? `[exception] ${p.exceptionDetails.text} ${p.exceptionDetails.exception?.description ?? ''}`
            : '';
        if (text) this.logs.push(text);
      }
    };
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    // ENV CONTRACT: capture Chrome must be launched with
    // --disable-features=CalculateNativeWinOcclusion — see file header.
    await this.send('Page.bringToFront');
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1, mobile: false,
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout ${method}`));
        }
      }, 120000);
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`page eval: ${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description ?? ''}`);
    }
    return res.result.value;
  }

  /** Ready means: qa hook alive on THIS page and the URL is exactly the pose we asked for. */
  async waitBoot(qs, { frozen = true, timeoutMs = 90000 } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const ready = await this.eval(`
        return Boolean(window.__porco && window.__porco.qa && window.__porco.scene)
          && ${frozen ? 'window.__porco.qa.frozen === true' : 'true'}
          && location.href.includes('${qs}');
      `).catch(() => false);
      if (ready) return true;
      await sleep(500);
    }
    return false;
  }

  /** Wall-clock determinism: wait out the 6s boot-status fade (+.6s transition). */
  async waitBootStatusFade(timeoutMs = 30000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const opacity = await this.eval(`
        const b = document.querySelector('#boot-status');
        return b ? getComputedStyle(b).opacity : 'gone';
      `).catch(() => null);
      if (opacity === '0' || opacity === 'gone') return opacity;
      await sleep(500);
    }
    return 'timeout';
  }

  async shotBytes() {
    const attempts = [];
    for (let i = 1; i <= 3; i++) {
      const res = await this.send('Page.captureScreenshot', {
        format: 'png', fromSurface: true, captureBeyondViewport: false,
      });
      const buf = Buffer.from(res.data, 'base64');
      if (buf.length >= MIN_BYTES) return buf;
      attempts.push(buf);
      console.log(`[shot attempt ${i}] ${buf.length} bytes (< ${MIN_BYTES} floor)`);
      await sleep(500);
    }
    const allSame = attempts.every((b) => b.length === attempts[0].length);
    if (allSame && attempts[0].length > 0) {
      console.log(`[shot] accepted flat frame: 3 identical attempts at ${attempts[0].length} bytes (deterministic, in-cloud/white candidate)`);
      return attempts[0];
    }
    throw new Error(`screenshot failed: sizes ${attempts.map((b) => b.length).join(',')} — varying tiny frames look broken`);
  }

  /** Focus probe for the perf segments (render-perf-pass1 口径纪律). */
  async focusState() {
    return this.eval(`
      return { hasFocus: document.hasFocus(), visibility: document.visibilityState };
    `);
  }

  async close() {
    await fetch(`${CDP}/json/close/${this.target.id}`).catch(() => {});
    this.ws.close();
  }
}

const PRESENT = `
  for (let i = 0; i < 2; i++) {
    window.__porco.qa.stepFrame(0);
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => requestAnimationFrame(r));
  }
`;

const DESCRIBE = `
  const q = window.__porco;
  const d = q.qa.describe();
  const whiteout = document.querySelector('.porco-whiteout');
  const boot = document.querySelector('#boot-status');
  return {
    ...d,
    whiteoutOpacity: whiteout ? whiteout.style.opacity : null,
    bootStatusOpacity: boot ? getComputedStyle(boot).opacity : null,
    gpu: Boolean(navigator.gpu),
    backend: q.renderer?.backend?.isWebGPUBackend === true ? 'webgpu' : 'other',
    postReady: Boolean(q.post),
  };
`;

/**
 * REAL-FLIGHT heading sweep. Two out-of-band protocols were tried and REJECTED
 * with in-page evidence (see task-9 report):
 *   v1 cold camera rotate   — bins never saw the new heading, wedge empty.
 *   v2 force+stepFrame hold — bins rebuilt (horizonCount 14->13, quad positions
 *     at the target azimuth, alpha 0.6-0.8) AND the camera provably sat at the
 *     target (rAF HUD self-report), yet the presented canvas stayed on the last
 *     RIG-rendered frame: the pipeline's out-of-band render is not reliable for
 *     capture here.
 * v3 (this): CDP-dispatched POINTER DRAG drives the real steering action
 *   (input.ts: drag-relative, full deflection at 120 px), the flight model
 *   banks and turns (TURN_RATE 1.25 rad/s = 71.6 deg/s at full bank), the rig
 *   follows, the bin sliding window spawns+fades wedges exactly as designed
 *   ("满舵 71.6°/s 下新楔形离视轴 ≥30°，0.17 s > 0.15 s"), and the frame is
 *   rendered by the NORMAL stepFrame path after the bank levels out. Every
 *   pixel of the sweep frame comes from real play. Headings are therefore
 *   approximate (recorded per frame in the sidecar as actualHeadingDeg).
 */
const STEER_PX = 100; // ~0.8 deflection pulses (STEER_RADIUS_PX 120 = full) — coarse hold overshot badly (camera lag + bank unwind ≈ 2x nominal)
const CANVAS_CENTER = { x: 692, y: 386 }; // portrait canvas center in the 1384x772 viewport

const wrap180 = (d) => {
  let x = d;
  while (x > 180) x -= 360;
  while (x < -180) x += 360;
  return x;
};

async function readHeading(session) {
  const hd = await session.eval(`
    const cam = window.__porco.camera;
    cam.updateWorldMatrix(true, false);
    const e = cam.matrixWorld.elements;
    return Math.atan2(e[8], e[10]) * 180 / Math.PI;
  `);
  return wrap180(Number(hd));
}

/** dirPx > 0 = drag right = right turn = heading decreases (game.ts yaw convention). */
async function steerPulse(session, dirPx, holdFrames) {
  const { x, y } = CANVAS_CENTER;
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', pressed: true, clickCount: 1 });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + dirPx, y, button: 'left', pressed: true });
  await session.eval(`return window.__porco.qa.step(${holdFrames}, ${STEP_DT});`);
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dirPx, y, button: 'left', pressed: false, clickCount: 1 });
  await session.eval(`return window.__porco.qa.step(30, ${STEP_DT});`); // bank unwind + camera converge
}

/**
 * One real-turn leg: closed-loop pulses toward `targetDeg` (camera heading is
 * the feedback AND the bin-system read — self-consistent), then a final settle
 * for the wedge fade. Returns the ACTUAL settled heading (approximate: real
 * flight, not a rotary stage; tolerance ±5 deg, recorded in the sidecar).
 */
async function turnTo(session, targetDeg) {
  let hd = await readHeading(session);
  for (let i = 0; i < 25 && Math.abs(wrap180(hd - targetDeg)) > 5; i++) {
    const err = wrap180(targetDeg - hd); // >0 = need heading increase = left = drag left
    await steerPulse(session, err > 0 ? -STEER_PX : STEER_PX, 8);
    hd = await readHeading(session);
  }
  await session.eval(`return window.__porco.qa.step(20, ${STEP_DT});`);
  return readHeading(session);
}

/** Group B — 360° sweep, both-layers + puff0 counting aid, one tab per set. */
async function groupB(payload) {
  for (const twin of [{ key: '', qs: '' }, { key: 'puff0', qs: 'puff=0' }]) {
    const qs = ['qa=frozen', twin.qs].filter(Boolean).join('&');
    const session = await runFrozenPose(qs, CRUISE_FRAMES);
    try {
      // real 360° right turn, a stop every ~45°: 0 -> -45 -> ... -> -315 (≡ +45)
      let from = await readHeading(session);
      for (let leg = 1; leg <= 7; leg++) {
        const target = wrap180(from - 45);
        const actual = await turnTo(session, target);
        await session.eval(PRESENT);
        const name = `sweep${twin.key ? `-${twin.key}` : ''}-leg${String(leg).padStart(2, '0')}`;
        const sc = await captureFrame(session, name, {
          qs, group: 'B-sweep', frames: CRUISE_FRAMES,
          extra: {
            targetHeadingDeg: Number(target.toFixed(1)),
            actualHeadingDeg: Number(actual.toFixed(1)),
            headingMethod: 'real flight: CDP pointer-drag steering (full rudder), bank unwound, settled, normal stepFrame render — bin window spawns/fades wedges exactly as in play',
            layers: twin.key || 'both',
          },
        });
        payload.frames[name] = sc;
        from = actual;
      }
      // leg 8 (h000 equivalent): the sweep started there — capture it LAST so
      // every frame comes after at least one leg of flight
      const actual = await turnTo(session, wrap180(from - 45));
      await session.eval(PRESENT);
      const name = `sweep${twin.key ? `-${twin.key}` : ''}-leg08`;
      const sc = await captureFrame(session, name, {
        qs, group: 'B-sweep', frames: CRUISE_FRAMES,
        extra: {
          targetHeadingDeg: Number(wrap180(from - 45).toFixed(1)),
          actualHeadingDeg: Number(actual.toFixed(1)),
          headingMethod: 'real flight (see leg01)',
          layers: twin.key || 'both',
        },
      });
      payload.frames[name] = sc;
    } finally {
      await session.close().catch(() => {});
    }
  }
}

async function captureFrame(session, name, { qs, group, frames, extra = {} }) {
  const desc = await session.eval(DESCRIBE);
  if (desc.backend !== 'webgpu' || !desc.gpu) {
    throw new Error(`renderer fell back: backend=${desc.backend} gpu=${desc.gpu} — matrix frames must come from WebGPU`);
  }
  if (!desc.postReady) throw new Error('post pipeline missing — frame is not the shipped render path');
  const bytes = await session.shotBytes();
  const file = path.join(ROOT, `${name}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  const sidecar = {
    url: `${BASE}?${qs}`,
    query: qs,
    group,
    name,
    frames,
    stepDt: STEP_DT,
    present: `qa.step(${frames}, 1/60) + 2x(stepFrame(0) + 2x rAF)`,
    ...extra,
    viewport: [VIEW_W, VIEW_H],
    deviceScaleFactor: 1,
    pngBytes: bytes.length,
    sha256: sha256(bytes),
    elapsed: desc.elapsed,
    desc,
    logs: session.logs.slice(-12),
  };
  fs.writeFileSync(path.join(ROOT, `${name}.json`), JSON.stringify(sidecar, null, 2));
  console.log(`[ok] ${group}/${name}: ${bytes.length}B sha=${sidecar.sha256.slice(0, 12)}`);
  return sidecar;
}

async function runFrozenPose(qs, frames) {
  const target = await newTab(`${BASE}?${qs}`);
  const session = new Session(target);
  await session.open();
  try {
    const ok = await session.waitBoot(qs);
    if (!ok) throw new Error('boot timeout (or URL drifted)');
    await session.waitBootStatusFade();
    await session.eval(`
      window.__porco.qa.setQuality(true);
      return window.__porco.qa.step(${frames}, ${STEP_DT});
    `);
    await session.eval(PRESENT);
    return session;
  } catch (err) {
    await session.close().catch(() => {});
    throw err;
  }
}

/** Group A — tod x {base, puff0, bg0}. */
const TOD_POSES = [
  { tod: 'default', extra: '' },
  { tod: '12', extra: 'tod=12' },
  { tod: '17.5', extra: 'tod=17.5' },
  { tod: '23', extra: 'tod=23' },
];
const LAYER_TWINS = [
  { key: '', qs: '' },
  { key: 'puff0', qs: 'puff=0' },
  { key: 'bg0', qs: 'bg=0' },
];

async function groupA(payload) {
  const onlyTods = process.env.A_TODS ? new Set(process.env.A_TODS.split(',')) : null;
  for (const pose of TOD_POSES) {
    if (onlyTods && !onlyTods.has(pose.tod)) continue;
    for (const twin of LAYER_TWINS) {
      const qs = ['qa=frozen', pose.extra, twin.qs].filter(Boolean).join('&');
      const name = `tod-${pose.tod}${twin.key ? `-${twin.key}` : ''}`;
      const session = await runFrozenPose(qs, CRUISE_FRAMES);
      try {
        const sc = await captureFrame(session, name, {
          qs, group: 'A-tod', frames: CRUISE_FRAMES,
          extra: { tod: pose.tod, layers: twin.key || 'both', isolation: name === 'tod-12-bg0' },
        });
        payload.frames[name] = sc;
      } finally {
        await session.close().catch(() => {});
      }
    }
  }
}

/** Group C — alt pair. */
async function groupC(payload) {
  for (const alt of [{ name: 'alt-low', v: 10 }, { name: 'alt-high', v: 240 }]) {
    const qs = `qa=frozen&alt=${alt.v}`;
    const session = await runFrozenPose(qs, CRUISE_FRAMES);
    try {
      const sc = await captureFrame(session, alt.name, {
        qs, group: 'C-alt', frames: CRUISE_FRAMES,
        extra: { alt: alt.v },
      });
      payload.frames[alt.name] = sc;
    } finally {
      await session.close().catch(() => {});
    }
  }
}

/**
 * Group D — through-cloud probe series (gate 2 三件套 + gate 4 veil entry).
 *
 * Two series:
 *   cruise  — default spawn, 0..3600 steps every 600. Negative evidence: the
 *             veil must NOT leak during ordinary straight cruise (first run
 *             peaked at 0 over 60 s — recorded, kept at coarser granularity).
 *   intercept — SAME tab (blob layout is plane-anchored; a ?pos= respawn would
 *             re-scatter the field): query world.blobs, pick the fattest blob,
 *             game.setPose to 40 m before its front surface ON ITS OWN (x, y),
 *             then cruise straight through it, probing every 10 steps for 240.
 *             Entry ramp frames = gate 4 (VEIL_INNER band); interior peak =
 *             gate 2 三件套.
 */
async function groupD(payload) {
  const qs = 'qa=frozen';
  const session = await runFrozenPose(qs, 0);
  try {
    const cruise = [];
    for (let steps = 0; steps <= PROBE_MAX; steps += 600) {
      if (steps > 0) await session.eval(`return window.__porco.qa.step(600, ${STEP_DT});`);
      await session.eval(PRESENT);
      const name = `through-t${String(steps).padStart(4, '0')}`;
      const sc = await captureFrame(session, `probe/${name}`, {
        qs, group: 'D-probe', frames: steps,
        extra: { probeSteps: steps, simSeconds: Number((steps / 60).toFixed(2)), series: 'cruise' },
      });
      cruise.push({
        steps, simSeconds: Number((steps / 60).toFixed(2)),
        whiteoutOpacity: sc.desc.whiteoutOpacity, plane: sc.desc.plane, png: `probe/${name}.png`,
      });
      payload.frames[name] = sc;
    }
    const cruisePeak = Math.max(...cruise.map((s) => Number(s.whiteoutOpacity ?? 0)));
    console.log(`[probe] cruise series peak whiteout: ${cruisePeak} (expected 0 — veil must not leak in open air)`);

    // pick the fattest blob (max halfW) — bigger chord = more interior frames
    const target = await session.eval(`
      const blobs = window.__porco.world?.blobs ?? [];
      let best = null;
      for (const b of blobs) {
        if (!Number.isFinite(b.x) || !Number.isFinite(b.y) || !Number.isFinite(b.z)) continue;
        if (!(b.halfW > 0) || !(b.halfH > 0)) continue;
        if (!best || b.halfW > best.halfW) best = { x: b.x, y: b.y, z: b.z, halfW: b.halfW, halfH: b.halfH };
      }
      return best;
    `);
    if (!target) throw new Error('no puff blobs found — puff field missing?');
    console.log(`[probe] intercept target blob: ${JSON.stringify(target)}`);

    // teleport 40 m before the front surface (plane forward = -Z), ON the blob's (x, y)
    const spawnZ = target.z + target.halfW + 40;
    const planeNow = await session.eval(`
      window.__porco.game.setPose(${target.x}, ${target.y}, ${spawnZ});
      return window.__porco.qa.describe().plane;
    `);
    if (Math.abs(planeNow[0] - target.x) > 1 || Math.abs(planeNow[2] - spawnZ) > 1) {
      throw new Error(`setPose failed: plane=${JSON.stringify(planeNow)} target=(${target.x},-,${spawnZ})`);
    }
    await session.eval(PRESENT);

    const intercept = [];
    for (let steps = 0; steps <= 240; steps += 10) {
      if (steps > 0) await session.eval(`return window.__porco.qa.step(10, ${STEP_DT});`);
      await session.eval(PRESENT);
      const name = `intercept-t${String(steps).padStart(4, '0')}`;
      const sc = await captureFrame(session, `probe/${name}`, {
        qs, group: 'D-probe', frames: steps,
        extra: {
          probeSteps: steps, simSeconds: Number((steps / 60).toFixed(2)), series: 'intercept',
          blob: target, spawnZ,
        },
      });
      intercept.push({
        steps, simSeconds: Number((steps / 60).toFixed(2)),
        whiteoutOpacity: sc.desc.whiteoutOpacity, plane: sc.desc.plane, png: `probe/${name}.png`,
      });
      payload.frames[name] = sc;
    }
    const peak = Math.max(...intercept.map((s) => Number(s.whiteoutOpacity ?? 0)));
    payload.probeSeries = { cruise, intercept };
    payload.probePeakWhiteout = peak;
    console.log(`[probe] intercept series peak whiteout: ${peak}`);
    if (peak < 0.2) {
      payload.warnings.push(`intercept series peaked at whiteout ${peak} — plane may have clipped past the blob; gate 2/4 need a re-aim`);
    }
  } finally {
    await session.close().catch(() => {});
  }
}

/**
 * Group E — perf segments, render-perf-pass1 §1.1 口径:
 * unfrozen (real rAF feeds the ring; frozen mode pushes fixed dt), focus +
 * tier double-assertion around each segment, one Chrome session.
 */
async function groupE(payload) {
  for (const seg of [
    { name: 'perf-default', qs: '' },
    { name: 'perf-puff0', qs: 'puff=0' },
    { name: 'perf-bg0', qs: 'bg=0' },
  ]) {
    const qs = seg.qs;
    const url = `${BASE}?${qs}`;
    const target = await newTab(url);
    const session = new Session(target);
    await session.open();
    const record = { name: seg.name, url, query: qs, fillMs: PERF_FILL_MS };
    try {
      const ok = await session.waitBoot(qs, { frozen: false });
      if (!ok) throw new Error('boot timeout (or URL drifted)');
      await session.eval(`
        const b = document.querySelector('#boot-status');
        let n = 0;
        while (b && getComputedStyle(b).opacity !== '0' && n < 60) {
          await new Promise(r => setTimeout(r, 500));
          n++;
        }
        return n;
      `);

      // focus + tier assertion (pre)
      let focus = null;
      for (let i = 0; i < 6; i++) {
        await session.send('Page.bringToFront');
        await sleep(1000);
        focus = await session.focusState();
        if (focus.hasFocus && focus.visibility === 'visible') break;
      }
      record.focusPre = focus;
      record.qualityPre = await session.eval('return window.__porco.qa.describe().quality;');
      if (!focus?.hasFocus || focus.visibility !== 'visible') {
        throw new Error(`segment ${seg.name} VOID: focus=${JSON.stringify(focus)} — 口径纪律 requires hasFocus===true`);
      }
      if (record.qualityPre !== 'high') {
        throw new Error(`segment ${seg.name} VOID: quality=${record.qualityPre} — 口径纪律 requires high tier`);
      }

      await sleep(PERF_FILL_MS);

      // focus + tier assertion (post) — a mid-segment governor down-tier voids it
      focus = await session.focusState();
      record.focusPost = focus;
      record.qualityPost = await session.eval('return window.__porco.qa.describe().quality;');
      record.valid = focus.hasFocus && focus.visibility === 'visible'
        && record.qualityPre === 'high' && record.qualityPost === 'high';

      const stats = await session.eval('return window.__porco.qa.frameStats();');
      const desc = await session.eval(DESCRIBE);
      record.frameStats = stats;
      record.drawCalls = desc.render?.calls ?? null;
      record.triangles = desc.render?.triangles ?? null;
      record.backend = desc.backend;
      record.qualityPost2 = desc.quality;
      record.plane = desc.plane;
      record.elapsed = desc.elapsed;

      const gate = stats.p95 <= 27.9;
      record.gate = { baseline: { p50: 20.8, p95: 27.9, source: '2026-11-12 render-perf-pass1 §1.1' }, p95Pass: gate };
      payload.perf[seg.name] = record;
      console.log(`[perf] ${seg.name}: p50=${stats.p50} p95=${stats.p95} calls=${record.drawCalls} valid=${record.valid} gate(p95<=27.9)=${gate}`);
      if (!record.valid) payload.warnings.push(`perf segment ${seg.name} recorded but INVALID per 口径纪律 (focus/tier assertion failed)`);
    } catch (err) {
      record.error = String(err).slice(0, 400);
      payload.perf[seg.name] = record;
      payload.errors.push(`perf ${seg.name}: ${record.error}`);
    } finally {
      await session.close().catch(() => {});
    }
  }
}

const payload = {
  protocol: {
    base: BASE,
    cdp: CDP,
    chrome: 'headed, --disable-features=CalculateNativeWinOcclusion (WebGPU needs D3D12; headless has no adapter here)',
    cruiseFrames: CRUISE_FRAMES,
    step: `qa.step(N, ${STEP_DT}) then 2 rounds of qa.stepFrame(0) + 2 rAF`,
    viewport: [VIEW_W, VIEW_H],
    deviceScaleFactor: 1,
    gates: {
      g1: 'any heading 8-14 bg patches, not merging into slabs (sweep frames, counted visually)',
      g2: 'through-cloud triple: white surround / plane visible / thickness (probe frames)',
      g3: '?tod=12 hard edge gone, incl. ?tod=12&bg=0 isolation frame (design §6)',
      g4: 'veil entry shows no hard cutoff layer; else VEIL_INNER 0.96->0.93 fallback',
      g5: 'alt low + alt=240 still show several patches',
      g6: 'anti-goal: far view not empty-clean (sky must not look fake)',
      g7: 'perf p95(all-on, high tier, focused) <= 27.9',
    },
  },
  frames: {},
  perf: {},
  probeSeries: [],
  warnings: [],
  errors: [],
};

const GROUPS = { A: groupA, B: groupB, C: groupC, D: groupD, E: groupE };
const MATRIX_FILE = path.join(ROOT, 'capture-matrix.json');
// Merge semantics: a partial re-run (ONLY=...) UPDATES the existing matrix
// record instead of replacing it — per-frame and per-segment keys merge, the
// probe series replaces only when group D actually ran. Group-level errors
// from PREVIOUS runs are dropped when the group re-ran cleanly this session.
const ranGroups = new Set();
const failedGroups = new Set();
for (const [key, fn] of Object.entries(GROUPS)) {
  if (ONLY && !ONLY.has(key)) continue;
  ranGroups.add(key);
  console.log(`=== group ${key} ===`);
  try {
    await fn(payload);
  } catch (err) {
    failedGroups.add(key);
    payload.errors.push(`group ${key}: ${String(err).slice(0, 500)}`);
    console.log(`[group ${key} FAILED] ${String(err).slice(0, 300)}`);
  }
}

fs.mkdirSync(ROOT, { recursive: true });
let merged = payload;
if (fs.existsSync(MATRIX_FILE)) {
  const prev = JSON.parse(fs.readFileSync(MATRIX_FILE, 'utf8'));
  const resolved = (e) => {
    const m = /^group (\w+):/.exec(e);
    return m && ranGroups.has(m[1]) && !failedGroups.has(m[1]);
  };
  merged = {
    ...prev,
    ...payload,
    protocol: { ...prev.protocol, ...payload.protocol },
    frames: { ...(prev.frames ?? {}), ...(payload.frames ?? {}) },
    perf: { ...(prev.perf ?? {}), ...(payload.perf ?? {}) },
    probeSeries: ranGroups.has('D') ? payload.probeSeries : (prev.probeSeries ?? []),
    warnings: [...new Set([...(prev.warnings ?? []).filter((w) => !ranGroups.has('D') || !w.includes('relocated re-run')), ...payload.warnings])],
    errors: [...new Set([...(prev.errors ?? []).filter((e) => !resolved(e)), ...payload.errors])],
    groupsRunOrder: [...(prev.groupsRunOrder ?? []), ...[...ranGroups].map((g) => `${g}@${new Date().toISOString()}`)],
  };
}
fs.writeFileSync(MATRIX_FILE, JSON.stringify(merged, null, 2));
if (merged.errors.length > 0) {
  console.log('CAPTURE ERRORS:', merged.errors.join(' | '));
  process.exitCode = 1;
} else {
  console.log(`capture done: matrix record holds ${Object.keys(merged.frames).length} frames + ${Object.keys(merged.perf).length} perf segments -> matrix/capture-matrix.json`);
}
