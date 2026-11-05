import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { trainDistance } from './lod';
import {
  B0_TRAIN5_FADE_END_M,
  DISTANCE_TINT,
  FRESNEL_TINT,
  NEAR_GLITTER_FADE_M,
  REFLECTION_EXP,
  TRAIN_FADE_WIDTH_M,
  buildSurfaceMaterial,
  distanceTint01,
  fresnelWeight,
  glitterGain,
  materialUniforms,
  nearGlitterFade,
  reflection01,
  trainWeight,
} from './surface-material';
import { SUN_ROAD } from '../sun-road';
import { SEA_PALETTE, SKY_PALETTE } from '../palettes';

const RP = 5.797e-4;
// d1 for the 11 m / 0.06 m train at the test budget.
const D1_TRAIN5 = 0.06 / RP;

describe('trainWeight', () => {
  it('fades a train out exactly at its visibility distance', () => {
    expect(trainWeight(0.06, trainDistance(0.06, RP), RP)).toBe(0);
    expect(trainWeight(0.06, 103.5, RP)).toBeCloseTo(0, 6);
    expect(trainWeight(0.06, 40, RP)).toBeGreaterThan(0.5);
  });

  it('ramps over one fade width, not as an on/off switch', () => {
    const d1 = D1_TRAIN5;
    const d0 = d1 - TRAIN_FADE_WIDTH_M;
    expect(trainWeight(0.06, d0 - 1, RP)).toBe(1);
    const mid = trainWeight(0.06, (d0 + d1) / 2, RP);
    expect(mid).toBeGreaterThan(0.4);
    expect(mid).toBeLessThan(0.6);
  });

  it('caps the finest train at the B0 edge (M4 exception), because 45 m < d0', () => {
    // Without the cap the weight at the B0 edge is still 1: 45 m is inside
    // d0 = d1 - 48, so the generic fade would carry a 2.2 px step over the edge.
    expect(trainWeight(0.06, 45, RP)).toBe(1);
    expect(trainWeight(0.06, 45, RP, B0_TRAIN5_FADE_END_M)).toBe(0);
    expect(trainWeight(0.06, 44, RP, B0_TRAIN5_FADE_END_M)).toBeGreaterThan(0);
    expect(B0_TRAIN5_FADE_END_M).toBe(45);
  });

  it('degrades to full weight on a broken budget, never to missing water', () => {
    expect(trainWeight(0.06, 40, NaN)).toBe(1);
    expect(trainWeight(0.06, 40, 0)).toBe(1);
    expect(trainWeight(0.06, 40, -1)).toBe(1);
    expect(trainWeight(NaN, 40, RP)).toBe(1);
  });
});

describe('materialUniforms', () => {
  it('carries the per-frame budget and the train count', () => {
    const map = materialUniforms({ trains: 5, radPerPixel: RP });
    expect(map.get('uRadPerPixel')!.value).toBeCloseTo(RP, 9);
    expect(map.get('uTime')!.value).toBe(0);
    expect(map.get('uTrains')!.value).toBe(5);
  });

  it('falls back to the hardest budget and clamps the train count', () => {
    const bad = materialUniforms({ trains: 5, radPerPixel: NaN });
    expect(bad.get('uRadPerPixel')!.value).toBeCloseTo(6.014e-4, 9);
    expect(materialUniforms({ trains: 99, radPerPixel: RP }).get('uTrains')!.value).toBe(5);
    expect(materialUniforms({ trains: -2, radPerPixel: RP }).get('uTrains')!.value).toBe(0);
    expect(materialUniforms({ trains: NaN, radPerPixel: RP }).get('uTrains')!.value).toBe(5);
  });
});

describe('buildSurfaceMaterial', () => {
  it('builds an unlit sea material with the Task 5 uniforms', async () => {
    const { material, uniforms } = await buildSurfaceMaterial(THREE, {
      trains: 5,
      radPerPixel: RP,
    });
    expect(material).toBeDefined();
    expect((material as unknown as { fog: boolean }).fog).toBe(false);
    expect((material as unknown as { positionNode: unknown }).positionNode).toBeDefined();
    expect((material as unknown as { colorNode: unknown }).colorNode).toBeDefined();
    expect(uniforms.uRadPerPixel.value).toBeCloseTo(RP, 9);
    expect(uniforms.uTime.value).toBe(0);
    expect(uniforms.uTrains.value).toBe(5);
  });

  it('builds the flat band with no trains', async () => {
    const { material, uniforms } = await buildSurfaceMaterial(THREE, {
      trains: 0,
      radPerPixel: RP,
    });
    expect(material).toBeDefined();
    expect(uniforms.uTrains.value).toBe(0);
  });

  it('wires the light chain into the graph, not just into the CPU mirrors', async () => {
    const { material } = await buildSurfaceMaterial(THREE, { trains: 5, radPerPixel: RP });
    const userData = (material as unknown as { userData: Record<string, unknown> }).userData;
    expect(userData.seaLight).toBe(true);
    expect(userData.seaUniforms).toBeDefined();
  });
});

