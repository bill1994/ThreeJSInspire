// Task 0 spike probe #3：分阶段显示取证（复用 probe2 的 renderer）
// 每个 phase() 重建现场并显示，供自动化逐阶段截图。
export async function phase(name) {
  const THREEw = await import('three/webgpu');
  const tsl = await import('three/tsl');
  const THREE = await import('three');
  const { Fn, vec3, vec4, uniform, uv, texture } = tsl;
  const renderer = window.__spikeRenderer;
  if (!renderer) throw new Error('renderer missing — run probe2 first');

  const geo = new THREE.PlaneGeometry(2, 2);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const gradMat = new THREEw.MeshBasicNodeMaterial();
  gradMat.colorNode = Fn(() => uv().y.greaterThan(0.5).select(vec3(0.8, 0.1, 0.1), vec3(0.1, 0.8, 0.1)), 1)();
  const whiteMat = new THREEw.MeshBasicNodeMaterial();
  whiteMat.colorNode = vec4(1, 1, 1, 1);
  const uStrip = uniform(0);
  const stripMat = new THREEw.MeshBasicNodeMaterial();
  stripMat.colorNode = Fn(() => vec3(uStrip.mul(0.2), uStrip.mul(0.15), uStrip.mul(0.25)).add(vec3(0.15, 0.15, 0.3)), 1)();

  const makeRT = () => new THREEw.RenderTarget(256, 256, { format: THREE.RGBAFormat, type: THREE.HalfFloatType });
  const bakeScene = (mat) => { const s = new THREE.Scene(); s.add(new THREE.Mesh(geo, mat)); return s; };
  const show = (rt) => {
    const m = new THREEw.MeshBasicNodeMaterial();
    m.colorNode = texture(rt.texture, uv());
    const s = new THREE.Scene(); s.add(new THREE.Mesh(geo, m));
    renderer.setViewport(0, 0, 256, 256); renderer.setScissorTest(false);
    renderer.setRenderTarget(null); renderer.render(s, cam);
  };

  window.__spikePhase = name;
  if (name === 'gradient') {
    const rt = makeRT(); const s = bakeScene(gradMat);
    renderer.setRenderTarget(rt); renderer.setViewport(0, 0, 256, 256); renderer.render(s, cam);
    renderer.setRenderTarget(null); show(rt);
  } else if (name === 'scissorRenderer') {
    const rt = makeRT(); const s = bakeScene(gradMat);
    renderer.setRenderTarget(rt); renderer.setViewport(0, 0, 256, 256); renderer.render(s, cam);
    renderer.setScissorTest(true); renderer.setScissor(0, 0, 256, 64);
    renderer.render(bakeScene(whiteMat), cam);
    renderer.setScissorTest(false);
    renderer.setRenderTarget(null); show(rt);
  } else if (name === 'scissorRt') {
    const rt = makeRT(); const s = bakeScene(gradMat);
    renderer.setRenderTarget(rt); renderer.setViewport(0, 0, 256, 256); renderer.render(s, cam);
    rt.scissor.set(0, 0, 256, 64); rt.scissorTest = true;
    renderer.render(bakeScene(whiteMat), cam);
    rt.scissorTest = false;
    renderer.setRenderTarget(null); show(rt);
  } else if (name === 'viewportStrips') {
    const rt = makeRT(); const s = bakeScene(stripMat);
    renderer.setRenderTarget(rt);
    for (let k = 0; k < 4; k++) { uStrip.value = k; renderer.setViewport(0, k * 64, 256, 64); renderer.render(s, cam); }
    renderer.setViewport(0, 0, 256, 256);
    renderer.setRenderTarget(null); show(rt);
  } else if (name === 'cubeFace0' || name === 'cubeFace4') {
    const crt = new THREEw.CubeRenderTarget(64, { format: THREE.RGBAFormat, type: THREE.HalfFloatType });
    const uFace = uniform(0);
    const fm = new THREEw.MeshBasicNodeMaterial();
    fm.colorNode = Fn(() => vec3(uFace.mul(0.15), 0.1, uFace.mul(0.1).add(0.2)), 1)();
    const s = bakeScene(fm);
    for (let f = 0; f < 6; f++) { uFace.value = f; renderer.setRenderTarget(crt, f); renderer.setViewport(0, 0, 64, 64); renderer.render(s, cam); }
    renderer.setViewport(0, 0, 256, 256);
    const face = name === 'cubeFace0' ? 0 : 4;
    const dirs = [vec3(1,0,0), vec3(-1,0,0), vec3(0,1,0), vec3(0,-1,0), vec3(0,0,1), vec3(0,0,-1)];
    const m = new THREEw.MeshBasicNodeMaterial();
    m.colorNode = texture(crt.texture, dirs[face]);
    const s2 = new THREE.Scene(); s2.add(new THREE.Mesh(geo, m));
    renderer.setRenderTarget(null); renderer.render(s2, cam);
    window.__spikePhaseColor = [Math.round(face * 0.15 * 100) / 100, 0.1, Math.round((face * 0.1 + 0.2) * 100) / 100];
  }
  return window.__spikePhase;
}
