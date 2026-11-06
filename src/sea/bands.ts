/**
 * Band mapping and footprint gating for the stylized sea — pure functions, no
 * three imports, so both the JS tests and the TSL graph read the same numbers.
 *
 * The four bands (deep / mid / lit / crest) are flat colour steps driven by the
 * C0 swell height only, so every ring paints the same wave the same way. The
 * thresholds are initial values: Task 12 measures each band's screen coverage
 * in `?sea=debug` false colour and reverse-solves the palette against them.
 */

/**
 * C0-height thresholds [deep|mid, mid|lit, lit|crest] in metres. Sized against
 * the cascade amplitude peaks (0.45 m swell + 0.10 m chop) so all four bands
 * occur in a normal sea.
 */
export const SEA_BAND_THRESHOLDS: readonly [number, number, number] = [-0.12, 0.06, 0.26];

/** Band index for a height: 0 = deep, 1 = mid, 2 = lit, 3 = crest. */
export function bandIndexFromHeight(
  h: number,
  thresholds: readonly [number, number, number],
): 0 | 1 | 2 | 3 {
  if (!(h >= thresholds[0])) return 0;
  if (!(h >= thresholds[1])) return 1;
  if (!(h >= thresholds[2])) return 2;
  return 3;
}

/**
 * Weight for the procedural detail normal map, from its screen-space footprint.
 *
 * A texel covering less than one pixel is spatially aliased — at the sun road's
 * specular distance (~57 m at 7 m eye height) the finest 1.6 cm texel covers
 * 0.47 px and would shatter the golden road into noise. Weight runs 0 below
 * 1 px, 1 above 2 px, smoothstep between; degenerate inputs weigh 0.
 */
export function detailWeight(
  texelMetres: number,
  distance: number,
  radPerPixel: number,
): number {
  if (
    !Number.isFinite(texelMetres) ||
    !Number.isFinite(distance) ||
    !Number.isFinite(radPerPixel) ||
    distance <= 0 ||
    radPerPixel <= 0
  ) {
    return 0;
  }
  const px = texelMetres / (distance * radPerPixel);
  const t = Math.min(Math.max(px - 1, 0), 1);
  return t * t * (3 - 2 * t);
}
