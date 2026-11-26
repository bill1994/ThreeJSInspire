/**
 * Explicit draw-layer contract for transparent objects.
 *
 * Three's transparent queue orders by `renderOrder` first, then by clip-space
 * depth. `renderOrder` is therefore the only way to express "this object is a
 * *layer*, not a 3D body" - and the sky, the star field and the cloud card
 * shells are exactly that. They sit on a shell that follows the camera, so
 * their depth is a stand-in for distance rather than real distance. Feeding
 * that fake depth into a depth sort produces nonsense, so they get an explicit
 * layer instead.
 *
 * Everything else - terrain, far-tree billboards, volume clouds, spray - is a
 * real 3D body and belongs at SCENE depth, where three's own depth sort decides
 * the order. Do not add depth relationships to this table.
 */
export const LAYER = {
  /** Sky dome. Drawn first, never writes depth. */
  SKY: -1000,
  /** Star points, just above the dome. */
  STARS: -999,
  /**
   * Far-tree billboards. Must land after STARS and before CLOUD_BACKDROP so the
   * background cloud shells can composite over a crown that pokes above the
   * horizon. Their order against the volume clouds is *not* set here - it comes
   * from the batch's real world position, see `showProxy` in archipelago.ts.
   */
  FAR_TREE: -960,
  /** Horizon cloud cards: a single flat layer, 800 m shell. */
  CLOUD_BACKDROP: -950,
  /** Cloud cards on the 800 m shell; each frame adds its distance rank (0..16). */
  CLOUD_FIELD: -900,
  /** Aircraft headlight beam, composites in front of the sky layers. */
  HEADLIGHT: -100,
  /** Real 3D geometry: terrain, water, volume clouds, spray, contrails. */
  SCENE: 0,
  /** Additive FX that should read on top of the scene. */
  OVERLAY: 2,
  /** Second overlay tier, for FX that must not be reordered against OVERLAY. */
  OVERLAY_TOP: 3,
} as const;
