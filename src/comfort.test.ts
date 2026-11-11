import * as THREE from 'three';
import { describe, it, expect } from 'vitest';
import {
  comfortFromQuery,
  comfortDefault,
  COMFORT_SHAKE_REDUCED,
  COMFORT_WHITEOUT_REDUCED,
} from './comfort';
import { whiteout01, WHITEOUT_MAX } from './in-cloud';
import { initFeel } from './feel';

describe('comfort switches (P1-3: reduce shake / reduce flash)', () => {
  it('pins the reduced anchors against the live caps', () => {
    expect(COMFORT_SHAKE_REDUCED).toBe(0.4);
    expect(COMFORT_WHITEOUT_REDUCED).toBe(0.25);
    expect(WHITEOUT_MAX).toBe(0.45);
  });

  it('defaults to full shake + full whiteout', () => {
    expect(comfortDefault()).toEqual({ shakeScale: 1, whiteoutMax: 0.45 });
    expect(comfortFromQuery('')).toEqual({ shakeScale: 1, whiteoutMax: 0.45 });
    expect(comfortFromQuery('?')).toEqual({ shakeScale: 1, whiteoutMax: 0.45 });
  });

  it('reads the two switches independently', () => {
    expect(comfortFromQuery('?shake=reduced')).toEqual({ shakeScale: 0.4, whiteoutMax: 0.45 });
    expect(comfortFromQuery('?flash=reduced')).toEqual({ shakeScale: 1, whiteoutMax: 0.25 });
    expect(comfortFromQuery('?shake=reduced&flash=reduced')).toEqual({ shakeScale: 0.4, whiteoutMax: 0.25 });
  });

  it('treats anything but the exact word as absent (no accidental full shake)', () => {
    expect(comfortFromQuery('?shake=0').shakeScale).toBe(1);
    expect(comfortFromQuery('?shake=off').shakeScale).toBe(1);
    expect(comfortFromQuery('?shake=REDUCED').shakeScale).toBe(1);
    expect(comfortFromQuery('?flash=0').whiteoutMax).toBe(0.45);
    expect(comfortFromQuery('?shake=').shakeScale).toBe(1);
  });

  it('caps the whiteout through the second parameter', () => {
    expect(whiteout01(1)).toBeCloseTo(0.45, 9);
    expect(whiteout01(1, 0.25)).toBeCloseTo(0.25, 9);
    expect(whiteout01(0.5, 0.25)).toBeCloseTo(0.125, 9);
    expect(whiteout01(1, Number.NaN)).toBeCloseTo(0.45, 9);
    expect(whiteout01(0)).toBe(0);
  });

  it('scales every shake source at the single choke point', () => {
    const mk = (): { feel: ReturnType<typeof initFeel>; scene: THREE.Scene } => {
      const scene = new THREE.Scene();
      return { scene, feel: initFeel(scene) };
    };
    const tips = { leftTip: { x: -4, y: 7, z: 0 }, rightTip: { x: 4, y: 7, z: 0 } };
    const a = mk();
    const b = mk();
    b.feel.setShakeScale(0.4);
    // Same trauma hit + same frames on both handles: identical clocks, so the
    // only difference is the scale.
    for (let i = 0; i < 10; i += 1) {
      a.feel.addTrauma(0.1);
      b.feel.addTrauma(0.1);
      const ctx = { speed01: 0.5, bank: 0.3, stall01: 0.2, skim01: 0.6, ...tips };
      a.feel.update(1 / 60, ctx);
      b.feel.update(1 / 60, ctx);
    }
    expect(b.feel.shake.x).toBeCloseTo(a.feel.shake.x * 0.4, 9);
    expect(b.feel.shake.y).toBeCloseTo(a.feel.shake.y * 0.4, 9);
    expect(b.feel.shake.z).toBeCloseTo(a.feel.shake.z * 0.4, 9);
    a.feel.dispose();
    b.feel.dispose();
  });
});
