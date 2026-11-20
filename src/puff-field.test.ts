import { describe, expect, it } from 'vitest';

import { FLIGHT } from './game';
import {
  PUFF_EDGE_FADE,
  PUFF_FADE_FAR,
  PUFF_FADE_NEAR,
  PUFF_NEAR_FLOOR,
  PUFF_RING,
  PUFF_SCATTER,
  PUFF_SPACING,
  PUFF_WINDOW,
  PuffSize,
  fadeForDistance,
  puffEdgeFade,
  puffGridCells,
  puffScatter,
  composePuffBanks,
  wrapPuffAxis,
  wrapPuffWindow,
} from './puff-field';

/** 请求 25 朵：5×5 的格子刚好装下，净空剔除后少一两朵可接受。 */
function makeSizes(count = 25): PuffSize[] {
  return Array.from({ length: count }, () => ({ halfW: 20, halfH: 30, s: 1.8 }));
}

/** 环面距离：两个方向都要跨接缝取短边。 */
function toroidal(a: number, b: number, period: number): number {
  const d = Math.abs(a - b) % period;
  return Math.min(d, period - d);
}

describe('composed puff banks', () => {
  it('preserves far spawn, toroidal clearance, scale and altitude over many seeds', () => {
    const sizes=Array.from({length:25},(_,i)=>({halfW:20+i,halfD:24,halfH:22+i,s:2}));
    for(let seed=1;seed<=50;seed++) {
      const original=puffScatter(seed,sizes);
      const snapshot=JSON.stringify(original);
      const spots=composePuffBanks(original,sizes);
      expect(JSON.stringify(original)).toBe(snapshot);
      expect(spots).toEqual(composePuffBanks(original,sizes));
      expect(spots).toHaveLength(original.length);
      spots.forEach((s,i)=>{
        expect(s.s).toBe(original[i].s);
        expect(Math.hypot(s.x,s.z)-Math.hypot(sizes[i].halfW,sizes[i].halfD)).toBeGreaterThanOrEqual(PUFF_SCATTER.SPAWN_CLEAR);
        expect(s.y-sizes[i].halfH).toBeGreaterThanOrEqual(FLIGHT.ALT_MIN+PUFF_SCATTER.SEA_CLEAR-1e-8);
        expect(s.y+sizes[i].halfH).toBeLessThanOrEqual(FLIGHT.ALT_MAX+1e-8);
        for(let j=0;j<i;j++) expect(Math.hypot(toroidal(s.x,spots[j].x,PUFF_WINDOW),toroidal(s.z,spots[j].z,PUFF_WINDOW)))
          .toBeGreaterThanOrEqual(PUFF_SCATTER.GAP_MARGIN*(Math.hypot(sizes[i].halfW,sizes[i].halfD)+Math.hypot(sizes[j].halfW,sizes[j].halfD))-1e-8);
      });
    }
  });
  it('brings a horizontal pair closer and aligns its bases without changing shape', () => {
    const sizes=makeSizes(2);
    const input=[{x:1300,z:0,y:55,s:1.8},{x:1300,z:200,y:110,s:1.8}];
    const [a,b]=composePuffBanks(input,sizes);
    expect(Math.hypot(a.x-b.x,a.z-b.z)).toBeLessThan(100);
    expect(Math.abs(a.y-b.y)).toBeLessThanOrEqual(8);
  });
});

describe('wrapPuffAxis', () => {
  it('把任意偏移一次搬回窗口内，不靠循环步进', () => {
    const out = wrapPuffAxis(-800, -10770);
    expect(out).toBeGreaterThan(-10770 - PUFF_WINDOW / 2);
    expect(out).toBeLessThanOrEqual(-10770 + PUFF_WINDOW / 2);
    // 位移必须是窗口长度的整数倍，否则云会漂移
    const shift = Math.abs(out - -800);
    expect(shift % PUFF_WINDOW).toBeCloseTo(0, 6);
  });

  it('已经在窗口内就原样返回', () => {
    expect(wrapPuffAxis(-800, -800)).toBe(-800);
    expect(wrapPuffAxis(0, 500)).toBe(0);
  });

  it('非有限输入回原值而不是跳云', () => {
    expect(wrapPuffAxis(Number.NaN, 0)).toBeNaN();
    expect(wrapPuffAxis(5, Number.NaN)).toBe(5);
  });
});

