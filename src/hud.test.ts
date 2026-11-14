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

// FLT-03 失速带三态（2026-11-12 修复清单 Phase 1，Task 3）
describe('hud 失速带三态（FLT-03）', () => {
  it('预警态 --warn 常亮暗态、事件态 --on 闪烁，互不吞并', () => {
    const src = sources['./hud.ts'];
    expect(src).toMatch(/\.porco-stall--warn\{opacity:\.55\}/);
    expect(src).toMatch(/stallWarn === true[\s\S]{0,240}porco-stall--warn/);
    expect(src).toMatch(/porco-stall--on/);
  });
});

// HUD 折叠（2026-11-14）：常态 + UI 芯片，点开完整面板，− 收回。
describe('hud 折叠外壳', () => {
  it('常态折叠：初始化即 collapsed 并落一次 applyCollapsed', () => {
    const src = sources['./hud.ts'];
    expect(src).toMatch(/let collapsed = true/);
    expect(src).toMatch(/applyCollapsed\(\);/);
    expect(src).toMatch(/porco-hud--collapsed/);
  });

  it('一个按钮两态：+ / − 由同一处写入，点击只翻转状态', () => {
    const src = sources['./hud.ts'];
    expect(src).toMatch(/hudToggleGlyph\.textContent = collapsed \? '\+' : '−'/);
    expect(src).toMatch(/hudToggleLabel\.textContent = collapsed \? 'UI' : ''/);
    expect(src).toMatch(/collapsed = !collapsed/);
  });

  it('读屏语义：aria-expanded 随态翻转，标签说明动作；不指向半个目标', () => {
    const src = sources['./hud.ts'];
    expect(src).toMatch(/setAttribute\('aria-expanded', collapsed \? 'false' : 'true'\)/);
    expect(src).toMatch(/collapsed \? 'Show HUD' : 'Hide HUD'/);
    // 按钮同时藏仪表/混音台/底栏——aria-controls 只能指一个，会误导，故不挂这个属性。
    expect(src).not.toMatch(/setAttribute\('aria-controls'/);
  });

  it('触摸目标 ≥44px，且沿用面板材质而不是另起一套观感', () => {
    const src = sources['./hud.ts'];
    const rule = src.slice(src.indexOf('.porco-hud__toggle{'), src.indexOf('.porco-hud__toggle{') + 700);
    expect(rule).toMatch(/min-width:44px/);
    expect(rule).toMatch(/min-height:44px/);
    expect(rule).toMatch(/border-radius:10px/);
    expect(rule).toMatch(/rgba\(18,14,20,\.46\)/);
  });

  it('折叠只藏仪器/混音台/底栏——STALL 与字幕不许一起消失', () => {
    const src = sources['./hud.ts'];
    const start = src.indexOf('.porco-hud--collapsed .porco-arc-wrap');
    const rule = src.slice(start, src.indexOf('}', src.indexOf('.porco-hud__bottom', start)));
    expect(rule).toMatch(/porco-arc-wrap/);
    expect(rule).toMatch(/porco-mixer/);
    expect(rule).toMatch(/porco-hud__bottom/);
    expect(rule).not.toMatch(/porco-stall/);
    expect(rule).not.toMatch(/porco-sub/);
  });

  it('外部只走 setCollapsed：按钮与句柄共用 applyCollapsed，不各写一份', () => {
    const src = sources['./hud.ts'];
    expect(src).toMatch(/setCollapsed\(v: boolean\): void \{/);
    expect(src).toMatch(/isCollapsed\(\): boolean/);
    const calls = src.match(/applyCollapsed\(\);/g) ?? [];
    expect(calls.length).toBe(3); // 定义后一次初调 + 点击一次 + setCollapsed 一次
  });

  it('尊重 prefers-reduced-motion：减少动效时去掉过渡', () => {
    const src = sources['./hud.ts'];
    expect(src).toMatch(/@media \(prefers-reduced-motion: reduce\)\{[\s\S]{0,120}transition:none/);
  });
});
