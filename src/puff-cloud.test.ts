import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import {
  PUFF_BAND_COLORS,
  PUFF_BAND_THRESHOLDS,
  PUFF_LOBE_SHADE_GAIN,
  PUFF_NORMAL_WEIGHT,
  initPuffClouds,
  puffBandIndex,
} from './puff-cloud';
import { CLOUD_PALETTE } from './palettes';
import { PUFF_DEFAULT_DETAIL, PUFF_VARIANTS, buildPuffGeometry, mulberry32 } from './puff-shape';

const SUN = new THREE.Vector3(60, 35, -280).normalize();
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
    // 阈值按「两半球都读得出层」反解，理由见 PUFF_BAND_THRESHOLDS 的注释。
    expect(PUFF_BAND_THRESHOLDS).toEqual([0.2, 0.4, 0.68]);
    expect(puffBandIndex(PUFF_BAND_THRESHOLDS[0] - 1e-6)).toBe(0);
    expect(puffBandIndex(PUFF_BAND_THRESHOLDS[0])).toBe(1);
    expect(puffBandIndex(PUFF_BAND_THRESHOLDS[1] - 1e-6)).toBe(1);
    expect(puffBandIndex(PUFF_BAND_THRESHOLDS[1])).toBe(2);
    expect(puffBandIndex(PUFF_BAND_THRESHOLDS[2] - 1e-6)).toBe(2);
    expect(puffBandIndex(PUFF_BAND_THRESHOLDS[2])).toBe(3);
  });

  it('splits the wrap-lit range into the reference four flat tones', () => {
    expect(puffBandIndex(0)).toBe(0); // 全背光 -> shadow
    expect(puffBandIndex(0.199)).toBe(0);
    expect(puffBandIndex(0.2)).toBe(1); // 云体主色 -> base
    expect(puffBandIndex(0.399)).toBe(1);
    expect(puffBandIndex(0.4)).toBe(2); // 受光侧 -> pink
    expect(puffBandIndex(0.679)).toBe(2);
    expect(puffBandIndex(0.68)).toBe(3); // 向光面 -> gold
    expect(puffBandIndex(1)).toBe(3);
  });

  it('keeps every step wide enough to read as a plateau', () => {
    // 某一档太窄会在曲面上消失，四档读成三档甚至两档——平涂就散了。
    const [t0, t1, t2] = PUFF_BAND_THRESHOLDS;
    for (const w of [t0, t1 - t0, t2 - t1, 1 - t2]) expect(w).toBeGreaterThan(0.15);
  });

  it('refuses non-finite input instead of producing NaN colours', () => {
    // Garbage falls to the shadow tone: a wrong-but-dark band beats a NaN vertex colour.
    expect(puffBandIndex(Number.NaN)).toBe(0);
    expect(puffBandIndex(Number.POSITIVE_INFINITY)).toBe(0);
    expect(puffBandIndex(-5)).toBe(0);
  });
});

