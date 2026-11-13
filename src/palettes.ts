/**
 * Single source of truth for every colour the sunset scene is built from.
 *
 * Two shapes live here on purpose:
 * - the sky palette stays CSS hex strings, because it feeds `THREE.Color` and the canvas
 *   gradient texture;
 * - the aircraft livery and the wake foam stay numeric hex, because the TSL graphs build
 *   constants from numbers (`col(hex)`), and `feel.ts` unpacks the wake foam to floats.
 *
 * The sea palette and the dome-cloud palette that used to live here were deleted on
 * 2026-11-06 (`rebuild/sea-dome-reset`) together with their renderers. Two values were
 * load-bearing outside them and moved rather than died:
 * - the wake foam tint became `WAKE_FOAM` (it was `SEA_PALETTE.foam`, read by `feel.ts`
 *   for the deck-skim spray — spray, not water);
 * - the far-field haze colour stayed as `HAZE_COLOR`, which the puff field converges on.
 */

/**
 * DEFAULT sun position. `?sun=az,el` overrides the direction at runtime (Task 7);
 * this seeds the sky uniform, the light rig and the spectrum's wind bearing.
 * The clouds and the sky dome both read it.
 */
export const SUN_POSITION: readonly [number, number, number] = [60, 35, -280];

/**
 * `SUN_POSITION` as a unit vector — the shader-side form of the same single source.
 *
 * The sky's glow and the cloud lighting each used to carry their own literal. The two
 * happened to nearly agree (about 4 degrees of azimuth and 0.7 degrees of elevation
 * apart), which is exactly the kind of drift a shared constant exists to prevent.
 * Deriving the direction once here means a change to `SUN_POSITION` moves both together,
 * which is what the plan's "turn the sun, all three follow" acceptance actually needs.
 */
export const SUN_DIRECTION: readonly [number, number, number] = (() => {
  const [x, y, z] = SUN_POSITION;
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len] as const;
})();

/**
 * Unit direction for ANY sun position (free-play helper, 2026-11-13).
 * `SUN_DIRECTION` above is just `sunDirectionFor(SUN_POSITION)` — the default
 * seed. Callers that move the sun (`?sun=`, tod, presets) derive from here so
 * sky glow, cloud lighting and sea glitter can never drift apart.
 */
export function sunDirectionFor(pos: readonly [number, number, number]): readonly [number, number, number] {
  const len = Math.hypot(pos[0], pos[1], pos[2]) || 1;
  return [pos[0] / len, pos[1] / len, pos[2] / len] as const;
}

export const SKY_PALETTE = {
  top: '#6b4fa1',
  horizon: '#ff9a5a',
  sun: '#ffd9a0',
} as const;

/**
 * The sun tint the dome and the sea's reflection must agree on.
 *
 * **multiplier, already linear**：这是线性乘子而非 sRGB 颜色——它乘在 glow/disc 的
 * 辐射亮度上，约束⑨的 sRGB→线性解码不适用于它（解码会把乘子放大一个 gamma）。
 * 原 `sky-webgpu.ts` 的模块私有 `SUN_TINT`，2026-11-08 升进调色单源（旧技术说明
 * K2(c) 欠的「调色板之外的第二份太阳色」在此清账）。
 */
export const SUN_TINT_LINEAR = [1.0, 0.78, 0.52] as const;

/**
 * The sunset ramp, shared by both sky renderers.
 *
 * Each stop carries **two** positions, because the two renderers measure different things:
 *
 * - `at` is the position inside the dome's ramp parameter
 *   `t = smoothstep(-0.02, 0.55, positionWorld.y / radius)`. `t` is neither an angle nor a
 *   height, so the landing points are pinned here instead of being re-derived by hand each
 *   time (the numbers below are the only thing that has to be recomputed if the dome radius
 *   or the smoothstep edges move):
 *
 *       at 0     -> h -0.020 -> -1.1 deg
 *       at 0.42  -> h  0.235 -> 13.6 deg
 *       at 0.72  -> h  0.351 -> 20.6 deg
 *       at 1     -> h  0.550 -> 33.4 deg      (h = sin(elevation), dome radius 800 m)
 *
 * - `canvasY` is the row in the fallback gradient (0 = top of the texture).
 *
 * They are not the same number and must not be forced to be. The layout that shipped used the
 * canvas rows as if they were elevations, which put the rose band 6 deg above the water
 * line — inside the band the horizon glow owns — and left the whole visible sky (a 60 deg
 * vertical FOV, horizon below centre) crossing a straight orange-to-violet line.
 * That straight line is the "grey-red crossover" the audit flagged, and it is why the dome had
 * no rose band while the canvas fallback did.
 */
