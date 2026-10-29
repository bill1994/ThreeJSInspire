import { describe, it, expect } from 'vitest';
import { SUB_LINES, createCues, fadeAlpha } from './subtitles';

describe('SUB_LINES', () => {
  it('ships five Chinese lines with sane durations', () => {
    expect(SUB_LINES).toHaveLength(5);
    for (const l of SUB_LINES) {
      expect(l.zh.length).toBeGreaterThan(2);
      expect(l.dur).toBeGreaterThan(1);
      expect(l.dur).toBeLessThan(8);
    }
  });
});

describe('createCues', () => {
  it('fires each line once and only on its own cue', () => {
    const cues = createCues();
    const first = cues.nextLine('takeoff');
    expect(first).not.toBeNull();
    expect(cues.nextLine('takeoff')).toBeNull();
    expect(cues.nextLine('nothing-happened')).toBeNull();
  });

  it('can be reset for a second sortie', () => {
    const cues = createCues();
    const id = cues.nextLine('takeoff');
    cues.reset();
    expect(cues.nextLine('takeoff')).toBe(id);
  });
});

describe('fadeAlpha', () => {
  it('fades in, holds, fades out, and never exceeds 1', () => {
    expect(fadeAlpha(0, 3)).toBe(0);
    expect(fadeAlpha(1.5, 3)).toBe(1);
    expect(fadeAlpha(3, 3)).toBe(0);
    expect(fadeAlpha(99, 3)).toBe(0);
    expect(fadeAlpha(Number.NaN, 3)).toBe(0);
  });
});
