import { describe, expect, it } from 'vitest';

const sources = import.meta.glob('./*.ts', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

describe('sea material source', () => {
  it('never reads scene fog (the horizon would turn purple)', () => {
    // Review Focus 5: scene.fog is #c96a7a while the sky horizon is #ff9a5a —
    // a fogged far ring converges on the wrong colour and paints a full-width seam.
    expect(sources['./material.ts']).toMatch(/fog\s*=\s*false/);
  });

  it('owns the ?sea=debug false-colour switch (Task 12 measures with it)', () => {
    expect(sources['./material.ts']).toMatch(/debugUniform/);
  });

  it('keeps the WebGPU build behind dynamic imports only', () => {
    const src = sources['./material.ts'];
    expect(src).not.toMatch(/^\s*import\s+(?!type\b)[^;]*from\s+['"]three\/(webgpu|tsl)['"]/m);
    expect(src).toMatch(/await import\(['"]three\/webgpu['"]\)/);
  });

  it('mounts four named rings', () => {
    expect(sources['./material.ts']).toMatch(/sea-r\$\{/);
  });
});