describe('wrapPuffWindow', () => {
  it('两轴都按同一个窗口取模', () => {
    const out = wrapPuffWindow(9000, -9000, 0, 0);
    expect(Math.abs(out.x)).toBeLessThanOrEqual(PUFF_WINDOW / 2);
    expect(Math.abs(out.z)).toBeLessThanOrEqual(PUFF_WINDOW / 2);
  });

  it('掉头 180° 之后前方仍然有云（同一朵不会消失）', () => {
    const cloud = { x: -900, z: -900 };
    const ahead = wrapPuffWindow(cloud.x, cloud.z, 0, 0);
    const afterTurn = wrapPuffWindow(cloud.x, cloud.z, 1800, 1800);
    for (const p of [ahead, afterTurn]) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.z)).toBe(true);
    }
    expect(afterTurn).not.toEqual(ahead);
  });
});

describe('puffEdgeFade', () => {
  it('窗口中心是 1，边界是 0', () => {
    expect(puffEdgeFade(0, 0, 0, 0)).toBe(1);
    expect(puffEdgeFade(PUFF_WINDOW / 2, 0, 0, 0)).toBe(0);
  });

  it('淡出带内单调不增', () => {
    // 按半窗口取比例，别写死米数——窗口一改这些采样点就会绕回窗口内。
    const half = PUFF_WINDOW / 2;
    const xs = [0, 0.6, 0.8, 0.9, 0.95, 0.99].map((f) => f * half);
    const v = xs.map((x) => puffEdgeFade(x, 0, 0, 0));
    for (let i = 1; i < v.length; i += 1) expect(v[i]).toBeLessThanOrEqual(v[i - 1] + 1e-9);
  });

  it('掉头扫过时淡出连续，跨窗口接缝也不跳', () => {
    let prev = puffEdgeFade(-900, 0, 0, 0);
    for (let camX = 0; camX <= 2000; camX += 20) {
      const x = wrapPuffWindow(-900, 0, camX, 0).x;
      const f = puffEdgeFade(x, 0, camX, 0);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
      expect(Math.abs(f - prev)).toBeLessThan(0.25);
      prev = f;
    }
  });

  it('new clouds occupy the far ring, within the recycling boundary', () => {
    expect(PUFF_RING.inner).toBeGreaterThan(0);
    expect(PUFF_RING.inner).toBeGreaterThanOrEqual(PUFF_SCATTER.SPAWN_CLEAR);
    expect(PUFF_RING.outer).toBeLessThan(PUFF_WINDOW / 2);
  });

  it('淡出带必须窄于半个窗口，否则整场云永远半透明', () => {
    expect(PUFF_EDGE_FADE).toBeGreaterThan(0);
    expect(PUFF_EDGE_FADE).toBeLessThan(PUFF_WINDOW / 2);
  });
});

describe('puffScatter (square window)', () => {
  const sizes = makeSizes();

  it('1. 同种子确定，换种子就变', () => {
    expect(puffScatter(7, sizes)).toEqual(puffScatter(7, sizes));
    expect(puffScatter(7, sizes)).not.toEqual(puffScatter(8, sizes));
  });

  it('2. 两两最小间距按环面算，跨接缝也成立', () => {
    const spots = puffScatter(7, sizes);
    const minGap = PUFF_SCATTER.GAP_MARGIN * 2 * 20;
    for (let i = 0; i < spots.length; i += 1) {
      for (let j = i + 1; j < spots.length; j += 1) {
        const dx = toroidal(spots[i].x, spots[j].x, PUFF_WINDOW);
        const dz = toroidal(spots[i].z, spots[j].z, PUFF_WINDOW);
        expect(Math.hypot(dx, dz)).toBeGreaterThanOrEqual(minGap - 1e-9);
      }
    }
  });

  it('3. 云底不插进海里，云顶不出爬升上限', () => {
    for (const spot of puffScatter(7, sizes)) {
      expect(spot.y - 30).toBeGreaterThanOrEqual(FLIGHT.ALT_MIN);
      expect(spot.y + 30).toBeLessThanOrEqual(FLIGHT.ALT_MAX);
    }
  });

  it('4. 全部落在窗口里', () => {
    for (const spot of puffScatter(7, sizes)) {
      expect(Math.abs(spot.x)).toBeLessThanOrEqual(PUFF_WINDOW / 2);
      expect(Math.abs(spot.z)).toBeLessThanOrEqual(PUFF_WINDOW / 2);
    }
  });

  it('5. 出生点是剔除不是平移', () => {
    for (const spot of puffScatter(7, sizes)) {
      expect(Math.hypot(spot.x, spot.z)).toBeGreaterThanOrEqual(PUFF_SCATTER.SPAWN_CLEAR + sizes[0].halfW - 1e-9);
    }
  });

  it('6. distant ring retains the requested cloud count', () => {
    const spots = puffScatter(7, sizes);
    expect(spots.length).toBeGreaterThanOrEqual(20);
    expect(spots.length).toBeLessThanOrEqual(30);
  });

  it('7. 网格容量按窗口整除，格距不窄于请求的最小间距', () => {
    const cells = puffGridCells(PUFF_SPACING);
    expect(cells).toBeGreaterThanOrEqual(1);
    expect(PUFF_WINDOW / cells).toBeGreaterThanOrEqual(PUFF_SPACING - 1e-9);
  });

  it('8. 装不下的尺寸抛错，不返回 NaN', () => {
    expect(() => puffScatter(7, [{ halfW: 20, halfH: 200, s: 2.6 }])).toThrow();
  });
});

