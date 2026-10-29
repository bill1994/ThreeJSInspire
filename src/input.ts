/**
 * src/input.ts — one `steer` action for pointer + touch (Pointer Events unify mouse,
 * touch and pen, so there is exactly one code path for every device).
 *
 * Node-importable: nothing here touches `window`/`document` until `initInput()` is
 * called, so the pure `deadzone()` math is unit-testable without a DOM.
 */

/** Raw pointer travel (CSS px) that must be crossed before steering registers. */
export const DEADZONE_PX = 4;

/** Drag distance (CSS px) at which steer reaches full deflection (1.0). */
export const STEER_RADIUS_PX = 120;

/** Steer axis, values in [-1, 1]. Mutated in place — never re-allocated per frame. */
export interface Steer {
  x: number;
  y: number;
}

export interface InputHandle {
  steer: Steer;
  dispose(): void;
}

/**
 * Scalar dead-zone with rescale, so steering ramps from 0 exactly at the edge of the
 * dead zone instead of jumping. |px| <= 4 -> 0; |px| >= STEER_RADIUS_PX -> ±1.
 * Non-finite input collapses to 0 so a bad pointer sample can never poison the
 * flight model with NaN.
 */
export function deadzone(px: number): number {
  if (!Number.isFinite(px)) return 0;
  const mag = Math.abs(px);
  if (mag <= DEADZONE_PX) return 0;
  const span = STEER_RADIUS_PX - DEADZONE_PX;
  const scaled = span <= 0 ? 1 : (mag - DEADZONE_PX) / span;
  return Math.sign(px) * Math.min(scaled, 1);
}

/**
 * Radial 2D dead zone: apply the dead zone to the drag *magnitude* and keep the
 * direction, so diagonals are not clipped into the axes (a per-axis dead zone
 * would carve a square hole and snap input to the axes).
 */
function applyRadial(sx: number, sy: number, span: number, out: Steer): void {
  const mag = Math.hypot(sx, sy);
  if (!Number.isFinite(mag) || mag <= DEADZONE_PX) {
    out.x = 0;
    out.y = 0;
    return;
  }
  const drive = Math.min((mag - DEADZONE_PX) / (span <= 0 ? 1 : span), 1);
  const inv = drive / mag;
  out.x = sx * inv;
  out.y = sy * inv;
}

/**
 * Mount the single `steer` action on a canvas.
 *
 * Drag-relative steering: `pointerdown` captures an anchor, each `pointermove`
 * measures travel from that anchor, so the stick self-centres on release and a
 * tap (no travel) is a no-op instead of a jump.
 */
export function initInput(canvas: HTMLCanvasElement, radiusPx: number = STEER_RADIUS_PX): InputHandle {
  const steer: Steer = { x: 0, y: 0 };
  const span = radiusPx - DEADZONE_PX;

  let activeId: number | null = null;
  let anchorX = 0;
  let anchorY = 0;

  const onPointerDown = (e: PointerEvent): void => {
    if (activeId !== null) return;
    activeId = e.pointerId;
    anchorX = e.clientX;
    anchorY = e.clientY;
    steer.x = 0;
    steer.y = 0;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort; steering still works without it */
    }
    if (e.cancelable) e.preventDefault();
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (activeId === null || e.pointerId !== activeId) return;
    applyRadial(e.clientX - anchorX, e.clientY - anchorY, span, steer);
    if (e.cancelable) e.preventDefault();
  };

  const release = (e: PointerEvent): void => {
    if (activeId === null || e.pointerId !== activeId) return;
    activeId = null;
    steer.x = 0;
    steer.y = 0;
    try {
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  const onContextMenu = (e: Event): void => e.preventDefault();

  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('lostpointercapture', release);
  canvas.addEventListener('contextmenu', onContextMenu);

  return {
    steer,
    dispose(): void {
      activeId = null;
      steer.x = 0;
      steer.y = 0;
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', release);
      canvas.removeEventListener('pointercancel', release);
      canvas.removeEventListener('lostpointercapture', release);
      canvas.removeEventListener('contextmenu', onContextMenu);
    },
  };
}
