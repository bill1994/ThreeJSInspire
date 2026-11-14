// Task 0 spike probe #2：scissor 失效后的三条替代/确认路径
// A: uv 渐变烘进 2D RT（证明 RT 内容 + 显示采样 + uv 方向）
// B: renderer.setScissorTest/setScissor（renderer 级 scissor 路径）
// C: rt.scissorTest 复测（探针 1 已疑似失效）
// D: 逐条带 viewport 方案（无需 scissor：视口把四边形精确映射到条带矩形）
// E: CubeRenderTarget 六面异色（面 0 / 面 4 显示证据）
export async function run() {
  const R = (window.__spike2Result = {
    gradient: false, scissorRenderer: null, scissorRt: null, viewportStrips: false,
    cubeFaces: false, errors: [],
  });
  const note = (k, e) => { R.errors.push(`${k}: ${(e && e.message) || String(e)}`); console.warn('[spike2]', k, e); };
  try {
    const THREEw = await import('three/webgpu');
    const tsl = await import('three/tsl');
    const THREE = await import('three');
    const { Fn, vec2, vec3, vec4, uniform, uv, texture } = tsl;

    let canvas = document.getElementById('spike-canvas2');
    if (!window.__spikeRenderer) {
      canvas = document.createElement('canvas');
      canvas.id = 'spike-canvas2';
      canvas.width = 256; canvas.height = 256;
      Object.assign(canvas.style, { position: 'fixed', left: '8px', bottom: '8px', width: '256px', height: '256px', zIndex: '99998' });
      document.body.appendChild(canvas);
      const { createRenderer } = await import('/src/renderer.ts');
      window.__spikeRenderer = (await createRenderer(canvas)).renderer;
    }
    const renderer = window.__spikeRenderer;

    const uStrip = uniform(0);
    const mat = new THREEw.MeshBasicNodeMaterial();
    // 渐变：上半红、下半绿（uv.y 0=底 1=顶）
    mat.colorNode = Fn(() => {
      const g = uv().y.greaterThan(0.5);
      return vec4(g.select(vec3(0.8, 0.1, 0.1), vec3(0.1, 0.8, 0.1)), 1);
    })();
    const stripMat = new THREEw.MeshBasicNodeMaterial();
    stripMat.colorNode = Fn(() => vec3(uStrip.mul(0.2), uStrip.mul(0.15), uStrip.mul(0.25)).add(vec3(0.15, 0.15, 0.3)), 1)();
    const whiteMat = new THREEw.MeshBasicNodeMaterial();
    whiteMat.colorNode = vec4(1, 1, 1, 1);

    const geo = new THREE.PlaneGeometry(2, 2);
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const show2D = (rt) => {
      const m = new THREEw.MeshBasicNodeMaterial();
      m.colorNode = texture(rt.texture, uv());
      const s = new THREE.Scene(); s.add(new THREE.Mesh(geo, m));
      renderer.setViewport(0, 0, 256, 256);
      renderer.setScissorTest(false);
      renderer.setRenderTarget(null);
      renderer.render(s, cam);
    };

    // ===== A: 渐变烘进 2D RT =====
    const rtA = new THREEw.RenderTarget(256, 256, { format: THREE.RGBAFormat, type: THREE.HalfFloatType });
    const sceneA = new THREE.Scene(); sceneA.add(new THREE.Mesh(geo, mat));
    renderer.setRenderTarget(rtA); renderer.setViewport(0, 0, 256, 256); renderer.render(sceneA, cam);
    renderer.setRenderTarget(null); show2D(rtA);
    R.gradient = true; // __spike2Phase = 'A'（截图读回）

    // ===== B: renderer 级 scissor（先重烘渐变，再白四边形裁到底条） =====
    try {
      renderer.setRenderTarget(rtA); renderer.setViewport(0, 0, 256, 256); renderer.render(sceneA, cam);
      renderer.setScissorTest(true);
      renderer.setScissor(0, 0, 256, 64); // 底条
      const sceneW = new THREE.Scene(); sceneW.add(new THREE.Mesh(geo, whiteMat));
      renderer.render(sceneW, cam);
      renderer.setScissorTest(false);
      renderer.setRenderTarget(null); show2D(rtA);
      R.scissorRenderer = 'pending-visual';
    } catch (e) { note('scissorRenderer', e); }

    // ===== C: rt.scissor 复测 =====
    try {
      renderer.setRenderTarget(rtA); renderer.setViewport(0, 0, 256, 256); renderer.render(sceneA, cam);
      rtA.scissor.set(0, 0, 256, 64); rtA.scissorTest = true;
      const sceneW2 = new THREE.Scene(); sceneW2.add(new THREE.Mesh(geo, whiteMat));
      renderer.render(sceneW2, cam);
      rtA.scissorTest = false;
      renderer.setRenderTarget(null); show2D(rtA);
      R.scissorRt = 'pending-visual';
    } catch (e) { note('scissorRt', e); }

    // ===== D: 逐条带 viewport（4 条带异色，无需 scissor） =====
    try {
      const rtD = new THREEw.RenderTarget(256, 256, { format: THREE.RGBAFormat, type: THREE.HalfFloatType });
      const sceneD = new THREE.Scene(); sceneD.add(new THREE.Mesh(geo, stripMat));
      renderer.setRenderTarget(rtD);
      for (let k = 0; k < 4; k++) {
        uStrip.value = k;
        renderer.setViewport(0, k * 64, 256, 64);
        renderer.render(sceneD, cam);
      }
      renderer.setViewport(0, 0, 256, 256);
      renderer.setRenderTarget(null); show2D(rtD);
      R.viewportStrips = 'pending-visual';
    } catch (e) { note('viewportStrips', e); }

    // ===== E: cube 六面异色 =====
    try {
      const crt = new THREEw.CubeRenderTarget(64, { format: THREE.RGBAFormat, type: THREE.HalfFloatType });
      const faceMat = new THREEw.MeshBasicNodeMaterial();
      const uFace = uniform(0);
      faceMat.colorNode = Fn(() => vec3(uFace.mul(0.15), 0.1, uFace.mul(0.1).add(0.2)), 1)();
      const sceneE = new THREE.Scene(); sceneE.add(new THREE.Mesh(geo, faceMat));
      for (let f = 0; f < 6; f++) {
        uFace.value = f;
        renderer.setRenderTarget(crt, f); renderer.setViewport(0, 0, 64, 64);
        renderer.render(sceneE, cam);
      }
      renderer.setViewport(0, 0, 256, 256);
      R.__crt = crt; window.__spikeCrt = crt;
      const dir0 = vec3(1, 0, 0); // face 0 → color (0, 0.1, 0.2) 深蓝
      const m0 = new THREEw.MeshBasicNodeMaterial();
      m0.colorNode = texture(crt.texture, dir0);
      const s0 = new THREE.Scene(); s0.add(new THREE.Mesh(geo, m0));
      renderer.setRenderTarget(null); renderer.render(s0, cam);
      R.cubeFaces = 'pending-visual-face0';
    } catch (e) { note('cubeFaces', e); }

    console.log('[spike2] done', JSON.stringify(R));
    return R;
  } catch (e) {
    note('fatal', e);
    console.log('[spike2] fatal', JSON.stringify(R));
    return R;
  }
}
