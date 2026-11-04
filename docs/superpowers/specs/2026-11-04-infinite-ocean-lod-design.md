# Infinite Ocean — Surface LOD Design

Date: 2026-11-04. Branch: `feat/puff-cluster-cloud` (reconstruct baseline: no sea).
Companion to `2026-11-04-stylized-sea-design.md` — that one decides **what the water looks
like**; this one decides **how much of it exists and at what resolution**.

Supersedes the single-mesh approach implied by `plans/2026-11-04-stylized-sea.md` Task 3
and Task 6.

**Revision 2** — corrected after a builder review. Revision 1 had an arithmetic error in
its own level table (cells that could not satisfy its own cell rule) and computed the pixel
pitch at the wrong resolution. Both are fixed below; §11 records what changed and why.

---

## 1. Intent and why

The previous FFT sea was a **single 1600 m mesh** (560² segments, 627k triangles) towed
under the aircraft. Two things are wrong with that now:

1. **The vertex cost model changed.** The FFT displaced vertices with *one texture sample*.
   The rebuild displaces them with *five analytic Gerstner trains* — five `sin`+`cos` per
   vertex. Reusing the old density means trig calls in the millions per frame.
2. **A uniform grid is wrong for a 7 m skim.** `SKIM.DECK_Y = 7`: the camera can be seven
   metres above the water. At that height the near field needs cells of ~2.75 m to show the
   short trains, while 600 m away nothing needs to exist at all. One cell size cannot serve
   both without wasting most of the budget on water nobody can resolve.

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
- **G4** The LOD is distance-driven and continuous, so it needs no hand-placed boundaries
  and no per-scene tuning.

Non-goals (explicitly out): baked height caches, tessellation shaders (unavailable on the
WebGL2 fallback), a general-purpose terrain clipmap, wave physics beyond the existing
Gerstner field.

Anti-goals (failure even if it renders):

- **A visible ring or square around the camera.** The classic LOD tell.
- **Popping** when a level appears, disappears, or changes its train set.
- **Vertex swimming** as the camera slides: samples sliding through the field make the whole
  surface shimmer even when nothing else changes.
- **Spending triangles on sub-pixel water.**
- Any static `import 'three/webgpu'` in the boot graph.

## 3. Constraints (inherited, non-negotiable)

- **C1** TSL node materials only; no `ShaderMaterial` / `onBeforeCompile`. WebGPU modules
  load through dynamic `import()` (`module-graph.test.ts` guards this).
- **C2** Mobile low tier must run — and see M9: on a mid-range phone the fragment stage is
  the expensive one, so the cheap path has to cut fragment work too, not just vertices.
- **C3** Palette single source (`palettes.ts`); `SEA_PALETTE.haze === SKY_PALETTE.horizon`
  and `SUN_POSITION === [60, 35, -280]` stay pinned.
- **C4** Post contract untouched: bloom threshold 0.82, K4 margin 0.063.
- **C5** Lagrangian rule: displacement and sampling both evaluate at **base**
  (pre-displacement) coordinates. The old self-feedback bug stays structurally impossible.
- **C6** `camera.far` 2000, `scene.fog` 60→700, `SKIM.DECK_Y = 7`, and the 240 m ceiling do
  not move. The sea does **not** use `scene.fog` (it is a custom TSL material, like the
  puffs and the dome) — the haze question is §12 Q1.

## 4. Decided by the user

- **D1** The near field shows everything that can be shown — a hard requirement, not a
  stretch goal.
- **D2** Crossing the detail boundary produces **no perceivable change**. The target is a
  line you cannot locate, not a graceful transition.
- **D3** Full implementation in one step, not a simplified single-mesh first pass.
- **D4** Target 60 fps on **mid-range Android**, 30 fps floor.
- **D5** The "500 m" figure was a **reference figure, not a constant**. Extents are derived.
- **D6** The far tint saturates at **~900 m**, not the 520 m currently in `horizon.ts`
  (answered 2026-11-04). The horizon should read as open water from a 7 m skim rather than
  as a close haze wall. This moves a tested constant — see §7.

## 5. The derivation (this is the load-bearing wall)

### 5.1 Pixel pitch — at the drawing buffer, not CSS

The canvas is a 9:16 CSS box and `main.ts` clamps the device pixel ratio to **1.5**. The
eye's limit is the **rendered** buffer, because that is what gets upscaled to the display: a
feature smaller than one rendered pixel is not representable at all.

Canonical case: drawing buffer height `1280 × 1.5 = 1920` px, vertical FOV 60°.

