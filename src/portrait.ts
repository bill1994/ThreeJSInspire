/**
 * src/portrait.ts — the portrait framing contract as pure functions.
 *
 * `src/main.ts` does DOM work at module scope, so nothing in here may import it;
 * these are the rules the boot code consumes. The framing judgement (aspect clamp,
 * lower-third composition, safe area) lives here so vitest can pin it node-side,
 * while DOM/GPU behaviour stays with the screenshot chain.
 */

export const PORTRAIT = {
  /** The story frame. Wider windows letterbox; nothing ever stretches. */
  ASPECT: 9 / 16,
  /** Fraction of the frame height kept clear at the top (notch / status). */
  SAFE_TOP: 0.1,
  /** Fraction of the frame height kept clear at the bottom (home bar / grip). */
  SAFE_BOTTOM: 0.14,
  /** The aircraft sits below this line of the frame height. */
  LOWER_THIRD: 0.62,
} as const;

/**
 * Aspect for the camera from a buffer size. Anything wider than 9:16 clamps to the
 * story frame; invalid sizes (0, NaN) fall back to 9:16 so the frustum can never go
 * degenerate. A narrower-than-9:16 phone keeps its own (more vertical) aspect.
 */
export function portraitAspect(w: number, h: number): number {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return PORTRAIT.ASPECT;
  const aspect = w / h;
  return aspect > PORTRAIT.ASPECT ? PORTRAIT.ASPECT : aspect;
}

/** Y (in frame pixels from the top) where the lower third begins. */
export function lowerThirdY(viewH: number): number {
  return (Number.isFinite(viewH) && viewH > 0 ? viewH : 0) * PORTRAIT.LOWER_THIRD;
}

/**
 * HUD safe insets as fractions of the frame height. A fixed physical notch is a
 * larger fraction of a narrower frame, so the insets scale with the aspect and
 * clamp to sane bounds; an invalid aspect reads as the story frame.
 */
export function hudSafeArea(aspect: number): { top: number; bottom: number } {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : PORTRAIT.ASPECT;
  const k = Math.min(Math.max(PORTRAIT.ASPECT / a, 0.75), 1.5);
  return {
    top: Math.min(PORTRAIT.SAFE_TOP * k, 0.2),
    bottom: Math.min(PORTRAIT.SAFE_BOTTOM * k, 0.25),
  };
}
