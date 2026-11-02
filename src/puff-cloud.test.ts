import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { CLOUD_BAND } from './clouds-compute';
import {
  PUFF_AMBIENT_AMOUNT,
  PUFF_BAND_THRESHOLDS,
  PUFF_COUNT_HIGH,
  PUFF_LOBE_SHADE_GAIN,
  PUFF_NORMAL_WEIGHT,
  PUFF_RIM,
  initPuffClouds,
  puffAmbientColor,
  puffBandIndex,
  puffShadowBandColor,
} from './puff-cloud';
import {
  PUFF_BEHIND_MARGIN,
  PUFF_FADE_FAR,
  PUFF_FADE_NEAR,
  PUFF_FIELD_DEPTH,
  PUFF_SCATTER,
  PUFF_X_SPAN,
  PuffSize,
  fadeForDistance,
  puffGridCells,
  puffScatter,
  wrapPuffZ,
} from './puff-field';
import { CLOUD_PALETTE } from './palettes';
import { PUFF_DEFAULT_DETAIL, PUFF_VARIANTS, buildPuffGeometry, mulberry32 } from './puff-shape';

const SUN = new THREE.Vector3(60, 35, -280).normalize();

/** 14 朵按几何上限缩放后的现实尺寸：halfH 40 落在 [48,55] 的可行带里。 */
function makeSizes(count: number = PUFF_COUNT_HIGH): PuffSize[] {
  return Array.from({ length: count }, () => ({ halfW: 25, halfH: 40, s: 2.1 }));
}

/** 环面 dz：跨接缝取短边，专文 §4 第 2 条要求按这个距离断言。 */
function toroidalDz(a: number, b: number): number {
  const d = Math.abs(a - b) % PUFF_FIELD_DEPTH;
  return Math.min(d, PUFF_FIELD_DEPTH - d);
}

function assertGaps(spots: { x: number; y: number; z: number }[]): void {
  const minGap = PUFF_SCATTER.GAP_MARGIN * 2 * 25;
  for (let i = 0; i < spots.length; i += 1) {
    for (let j = i + 1; j < spots.length; j += 1) {
      const dx = spots[i].x - spots[j].x;
      const dz = toroidalDz(spots[i].z, spots[j].z);
      expect(Math.hypot(dx, dz)).toBeGreaterThanOrEqual(minGap - 1e-9);
    }
  }
}

