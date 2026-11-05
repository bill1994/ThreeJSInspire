import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { trainDistance } from './lod';
import {
  B0_TRAIN5_FADE_END_M,
  TRAIN_FADE_WIDTH_M,
  buildSurfaceMaterial,
  materialUniforms,
  trainWeight,
} from './surface-material';

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
});

describe('sea module graph (Task 5)', () => {
  it('keeps three/webgpu and three/tsl behind dynamic import()', async () => {
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
