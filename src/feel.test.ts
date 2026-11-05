import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { updateTrauma, shakeSample, TRAUMA_DECAY, SHAKE_MAX, initFeel, SKIM_WAKE } from './feel';

describe('updateTrauma', () => {
  it('decays a stretched trauma value toward rest and clamps at 0', () => {
    let t = 0.8;
    for (let i = 0; i < 600; i += 1) t = updateTrauma(t, 1 / 60);
    expect(t).toBe(0);
    expect(updateTrauma(0.5, 0)).toBe(0.5);
    expect(updateTrauma(0.5, 10)).toBe(0);
    expect(TRAUMA_DECAY).toBeGreaterThan(0);
  });

  it('clamps incoming trauma into 0..1 so stacked hits cannot exceed full shake', () => {
    expect(updateTrauma(4, 0)).toBe(1);
    expect(updateTrauma(-3, 0)).toBe(0);
  });

  it('sanitizes NaN trauma and NaN dt', () => {
    expect(updateTrauma(Number.NaN, 1 / 60)).toBe(0);
    expect(updateTrauma(0.6, Number.NaN)).toBe(0.6);
  });
});

describe('shakeSample', () => {
  it('is exactly zero at rest so the camera never drifts', () => {
    const out = { x: 1, y: 1, z: 1 };
    shakeSample(0, 12.3, out);
    expect(out).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('stays bounded by trauma^2 * SHAKE_MAX', () => {
    const out = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 400; i += 1) {
      shakeSample(1, i * 0.05, out);
      expect(Math.hypot(out.x, out.y, out.z)).toBeLessThanOrEqual(SHAKE_MAX * 1.001);
      expect([out.x, out.y, out.z].every((n) => Number.isFinite(n))).toBe(true);
    }
  });

  it('scales quadratically: a small hit barely moves the camera', () => {
    const small = { x: 0, y: 0, z: 0 };
    const big = { x: 0, y: 0, z: 0 };
    let smallPeak = 0;
    let bigPeak = 0;
    for (let i = 0; i < 400; i += 1) {
      shakeSample(0.2, i * 0.05, small);
      shakeSample(0.9, i * 0.05, big);
      smallPeak = Math.max(smallPeak, Math.hypot(small.x, small.y, small.z));
      bigPeak = Math.max(bigPeak, Math.hypot(big.x, big.y, big.z));
    }
    expect(bigPeak).toBeGreaterThan(smallPeak * 4);
  });
});

describe('skim wake', () => {
  const tips = { leftTip: { x: -4, y: 7, z: 0 }, rightTip: { x: 4, y: 7, z: 0 } };

  const step = (feel: ReturnType<typeof initFeel>, skim01: number): void => {
    for (let i = 0; i < 8; i += 1) {
      feel.update(1 / 60, { speed01: 0.5, bank: 0, stall01: 0, skim01, ...tips });
    }
  };

  it('throws a foam wake behind the aircraft while it rides the deck', () => {
    const scene = new THREE.Scene();
    const feel = initFeel(scene);
    const mesh = scene.getObjectByName('porco_skim_wake') as THREE.Mesh | undefined;
    expect(mesh).toBeDefined();

    step(feel, 1);
    expect(mesh!.geometry.drawRange.count).toBeGreaterThan(0);
    feel.dispose();
  });

  it('leaves no wake while the aircraft is high above the water', () => {
    const scene = new THREE.Scene();
    const feel = initFeel(scene);
    const mesh = scene.getObjectByName('porco_skim_wake') as THREE.Mesh | undefined;

    step(feel, 0);
    expect(mesh!.geometry.drawRange.count).toBe(0);
    feel.dispose();
  });

  it('tints the wake with the sea foam, not the contrail white', () => {
    const scene = new THREE.Scene();
    const feel = initFeel(scene);
    const mesh = scene.getObjectByName('porco_skim_wake') as THREE.Mesh | undefined;

    step(feel, 1);
    const col = mesh!.geometry.getAttribute('color') as THREE.BufferAttribute;
    // The intent is "the wake carries the sea's foam colour, which is warm", not "red is
    // exactly 1": that literal broke the moment the sea palette was re-graded darker
    // (Task 7). Assert the relationship the tint is supposed to have — warm, and not the
    // blue-white of a contrail.
    const r = col.getX(0);
    const g = col.getY(0);
    const b = col.getZ(0);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    expect(r).toBeGreaterThan(0.75);
    feel.dispose();
  });

  it('lays the wake on the water rather than at the aircraft altitude', () => {
    const scene = new THREE.Scene();
    const feel = initFeel(scene);
    const mesh = scene.getObjectByName('porco_skim_wake') as THREE.Mesh | undefined;

    step(feel, 1);
    const pos = mesh!.geometry.getAttribute('position') as THREE.BufferAttribute;
    expect(pos.count).toBeGreaterThan(0);
    // The tips are at y = 7; a wake anchored there floated a slab in mid-air.
    for (let i = 0; i < pos.count; i += 1) {
      expect(pos.getY(i)).toBeLessThan(2);
      expect(pos.getY(i)).toBeGreaterThan(-1);
    }
    feel.dispose();
  });

  it('exposes the activation threshold', () => {
    expect(SKIM_WAKE).toBeGreaterThan(0);
    expect(SKIM_WAKE).toBeLessThan(1);
  });
});
