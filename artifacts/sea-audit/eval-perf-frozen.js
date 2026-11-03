// Frozen-mode CPU wall time of a single frame (qa.step(1) includes post.render).
// On SwiftShader the rasterization runs on the CPU, so wall time tracks pixel
// cost. rAF deltas are vsync-locked (16.7 ms flat, measured) and cannot see
// fragment cost — this is the honest relative measure available headless.
const samples = [];
window.__porco.qa.step(5, 1 / 60); // warm shader paths
const gl = window.__porco.renderer.getContext();
for (let i = 0; i < 10; i++) {
  const t0 = performance.now();
  window.__porco.qa.step(1, 1 / 60);
  gl.finish(); // the submit is async: without the sync this measures recording only
  samples.push(performance.now() - t0);
}
samples.sort((a, b) => a - b);
const med = samples[5];
const p90 = samples[9];
return {
  medianMs: +med.toFixed(2), p90Ms: +p90.toFixed(2),
  backend: window.__porco.backend,
  search: window.location.search,
  camera: window.__porco.camera.position.toArray().map((v) => +v.toFixed(1)),
};
