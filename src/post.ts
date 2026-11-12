/**
 * src/post.ts — the WebGPU post pipeline: bloom, distance blur, SMAA.
 *
 * Node chain (the order matters, and two of the three steps are easy to get backwards):
 *
 *   pass(samples: 0) → bloom() ─add→ dof() → smaa()
 *
 * - `bloom()` returns **only the glow**, so it must be added to the scene colour.
 * - `dof()` returns the **finished image**, so it must not be added to anything.
 * - `smaa()` works in **linear space**: leave `pipeline.outputColorTransform` at its default
 *   (true) so the pipeline tone-maps and converts to sRGB *after* SMAA. Wrapping it in
 *   `renderOutput()` is the FXAA recipe — running the edge detector on already-encoded pixels
 *   softens every edge in the frame.
 *
 * There are two finished graphs, with and without depth of field. The low tier selects the
 * one without it: zeroing `bokehScale` only collapses the blur taps onto a single texel, the
 * CoC pass, both half-res blur passes and the composite all still run.
 *
 * `pass()` with `samples: 0` because `antialias: true` is silently zeroed in WebGPU
 * compatibility mode (older Android), so SMAA does the anti-aliasing on every device.
 */
import type * as ThreeNS from 'three/webgpu';

export interface PostFx {
  bloom: boolean;
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
  dof: boolean;
  focusDistance: number;
  focalLength: number;
  bokehScale: number;
}

export interface PostHandle {
  render(): void;
  /** Keeps the aircraft sharp by pulling focus onto it every frame. */
  focusTo(cam: { x: number; y: number; z: number }, plane: { x: number; y: number; z: number }): void;
  setQuality(high: boolean): void;
  setFx(p: Partial<PostFx>): void;
  dispose(): void;
  readonly fx: PostFx;
}

/**
 * Desktop budget. `bloomThreshold` 0.82 sits above everything the dome's DUSK diffuse
 * term produces, so only the sun disc and the sun glow bloom.
 *
 * 2026-11-08 (day-night track Task 4): the sky is now `skyColorTsl` v2 (palette track
 * × Preetham ratio). The peaks below come from the JS mirror (`skyColorJs` — the exact
 * function the GPU graph mirrors) over the budget grid: elevation −2…40°, azimuth ±90°
 * around the sun, six track states (4 keyframes + 3°/−2° segment samples):
 *
 *     state      non-disc peak    disc peak (includeDisc=true)
 *     -8 deg     0.034            0.034
 *     -4 deg     0.089            0.089
 *     -2 deg     0.176            0.237
 *      0 deg     0.301            0.503
 *      3 deg     0.464            0.649
 *     ref 6.97   0.743            0.952
 *
 * Only the reference key's DISC peak crosses 0.82 — the sun blooms, on purpose; every
 * non-disc row stays under (night keys are an order of magnitude under, so only star
 * cores can cross at night). **Re-run `sky-color-js.test.ts` (the bloom 预算 describe)
 * after changing ANY track parameter — glowGain/glowPow/discGain/floorLinear/dayStops —
 * or the classic constants `GLOW_GAIN`, `DISK_GAIN`, `GLOW_POW`, `SKY_PALETTE.horizon`
 * (the reference keyframe imports them).** If the whole sky blooms instead of just the
 * disc, lower the offending key's `glowGain`/`discGain` first — the reference column is
 * pinned by tests and must not move.
 *
 * 2026-11-13 (toon-look Phase 1 Task 5, spec T7): toon mode row. With the outlet
 * posterize at `toonAmount=1` (`uToon=1`) every output luminance lands ON the
 * `TOON_STEPS` anchor set ([0.02, 0.08, 0.18, 0.32, 0.52, 0.75], max 0.75), so the
 * non-disc budget is structurally capped below 0.82 — large flat toon colour blocks
 * cannot bloom by construction (calibration: `artifacts/toon-audit/steps.json`).
 * Measured toon non-disc peaks (same BUDGET_KEYS grid and helper as the table above;
 * the test pin is the "toon mode (toonAmount=1) non-disc peak < bloomThreshold at
 * EVERY budget key" it in `sky-color-js.test.ts`):
 *
 *     state      toon non-disc peak (toonAmount=1)
 *     -8 deg     0.02
 *     -4 deg     0.08
 *     -2 deg     0.18
 *      0 deg     0.32
 *      3 deg     0.52
 *     ref 6.97   0.75
 *
 * Each budget key's toon peak is the anchor its brightest sky pixel buckets into —
 * the row rises with elevation exactly because brighter keys bucket into higher
 * anchors. If a future anchor re-calibration pushes the top anchor above 0.82,
 * compress the offending `TOON_STEPS` value per the calibration data — never move
 * the 0.82 threshold or the reference-column values (same discipline as above).
 */