describe('fadeForDistance', () => {
  it('近距有下限 0.3（软墙包裹相机），带外是 1', () => {
    expect(PUFF_FADE_NEAR).toBeCloseTo(3.5, 6);
    expect(PUFF_FADE_FAR).toBeCloseTo(10, 6);
    expect(PUFF_NEAR_FLOOR).toBeCloseTo(0.3, 6);
    expect(fadeForDistance(PUFF_FADE_NEAR)).toBeCloseTo(PUFF_NEAR_FLOOR, 6);
    expect(fadeForDistance(0)).toBeCloseTo(PUFF_NEAR_FLOOR, 6);
    expect(fadeForDistance(PUFF_FADE_FAR)).toBe(1);
  });

  it('近场闸门：5 m 处 ≤ 0.40（压贴脸平涂），0.5 m 处 ≥ 0.2（软墙不许消失）', () => {
    // 0.2 是模块注释钉死的可读性下限——低于它软墙就近乎消失，「云里什么都没有」。
    expect(fadeForDistance(5)).toBeLessThanOrEqual(0.4);
    expect(fadeForDistance(0.5)).toBeGreaterThanOrEqual(0.2);
  });

  it('带内单调', () => {
    const v = [0, 2, 4, 6, 8, 10, 12].map((d) => fadeForDistance(d));
    for (let i = 1; i < v.length; i += 1) expect(v[i]).toBeGreaterThanOrEqual(v[i - 1]);
  });

  it('垃圾输入按全显处理', () => {
    expect(fadeForDistance(Number.NaN)).toBe(1);
  });
});

describe('puffScatter (coverage)', () => {
  it('9. 25 朵铺开在整个窗口，不塌成一坨', () => {
    const spots = puffScatter(7, makeSizes());
    const xs = spots.map((s) => s.x);
    const zs = spots.map((s) => s.z);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(600);
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(600);
  });
});


describe('far-only initial placement', () => {
  it('keeps the full cloud footprint away from spawn after jitter across seeds and sizes', () => {
    const sizes = Array.from({ length: 25 }, (_, i) => ({ halfW: 30 + i * 2, halfD: 50, halfH: 30, s: 2 }));
    for (let seed = 1; seed <= 50; seed++) {
      const spots = puffScatter(seed, sizes);
      expect(spots.length).toBeGreaterThan(0);
      spots.forEach((spot, i) => {
        const radius = Math.hypot(spot.x, spot.z);
        expect(radius).toBeGreaterThanOrEqual(PUFF_RING.inner);
        expect(radius).toBeLessThanOrEqual(PUFF_RING.outer);
        expect(radius - Math.hypot(sizes[i].halfW, sizes[i].halfD)).toBeGreaterThanOrEqual(PUFF_SCATTER.SPAWN_CLEAR);
      });
    }
  });

  it('fades at the same distance in front and diagonally, leaving close clouds solid', () => {
    for (const radius of [0, 100, 500, 1000, 1100, 1200, 1399]) {
      expect(puffEdgeFade(radius, 0, 0, 0)).toBeCloseTo(puffEdgeFade(radius / Math.SQRT2, radius / Math.SQRT2, 0, 0), 8);
    }
    expect(puffEdgeFade(100, 0, 0, 0)).toBe(1);
  });
});
