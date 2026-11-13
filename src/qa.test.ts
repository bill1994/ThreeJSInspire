import { describe, expect, it } from 'vitest';

import {
  formatColorRepro,
  parseBgVisible,
  parseCloudLook,
  parseDebugColor,
  parseDomeVisible,
  parseHazeLock,
  parseLinearVec3,
  parsePos,
  parsePuffVisible,
  parseSeaDebug,
  parseSeaNoChop,
  parseSeaVisible,
  parseSunOff,
  parseSunSpin,
  parseToon,
  parseTrackPatch,
  resolveBgVisible,
} from './qa';

describe('parsePos', () => {
  it('解析三数坐标', () => {
    expect(parsePos('1,60,-300')).toEqual({ x: 1, y: 60, z: -300 });
  });

  it('缺项、错项、缺参数都是 null', () => {
    expect(parsePos('1,60')).toBeNull();
    expect(parsePos('a,60,-300')).toBeNull();
    expect(parsePos('1,60,-300,4')).toBeNull();
    expect(parsePos('1,,3')).toBeNull(); // Number('') 是 0，空分量不能悄悄把飞机按到海面
    expect(parsePos(null)).toBeNull();
    expect(parsePos('')).toBeNull();
    expect(parsePos('1,Infinity,-300')).toBeNull();
  });
});

describe('parsePuffVisible', () => {
  it('只有显式的 0 才关掉云场', () => {
    expect(parsePuffVisible('0')).toBe(false);
    expect(parsePuffVisible('1')).toBe(true);
    expect(parsePuffVisible(null)).toBe(true);
    expect(parsePuffVisible('whatever')).toBe(true);
  });
});

describe('parseSeaVisible', () => {
  it('只有显式的 0 才关掉海', () => {
    expect(parseSeaVisible('0')).toBe(false);
    expect(parseSeaVisible('1')).toBe(true);
    expect(parseSeaVisible(null)).toBe(true);
    expect(parseSeaVisible('debug')).toBe(true);
  });
});

describe('parseSeaDebug', () => {
  it('真当且仅当显式 debug', () => {
    expect(parseSeaDebug('debug')).toBe(true);
    expect(parseSeaDebug('0')).toBe(false);
    expect(parseSeaDebug(null)).toBe(false);
    expect(parseSeaDebug('1')).toBe(false);
  });
});

describe('parseSunSpin', () => {
  it('默认是 0，太阳静止', () => {
    expect(parseSunSpin(null)).toBe(0);
    expect(parseSunSpin('')).toBe(0);
    expect(parseSunSpin('0')).toBe(0);
  });

  it('只接受有限正数，并给一个频闪上限', () => {
    expect(parseSunSpin('12')).toBe(12);
    expect(parseSunSpin('-5')).toBe(0);
    expect(parseSunSpin('abc')).toBe(0);
    expect(parseSunSpin('Infinity')).toBe(0);
    expect(parseSunSpin('10000')).toBe(360);
  });
});

// ---- ?sea=nochop（海面细八度计划 Task 1：c1Gate A/B 验收钩子）--------------------------

describe('parseSeaNoChop', () => {
  it("仅 'nochop' 为 true；null/'0'/'debug' 均 false", () => {
    expect(parseSeaNoChop('nochop')).toBe(true);
    expect(parseSeaNoChop(null)).toBe(false);
    expect(parseSeaNoChop('0')).toBe(false);
    expect(parseSeaNoChop('debug')).toBe(false);
  });
  it('nochop 不藏海（visible true）也不进假色（debug false）', () => {
    expect(parseSeaVisible('nochop')).toBe(true);
    expect(parseSeaDebug('nochop')).toBe(false);
  });
});

describe('parseBgVisible', () => {
  it('只认字面量 0 关掉背景', () => {
    expect(parseBgVisible('0')).toBe(false);
  });

  it('缺省一律当开', () => {
    expect(parseBgVisible(null)).toBe(true);
    expect(parseBgVisible(undefined)).toBe(true);
    expect(parseBgVisible('')).toBe(true);
    expect(parseBgVisible('1')).toBe(true);
  });

  it('与 puff 开关互不干扰', () => {
    expect(parseBgVisible('0')).toBe(false);
    expect(parsePuffVisible('0')).toBe(false);
    expect(parseBgVisible('0')).not.toBe(parsePuffVisible('1'));
  });
});

