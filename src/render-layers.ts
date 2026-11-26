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
 * Terrain, spray and the volume clouds are real 3D bodies and stay at SCENE
 * depth, where three's own depth sort decides their order. The far-tree
 * billboards do not: the cloud pass they must precede opts out of depth
 * entirely, so they need an explicit slot too. Do not add depth relationships
 * to this table - `renderOrder` outranks distance, so a number here can only
 * express a layer, never a real relative distance.
 */
export const LAYER = {
  /** Sky dome. Drawn first, never writes depth. */
  SKY: -1000,
  /** Star points, just above the dome. */
  STARS: -999,
  /**
   * Far-tree billboards. Must land after STARS and before CLOUD_BACKDROP so the
   * background cloud shells can composite over a crown that pokes above the
   * horizon, and before SCENE because the volume cloud pass opts out of depth
   * and can only self-clip against what was drawn before it.
   *
   * This value *does* set the tree-vs-cloud order: `renderOrder` is compared
   * before depth, so the batch positions below never decide it. Rebasing the
   * batches only orders them against each other, since they all share this slot.
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
