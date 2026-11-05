# Infinite Ocean — Surface LOD Design

Date: 2026-11-04. Branch: `feat/puff-cluster-cloud` (reconstruct baseline: no sea).
Companion to `2026-11-04-stylized-sea-design.md` — that one decides **what the water looks
like**; this one decides **how much of it exists and at what resolution**.

Supersedes the single-mesh approach in `plans/2026-11-04-stylized-sea.md` Task 3 and Task 6.

**Revision 3.** Rev 1 had an arithmetic error in its own table. Rev 2 fixed the arithmetic
but kept a frozen pixel constant and a near-field assumption that do not survive contact
with the actual camera. Rev 3 replaces both with a per-frame quantity, tightens the
sampling rule to account for wave direction, and reallocates the near field per D7. §12
records all three revisions honestly.

---

## 1. Intent and why

The previous FFT sea was a **single 1600 m mesh** (560² segments) towed under the aircraft.
It displaced vertices with *one texture sample*; the rebuild displaces them with *five
analytic Gerstner trains*. Reusing that density means trig calls in the millions per frame.
And a uniform grid cannot serve a camera that sits 13 m above the water at a 7 m skim: the
near water needs cells an order of magnitude finer than the far water, and one cell size
wastes the budget on water nobody can resolve.

The user's framing: **crossing any detail boundary must produce no perceivable change** —
not "a smooth transition", but "you cannot find the line".

## 2. Goals / non-goals / anti-goals

Goals:

- **G1** At 7 m skim the near water carries a coherent wave form, nothing dropped inside the
  range where it is visibly resolved.
- **G2** The ocean extends past the haze and reads as infinite. No visible edge, no ring
  around the camera, no pop when the aircraft climbs, dives or banks.
- **G3** 60 fps on a mid-range Android at the skim, 30 fps floor; the sea's triangle count
  is fixed regardless of flight distance.
- **G4** The LOD is distance-driven and continuous, with no hand-placed boundaries.

Non-goals: baked height caches, tessellation shaders (unavailable on the WebGL2 fallback),
a general-purpose terrain clipmap, wave physics beyond the existing Gerstner field.

Anti-goals (failure even if it renders): a visible ring or square around the camera; popping
when a band or train set changes; vertex swimming as the camera slides; spending triangles on
sub-pixel water; any static `import 'three/webgpu'` in the boot graph.

## 3. Constraints (inherited, non-negotiable)

- **C1** TSL node materials only; no `ShaderMaterial` / `onBeforeCompile`. WebGPU modules
  load through dynamic `import()` (`module-graph.test.ts`).
- **C2** Mobile low tier must run. On a mid-range phone the **fragment** stage is the
  expensive one (§6 M10), so the cheap path must cut fragment work too.
- **C3** Palette single source; `SEA_PALETTE.haze === SKY_PALETTE.horizon`,
  `SUN_POSITION === [60, 35, -280]` stay pinned.
- **C4** Post contract untouched: bloom 0.82, K4 margin 0.063.
- **C5** Lagrangian: displacement and sampling both evaluate at **base** coordinates.
- **C6** `camera.far` 2000, `SKIM.DECK_Y = 7`, `CAM_HEIGHT = 6.8`, the 240/6 m altitude
  envelope and `FALL_MAX_SINK` do not move. The sea does **not** use `scene.fog` (M11).

## 4. Decided by the user

- **D1** The near field shows everything that can be shown.
- **D2** Crossing a detail boundary produces no perceivable change — a line you cannot locate.
- **D3** Full implementation in one step, not a simplified first pass.
- **D4** 60 fps target, 30 fps floor, **mid-range Android**.
- **D5** The "500 m" figure was a reference, not a constant.
- **D6** The far tint saturates at **~900 m**, not the 520 m in `horizon.ts`.
- **D7** The water at the bottom of the frame is substantially covered by the aircraft and
  the HUD, so the innermost band need not carry maximum density; the budget goes to the
  mid-ground instead.

## 5. The derivation

### 5.1 Pixel angle is per-frame, not a constant

