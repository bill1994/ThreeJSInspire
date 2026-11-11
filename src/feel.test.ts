import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { updateTrauma, shakeSample, TRAUMA_DECAY, SHAKE_MAX, initFeel, SKIM_WAKE } from './feel';
import {
  RUMBLE_Y_HZ,
  RUMBLE_X_HZ,
  RUMBLE_AMP,
  RUMBLE_MIN_MIX,
  CLOUD_BUFFET_HZ,
  CLOUD_BUFFET01,
  CLOUD_SWAY_RAD,
  CLOUD_SWAY_HZ,
  CLOUD_TRACK_RATE,
  CONTRAIL_SPEED,
  CONTRAIL_IDLE_MIN,
  CONTRAIL_IDLE,
  rumbleNoise01,
  seaRumble01,
  wakeStrength,
} from './feel';

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

  it('tints the wake with the foam cream, not the contrail white', () => {
    const scene = new THREE.Scene();
    const feel = initFeel(scene);
    const mesh = scene.getObjectByName('porco_skim_wake') as THREE.Mesh | undefined;

    step(feel, 1);
    const col = mesh!.geometry.getAttribute('color') as THREE.BufferAttribute;
    // The intent is "the wake carries the warm foam colour", not "red is exactly 1": that
    // literal broke the moment the palette was re-graded darker (Task 7). Assert the
    // relationship the tint is supposed to have — warm, and not the blue-white of a
    // contrail.
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

describe('P0-2 sea rumble (continuous deck chop, never trauma)', () => {
  const tips = { leftTip: { x: -4, y: 7, z: 0 }, rightTip: { x: 4, y: 7, z: 0 } };
  const DT = 1 / 60;

  it('pins the chop frequencies and the amplitude window', () => {
    expect(RUMBLE_Y_HZ).toBe(13);
    expect(RUMBLE_X_HZ).toBe(17);
    expect(RUMBLE_AMP).toBe(0.16);
    expect(RUMBLE_MIN_MIX).toBe(0.625); // 0.625 x 0.16 = 0.10, the spec floor
  });

  it('gates the rumble on the skim: silence at altitude, chop on the deck', () => {
    expect(seaRumble01(0, 3.7)).toBe(0);
    expect(seaRumble01(Number.NaN, 3.7)).toBe(0);
    for (let i = 0; i < 200; i += 1) {
      const r = seaRumble01(1, i * 0.05);
      expect(r).toBeGreaterThanOrEqual(RUMBLE_MIN_MIX - 1e-9);
      expect(r).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('shakes the camera inside 0.10..0.16 x SHAKE_MAX on the deck, zero up high', () => {
    const scene = new THREE.Scene();
    const feel = initFeel(scene);
    let peakDeck = 0;
    for (let i = 0; i < Math.round(3 / DT); i += 1) {
      feel.update(DT, { speed01: 0, bank: 0, stall01: 0, skim01: 1, ...tips });
      peakDeck = Math.max(peakDeck, Math.abs(feel.shake.y));
    }
    expect(peakDeck).toBeGreaterThan(0.1 * SHAKE_MAX * 0.8);
    expect(peakDeck).toBeLessThanOrEqual(0.16 * SHAKE_MAX + 1e-9);
    feel.dispose();

    const calm = initFeel(scene);
    let peakHigh = 0;
    for (let i = 0; i < Math.round(1 / DT); i += 1) {
      calm.update(DT, { speed01: 0, bank: 0, stall01: 0, skim01: 0, ...tips });
      peakHigh = Math.max(peakHigh, Math.abs(calm.shake.y), Math.abs(calm.shake.x));
    }
    expect(peakHigh).toBe(0);
    calm.dispose();
  });

  it('chops at 13 Hz vertically (zero-crossing count over 2 s)', () => {
    const scene = new THREE.Scene();
    const feel = initFeel(scene);
    let crossings = 0;
    let prev = 0;
    for (let i = 0; i < Math.round(2 / DT); i += 1) {
      feel.update(DT, { speed01: 0, bank: 0, stall01: 0, skim01: 1, ...tips });
      const y = feel.shake.y;
      if (i > 0 && Math.sign(y) !== Math.sign(prev) && y !== 0) crossings += 1;
      prev = y;
    }
    // 13 Hz x 2 s = 26 cycles = 52 crossings; the amplitude breathe never
    // touches zero, so no cycle is lost or gained. Wide band, exact rate varies
    // with the frame grid.
    expect(crossings).toBeGreaterThanOrEqual(40);
    expect(crossings).toBeLessThanOrEqual(64);
    feel.dispose();
  });

  it('never routes the chop through trauma', () => {
    const scene = new THREE.Scene();
    const feel = initFeel(scene);
    feel.addTrauma(0.6);
    for (let i = 0; i < Math.round(1 / DT); i += 1) {
      feel.update(DT, { speed01: 0, bank: 0, stall01: 0, skim01: 1, ...tips });
    }
    expect(feel.trauma01()).toBeLessThan(0.6);
    feel.dispose();
  });

  it('pulses the foam wake 0.45 -> 0.70 with the chop', () => {
    expect(wakeStrength(0, 3.7)).toBe(0);
    for (let i = 0; i < 200; i += 1) {
      const w = wakeStrength(1, i * 0.05);
      expect(w).toBeGreaterThanOrEqual(0.45 - 1e-9);
      expect(w).toBeLessThanOrEqual(0.7 + 1e-9);
    }
    expect(rumbleNoise01(Number.NaN)).toBe(0.5);
  });
});

describe('P0-3 cloud rumble (continuous in-cloud chop)', () => {
  const tips = { leftTip: { x: -4, y: 7, z: 0 }, rightTip: { x: 4, y: 7, z: 0 } };
  const DT = 1 / 60;
  const calmCtx = { speed01: 0, bank: 0, stall01: 0, skim01: 0, cloud01: 0, ...tips };

  it('pins the cloud-chop constants', () => {
    expect(CLOUD_BUFFET_HZ).toBe(23);
    expect(CLOUD_BUFFET01).toBe(0.12);
    expect(CLOUD_SWAY_RAD).toBe(0.06);
    expect(CLOUD_SWAY_HZ).toBe(0.7);
    expect(CLOUD_TRACK_RATE).toBe(3);
  });

  it('climbs toward the cloud target inside and breathes out on exit', () => {
    const scene = new THREE.Scene();
    const feel = initFeel(scene);
    for (let i = 0; i < Math.round(2 / DT); i += 1) {
      feel.update(DT, { ...calmCtx, cloud01: 1 });
    }
    // target at prox 1 is 0.40; 2 s of rate-3 tracking lands on it.
    expect(feel.trauma01()).toBeGreaterThan(0.3);
    expect(feel.trauma01()).toBeLessThanOrEqual(0.41);
    for (let i = 0; i < Math.round(0.5 / DT); i += 1) {
      feel.update(DT, calmCtx);
    }
    // linear decay 1.15/s walks 0.40 back to zero inside half a second.
    expect(feel.trauma01()).toBe(0);
    feel.dispose();
  });

  it('lays a 23 Hz buffet under the shake while inside', () => {
    const scene = new THREE.Scene();
    const feel = initFeel(scene);
    // settle the tracking first so the trauma lane holds still
    for (let i = 0; i < Math.round(2 / DT); i += 1) {
      feel.update(DT, { ...calmCtx, cloud01: 1 });
    }
    // median rising-crossing period over the next 2 s reads the buffet rate
    const rises: number[] = [];
    let prev = 0;
    let peak = 0;
    for (let i = 0; i < Math.round(2 / DT); i += 1) {
      feel.update(DT, { ...calmCtx, cloud01: 1 });
      const y = feel.shake.y;
      peak = Math.max(peak, Math.abs(y));
      if (i > 0 && prev <= 0 && y > 0) rises.push(i);
      prev = y;
    }
    const intervals: number[] = [];
    for (let i = 1; i < rises.length; i += 1) intervals.push(rises[i] - rises[i - 1]);
    intervals.sort((a, b) => a - b);
    const median = intervals[Math.floor(intervals.length / 2)] / 60;
    expect(1 / median).toBeGreaterThan(15);
    expect(1 / median).toBeLessThan(32);
    // the lane is small by design: under the stall buffet, above the noise.
    expect(peak).toBeGreaterThan(0.05 * SHAKE_MAX);
    expect(peak).toBeLessThanOrEqual((0.4 * 0.4 + CLOUD_BUFFET01) * SHAKE_MAX + 1e-6);
    feel.dispose();
  });

  it('sways the visual bank ±0.06 rad at 0.7 Hz, zero outside', () => {
    const scene = new THREE.Scene();
    const feel = initFeel(scene);
    let peak = 0;
    let signFlips = 0;
    let prev = 0;
    for (let i = 0; i < Math.round(3 / DT); i += 1) {
      feel.update(DT, { ...calmCtx, cloud01: 1 });
      const s = feel.bankSway;
      peak = Math.max(peak, Math.abs(s));
      if (i > 0 && Math.sign(s) !== Math.sign(prev) && s !== 0) signFlips += 1;
      prev = s;
    }
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThanOrEqual(0.06 + 1e-9);
    // 0.7 Hz over 3 s ≈ 2 cycles ≈ 4 zero crossings — it genuinely oscillates.
    expect(signFlips).toBeGreaterThanOrEqual(3);
    const out = initFeel(scene);
    out.update(DT, calmCtx);
    expect(out.bankSway).toBe(0);
    feel.dispose();
    out.dispose();
  });
});

describe('contrail idle lane (P0-4 Q3-7)', () => {
  const tips = { leftTip: { x: -4, y: 7, z: 0 }, rightTip: { x: 4, y: 7, z: 0 } };
  const DT = 1 / 60;

  const headAlpha = (scene: THREE.Scene): number => {
    const mesh = scene.getObjectByName('porco_contrail_l') as THREE.Mesh;
    const col = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    return col.getW(0); // newest sample, first vertex
  };

  it('pins the lowered trigger and the idle anchors', () => {
    expect(CONTRAIL_SPEED).toBe(0.55);
    expect(CONTRAIL_IDLE_MIN).toBe(0.15);
    expect(CONTRAIL_IDLE).toBe(0.15);
  });

  it('keeps a whisper trail at cruise instead of popping in past the trigger', () => {
    const scene = new THREE.Scene();
    const feel = initFeel(scene);
    const mesh = scene.getObjectByName('porco_contrail_l') as THREE.Mesh;
    for (let i = 0; i < 60; i += 1) {
      feel.update(DT, { speed01: 0.3, bank: 0, stall01: 0, skim01: 0, ...tips });
    }
    // Before the idle lane this was 0 (0.3 < 0.72 trigger) — cruise flew naked.
    expect(mesh.geometry.drawRange.count).toBeGreaterThan(0);
    const a = headAlpha(scene);
    expect(a).toBeGreaterThan(0.03);
    expect(a).toBeLessThan(0.12);
    feel.dispose();
  });

  it('leaves slow flight clean and keeps the banked trail dominant', () => {
    const scene = new THREE.Scene();
    const feel = initFeel(scene);
    const mesh = scene.getObjectByName('porco_contrail_l') as THREE.Mesh;
    for (let i = 0; i < 60; i += 1) {
      feel.update(DT, { speed01: 0.05, bank: 0, stall01: 0, skim01: 0, ...tips });
    }
    expect(mesh.geometry.drawRange.count).toBe(0);
    for (let i = 0; i < 60; i += 1) {
      feel.update(DT, { speed01: 0.3, bank: 0, stall01: 0, skim01: 0, ...tips });
    }
    const idleA = headAlpha(scene);
    for (let i = 0; i < 60; i += 1) {
      feel.update(DT, { speed01: 0.3, bank: 0.5, stall01: 0, skim01: 0, ...tips });
    }
    // Same speed, banked: the pour-off trail must dwarf the whisper.
    expect(headAlpha(scene)).toBeGreaterThan(idleA * 3);
    feel.dispose();
  });
});