```
1 px = 60° / 1920 = 0.03125° = 5.454e-4 rad
```

This is **1.5× finer** than revision 1 assumed (it used the CSS height), so every distance
below is 1.5× larger than rev 1's numbers. Getting this wrong in the conservative direction
would flatten the water early on exactly the target devices.

**M8 — the table is fixed to this canonical case.** dpr is clamped at 1.5 and a mid-range
Android at 720×1280 CSS renders exactly 1080×1920. A device that somehow renders fewer
pixels than canonical gets slightly *more* detail than it needs; that costs triangles, not
fidelity. Deriving the table at runtime instead would mean rebuilding every level's geometry
on resize/DPR change — rejected.

### 5.2 Per-train geometric visibility

A vertical displacement `A` at distance `d` subtends `A/d` radians, so each train has a
distance past which its height is under one rendered pixel:

| train | λ (m) | A (m) | height < 1 px beyond | cell must be ≤ λ/4 |
| ----: | ----: | ----: | -------------------: | -----------------: |
| 1 | 180 | 0.34 | **623 m** | 45.00 m |
| 2 |  90 | 0.24 | **440 m** | 22.50 m |
| 3 |  45 | 0.15 | **275 m** | 11.25 m |
| 4 |  22 | 0.10 | **183 m** |  5.50 m |
| 5 |  11 | 0.06 | **110 m** |  2.75 m |

Two consequences, and they are the whole design:

1. **Beyond 623 m the surface is geometrically flat.** Not "cheap" — flat. Every train's
   height is under a pixel, so no triangle count can improve it. What remains visible is the
   **slope**, which lives in the normal, per-pixel, free. This is why the reference art
   (`Uber-Stylized-Water`, Anime preset) can turn vertex waves off entirely and still read
   as water.
2. **The set of trains worth displacing shrinks with distance**, and the cell can coarsen
   with it. At the moment a train is dropped its contribution is under a pixel, so the step
   is invisible **by construction** rather than by blending.

At the 240 m ceiling the nearest water is 240 m away, so trains 4 and 5 are sub-pixel
everywhere in the frame and the near bands are not merely cheap but pointless (§6 M7).

## 6. My calls (challenge freely)

- **M1 — Distance to the camera is the driver, not altitude.** Altitude only sets a floor on
  that distance. One rule for skim, cruise and ceiling instead of three regimes.
