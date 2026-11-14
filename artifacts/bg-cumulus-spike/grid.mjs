// 冻结帧下渲染烘焙立方图六面网格（vite 改写裸导入，探针从页面动态 import 本文件）
export async function draw() {
  try {
    const mod = await import('/src/bg-cumulus.ts?v=' + Date.now());
    const handles = await mod.initBgCumulus(window.__diagRenderer, { seed: 7, quality: 128 });
    const THREEw = await import('three/webgpu');
    const tsl = await import('three/tsl');
    const THREE = await import('three');
    const geo = new THREE.PlaneGeometry(2, 2);
    const cam = new THREE.OrthographicCamera(-3.3, 3.3, -1.3, 1.3, 0, 1);
    const dirs = [tsl.vec3(1,0,0), tsl.vec3(-1,0,0), tsl.vec3(0,1,0), tsl.vec3(0,-1,0), tsl.vec3(0,0,1), tsl.vec3(0,0,-1)];
    const s2 = new THREE.Scene();
    for (let f = 0; f < 6; f++) {
      const m = new THREEw.MeshBasicNodeMaterial();
      m.colorNode = tsl.cubeTexture(handles.texture, dirs[f]);
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.x = (f % 3) * 2.2 - 2.2;
      mesh.position.y = f < 3 ? 0.75 : -0.75;
      mesh.scale.setScalar(0.98);
      s2.add(mesh);
    }
    const renderer = window.__diagRenderer;
    renderer.setViewport(0, 0, 1024, 400);
    renderer.setScissorTest(false);
    renderer.setRenderTarget(null);
    renderer.render(s2, cam);
    return 'ok';
  } catch (e) {
    return 'ERR ' + String(e).slice(0, 300);
  }
}
