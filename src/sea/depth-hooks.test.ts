import { describe, it, expect } from 'vitest';
import { SEA_DEPTH_FALLBACK, SHORE, depthTerms } from './depth-hooks';

/** Depth sweep from the water's edge (0) to deep water (1). */
const SWEEP = Array.from({ length: 41 }, (_, i) => i / 40);

describe('SEA_DEPTH_FALLBACK', () => {
  it('is all-deep, so every shore term is dormant', () => {
    expect(SEA_DEPTH_FALLBACK).toBe(1);
    const t = depthTerms(SEA_DEPTH_FALLBACK);
    expect(t.shoreFade).toBe(0);
    expect(t.shoreline).toBe(0);
    expect(t.intersection).toBe(0);
  });
});

describe('SHORE constants', () => {
  it('orders the bands from thinnest to widest', () => {
    expect(SHORE.lineWidth).toBeGreaterThan(0);
    expect(SHORE.lineWidth).toBeLessThan(SHORE.foamWidth);
    expect(SHORE.foamWidth).toBeLessThan(SHORE.fadeFar);
    expect(SHORE.fadeNear).toBeGreaterThanOrEqual(0);
    expect(SHORE.fadeNear).toBeLessThan(SHORE.fadeFar);
    expect(SHORE.fadeFar).toBeLessThanOrEqual(1);
  });
});

describe('depthTerms at the water edge', () => {
  it('is fully on at depth 0', () => {
    const t = depthTerms(0);
    expect(t.shoreFade).toBe(1);
    expect(t.shoreline).toBeGreaterThan(0);
    expect(t.intersection).toBeGreaterThan(0);
  });

  it('is fully off in deep water', () => {
    const t = depthTerms(1);
    expect(t.shoreFade).toBe(0);
    expect(t.shoreline).toBe(0);
    expect(t.intersection).toBe(0);
  });
});

describe('depthTerms monotonicity', () => {
  it('never increases as depth grows, for any of the three terms', () => {
    let prev = depthTerms(0);
    for (const d of SWEEP) {
      const t = depthTerms(d);
      expect(t.shoreFade).toBeLessThanOrEqual(prev.shoreFade);
      expect(t.shoreline).toBeLessThanOrEqual(prev.shoreline);
      expect(t.intersection).toBeLessThanOrEqual(prev.intersection);
      prev = t;
    }
  });

  it('stays inside 0..1 everywhere on the sweep', () => {
    for (const d of SWEEP) {
      const t = depthTerms(d);
      for (const v of [t.shoreFade, t.shoreline, t.intersection]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('keeps the shoreline thinner than the shore fade', () => {
    // Half-response point: the line is gone by 0.1, the fade is still visible there.
    const t = depthTerms(0.1);
    expect(t.shoreline).toBe(0);
    expect(t.shoreFade).toBeGreaterThan(0);
  });
});

describe('depthTerms poisoning', () => {
  it('returns all zero for NaN rather than leaking NaN into the frame', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const t = depthTerms(bad);
      expect(t).toEqual({ shoreFade: 0, shoreline: 0, intersection: 0 });
    }
  });

  it('clamps out-of-range depth instead of extrapolating', () => {
    expect(depthTerms(-5)).toEqual(depthTerms(0));
    expect(depthTerms(5)).toEqual(depthTerms(1));
  });
});