- **M2 — Bands are cut at the visibility distances, not at powers of two.** This is the
  correction to revision 1. Because train 5 stays visible out to 110 m, *every* band
  covering any part of 0–110 m must be at ≤2.75 m cells; a doubling clipmap would put 4–6 m
  cells there and lose the short trains across most of the near field. So:

  | band | covers (half-extent) | shortest visible train | cell | ~triangles |
  | --- | --- | --- | --- | --- |
  | B0 | 0 – 110 m | 11 m | 2.75 m | 12.8k |
  | B1 | 110 – 183 m | 22 m | 5.50 m | 5.5k |
  | B2 | 183 – 275 m | 45 m | 11.0 m | 2.8k |
  | B3 | 275 – 440 m | 90 m | 22.0 m | 2.0k |
  | B4 | 440 – 623 m | 180 m | 44.0 m | 0.8k |
  | B5 | 623 – 2048 m | — (flat) | 128 m | 1.8k |

  ≈ **26k triangles**, and the entire near 220 m square is at full 2.75 m resolution — which
  is what "near field gets everything" actually costs, and it is affordable.

  ⚠️ B0 at 2.75 m and B1 at 5.50 m sit **exactly** on the 4-samples-per-wavelength rule, not
  under it. That is deliberate (it is the project's existing rule) but it leaves zero margin,
  and the seam gate in §9 is what would catch it if it is too tight. If a seam measures hot,
  the fix is one step finer in that band (B0 → 2.5 m, B1 → 5.0 m, ≈+2.7k triangles) — never
  re-cutting the band boundary, which would reintroduce the rev-1 error.
- **M3 — Bands are drawn as square annuli, not nested full squares.** Nested full squares
  would overdraw the centre five times over; on a mid-range phone that fill cost is worse
  than the triangles it saves. The ring is built as four trapezoid strips sharing the band's
  cell size.
- **M4 — Per-train distance fade in the vertex shader, in addition to the band sets.** Each
  train's displacement amplitude is multiplied by a smooth weight reaching 0 at its
  visibility distance from §5.2. Band sets are a cost optimisation; the fade is the
  invisibility guarantee. The fade must **start** no later than one band-width before it
  ends, so the drop is spread over tens of metres rather than metres.
- **M5 — Shading is per-pixel from the exact field; geometry carries only displacement.**
  This is the answer to "normals are per-pixel and free" and it has three consequences:
  - Crest tint (from height) and foam (from the Jacobian) are evaluated per fragment at base
    coordinates, so **two overlapping bands shade identically** and there is nothing to blend
    at a seam.
  - **The dither crossfade is therefore dropped.** It would have been a solution to a
    problem that does not exist, and R4-v1 (dither read as noise on hard toon bands) dies
    with it. Bands simply meet; the only discontinuity is a sub-pixel geometric step.
  - The ALU risk moves from the vertex stage to the **fragment** stage, where it is much
    more expensive on mobile. That is now R2 and it forces M9.
- **M6 — Each band snaps its origin to its own cell size (toroidal wrap).** Continuous
  translation makes samples slide through the field and the surface shimmers. Snapping keeps
  sample positions world-stable. Finer bands snap more often; that is inherent and is
  accepted.
- **M7 — Skip a band entirely when the camera's altitude exceeds its finest train's
  visibility distance.** At 240 m: B0's finest train is visible to 110 m and everything in
  B0 is >240 m away → skip B0 and B1; the innermost drawn band loses its inner hole. Ceiling
  cost drops to ~7k triangles.
- **M8 — Canonical pixel table, fixed at build.** See §5.1.
- **M9 — The low tier cuts segments, not bands, and cuts fragment trains.** Same band
  structure (no holes to reason about), half the segments per side, and the fragment path
  drops to `LOW_TIER_TRAINS = 3`. Cutting *bands* (e.g. "keep B0, B2, B4") would either
  leave literal holes in the ocean or force a coarse band to cover the near field, which is
  the moiré anti-goal. Cutting segments keeps the topology identical and only coarsens it.

## 7. Impact on what already exists

- `src/sea/waves.ts` exports `SEA_PATCH_SIZE = 1600`, `SEGMENTS_HIGH = 600`,
  `SEGMENTS_LOW = 300` and a test asserting `SEA_PATCH_SIZE / SEGMENTS ≤ finest/4`. Those
  three constants are **superseded** by the band table. The test's *intent* survives — "cell
  ≤ shortest visible wavelength / 4" — but it must be re-expressed per band.
  `TRAINS`, `gerstnerField`, `finestWavelength`, `combinedRms`, `LOW_TIER_TRAINS` stay.
- `plans/2026-11-04-stylized-sea.md` **Task 3** and **Task 6** are rewritten against this
  document. Tasks 4, 5, 7 (foam, light terms, grading) are unaffected — fragment work.
- `src/far-field.ts` keeps only the sky shell. The sea owns its own tow, because each band
  has its own snap quantum and the tow is no longer a single translation.
- **`src/horizon.ts` — `HORIZON.HAZE_FAR` moves 520 → 900** (D6). This is not a free edit:
  `horizon.test.ts:18-20` asserts "haze saturates before the sea's edge" using a **frozen
  600 m** figure inherited from the deleted FFT patch (`half patch − half step`). With
  `HAZE_FAR = 900` that frozen edge (≈646 m from the aircraft) is no longer past saturation,
  so the test **fails unless the literal is updated**. The correct replacement is the new
  worst-case edge: the sea now reaches 2048 m (B5 half-extent), so
  `hypot(2048, ALT_MAX + CAM_HEIGHT) ≈ 2063 m > 900` — the property holds, and with a much
  larger margin than before. `CLOUD_HAZE` is a separate constant and does not move.
- `horizon.test.ts`'s frozen 600 m literal is also the item the builder review flagged as
  needing replacement; it is the same edit as above, done once.
- **B5 is now load-bearing, not insurance.** With saturation at 900 m, the 623–2048 band
  still carries colour variation out to 900 m even though its geometry is flat; it can stay
  at 128 m cells because per-pixel shading (M5) does the tint. Were the answer 520 m, B5
  would be ~1.8k triangles of pure constant colour — the one thing D6 actually buys.

## 8. Shape of the implementation (builder's, but bounded)

At minimum: one module owning the band stack (geometry per band, named `sea-b0` … `sea-b5`);
per-band state (half-extents, cell, snap origin, train set, hole radius); an update step
(snap each band, update holes from the camera, update the skip mask from altitude, advance
time); the fragment side (exact-field height/Jacobian/normal per pixel, hole discard at the
band boundary); and the low-tier path per M9 behind the existing `world.setQuality` lever.

The TSL graph structure, fade curve, helper decomposition, and ring-geometry construction
are the builder's.

## 9. How we will know it worked

| What | How | Gate |
| --- | --- | --- |
| Band table | unit tests on the pure band/train tables | every band's cell ≤ its shortest visible train / 4 (M2 table, exactly) |
| Visibility distances | unit test against §5.2 | matches the table to 1 m |
| Skip rule | unit test: altitude → drawn band set | 7 m → all 6; 240 m → B2–B5 |
| Scene graph | node-build test | one mesh per band, names stable, no static webgpu import |
| Seam invisibility | frozen frames, sample a 40 px-wide strip across each band boundary **in screen space**, take the max |Δcolour| per pixel row | ≤ the 95th percentile of |Δcolour| within the same band 20 px inward — i.e. the seam is no sharper than the surface itself |
| No ring artifact | edge map on frozen frames, 4 headings × 3 altitudes, fit a circle to the longest closed contour around frame centre | no closed contour with radius > 50 px that is not present in a single-band reference render |
| Vertex swimming | camera advanced 24 × 0.25 m world steps, frame-to-frame mean |Δ| inside the band area | under the same statistic measured on a stationary camera |
| Triangle budget | `__porco.qa.describe().render.triangles` | ≈26k at skim, ≈7k at ceiling; sea never exceeds 25% of the drawn frame |
| Shading intact | band-occupancy + bloom-margin gates from the sea plan Task 7 | occupancy > 5% per band, margin ≥ 0.063 |

## 10. Risks the builder should not paper over

- **R1 — Grazing-angle crest occlusion.** §5 measures *height* against a pixel, but at a 7 m
  skim the horizon-ward water shows overlapping crests edge-on. A wave can be sub-pixel in
  height and still be visible as an occlusion pattern. If the LOD reads as "the water went
  flat" in the mid-distance, the height criterion is incomplete and the band table needs a
  grazing-angle correction. **Judge on frozen frames, not in the abstract.** This is the one
  risk that can invalidate the whole table.
- **R2 — Fragment ALU on a mid-range phone is unmeasured and is now the main cost.** With
  M5 the fragment evaluates height, Jacobian and normal for up to 5 trains per pixel; a
  720p-ish sea is ~0.3–0.5 M pixels → several million transcendentals per frame. No GPU
  timestamp channel exists in this harness (`puff-budget-2026-11-02.json` records that
  limitation). This needs a real-device spike **before** the shading task is planned in
  detail.
- **R3 — Snapping beats.** M6's snap quantum interacts with M4's fade; a band snapping while
  a train is fading could produce a one-frame flicker. Needs a frozen-frame A/B across a snap
  boundary, which is fiddly to set up.
- **R4 — Retired.** The dither crossfade is gone (§6 M5), so its toon-band risk goes with it.
  Kept as a numbered hole so nothing re-introduces blending without noticing this note.

## 11. Revision log

**rev 2 (after builder review).** Three substantive corrections:

1. **Level table arithmetic.** Rev 1 cut bands at powers of two (96/192/384/…) and claimed
   `cell = 3/6/12/…` satisfied its own rule. It did not: 3 m > 2.75 m, 6 m > 5.5 m. The
   deeper problem is that train 5 stays visible to 110 m, so *no* doubling scheme can work —
   bands are now cut **at the visibility distances** (M2).
2. **Pixel pitch.** Rev 1 used the CSS height (1280). The clamp is dpr 1.5, so the rendered
   buffer is 1920 and every distance is 1.5× larger. Rev 1 would have flattened the water
   early on precisely the target devices.
3. **Crossfade removed.** Once shading is per-pixel from the exact field (M5), overlapping
   bands shade identically and there is nothing for a crossfade to blend.

Also: the low tier no longer drops bands (that left literal holes), it cuts segments (M9);
the triangle budget drops 41k → 26k; and `scene.fog`'s 700 m was the wrong constant to cite
for the sea's extent (the sea ignores `scene.fog`), so the far band's job is stated in terms
of the haze instead.

## 12. Open question for the user

**None.** Q1 (how far the horizon should read) was answered as **900 m** on 2026-11-04 and
is recorded as D6. Its knock-on — `HORIZON.HAZE_FAR` 520 → 900 and the frozen-edge test
literal — is written up in §7 so the plan can carry it as a real task rather than a
footnote.

The remaining uncertainty is not the user's: R1 (grazing-angle crest occlusion) can only be
settled on frozen frames once the surface exists, and R2 (fragment ALU on a mid-range phone)
needs a device measurement. Both are build-time gates, not design questions.

