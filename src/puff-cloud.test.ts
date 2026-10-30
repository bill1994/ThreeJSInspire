import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import {
  PUFF_BEHIND_MARGIN,
  PUFF_COUNT_HIGH,
  PUFF_FADE_FAR,
  PUFF_FADE_NEAR,
  PUFF_FIELD_DEPTH,
  PUFF_SHAPE,
  PUFF_X_SPAN,
  PUFF_Y_MAX,
  PUFF_Y_MIN,
  buildPuffGeometry,
  fadeForDistance,
  initPuffClouds,
  mulberry32,
  puffBandIndex,
  puffLayout,
  wrapPuffZ,
} from './puff-cloud';

const SUN = new THREE.Vector3(60, 35, -280).normalize();

describe('puff layout', () => {
  it('is deterministic for one seed', () => {
    expect(puffLayout(7, PUFF_COUNT_HIGH)).toEqual(puffLayout(7, PUFF_COUNT_HIGH));
  });

  it('differs across seeds', () => {
    expect(puffLayout(7, 4)).not.toEqual(puffLayout(8, 4));
  });

  it('stays inside the cruise corridor', () => {
    for (const s of puffLayout(7, PUFF_COUNT_HIGH)) {
      expect(Math.abs(s.x)).toBeLessThanOrEqual(PUFF_X_SPAN);
      expect(s.y).toBeGreaterThanOrEqual(PUFF_Y_MIN);
      expect(s.y).toBeLessThanOrEqual(PUFF_Y_MAX);
      expect(s.z).toBeLessThanOrEqual(0);
      expect(s.z).toBeGreaterThanOrEqual(-PUFF_FIELD_DEPTH);
    }
  });

  it('mulberry32 never leaves [0, 1)', () => {
    const rand = mulberry32(1);
    for (let i = 0; i < 200; i += 1) {
      const v = rand();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('wrapPuffZ', () => {
  it('pulls a cloud left behind back ahead of the aircraft', () => {
    // 飞机沿 -Z 飞：planeZ=-1000 时 z=-800 的云已在身后搬回 -800-1200。
    expect(wrapPuffZ(-800, -1000)).toBeCloseTo(-800 - PUFF_FIELD_DEPTH, 6);
  });

  it('leaves clouds ahead of the aircraft alone', () => {
    expect(wrapPuffZ(-1100, -1000)).toBe(-1100);
  });

  it('lands huge offsets inside the corridor in one step (no ping-pong)', () => {
    // 之前 guard-8 循环大偏移下一帧跳 8000m 越过走廊来回弹云被甩到几公里外。
    for (const z of [-21770, 5000, -500, -100000]) {
      const out = wrapPuffZ(z, -10770);
      expect(out).toBeGreaterThanOrEqual(-10770 - PUFF_FIELD_DEPTH + PUFF_BEHIND_MARGIN);
      expect(out).toBeLessThan(-10770 + PUFF_BEHIND_MARGIN + 1);
    }
  });

  it('refuses non-finite input instead of teleporting clouds', () => {
    expect(wrapPuffZ(Number.NaN, -1000)).toBeNaN();
    expect(wrapPuffZ(-800, Number.NaN)).toBe(-800);
  });

  it('exposes sane recycle constants', () => {
    expect(PUFF_FIELD_DEPTH).toBe(1000);
    expect(PUFF_BEHIND_MARGIN).toBe(120);
  });
});

describe('fadeForDistance', () => {
  it('is 0 inside the core and 1 past the fade band', () => {
    expect(fadeForDistance(0)).toBe(0);
    expect(fadeForDistance(PUFF_FADE_NEAR)).toBe(0);
    expect(fadeForDistance(PUFF_FADE_FAR)).toBe(1);
    expect(fadeForDistance(500)).toBe(1);
  });

  it('ramps smoothly through the band', () => {
    const mid = fadeForDistance((PUFF_FADE_NEAR + PUFF_FADE_FAR) / 2);
    expect(mid).toBeGreaterThan(0.4);
    expect(mid).toBeLessThan(0.6);
    expect(fadeForDistance(10)).toBeLessThan(fadeForDistance(20));
  });

  it('treats garbage as fully visible rather than hiding the cloud', () => {
    expect(fadeForDistance(Number.NaN)).toBe(1);
  });
});

describe('buildPuffGeometry', () => {
  it('merges into one non-empty geometry with baked toon colors', async () => {
    const geo = await buildPuffGeometry(mulberry32(3), 9, 1);
    expect(geo.attributes.position.count).toBeGreaterThan(0);
    expect(geo.attributes.normal.count).toBe(geo.attributes.position.count);
    expect(geo.attributes.color.count).toBe(geo.attributes.position.count);
    expect(geo.boundingSphere?.radius ?? 0).toBeGreaterThan(5);
    // 烘焙色必须进色域：紫/粉都在 0..1 里。
    const color = geo.attributes.color as THREE.BufferAttribute;
    for (let i = 0; i < Math.min(color.count, 50); i += 1) {
      for (const ch of [color.getX(i), color.getY(i), color.getZ(i)]) {
        expect(Number.isFinite(ch)).toBe(true);
        expect(ch).toBeGreaterThanOrEqual(0);
        expect(ch).toBeLessThanOrEqual(1);
      }
    }
    geo.dispose();
  });

  it('clamps silly blob counts instead of throwing', async () => {
    const tiny = await buildPuffGeometry(mulberry32(3), 0, 0);
    expect(tiny.attributes.position.count).toBeGreaterThan(0);
    tiny.dispose();
  });

  /**
   * ref-01 reads as a VERTICAL stack of large lobes. The old build fanned small
   * blobs along X and squashed them 0.62 on Y, which rendered as a wide faceted
   * potato that filled half the frame. These bounds stop it drifting back.
   */
  it('builds a taller-than-wide, large-lobed cloud', async () => {
    const geo = await buildPuffGeometry(mulberry32(5), 11, 1);
    geo.computeBoundingBox();
    const size = new THREE.Vector3();
    geo.boundingBox!.getSize(size);
    expect(size.y / size.x).toBeGreaterThan(1.15);
    expect(size.y / size.x).toBeLessThan(2.2);
    expect(size.y).toBeGreaterThan(PUFF_SHAPE.width * 1.15);
    // a real 3D body, not a flat card
    expect(size.z).toBeGreaterThan(PUFF_SHAPE.width * 0.45);
    geo.dispose();
  });

  it('tessellates every lobe finely enough to hide at close range', async () => {
    const coarse = await buildPuffGeometry(mulberry32(9), 10, 1);
    const fine = await buildPuffGeometry(mulberry32(9), 10, 2);
    // three subdivides each icosahedron face (detail+1)^2 times: 80 faces at 1,
    // 180 at 2 -- a 2.25x vertex count, not the naive 4x.
    expect(fine.attributes.position.count).toBeGreaterThan(coarse.attributes.position.count * 2);
    expect(PUFF_SHAPE.detail).toBeGreaterThanOrEqual(2);
    coarse.dispose();
    fine.dispose();
  });
});

describe('puffBandIndex', () => {
  it('splits the wrap-lit range into the reference four flat tones', () => {
    expect(puffBandIndex(0)).toBe(0); // 全背光 -> shadow
    expect(puffBandIndex(0.19)).toBe(0);
    expect(puffBandIndex(0.2)).toBe(1); // 云体主色 -> base
    expect(puffBandIndex(0.49)).toBe(1);
    expect(puffBandIndex(0.5)).toBe(2); // 受光侧 -> pink
    expect(puffBandIndex(0.75)).toBe(2);
    expect(puffBandIndex(0.76)).toBe(3); // 向光面 -> gold/奶白
    expect(puffBandIndex(1)).toBe(3);
  });

  it('gives the cloud-body tone the widest band', () => {
    // ref-01's cloud body averages (124,75,141), which is CLOUD_PALETTE.base rather
    // than shadow. Using only shadow/pink/gold turned every cloud into a dark
    // purple blob -- base must own the widest slice of the range.
    const widths = [0.2, 0.5 - 0.2, 0.76 - 0.5, 1 - 0.76];
    expect(Math.max(...widths)).toBe(widths[1]);
  });

  it('refuses non-finite input instead of producing NaN colours', () => {
    // Garbage falls to the shadow tone: a wrong-but-dark band beats a NaN vertex colour.
    expect(puffBandIndex(Number.NaN)).toBe(0);
    expect(puffBandIndex(Number.POSITIVE_INFINITY)).toBe(0);
    expect(puffBandIndex(-5)).toBe(0);
  });
});

describe('puff clouds scene wiring', () => {
  it('adds one group of named meshes and survives update/dispose without a GPU', async () => {
    const scene = new THREE.Scene();
    const puffs = await initPuffClouds(scene, 7, 6);
    expect(puffs.kind).toBe('puff');
    const group = scene.getObjectByName('puff-field');
    expect(group).toBeTruthy();
    expect(group?.children.length).toBe(6);
    for (const child of group?.children ?? []) expect(child.name.startsWith('puff-')).toBe(true);

    for (const t of [0, 0.016, 12.5, 3600]) {
      expect(() => puffs.update(t, SUN)).not.toThrow();
    }
    puffs.setQuality(false);
    expect(group?.children.filter((c) => c.visible).length).toBe(3);
    puffs.setQuality(true);
    expect(group?.children.filter((c) => c.visible).length).toBe(6);

    puffs.dispose();
    expect(scene.getObjectByName('puff-field')).toBeFalsy();
    expect(() => puffs.dispose()).not.toThrow();
  });
});