describe('light terms (Task 5)', () => {
  it('fades the far field to pure haze between 150 m and 900 m, never before', () => {
    expect(distanceTint01(0)).toBe(0);
    expect(distanceTint01(DISTANCE_TINT.near)).toBe(0);
    expect(distanceTint01((DISTANCE_TINT.near + DISTANCE_TINT.far) / 2)).toBeCloseTo(0.5, 9);
    expect(distanceTint01(DISTANCE_TINT.far)).toBe(1);
    expect(distanceTint01(2000)).toBe(1);
    // A broken distance must not flash the near colour across the patch.
    expect(distanceTint01(NaN)).toBe(1);
  });

  it('moves the far colour toward the contracted haze, not toward some new one', () => {
    // Same colour, two representations (palettes.ts stores the sea as ints and the sky as
    // CSS strings); the contract itself is pinned in palettes.test.ts.
    expect(SEA_PALETTE.haze).toBe(0xff9a5a);
    expect(SKY_PALETTE.horizon).toBe('#ff9a5a');
  });

  it('turns the reflection from the deep colour straight down to the horizon colour at grazing', () => {
    expect(reflection01(1)).toBe(0); // normal straight up: you see the sky's depth, i.e. deep water
    expect(reflection01(0)).toBe(1); // grazing: you see the horizon band
    expect(reflection01(0.5)).toBeCloseTo(Math.pow(0.5, REFLECTION_EXP), 9);
    expect(reflection01(NaN)).toBe(0); // degenerate normal keeps the base colour
    // Monotone in between: no second bright band.
    let prev = 0;
    for (let nY = 1; nY >= 0; nY -= 0.05) {
      const v = reflection01(nY);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
  });

  it('is near-total at grazing and F0 head-on, and the tint it adds is warm', () => {
    expect(fresnelWeight(0)).toBeGreaterThan(0.5);
    expect(fresnelWeight(1)).toBeCloseTo(SUN_ROAD.F0, 9);
    expect(fresnelWeight(NaN)).toBeCloseTo(SUN_ROAD.F0, 9);
    // "Tinted, not white": the added light has to be warmer than it is cool, or it reads
    // as a grey sheen instead of sunset light in the water.
    const r = (FRESNEL_TINT >> 16) & 0xff;
    const g = (FRESNEL_TINT >> 8) & 0xff;
    const b = FRESNEL_TINT & 0xff;
    expect(r).toBeGreaterThan(b);
    expect(r).toBeGreaterThan(g);
    expect(FRESNEL_TINT).not.toBe(0xffffff);
  });

  it('concentrates glitter inside the sun road, floors it outside, and kills it in the near field', () => {
    const onRoad = glitterGain(1, 0, 1);
    const offRoad = glitterGain(1, ((SUN_ROAD.WIDTH_DEG + 20) * Math.PI) / 180, 1);
    expect(onRoad).toBeCloseTo(SUN_ROAD.BASE * SUN_ROAD.ROAD_PEAK, 9);
    expect(onRoad / offRoad).toBeCloseTo(SUN_ROAD.ROAD_PEAK / SUN_ROAD.ROAD_FLOOR, 6);
    expect(offRoad).toBeGreaterThan(0); // the floor is deliberate: no hard road edge
  });

  it('gives no glitter when there is nothing to reflect', () => {
    expect(glitterGain(0, 0, 1)).toBe(0);
    expect(glitterGain(NaN, 0, 1)).toBe(0);
    expect(glitterGain(1, 0, 0)).toBe(0);
    expect(glitterGain(1, 0, NaN)).toBe(0);
    // A degenerate view bearing is "no road", not "no glitter": sun-road.ts:108 chose that,
    // so the floor still applies and the water cannot blink out at a pole.
    expect(glitterGain(1, NaN, 1)).toBeCloseTo(SUN_ROAD.BASE * SUN_ROAD.ROAD_FLOOR, 9);
  });

  it('fades glitter in under the camera so the nearest band is not a solid sheet', () => {
    expect(nearGlitterFade(0)).toBe(0);
    expect(nearGlitterFade(NEAR_GLITTER_FADE_M / 2)).toBeCloseTo(0.5, 9);
    expect(nearGlitterFade(NEAR_GLITTER_FADE_M)).toBe(1);
    expect(nearGlitterFade(500)).toBe(1);
    expect(nearGlitterFade(NaN)).toBe(0);
  });
});

describe('sea module graph (Task 5)', () => {  it('keeps three/webgpu and three/tsl behind dynamic import()', async () => {
    const modules = import.meta.glob('./*.ts', {
      query: '?raw',
      eager: true,
      import: 'default',
    }) as Record<string, string>;
    const STATIC_WEBGPU_IMPORT =
      /^\s*import\s+(?!type\b)[^;]*from\s+['"]three\/(webgpu|tsl)['"]/m;
    const offenders = Object.entries(modules)
      .filter(([path]) => !path.endsWith('.test.ts'))
      .filter(([, source]) => STATIC_WEBGPU_IMPORT.test(source))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('samples the field at base coordinates, never at the displaced position', async () => {
    const modules = import.meta.glob('./surface-material.ts', {
      query: '?raw',
      eager: true,
      import: 'default',
    }) as Record<string, string>;
    const source = (Object.values(modules)[0] ?? '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');
    expect(source).toContain('modelWorldMatrix');
    expect(source).toContain('positionLocal');
    expect(source).not.toContain('positionWorld');
  });
});
