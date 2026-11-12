/**
 * Aircraft loader: the asset is allowed to be missing, slow or corrupt — the scene must still
 * fly something. These run in node, where every GLB request fails, which is exactly the
 * "missing/corrupt GLB" review gate.
 */
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { initPlane, propOpacity01, propSpinRate, PROP_OPACITY_MIN, PROP_OPACITY_MAX, PROP_SPIN_IDLE, PROP_SPIN_FULL } from './plane';

function meshCount(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) n += 1;
  });
  return n;
}

describe('plane loader', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to a visible placeholder when the GLB cannot be loaded', async () => {
    const scene = new THREE.Scene();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const plane = await initPlane(scene);

    expect(scene.children).toContain(plane.group);
    expect(meshCount(plane.group)).toBeGreaterThan(6);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('placeholder'));
    // the placeholder has to be named for the QA/visual checks to find it
    expect(plane.group.getObjectByName('porco_placeholder')).toBeTruthy();
    // …and carry the livery, not an untextured grey blob
    const fuselage = plane.group.getObjectByName('fuselage_body') as THREE.Mesh;
    expect((fuselage.material as THREE.MeshStandardMaterial).name).toBe('livery_white');

    plane.dispose();
    expect(scene.children).not.toContain(plane.group);
  });

  it('keeps the nose +Z -> world -Z conversion on the inner model node', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scene = new THREE.Scene();
    const plane = await initPlane(scene);
    const model = plane.group.getObjectByName('porco_model');
    expect(model).toBeTruthy();
    expect(model?.rotation.y).toBeCloseTo(Math.PI, 6);
    plane.dispose();
  });

  it('ignores non-finite attitude values instead of producing NaN transforms', async () => {    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scene = new THREE.Scene();
    const plane = await initPlane(scene);

    plane.setBank(Number.NaN);
    plane.setPitch(Number.POSITIVE_INFINITY);
    plane.setYaw(Number.NaN);
    plane.group.traverse((o) => {
      expect(Number.isFinite(o.rotation.x)).toBe(true);
      expect(Number.isFinite(o.rotation.y)).toBe(true);
      expect(Number.isFinite(o.rotation.z)).toBe(true);
    });

    plane.setBank(0.6);
    plane.setPitch(-0.25);
    plane.setYaw(1.1);
    expect(plane.group.rotation.y).toBeCloseTo(1.1, 6);
    plane.dispose();
  });
});

describe('prop feedback (P1-2: blur disc opacity + spin follow the throttle)', () => {
  it('pins the opacity and spin anchors', () => {
    expect(PROP_OPACITY_MIN).toBe(0.1);
    expect(PROP_OPACITY_MAX).toBe(0.35);
    expect(PROP_SPIN_IDLE).toBe(6);
    expect(PROP_SPIN_FULL).toBe(46);
    expect(propOpacity01(0)).toBeCloseTo(0.1, 9);
    expect(propOpacity01(1)).toBeCloseTo(0.35, 9);
    expect(propOpacity01(0.5)).toBeCloseTo(0.225, 9);
    expect(propOpacity01(Number.NaN)).toBeCloseTo(0.1, 9);
    expect(propSpinRate(0)).toBeCloseTo(6, 9);
    expect(propSpinRate(1)).toBeCloseTo(46, 9);
    expect(propSpinRate(Number.NaN)).toBeCloseTo(6, 9);
  });

  it('spins the blades and breathes the disc with the throttle', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scene = new THREE.Scene();
    const plane = await initPlane(scene);
    const spin = plane.group.getObjectByName('prop_spin');
    expect(spin).toBeTruthy();

    plane.setProp(1, 0.1);
    expect(spin!.rotation.z).toBeCloseTo(4.6, 6); // 46 rad/s x 0.1 s (dt clamps like the frame's DT_CLAMP)
    plane.setProp(0, 0.1);
    expect(spin!.rotation.z).toBeCloseTo(5.2, 6); // + idle 6 rad/s x 0.1 s
    const disc = plane.group.getObjectByName('prop_blade_0') as THREE.Mesh;
    expect((disc.material as THREE.MeshStandardMaterial).opacity).toBeCloseTo(0.1, 9);
    plane.setProp(1, 0);
    expect((disc.material as THREE.MeshStandardMaterial).opacity).toBeCloseTo(0.35, 9);
    plane.dispose();
  });

  it('drives blades via a synthesized pivot when the GLB has no prop_spin (FLT-01)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scene = new THREE.Scene();
    const plane = await initPlane(scene);
    const spin = plane.group.getObjectByName('prop_spin');
    spin?.parent?.remove(spin); // 模拟 GLB 换装吞掉占位 prop 组
    // 真 GLB 的节点拓扑：三节点松挂在场景根、没有 prop_spin 包装（实测
    // porco-fighter-v002.glb：spinner t=[0,0.25,4.62]、blades t=[0,0.25,4.34]，
    // 自旋轴 = GLB 世界 Z 过 (0,0.25) 线）。占位机的桨叶是 prop_spin 的子节点，
    // remove 时已一起消失，兜底要找的锚点得在这里重新摆上。
    const standIn = (name: string, z: number): THREE.Mesh => {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, 1.8, 0.04),
        new THREE.MeshStandardMaterial(),
      );
      m.name = name;
      m.position.set(0, 0.25, z);
      plane.group.add(m);
      return m;
    };
    standIn('prop_spinner', 4.62);
    standIn('prop_blade_0', 4.34);
    standIn('prop_blade_1', 4.34);
    plane.setProp(1, 0.1);
    const pivot = plane.group.getObjectByName('prop_spin');
    expect(pivot).not.toBeNull(); // 兜底建出了 pivot
    const b0 = plane.group.getObjectByName('prop_blade_0') as THREE.Mesh;
    expect(b0.parent).toBe(pivot);
    expect(pivot!.rotation.z).not.toBe(0);
    expect((b0.material as THREE.MeshStandardMaterial).opacity).toBeCloseTo(0.35, 9);
    plane.setProp(Number.NaN, Number.NaN);
    expect(Number.isFinite(pivot!.rotation.z)).toBe(true); // NaN 不转不写坏
    plane.dispose();
  });

  it('stays a true no-op and warns once when the asset has no prop nodes at all', async () => {
    const scene = new THREE.Scene();
    const plane = await initPlane(scene);
    // spy 要装在 initPlane 之后：启动路径本来就 warn 一次（GLB missing、占位机），
    // 装在前面会把这条无关 warn 数进断言，warn-once 就测不到了。
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spin = plane.group.getObjectByName('prop_spin');
    spin?.parent?.remove(spin); // 连 prop_blade_* 一起消失
    plane.setProp(0.7, 0.016);
    plane.setProp(0.7, 0.016);
    // three 的 getObjectByName 找不到时返回 undefined，不是 null
    expect(plane.group.getObjectByName('prop_spin')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    plane.dispose();
  });
});
