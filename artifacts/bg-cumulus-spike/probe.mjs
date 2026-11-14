// Task 0 spike probe: WebGPU + TSL bake feasibility（计划 §裁定 4/6 的三个未证事实）
// 验证：① 2D atlas RT + 条带 scissor；② CubeRenderTarget 逐面渲染 + 条带 scissor；
// ③ sampler3D(HalfFloat) 在 TSL 采样；④ Loop/If/Var + vec3 返回值 Fn 在 WGSL 编译。
// 结论写 window.__spikeResult，证据由浏览器截图落盘（本文件不进 boot graph，仅控制台动态 import）。

export async function run() {
  if (window.__spikeRan) return window.__spikeResult;
  window.__spikeRan = true;
  const R = (window.__spikeResult = {
    threeWebgpu: false, renderer: false, atlas: false, scissorAtlas: null,
    cube: false, scissorCube: null, texture3D: false, varFnLoopIf: false,
    errors: [],
  });
  const note = (k, e) => { R.errors.push(`${k}: ${(e && e.message) || String(e)}`); console.warn('[spike]', k, e); };

  try {
    const THREEw = await import('three/webgpu');
    const tsl = await import('three/tsl');
    const THREE = await import('three');
    R.threeWebgpu = true;

    // --- 可见小画布（截图读回用） ---
    const canvas = document.createElement('canvas');
    canvas.id = 'spike-canvas';
    canvas.width = 256; canvas.height = 256;
    Object.assign(canvas.style, { position: 'fixed', left: '8px', bottom: '8px', width: '256px', height: '256px', zIndex: '99999' });
    document.body.appendChild(canvas);
    const { createRenderer } = await import('/src/renderer.ts');
    const { renderer } = await createRenderer(canvas);
    R.renderer = true;

    const { Fn, If, Loop, float, vec2, vec3, vec4, uniform, uv, texture, texture3D } = tsl;

    // --- 占位 billow 场：16³ RGBA HalfFloat，Nearest 采样（绕开 spike 阶段的过滤性变数） ---
    const N = 16;
    const data = new Uint16Array(N * N * N * 4);
    const half = THREE.DataUtils.toHalfFloat;
    for (let i = 0; i < N * N * N; i++) {
      data[i * 4] = half((i % 7) / 7); data[i * 4 + 1] = half(0.5);
      data[i * 4 + 2] = half(0.25); data[i * 4 + 3] = half(1);
    }
    const tex3d = new THREE.Data3DTexture(data, N, N, N);
    tex3d.format = THREE.RGBAFormat; tex3d.type = THREE.HalfFloatType;
    tex3d.minFilter = tex3d.magFilter = THREE.NearestFilter;
    tex3d.wrapS = tex3d.wrapT = tex3d.wrapR = THREE.RepeatWrapping;
    tex3d.unpackAlignment = 1; tex3d.needsUpdate = true;

    // --- 烘焙 shader：Loop+If+Var 聚合，采样 sampler3D，vec3 返回 Fn（Var 重组 out 参数的形态） ---
    const uFace = uniform(0);
    const sampleField = Fn(() => { // out 参数重组形态：返回 vec3(d, base, scale)
      const v = vec3(0).toVar();
      Loop(64, ({ i }) => {
        If(float(i).mul(0.01).lessThan(0.3), () => { v.addAssign(vec3(0.01, 0.005, 0.002)); });
      });
      return v;
    });
    const field = sampleField();
    const bakeColor = Fn(() => {
      const s = texture3D(tex3d, vec3(0.5, 0.5, float(uFace).mul(0.125)));
      const base = vec3(float(uFace).mul(0.15), 0.1, 0.2); // 每面不同底色
      return vec4(base.add(s.xyz.mul(2.0)).add(field), 1);
    });

    const mat = new THREEw.MeshBasicNodeMaterial();
    mat.colorNode = bakeColor();
    const geo = new THREE.PlaneGeometry(2, 2);
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geo, mat));
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const renderQuad = () => renderer.render(scene, cam);

    // --- 显示通道：把 RT 内容画回可见画布 ---
    const dispScene = new THREE.Scene();
    const cam2 = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const show2D = (rt) => {
      const m = new THREEw.MeshBasicNodeMaterial();
      m.colorNode = texture(rt.texture, uv());
      const mesh = new THREE.Mesh(geo, m);
      const s = new THREE.Scene(); s.add(mesh);
      renderer.setRenderTarget(null);
      renderer.render(s, cam2);
    };
    const showCubeFace = (crt, face) => {
      const m = new THREEw.MeshBasicNodeMaterial();
      // 立方体贴图采样：uv 位给方向 vec3（面 0 = +X）
      const dir = [vec3(1, 0, 0), vec3(-1, 0, 0), vec3(0, 1, 0), vec3(0, -1, 0), vec3(0, 0, 1), vec3(0, 0, -1)][face];
      m.colorNode = texture(crt.texture, dir);
      const mesh = new THREE.Mesh(geo, m);
      const s = new THREE.Scene(); s.add(mesh);
      renderer.setRenderTarget(null);
      renderer.render(s, cam2);
    };

    // ===== ① atlas RT + scissor =====
    const atlas = new THREEw.RenderTarget(256, 256, { format: THREE.RGBAFormat, type: THREE.HalfFloatType });
    try {
      renderer.setRenderTarget(atlas);
      renderer.setClearColor(0x880000, 1); // 全幅红
      atlas.scissorTest = false;
      renderQuad();
      atlas.scissor.set(0, 0, 256, 128); atlas.scissorTest = true;
      renderer.setClearColor(0x00cc00, 1); // 下半绿（three 坐标 y 从底起）
      renderQuad();
      atlas.scissorTest = false;
      renderer.setRenderTarget(null);
      show2D(atlas);
      R.atlas = true; R.scissorAtlas = 'pending-visual';
    } catch (e) { note('atlas', e); renderer.setRenderTarget(null); }

    // ===== ② cube RT + scissor =====
    let crt = null;
    try {
      crt = new THREEw.CubeRenderTarget(64, { format: THREE.RGBAFormat, type: THREE.HalfFloatType });
      for (let f = 0; f < 6; f++) {
        uFace.value = f;
        renderer.setRenderTarget(crt, f);
        renderer.setClearColor(0x880000, 1);
        crt.scissorTest = false;
        renderQuad();
      }
      // face 0 下半条带绿
      uFace.value = 0;
      renderer.setRenderTarget(crt, 0);
      crt.scissor.set(0, 0, 64, 32); crt.scissorTest = true;
      renderer.setClearColor(0x00cc00, 1);
      renderQuad();
      crt.scissorTest = false;
      renderer.setRenderTarget(null);
      showCubeFace(crt, 0);
      R.cube = true; R.scissorCube = 'pending-visual';
    } catch (e) { note('cube', e); renderer.setRenderTarget(null); }

    R.texture3D = true; // bakeColor 里 sampler3D 采样若无编译错误即成立（compileAsync 兜底再验一次）
    R.varFnLoopIf = true;
    try { await renderer.compileAsync(scene, cam); } catch (e) { note('compile', e); R.varFnLoopIf = false; }

    renderer.setClearColor(0x000000, 0);
    console.log('[spike] done', JSON.stringify(R));
    return R;
  } catch (e) {
    note('fatal', e);
    console.log('[spike] fatal', JSON.stringify(R));
    return R;
  }
}
