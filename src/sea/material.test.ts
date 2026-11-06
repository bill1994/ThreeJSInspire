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

describe('sea material shader-sign tripwires (review pass)', () => {
  const src = sources['./material.ts'];

  it('reflects the sun WITHOUT negating it (the glint dot flips the sign)', () => {
    // C1: reflect(-sun, N) points away from the eye at the mirror point; the
    // glint compares it against the camera->surface viewDir, so the negate
    // clamps spec to zero exactly where the road should shine.
    expect(src).not.toMatch(/reflect\(sunU\.negate\(\)/);
    expect(src).toMatch(/reflect\(sunU, normalNode\)/);
  });

  it('gates the road by the horizontal bearing (x, z), not (x, y)', () => {
    // C2: (x, y) mixes the sun's ELEVATION into the azimuth gate.
    expect(src).not.toMatch(/vec2\(sunU\.x, sunU\.y\)/);
    expect(src).toMatch(/vec2\(sunU\.x, sunU\.z\)/);
  });

  it('computes Schlick Fresnel as (1 + dot(view, N))^5', () => {
    // C3: viewDir is camera->surface, so cos(theta) = -dot(view, N) and the
    // Schlick term is (1 - cos)^5 = (1 + dot)^5 — the (1 - dot) form is
    // unbounded (up to 32) and burns the near water.
    expect(src).not.toMatch(/sub\(viewDir\.dot\(normalNode\)\)\.pow\(5\.0\)/);
    expect(src).toMatch(/add\(viewDir\.dot\(normalNode\)\)\.pow\(5\.0\)/);
  });

  it('blends LOD by ring-local radius, not world radius', () => {
    // C4: the mesh is towed with the camera; a world-space radius saturates
    // the blend the moment the camera leaves the origin.
    expect(src).not.toMatch(/max\(worldXZ\.x\.abs\(\)/);
    expect(src).toMatch(/const localXZ = positionLocal\.xz/);
  });

  it('feeds the chop cascade to ring 0 only, gated by a quality uniform', () => {
    // C5/F1/F4: R1-R3 are swell-only; the band judgement is C0-only; the low
    // tier gates C1 in-graph instead of freezing its textures.
    expect(src).toMatch(/c1Gate/);
    expect(src).toMatch(/i === 0/);
    expect(src).not.toMatch(/varying\(heightSum\)/);
    expect(src).not.toMatch(/BASE \* tierGain\.value/);
  });
});
