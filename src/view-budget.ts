/**
 * Per-frame angular budget: how much world-space angle a single buffer pixel
 * covers. The sea's cascade and ring validity rules are derived from this, so
 * they survive FOV kicks and DPR changes instead of being tuned for one device.
 *
 * `bufferHeightPx` is the drawing-buffer height, not the CSS height — the same
 * distinction `resize()` already makes.
 */

/**
 * Radians of world angle covered by one pixel.
 *
 * `2·tan(fov/2)` is the visible world height at unit distance; dividing by the
 * buffer height in pixels gives radians per pixel. Non-finite or non-positive
 * inputs return NaN so callers can branch instead of silently dividing by zero.
 */
export function perPixelRadians(fovDeg: number, bufferHeightPx: number): number {
  if (
    !Number.isFinite(fovDeg) ||
    fovDeg <= 0 ||
    !Number.isFinite(bufferHeightPx) ||
    bufferHeightPx <= 0
  ) {
    return NaN;
  }
  return (2 * Math.tan((fovDeg * Math.PI) / 360)) / bufferHeightPx;
}

/** The budget the sea's tables were sized against: 60° fov on a 1920-px buffer. */
export const CANONICAL_RAD_PER_PIXEL = perPixelRadians(60, 1920);