Three things make a frozen table wrong:

1. **Rectilinear projection.** 1 px at the optical axis subtends `2·tan(fov/2)/H`, not
   `fov/H`. For `fov = 60`, that is `1.1547/H`, which is **9.3% larger** than the naive
   average. It is also not constant across the frame: `1 px = (1.1547/H)·cos²θ`, so at the
   frame corner (θ = 30°) it is 25% smaller again.
2. **The canvas is not 1280 tall.** `index.html:12` caps `#frame` at `max-width:560px` with
   `aspect-ratio:9/16`, so the CSS height is **≤ 995.6 px**; 1280 is the HUD's *logical*
   frame, not the drawing buffer.
3. **Both inputs move.** `pixelRatio = min(dpr, 2)` without post and `min(dpr, 1.5)` with it
   (`renderer.ts:63`, `main.ts:171`), and `camera.fov` is animated 60 → 69° by
   `CAM_FOV_KICK` (`camera-rig.ts:205`).

Across those, `rad/px` spans roughly **5.8e-4 to 1.4e-3** — a 2.4× spread.

**M1 — the angular budget is a per-frame uniform, not a constant.** Each frame the sea
computes `radPerPixel = 2·tan(fov/2) / drawingBufferHeight` and passes it to the material.
Every fade distance below is then `A / radPerPixel`, evaluated on the GPU. Geometry (band
cells) is fixed at the **most demanding** configuration — smallest `rad/px`, i.e. `fov = 60`
with the largest buffer (1992 px at dpr 2) — so the mesh never under-provides, and the
uniform lets the fades tighten automatically on easier configurations.

The cos²θ falloff is deliberately **ignored**: honouring it would make the criterion
view-direction dependent, which breaks G4. The consequence is that the table is up to 25%
conservative at the frame edges. That is the safe direction and costs triangles, not fidelity.

### 5.2 Sampling rule must account for wave direction

The trains travel along `WIND = (0.82, −0.57)` against an axis-aligned grid, so the sample
spacing *along the direction of travel* is `c / max(|dir.x|, |dir.z|)` = `c / 0.82`. Samples
per wavelength is therefore `0.82·λ / c`, and four samples requires

```
c ≤ 0.205·λ
```

not `λ/4` (which is 22% looser). For λ = 11 m that is **2.26 m**. The repo's existing rule in
`waves.test.ts:56` is direction-blind and therefore too loose; it must be re-expressed.

### 5.3 Per-train geometric visibility

A vertical displacement `A` at distance `d` subtends `A/d`. At the most demanding
configuration (`rad/px = 5.797e-4`):

| train | λ (m) | A (m) | height < 1 px beyond | cell ≤ 0.205λ |
| ----: | ----: | ----: | -------------------: | ------------: |
| 1 | 180 | 0.34 | **587 m** | 36.9 m |
| 2 |  90 | 0.24 | **414 m** | 18.5 m |
| 3 |  45 | 0.15 | **259 m** |  9.2 m |
| 4 |  22 | 0.10 | **173 m** |  4.5 m |
| 5 |  11 | 0.06 | **104 m** |  2.26 m |

