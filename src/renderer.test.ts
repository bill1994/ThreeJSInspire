/**
 * Tone mapping is the global prerequisite for every colour change in the v2 plan:
 * before it, the frame's mid band was 51.6% pixels at 250+ (clipped), so any palette
 * tuning was done on a truncated baseline. These tests pin the two things a reviewer
 * can check without a GPU — the chosen tonal range, and that applying it cannot take
 * the boot down on a renderer that lacks the fields.
 */
import { describe, expect, it } from 'vitest';

import { applyToneMapping, TONE_MAPPING } from './renderer';

const sources = import.meta.glob('./*.ts', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

describe('tone mapping', () => {
  it('pins a tonal range that can actually lift the sky out of clipping', () => {
    expect(TONE_MAPPING.mode === 'aces' || TONE_MAPPING.mode === 'neutral').toBe(true);
    expect(TONE_MAPPING.exposure).toBeGreaterThan(0.5);
    expect(TONE_MAPPING.exposure).toBeLessThanOrEqual(1.5);
  });

  it('writes both the curve and the exposure onto a node renderer', () => {
    const renderer = { toneMapping: 0, toneMappingExposure: 1 };
    applyToneMapping(renderer);
    expect(renderer.toneMapping).not.toBe(0); // 0 is NoToneMapping
    expect(renderer.toneMappingExposure).toBe(TONE_MAPPING.exposure);
  });

  it('does not throw on a renderer missing the fields', () => {
    // The classic WebGLRenderer fallback and any stubbed backend may not expose
    // these; a throw here would kill boot for a cosmetic setting.
    expect(() => applyToneMapping({})).not.toThrow();
    expect(() => applyToneMapping(null)).not.toThrow();
    expect(() => applyToneMapping(undefined)).not.toThrow();
  });

  it('has no WebGL fallback left', () => {
    const src = sources['./renderer.ts'];
    expect(src).not.toMatch(/forceWebGL/);
    expect(src).not.toMatch(/WebGLRenderer/);
    expect(src).not.toMatch(/postSupported/);
  });
});
