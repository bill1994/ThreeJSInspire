// rAF median frame time over the live (non-frozen) animation loop.
// SwiftShader renders on the CPU: absolute numbers are meaningless; the
// fft-vs-fbm MEDIANS are the relative deliverable (plan Task 5 step 1).
const deltas = [];
await new Promise((resolve) => {
  let last = performance.now();
  let n = 0;
  const tick = (t) => {
    deltas.push(t - last);
    last = t;
    if (++n >= 120) resolve();
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
deltas.sort((a, b) => a - b);
const q = (p) => +deltas[Math.floor(p * (deltas.length - 1))].toFixed(2);
return {
  median: q(0.5), p10: q(0.1), p90: q(0.9),
  backend: window.__porco.backend,
  href: window.location.search,
};
