/**
 * Band-continuity metrics for sea colour-band fields (plan 2026-11-03-sea-fbm-band-continuity,
 * Task 0). Pure TypeScript, no three dependency, so the same numbers can be produced for
 * a CPU field, a TSL mirror, or a calibration probe without a renderer.
 *
 * The defect being quantified: "band boundaries read as broken patches". Four numbers
 * capture it:
 * - edgeCoherence   |Σ e^{2iθ}|/N over boundary pixels (2θ folds direction into orientation,
 *                   so a straight family of parallel edges scores 1 and isotropic blobs ~0.2)
 * - componentsPer100m2  how fragmented the top band is (8-connected, per 100 m²)
 * - extentAlongWind mean reach of a top-band component along the wind (m)
 * - edgeCurvature   mean |κ| of the boundary as a level set, κ = -div(∇f/|∇f|) (1/m)
 * - edgeSpacing     median gap between consecutive boundary crossings along wind-parallel
 *                   scanlines (m) — the "highest octave ≥ 3× spacing" rule reads this
 * - occupancy       the four bands' area shares, summing to 1
 */

export interface BandMetrics {
  /** Boundary tangent 2θ circular statistic: 0 = isotropic patches, 1 = parallel stripes. */
  edgeCoherence: number;
  /** Top-band 8-connected components per 100 m². */
  componentsPer100m2: number;
  /** Mean along-wind reach of a top-band component (m). */
  extentAlongWind: number;
  /** Mean |level-set curvature| of band boundaries (1/m); lower = straighter. */
  edgeCurvature: number;
  /** Median gap between consecutive boundary crossings along the wind (m). */
  edgeSpacing: number;
  /** Area share of deep / mid / lit / crest; sums to 1. */
  occupancy: [number, number, number, number];
}

export interface BandMetricsOptions {
  /** Exactly three ascending thresholds (deep|mid|lit|crest boundaries). */
  stops: readonly number[];
  /** Grid resolution per axis. Default 512. */
  size?: number;
  /** World extent sampled as [-extent/2, extent/2] on both axes (metres). */
  extent: number;
  /** Wind direction in world coordinates; any nonzero length. */
  wind: [number, number];
  /** Which stop defines the "top band" for the component metrics. Default: stops[2]. */
  topStop?: number;
  /** Wind-parallel scanline count for edgeSpacing. Default 64. */
  scanlines?: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function bandMetrics(
  sample: (x: number, z: number) => number,
  opts: BandMetricsOptions,
): BandMetrics {
  const stops = opts.stops;
  if (stops.length !== 3) {
    throw new Error(`bandMetrics expects exactly three stops (got ${stops.length})`);
  }
  if (!(stops[0] < stops[1] && stops[1] < stops[2])) {
    throw new Error(`bandMetrics stops must be strictly ascending (got ${stops.join(', ')})`);
  }
  const size = opts.size ?? 512;
  const extent = opts.extent;
  if (!(size >= 16) || !(extent > 0)) {
    throw new Error(`bandMetrics needs size >= 16 and extent > 0 (got ${size}, ${extent})`);
  }
  const wlen = Math.hypot(opts.wind[0], opts.wind[1]);
  if (!(wlen > 0) || !Number.isFinite(wlen)) {
    throw new Error('bandMetrics wind must be a nonzero finite vector');
  }
  const wx = opts.wind[0] / wlen;
  const wz = opts.wind[1] / wlen;
  const topStop = opts.topStop ?? stops[2];
  const scanlineCount = opts.scanlines ?? 64;

  // ------------------------------------------------------------------
  // Sample the field on a size×size grid.
  // ------------------------------------------------------------------
  const step = extent / (size - 1);
  const half = extent / 2;
  const field = new Float64Array(size * size);
  for (let j = 0; j < size; j++) {
    const z = -half + j * step;
    const row = j * size;
    for (let i = 0; i < size; i++) {
      field[row + i] = sample(-half + i * step, z);
    }
  }

  const at = (i: number, j: number): number => field[j * size + i];

  // ------------------------------------------------------------------
  // Gradient (central differences), level-set normal, curvature.
  // Interior only: the 1-px border has no central difference.
  // ------------------------------------------------------------------
  const inv2 = 1 / (2 * step);
  const edge = new Uint8Array(size * size);
  const normX = new Float64Array(size * size);
  const normZ = new Float64Array(size * size);
  const curv = new Float64Array(size * size);
  for (let j = 1; j < size - 1; j++) {
    const row = j * size;
    for (let i = 1; i < size - 1; i++) {
      const gx = (at(i + 1, j) - at(i - 1, j)) * inv2;
      const gz = (at(i, j + 1) - at(i, j - 1)) * inv2;
      const len = Math.hypot(gx, gz);
      const k = row + i;
      if (len > 1e-12) {
        normX[k] = gx / len;
        normZ[k] = gz / len;
      }
    }
  }
  for (let j = 2; j < size - 2; j++) {
    const row = j * size;
    for (let i = 2; i < size - 2; i++) {
      const k = row + i;
      if (normX[k] === 0 && normZ[k] === 0) continue;
      const dx = (normX[k + 1] - normX[k - 1]) * inv2;
      const dz = (normZ[k + size] - normZ[k - size]) * inv2;
      curv[k] = Math.abs(dx + dz); // |−div(n)| — sign carries no information here
    }
  }

  // ------------------------------------------------------------------
  // Edge pixels: any 4-neighbour pair straddles any stop.
  // ------------------------------------------------------------------
  let c2 = 0;
  let s2 = 0;
  let edgeCount = 0;
  let curvSum = 0;
  let curvCount = 0;
  const crosses = (a: number, b: number): boolean => {
    for (let s = 0; s < 3; s++) {
      if ((a - stops[s]) * (b - stops[s]) < 0) return true;
    }
    return false;
  };
  for (let j = 1; j < size - 1; j++) {
    const row = j * size;
    for (let i = 1; i < size - 1; i++) {
      const k = row + i;
      const v = field[k];
      if (!crosses(v, field[k + 1]) && !crosses(v, field[k + size])) continue;
      edge[k] = 1;
      const gx = (at(i + 1, j) - at(i - 1, j)) * inv2;
      const gz = (at(i, j + 1) - at(i, j - 1)) * inv2;
      if (!(Math.hypot(gx, gz) > 1e-12)) continue;
      // Tangent = gradient rotated 90°: (-gz, gx). 2θ folds ±π into one orientation.
      const theta = Math.atan2(gx, -gz); // atan2 of (ty, tx) with t = (-gz, gx)
      c2 += Math.cos(2 * theta);
      s2 += Math.sin(2 * theta);
      edgeCount++;
      if (curv[k] > 0) {
        curvSum += curv[k];
        curvCount++;
      }
    }
  }
  const edgeCoherence = edgeCount > 0 ? Math.hypot(c2, s2) / edgeCount : 0;
  const edgeCurvature = curvCount > 0 ? curvSum / curvCount : 0;

  // ------------------------------------------------------------------
  // Top-band components: 8-connected flood fill on field > topStop.
  // ------------------------------------------------------------------
  const visited = new Uint8Array(size * size);
  const stack = new Int32Array(size * size);
  let componentCount = 0;
  let extentSum = 0;
  for (let j0 = 0; j0 < size; j0++) {
    const row0 = j0 * size;
    for (let i0 = 0; i0 < size; i0++) {
      const k0 = row0 + i0;
      if (visited[k0] || !(field[k0] > topStop)) continue;
      componentCount++;
      let sp = 0;
      stack[sp++] = k0;
      visited[k0] = 1;
      let aMin = Infinity;
      let aMax = -Infinity;
      while (sp > 0) {
        const k = stack[--sp];
        const i = k % size;
        const j = (k / size) | 0;
        const a = (-half + i * step) * wx + (-half + j * step) * wz;
        if (a < aMin) aMin = a;
        if (a > aMax) aMax = a;
        for (let dj = -1; dj <= 1; dj++) {
          const jj = j + dj;
          if (jj < 0 || jj >= size) continue;
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            if (ii < 0 || ii >= size) continue;
            const kk = jj * size + ii;
            if (visited[kk] || !(field[kk] > topStop)) continue;
            visited[kk] = 1;
            stack[sp++] = kk;
          }
        }
      }
      extentSum += aMax - aMin;
    }
  }
  const areaPer100 = (extent * extent) / 100;
  const componentsPer100m2 = componentCount / areaPer100;
  const extentAlongWind = componentCount > 0 ? extentSum / componentCount : 0;

