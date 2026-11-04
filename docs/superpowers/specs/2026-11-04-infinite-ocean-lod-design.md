# Infinite Ocean — Surface LOD Design

Date: 2026-11-04. Branch: `feat/puff-cluster-cloud` (reconstruct baseline: no sea).
Companion to `2026-11-04-stylized-sea-design.md` — that one decides **what the water looks
like**; this one decides **how much of it exists and at what resolution**.

Status: user chose full implementation (not a simplified first pass). This document
supersedes the single-mesh approach implied by `plans/2026-11-04-stylized-sea.md` Task 3
and Task 6.

---

## 1. Intent and why

The previous FFT sea was a **single 1600 m mesh** (560² segments, 627k triangles) towed
under the aircraft. Two things are wrong with that now:

1. **The vertex cost model changed.** The FFT displaced vertices with *one texture sample*.
   The rebuild displaces them with *five analytic Gerstner trains* — five `sin`+`cos` per
   vertex. Reusing the old density means ~1.8M trig calls per frame instead of ~315k
   texture fetches.
2. **A uniform grid is wrong for a 7 m skim.** `SKIM.DECK_Y = 7`: the camera can be seven
   metres above the water. At that height the near field needs cells of ~2 m to look like
   water, while 400 m away nothing needs to exist at all. One cell size cannot serve both
   without wasting most of the budget on water nobody can resolve.

The user's framing, and the reason this is a design document rather than a constant tweak:
**crossing any detail boundary must produce no perceivable change** — not "a smooth
transition", but "you cannot find the line". And the near field is where the game is meant
to look good; the far field exists only so the ocean reads as infinite.

## 2. Goals / non-goals / anti-goals

Goals:

- **G1** At 7 m skim, the near water carries the full wave form: displacement, per-train
  detail, chop. Nothing is dropped inside the range where it is visible.
- **G2** The ocean extends past the haze and reads as infinite. No visible edge, no visible
  ring around the camera, no pop when the aircraft climbs or banks.
- **G3** 60 fps on a mid-range Android at the skim, 30 fps floor. The sea holds a fixed
  triangle budget regardless of how far the plane flies.
- **G4** The LOD is **distance-driven and continuous**, so it needs no hand-placed
  boundaries and no per-scene tuning.

Non-goals (explicitly out): baked height caches, tessellation shaders (not available on
the WebGL2 fallback), a general-purpose terrain clipmap, wave physics beyond the existing
Gerstner field.

Anti-goals (failure even if it renders):

- **A visible ring or square around the camera.** The classic clipmap tell.
- **Popping** when a level appears, disappears, or changes its train set.
- **Vertex swimming** as the camera slides: samples sliding through the field make the
  whole surface shimmer even when nothing else changes.
- **Spending triangles on sub-pixel water.** The whole point is that the far field costs a
  fraction of the near field.
- Any static `import 'three/webgpu'` in the boot graph.

## 3. Constraints (inherited, non-negotiable)

- **C1** TSL node materials only; no `ShaderMaterial` / `onBeforeCompile`. WebGPU modules
  load through dynamic `import()` (`module-graph.test.ts` guards this).
- **C2** Mobile low tier must run: every level and every train needs a cheap path.
- **C3** Palette single source (`palettes.ts`); `SEA_PALETTE.haze === SKY_PALETTE.horizon`
  and `SUN_POSITION === [60, 35, -280]` stay pinned.
- **C4** Post contract untouched: bloom threshold 0.82, K4 margin 0.063.
- **C5** Lagrangian rule: displacement and sampling both evaluate at **base**
  (pre-displacement) coordinates. The old self-feedback bug must stay structurally
  impossible.
- **C6** Existing scene numbers do not move unless this design says so: `scene.fog`
  60→700, `camera.far` 2000, `HORIZON.HAZE_NEAR 150 / HAZE_FAR 520`.

## 4. Decided by the user

- **D1** The near field shows everything that can be shown — this is a hard requirement, not
  a stretch goal.
- **D2** Crossing the detail boundary produces **no perceivable change**. The target is a
  line you cannot locate, not a graceful transition.
- **D3** Full implementation in one step (clipmap-class surface), not a simplified
  single-mesh first pass that gets rewritten later.
- **D4** Target 60 fps on **mid-range Android**, 30 fps floor.
- **D5** The "500 m" figure from the original conversation was a **reference figure, not a
  constant**. The actual extents are to be derived.

## 5. The derivation that makes D2 possible

This is the load-bearing argument of the whole design. Everything below follows from it.