Beyond 576 m (B5's inner edge, just inside that 587 m point) the surface is **geometrically
flat** — not cheap, flat. Every train's height is
under a pixel, so no triangle count improves it; what remains is the slope, which lives in
the normal.

## 6. My calls

- **M2 — Bands are cut at the visibility distances**, not at powers of two, because train 5
  stays visible out to 104 m and a doubling scheme would put 4–6 m cells there.

  | band | covers | cell | geometric trains | ~tris |
  | --- | --- | --- | --- | --- |
  | B0 | 0 – 45 m | 2.25 m | 1–5 | 3.2k |
  | B1 | 45 – 171 m | 4.5 m | 1–4 | 10.8k |
  | B2 | 171 – 252 m | 9.0 m | 1–3 | 3.4k |
  | B3 | 252 – 396 m | 18 m | 1–2 | 2.3k |
  | B4 | 396 – 576 m | 36 m | 1 | 1.1k |
  | B5 | 576 – 1536 m | 96 m | none (flat) | 1.8k |

  ≈ **22.5k triangles** (`segments² − (2·inner/cell)²` per band, ×2). These are the numbers
  `src/sea/lod.ts:124-131` shipped after rev 3's retune; rev 3 left this table on the
  pre-retune values (48/173/259/414/587/2048, B5 at 128 m) and they disagreed with M5 and
  with the code. B0 ends at 45 m because D7 says the water closer than that is substantially
  covered; giving it full 2.25 m resolution over train 5's 104 m radius would cost another
  ~13k (92² cells vs 40²) for pixels the aircraft already owns. Train 5 is therefore
  **geometric only inside 45 m** and normal-only beyond — recorded as a deliberate consequence
  of D7, not an oversight, and the reason M4's fade schedule has exactly one exception.
- **M3 — Bands are square annuli built as four strips.** Nested full squares would overdraw
  the centre five times; on a mobile tiler that fill cost exceeds the triangles it saves.
- **M4 — Per-train distance fade in the vertex shader.** Weight reaches 0 at the train's
  distance from §5.3 **as computed from the per-frame `radPerPixel`**. The fade must start at
  least one band-width earlier, so no drop happens at a band edge. There is exactly **one
  exception, and it is B0/B1**: every other band edge is cut a few percent inside its dropped
  train's 1-px distance, so that train's weight is ~0 where the band ends and the step M5
  measures is 0.97–1.01 px; B0 ends at 45 m while train 5 lives to 104 m (D7), so train 5's weight
  must reach 0 **at 45 m** — otherwise the band edge carries a 2.2 px amplitude step that no
  geometry can hide (M5: a wall there would be a 2.2 px crease).
- **M5 — Quantised nesting is what makes a seam safe; the inset is the fallback for the one
  seam that does not nest.**

  Every band's cell is a multiple of the one inside it — 4.5 = 2×2.25, 9 = 2×4.5, 18 = 2×9,
  36 = 2×18 — **except B5, whose 96 m is 2.67× B4's 36 m.** Each band tows on its own quantum
  with `floor` (M6), so the coarse origin is never *outward* of the finer one: when
  `c_c = k·c_f`, `O_c = floor(v/c_c)·c_c` is itself a multiple of `c_f` and is `≤ v`, so it
  cannot exceed `O_f = floor(v/c_f)·c_f`. The coarse hole edge therefore lands at or *inside*
  the fine band's outer edge, with no alignment pass: **at the four 2:1 seams the overlap is
  `∈ [0, c_c − c_f]` at every camera position, and a gap of missing water is structurally
  impossible.** Per axis that is 2.25 / 4.5 / 9 / 18 m of double cover, and it is the snap that
  supplies it, not the table.

  B4/B5 gets none of that for free, and it is the only seam that can *lose* water: with
  `96 ∤ 36` the residual takes both signs — measured **`[−84, +24] m`** per axis — so a +24 m
  residual opens a 24 m hole in the sea at ~576 m. B5's hole edge therefore moves from 576 m
  to **480 m**. 96 m is the smallest inset the lattice can express (it must be a multiple of
  B5's cell), and it covers the worst case with room: overlap after inset is 72–180 m. It
  costs one row of B5 cells — the hole shrinks from 12 cells across to 10, so 44 quads out of
  880 (5% of that band's triangles), and the annulus area grows from `1536² − 576²` to
  `1536² − 480²`, about 5% more B5 fill.

  What the inset is *not* is free fill, and the invoice is denominated in pixels — but only
  where the dropped train is still alive at the seam. In the overlap both surfaces are drawn,
  separated by exactly that train's displacement, so the flatter coarse surface wins the depth
  test wherever the train is negative. M4's fade is what pays it: each seam sits at the finer
  band's outer edge, which is at or beyond the dropped train's fade distance, so at the canonical
  budget the train reaches the seam weighted to zero and the two surfaces agree. The old
  arithmetic (`0.34 m @ 576 m ≈ 0.98 px`, `1.01`, `0.99`, `0.97`, and `0.06 m @ 45 m ≈ 2.2 px`
  at B0/B1) was sizing a step that the fade has already removed — see R6, and the flat-green
  skim probe that finds no rim at any of the five seams. The arithmetic still bites on a budget
  *finer* than canonical: at 3e-4 rad/px train 4 lives to 333 m and is still ~0.10 m alive where
  b1 ends at 171 m. That is why the inset is specified for B4/B5 and nowhere else — at the
  nested seams it would buy nothing (a gap is already impossible) and only widen the cover.

  **There is no skirt.** Overlap ≥ 0 leaves no exposed boundary to stitch: the coarse band's
  inner edge is buried under the fine surface, and its own inner row may be anything, because
  nothing sees it. A skirt would only have a job if the two surfaces disagreed *at the edge
  line*, and the only seam that still does is B0/B1 — where a 0.06 m wall is a 2.2 px crease,
  i.e. exactly the band edge A1 forbids, manufactured by the remedy. That seam is a **fade**
  problem (M4), not a stitch problem, and the reason is a number rather than a taste: the
  other four band edges sit a few percent *inside* their dropped train's 1-px distance (171 vs
  173, 252 vs 259, 396 vs 414, 576 vs 587 m), so their step measures 0.97–1.01 px. B0/B1
  is the exception, cut at 45 m against train 5's 104 m by D7 — so train 5 must reach weight 0
  *at 45 m*, not at its visibility distance.

  **This supersedes the earlier "zero overlap, exact skirt" wording.** That wording was tuned
  against the residual's *magnitude* and never its *sign*, so it bought a skirt for four seams
  that could not open and left the one seam that could (B4/B5) unattended in the opposite
  direction. It also supersedes a rejected alternative: **one shared tow origin for all
  bands.** A common origin snapped to 2.25 m makes a coarse band's vertices sit at
  `O + k·cell` with `O mod cell` alternating between 0 and 2.25, so every coarse band's
  lattice slides by half its own cell as the camera moves — exactly the vertex swimming M6
  exists to prevent. Aligning seams by that route trades a fill cost for a shimmer.
  The dither crossfade stays rejected for a reason stronger than "nothing to blend": a 1-bit
  stipple on a hard-banded palette draws a *dashed band edge*, which is anti-goal A1
  manufactured by the mechanism meant to prevent it.
- **M6 — Each band snaps its origin to its own cell size.** Continuous translation makes
  samples slide through the field and the surface shimmers.
- **M7 — Skip a band when its finest geometric train is sub-pixel everywhere it occurs**,
  computed from the per-frame `radPerPixel` **with hysteresis**: a band is dropped at
  `altitude > d_train + 10 m` and only restored below `d_train − 10 m`. Without the dead band
  the aircraft crosses the threshold at up to `FALL_MAX_SINK` during a dive — the most
  scrutinised pose — and the band flickers in and out.
- **M8 — No frozen distance table in the shader.** Distances are uniforms derived per frame
  (M1); the table in §5.3 exists only to size the geometry.
- **M9 — Low tier keeps the same band topology**, halves the segments per side, and drops
  the fragment path to `LOW_TIER_TRAINS = 3`. Cutting *bands* would either leave literal
  holes or force a coarse band over the near field — the moiré anti-goal.
  **Shipped so far (Task 6): only the train mask.** `setQuality` sets a per-band target and
  `update` eases `uTrains` toward it at 1/12 per frame, with the graph masking each train by
  `smoothstep(i, i+1, uTrains)`. That buys *appearance*, not milliseconds: the loop bound is
  baked per band (a TSL loop bound cannot be a uniform), so every train's `sin`/`cos` still
  executes on the low tier. The segment halving has not landed and cannot be a uniform —
  it needs a geometry rebuild and a tow quantum that is still a multiple of the band's cell.
  Do not let Task 8's mobile budget book a saving from this.
- **M10 — Shading is per-pixel from the exact field, and that is the main cost.** Crest tint
  (height) and foam (Jacobian) need per-fragment evaluation, and normals must be per-pixel or
  the short trains alias into low-frequency mottling at distance. The consequence is that the
  sea is **fragment-bound**: roughly 0.5 M water pixels × 5 trains × 2 transcendentals ≈
  **5 M transcendentals per frame**, against ~200k on the vertex side. The vertex budget is
  not where the money is, and any perf claim that counts only triangles is measuring 4% of
  the load.
- **M11 — The sea material has `fog` disabled; its own haze owns the distance colour.**
  `scene.fog` is `#c96a7a` mauve while `SEA_PALETTE.haze` is `#ff9a5a` orange. Enabling
  scene fog on the sea would converge far water on mauve against an orange sky horizon —
  a full-width colour seam created by the sea itself. The puffs and the dome already opt out
  of `scene.fog`; the sea joins them.
- **M12 — `HORIZON.HAZE_FAR` moves 520 → 900** (D6). `horizon.test.ts:18-20` asserts haze
  saturates before the sea's edge against a **frozen 600 m** inherited from the deleted FFT
  patch; at 900 m that fails (frozen edge ≈ 646 m). The literal moves to the new worst case
  `hypot(1536, 246) ≈ 1556 m`, which passes with more margin than the original had.
- **M13 — The cost of this design is justified by D3 and R1, not by §5.** §5 proves the LOD
  is *invisible*; it does not prove the triangles are *necessary*. A single ~700 m level at
  ~9 m cells plus per-pixel normals would render a nearly identical frame for half the
  triangles. What actually selects the expensive design is the user's one-step decision (D3)
  and the possibility that grazing-angle crest occlusion is visible (§10 R1). Stating it the
  other way round — as if the derivation demanded 22.5k triangles — would be dishonest.

## 7. Impact on what already exists

- `src/sea/waves.ts`: `SEA_PATCH_SIZE` / `SEGMENTS_HIGH` / `SEGMENTS_LOW` are superseded by
  the band table. `waves.test.ts:56`'s rule (`SEGMENTS` vs `finest/4`) is **direction-blind
  and too loose**; it must be re-expressed as `0.205·λ` per band. `TRAINS`, `gerstnerField`,
  `finestWavelength`, `combinedRms`, `LOW_TIER_TRAINS` stay.
- `plans/2026-11-04-stylized-sea.md` Task 3 and Task 6 are rewritten against this document.
  Tasks 4, 5, 7 (foam, light terms, grading) are unaffected — fragment work.
- `src/far-field.ts` keeps only the sky shell; the sea owns its own per-band tow.
- `src/horizon.ts` + `horizon.test.ts`: see M12.
- `src/post.ts`: DOF focuses on the aircraft, so mid/far water is defocused by a
  distance-dependent radius. The criterion in §5.3 ignores defocus, which makes it
  conservative (blur pushes a feature below one pixel *sooner*). Noted, not corrected.

## 8. Shape of the implementation (builder's, but bounded)

One module owning the band stack (`sea-b0` … `sea-b5`); per-band state (half-extents, cell,
snap origin, train set, hole edge — `inner` for B0…B4, `inner − cell` for B5 per M5); an
update step (snap, hole edge, skip mask with hysteresis, time uniform, `radPerPixel` uniform,
one frame of the `uTrains` ramp); the fragment side (exact-field height / Jacobian / normal per
pixel, `fog: false`); the low tier per M9 behind `world.setQuality`.

The TSL graph structure, fade curve, helper decomposition and the seam's depth handling (R6)
are the builder's.

## 9. How we will know it worked

| What | How | Gate |
| --- | --- | --- |
| Angular uniform | unit test: `radPerPixel` from (fov, height) matches `2tan(fov/2)/H` | exact, and monotone in fov |
| Sampling rule | unit test per band | `cell ≤ 0.205 × shortest geometric λ`, direction-aware |
| Skip + hysteresis | unit test: altitude swept up and down | up-crossing and down-crossing differ by 20 m; no band toggles inside the dead band |
| Scene graph | node-build test | one mesh per band, stable names, no static webgpu import |
| Overlap | unit test: for every adjacent pair, sweep the camera origin over an integer cell grid and assert `coarseHole − fineOuter ≤ 0` in both axes | ≥ 0 everywhere; also the measured ranges from M5 (2.25 / 4.5 / 9 / 18, and B4/B5 in [72, 180] after inset) |
| Seam | flat-green skim probe (displacement live, colour replaced) + frozen frames: 40 px strip across each band boundary, max |Δ| per row vs the 95th percentile 20 px inward | no sky-coloured crack and no visible rim at any seam — **met 2026-11-05** (probe); the strip statistic still wants the shaded frames, and the residual to watch is a seam on a budget finer than canonical (R6) |
| No ring | edge map, 4 headings × 3 altitudes, closed contours around frame centre | none that a single-band reference render does not also have |
| Swimming | camera advanced 24 × 0.25 m, frame-to-frame mean |Δ| | under the same statistic on a stationary camera |
| Snap beat | 60 frozen frames across one L0/L1 beat period (6 m at cruise = 0.13 s) | no periodic modulation of the seam band above the frame noise floor |
| Budget | `__porco.qa.describe().render.triangles` | ≈22.5k at skim, ≈5k at ceiling |
| Shading | band occupancy > 5% each, bloom margin ≥ 0.063 | from the sea plan Task 7 |

## 10. Risks

- **R1 — Grazing-angle crest occlusion.** §5 measures *height* against a pixel; at a 7 m skim
  the horizon-ward water shows overlapping crests edge-on, so a wave can be sub-pixel in
  height and still visible as an occlusion pattern. **This is the risk that can invalidate
  the whole table** and it can only be judged on frozen frames once the surface exists.
- **R2 — The sea is fragment-bound and nobody has measured a phone.** §6 M10 estimates ~5 M
  transcendentals per frame for the normal/crest/foam field. No GPU timestamp channel exists
  in this harness (`puff-budget-2026-11-02.json` records that limitation). **A real-device
  spike belongs before the shading task is planned in detail**, not after.
- **R3 — Snap beat.** Each band's coverage square jumps by its own cell, so the relative
  offset of adjacent bands cycles with a 4.5 m period — 10.2 Hz at cruise speed for B0/B1.
  Under M5 this is a geometry-only change with no alpha and no stitch, so the exposed
  failure mode is no longer a moving skirt but the *width of the double cover* at the seam:
  whether the coarse surface poking through the fine one flickers as that width sweeps
  0 → 2.25 m is unverified. The flat-green skim probe settles the crack half of it (the surface
  is continuous); the flicker half still wants two frames a few snap cycles apart.
- **R4 — Far-plane clip.** B5's corner is at `1536·√2 ≈ 2172 m` (2048 m in the rev-3 table),
  past `camera.far = 2000`. It is hidden today only because haze saturates at 900 m (D6). The
  claim "the far edge never exists on screen" therefore rests on the haze constants, not on
  geometry.
- **R5 — fp32 world coordinates.** The field is evaluated at absolute world base coordinates
  (C5). At ~1000 km the position quantum on a 2.25 m cell is ~2% and phase error reaches
  12 mm on train 1. Not a today-problem; the camera-relative retrofit touches every node in
  §8, so decide early if flight distance is ever unbounded.
- **R6 — The seam's height step, and what the fade removes. Partly answered.** M5's inset is
  specified only for B4/B5, so B0/B1 keeps the overlap the snap produces: up to 2.25 m wide. The
  earlier sizing put train 5's 0.06 m between the two surfaces at the seam — 2.2 px at 45 m, and
  worse at grazing angles (a 0.06 m offset at 5° displaces the boundary ~0.7 m along the ground,
  ~8 px). That premise is wrong, and it is wrong by construction: M4's fade zeroes the dropped
  train at or before the seam, so at the canonical budget the two rows agree and the step is
  zero at every seam. What survives is that the fade is keyed to the **live** budget. On a device
  rendering finer than canonical (~6e-4 rad/px) the dropped train is still alive where its band
  ends: at 3e-4 rad/px train 4 lives to 333 m, so the b1/b2 seam at 171 m carries up to 0.10 m
  (~2 px), and b3/b4 at 396 m up to 0.24 m (~2 px). That is the whole residual.
  **Measured on 2026-11-05 (skim altitude, sea mounted, per-band displacement live, fragment
  colour replaced by flat green):** the surface is continuous across all five seams — no
  sky-coloured crack, no visible rim, and the double cover does not read at this angle. The
  bars that looked like seam defects in the shaded shots are the crest colour window
  (`smoothstep(0.38, 0.6, h)`, where h sums to ±0.89, so a whole crest saturates) — a
  provisional ramp value to eye-tune with the light terms, not a geometry fault. **Still
  unmeasured:** the finer-than-canonical budget. Closing that needs a device at rad/px < 6e-4,
  not a frozen frame, so the frozen-frame gate this risk used to carry is discharged.

## 11. Revision log

**rev 2** fixed rev 1's arithmetic (bands cut at visibility distances, not powers of two) and
removed the dither crossfade once shading became per-pixel.

**rev 3** (after adversarial review). Four further corrections:

1. **The pixel angle is per-frame, not a constant** (§5.1). Rev 2 froze `rad/px` at 1920 CSS
   px with a linear `fov/H` approximation. The projection is rectilinear (`2tan(fov/2)/H`),
   the canvas is capped at 995.6 CSS px tall, dpr is clamped differently with and without
   post, and `camera.fov` animates 60→69°. A frozen table was wrong by up to 2.4×.
2. **The sampling rule ignores wave direction** (§5.2). `λ/4` should be `0.205λ`; the
   existing `waves.test.ts` assertion is too loose for the same reason.
3. **The near field was over-specified** and is reallocated per D7 — train 5 is geometric
   only inside 45 m, and the saved triangles go to the mid-ground band.
4. **`scene.fog` was never decided** (M11). Its mauve would have met the sea's orange haze
   in a full-width seam.

**rev 4** (second adversarial pass, against the retuned table the code actually ships).
M5's ruling from rev 3 was right in direction and wrong in two facts:

1. **The sign of the residual, not its magnitude.** `floor` snapping on nested quanta makes
   the coarse hole edge land at or inside the fine outer edge *by construction* — the coarse
   origin is a multiple of the fine cell and `≤ v`. Rev 3 measured only that adjacent edges
   could differ by one quantum and assumed the difference could go either way, so it priced a
   blanket inset for five seams and a skirt to stitch them. Four of those seams cannot open at
   all; the fifth (B4/B5, 96 ∤ 36) can, in the `[−84, +24]` m range, and only there.
2. **The skirt was the wrong remedy even as a fallback.** With overlap ≥ 0 the seam has no
   exposed boundary to stitch; where a step does remain (B0/B1, 2.2 px) a vertical wall would
   manufacture the band edge A1 forbids, and the real remedy is M4's fade keyed to the band
   edge. So 4c is no longer a skirt task: it is one inset in `bands.ts:181`, an overlap
   assertion, and the B0/B1 frozen frame (R6).
3. **The band table in M2 was stale** — it still carried rev 2's 48/173/259/414/587/2048 and
   B5 = 128 m against the code's 45/171/252/396/576 and 96 m, which also contradicted M5's own
   `96:36 = 2.67:1`. Per-band triangle counts were likewise off for B0/B2/B3 (3.7/2.7/2.7k
   against a computed 3.2/3.4/2.3k) although the ≈23k total was right.
4. **R4's corner distance** followed the stale table; `1536·√2 ≈ 2172 m` still clips
   `camera.far = 2000`, so the risk stands with the corrected number.

## 12. Open questions

**None for the user.** D6 (900 m) and D7 (bottom strip occluded) closed the last two.

The remaining uncertainty is build-time: R1 needs frozen frames, R2 needs a device.