export const SKY_STOPS = [
  { at: 0, canvasY: 0.78, color: SKY_PALETTE.horizon },
  { at: 0.42, canvasY: 0.62, color: '#c96a8f' },
  { at: 0.72, canvasY: 0.34, color: SKY_PALETTE.top },
  { at: 1, canvasY: 0, color: '#4a2f74' },
] as const;

/**
 * What the world converges on at distance.
 *
 * Sky horizon and the clouds' air perspective are the same atmospheric fact seen in two
 * directions; keeping two copies of it is how the horizon seam starts showing.
 */
export const HAZE_COLOR = SKY_PALETTE.horizon;

/**
 * The puff field's four posterized band colours, shadow → lit, re-authored
 * 2026-11-02 against the Ghibli reference ramp (targets L* 37.7 / 45.0 / 52.6 /
 * 60.0, equal ~7.5 L* steps, see `puff-cloud.ts` for the solve). Numeric hex —
 * the TSL graphs build constants from numbers.
 *
 * Raised into the palette single source on 2026-11-08 so the day-night track's
 * reference keyframe and the cloud material cannot drift apart; `puff-cloud.ts`
 * re-points its import in the sky plan's Task 5 (until then both hold the same
 * bytes by construction — the track test pins the equality).
 */
export const PUFF_BAND_COLORS = [0x6f618f, 0x826da8, 0xc16e95, 0xc08c93] as const;

/**
 * Below the waterline. **Canvas fallback only, on purpose.**
 *
 * The dome has to stay exactly `SKY_PALETTE.horizon` under y=0 so the sky's edge meets the
 * far haze colour at the seam; darkening it there would paint a visible grey band across
 * the horizon.
 */
export const SKY_BELOW_HORIZON = '#8c4a5e';

/**
 * Foam tint for the deck-skim spray (`feel.ts`), deliberately NOT near-white.
 *
 * Ablation on the alt-8 frozen pose: foam covered ~8.5% of the water but cost 22.7 L of the
 * frame's 139.6 — the single largest brightener, ahead of the glitter (8.2 L) and the
 * fresnel (0). 0xfff0e2 read as paper. This is the warm cream the sunset actually has.
 *
 * Carried over verbatim from `SEA_PALETTE.foam` when the sea was deleted; the wake is spray
 * thrown by the aircraft, so it outlives the surface it used to land on.
 */
export const WAKE_FOAM = 0xd8b896;

/** Aircraft livery, carried verbatim out of `plane.ts` so the toon ramp and the
 *  livery tinting can never drift apart. CSS strings: these feed `THREE.Color`. */
export const PLANE_PALETTE = {
  liveryWhite: '#efeadb',
  liveryGreen: '#2f6b4e',
  liveryRed: '#b63629',
  darkTrim: '#3a3a3e',
  glassCanopy: '#22242c',
  metalProp: '#9aa0a8',
} as const;