At 720×1280 portrait with a vertical FOV of 60°, the angular size of one logical pixel is

```
1 px = 60° / 1280 = 0.046875° = 8.18e-4 rad
```

A vertical displacement `A` seen at distance `d` subtends `A/d` radians. So each train has
a **geometric visibility distance**: past it, its height contribution is under one pixel.

| train | λ (m) | A (m) | height < 1 px beyond | cell must be ≤ λ/4 |
| ----: | ----: | ----: | -------------------: | -----------------: |
| 1 | 180 | 0.34 | 416 m | 45.0 m |
| 2 | 90 | 0.24 | 293 m | 22.5 m |
| 3 | 45 | 0.15 | 183 m | 11.25 m |
| 4 | 22 | 0.10 | 122 m | 5.5 m |
| 5 | 11 | 0.06 | 73 m | 2.75 m |

Two consequences, and they are the whole design:

1. **Beyond 416 m, the surface is geometrically flat.** Not "cheap" — flat. Every train's
   height has fallen below a pixel, so no triangle count can improve it. What remains
   visible there is the **slope**, which lives in the normal, and normals are per-pixel and
   free. This is also why the reference art (`Uber-Stylized-Water`, Anime preset) can turn
   vertex waves off entirely and still read as water.
2. **The set of trains worth displacing shrinks with distance**, and the cell size can
   shrink with it. Cell size is tied to the shortest *visible* train, so the LOD step is
   invisible **by construction**: at the moment a train is dropped, its remaining
   contribution is under a pixel.

Note what this means for altitude. At the 240 m ceiling, the nearest water is 240 m away,
so trains 3, 4, 5 are already sub-pixel **everywhere in the frame**. The near levels are
not just cheap at altitude — they are pointless, and can be skipped outright.

## 6. My calls (challenge freely)

- **M1 — Distance to the camera is the driver, not altitude.** Altitude only sets a floor on
  that distance. Deriving the LOD from `camera.position` keeps one rule for skim, cruise and
  ceiling instead of three regimes.
- **M2 — Five concentric square levels, constant cost per level.** Half-extents
  96 / 192 / 384 / 768 / 1536 m with cells 3 / 6 / 12 / 24 / 48 m, 64×64 quads each
  (8,192 triangles per level, ~41k total). Level *l* covers the annulus between level
  *l−1*'s extent and its own; the innermost drawn level has no hole. Coverage reaches
  ±1536 m, comfortably past the 700 m fog, so the far edge never exists on screen.
  Cost is **fixed** regardless of flight distance — no accumulation, no per-frame mesh
  rebirth.
- **M3 — Cell sizes are chosen against the band table, with headroom.** L1 (span 96–192 m)
  uses 6 m cells where the visible trains need ≤ 11.25 m; L2 (192–384) uses 12 m where
  ≤ 22.5 m is required. The headroom is deliberate: the interpolation error between a cell
  and the true surface is what could show at a seam, and this keeps it well under a pixel.
- **M4 — Per-train distance fade in the vertex shader, in addition to the level sets.**
  Each train's displacement amplitude is multiplied by a smooth weight that reaches 0 at
  its visibility distance from §5. This is what makes a train's disappearance invisible
  even *within* a level — the level sets are a cost optimisation, the fade is the
  guarantee.
- **M5 — Seams: overlap by one coarse cell and dither-crossfade.** Adjacent levels overlap
  by exactly one cell of the coarser level; in that band both are drawn and blend with a
  hash dither on screen-space position (not a linear alpha ramp, which shows as a grey
  band on a colour-graded surface). Both levels evaluate the same field at base
  coordinates, so the only difference in the overlap is interpolation error — bounded by
  M3.
- **M6 — Each level snaps its origin to its own cell size (toroidal wrap).** Continuous
  translation makes samples slide through the field and the surface shimmers even when
  nothing else changes. Snapping to the cell grid keeps sample positions world-stable.
  Smaller levels snap more often; that is the standard tradeoff and is acceptable at their
  scale.
- **M7 — Skip a level entirely when the camera's altitude exceeds its finest train's
  visibility distance.** At 240 m, L0 (finest train visible to 73 m) and L1 (183 m) are
  fully sub-pixel and are not drawn at all; the innermost drawn level loses its hole. This
  drops the ceiling cost to ~25k triangles with no other change.
- **M8 — Nothing here changes the shading design.** §5's claim that slope survives while
  height does not depends on the normals carrying all five trains at every distance. That
  is already true of the shading design and must stay true.

