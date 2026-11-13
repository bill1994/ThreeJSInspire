/**
 * src/visual-presets.ts — free-play presets over the existing pipelines.
 *
 * No new renderer, no new graph: every preset resolves into inputs the
 * current code already consumes (`?trackpatch`, `PostFx`, `CameraTuning`).
 * Defaults are bit-for-bit the shipped sunset frame; the other entries are
 * starting points, not physics.
 *
 * Hard guards (pinned by `visual-presets.test.ts`):
 * - palette: `horizon` IS the haze colour, `seaHaze` equals it, zenith darker;
 * - post: preset thresholds stay above the sky non-disc budget (>= 0.82);
 * - camera: presets stay inside the widened TUNING_RANGES.
 */
import { PALETTE_PRESETS, type PalettePresetName } from './palettes';
import { srgbToLinear, type DebugTrackPatch, type Vec3 } from './sky-track';
import { clampFx, POST_PRESETS, type PostFx, type PostPresetName } from './post';
import { clampTuning, type CameraTuning } from './camera-rig';

export type { PalettePresetName, PostPresetName };

/** Resolve a palette preset name (unknown → null = shipped sunset, no patch). */
export function palettePreset(name: string | null | undefined): PalettePresetName | null {
  if (typeof name === 'string' && name in PALETTE_PRESETS) return name as PalettePresetName;
  return null;
}

/**
 * Palette preset → track patch. Only retints the day look's ramp + sun/sky
 * lights + haze endpoints; night keys, Preetham params and glow shaping stay
 * on the shipped track so the day-night orbit keeps working.
 */
export function paletteToTrackPatch(name: PalettePresetName): DebugTrackPatch {
  const p = PALETTE_PRESETS[name];
  const dayStops: [Vec3, Vec3, Vec3, Vec3] = [
    srgbToLinear(p.horizon),
    srgbToLinear(p.rose),
    srgbToLinear(p.top),
    srgbToLinear(p.top),
  ];
  const haze = srgbToLinear(p.horizon);
  return {
    dayStops,
    sunLightColorCss: p.sun,
    hemiSkyCss: p.rose,
    cloudHaze: haze,
    hazeLinear: haze,
    bloomThreshold: 0.82,
  };
}

/** Resolve a `?postfx=<name>` preset (unknown → sunset = POST_HIGH). */
export function postPreset(name: string | null | undefined): PostFx {
  if (typeof name === 'string' && name in POST_PRESETS) {
    return clampFx({ ...(POST_PRESETS as Record<string, PostFx>)[name] });
  }
  return clampFx({ ...(POST_PRESETS as Record<string, PostFx>).sunset });
}

/**
 * Free-play chase presets. `sunset` is the shipped CAM_DISTANCE/HEIGHT.
 * `lowChase` / `highWide` / `acro` stay inside TUNING_RANGES and only touch
 * distance/height — fovKick/bankFollow remain director-driven per frame.
 */
export const CAM_PRESETS = {
  sunset: { distance: 30, height: 6.8 },
  lowChase: { distance: 18, height: 3.5 },
  highWide: { distance: 55, height: 14 },
  acro: { distance: 12, height: 4 },
} as const satisfies Record<string, Partial<CameraTuning>>;

export type CamPresetName = keyof typeof CAM_PRESETS;

/** Resolve `?cam=<preset|dist,height>` — preset name or `dist,height` numbers. */
export function camPreset(
  raw: string | null | undefined,
): Partial<CameraTuning> | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (raw in CAM_PRESETS) return { ...(CAM_PRESETS as Record<string, Partial<CameraTuning>>)[raw] };
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length > 2) return null;
  const nums = parts.map((p) => (p === '' ? Number.NaN : Number(p)));
  const out: Partial<CameraTuning> = {};
  if (parts[0] !== undefined && parts[0] !== '' && Number.isFinite(nums[0])) out.distance = nums[0];
  if (parts.length === 2 && parts[1] !== '' && Number.isFinite(nums[1])) out.height = nums[1];
  if (Object.keys(out).length === 0) return null;
  return clampTuning(out);
}
