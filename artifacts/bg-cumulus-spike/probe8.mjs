// Task 3 构件二分：A uniformArray+element / B +texture3D / C +smin链 / D bgMap 完整克隆
export async function run() {
  const R = (window.__probe8 = { A: null, B: null, C: null, D: null });
  const THREEw = await import('three/webgpu');
  const tsl = await import('three/tsl');
  const THREE = await import('three');
  const { Fn, If, Loop, uniform, uniformArray, texture3D, vec3, vec4, float, int, uv, length, min, max, abs } = tsl;
  const renderer = window.__p7r;
  if (!renderer) throw new Error('no p7 renderer');
  const geo = new THREE.PlaneGeometry(2, 2);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const attempt = async (key, build) => {
    try {
      const mat = new THREEw.MeshBasicNodeMaterial();
      mat.colorNode = build();
      const s = new THREE.Scene(); s.add(new THREE.Mesh(geo, mat));
      await renderer.compileAsync(s, cam);
      R[key] = 'ok';
    } catch (e) { R[key] = 'throw: ' + String(e).slice(0, 200); }
  };

  const vals = Array.from({ length: 8 }, () => new THREE.Vector4(1, 2, 3, 4));
  const u4 = uniformArray(vals, 'vec4');
  const uCount = uniform(3);
  const tex3d = new THREE.Data3DTexture(new Uint16Array(8 * 8 * 8 * 4).fill(15360), 8, 8, 8);
  tex3d.format = THREE.RGBAFormat; tex3d.type = THREE.HalfFloatType;
  tex3d.minFilter = tex3d.magFilter = THREE.LinearFilter;
  tex3d.wrapS = tex3d.wrapT = tex3d.wrapR = THREE.RepeatWrapping;
  tex3d.unpackAlignment = 1; tex3d.needsUpdate = true;

  await attempt('A', () => Fn(() => {
    const acc = float(0).toVar();
    Loop(8, ({ i }) => {
      If(float(i).lessThan(uCount), () => {
        const e = u4.element(int(i));
        acc.addAssign(e.x.mul(0.1));
      });
    });
    return vec4(acc, 0, 0, 1);
  })());

  await attempt('B', () => Fn(() => {
    const s = texture3D(tex3d, vec3(uv(), float(0.5)));
    return vec4(s.xyz, 1);
  })());

  await attempt('C', () => Fn(() => {
    const dc = float(1e9).toVar();
    Loop(8, ({ j }) => {
      const e = u4.element(int(j));
      const d = length(vec3(e.x, e.y, e.z).sub(vec3(1, 2, 3))).sub(e.w);
      const k = e.w.mul(0.55);
      const h = max(k.sub(abs(d.sub(0))), 0).div(k);
      dc.assign(min(dc, d.sub(h.mul(h).mul(k).mul(0.25))));
    });
    return vec4(dc.mul(0.01), 0, 0, 1);
  })());

  // D：bgMap 形态克隆（Fn 数组布局 + element(int(i)) + If/Else 嵌套 + texture3D 在 Else 里）
  const bgMapClone = Fn(([p]) => {
    const d = float(1e9).toVar();
    Loop(8, ({ i }) => {
      const cl = u4.element(int(i));
      const db = length(p.sub(cl.xyz)).sub(cl.w);
      If(float(i).lessThan(uCount), () => {
        If(db.greaterThan(0), () => {
          d.assign(min(d, db.add(150)));
        }).Else(() => {
          const q = p.div(cl.w.mul(7.5)).add(vec3(float(i).mul(0.37)));
          const s3 = texture3D(tex3d, q);
          d.assign(s3.r.sub(0.55).mul(-2.4));
        });
      });
    });
    return vec3(d, float(0), float(1));
  });
  await attempt('D', () => vec4(bgMapClone(vec3(uv().x, uv().y, 0.5)).x.mul(0.001), 0, 0, 1));

  return R;
}
