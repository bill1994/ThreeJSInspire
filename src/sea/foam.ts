/**
 * Jacobian foam for the stylized sea — pure functions, no three imports.
 *
 * Foam appears where the summed displacement field compresses: the Jacobian
 * J = (1+dxx)(1+dzz) − dxz·dzx of the TOTAL horizontal displacement drops
 * towards zero at folded crests. The partials must be SUMMED across cascades
 * first — multiplying per-cascade determinants is the classic FFT-ocean bug.
 *
 * `dzx ≡ dxz` for a smooth field; the interface keeps both so callers that
 * have them separately still compute the true determinant.
 */

export interface JacobianPartials {
  dxx: number;
  dzz: number;
  dxz: number;
  dzx: number;
}

/** Determinant of the summed-displacement Jacobian (1 on an undisturbed surface). */
export function jacobianSummed(d: JacobianPartials): number {
  return (1 + d.dxx) * (1 + d.dzz) - d.dxz * d.dzx;
}

/**
 * Foam threshold from measured 1−J samples: the midpoint of the P95 and P99
 * quantiles, so foam covers roughly the top few percent of the surface.
 * Feed it the distribution read from a `?qa=frozen` frame; the resulting
 * number is pinned below until the next measurement.
 */
export function foamThresholdFromP95(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const quantile = (q: number): number => {
    const pos = q * (sorted.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  };
  return (quantile(0.95) + quantile(0.99)) / 2;
}

/**
 * Initial foam threshold on 1−J. PLACEHOLDER pending the first frozen-frame
 * measurement — re-pin from `foamThresholdFromP95` once Task 12's QA pass
 * reads a real distribution.
 */
export const SEA_FOAM_THRESHOLD = 0.35;
