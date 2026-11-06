import { describe, expect, it } from 'vitest';

import { parsePos, parsePuffVisible, parseSeaDebug, parseSeaVisible } from './qa';

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
