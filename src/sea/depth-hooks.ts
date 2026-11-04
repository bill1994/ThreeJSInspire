/**
 * Shore interface — dormant by default.
 *
 * The sea has no terrain to talk to yet, so every shore term here is driven by a single
 * 0..1 depth value and the fallback is `SEA_DEPTH_FALLBACK = 1` (all deep), where all
 * three terms evaluate to exactly `0`. When procedural terrain lands it plugs a depth
 * texture in behind the same interface and the sea needs no changes: swap the constant
 * for a sample.
 *
 * Deliberate limits:
 * - **Smoothstep gates only, no noise.** Foam noise lives in `foam.ts`; mixing a noise
 *   source in here would make the dormancy guarantee impossible to state as `=== 0`.
 * - **Pure functions of one number.** No depth texture, no camera, no time. That is what
 *   makes the whole shore layer testable before any terrain exists.
 *
 * Depth is 0 at the water's edge and 1 in open water. Every term is strongest at the edge
 * and decays monotonically inward.
 */

/** Depth value meaning "no shore here": open water, every shore term dormant. */
export const SEA_DEPTH_FALLBACK = 1;

/**
 * Band edges, in the same 0..1 depth space.
 *
 * Ordered thinnest-to-widest on purpose: a crisp waterline sits inside the intersection
 * foam band, which sits inside the overall shore fade (`depth-hooks.test.ts` pins the
 * ordering, because getting it backwards reads as a wide grey smear at the shore).
 */
export const SHORE = {
  /** Depth where the shore fade starts easing off. Below this it stays fully on. */
  fadeNear: 0.04,
  /** Depth where the shore fade has fully released: open water. */
  fadeFar: 0.35,
  /** Width of the crisp waterline. */
  lineWidth: 0.06,
  /** Width of the foam band where geometry cuts the surface. */
  foamWidth: 0.18,
} as const;

export interface ShoreTerms {
  /** 1 at the water's edge, 0 in open water: how much shoreline treatment to apply. */
  shoreFade: number;
  /** The crisp waterline itself. Thinner than `shoreFade`. */
  shoreline: number;
  /** Foam where terrain intersects the surface. */
  intersection: number;
}

const DORMANT: ShoreTerms = { shoreFade: 0, shoreline: 0, intersection: 0 };

/** Hermite smoothstep with the usual clamping; `edge0 >= edge1` degenerates to a step. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const span = edge1 - edge0;
  if (!(span > 0)) return x >= edge1 ? 1 : 0;
  const t = Math.min(Math.max((x - edge0) / span, 0), 1);
  return t * t * (3 - 2 * t);
}

/** 1 at the shore, released to 0 by `edge`. */
function inwardGate(edge: number, depth: number): number {
  return 1 - smoothstep(0, edge, depth);
}

/**
 * Evaluate the three shore terms for a depth sample.
 *
 * `depth01` is clamped to `0..1`. Anything non-finite returns the fully dormant set
 * rather than propagating NaN into a frame — a missing depth read must look like open
 * water, never like a hole in the ocean.
 */
export function depthTerms(depth01: number): ShoreTerms {
  if (!Number.isFinite(depth01)) return { ...DORMANT };

  const depth = Math.min(Math.max(depth01, 0), 1);

  return {
    shoreFade: 1 - smoothstep(SHORE.fadeNear, SHORE.fadeFar, depth),
    shoreline: inwardGate(SHORE.lineWidth, depth),
    intersection: inwardGate(SHORE.foamWidth, depth),
  };
}
