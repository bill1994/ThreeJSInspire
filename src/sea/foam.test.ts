import { describe, it, expect } from 'vitest';
import { FOAM, collapseGain, foamMask, shoreFoam } from './foam';
import { SEA_DEPTH_FALLBACK } from './depth-hooks';

describe('foam', () => {
  it('never foams unstrained water', () => {
    // J = 1 is the unstrained surface: no collapse, so nothing to show. The noise must not
    // be able to invent foam there, which is why the gain gate is applied before it.
    expect(collapseGain(1)).toBe(0);
    expect(foamMask(1, 0)).toBe(0);
    expect(foamMask(1, 1)).toBe(0);
    expect(foamMask(1, -1)).toBe(0);
    // J > 1 is stretching, not collapse: foam on stretched water would read as a smear.
    expect(foamMask(1.2, 0)).toBe(0);
  });

  it('covers a collapsed crest', () => {
    expect(collapseGain(0)).toBe(1);
    expect(collapseGain(0.5)).toBe(0.5);
    expect(foamMask(0.25, 0)).toBeGreaterThan(0.5);
    expect(foamMask(0, 0)).toBeCloseTo(1, 6);
  });

  it('keeps a hard edge — the ramp is narrower than the driver', () => {
    // Two ramp widths below the threshold reads as no foam, two above reads as full foam.
    // That narrowness is the graphic look; a wide ramp turns the Jacobian into a grey haze.
    const below = foamMask(1 - (FOAM.edge - 2 * FOAM.smooth), 0);
    const above = foamMask(1 - (FOAM.edge + 2 * FOAM.smooth), 0);
    expect(below).toBeLessThan(0.02);
    expect(above).toBeGreaterThan(0.98);
    expect(foamMask(1 - FOAM.edge, 0)).toBeCloseTo(0.5, 6);
  });

  it('lets the scroll break the edge instead of tracing the Jacobian contour', () => {
    // At the half-on gain the two scroll phases must disagree: that is what makes the foam
    // edge dissolve rather than follow a contour line exactly. Measured at the ramp centre,
    // because that is the only place a threshold shift can change the answer.
    const jac = 1 - FOAM.edge; // gain == edge, i.e. the ramp centre
    expect(foamMask(jac, -1)).toBeGreaterThan(foamMask(jac, 0));
    expect(foamMask(jac, 0)).toBeGreaterThan(foamMask(jac, 1));
    expect(foamMask(jac, -1) - foamMask(jac, 1)).toBeGreaterThan(0.4);
  });

  it('treats a broken Jacobian as open water, never as a hole in the ocean', () => {
    expect(foamMask(NaN, 0)).toBe(0);
    expect(collapseGain(NaN)).toBe(0);
    expect(collapseGain(Infinity)).toBe(0);
    // A broken noise sample must not delete real foam either.
    expect(foamMask(0.2, NaN)).toBe(foamMask(0.2, 0));
  });

  it('stays dormant on the open-water depth fallback, and wakes at the shore', () => {
    // The shore term is wired but has nothing to intersect yet (depth-hooks.ts fallback).
    expect(shoreFoam(SEA_DEPTH_FALLBACK)).toBe(0);
    expect(shoreFoam(NaN)).toBe(0);
    expect(shoreFoam(0)).toBeGreaterThan(0.5);
  });
});
