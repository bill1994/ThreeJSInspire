// Task 3 冒烟 #2：假色三档 + 六面网格显示
export async function run() {
  try {
    const THREEw = await import('three/webgpu');
    const tsl = await import('three/tsl');
    const THREE = await import('three');
    let renderer = window.__spikeRenderer;
    if (!renderer) {
      const canvas = document.createElement('canvas');
      canvas.id = 'spike-canvas2';
      canvas.width = 256; canvas.height = 256;
      Object.assign(canvas.style, { position: 'fixed', left: '8px', bottom: '8px', width: '256px', height: '256px', zIndex: '99998' });
      document.body.appendChild(canvas);
      const { createRenderer } = await import('/src/renderer.ts');
      renderer = (await createRenderer(canvas)).renderer;
      window.__spikeRenderer = renderer;
    }
    const mod = await import('/src/bg-cumulus.ts');
    const handles = await mod.initBgCumulus(renderer, { seed: 7, quality: 256 });
    window.__bgHandles = handles;
    const mode = window.__spikeDebugMode ?? 0;
    handles.debugMode(mode);
    handles.drawAll();
    const geo = new THREE.PlaneGeometry(2, 2);
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const dirs = [tsl.vec3(1,0,0), tsl.vec3(-1,0,0), tsl.vec3(0,1,0), tsl.vec3(0,-1,0), tsl.vec3(0,0,1), tsl.vec3(0,0,-1)];
    const s = new THREE.Scene();
    for (let f = 0; f < 6; f++) {
      const m = new THREEw.MeshBasicNodeMaterial();
      m.colorNode = tsl.cubeTexture(handles.texture, dirs[f]);
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.x = (f % 3) * 1.4 - 1.4;
      mesh.position.y = f < 3 ? 0.7 : -0.7;
      mesh.scale.setScalar(0.6);
      s.add(mesh);
    }
    const cam2 = new THREE.OrthographicCamera(-2.2, 2.2, -1.2, 1.2, 0, 1);
    renderer.setViewport(0, 0, 256, 256);
    renderer.setScissorTest(false);
    renderer.setRenderTarget(null);
    renderer.render(s, cam2);
    window.__spike3Result = { ok: true, mode };
    return { ok: true, mode };
  } catch (e) {
    window.__spike3Result = { ok: false, err: String(e) };
    return { ok: false, err: String(e) };
  }
}
