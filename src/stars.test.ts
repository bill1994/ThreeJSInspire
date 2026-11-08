import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

import { initStars } from './stars';
import { srgbToLinear } from './sky-track';
import { initFarField } from './far-field';

const lum = (v: readonly number[]): number => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];

describe('initStars', () => {
  it('scene 里多一个 Points（sky_stars）；dispose 移除且 geometry/material dispose 被调', () => {
    const scene = new THREE.Scene();
    const stars = initStars(scene);
    const points = scene.getObjectByName('sky_stars') as THREE.Points;
    expect(points).toBeInstanceOf(THREE.Points);
    const geoSpy = vi.spyOn(points.geometry, 'dispose');
    const matSpy = vi.spyOn(points.material as THREE.PointsMaterial, 'dispose');
    stars.dispose();
    expect(geoSpy).toHaveBeenCalledTimes(1);
    expect(matSpy).toHaveBeenCalledTimes(1);
    expect(scene.getObjectByName('sky_stars')).toBeFalsy();
  });

  it('setOpacity 钳制 [0,1]', () => {
    const scene = new THREE.Scene();
    const stars = initStars(scene);
    const points = scene.getObjectByName('sky_stars') as THREE.Points;
    const mat = points.material as THREE.PointsMaterial;
    stars.setOpacity(2);
    expect(mat.opacity).toBe(1);
    stars.setOpacity(-1);
    expect(mat.opacity).toBe(0);
    stars.setOpacity(0.5);
    expect(mat.opacity).toBe(0.5);
    stars.dispose();
  });

  it('顶点位置种子化：两次 init 逐位一致（采集协议可复现）', () => {
    const a = new THREE.Scene();
    const b = new THREE.Scene();
    const sa = initStars(a);
    const sb = initStars(b);
    const pa = (a.getObjectByName('sky_stars') as THREE.Points).geometry.attributes.position
      .array as Float32Array;
    const pb = (b.getObjectByName('sky_stars') as THREE.Points).geometry.attributes.position
      .array as Float32Array;
    expect(Array.from(pa)).toEqual(Array.from(pb));
    sa.dispose();
    sb.dispose();
  });

  it('材质参数：size 1.8 / sizeAttenuation false / AdditiveBlending / depthWrite false / fog 显式 false / renderOrder -999 / frustumCulled false', () => {
    const scene = new THREE.Scene();
    initStars(scene);
    const points = scene.getObjectByName('sky_stars') as THREE.Points;
    const mat = points.material as THREE.PointsMaterial;
    expect(mat.size).toBe(1.8);
    expect(mat.sizeAttenuation).toBe(false);
    expect(mat.blending).toBe(THREE.AdditiveBlending);
    expect(mat.depthWrite).toBe(false);
    // r186 线性雾是 smoothstep，780 m 处雾因子满格——不关会把整层星点染成雾色
    expect(mat.fog).toBe(false);
    expect(points.renderOrder).toBe(-999);
    expect(points.frustumCulled).toBe(false);
    // 上半球、穹顶之内
    const pos = points.geometry.attributes.position.array as Float32Array;
    expect(pos.length).toBe(900 * 3);
    for (let i = 0; i < pos.length; i += 3) {
      const r = Math.hypot(pos[i], pos[i + 1], pos[i + 2]);
      expect(r).toBeLessThanOrEqual(780.001);
      expect(pos[i + 1]).toBeGreaterThan(0.03 * 780 - 1e-6);
    }
  });

  it('星色 #b9c6ff 线性 Rec709 亮度 < 0.72（0.82 阈值余量充足）', () => {
    expect(lum(srgbToLinear('#b9c6ff'))).toBeLessThan(0.72);
  });
});

describe('far-field 多对象拖动（B4 结构改法——行为断言，不是源码 pin）', () => {
  it('init 星点后 update()：穹顶与星点两个对象的 position.x/z 都等于相机', () => {
    const scene = new THREE.Scene();
    const dome = new THREE.Mesh(new THREE.SphereGeometry(800, 8, 6));
    dome.name = 'sky_sunset_tsl';
    scene.add(dome);
    initStars(scene);
    const far = initFarField(scene);
    far.update(-50, 100, 30);
    expect(dome.position.x).toBe(-50);
    expect(dome.position.z).toBe(100);
    const pts = scene.getObjectByName('sky_stars') as THREE.Points;
    expect(pts.position.x).toBe(-50);
    expect(pts.position.z).toBe(100);
    // followed 汇报改数组形
    expect(far.followed).toEqual({ towed: ['sky_sunset_tsl', 'sky_stars'] });
    far.dispose();
  });
});