/**
 * The sea's scatter colours, restored on 2026-11-07 with the FFT ocean and
 * re-authored the same day as a CONTINUOUS water model (see
 * `src/sea/water-shading.ts`). Numeric hex — the TSL graphs build constants from
 * numbers.
 *
 * The four posterized band colours are gone; they were the reason every swell
 * read as a hard-edged patch of one flat colour. What replaced them is the
 * body-scatter pair the real-time references converge on (Crest
 * `OceanEmission.hlsl`, godot4-oceanfft `SurfaceVisual.gdshader`):
 *
 * - `deep` — body scatter straight down the view (linear ≈ 0.004, 0.030, 0.075,
 *   i.e. teal-navy, NOT pure blue: the blue in a sunset sea lives in the sky
 *   reflection, not in the water);
 * - `grazing` — body scatter at grazing view (linear ≈ 0.010, 0.055, 0.090,
 *   a touch greener and lighter);
 * - `shallow` — the thin-water tint a crest reaches;
 * - `subsurface` — the backlit-crest glow tint (Crest ships 0.0885/0.497/0.456
 *   for noon; warmed here for a low sun).
 *
 * CIE L* still runs monotonically brighter deep → grazing → shallow (pinned by
 * test) so the body cannot invert as the view angle turns.
 *
 * `haze` is the hard contract: it MUST equal `SKY_PALETTE.horizon` so the far
 * sea converges on the same colour the sky paints at its edge (pinned by test).
 */
export const SEA_PALETTE = {
  deep: 0x0d2e4d,
  grazing: 0x204054,
  shallow: 0x2f6f7c,
  subsurface: 0xa2bfa3,
  glitter: 0xffd9a0,
  foam: 0xfff0db,
  haze: 0xff9a5a,
} as const;

/**
 * Free-play palette presets (data only, 2026-11-13).
 *
 * `sunset` is the shipped frame, bit-for-bit (same bytes as SKY_PALETTE /
 * SEA_PALETTE above — the palette tests pin it). The other three are
 * starting points for freer art direction, not physics: pick one, then tune
 * freely. Hard guards travel with every preset and are re-checked in
 * `visual-presets.test.ts`:
 * - `horizon` IS the haze colour (sky edge == far field, no seam);
 * - `seaHaze` MUST equal `horizon` (same contract in numeric form);
 * - `top` must read darker than `horizon` (zenith never brighter than glow).
 *
 * Runtime application goes through `src/visual-presets.ts`
 * (`paletteToTrackPatch`) → the existing `?trackpatch` pipeline, so no
 * renderer or sea refactor is needed to try a new look.
 */
export interface PalettePreset {
  /** Preset key used by `?palette=<name>`. */
  name: string;
  /** Sky zenith / mid / horizon / sun CSS hex. */
  top: string;
  rose: string;
  horizon: string;
  sun: string;
  /** Sea body + haze (numeric hex, TSL form). `seaHaze` mirrors `horizon`. */
  seaDeep: number;
  seaGrazing: number;
  seaShallow: number;
  seaHaze: number;
}

export const PALETTE_PRESETS = {
  sunset: {
    name: 'sunset',
    top: '#4a2f74',
    rose: '#c96a8f',
    horizon: '#ff9a5a',
    sun: '#ffd9a0',
    seaDeep: 0x0d2e4d,
    seaGrazing: 0x204054,
    seaShallow: 0x2f6f7c,
    seaHaze: 0xff9a5a,
  },
  roseDawn: {
    name: 'roseDawn',
    top: '#3a3f7a',
    rose: '#d97a9e',
    horizon: '#ffb37a',
    sun: '#ffe4b8',
    seaDeep: 0x12314f,
    seaGrazing: 0x2a4a58,
    seaShallow: 0x3d7f86,
    seaHaze: 0xffb37a,
  },
  tealNoon: {
    name: 'tealNoon',
    top: '#2f6f9e',
    rose: '#7fb8c9',
    horizon: '#cfe8dd',
    sun: '#fff6e0',
    seaDeep: 0x0e3a4a,
    seaGrazing: 0x2a5a60,
    seaShallow: 0x4a9a8e,
    seaHaze: 0xcfe8dd,
  },
  violetDusk: {
    name: 'violetDusk',
    top: '#2e2456',
    rose: '#8e4a7e',
    horizon: '#e0705a',
    sun: '#ffc890',
    seaDeep: 0x14203c,
    seaGrazing: 0x24344c,
    seaShallow: 0x3a5a62,
    seaHaze: 0xe0705a,
  },
} as const satisfies Record<string, PalettePreset>;

export type PalettePresetName = keyof typeof PALETTE_PRESETS;
