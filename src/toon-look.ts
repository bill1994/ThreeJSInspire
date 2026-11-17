/**
 * src/toon-look.ts — toon-look outlet posterize: constants + the JS mirror pure fn
 * (toon-look-toggle Phase 1 Task 2, design §T2).
 *
 * THE MATH (calibration product — anchor values came from the toon-audit
 * `steps.json` capture (raw evidence purged with `artifacts/` 2026-11-16); the
 * pins below are the survivors. Hue curve is a my-call initial value ratified
 * for Phase 1):
 *
 *     sanitize  any non-finite component → the whole colour walks the black
 *               pipeline (pure-function totality; GPU inputs are finite by
 *               construction, the TSL side therefore has no isFinite branch —
 *               documented divergence, mirrors the energy den-guard precedent)
 *     t         = lum(c)                                    // Rec.709, linear
 *     idx       = #{ k : t >= TOON_BUCKET_MIDS[k] }         // nearest-anchor bucket
 *     anchor    = TOON_STEPS[idx]
 *     {tint, w} = TOON_HUE_SHIFT[idx]                       // tint.lum == anchor
 *     ch        = mix(c, tint, w)                           // hue pull: dark→purple, lit→warm
 *     kl        = anchor / max(lum(ch), TOON_LUM_EPS)       // luminance renormalise
 *     c''       = ch · kl                                   // lum(c'') == anchor within 1e-6 (unitLum float rounding)
 *     out       = mix(c, c'', amount)
 *
 * Properties the tests pin (sky-color-js.test.ts, outlet posterize describe):
 *   · amount=0 is bit-identical passthrough (mix with t=0 collapses to c)
 *   · amount=1 lands every output ON the anchor luminance set, monotone in the
 *     input luminance (threshold bucketing over sorted anchors is monotone)
 *   · every HUE weight is > 0, so even black maps to lum == anchor (ch = w·tint)
 *   · NaN/Inf never leaks: sanitize → black → bucket 0 rep (lum = TOON_STEPS[0])
 *
 * Anchor calibration (steps.json, 2026-11-13): reference-key diffuse sky spans
 * [0.0475, 0.7177], mean 0.1209, 63% of the dome below 0.075. The anchors
 * straddle that profile — [0.02] night-floor guard (night-key peaks ≈ 0.034:
 * a higher darkest anchor would brighten the night sky ~2×; Review Focus 2),
 * [0.08] upper-dome mass (q66), [0.18]/[0.32] the dominant horizon gradient
 * (q75/q90), [0.52] bright glow band (q99.5), [0.75] glow tip + the whole sun
 * disc (disc peaks ≈ 1.1 all land in bucket 5). No material disagreement with
 * the plan's my-call initial values → kept verbatim.
 *
 * Pure module: no THREE import — the TSL side (sky-webgpu.ts) imports the same
 * constants and hand-writes the identical expression over TSL nodes (dual
 * mirror; the source pin in sky-color-js.test.ts is the drift guard).
 */
import type { Vec3 } from './sky-track';

/** Rec.709 luminance weights — the SAME coefficients the outlet quantizes by. */
export const TOON_LUM_WEIGHTS: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];

/** Denominator floor for the luminance renormalise (pure guard, never active
 * for real sky colours: lum(ch) ≥ minWeight · anchor ≥ 0.18 · 0.02). */
export const TOON_LUM_EPS = 1e-6;

/** The 6 anchor luminances (calibration product, see header). Ascending. */
export const TOON_STEPS: readonly number[] = [0.02, 0.08, 0.18, 0.32, 0.52, 0.75];

/** Nearest-anchor bucket thresholds: pairwise midpoints of TOON_STEPS. */
export const TOON_BUCKET_MIDS: readonly number[] = TOON_STEPS.slice(0, -1).map(
  (s, i) => (s + TOON_STEPS[i + 1]) / 2,
);

export interface ToonHueShift {
  /** Bucket representative tint, linear RGB, luminance == the anchor itself. */
  readonly tint: Vec3;
  /** mix(c, tint, weight) hue-pull strength (always > 0 — see header). */
  readonly weight: number;
}

// Hue directions authored as linear-RGB ratios, normalised to unit luminance so
// each bucket tint = dir · anchor carries luminance == anchor exactly.
const PURPLE_RATIO: Vec3 = [0.45, 0.18, 1.0]; // dark buckets pulled toward purple
const WARM_RATIO: Vec3 = [1.0, 0.55, 0.28]; // lit buckets pulled toward warm orange

const lumOf = (v: Vec3): number =>
  TOON_LUM_WEIGHTS[0] * v[0] + TOON_LUM_WEIGHTS[1] * v[1] + TOON_LUM_WEIGHTS[2] * v[2];

const unitLum = (v: Vec3): Vec3 => {
  const l = lumOf(v);
  return [v[0] / l, v[1] / l, v[2] / l];
};

const PURPLE = unitLum(PURPLE_RATIO);
const WARM = unitLum(WARM_RATIO);

// Per-anchor hue curve (my-call initial): dark anchors pull purple hardest,
// the middle nearly pure posterize, lit anchors pull warm.
const HUE_DIRS: readonly Vec3[] = [PURPLE, PURPLE, PURPLE, PURPLE, WARM, WARM];
const HUE_WEIGHTS: readonly number[] = [0.55, 0.45, 0.3, 0.18, 0.32, 0.45];

/** Per-anchor hue-shift anchor table — SAME source the TSL graph imports. */
export const TOON_HUE_SHIFT: readonly ToonHueShift[] = HUE_DIRS.map((dir, i) => ({
  tint: [dir[0] * TOON_STEPS[i], dir[1] * TOON_STEPS[i], dir[2] * TOON_STEPS[i]] as Vec3,
  weight: HUE_WEIGHTS[i],
}));

/**
 * The outlet posterize over one linear RGB colour. `amount` is the master
 * toon lever (uToon): 0 = bit-identical passthrough, 1 = full 6-step
 * posterize, in between = mix(c, c'', amount). See the header for the math
 * and the pinned properties.
 */
export function toonQuantizeJs(c: Vec3, amount: number): Vec3 {
  // sanitize: any non-finite component → whole colour walks the black pipeline
  const finite =
    Number.isFinite(c[0]) && Number.isFinite(c[1]) && Number.isFinite(c[2]);
  const cs: Vec3 = finite ? [c[0], c[1], c[2]] : [0, 0, 0];

  const t = lumOf(cs);
  let idx = 0;
  for (let i = 0; i < TOON_BUCKET_MIDS.length; i += 1) {
    if (t >= TOON_BUCKET_MIDS[i]) idx = i + 1;
  }
  const shift = TOON_HUE_SHIFT[idx];
  const anchor = TOON_STEPS[idx];

  // hue pull toward the bucket tint (tint luminance == anchor)
  const w = shift.weight;
  const ch: Vec3 = [
    (1 - w) * cs[0] + w * shift.tint[0],
    (1 - w) * cs[1] + w * shift.tint[1],
    (1 - w) * cs[2] + w * shift.tint[2],
  ];
  // luminance renormalise: lum(c'') == anchor exactly
  const kl = anchor / Math.max(lumOf(ch), TOON_LUM_EPS);
  const c2: Vec3 = [ch[0] * kl, ch[1] * kl, ch[2] * kl];

  // the outlet mix — amount=0 collapses to cs bit-exactly
  return [
    (1 - amount) * cs[0] + amount * c2[0],
    (1 - amount) * cs[1] + amount * c2[1],
    (1 - amount) * cs[2] + amount * c2[2],
  ];
}