export const POST_HIGH: PostFx = {
  bloom: true,
  bloomStrength: 0.7,
  bloomRadius: 0.6,
  bloomThreshold: 0.82,
  dof: true,
  focusDistance: 34,
  focalLength: 420,
  bokehScale: 1.1,
};

/** Mobile budget: half-resolution bloom, no depth of field — blur is the first thing to cut. */
export const POST_LOW: PostFx = {
  ...POST_HIGH,
  bloomStrength: 0.55,
  bloomRadius: 0.55,
  bloomThreshold: 0.85,
  dof: false,
  bokehScale: 0.6,
};

/**
 * Task 8: far viewZ cutoff for the DOF chain. viewZ is negative (far is more
 * negative); anything beyond this is clamped back so far CoC cannot saturate.
 * Global far-DOF off: cloud depthWrite=false shares the far plane, post has no
 * cloud mask, so region clamp equals global clamp. -180m keeps near/mid DOF
 * (<150m sea, aircraft focus 12-60m) intact while flattening cloud/far-sea blur
 * from 1.0 to ~0.1 CoC.
 */
export const DOF_FAR_VIEW_Z = -180;

/** `?post=0` turns the whole pipeline off; everything else leaves it on. */
export function usePost(search: string): boolean {
  const query = search.startsWith('?') ? search : `?${search}`;
  return new URLSearchParams(query).get('post') !== '0';
}

/**
 * Distance from the camera to the aircraft, which is where focus belongs. Clamped to
 * [12, 60]: closer than the near field the nose would blur, further out the
 * aircraft itself would soften as the camera lags in a dive.
 */
export function focusDistanceFor(
  cam: { x: number; y: number; z: number },
  plane: { x: number; y: number; z: number },
): number {
  const dx = plane.x - cam.x;
  const dy = plane.y - cam.y;
  const dz = plane.z - cam.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!Number.isFinite(distance)) return POST_HIGH.focusDistance;
  return Math.min(60, Math.max(12, distance));
}

function clampNumber(value: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(hi, Math.max(lo, value));
}

/** Keeps hand-tuned or externally supplied values inside the ranges the shader expects. */
export function clampFx(fx: PostFx): PostFx {
  return {
    bloom: fx.bloom === true,
    bloomStrength: clampNumber(fx.bloomStrength, 0, 2, POST_HIGH.bloomStrength),
    bloomRadius: clampNumber(fx.bloomRadius, 0, 1, POST_HIGH.bloomRadius),
    bloomThreshold: clampNumber(fx.bloomThreshold, 0, 1, POST_HIGH.bloomThreshold),
    dof: fx.dof === true,
    focusDistance: clampNumber(fx.focusDistance, 12, 60, POST_HIGH.focusDistance),
    focalLength: clampNumber(fx.focalLength, 50, 2000, POST_HIGH.focalLength),
    bokehScale: clampNumber(fx.bokehScale, 0, 3, POST_HIGH.bokehScale),
  };
}