## 7. Impact on what already exists

- `src/sea/waves.ts` currently exports `SEA_PATCH_SIZE = 1600`, `SEGMENTS_HIGH = 600`,
  `SEGMENTS_LOW = 300` and a test asserting `SEA_PATCH_SIZE / SEGMENTS ≤ finest/4`. Those
  three constants are **superseded** by the level table. The test's *intent* survives —
  "cell ≤ finest visible wavelength / 4" — but it must be re-expressed per level.
  `TRAINS`, `gerstnerField`, `finestWavelength`, `combinedRms`, `LOW_TIER_TRAINS` stay.
- `plans/2026-11-04-stylized-sea.md` **Task 3** ("mesh + displacement") and **Task 6**
  ("world, far-field tow") are rewritten against this document. Tasks 4, 5, 7 (foam,
  light terms, grading) are unaffected — they are fragment work.
- `src/far-field.ts` currently tows a single named object. It must now tow **N levels**,
  each with its own snap quantum, or the tow moves into the sea module. My call: the sea
  module owns its own tow (see §8) and `far-field` keeps only the sky shell.

## 8. Shape of the implementation (left to the builder, but bounded)

A builder needs, at minimum:

- One module owning the level stack: builds N meshes named `sea-l0` … `sea-l4`, each a
  `PlaneGeometry` of 64×64 quads at its extent, with the vertex shader evaluating
  `gerstnerField` at **world** base coordinates derived from the mesh transform.
- Per-level state: half-extent, cell size, snap origin, train set, hole radius.
- The update step: snap each level's origin to its own cell grid, update the hole radius
  from the camera, update the skip mask from altitude, advance the time uniform.
- The fragment side: distance-based hole discard at the level boundary plus the dither
  crossfade band (M5).
- The low-tier path: half the levels (my call: L0/L2/L4) at half the trains, gated by the
  existing `world.setQuality` lever.

Everything about the TSL graph structure, the dither pattern, the exact fade curve, and
the internal helper decomposition is the builder's.

## 9. How we will know it worked

The repo's existing measurement culture applies; this is not a "looks fine" gate.

| What | How | Gate |
| --- | --- | --- |
| Level table and cell rule | unit tests on the pure level/train tables | every level's cell ≤ shortest visible train / 4 |
| Train visibility distances | unit test against §5's constants | matches the table exactly |
| Skip rule | unit test: altitude → drawn level set | 7 m → all 5; 240 m → 3 |
| Scene graph | node-build test | 5 meshes, names stable, no static webgpu import |
| Seam invisibility | frozen frames (`?qa=frozen`, `?pos=`), gradient magnitude across each seam band | no discontinuity above the surface's own local gradient noise |
| No ring artifact | frozen frames from 4 headings + 3 altitudes | no closed contour in an edge map around the camera |
| Vertex swimming | frozen frames, camera advanced in tiny world steps | frame-to-frame difference under the noise floor while stationary |
| Triangle budget | `__porco.qa.describe().render.triangles` | ≈41k at skim, ≈25k at ceiling; sea never exceeds 25% of the drawn frame |
| Shading intact | existing band-occupancy + bloom-margin gates from the sea plan Task 7 | occupancy > 5% per band, margin ≥ 0.063 |

## 10. Risks the builder should not paper over

- **R1 — Grazing-angle crest occlusion.** §5 measures *height* against a pixel, but at a
  7 m skim the horizon-ward water shows overlapping crests edge-on. A wave can be
  sub-pixel in height and still be visible as an occlusion pattern. If the LOD reads as
  "the water went flat" in the mid-distance, the height criterion is incomplete and the
  band table needs a grazing-angle correction. **Judge this on frozen frames, not in the
  abstract.**
- **R2 — Mid-range ALU is unmeasured.** No GPU timestamp channel exists in this harness
  (`puff-budget-2026-11-02.json` records that limitation). Vertex ALU should be trivial
  at 41k triangles × 5 trains, but "should be" is not a measurement; the device run is a
  human gate.
- **R3 — Snapping beats.** M6's snap quantum interacts with the fade in M4; a level
  snapping while a train is fading could produce a one-frame flicker. Needs a frozen-frame
  A/B across a snap boundary, which is fiddly to set up.
- **R4 — Crossfade versus toon bands.** A dither crossfade on a surface shaded in hard
  flat bands may read as noise in the band colours rather than as a blend. If so, the
  fallback is a geometric stitch rather than an alpha blend — a larger change, so decide
  it early.
