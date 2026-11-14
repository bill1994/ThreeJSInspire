// Task 3 GPU 冒烟：真模块 initBgCumulus → drawAll → 立方图内容显示
export async function run() {
  try {
    const THREEw = await import('three/webgpu');
    const tsl = await import('three/tsl');
    const THREE = await import('three');
    const renderer = window.__spikeRenderer;
    if (!renderer) throw new Error('no spike renderer');
    const { initBgCumulus } = await import('/src/bg-cumulus.ts');
    const handles = await initBgCumulus(renderer, { seed: 7, quality: 256 });
    window.__bgHandles = handles;
    handles.drawAll();
    // 显示：face 4 (+Z 前方) 采样
    const geo = new THREE.PlaneGeometry(2, 2);
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const dirs = [
      tsl.vec3(1, 0, 0), tsl.vec3(-1, 0, 0), tsl.vec3(0, 1, 0),
      tsl.vec3(0, -1, 0), tsl.vec3(0, 0, 1), tsl.vec3(0, 0, -1),
    ];
    const face = window.__spikeFace ?? 4;
    const m = new THREEw.MeshBasicNodeMaterial();
    m.colorNode = tsl.cubeTexture(handles.texture, dirs[face]);
    const s = new THREE.Scene();
    s.add(new THREE.Mesh(geo, m));
    renderer.setViewport(0, 0, 256, 256);
    renderer.setScissorTest(false);
    renderer.setRenderTarget(null);
    renderer.render(s, cam);
    window.__spike3Result = { ok: true, count: handles.count };
    return { ok: true, count: handles.count };
  } catch (e) {
    window.__spike3Result = { ok: false, err: String(e) };
    return { ok: false, err: String(e) };
  }
}
