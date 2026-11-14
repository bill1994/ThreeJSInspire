// Task 0 spike probe #4：shader 侧 Discard 条带掩码（scissor/viewport 均失效后的兜底）+ 立方图逐面
// r186 TSL：three/tsl 导出 Discard（条件链式 .discard() 也可），node_modules/three/src/nodes/utils/Discard.js
export async function phase(name) {
  const THREEw = await import('three/webgpu');
  const tsl = await import('three/tsl');
  const THREE = await import('three');
  const { Fn, vec3, vec4, uniform, uv, texture, cubeTexture } = tsl;
  const renderer = window.__spikeRenderer;
  if (!renderer) throw new Error('renderer missing — run probe2 first');
  const geo = new THREE.PlaneGeometry(2, 2);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const show = (rt) => {
    const m = new THREEw.MeshBasicNodeMaterial();
    m.colorNode = texture(rt.texture, uv());
    const s = new THREE.Scene(); s.add(new THREE.Mesh(geo, m));
    renderer.setViewport(0, 0, 256, 256); renderer.setScissorTest(false);
    renderer.setRenderTarget(null); renderer.render(s, cam);
  };

  window.__spikePhase = name;
  if (name === 'discardBand') {
    // 底图：上半红下半绿
    const rt = new THREEw.RenderTarget(256, 256, { format: THREE.RGBAFormat, type: THREE.HalfFloatType });
    const gradMat = new THREEw.MeshBasicNodeMaterial();
    gradMat.colorNode = Fn(() => uv().y.greaterThan(0.5).select(vec3(0.8, 0.1, 0.1), vec3(0.1, 0.8, 0.1)), 1)();
    const s = new THREE.Scene(); s.add(new THREE.Mesh(geo, gradMat));
    renderer.setRenderTarget(rt); renderer.setViewport(0, 0, 256, 256); renderer.render(s, cam);
    // 条带烘焙：uv.y ∈ [0.25, 0.5) 写白，带外真 discard
    const uBand0 = uniform(0.25), uBand1 = uniform(0.5);
    const stripMat = new THREEw.MeshBasicNodeMaterial();
    stripMat.colorNode = Fn(() => {
      const v = uv().y;
      v.lessThan(uBand0).discard();
      v.greaterThanEqual(uBand1).discard();
      return vec4(1, 1, 1, 1);
    })();
    const s2 = new THREE.Scene(); s2.add(new THREE.Mesh(geo, stripMat));
    renderer.autoClear = false; // 条带 pass 跳过整幅 clear —— 保留带外内容的关键
    renderer.render(s2, cam);
    renderer.autoClear = true;
    renderer.setRenderTarget(null); show(rt);
    window.__spikeNote = '期望：仅一条白带，渐变其余部分原样保留 = Discard 掩码成立';
  } else if (name === 'cubeFace0' || name === 'cubeFace4') {
    const crt = new THREEw.CubeRenderTarget(64, { format: THREE.RGBAFormat, type: THREE.HalfFloatType });
    const uFace = uniform(0);
    const fm = new THREEw.MeshBasicNodeMaterial();
    fm.colorNode = Fn(() => vec3(uFace.mul(0.15), 0.1, uFace.mul(0.1).add(0.2)), 1)();
    const s = new THREE.Scene(); s.add(new THREE.Mesh(geo, fm));
    for (let f = 0; f < 6; f++) { uFace.value = f; renderer.setRenderTarget(crt, f); renderer.setViewport(0, 0, 64, 64); renderer.render(s, cam); }
    renderer.setViewport(0, 0, 256, 256);
    const face = name === 'cubeFace0' ? 0 : 4;
    const dirs = [vec3(1,0,0), vec3(-1,0,0), vec3(0,1,0), vec3(0,-1,0), vec3(0,0,1), vec3(0,0,-1)];
    const m = new THREEw.MeshBasicNodeMaterial();
    m.colorNode = cubeTexture(crt.texture, dirs[face]);
    const s2 = new THREE.Scene(); s2.add(new THREE.Mesh(geo, m));
    renderer.setRenderTarget(null); renderer.render(s2, cam);
    window.__spikePhaseColor = [face * 0.15, 0.1, face * 0.1 + 0.2];
  }
  return window.__spikePhase;
}