/**
 * Whether this preset should run depth of field at all. `initPost` builds one graph with the
 * DOF node and one without, and this drives which one is live — a scale of 0 is not the same
 * as absent.
 */
export function presetUsesDof(fx: PostFx): boolean {
  return fx.dof === true && fx.bokehScale > 0;
}

/** One lookup image an `SMAANode` decodes from a data URL. Typed loosely on purpose. */
type SmaaImage = {
  complete?: boolean;
  decode?: () => Promise<void>;
  addEventListener?: (type: string, listener: () => void, options?: { once?: boolean }) => void;
};

/** Resolves once the image has pixels — or as soon as it is clear nothing is coming. */
function imageReady(img: SmaaImage): Promise<void> {
  if (img.complete) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => resolve();
    img.addEventListener?.('load', done, { once: true });
    img.addEventListener?.('error', done, { once: true });
    // Belt and braces for images without an event surface: a settled `decode()` also means pixels.
    if (typeof img.decode === 'function') void img.decode().then(done, done);
  });
}

/**
 * Waits for every `SMAANode` in `nodes` to finish decoding its area/search textures.
 *
 * `SMAANode` builds them with `new Image()` + a data URL and flips `needsUpdate` from `onload`
 * (`SMAANode.js:85-112`), so for the first task the lookup textures have no pixels while the
 * edge/weight/blend materials want to compile against them. This is not the flat-frame bug —
 * that was `DepthOfFieldNode` sizing itself from a 1x1 placeholder (see `initPost`) — but a
 * capture must not depend on which task the decode lands in, and `initPost` is already awaited
 * before the first frame, so waiting here is free.
 *
 * Never rejects: a missing or failing decode must not take the post pipeline down with it.
 */
export async function smaaTexturesReady(nodes: readonly unknown[]): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const node of nodes) {
    for (const key of ['_areaTexture', '_searchTexture'] as const) {
      const holder = (node as Record<string, { image?: SmaaImage } | undefined> | null | undefined)?.[key];
      const image = holder?.image;
      if (image) pending.push(imageReady(image));
    }
  }
  await Promise.all(pending);
}

