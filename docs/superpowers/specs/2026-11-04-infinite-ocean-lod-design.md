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

Beyond 587 m the surface is **geometrically flat** — not cheap, flat. Every train's height is
under a pixel, so no triangle count improves it; what remains is the slope, which lives in
the normal.

## 6. My calls

- **M2 — Bands are cut at the visibility distances**, not at powers of two, because train 5
  stays visible out to 104 m and a doubling scheme would put 4–6 m cells there.

  | band | covers | cell | geometric trains | ~tris |
  | --- | --- | --- | --- | --- |
  | B0 | 0 – 48 m | 2.25 m | 1–5 | 3.7k |
  | B1 | 48 – 173 m | 4.5 m | 1–4 | 11.0k |
  | B2 | 173 – 259 m | 9.0 m | 1–3 | 2.7k |
  | B3 | 259 – 414 m | 18 m | 1–2 | 2.7k |
  | B4 | 414 – 587 m | 36 m | 1 | 1.0k |
  | B5 | 587 – 2048 m | 128 m | none (flat) | 1.9k |

  ≈ **23k triangles**. B0 ends at 48 m because D7 says the water closer than that is
  substantially covered; giving it full 2.26 m resolution over a 104 m radius would cost
  another ~13k for pixels the aircraft already owns. Train 5 is therefore **geometric only
  inside 48 m** and normal-only beyond — recorded as a deliberate consequence of D7, not an
  oversight.
- **M3 — Bands are square annuli built as four strips.** Nested full squares would overdraw
  the centre five times; on a mobile tiler that fill cost exceeds the triangles it saves.
- **M4 — Per-train distance fade in the vertex shader.** Weight reaches 0 at the train's
  distance from §5.3 **as computed from the per-frame `radPerPixel`**. The fade must start at
  least one band-width earlier, so no drop happens at a band edge.
- **M5 — Bands abut in their own frames; the world-space seam is spanned by deliberate
  overlap, never by alignment.** Every band's cell is a multiple of B0's 2.25 m (4.5 = 2×,
  9 = 4×, 18 = 8×, 36 = 16×), and the band table is retuned so each `inner` is an integer
  multiple of its own cell: the bands tile with zero overlap *in their own frames*. But each
  band tows on its own snap quantum (M6), so two neighbouring squares are **not concentric**
  and their shared edge is really two different world lines, up to one finer quantum apart
  (measured: 2.25 / 4.5 / 9 / 18 / 84 m; the b4/b5 residual is a multiple of 12 in
  [−84, +24]). Therefore the coarse band's hole is pulled **one cell inside** its `inner`.
  That makes overlap ≥ 0 at every camera position, so the unrecoverable direction — a gap of
  missing water — is structurally impossible. The price is up to two cells of double cover
  per seam, which is fill, not a visual defect.
  **This supersedes the earlier "zero overlap, exact skirt" wording, and it supersedes a
  rejected alternative: one shared tow origin for all bands.** A common origin snapped to
  2.25 m makes a coarse band's vertices sit at `O + k·cell` with `O mod cell` alternating
  between 0 and 2.25, so every coarse band's lattice slides by half its own cell as the
  camera moves — exactly the vertex swimming M6 exists to prevent. Aligning seams by that
  route trades a fill cost for a shimmer.
  The skirt that stitches the overlap must span **two** things, not one: the T-junction
  spacing (b0/b1…b3/b4 are 2:1, b4/b5 is 96:36 = 2.67:1) and a **height step**, because each
  seam drops exactly one train — 0.06 / 0.10 / 0.15 / 0.24 / 0.34 m across b0/b1 … b4/b5.
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
  `hypot(2048, 246) ≈ 2063 m`, which passes with more margin than the original had.
- **M13 — The cost of this design is justified by D3 and R1, not by §5.** §5 proves the LOD
  is *invisible*; it does not prove the triangles are *necessary*. A single ~700 m level at
  ~9 m cells plus per-pixel normals would render a nearly identical frame for half the
  triangles. What actually selects the expensive design is the user's one-step decision (D3)
  and the possibility that grazing-angle crest occlusion is visible (§10 R1). Stating it the
  other way round — as if the derivation demanded 23k triangles — would be dishonest.

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
snap origin, train set, inner skirt ring); an update step (snap, skirt, skip mask with
hysteresis, time uniform, `radPerPixel` uniform); the fragment side (exact-field height /
Jacobian / normal per pixel, `fog: false`); the low tier per M9 behind `world.setQuality`.

The TSL graph structure, fade curve, helper decomposition and skirt construction are the
builder's.

## 9. How we will know it worked

| What | How | Gate |
| --- | --- | --- |
| Angular uniform | unit test: `radPerPixel` from (fov, height) matches `2tan(fov/2)/H` | exact, and monotone in fov |
| Sampling rule | unit test per band | `cell ≤ 0.205 × shortest geometric λ`, direction-aware |
| Skip + hysteresis | unit test: altitude swept up and down | up-crossing and down-crossing differ by 20 m; no band toggles inside the dead band |
| Scene graph | node-build test | one mesh per band, stable names, no static webgpu import |
| Seam | frozen frames: 40 px strip across each band boundary, max |Δ| per row vs the 95th percentile 20 px inward | seam no sharper than the surface itself |
| No ring | edge map, 4 headings × 3 altitudes, closed contours around frame centre | none that a single-band reference render does not also have |
| Swimming | camera advanced 24 × 0.25 m, frame-to-frame mean |Δ| | under the same statistic on a stationary camera |
| Snap beat | 60 frozen frames across one L0/L1 beat period (6 m at cruise = 0.13 s) | no periodic modulation of the seam band above the frame noise floor |
| Budget | `__porco.qa.describe().render.triangles` | ≈23k at skim, ≈5k at ceiling |
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
  M5's stitching makes that a geometry-only change with no alpha, but whether the skirt's
  shape change is itself visible is unverified.
- **R4 — Far-plane clip.** B5's corner is at `2048·√2 ≈ 2896 m`, past `camera.far = 2000`.
  It is hidden today only because haze saturates at 900 m (D6). The claim "the far edge never
  exists on screen" therefore rests on the haze constants, not on geometry.
- **R5 — fp32 world coordinates.** The field is evaluated at absolute world base coordinates
  (C5). At ~1000 km the position quantum on a 2.25 m cell is ~2% and phase error reaches
  12 mm on train 1. Not a today-problem; the camera-relative retrofit touches every node in
  §8, so decide early if flight distance is ever unbounded.

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
   only inside 48 m, and the saved triangles go to the mid-ground band.
4. **`scene.fog` was never decided** (M11). Its mauve would have met the sea's orange haze
   in a full-width seam.

## 12. Open questions

**None for the user.** D6 (900 m) and D7 (bottom strip occluded) closed the last two.

The remaining uncertainty is build-time: R1 needs frozen frames, R2 needs a device.
