// Readback probe (plan Task 1/2, Review Focus #5): evaluate the FBM band graph
// on the GPU inside the live page and compare against the TS mirror.
// Runs via cdp-capture.mjs --eval on a ?sea=fbm page.
// The three instance MUST be the page's own: importing the dep URL without the
// ?v hash creates a second module record -> two three instances -> the
// renderer's weakmaps miss on foreign objects ("Invalid value used as weak
// map key", measured). Discover the exact URLs the page actually loaded.
const resUrl = (needle) =>
  performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes(needle));
const threeUrl = resUrl('three_webgpu');
const tslUrl = resUrl('three_tsl');
if (!threeUrl || !tslUrl) {
  return { probeError: 'three module URLs not found in page resources' };
} else {
const mod = await import(threeUrl);
const seaFft = await import('/src/sea-fft.ts');
const seaFbm = await import('/src/sea-fbm.ts');

const TSL = await import(tslUrl);
const THREE = mod;
const r = window.__porco.renderer;
const graph = seaFft.createFbmBandGraph(TSL);

const uTime = TSL.uniform(0);
const pos = TSL.uniform(new THREE.Vector2(0, 0));
const bandNode = graph.bandShape(pos.x, pos.y, uTime);
const ridgeNode = graph.ridge(pos.x, pos.y);

const mat = new THREE.MeshBasicNodeMaterial();
mat.colorNode = TSL.vec4(bandNode, ridgeNode, TSL.float(0), TSL.float(1));
const scene = new THREE.Scene();
const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
scene.add(mesh);
const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

// Byte precision (1/255 ~ 0.004) still catches the actual failure class —
// O(1) value jumps from float32 floor flips. NOTE: the WebGPU build's
// readRenderTargetPixelsAsync RETURNS the buffer (the WebGL build's takes one —
// passing a buffer lands in the textureIndex slot and explodes).
const rt = new THREE.RenderTarget(4, 4);

// probe points away from lattice borders (plan: avoid cell edges); a point that
// fails with O(1) error while the rest pass at 1e-4 is a border point -> drop.
const candidates = [
  [37.0, -82.0], [-115.0, 64.0], [203.5, 148.25], [-64.75, -201.5],
  [250.0, 12.5], [12.5, 250.0], [-250.0, -12.5], [-12.5, -250.0],
];
const results = [];
for (const [x, z] of candidates) {
  pos.value.set(x, z);
  uTime.value = 0;
  r.setRenderTarget(rt);
  await r.renderAsync(scene, cam);
  const buf = await r.readRenderTargetPixelsAsync(rt, 0, 0, 4, 4);
  r.setRenderTarget(null);
  // centre pixel of the 4x4 target
  const i = (1 * 4 + 1) * 4 + 0;
  const gpuBand = buf[i] / 255;
  const gpuRidge = buf[i + 1] / 255;
  const tsRidge = seaFbm.fbmRidgeField(x, z, 0);
  const tsBand = seaFbm.fbmBandShape(tsRidge, x, z, 0);
  results.push({
    x, z,
    gpuRidge: +gpuRidge.toFixed(6), tsRidge: +tsRidge.toFixed(6),
    gpuBand: +gpuBand.toFixed(6), tsBand: +tsBand.toFixed(6),
    dRidge: Math.abs(gpuRidge - tsRidge), dBand: Math.abs(gpuBand - tsBand),
  });
}
rt.dispose();
mat.dispose();
const keep = results.filter((p) => p.dBand < 0.01 && p.dRidge < 0.01);
const borderDropped = results.length - keep.length;
const maxDBand = Math.max(...keep.map((p) => p.dBand));
const maxDRidge = Math.max(...keep.map((p) => p.dRidge));
return ({
  verdict: keep.length >= 6 && maxDBand < 5e-3 && maxDRidge < 5e-3 ? 'PASS' : 'FAIL',
  keep: keep.length, borderDropped, maxDBand, maxDRidge,
  backend: window.__porco.backend,
  results,
});
}
