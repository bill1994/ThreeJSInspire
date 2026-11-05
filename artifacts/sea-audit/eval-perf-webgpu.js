// Water fragment-cost probe on the WebGPU path — the replacement for the two
// archived WebGL/SwiftShader harnesses (`eval-perf-rAF.js` measured a vsync-
// locked rAF delta, `eval-perf-glfinish.js` synced with `gl.finish()` on a
// `WebGPURenderer` that has no `getContext()`; neither can see fragment cost).
//
// Protocol is the one pinned by fragment-cost-2026-11-05.md, do not "simplify" it:
//   1. Offscreen 4096x7279 RenderTarget. The on-screen canvas is NOT usable: the
//      compositor coalesces un-presented frames, so 32 submits of the same frame
//      still bill as one (measured 0.26 ms/frame regardless of geometry).
//   2. `queue.onSubmittedWorkDone()` per frame is too expensive (fixed ~5 ms), so
//      take the BATCH SLOPE (t(56) - t(8)) / 48 and median three of them.
//   3. Six warm frames before any measurement.
//   4. A paired control: the same landscape with the sea meshes hidden. If
//      water - no-water is not clearly positive, the instrument is blind (this is
//      exactly how the broken per-train rebuild in the report was caught).
//
// Run:
//   node artifacts/sea-audit/cdp-capture.mjs \
//     --browser "C:/Program Files/Google/Chrome/Application/chrome.exe" \
//     --url "http://localhost:5173/?alt=8&qa=frozen&post=0" \
//     --out artifacts/sea-audit/perf-webgpu.png --steps 40 \
//     --eval artifacts/sea-audit/eval-perf-webgpu.js
//
// `--browser` is not optional: headless **Edge 131** on this machine boots the
// page on `webgl2` (its `--enable-unsafe-webgpu --enable-features=Vulkan` does
// not produce an adapter), and forcing `?backend=webgpu` makes the app never
// reach the QA hook. Headless **Chrome** does give WebGPU. Measured
// 2026-11-05: Chrome headless, webgpu backend, water 3.704 ms vs no-water
// 3.017 ms at 4096x7279 → delta 0.687 ms, against the report's 0.70 ms field.
//
// `post=0` keeps the post pipeline out of the number. This is a desktop-GPU
// calibration, not a phone measurement: design R2 stays open on that point.

const P = window.__porco;
if (!P) return { error: 'no __porco hook — is this the app page?' };
if (!P.qa || !P.qa.frozen) return { error: 'needs ?qa=frozen so the loop cannot advance underneath' };

const r = P.renderer;
const isWebGPU = r?.backend?.isWebGPUBackend === true;
if (!isWebGPU) {
  return { error: `canonical WebGPU required, backend=${P.backend}`, backend: P.backend };
}
const device = r.backend.device;
if (!device?.queue?.onSubmittedWorkDone) return { error: 'no queue.onSubmittedWorkDone on this backend' };

const sea = P.world?.sea ?? null;
if (!sea || !Array.isArray(sea.meshes)) return { error: 'no banded sea mounted (world.sea is null)' };

// Three must be the page's OWN module record: importing the bare dep URL makes a
// second instance and the renderer's weakmaps reject foreign objects (measured).
const resUrl = (needle) => performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes(needle));
const threeUrl = resUrl('three_webgpu');
if (!threeUrl) return { error: 'three module URL not found in page resources' };
const THREE = await import(threeUrl);

const W = 4096;
const H = 7279;
const rt = new THREE.RenderTarget(W, H, { depthBuffer: true });
const sync = () => device.queue.onSubmittedWorkDone();

/** Submit `n` frames to the offscreen target and wait for the GPU to drain. */
async function batch(n) {
  r.setRenderTarget(rt);
  const t0 = performance.now();
  for (let i = 0; i < n; i += 1) P.qa.stepFrame(1 / 60);
  await sync();
  const ms = performance.now() - t0;
  r.setRenderTarget(null);
  return ms;
}

async function slope() {
  const a = await batch(8);
  const b = await batch(56);
  return (b - a) / 48;
}

const median = (xs) => {
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

// Measure water and no-water INTERLEAVED, per-cycle.
//
// Two traps, both paid for on 2026-11-05:
//
// 1. Do NOT hide the water with `mesh.visible = false`: `bands.update()` rewrites
//    `visible` from the visibility mask on EVERY frame (src/sea/bands.ts:396), so the
//    toggle is undone inside `qa.stepFrame` and the "dry" arm is silently still wet.
//    That produced deltas of 0.09 / 0.24 / -0.05 ms — pure noise — and the blind
//    control below is what caught it. Detach from the scene graph instead.
// 2. Do NOT measure all water first and all dry second: the machine drifts (the dry
//    baseline moved 3.0 -> 4.2 ms between runs), which is larger than the effect and
//    showed up as a fake 0.7 ms "water cost". Alternate per cycle so drift cancels.
await batch(6); // one warm-up for both arms: shader variants and first-use allocs
const parent = sea.meshes[0]?.parent ?? null;
const setDry = (dry) => {
  for (const m of sea.meshes) {
    if (dry) {
      if (m.parent) m.parent.remove(m);
    } else if (!m.parent && parent) {
      parent.add(m);
    }
  }
};
const cycles = [];
for (let k = 0; k < 7; k += 1) {
  setDry(false);
  const wet = await slope();
  setDry(true);
  const dry = await slope();
  cycles.push({ wet: +wet.toFixed(3), dry: +dry.toFixed(3), delta: +(wet - dry).toFixed(3) });
}
setDry(false);

const water = { label: 'water', samples: cycles.map((c) => c.wet), msPerFrame: +median(cycles.map((c) => c.wet)).toFixed(3) };
const dry = { label: 'no-water', samples: cycles.map((c) => c.dry), msPerFrame: +median(cycles.map((c) => c.dry)).toFixed(3) };
const delta = +median(cycles.map((c) => c.delta)).toFixed(3);

rt.dispose();
if (delta <= 0.05) {
  // Same failure signature as the broken per-train rebuild: the tool cannot see
  // the water it is supposed to be pricing, so its numbers mean nothing.
  return { error: 'instrument blind: hiding the water did not reduce cost', cycles, deltaMs: delta };
}

return {
  buffer: [W, H],
  water,
  dry,
  deltaMs: delta,
  cycles,
  note: 'desktop WebGPU calibration; interleaved per cycle; multiply by the phone derating before quoting a phone budget',
  backend: P.backend,
  revision: P.qa.revision,
  search: location.search,
  camera: P.camera.position.toArray().map((v) => +v.toFixed(1)),
};
