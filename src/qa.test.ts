import { describe, expect, it } from 'vitest';

import { parsePos, parsePuffVisible } from './qa';

describe('parsePos', () => {
  it('解析三数坐标', () => {
    expect(parsePos('1,60,-300')).toEqual({ x: 1, y: 60, z: -300 });
  });

  it('缺项、错项、缺参数都是 null', () => {
    expect(parsePos('1,60')).toBeNull();
    expect(parsePos('a,60,-300')).toBeNull();
    expect(parsePos('1,60,-300,4')).toBeNull();
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