describe('puffScatter (scatter invariants)', () => {
  const sizes = makeSizes();

  it('1. is deterministic for one seed and differs across seeds', () => {
    expect(puffScatter(7, sizes)).toEqual(puffScatter(7, sizes));
    expect(puffScatter(7, sizes)).not.toEqual(puffScatter(8, sizes));
  });

  it('2. keeps the minimum gap between every pair, including across the z seam', () => {
    assertGaps(puffScatter(7, sizes));
  });

  it('3. never punches through the sea', () => {
    for (const [i, spot] of puffScatter(7, sizes).entries()) {
      expect(spot.y - sizes[i].halfH).toBeGreaterThanOrEqual(PUFF_SCATTER.SEA_CLEAR - 1e-9);
    }
  });

  it('4. never punches through the cloud deck', () => {
    for (const [i, spot] of puffScatter(7, sizes).entries()) {
      expect(spot.y + sizes[i].halfH).toBeLessThanOrEqual(CLOUD_BAND.bottom + 1e-9);
    }
  });

  it('5. stays inside the cruise corridor', () => {
    for (const spot of puffScatter(7, sizes)) {
      expect(Math.abs(spot.x)).toBeLessThanOrEqual(PUFF_X_SPAN);
      expect(spot.z).toBeLessThanOrEqual(0);
      expect(spot.z).toBeGreaterThanOrEqual(-PUFF_FIELD_DEPTH);
    }
  });

  it('6. clears the spawn point by radius, not by shoving the cloud aside', () => {
    for (const spot of puffScatter(7, sizes)) {
      expect(Math.hypot(spot.x, spot.z)).toBeGreaterThanOrEqual(PUFF_SCATTER.SPAWN_CLEAR - 1e-9);
    }
  });

  it('7. lands the occupancy rate inside the readable band', () => {
    const placed = puffScatter(7, sizes).length;
    const grid = puffGridCells(PUFF_SCATTER.GAP_MARGIN * 2 * 25);
    const rate = placed / (grid.cellsX * grid.cellsZ);
    expect(rate).toBeGreaterThanOrEqual(0.12);
    expect(rate).toBeLessThanOrEqual(0.35);
  });

  it('8. keeps the gaps after wrapPuffZ recycling at any flight distance', () => {
    const spots = puffScatter(7, sizes);
    for (const planeZ of [0, -500, -1500, -3777]) {
      const wrapped = spots.map((s) => ({ ...s, z: wrapPuffZ(s.z, planeZ) }));
      assertGaps(wrapped);
    }
  });

  it('9. throws on a size that cannot fit under the deck instead of returning NaN', () => {
    // halfH 50 needs band [58, 45] — empty. The caller must re-scale, not the scatter clamp.
    expect(() => puffScatter(7, [{ halfW: 25, halfH: 50, s: 2.6 }])).toThrow();
  });

  it('hides half the field for the low tier and the rest still satisfies every safety invariant', () => {
    // 低档只藏不重建：剩下那半的位置一字未动，几何安全性必须原样成立。
    // （占位率是整幅布局的构图性质，不属于可见性子集——见 ledger 裁决。）
    const all = puffScatter(7, sizes);
    const half = all
      .map((spot, i) => ({ spot, size: sizes[i] }))
      .filter((_, i) => i % 2 === 0)
      .map(({ spot }) => spot);
    const halfSizes = sizes.filter((_, i) => i % 2 === 0);
    for (const [i, spot] of half.entries()) {
      expect(spot.y - halfSizes[i].halfH).toBeGreaterThanOrEqual(PUFF_SCATTER.SEA_CLEAR - 1e-9);
      expect(spot.y + halfSizes[i].halfH).toBeLessThanOrEqual(CLOUD_BAND.bottom + 1e-9);
      expect(Math.abs(spot.x)).toBeLessThanOrEqual(PUFF_X_SPAN);
      expect(Math.hypot(spot.x, spot.z)).toBeGreaterThanOrEqual(PUFF_SCATTER.SPAWN_CLEAR - 1e-9);
    }
    assertGaps(half);
    for (const planeZ of [0, -1500]) {
      const wrapped = half.map((s) => ({ ...s, z: wrapPuffZ(s.z, planeZ) }));
      assertGaps(wrapped);
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
  it('merges into one non-empty geometry with grey shade jitter in the vertex colours', async () => {
    const geo = await buildPuffGeometry(mulberry32(3), 'bank', 1);
    expect(geo.attributes.position.count).toBeGreaterThan(0);
    expect(geo.attributes.normal.count).toBe(geo.attributes.position.count);
    expect(geo.attributes.color.count).toBe(geo.attributes.position.count);
    expect(geo.boundingSphere?.radius ?? 0).toBeGreaterThan(5);
    // 顶点色只剩灰阶抖动（分档在片元 stage）：0.985 + rand*0.03，三通道同值。
    const color = geo.attributes.color as THREE.BufferAttribute;
    for (let i = 0; i < Math.min(color.count, 50); i += 1) {
      for (const ch of [color.getX(i), color.getY(i), color.getZ(i)]) {
        expect(Number.isFinite(ch)).toBe(true);
        expect(ch).toBeGreaterThanOrEqual(0.9);
        expect(ch).toBeLessThanOrEqual(1.02);
      }
    }
    geo.dispose();
  });

  it('clamps silly detail instead of throwing', async () => {
    const tiny = await buildPuffGeometry(mulberry32(3), 'bank', 0);
    expect(tiny.attributes.position.count).toBeGreaterThan(0);
    tiny.dispose();
  });

  /**
   * ref-01 reads as a VERTICAL stack of large lobes. The old build fanned small
   * blobs along X and squashed them 0.62 on Y, which rendered as a wide faceted
   * potato that filled half the frame. These bounds stop it drifting back.
   */
  it('builds a taller-than-wide, large-lobed cloud', async () => {
    const geo = await buildPuffGeometry(mulberry32(5), 'tower', 1);
    geo.computeBoundingBox();
    const size = new THREE.Vector3();
    geo.boundingBox!.getSize(size);
    expect(size.y / size.x).toBeGreaterThan(1.15);
    expect(size.y / size.x).toBeLessThan(2.2);
    expect(size.y).toBeGreaterThan(PUFF_VARIANTS.tower.width * 1.15);
    // a real 3D body, not a flat card
    expect(size.z).toBeGreaterThan(PUFF_VARIANTS.tower.width * 0.45);
    geo.dispose();
  });

  it('bakes only the grey shade jitter into vertex colours — banding lives in the fragment stage', async () => {
    // 顶点色分档的硬边界只能沿三角面拓扑走，近距离出多边形色阶（puff-v3-hero）。
    // 分档挪进 colorNode 后，顶点色只剩破平涂塑料感的灰阶抖动。
    const g = await buildPuffGeometry(mulberry32(3), 'bank', 1);
    const color = g.attributes.color as THREE.BufferAttribute;
    expect(color.count).toBe(g.attributes.position.count);
    for (let i = 0; i < color.count; i += 1) {
      const r = color.getX(i);
      const gr = color.getY(i);
      const b = color.getZ(i);
      expect(r).toBeCloseTo(gr, 6);
      expect(gr).toBeCloseTo(b, 6);
      expect(r).toBeGreaterThanOrEqual(0.9);
      expect(r).toBeLessThanOrEqual(1.02);
    }
    g.dispose();
  });

  it('tessellates every lobe finely enough to hide at close range', async () => {
    const coarse = await buildPuffGeometry(mulberry32(9), 'bank', 1);
    const fine = await buildPuffGeometry(mulberry32(9), 'bank', 2);
    // three subdivides each icosahedron face (detail+1)^2 times: 80 faces at 1,
    // 180 at 2 -- a 2.25x vertex count, not the naive 4x.
    expect(fine.attributes.position.count).toBeGreaterThan(coarse.attributes.position.count * 2);
    expect(PUFF_DEFAULT_DETAIL).toBeGreaterThanOrEqual(2);
    coarse.dispose();
    fine.dispose();
  });
});

describe('puffBandIndex', () => {
  it('cuts exactly at the exported thresholds the fragment stage reads', () => {
    // 分档挪进片元着色后，JS 镜像和 TSL 图必须读同一组阈值：这份导出就是合约。
    expect(PUFF_BAND_THRESHOLDS).toEqual([0.2, 0.5, 0.76]);
    expect(puffBandIndex(PUFF_BAND_THRESHOLDS[0] - 1e-6)).toBe(0);
    expect(puffBandIndex(PUFF_BAND_THRESHOLDS[0])).toBe(1);
    expect(puffBandIndex(PUFF_BAND_THRESHOLDS[1] - 1e-6)).toBe(1);
    expect(puffBandIndex(PUFF_BAND_THRESHOLDS[1])).toBe(2);
    expect(puffBandIndex(PUFF_BAND_THRESHOLDS[2] - 1e-6)).toBe(2);
    expect(puffBandIndex(PUFF_BAND_THRESHOLDS[2])).toBe(3);
  });

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

  it('treats the scatter count as a target: fewer placed clouds boot instead of crashing', async () => {
    // puffScatter 的净空剔除是「剔除不是平移」，返回数可能少于请求——调用方必须
    // 接受不足而不是 spots[i] 直接踩 undefined（评审最终轮 Important #1）。
    // 请求数必须留在网格容量之内（容量随云宽变化：bank 变宽后格子变少，旧的 58 已经越界）。
    const scene = new THREE.Scene();
    const puffs = await initPuffClouds(scene, 7, 30);
    const group = scene.getObjectByName('puff-field');
    expect(group).toBeTruthy();
    expect(group!.children.length).toBeGreaterThan(0);
    expect(group!.children.length).toBeLessThanOrEqual(30);
    puffs.dispose();
    expect(scene.getObjectByName('puff-field')).toBeFalsy();
  });
});

function lstar(c: THREE.Color): number {
  const hex = c.getHexString();
  const chan = (i: number): number => {
    const v = parseInt(hex.slice(i * 2, i * 2 + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const y = 0.2126 * chan(0) + 0.7152 * chan(1) + 0.0722 * chan(2);
  return 116 * Math.cbrt(y) - 16;
}

describe('puff ambient fill', () => {
  it('填充色从 SKY_PALETTE 派生，比 shadow 亮至少 6 L*', () => {
    const amb = puffAmbientColor();
    expect(lstar(amb)).toBeGreaterThanOrEqual(lstar(new THREE.Color(CLOUD_PALETTE.shadow)) + 6);
  });

  it('派生不修改 CLOUD_PALETTE', () => {
    const before = JSON.stringify(CLOUD_PALETTE);
    puffAmbientColor();
    puffShadowBandColor();
    expect(JSON.stringify(CLOUD_PALETTE)).toBe(before);
  });

  it('环境光整体抬亮，但不把暗档顶到 base 之上', () => {
    const shadow = lstar(new THREE.Color(CLOUD_PALETTE.shadow));
    const base = lstar(new THREE.Color(CLOUD_PALETTE.base));
    const band0 = lstar(puffShadowBandColor());
    expect(band0).toBeGreaterThan(shadow + 4);
    expect(band0).toBeLessThan(base + 12);
  });

  it('逐瓣法线权重降到 0.10，且这组常量被导出', () => {
    expect(PUFF_NORMAL_WEIGHT).toBe(0.10);
    expect(PUFF_LOBE_SHADE_GAIN).toBeGreaterThan(0);
    expect(PUFF_AMBIENT_AMOUNT).toBeGreaterThan(0);
    expect(PUFF_AMBIENT_AMOUNT).toBeLessThan(0.3);
    expect(PUFF_RIM.power).toBeGreaterThan(1);
  });
});
