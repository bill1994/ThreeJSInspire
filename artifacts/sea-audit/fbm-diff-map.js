// Difference-map diagnostic: render graph.ridge over a 400 m plane in one pass,
// read back 64x64, compare against the TS mirror on the same grid, and report
// the structure of the difference (constant offset? phase shift? noise?).
const resUrl = (needle) =>
  performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes(needle));
return (async () => {
  const threeUrl = resUrl('three_webgpu');
  const tslUrl = resUrl('three_tsl');
  const mod = await import(threeUrl);
  const TSL = await import(tslUrl);
  const THREE = mod;
  const seaFft = await import('/src/sea-fft.ts');
  const seaFbm = await import('/src/sea-fbm.ts');
  const r = window.__porco.renderer;
  const graph = seaFft.createFbmBandGraph(TSL);

  const EXT = 400; // metres covered by the plane
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.colorNode = TSL.vec4(graph.ridge(TSL.positionWorld.x, TSL.positionWorld.z), TSL.float(0), TSL.float(0), TSL.float(1));
  const scene = new THREE.Scene();
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(EXT, EXT), mat);
  plane.rotation.x = -Math.PI / 2; // lie flat: positionWorld.x/z sweep the field
  scene.add(plane);
  const cam = new THREE.OrthographicCamera(-EXT / 2, EXT / 2, EXT / 2, -EXT / 2, -10, 10);
  cam.position.set(0, 5, 0);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();

  const N = 64;
  const rt = new THREE.RenderTarget(N, N);
  r.setRenderTarget(rt);
  await r.renderAsync(scene, cam);
  const buf = await r.readRenderTargetPixelsAsync(rt, 0, 0, N, N);
  r.setRenderTarget(null);

  // row j of the framebuffer = world z from +EXT/2 (top) to -EXT/2 (bottom);
  // readback rows are bottom-up, so readback row j = world z = -EXT/2 + (j+0.5)*d
  let maxD = 0, meanD = 0, count = 0;
  let worst = null;
  const dMap = [];
  for (let j = 0; j < N; j++) {
    const z = -EXT / 2 + (j + 0.5) * (EXT / N);
    for (let i2 = 0; i2 < N; i2++) {
      const x = -EXT / 2 + (i2 + 0.5) * (EXT / N);
      const idx = (j * N + i2) * 4;
      const gpu = buf[idx] / 255;
      const ts = seaFbm.fbmRidgeField(x, z, 0);
      const d = gpu - ts;
      dMap.push(+d.toFixed(4));
      meanD += d; count++;
      if (Math.abs(d) > Math.abs(maxD)) { maxD = d; worst = { x: +x.toFixed(1), z: +z.toFixed(1), gpu: +gpu.toFixed(4), ts: +ts.toFixed(4) }; }
    }
  }
  meanD /= count;
  rt.dispose(); mat.dispose();
  // column profile of the mean difference (does it vary along x? along z?)
  const colProfile = [];
  for (let i2 = 0; i2 < N; i2 += 8) {
    let s = 0, n = 0;
    for (let j = 0; j < N; j++) { s += dMap[j * N + i2]; n++; }
    colProfile.push(+(s / n).toFixed(4));
  }
  const rowProfile = [];
  for (let j = 0; j < N; j += 8) {
    let s = 0, n = 0;
    for (let i2 = 0; i2 < N; i2++) { s += dMap[j * N + i2]; n++; }
    rowProfile.push(+(s / n).toFixed(4));
  }
  return ({ maxD: +maxD.toFixed(4), meanD: +meanD.toFixed(4), worst, colProfile, rowProfile });
})();
