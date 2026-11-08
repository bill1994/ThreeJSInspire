import { describe, expect, it } from 'vitest';

import { seaHazeEndpoints, skyColorJs } from '../sky-color-js';
import { REFERENCE_ELEVATION_DEG, skyTrackAt, type Vec3 as Vec3T, type SkyTrackState } from '../sky-track';
import { seaHazeTargetLinear, sunDirectionFromAzEl } from '../horizon';
import { SUN_DIRECTION, SUN_POSITION } from '../palettes';

const sources = import.meta.glob('./*.ts', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/**
 * 中间方位亮度差的实测钉值（2026-11-08 首跑实测回填）：2 端点线性 mix 对物理方位
 * 曲线的已知近似，逐档 |ΔLum| = 参考 0.0787 / 0° 0.1663 / −4° 0.0281 / −8° 0
 * （0° 档主导：太阳嵌在地平线上时 E 场方位变化最陡）。断言上限 = 本值 + 0.01，
 * 恶化即红——不许无声放大。
 */
const MID_AZIMUTH_MEASURED = 0.167;

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

// ---- 海霾端点同源（day-night Task 5，Review Focus 1）--------------------------------

describe('sea haze endpoints — sky 同源', () => {
  const REF_P = skyTrackAt(REFERENCE_ELEVATION_DEG).preetham;
  const AZ = (Math.atan2(SUN_POSITION[0], -SUN_POSITION[2]) * 180) / Math.PI;
  const lum = (v: readonly number[]): number => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  const edgeAt = (state: SkyTrackState, sun: Vec3T, azDeg: number): Vec3T =>
    skyColorJs(sunDirectionFromAzEl(azDeg, 0), sun, state, SUN_DIRECTION, REF_P, false);

  it('seaHazeEndpoints 的两端点 = skyColorJs 在两标准地平方向的输出（≤1e-6，钉「谁派生谁」）', () => {
    for (const el of [REFERENCE_ELEVATION_DEG, 0, -4, -8]) {
      const state = skyTrackAt(el);
      const sun = sunDirectionFromAzEl(AZ, el);
      const { haze, awayEdge } = seaHazeEndpoints(state, sun, SUN_DIRECTION, REF_P);
      const hz = edgeAt(state, sun, AZ);
      const aw = edgeAt(state, sun, AZ + 180);
      for (let i = 0; i < 3; i += 1) {
        expect(Math.abs(haze[i] - hz[i])).toBeLessThanOrEqual(1e-6);
        expect(Math.abs(awayEdge[i] - aw[i])).toBeLessThanOrEqual(1e-6);
      }
    }
  });

  it('中间方位（相对太阳 90°）：2 端点线性 mix 与物理方位曲线的亮度差 ≤ 实测 + 0.01', () => {
    // 2 端点线性 mix 对物理方位曲线是已知近似；实测差 pin 死，不许无声放大。
    let measured = 0;
    const perKey: Record<string, number> = {};
    for (const el of [REFERENCE_ELEVATION_DEG, 0, -4, -8]) {
      const state = skyTrackAt(el);
      const sun = sunDirectionFromAzEl(AZ, el);
      const { haze, awayEdge } = seaHazeEndpoints(state, sun, SUN_DIRECTION, REF_P);
      const dir90 = sunDirectionFromAzEl(AZ + 90, 0);
      const dl = Math.max(Math.hypot(dir90[0], dir90[2]), 1e-4);
      const sl = Math.max(Math.hypot(sun[0], sun[2]), 1e-4);
      const cosAz = (dir90[0] / dl) * (sun[0] / sl) + (dir90[2] / dl) * (sun[2] / sl);
      const target = seaHazeTargetLinear(cosAz, { haze, awayEdge });
      const physical = edgeAt(state, sun, AZ + 90);
      const diff = Math.abs(lum(target) - lum(physical));
      perKey[el.toFixed(2)] = Number(diff.toFixed(4));
      measured = Math.max(measured, diff);
    }
    // eslint-disable-next-line no-console
    console.log('[sea-haze-endpoints] mid-azimuth |ΔLum| per key:', JSON.stringify(perKey), 'max =', measured.toExponential(3));
    expect(measured).toBeLessThanOrEqual(MID_AZIMUTH_MEASURED + 0.01);
  });

  it('source: setHazeTargets + 共享端点 uniform（改端点不重建材质）', () => {
    const src = sources['./material.ts'];
    expect(src).toMatch(/setHazeTargets/);
    expect(src).toMatch(/hazeU\.haze/);
    expect(src).toMatch(/hazeU\.awayEdge/);
    // 默认端点表达式必须保留 awayHorizonLinear() 调用（既有 pin 的依赖）
    expect(src).toMatch(/awayHorizonLinear\(\)/);
    expect(src).not.toMatch(/HORIZON\.AWAY_GAIN/);
  });
});
