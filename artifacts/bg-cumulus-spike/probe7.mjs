// Task 3 综合冒烟（干净页面一次性）：magenta → init → drawAll → display，每阶段 flag
export async function run() {
  const R = (window.__probe7 = { magenta: false, init: false, bake: false, display: false, err: null });
  try {
    const THREEw = await import('three/webgpu');
    const tsl = await import('three/tsl');
    const THREE = await import('three');
    const canvas = document.createElement('canvas');
    canvas.id = 'probe7-canvas';
    canvas.width = 256; canvas.height = 256;
    Object.assign(canvas.style, { position: 'fixed', left: '8px', bottom: '8px', width: '256px', height: '256px', zIndex: '99997' });
    document.body.appendChild(canvas);
    const { createRenderer } = await import('/src/renderer.ts');
    const renderer = (await createRenderer(canvas)).renderer;
    window.__p7r = renderer;
    // 品红健全性
    const geo = new THREE.PlaneGeometry(2, 2);
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const m1 = new THREEw.MeshBasicNodeMaterial();
    m1.colorNode = new THREE.Color(1, 0, 1);
    const s1 = new THREE.Scene(); s1.add(new THREE.Mesh(geo, m1));
    renderer.setViewport(0, 0, 256, 256);
    renderer.render(s1, cam);
    R.magenta = true;
    // 模块
    const { initBgCumulus } = await import('/src/bg-cumulus.ts');
    const handles = await initBgCumulus(renderer, { seed: 7, quality: 128 });
    R.init = true;
    handles.drawAll();
    R.bake = true;
    const dirs = [tsl.vec3(1,0,0), tsl.vec3(-1,0,0), tsl.vec3(0,1,0), tsl.vec3(0,-1,0), tsl.vec3(0,0,1), tsl.vec3(0,0,-1)];
    const face = window.__p7face ?? 4;
    const m2 = new THREEw.MeshBasicNodeMaterial();
    m2.colorNode = tsl.cubeTexture(handles.texture, dirs[face]);
    const s2 = new THREE.Scene(); s2.add(new THREE.Mesh(geo, m2));
    renderer.setRenderTarget(null);
    renderer.render(s2, cam);
    R.display = true;
    window.__p7handles = handles;
    return R;
  } catch (e) {
    R.err = String(e);
    return R;
  }
}
