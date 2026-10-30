import { describe, it, expect } from 'vitest';

/**
 * Module-graph guard.
 *
 * `renderer.ts` keeps a classic-`WebGLRenderer` last resort for the case where
 * `three/webgpu` itself fails to load, and `main.ts` promises "never a black page". A *static*
 * import of `three/webgpu` anywhere in the boot graph (main → game/world/post → …) makes that
 * net unreachable: module linking fails before `createRenderer` is ever called, and the
 * boot-status line never paints. Everything that needs the WebGPU build must `await import()`.
 */
const sources = import.meta.glob('./*.ts', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

// `import type` is erased at compile time and creates no runtime dependency, so it is allowed.
const STATIC_WEBGPU_IMPORT = /^\s*import\s+(?!type\b)[^;]*from\s+['"]three\/(webgpu|tsl)['"]/m;

describe('module graph', () => {
  it('has source files to scan (the glob itself works)', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    expect(Object.keys(sources).some((p) => p.endsWith('/game.ts'))).toBe(true);
  });

  it('never statically imports three/webgpu or three/tsl outside tests', () => {
    const offenders = Object.entries(sources)
      .filter(([path]) => !path.endsWith('.test.ts'))
      .filter(([, source]) => STATIC_WEBGPU_IMPORT.test(source))
      .map(([path]) => path.replace('./', ''));

    expect(offenders).toEqual([]);
  });

  it('loads the WebGPU build dynamically where it is needed', () => {
    const dynamicUsers = Object.entries(sources)
      .filter(([path]) => !path.endsWith('.test.ts'))
      .filter(([, source]) => /await import\(['"]three\/webgpu['"]\)/.test(source))
      .map(([path]) => path.replace('./', ''))
      .sort();

    // renderer.ts is the one that must work even when the import throws; the rest build on it.
    expect(dynamicUsers).toContain('renderer.ts');
    expect(dynamicUsers).toContain('post.ts');
    expect(dynamicUsers).toContain('toon.ts');
  });
});
