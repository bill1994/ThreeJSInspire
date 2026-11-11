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

describe('hud G vignette (P2-2)', () => {
  it('setG 走白纱同款防抖：量化 1/200 + 变化才写', () => {
    const src = sources['./hud.ts'];
    expect(src).toMatch(/setG\(v: number\): void/);
    expect(src).toMatch(/gLayer\.style\.opacity/);
    expect(src).toMatch(/q !== lastG/);
  });

  it('暗角层是径向渐变：中心透明、边缘压黑，不抢 HUD 的字', () => {
    const src = sources['./hud.ts'];
    expect(src).toMatch(/\.porco-g\{[^}]*radial-gradient/);
    expect(src).toMatch(/transparent 52%/);
  });
});