export async function initPost(
  renderer: any,
  scene: ThreeNS.Scene,
  camera: ThreeNS.PerspectiveCamera,
): Promise<PostHandle> {
  // Loaded at call time: a static `three/webgpu` import here would break module linking
  // (main → post) before `renderer.ts` can fall back to the classic WebGLRenderer. The addons
  // belong to the same build, so they load together.
  const THREE = await import('three/webgpu');
  const { pass, uniform } =
    await import('three/tsl');
  const { bloom } = await import('three/addons/tsl/display/BloomNode.js');
  const { dof } = await import('three/addons/tsl/display/DepthOfFieldNode.js');
  const { smaa } = await import('three/addons/tsl/display/SMAANode.js');

  let fx = clampFx(POST_HIGH);

  const pipeline = new (THREE as any).RenderPipeline(renderer);

  // samples: 0 — SMAA owns anti-aliasing (see the module comment).
  const scenePass = pass(scene, camera, { samples: 0 });
  const color = scenePass.getTextureNode('output'); // HalfFloat: >1 highlights survive for bloom
  const viewZ = scenePass.getViewZNode();

  const glow = bloom(color, fx.bloomStrength, fx.bloomRadius, fx.bloomThreshold);
  // BloomNode ships at half resolution; the desktop tier has to claim full resolution back.
  glow.setResolutionScale(1);
  const lit = color.add(glow); // ⚠️ bloom() is only the glow

  // Uniforms, not constants: focus follows the aircraft and quality switching retunes these
  // without rebuilding the node graph.
  const focus = uniform(fx.focusDistance);
  const focal = uniform(fx.focalLength);
  const bokeh = uniform(fx.bokehScale);

  // Radial speed lines were removed: measured against ref-02 they ran 2x too dense and 1.5x
  // too hard, and they crossed the cloud mass and the aircraft. The chain below is the whole
  // picture now — bloom, DOF, SMAA — with nothing added on top of the tone-mapped image.

  // Task 8: clamp far viewZ so the cloud deck cannot hit max CoC. viewZ.max (not min):
  // far viewZ is more negative, the lower bound clips it back to DOF_FAR_VIEW_Z.
  const viewZClamped = viewZ.max(DOF_FAR_VIEW_Z);
  const dofNode = dof(lit, viewZClamped, focus, focal, bokeh); // ⚠️ dof() is the finished image
  const withDof = smaa(dofNode); // linear-space filter; pipeline transforms afterwards
  const withoutDof = smaa(lit);
  // Both branches are waited on, not just the live one — switching quality must not resurrect a
  // half-decoded graph.
  await smaaTexturesReady([withDof, withoutDof]);
  let usingDof = presetUsesDof(fx);

  pipeline.outputNode = usingDof ? withDof : withoutDof;
  pipeline.needsUpdate = true;

  /** Swaps the live graph only when the tier actually changes; one recompile per change. */
  const syncDof = (next: PostFx): void => {
    const want = presetUsesDof(next);
    if (want === usingDof) return;
    usingDof = want;
    pipeline.outputNode = want ? withDof : withoutDof;
    pipeline.needsUpdate = true;
  };

  const applyFx = (next: PostFx): void => {
    fx = next;
    // `bloom: false` collapses to strength 0: BloomNode has no enable flag.
    glow.strength.value = next.bloom ? next.bloomStrength : 0;
    glow.radius.value = next.bloomRadius;
    glow.threshold.value = next.bloomThreshold;
    focus.value = next.focusDistance;
    focal.value = next.focalLength;
    bokeh.value = next.bokehScale;
    syncDof(next);
  };

  applyFx(fx);

  // Warm-up. `DepthOfFieldNode.updateBefore()` sizes its six render targets from
  // `textureNode.value.image` (`DepthOfFieldNode.js:283-284`), and that texture node only points
  // at the scene pass' real render target *after* the pass has rendered once — before that it is
  // the 1x1 placeholder, so the whole chain bakes at 1x1 and every pixel samples the same texel:
  // one flat colour, for as many synchronous frames as anyone renders (`?qa=frozen` + `step(n)`).
  // With the animation loop it looks like it heals on the next task, which is why it survived so
  // long. Rendering once to prime the pass, re-sizing, and rebuilding closes it deterministically.
  const syncDofSize = (): void => {
    const size = new THREE.Vector2();
    renderer.getDrawingBufferSize?.(size);
    // `dof()` is typed as a plain node; the runtime object is `DepthOfFieldNode` with `setSize`.
    const sizer = dofNode as unknown as { setSize?: (w: number, h: number) => void };
    sizer.setSize?.(Math.max(1, Math.round(size.x)), Math.max(1, Math.round(size.y)));
  };
  pipeline.render();
  syncDofSize();
  pipeline.needsUpdate = true;
  pipeline.render();

  return {
    render(): void {
      pipeline.render();
    },
    focusTo(cam, plane): void {
      const next = clampFx({ ...fx, focusDistance: focusDistanceFor(cam, plane) });
      fx = next;
      focus.value = next.focusDistance;
    },
    setQuality(high: boolean): void {
      glow.setResolutionScale(high ? 1 : 0.5);
      applyFx(clampFx(high ? POST_HIGH : POST_LOW));
    },
    setFx(partial: Partial<PostFx>): void {
      applyFx(clampFx({ ...fx, ...partial }));
    },
    dispose(): void {
      // `RenderPipeline.dispose()` frees only its quad material; every node owns render targets.
      scenePass.dispose();
      glow.dispose();
      dofNode.dispose();
      withDof.dispose();
      withoutDof.dispose();
      pipeline.dispose();
    },
    get fx() {
      return fx;
    },
  };
}
