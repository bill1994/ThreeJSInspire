import { describe, expect, it } from 'vitest';

const sources = import.meta.glob('./hud.ts', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

describe('hud whiteout backstop (兜底纱)', () => {
  it('setWhiteout 接受可选纱色并写背景——纱随太阳方位着色', () => {
    const src = sources['./hud.ts'];
    expect(src).toMatch(/setWhiteout\(v: number, tintCss\?: string\)/);
    expect(src).toMatch(/background = tint/);
  });

  it('纱色只在变化时写样式——沿用白雾的量化防抖约定', () => {
    const src = sources['./hud.ts'];
    expect(src).toMatch(/tintCss && tintCss !== lastTint/);
  });
});