  // ------------------------------------------------------------------
  // edgeSpacing: scanlines PERPENDICULAR to the wind (across-band profile),
  // arranged along the wind; median gap between consecutive stop crossings.
  // Band edges of a painted sea run along the wind, so their spacing only
  // exists across it — a wind-parallel scanline would never cross one.
  // ------------------------------------------------------------------
  const qx = -wz;
  const qz = wx;
  const sampleBilinear = (x: number, z: number): number => {
    const gx = Math.min(Math.max((x + half) / step, 0), size - 1);
    const gz = Math.min(Math.max((z + half) / step, 0), size - 1);
    const i = Math.min(Math.floor(gx), size - 2);
    const j = Math.min(Math.floor(gz), size - 2);
    const fx = gx - i;
    const fz = gz - j;
    const v00 = field[j * size + i];
    const v10 = field[j * size + i + 1];
    const v01 = field[(j + 1) * size + i];
    const v11 = field[(j + 1) * size + i + 1];
    return (
      v00 * (1 - fx) * (1 - fz) + v10 * fx * (1 - fz) + v01 * (1 - fx) * fz + v11 * fx * fz
    );
  };
  const gaps: number[] = [];
  const scanStep = step / 2;
  const nScan = Math.max(2, Math.round(extent / scanStep));
  for (let k = 0; k < scanlineCount; k++) {
    const s = -half + ((k + 0.5) * extent) / scanlineCount;
    let prev = sampleBilinear(wx * s + qx * -half, wz * s + qz * -half);
    let crossedAt: number[] = [];
    for (let m = 1; m <= nScan; m++) {
      const t = -half + m * scanStep;
      const v = sampleBilinear(wx * s + qx * t, wz * s + qz * t);
      for (let si = 0; si < 3; si++) {
        const stop = stops[si];
        if ((prev - stop) * (v - stop) < 0) {
          const frac = (stop - prev) / (v - prev);
          crossedAt.push(t - scanStep + frac * scanStep);
        }
      }
      prev = v;
    }
    for (let m = 1; m < crossedAt.length; m++) gaps.push(crossedAt[m] - crossedAt[m - 1]);
  }
  const edgeSpacing = median(gaps);

  // ------------------------------------------------------------------
  // Occupancy.
  // ------------------------------------------------------------------
  const counts: [number, number, number, number] = [0, 0, 0, 0];
  const total = size * size;
  for (let k = 0; k < total; k++) {
    const v = field[k];
    if (v < stops[0]) counts[0]++;
    else if (v < stops[1]) counts[1]++;
    else if (v < stops[2]) counts[2]++;
    else counts[3]++;
  }
  const occupancy: [number, number, number, number] = [
    counts[0] / total,
    counts[1] / total,
    counts[2] / total,
    counts[3] / total,
  ];

  return {
    edgeCoherence,
    componentsPer100m2,
    extentAlongWind,
    edgeCurvature,
    edgeSpacing,
    occupancy,
  };
}