describe('resolveBgVisible（?bg= 优先，?dome= 兼容别名）', () => {
  it('?bg= 有值时胜过 ?dome=', () => {
    expect(resolveBgVisible('0', '1')).toBe(false);
    expect(resolveBgVisible('1', '0')).toBe(true);
  });

  it('?bg= 缺省/空串回落 ?dome=', () => {
    expect(resolveBgVisible(null, '0')).toBe(false);
    expect(resolveBgVisible(undefined, '0')).toBe(false);
    expect(resolveBgVisible('', '0')).toBe(false);
    expect(resolveBgVisible(null, '1')).toBe(true);
    expect(resolveBgVisible(undefined, '1')).toBe(true);
  });

  it('两者都缺省时当开', () => {
    expect(resolveBgVisible(null, null)).toBe(true);
    expect(resolveBgVisible(undefined, undefined)).toBe(true);
  });
});

describe('parseDomeVisible（legacy 别名底层，resolveBgVisible 回落仍读它）', () => {
  it("仍然只认字面量 '0'", () => {
    expect(parseDomeVisible('0')).toBe(false);
    expect(parseDomeVisible(null)).toBe(true);
    expect(parseDomeVisible('1')).toBe(true);
  });
});

// ---- ?debug=color 面板通道（debug color panel 计划 Task 1）------------------------------

describe('parseDebugColor', () => {
  it("仅显式 'color' 为 true，其它一律 falsy", () => {
    expect(parseDebugColor('color')).toBe(true);
    expect(parseDebugColor(null)).toBe(false);
    expect(parseDebugColor(undefined)).toBe(false);
    expect(parseDebugColor('')).toBe(false);
    expect(parseDebugColor('0')).toBe(false);
    expect(parseDebugColor('debug')).toBe(false);
    expect(parseDebugColor('Color')).toBe(false);
  });
});

describe('parseTrackPatch', () => {
  it('合法 JSON 对象深等于该对象', () => {
    expect(parseTrackPatch('{"nightWeight":0.5}')).toEqual({ nightWeight: 0.5 });
  });

  it('非 JSON、JSON 非普通对象一律 null（解析失败返回 null 不抛错，启动不被打断）', () => {
    expect(parseTrackPatch('not json')).toBeNull();
    expect(parseTrackPatch(null)).toBeNull();
    expect(parseTrackPatch('')).toBeNull();
    expect(parseTrackPatch('null')).toBeNull();
    expect(parseTrackPatch('[1,2]')).toBeNull();
    expect(parseTrackPatch('3')).toBeNull();
    expect(parseTrackPatch('"str"')).toBeNull();
  });
});

describe('parseHazeLock', () => {
  it("仅 '1' 为 true（?hazelock=1）", () => {
    expect(parseHazeLock('1')).toBe(true);
  });

  it('null / 其它值一律 false（包括字面量 true）', () => {
    expect(parseHazeLock(null)).toBe(false);
    expect(parseHazeLock('true')).toBe(false);
    expect(parseHazeLock('')).toBe(false);
    expect(parseHazeLock('0')).toBe(false);
  });
});

describe('parseLinearVec3', () => {
  it('?haze=/away= 的线性三分量：三个有限数 → 元组', () => {
    expect(parseLinearVec3('0.0296,0.1100,0.2000')).toEqual([0.0296, 0.11, 0.2]);
    expect(parseLinearVec3('1,2,3')).toEqual([1, 2, 3]);
  });

  it('分量数不对、非法数、空分量一律 null', () => {
    expect(parseLinearVec3('1,2')).toBeNull();
    expect(parseLinearVec3('a,b,c')).toBeNull();
    expect(parseLinearVec3('1,,3')).toBeNull(); // Number('') 是 0，空分量不能悄悄当 0 用
    expect(parseLinearVec3(null)).toBeNull();
    expect(parseLinearVec3('')).toBeNull();
  });
});

