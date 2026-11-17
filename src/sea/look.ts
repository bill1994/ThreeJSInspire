import { C1_VERTEX_MIP_LOD } from './cascades';
import { HAZE_CONVERGE_START, HAZE_CONVERGE_END, WATER_OPTICS } from './water-shading';

export type SeaLook = 'legacy' | 'painted';
export const parseSeaLook = (raw: string | null): SeaLook => raw === 'painted' ? 'painted' : 'legacy';
export const SEA_DIAGNOSTICS = ['none', 'detail', 'fine', 'slope', 'reflection', 'road', 'foam'] as const;
export type SeaDiagnostic = typeof SEA_DIAGNOSTICS[number];
export function parseSeaDiagnostic(raw: string | null): SeaDiagnostic {
  return SEA_DIAGNOSTICS.find(value => value === raw) ?? 'none';
}

/** One candidate recipe, shared by JS mirrors and the TSL material. */
export const PAINTED_SEA = {
  slopeGain: 10,
  // 3 m texels (~15 m waves): soften the smallest octave without erasing chop.
  c1MinLod: 2,
  detail: 0.2,
  reflection: 0.65,
  road: 0.72,
  foam: 0.45,
  crestLow: -0.18,
  crestHigh: 0.24,
  crestTint: 0.48,
  bodySun: 0.55,
  crestGlow: 0.28,
  gloss: 64,
  sparkle: 0.08,
} as const;

export function seaLookSettings(look: SeaLook, diagnostic: SeaDiagnostic = 'none') {
  const p = look === 'painted';
  const settings = {
    painted: p ? 1 : 0,
    slopeGain: Number(p ? PAINTED_SEA.slopeGain : WATER_OPTICS.SLOPE_GAIN),
    c1MinLod: p ? PAINTED_SEA.c1MinLod : 0,
    detail: p ? PAINTED_SEA.detail : 1,
    reflection: p ? PAINTED_SEA.reflection : 1,
    road: p ? PAINTED_SEA.road : 1,
    foam: p ? PAINTED_SEA.foam : 1,
  };
  // Independent ablations: geometry, spectrum and quality gates never change.
  if (diagnostic === 'fine') settings.c1MinLod = C1_VERTEX_MIP_LOD;
  else if (diagnostic === 'slope') settings.slopeGain = 8;
  else if (diagnostic !== 'none') settings[diagnostic] = 0;
  return settings;
}

/** Mirror of the footprint-widened crest transition in material.ts. */
export function paintedCrest(height: number, footprint: number): number {
  if (!Number.isFinite(height) || !Number.isFinite(footprint)) return 0;
  const aa = Math.max(0, footprint);
  const t = Math.min(1, Math.max(0, (height - (PAINTED_SEA.crestLow - aa)) /
    (PAINTED_SEA.crestHigh - PAINTED_SEA.crestLow + 2 * aa)));
  return t * t * (3 - 2 * t);
}

/** JS mirror: away weighting becomes independent of reflection at the edge. */
export function paintedHazeWeight(cosAz: number, lowSky: number, distance: number): number {
  if (![cosAz, lowSky, distance].every(Number.isFinite)) return 0;
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  const away = clamp((1 - cosAz) * 0.5) ** 1.2;
  const t = clamp((distance - HAZE_CONVERGE_START) / (HAZE_CONVERGE_END - HAZE_CONVERGE_START));
  const converge = t * t * (3 - 2 * t);
  return away * (clamp(lowSky) + (1 - clamp(lowSky)) * converge);
}
