// Task 3 构件二分第二轮：E~J = 模块里 probe8 未覆盖的独有构造
export async function run() {
  const R = (window.__probe9 = { E: null, F: null, G: null, H: null, I: null, J: null });
  const THREEw = await import('three/webgpu');
  const tsl = await import('three/tsl');
  const THREE = await import('three');
  const { Fn, If, Loop, Discard, uniform, uniformArray, texture3D, uv, vec2, vec3, vec4, float, int, sin, abs, max, min, mix, normalize, dot, exp, smoothstep, clamp, length } = tsl;
  const renderer = window.__p7r;
  const geo = new THREE.PlaneGeometry(2, 2);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const attempt = async (key, build) => {
    try {
      const mat = new THREEw.MeshBasicNodeMaterial();
      mat.colorNode = build();
      const s = new THREE.Scene(); s.add(new THREE.Mesh(geo, mat));
      await renderer.compileAsync(s, cam);
      R[key] = 'ok';
    } catch (e) { R[key] = 'throw: ' + String(e).slice(0, 250); }
  };

  const vals = Array.from({ length: 8 }, () => new THREE.Vector4(1, 2, 3, 4));
  const u4 = uniformArray(vals, 'vec4');
  const uV3 = uniform(new THREE.Vector3(0, 0.2, -1));
  const tex3d = new THREE.Data3DTexture(new Uint16Array(8 * 8 * 8 * 4).fill(15360), 8, 8, 8);
  tex3d.format = THREE.RGBAFormat; tex3d.type = THREE.HalfFloatType;
  tex3d.minFilter = tex3d.magFilter = THREE.LinearFilter;
  tex3d.wrapS = tex3d.wrapT = tex3d.wrapR = THREE.RepeatWrapping;
  tex3d.unpackAlignment = 1; tex3d.needsUpdate = true;

  // E：fine 参数 If + 多次 texture3D 通道运算（lump 形态）
  const fnE = Fn(([p, fine]) => {
    const dc = float(1e9).toVar();
    Loop(8, ({ i }) => {
      const e = u4.element(int(i));
      const sc = e.w;
      const q = p.div(sc.mul(7.5)).add(vec3(float(i).mul(0.37)));
      const lump = texture3D(tex3d, q).r.sub(0.55).mul(-2.4);
      If(fine.greaterThan(0), () => {
        lump.addAssign(texture3D(tex3d, q.mul(2.7).add(0.3)).r.sub(0.55));
        lump.addAssign(texture3D(tex3d, q.mul(7.3).add(0.7)).r.sub(0.55).mul(0.36));
      });
      dc.assign(dc.add(sc.mul(lump)));
    });
    return vec3(dc, float(0), float(1));
  });
  await attempt('E', () => vec4(fnE(vec3(uv(), uv(), 0.5), float(1)).x.mul(0.01), 0, 0, 1));

  // F：sin 波 under 项（精确表达式）
  await attempt('F', () => Fn(() => {
    const sc = float(420);
    const p = vec3(uv().mul(1000), 500);
    const under = sc.mul(
      float(0.55).mul(sin(p.x.div(sc.mul(2.3)).add(float(3))))
        .mul(sin(p.z.div(sc.mul(1.9)).add(1.7)))
        .add(float(0.3).mul(sin(p.x.div(sc.mul(0.9)).add(p.z.div(sc.mul(1.2)))))),
    );
    return vec4(under.mul(0.001), 0, 0, 1);
  })());

  // G：If 回调内 toVar + 无参回调 Loop + and() 守卫
  await attempt('G', () => Fn(() => {
    const out = float(0).toVar();
    If(uV3.x.greaterThan(-1), () => {
      const t = float(1).toVar();
      const hit = float(0).toVar();
      Loop(64, () => {
        If(t.lessThan(1000).and(hit.equal(0)), () => {
          t.addAssign(30);
          If(t.greaterThan(500), () => { hit.assign(1); });
        });
      });
      out.assign(hit);
    });
    return vec4(out, 0, 0, 1);
  })());

  // H：ElseIf 链（uFace 形态）+ vec2 st + Discard 掩码
  const uFace = uniform(0);
  const uStrip = uniform(0);
  await attempt('H', () => Fn(() => {
    const st = vec2(uv().x.mul(2).sub(1), uv().y.mul(2).sub(1));
    const rd = vec3(0, 0, 1).toVar();
    If(uFace.equal(0), () => { rd.assign(vec3(1, st.y.negate(), st.x.negate())); })
      .ElseIf(uFace.equal(1), () => { rd.assign(vec3(-1, st.y.negate(), st.x)); })
      .ElseIf(uFace.equal(2), () => { rd.assign(vec3(st.x, 1, st.y)); })
      .ElseIf(uFace.equal(3), () => { rd.assign(vec3(st.x, -1, st.y.negate())); })
      .ElseIf(uFace.equal(4), () => { rd.assign(vec3(st.x, st.y.negate(), 1)); })
      .Else(() => { rd.assign(vec3(st.x.negate(), st.y.negate(), -1)); });
    const v = uv().y;
    If(v.lessThan(uStrip.div(8)).or(v.greaterThanEqual(uStrip.add(1).div(8))), () => { Discard(); });
    If(rd.y.lessThan(0.002), () => { Discard(); });
    return vec4(abs(rd).mul(0.5), 1);
  })());

  // I：paint 形态克隆（法线 4 探针 + 阴影 2 探针 + Vector3 uniform 颜色）
  const uLit = uniform(new THREE.Vector3(1.2, 1.1, 1.0));
  const uMid = uniform(new THREE.Vector3(0.6, 0.7, 0.85));
  const uLightDir = uniform(new THREE.Vector3(0, 0.2, -1));
  const mapI = Fn(([p, fine]) => {
    const d = float(1e9).toVar();
    Loop(8, ({ i }) => {
      const e = u4.element(int(i));
      const db = length(p.sub(e.xyz)).sub(e.w);
      If(db.greaterThan(0), () => { d.assign(min(d, db.add(150))); }).Else(() => { d.assign(db); });
    });
    return vec3(d, float(0), float(1));
  });
  const paintI = Fn(([p, base, scale]) => {
    const k1 = vec3(1, -1, -1);
    const Ns = normalize(k1.mul(mapI(p.add(k1.mul(scale.mul(1.2))), float(0)).x)
      .add(vec3(-1, -1, 1).mul(mapI(p.add(vec3(-1, -1, 1).mul(scale.mul(1.2))), float(0)).x))
      .add(vec3(-1, 1, -1).mul(mapI(p.add(vec3(-1, 1, -1).mul(scale.mul(1.2))), float(0)).x))
      .add(vec3(1, 1, 1).mul(mapI(p.add(vec3(1, 1, 1).mul(scale.mul(1.2))), float(0)).x)));
    const L = normalize(uLightDir.add(vec3(0, 0.5, 0)).sub(normalize(vec3(p.x, 0, p.z)).mul(0.3)));
    const sh = clamp(mapI(p.add(L.mul(scale.mul(2.6))), float(0)).x.negate().div(scale.mul(0.8)), 0, 1).mul(0.5)
      .add(clamp(mapI(p.add(L.mul(scale.mul(6.5))), float(0)).x.negate().div(scale.mul(1.4)), 0, 1).mul(0.7));
    const up = smoothstep(0, scale.mul(7), p.y.sub(base));
    const light = dot(Ns, L).mul(0.5).add(0.5).mul(exp(sh.negate().mul(1.3)))
      .add(up.mul(0.1)).add(Ns.y.mul(0.1));
    const col = mix(uMid, uLit, smoothstep(0.55, 0.6, light));
    return mix(vec3(0.2, 0.3, 0.5), col, smoothstep(-0.2, 0.5, light));
  });
  await attempt('I', () => vec4(paintI(vec3(uv().mul(1000), 500), float(500), float(420)), 1));

  // J：march 完整克隆（二分细化 + near 描边 + t.toVar 在 If 内）
  const marchJ = Fn(() => {
    const outC = vec4(0, 0, 0, 0).toVar();
    const rdN = normalize(vec3(uv().x.mul(2).sub(1), uv().y.mul(2).sub(1), 1)).toVar();
    const ro = vec3(0, 70, 0);
    If(uV3.x.greaterThan(-2), () => {
      const t = float(230).toVar();
      const tEnd = float(16000).toVar();
      const near = float(1e9).toVar();
      const tNear = t.toVar();
      const hit = float(0).toVar();
      const before = t.toVar();
      Loop(64, () => {
        If(t.lessThan(tEnd).and(hit.equal(0)), () => {
          const d = mapJ(ro.add(rdN.mul(t)));
          If(d.lessThanEqual(0), () => {
            hit.assign(1);
          }).Else(() => {
            If(d.lessThan(near.mul(t)), () => {
              near.assign(d.div(t));
              tNear.assign(t);
            });
            before.assign(t);
            t.addAssign(max(d.mul(0.5), 30));
          });
        });
      });
      const alpha = float(0).toVar();
      const tHit = t.toVar();
      If(hit.equal(1), () => {
        const lo = before.toVar();
        const hi = t.toVar();
        Loop(9, () => {
          const mid = lo.add(hi).mul(0.5);
          If(mapJ(ro.add(rdN.mul(mid))).greaterThan(0), () => { lo.assign(mid); }).Else(() => { hi.assign(mid); });
        });
        tHit.assign(hi);
        alpha.assign(1);
      }).Else(() => {
        If(near.lessThan(0.01), () => {
          tHit.assign(tNear);
          alpha.assign(float(1).sub(near.div(0.01)));
        });
      });
      If(alpha.greaterThan(0), () => {
        outC.assign(vec4(alpha, alpha, alpha, 1));
      });
    });
    return outC;
  });
  const mapJ = (p) => {
    const e = u4.element(int(0));
    return length(p.sub(e.xyz)).sub(e.w);
  };
  await attempt('J', marchJ);

  return R;
}
