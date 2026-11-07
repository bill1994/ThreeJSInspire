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

describe('sea material road/haze rewrite tripwires (plan v2 Task 3)', () => {
  const src = sources['./material.ts'];

  it('builds the road from the knee + slope-gated glint constants, no hardcoded 96', () => {
    // E5/M3/M4: the graph links SUN_ROAD's mirrors — ceiling, knee softness and
    // the sparkle threshold — and the exponent lives in SUN_ROAD.GLOSS_POW.
    expect(src).toMatch(/SUN_ROAD\.ROAD_CEILING/);
    expect(src).toMatch(/SUN_ROAD\.KNEE_K/);
    expect(src).toMatch(/SUN_ROAD\.GLINT_COS_THRESHOLD/);
    expect(src).toMatch(/SUN_ROAD\.GLOSS_POW/);
    expect(src).toMatch(/roadSpecKneeTsl/);
    expect(src).not.toMatch(/pow\(96/);
  });

  it('samples the sky WITHOUT the sun disc (double-sun dedup) and derives the haze colour from the away edge', () => {
    // The sea already paints the sun through the specular road; skyColorTsl's
    // disc inside the reflection would paint it twice. Glow stays (atmospheric
    // halo is genuine sky radiance a mirror reflects).
    expect(src).toMatch(/skyColorTsl\(tsl,\s*reflected,\s*sunU,\s*false\)/);
    expect(src).toMatch(/awayHorizonLinear/);
    // v1 constants the review rejected — must not linger.
    expect(src).not.toMatch(/reflectionAwayDim|hazeAzimuthGate|hazeAway/);
  });

  it('guards XZ normalisations against the straight-down NaN; mix stays function-form', () => {
    // M8: viewDir is degenerate when looking straight down (FALL poses); the
    // sky's own code guards with max(1e-4) — the sea must not do worse.
    expect(src).toMatch(/length\(\)\.max\(1e-4\)/);
    expect(src).not.toMatch(/\)\.mix\(/);
  });
});

describe('sea material QA round-1 rulings (Task 4)', () => {
  const src = sources['./material.ts'];

  it('gates sparkle cores by the road mask (off-road glints are unphysical at 180 deg)', () => {
    // SLOPE_GAIN 14 inflates facet normals enough to align off-road; without
    // the mask the sparkle boost paints glint streaks at every bearing.
    expect(src).toMatch(/sparkleGlintTsl\(cont,\s*specDot,\s*mask\)/);
  });

  it('fires the backlit crest on the SUNWARD side (dot(viewDir, sun), no negate)', () => {
    // crestGlow doc: cosEyeToSun = 1 when the eye looks into the sun through
    // the water. viewDir runs camera->surface, so that is dot(viewDir, sunU);
    // the shipped negate lit the FRONT-lit side (found by QA round 1, B frame).
    expect(src).toMatch(/viewDir\.dot\(sunU\)/);
    expect(src).not.toMatch(/viewDir\.negate\(\)\.dot\(sunU\)/);
  });
});

describe('sea material final-review fixes', () => {
  const src = sources['./material.ts'];

  it('haze colour targets the sky edge with AWAY_GAIN applied exactly once', () => {
    // Important 1 (final review): awayHorizonLinear already carries AWAY_GAIN;
    // a weight that multiplies it again lands at g² and the seam cracks as soon
    // as HAZE_MAX or AWAY_GAIN is retuned. The graph defers to seaHazeTsl.
    expect(src).toMatch(/seaHazeTsl/);
    expect(src).not.toMatch(/HORIZON\.AWAY_GAIN/);
  });
});