describe('formatColorRepro — 复现闭环（R14/S4）', () => {
  it('锁定 + 改端点后的导出态：URL 含 hazelock=1 / trackpatch JSON / ≥4 位小数，控制台含 setTrackPatch、lockHaze(true)、setHazeEndpoints', () => {
    // main.ts 里 exportColorState 的取值序列：lockHaze(true) → setHazeEndpoints(...) → 再导出，
    // 端点读闭包缓存 hazeNow/awayEdgeNow（S5，不是重算）——缓存语义由
    // sky-sun-sea-linkage.test.ts 的 main 源码 pin 守住；这里钉死 repro 两条命令的格式。
    const repro = formatColorRepro(12.5, -3.25, { nightWeight: 0.5 }, true, [0.1, 0.2, 0.3], [0.4, 0.5, 0.6]);
    const [url, consoleCmd] = repro.split('\n');
    expect(url).toContain('hazelock=1');
    expect(url).toContain(`trackpatch=${encodeURIComponent('{"nightWeight":0.5}')}`);
    expect(url).toContain('sun=12.5000,-3.2500'); // 数值一律 toFixed(4)
    expect(url).toContain('haze=0.1000,0.2000,0.3000');
    expect(url).toContain('away=0.4000,0.5000,0.6000');
    expect(consoleCmd).toContain('qa.setSun(12.5000, -3.2500)');
    expect(consoleCmd).toContain('qa.setTrackPatch({"nightWeight":0.5})');
    expect(consoleCmd).toContain('qa.lockHaze(true)');
    expect(consoleCmd).toContain('qa.setHazeEndpoints([0.1000,0.2000,0.3000],[0.4000,0.5000,0.6000])');
  });

  it('patch / 端点为 null：省掉 haze/away 两段，控制台不追加 setHazeEndpoints', () => {
    const repro = formatColorRepro(0, 8, null, false, null, null);
    const [url, consoleCmd] = repro.split('\n');
    expect(url).not.toContain('haze=');
    expect(url).not.toContain('away=');
    expect(url).toContain('hazelock=0');
    expect(url).not.toContain('trackpatch'); // null patch 时整段省略——fresh URL 加载即默认轨道
    expect(consoleCmd).toContain('qa.setTrackPatch(null)');
    expect(consoleCmd).toContain('qa.lockHaze(false)');
    expect(consoleCmd).not.toContain('setHazeEndpoints');
  });
});

// ---- dome-cloud P1.5/P2/horizon 计划 Task 2：云形态档位 + 太阳项证伪开关 ------------------

describe('parseCloudLook', () => {
  it("默认 'soft'：null / undefined / '' / 任意词都不改档", () => {
    expect(parseCloudLook(null)).toBe('soft');
    expect(parseCloudLook(undefined)).toBe('soft');
    expect(parseCloudLook('')).toBe('soft');
    expect(parseCloudLook('whatever')).toBe('soft');
  });

  it("显式 'flat' 才进平顶档", () => {
    expect(parseCloudLook('flat')).toBe('flat');
  });
});

describe('parseSunOff', () => {
  it("仅 '1' 为 true（?sunoff=1）；null / '0' / 其它值一律 false", () => {
    expect(parseSunOff(null)).toBe(false);
    expect(parseSunOff('0')).toBe(false);
    expect(parseSunOff('1')).toBe(true);
  });
});

// ---- toon-look Phase 1 计划 Task 1：uToon 总闸 -------------------------------------------

describe('parseToon', () => {
  it.each([
    ['0', 0], ['1', 1], ['0.35', 0.35], ['0.5', 0.5],
  ])('?toon=%s → %s', (raw, v) => expect(parseToon(raw)).toBe(v));
  it('defaults and rejects', () => {
    expect(parseToon(null)).toBe(0);
    expect(parseToon(undefined)).toBe(0);
    expect(parseToon('')).toBe(0);
    expect(parseToon('abc')).toBe(0);
    expect(parseToon('1.5')).toBe(1);   // clamp 上界
    expect(parseToon('-0.2')).toBe(0);  // clamp 下界
  });
});

// ---- toon-look Phase 1 计划 Task 4：exportColorState repro 的 toon 段 ----------------------

describe('formatColorRepro — toon 段（toon-look Phase 1 Task 4）', () => {
  it('toonAmount≠0：URL 加 &toon=、控制台加 qa.setToon(...)（照 haze 段的追加先例）', () => {
    const repro = formatColorRepro(12.5, -3.25, null, false, null, null, 1);
    const [url, consoleCmd] = repro.split('\n');
    expect(url).toContain('&toon=1.0000');
    expect(consoleCmd).toContain('qa.setToon(1.0000)');
  });

  it('toonAmount=0：两行命令都省略 toon 段（照 haze null 省略先例——默认画面逐位不变）', () => {
    const repro = formatColorRepro(0, 8, null, false, null, null, 0);
    const [url, consoleCmd] = repro.split('\n');
    expect(url).not.toContain('toon=');
    expect(consoleCmd).not.toContain('setToon');
  });

  it('repro round-trip：URL 的 toon= 经 parseToon 回放出同一 toonAmount', () => {
    for (const amount of [1, 0.35, 0.0421]) {
      const url = formatColorRepro(0, 8, null, false, null, null, amount).split('\n')[0];
      const m = /[?&]toon=([0-9.]+)/.exec(url);
      expect(m).not.toBeNull();
      expect(parseToon(m![1])).toBe(amount);
    }
  });
});
