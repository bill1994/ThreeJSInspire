import { C1_VERTEX_MIP_LOD } from './cascades';
import { HAZE_CONVERGE_START, HAZE_CONVERGE_END, WATER_OPTICS } from './water-shading';
import { PAINT_CONSTANTS } from '../bg-cumulus-paint';

export type SeaLook = 'legacy' | 'painted';
export const parseSeaLook = (raw: string | null): SeaLook => raw === 'painted' ? 'painted' : 'legacy';
export const SEA_DIAGNOSTICS = ['none', 'detail', 'fine', 'slope', 'reflection', 'road', 'foam'] as const;
export type SeaDiagnostic = typeof SEA_DIAGNOSTICS[number];
export function parseSeaDiagnostic(raw: string | null): SeaDiagnostic {
  return SEA_DIAGNOSTICS.find(value => value === raw) ?? 'none';
}

/** Base painted recipe, retained for the previous-stage comparison. */
export const PAINTED_SEA = {
  slopeGain: 10,
  // 3 m texels (~15 m waves): soften the smallest octave without erasing chop.
  c1MinLod: 2,
  detail: 0.2,
  reflection: 0.16,
  road: 0.52,
  bodyShadeLift: [0.3, 0.6] as const,
  bodyLightLift: 0.16,
  rippleHeight: [0.008, 0.03] as const,
  rippleSlope: [0.001, 0.006] as const,
  rippleFade: [160, 1100] as const,
  rippleShadow: 0.35,
  foam: 0.72,
  foamHeight: [0.045, 0.075] as const,
  foamCurvature: [0.001, 0.0035] as const,
  foamSlope: [0.0005, 0.0018] as const,
  foamBreak: [0.45, 0.58] as const,
  accentHeight: 0.016,
  accentWidth: 0.004,
  accentStrength: 0.045,
  markFade: [280, 850] as const,
  roadEdge: [0.12, 0.42] as const,
  roadPlateau: 0.62,
  crestLow: -0.18,
  crestHigh: 0.24,
  crestTint: 0.48,
  bodySun: 0.55,
  crestGlow: 0.28,
  gloss: 64,
  sparkle: 0.08,
} as const;

/** Stage 2: wave form remains legible away from the specular road. Linear RGB. */
export const SEA_REFINEMENT = {
  // Restrict large sun patches only in the near field while skimming.
  roadHeight: [18, 55] as const,
  roadDistance: [60, 240] as const,
  roadNearGain: 0.42,
  roadNearGloss: 110,
  formHeight: 4,
  formSlope: 35,
  formSwell: 0.16,
  formEdge: [-0.16, 0.18] as const,
  formFade: [300, 1600] as const,
  formStrength: 0.48,
  foamSlopeGain: 1.8,
  foamBreak: [0.50, 0.65] as const,
  foamFade: [140, 650] as const,
  foamPeriod: [64, 128] as const,
  lowTierFoam: 0.22,
  waterNight: [0.20, 0.32, 0.48] as const,
  foamNight: [0.08, 0.13, 0.20] as const,
} as const;

function ramp(low: number, high: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

/** CPU mirror of the sea's cloud-style light/shadow boundaries. */
export function paintedLightWeights(normalDotSun: number, height: number, footprint = 0, sunUp = 0) {
  if (![normalDotSun, height, footprint, sunUp].every(Number.isFinite)) return { lit: 0, shade: 0 };
  const light = Math.max(0, Math.min(1, (normalDotSun - sunUp * 0.85) * 1.5 + 0.42 + height * 0.7));
  const aa = Math.max(0, footprint);
  return {
    lit: ramp(PAINT_CONSTANTS.hardEdge[0] - aa, PAINT_CONSTANTS.hardEdge[1] + aa, light),
    shade: ramp(...PAINT_CONSTANTS.shadeMix, light),
  };
}

/** CPU mirror of wind-wave shoulder strokes and their screen/distance fades. */
export function paintedRippleWeights(height: number, windSlope: number, distance: number,
  heightFootprint = 0, slopeFootprint = 0) {
  if (![height, windSlope, distance, heightFootprint, slopeFootprint].every(Number.isFinite)) {
    return { light: 0, dark: 0 };
  }
  const p = PAINTED_SEA;
  const hAA = Math.max(0, heightFootprint);
  const sAA = Math.max(0, slopeFootprint);
  const shoulder = 1 - ramp(p.rippleSlope[0] - sAA, p.rippleSlope[1] + sAA, Math.abs(windSlope));
  const width = p.rippleHeight[1] - p.rippleHeight[0];
  const coverage = width / Math.max(hAA, width);
  const envelope = shoulder * coverage * (1 - ramp(...p.rippleFade, distance));
  return {
    light: ramp(p.rippleHeight[0] - hAA, p.rippleHeight[1] + hAA, height) * envelope,
    dark: ramp(p.rippleHeight[0] - hAA, p.rippleHeight[1] + hAA, -height) * envelope * p.rippleShadow,
  };
}

/** Previous-stage crest/shoulder recipe, before opacity and haze. Stage 2's
 * changed width, gaps and distance handling are checked by the GPU image probe. */
export function paintedMarks(height: number, curvature: number, slope: number, distance: number,
  heightAA = 0, curvatureAA = 0, slopeAA = 0, breakup = 1, breakupAA = 0): number {
  if (![height, curvature, slope, distance, heightAA, curvatureAA, slopeAA, breakup, breakupAA].every(Number.isFinite)) return 0;
  const hAA = Math.max(0, heightAA), cAA = Math.max(0, curvatureAA), sAA = Math.max(0, slopeAA);
  const p = PAINTED_SEA;
  const crest = ramp(p.foamHeight[0] - hAA, p.foamHeight[1] + hAA, height);
  const ridge = 1 - ramp(p.foamSlope[0] - sAA, p.foamSlope[1] + sAA, Math.abs(slope));
  const activity = ramp(p.foamCurvature[0] - cAA, p.foamCurvature[1] + cAA, curvature);
  const fade = 1 - ramp(...p.markFade, distance);
  const accent = (1 - ramp(p.accentWidth, p.accentWidth + Math.max(hAA, 0.003), Math.abs(height - p.accentHeight)))
    * p.accentWidth / Math.max(hAA, p.accentWidth) * p.accentStrength;
  const broken = ramp(p.foamBreak[0] - Math.max(0, breakupAA), p.foamBreak[1] + Math.max(0, breakupAA), breakup);
  return Math.max(crest * ridge, accent) * activity * fade * broken;
}

export function seaLookSettings(look: SeaLook, diagnostic: SeaDiagnostic = 'none', refined = true) {
  const p = look === 'painted';
  const settings = {
    painted: p ? 1 : 0,
    refined: p && refined ? 1 : 0,
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