describe('puff band ramp', () => {
  /**
   * 屏幕上的明度：`NeutralToneMapping` 在 max<0.76 时只减一个 offset，
   * 暗端走二次分支（`x - 6.25x²`）、其余走 0.04。**必须过这一层再量**——
   * 直接量 hex 的 L* 会少算 3 L*：那个偏移在暗端抬得更多，把跨度压扁。
   */
  const renderedLstar = (hex: number): number => {
    const c = new THREE.Color(hex); // sRGB -> 线性工作空间
    const x = Math.min(c.r, c.g, c.b);
    const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
    const r = Math.max(0, c.r - offset);
    const g = Math.max(0, c.g - offset);
    const b = Math.max(0, c.b - offset);
    const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
    const fy = y > 216 / 24389 ? Math.cbrt(y) : (841 / 108) * y + 4 / 29;
    return 116 * fy - 16;
  };

  it('四档等距，跨度对齐 ghibli 参考的 22.6 L*', () => {
    expect(PUFF_BAND_COLORS.length).toBe(4);
    const ls = PUFF_BAND_COLORS.map(renderedLstar);
    const steps = [ls[1] - ls[0], ls[2] - ls[1], ls[3] - ls[2]];
    // 参考四绿的实测步长是 5.9 / 7.8 / 8.9（均值 7.53）；这里取等距 7.5。
    for (const s of steps) {
      expect(s).toBeGreaterThan(6);
      expect(s).toBeLessThan(9);
    }
    const span = ls[3] - ls[0];
    expect(span).toBeGreaterThan(20);
    expect(span).toBeLessThan(26);
  });

  it('由暗到亮单调，不许有回头的档', () => {
    const ls = PUFF_BAND_COLORS.map(renderedLstar);
    for (let i = 1; i < ls.length; i += 1) expect(ls[i]).toBeGreaterThan(ls[i - 1]);
  });

  it('整条色阶落在中间调：比海亮，不亮过地平线辉光', () => {
    // 实测：海面 L*≈19，地平线辉光 L*≈70。云压在海里就是黑洞，亮过辉光就是白斑。
    const ls = PUFF_BAND_COLORS.map(renderedLstar);
    expect(ls[0]).toBeGreaterThan(30);
    expect(ls[3]).toBeLessThan(65);
  });

  it('不改 palettes 的穹顶配色', () => {
    // 穹顶共用 CLOUD_PALETTE，且 palettes.test.ts 锁着 base 与 skyTop 的分离度。
    const before = JSON.stringify(CLOUD_PALETTE);
    PUFF_BAND_COLORS.forEach(renderedLstar);
    expect(JSON.stringify(CLOUD_PALETTE)).toBe(before);
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

describe('puff ghibli shading constants', () => {
  it('逐瓣法线只当点缀：权重压到 0.04，层次交给逐瓣常量', () => {
    // 法线在每颗瓣的轮廓处转向，会沿球边开硬缝（650 m 实拍 581 个碎边组件）。
    // 压到 0.04 后明暗差改由 lobeShade 承担——它是整颗瓣平移，不切线走。
    expect(PUFF_NORMAL_WEIGHT).toBe(0.04);
    expect(PUFF_LOBE_SHADE_GAIN).toBeGreaterThan(PUFF_NORMAL_WEIGHT * 4);
  });

  it('阈值必须严格递增，否则 mix 链会短路成单色', () => {
    const [t0, t1, t2] = PUFF_BAND_THRESHOLDS;
    expect(t0).toBeLessThan(t1);
    expect(t1).toBeLessThan(t2);
    expect(t0).toBeGreaterThan(0);
    expect(t2).toBeLessThan(1);
  });
});

describe('puffSunW light remap', () => {
  it('每一档都拿得到实数区间，没有一档被饿死', () => {
    // 四档等分的意义：任何光照角度下四档都该出现，否则就是抄了别处场景的绝对值。
    const widths = PUFF_BAND_THRESHOLDS.map((t, i) =>
      i === 0 ? t : t - PUFF_BAND_THRESHOLDS[i - 1],
    );
    widths.push(1 - PUFF_BAND_THRESHOLDS[PUFF_BAND_THRESHOLDS.length - 1]);
    for (const w of widths) expect(w).toBeGreaterThan(0.15);
  });

  it('背光云读得出四档，不是一整块暗', () => {
    // 太阳在相机正前方，可见半球永远是 wrap ∈ [0, 0.5]：
    // 这一段必须跨过至少三档，否则无论怎么摆机位都是一块平色（实拍翻过车）。
    const bands = new Set<number>();
    for (let i = 0; i <= 20; i += 1) bands.add(puffBandIndex(i / 40));
    expect(bands.size).toBeGreaterThanOrEqual(3);
  });

  it('受光侧不会整片糊成一档', () => {
    // 灯转到侧面/正面时 wrap 会铺到 [0.5, 1]：这一半也必须分得出层。
    // 曾经用 gain 1.35 / bias 0.19 把这里全顶到 gold，糊成一片奶白（实拍验证）。
    const bands = new Set<number>();
    for (let i = 0; i <= 20; i += 1) bands.add(puffBandIndex(0.5 + i / 40));
    expect(bands.size).toBeGreaterThanOrEqual(2);
  });
});

describe('puff blobs follow visibility', () => {
  it('低档藏掉一半时，包围体也必须少一半', async () => {
    // C1: blobs 若无视 visible，手机上每隔一朵云就会「在空处穿云」——
    // 白雾满、镜头踢、台词播，屏幕却什么都没有。
    const scene = new THREE.Scene();
    const puffs = await initPuffClouds(scene, 7, 6);
    const full = puffs.blobs.length;
    expect(full).toBeGreaterThan(0);
    puffs.setQuality(false);
    expect(puffs.blobs.length).toBe(Math.ceil(full / 2));
    puffs.setQuality(true);
    expect(puffs.blobs.length).toBe(full);
    puffs.dispose();
  });
});
