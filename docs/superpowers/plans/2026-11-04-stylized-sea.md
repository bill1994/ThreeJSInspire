# Stylized Sea Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the sea on `reconstruct` as a GPU parametric Gerstner wave field with Uber-Anime-style sunset shading, shore hooks dormant on an all-deep fallback.

**Architecture:** Pure-TS wave math (`src/sea/waves.ts`, fully unit-tested closed forms) feeds a TSL material (`src/sea/surface-material.ts`) that evaluates displacement as a pure function of base (pre-displacement) coordinates — Lagrangian by construction, so the old UV self-feedback bug is structurally impossible. Foam (`src/sea/foam.ts`) and depth hooks (`src/sea/depth-hooks.ts`) are separate rejectable layers. Sun glitter reuses `src/sun-road.ts` constants and helpers; no new sun math.

**Tech Stack:** three 0.186 TSL (dynamic import only), vitest 2, tsc strict. TSL idioms reference: `git show 5db7458:src/sea-fft.ts` (deleted implementation, same renderer version).

**Spec:** `docs/superpowers/specs/2026-11-04-stylized-sea-design.md` — the plan argues from it; executors read both. Uber reference clone (MIT): `G:\DSHProject\_refs\Uber-Stylized-Water`

> **⚠️ Task 3 and Task 6 are SUPERSEDED and already shipped — do not re-execute them.**
> The surface is no longer a single 1600 m mesh: it is six distance-driven bands on a shared
> lattice, because a uniform grid cannot serve a camera 13 m above the water at a 7 m skim.
> See `2026-11-04-sea-surface-lod.md` (plan, Tasks 5–6) and
> `../specs/2026-11-04-infinite-ocean-lod-design.md` (design, rev 3).
>
> **The file this plan names does not exist.** Task 3's `src/sea/shading.ts` was never created;
> the equivalent work shipped as **`src/sea/surface-material.ts`** under the LOD plan's Task 5.
> Any remaining task that says "modify `src/sea/shading.ts`" means that file — the paths below
> have been rewritten accordingly. Do not create a `shading.ts` now: it would fork the shader.
>
> **Tasks 1 and 2 are done; Task 4, 5 and 7 remain.** They are fragment work on top of whatever
> surface exists, so they run *after* the LOD plan's Tasks 1–6, which are also done.

### Brightness pass (2026-11-05, step 1 of the close-out)

**First, a correction to the Task 7 note above.** "Still ~20 L too bright against ref-01" compared
our whole water region against hand-picked *shadowed* water patches in the reference. Whole frame
against whole frame, our sea was never 40 L bright:

| | mean | p50 | sat | warm |
| --- | --- | --- | --- | --- |
| ref-01, whole frame | 124.1 | 116.7 | 0.420 | 58.7 |
| ours, before this pass | 124.9 | 143.7 | 0.477 | 48.1 |
| **ours, after this pass** | **118.2** | **135.0** | **0.498** | 47.6 |

So the frame mean is now *below* the reference and the median is still 18 brighter: we carry more
mid-brightness and less highlight headroom (ref p90 205 vs our 163). Same family, different shape.

**What was actually making it bright — ablated, not guessed** (each term zeroed, same frozen pose):

| term removed | frame L | delta |
| --- | --- | --- |
| foam | 116.9 | **-22.7** |
| glitter | 131.4 | **-8.2** |
| fresnel + reflection | 140.3 | ~0 |
| distance tint | 140.3 | ~0 |

Foam was the single largest brightener: near-white paper over ~8.5% of the water. The two ended
up costing nothing at this pose because the far field is a small slice of the crop.

**The changes, in that order of effect:** foam colour 0xfff0e2 → 0xd8b896 (warm cream, still
foam), glitter colour 0xfff2d6 → 0xffe3bd, band ramp shifted so the bright half is accents
rather than body (mid/lit/crest coverage 35.4/38.2/12.9 → 42.7/32.3/11.4), palette re-graded one
more step darker inside its L* gates, and the "no band owns half" test re-cut to a measured pair:
no band over 48%, deep+mid (the dark body) at least 45%.

Side effect worth knowing: SEA_PALETTE.foam is also the skim wake's tint (eel.ts), and
eel.test.ts pinned its red channel at exactly 1.0 — that assertion was really "the wake is
warm, not contrail blue", so it now asserts the relationship instead of a literal.
## Global Constraints

- `strict: true` — `npx tsc --noEmit` must exit 0 after every task.
- No static `three/webgpu` in the boot graph; sea modules load via dynamic `import()` (`module-graph.test.ts` stays green).
- Palette single-source: `SEA_PALETTE` keys and `SEA_PALETTE.haze === SKY_PALETTE.horizon` and `SUN_POSITION === [60, 35, -280]` pins in `palettes.test.ts` stay green.
- Post contract untouched: bloom threshold 0.82, K4 margin 0.063.
- Every task ends with its tests passing and a commit; full `npx vitest run` green before moving on.

## Review Focus

- R1 Low-tier ALU on a real mobile GPU has no automated test — Task 6 wires the tier switch, but the device run is a human gate; if it misses, drop to 2 trains via the `TRAIN_COUNT` uniform (no re-plan).
- R2 Far-field glitter convergence past ~400 m is judged by eye on frozen captures in Task 7, not by unit tests; the distance-tint endpoints are pinned but the middle is taste.
- R3 Real-depth behavior (terrain plugs a depth texture in later) is untestable now — Task 2 pins only the fallback dormancy and the interface shape; the terrain side re-opens this.
- R4 `?sea-debug=shape` must be harmless in prod: default off, and the debug view must never leak into the normal path (test in Task 6).
- R5 Crest HDR values may eat the bloom margin — Task 7 measures the margin on frozen captures and fails the task if it regresses past 0.063.

---

### Task 1: Wave math core

**Files:**
- Create: `src/sea/waves.ts`
- Test: `src/sea/waves.test.ts`

**Interfaces:**
- Consumes: nothing (pure math; `g = 9.81`).
- Produces: `TRAINS` (5 entries: `{ lambda, dir: [x, z] unit, amp, sharpnessQ, speed }`), `SEA_PATCH_SIZE = 1600`, `SEGMENTS_HIGH = 600`, `SEGMENTS_LOW = 300`, `LOW_TIER_TRAINS = 3`, `gerstnerField(x, z, t, trainCount) -> { y, ox, oz, nx, nz, jac }`, `finestWavelength(trainCount) -> number`, `combinedRms(trainCount) -> number`. The displaced surface point is `(x + ox, y, z + oz)` — `ox`/`oz` were missing from the first cut of this interface and are the chop that leans the crests..

**Decisions locked here (spec M1):** 5 trains, wavelengths `[180, 90, 45, 22, 11]`, directions = wind `[0.82, -0.57]` rotated by `[-12, -5, 0, 7, 15]` degrees, amplitudes `[0.34, 0.24, 0.15, 0.10, 0.06]` (combined RMS must land 0.30–0.36, continuity with the old 0.34 RMS sea), `Q ≤ 0.8` each, total slope `< 0.7`, speeds from deep-water dispersion `ω = sqrt(g·k)`. Mesh rule: `quad = PATCH / SEGMENTS ≤ finestWavelength / 4` for both tiers (600 → quad 2.67 ≤ 2.75; low tier drops the 2 shortest trains so λmin = 45, 300 → quad 5.33 ≤ 11.25).

- [x] **Step 1: Write the failing test** — `src/sea/waves.test.ts`: single-train closed form at `t = 0` (crest at phase 0: `y = A`, horizontal offset `= Q·A·dir`), `combinedRms(5)` in `[0.30, 0.36]`, total slope `< 0.7`, all dirs unit length, `finestWavelength(5) = 11`, segment rule for both tiers, time sweep `[0, 0.25, 3.7, 60, 1e4]` all finite, determinism (same inputs twice → identical), Jacobian `≤ 1` everywhere on a 40×40×4-time grid (no fold-overs at these Qs).
- [x] **Step 2: Run it to verify it fails** — Run: `npx vitest run src/sea/waves.test.ts`. Expected: FAIL with "function not defined".
- [x] **Step 3: Implement `gerstnerField` and constants in `src/sea/waves.ts`** — GPU-Gems-1 form per train with phase `φ = k·dot(dir, [x, z]) − ω·t`: `y += A·sin φ`, horizontal `+= Q·A·dir·cos φ`; analytic normal and Jacobian from the same phase terms (no finite differences).

```ts
// per train i, with k = 2π/λ, φ = k·(dx·x + dz·z) − ω·t:
//   y  += A·sin(φ)
//   ox += Q·A·dx·cos(φ);  oz += Q·A·dz·cos(φ)   // chop, leans the crest
// normal/jacobian accumulate the matching −k·A·cos / −k·Q·A·sin terms
```

- [x] **Step 4: Run the test to verify it passes** — Run: `npx vitest run src/sea/waves.test.ts` then `npx tsc --noEmit`. Expected: PASS, exit 0.
- [x] **Step 5: Commit** — `git add src/sea/waves.ts src/sea/waves.test.ts && git commit -m "feat(sea): parametric Gerstner wave math with closed-form tests"`.

> **Execution note (2026-11-04, post-review).** As first committed (`474e06c`), `gerstnerField`
> returned only `{ y, nx, nz, jac }`: the horizontal chop was never accumulated, only its
> derivatives. Every existing test stayed green because none of them read the offset, but
> Task 3 would have displaced the mesh in Y only — which is *exactly* the "有面无形" failure
> (anti-goal #1) that got the previous sea deleted. Fixed before starting Task 2: `ox`/`oz`
> are now returned and pinned by four tests (phase-origin offset `= Q·A·dir`, zero offset at
> the crest, the `Σ Q·A` bound, and a finite-difference check that the closed-form Jacobian
> really is the determinant of the displacement mapping). 244 → 248 tests.
>
> Two numbers worth keeping in mind downstream: `Σ Q·k·A ≈ 0.070` is both the worst-case
> error of the heightfield-normal approximation (`Ny` taken as 1) and the maximum crest
> compression (7%). The crest "lean" is therefore mostly a shading effect (Tasks 3–5), not a
> geometric one; raising `Q` for a harder lean spends the no-fold-over margin the Jacobian
> test guards.

### Task 2: Depth hooks (dormant shore interface)

**Files:**
- Create: `src/sea/depth-hooks.ts`
- Test: `src/sea/depth-hooks.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SEA_DEPTH_FALLBACK = 1` (all deep), `SHORE = { fadeNear, fadeFar, lineWidth, foamWidth }`, `depthTerms(depth01) -> { shoreFade, shoreline, intersection }` — pure functions of a 0..1 depth value so the TSL side stays thin.

**Decisions locked here (spec D1/G5):** all three shore terms are implemented but evaluate to exactly 0 at `depth01 = 1`; the future terrain side plugs a real depth texture behind the same interface without touching the sea.

- [x] **Step 1: Write the failing test** — at fallback `1`: all three terms `=== 0`; at `depth01 = 0`: `shoreFade === 1`, `shoreline > 0`, `intersection > 0`; monotonic in between; NaN input → all `0` (never poison the frame).
- [x] **Step 2: Run it to verify it fails** — Run: `npx vitest run src/sea/depth-hooks.test.ts`. Expected: FAIL.
- [x] **Step 3: Implement `depthTerms` in `src/sea/depth-hooks.ts`** — smoothstep gates only, no noise (noise lives in foam.ts).
- [x] **Step 4: Run the test to verify it passes** — Run: `npx vitest run src/sea/depth-hooks.test.ts` then `npx tsc --noEmit`. Expected: PASS, exit 0.
- [x] **Step 5: Commit** — `git add src/sea/depth-hooks.ts src/sea/depth-hooks.test.ts && git commit -m "feat(sea): dormant shore depth-hook interface"`.

> **Execution note (2026-11-04).** Landed as specified, 9 tests. Locked constants:
> `SHORE = { fadeNear: 0.04, fadeFar: 0.35, lineWidth: 0.06, foamWidth: 0.18 }` — ordered
> thinnest-to-widest and pinned by a test, because getting the order backwards reads as a
> wide grey smear at the shore. Two additions beyond the plan's test list: out-of-range
> depth is clamped (`depthTerms(-5) === depthTerms(0)`), and `±Infinity` is treated like
> NaN (dormant) rather than clamping to "deep", so a broken depth read can never paint a
> shore effect. `depthTerms` returns a fresh object per call — the dormant set is copied,
> not shared, so a caller that mutates its result cannot poison the fallback.
>
> Not wired to anything yet: `initWorld` has no sea and no depth texture, so the interface
> is exercised only by its tests. Task 4 will consume `depthTerms` through the foam mask;
> the terrain side re-opens this in a later plan.

### Task 3: Mesh + displacement + base ramp + crest tint — **DONE, under another name**

**Shipped as:** `src/sea/surface-material.ts` + `src/sea/surface-material.test.ts`
(LOD plan Task 5, commit `3faa054`; reviewed — no Critical/Important, 5 deferred Minors).
There is no `src/sea/shading.ts` and there should not be.

**Decisions from this task that survived verbatim:** displacement evaluates the Gerstner sum at
**base** coordinates (`modelWorldMatrix × positionLocal`) and never at the displaced position;
base ramp is height-driven (`deep → mid → lit` smoothsteps) with the crest tint applied before
foam (Uber order).

**What changed on the way:** the mesh is six bands, not one 1600 m plane (LOD plan); each band is
snap-towed on its own cell quantum instead of being slid tow-free; the per-train fade arrives as
a per-frame `uRadPerPixel` uniform; and the `debug: 'shape'` view was dropped — the bands can be
inspected with flat-green captures instead, which is what R6 actually used.

**Still true, and now tracked elsewhere:** the ramp stops are provisional
(`smoothstep(0.38, 0.6, h)` against a ±0.89 m field saturates most crests into horizontal bars).
That is LOD plan Next action 8, and it is gated on Task 5 below existing — do not guess it now.

### Task 4: Foam (Jacobian-driven, dissolving, graphic) — **DONE, with a caveat worth reading**

**Shipped:** `src/sea/foam.ts` (+ `src/sea/foam.test.ts`, 6 cases; suite 329 → 335), wired into
`src/sea/surface-material.ts` after the glitter add and before the distance tint. The Jacobian is
accumulated inside the same `gerstnerNodes` loop as the height and slope — the fragment already
pays for `sin` there, so the foam driver is nearly free.

**The caveat: the plan's `edge = 0.277` was dead code.** It is Uber-Anime's value, where the
sharpness Q is 3–4× larger. Measured on this field (5 trains, Q 0.5–0.7, 11–180 m), the Jacobian
over a 192×192 m sweep never falls below **0.9324**, so the maximum collapse gain is **0.0676** —
a 0.277 threshold puts the mask at exactly 0 everywhere, forever, while looking like a feature
that works. The threshold now sits inside the range the field can reach (`edge` 0.028,
`smooth` 0.012), and `collapseGain` is what the pure tests assert against.

**Two carriage returns' worth of tuning, recorded because the first answer was wrong:**
`edge` 0.03 at noise scale 0.35 painted **large soft white blobs** in the middle of swell faces;
0.045 made foam vanish entirely; 0.028 at noise scale 1.8 gives the fine speckle band that
ships. The look is foam *texture* concentrated where the surface pinches — not the hard graphic
foam lines of the Uber reference. That is honest: this field's J range is too shallow to make
lines, and getting them means raising Q, which trades against the no-fold-over guarantee in
`waves.test.ts`.

**Cost of the foam, measured on the same frozen pose** (foam is near-white over ~8.5% of the
water): L 119.0 → **142.0**, saturation 0.518 → **0.408**, warm 48.9 → 41.5.
`?alt=60` band occupancy is unchanged (27.3 / 44.7 / 10.8 / 17.2). So the foam reads, and it
costs brightness and saturation — the next pass has to decide which side of that trade to keep.


### Grain layer, final shape: baked normal map, two fetches (2026-11-05)

The noise version below was correct but expensive: three mx_noise_float taps cost **6x the
analytic field's per-pixel price** (water 2.25 -> 16.15 ms at 4096x7279), because MaterialX noise
is a procedural evaluation. Replaced with a **generated, tileable 512x512 normal map** sampled
twice at different scales and scroll directions — the reference's dual-sampling structure,
one fetch per sample instead of one noise evaluation.

The map is baked at material build time from the same kind of value noise, so there is still no
asset to ship and no UV seam to argue about with the six snap-towed bands; and the tests check
the very array the shader samples (tileability, decode range, variance) rather than a CPU mirror.

| | cost at 4096x7279 (interleaved, 7 cycles) |
| --- | --- |
| no grain | 2.25 ms |
| 3 noise taps | 14.0 ms |
| **2 map fetches** | **8.3 ms** |

40% cheaper, not free: texture sampling across ~13 M water pixels is still real work. Two more
findings worth keeping, both from looking rather than measuring:

- **256^2 faceted.** At 20-80 m one texel lands on roughly one screen pixel, and the sharp
  specular turns that into visible square facets. 512^2 with 14 noise cells fixed it; mipmaps
  matter for the far field (no mips = confetti at the horizon).
- **The slope budget is the sparkle knob, not a safety constant.** At 0.22 the water read as
  confetti; 0.14 reads as sun-glinted ripples. The bound is still a bound (it cannot flip the
  normal), but its value is a look decision.
### Grain layer — ACCEPTED: noise-gradient detail normals (2026-11-05)

The sine version below was rejected for being periodic. The replacement keeps the whole
contract and changes only the source: **three mx_noise_float taps** (centre, +x, +z) give a
forward-difference gradient, clamped to a slope budget and faded on the same angular budget as
the trains. No texture asset, no UV seam to argue about against the six snap-towed bands, never
displaces — the Gerstner field stays the only thing moving vertices.

Measured on the same frozen poses (water region):

| pose | grain (3x3 high-pass std) | bright>200 | L | sat |
| --- | --- | --- | --- | --- |
| alt 8, no grain | 3.93 | 0.085 | 142.0 | 0.408 |
| alt 8, noise grain | **7.90** | **0.114** | 139.6 | 0.416 |
| alt 60 | smooth mauve sheet → fine sparkle field | | | |

**It was accepted by looking, at 3x zoom**: the pattern is irregular blobs and glints, not the
sine version's lattice. The grain metric alone could not tell those apart — that is the lesson
from the rejection below, and it applies to this acceptance too.

**Cost, measured, and it is not free:** interleaved probe at 4096x7279 — water 16.15 ms vs
2.44 ms dry, **delta 14.0 ms**, against 2.25 ms before the grain. That is **6x the analytic
field's per-pixel price**: MaterialX noise is a procedural evaluation, not a texture fetch.
Scaled to the shipping buffer (about 1/56 of the water pixels) it is ~0.2 ms, still small
against 16.7 ms — but on a 10x-derated phone it is ~2 ms and no longer a rounding error. If that
matters first, replace the three taps with a real normal map (one fetch, needs an asset).
### Rejected attempt: procedural sine detail normals (2026-11-05)

After reading the reference clone (_refs/Uber-Stylized-Water, see below), the obvious gap was
grain: this surface is geometry-only, and 180 m swell at an 8 m camera fills the frame with
smooth colour. The plan was "geometry for the form, procedural normals for the grain" — five sine
trains at 7 / 4.3 / 3.1 / 2.2 / 1.7 m perturbing the analytic normal, faded on the same angular
budget (lambda / (2 * radPerPixel)), never displacing.

It worked mechanically and failed visually. Measured on the same frozen pose:

| | grain (3x3 high-pass std) | bright>200 |
| --- | --- | --- |
| no detail | 3.93 | 0.085 |
| 3 sine trains | 7.98 | 0.113 |
| 5 trains, irrational ratios | 7.19 | 0.108 |

Grain doubled and the sun road brightened, exactly as intended — but the picture reads as
**wallpaper**: the sine sum produces a standing interference lattice across the mid-field, and
warping the phase by the swell height (x0.35) did not break it. A sum of sines is periodic by
construction; the reference does not use sines, it samples a noise normal map twice from opposite
directions.

Reverted, because a visible periodic lattice is a worse artefact than flat water. Evidence frame:
rtifacts/archive/sea-detail-attempt/detail-sines-5trains-2026-11-05.png. The next attempt should
be a **noise-gradient normal** (three mx_noise_float taps, no texture asset) or a real normal map,
and it should be judged on whether the pattern is aperiodic — the grain metric above cannot tell
wallpaper from water, which is why this was caught by looking, not by the number.
**Also in this task:** the four band edges were narrowed (0.14 / 0.14 / 0.14 m windows instead of
0.18–0.26) toward "flat graphic layers", and `uDepth01` is wired to `depth-hooks.ts` and pinned
at the open-water fallback, so the shore foam is inert but connected.

**Files:**
- Create: `src/sea/foam.ts`
- Test: `src/sea/foam.test.ts`
- Modify: `src/sea/surface-material.ts` (wire the foam mask into the material after crest tint)
  — `src/sea/shading.ts` does not exist; see the banner at the top.

**Interfaces:**
- Consumes: Task 1 (`gerstnerField` Jacobian), Task 2 (`depthTerms`, fallback), TSL noise idiom (`mx_noise_float`, per deleted `sea-fft.ts` detail-bump usage).
- Produces: `foamMaskNode(...)` builder + `FOAM = { edge: 0.277, smooth: 0.098 }` (Uber-Anime start values; Task 7 eye-tunes).

**Decisions locked here:** foam driver = `(1 − J)` collapse gain plus a slow dissolve scroll; foam renders as a graphic hard-edge layer OVER the crest tint (never instead of it); shore-intersection term from Task 2 is wired but evaluates to 0 on the fallback (test pins dormancy through the real material).

- [ ] **Step 1: Write the failing test** — `foamMask` at `J = 1`, deep fallback, `t = 0` is `0`; at `J ≤ 0.25` with matching scroll phase is `> 0.5`; NaN Jacobian → `0`; material built with fallback depth shows zero intersection contribution (assert via the composed node output value, not pixels).
- [ ] **Step 2: Run it to verify it fails** — Run: `npx vitest run src/sea/foam.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `foamMaskNode` in `src/sea/foam.ts` and wire into `surface-material.ts`** — two scroll speeds (detail + dissolve, Uber UVPannerDistorted pattern: different directions, ratio ≈ 1 : 2.7); hard edge via narrow smoothstep (width = `FOAM.smooth`). The Jacobian the mask wants is already computable from the same phase terms `gerstnerNodes()` builds — reuse them, do not add a second evaluation.
- [ ] **Step 4: Run the test to verify it passes** — Run: `npx vitest run src/sea/foam.test.ts src/sea/surface-material.test.ts` then `npx tsc --noEmit` then full suite. Expected: PASS, exit 0, green.
- [ ] **Step 5: Commit** — `git add src/sea/foam.ts src/sea/foam.test.ts src/sea/surface-material.ts src/sea/surface-material.test.ts && git commit -m "feat(sea): Jacobian-driven graphic foam with dissolve"`.

### Task 5: Sun glitter, tinted fresnel, distance tint, analytic sky reflection — **DONE**

**Shipped in** `src/sea/surface-material.ts` (+ `src/sea/surface-material.test.ts`, 8 new cases;
suite 314 → 322). Evidence frame pair: `artifacts/sea-audit/light-before-2026-11-05.png` vs
`light-after-2026-11-05.png`, same camera and frozen step count.

**Execution note (2026-11-05, post-verification).** What the frame actually shows, measured
rather than eyeballed, over the water region of that pair:

| | L* | saturation | warm (r−b) | bright>200 |
|---|---|---|---|---|
| before | 109.0 | 0.460 | +8.6 | 0.0000 |
| after | 119.7 | 0.409 | +12.6 | 0.0068 |

So: warmer and glitter appears, but the water got **11% less saturated** and the glitter is a
single tight cluster (1171 px, localised to one 60-px column band — a road, not speckle).
Two things for Task 7 to answer, not to assume: the fresnel + distance tint wash the bands
(the regrade has to claw that back), and the road is one small patch rather than the design's
"warm gold road + flowing sparkle".

**Cost, measured before/after with the fixed probe** (`eval-perf-webgpu.js`, 7 interleaved
cycles ×3 runs, 4096×7279): **1.10 → 2.25 ms**, i.e. ×2.05. Design M10 guessed 3×. Scaled to
the shipping buffer that is ~0.04 ms; R2 (no phone has been measured) stays open.

**One implementation decision worth keeping:** the analytic normal is accumulated inside the
same `gerstnerNodes` loop as the height, from the same phase term, so the fragment pays one
`cos` per train and not a second field evaluation. A separate normal pass would have doubled
the transcendentals for identical output.

**Files:**
- Modify: `src/sea/surface-material.ts` (the light terms; `src/sea/shading.ts` does not exist)
- Test: `src/sea/surface-material.test.ts` (extend)

**Interfaces:**
- Consumes: `SUN_ROAD` constants + `sunRoadGain / slope01 / specExponent / fresnel01` from `src/sun-road.ts` (reuse as-is — no new sun math), `SEA_PALETTE.glitter / haze`, `SKY_PALETTE.horizon`.

**Decisions locked here:** glitter = `sunRoadGain` composition with Uber's size/spread/hardness mapped to (sparkle scale, exponent range, edge width); fresnel tinted toward sunset mauve (not white); far field = `mix(color, haze, smoothstep(150, 900, dist))` (Uber distance-tint pattern at our scale; numbers eye-tuned in Task 7); reflection is analytic — `mix(deepColor, horizonColor, pow(1 − reflDir.y, k))` — no mirror pass, no planar reflection, ever.

- [ ] **Step 1: Write the failing test** — glitter gain is `0` outside `SUN_ROAD.WIDTH_DEG` azimuth (via `sunRoadGain` composition); fresnel at grazing `> 0.5` and tinted (output hue ≠ white — assert `r > b`); distance tint at 0 m is identity and at 2000 m is pure haze; reflection at straight-down view is deep color, at horizon is horizon color. Test through `materialUniforms()` / the same pure-TS mirrors `surface-material.test.ts` already uses — the existing suite builds the real TSL graph in node, so this stays GPU-free.
- [ ] **Step 2: Run it to verify it fails** — Run: `npx vitest run src/sea/surface-material.test.ts`. Expected: FAIL on the new cases.
- [ ] **Step 3: Implement the light terms in `src/sea/surface-material.ts`** — constants passed as TSL uniforms (same numeric values as `SUN_ROAD`, single-sourced via import). Note the normal is analytic in `waves.ts` (`gerstnerField` returns it); this is where it finally gets wired, and it doubles the fragment transcendentals — the 37 ns/1000 water px price in `artifacts/sea-audit/fragment-cost-2026-11-05.md` is the number to re-measure afterwards with `eval-perf-webgpu.js`.
- [ ] **Step 4: Run the test to verify it passes** — Run target file, `tsc`, full suite. Expected: PASS, exit 0, green.
- [ ] **Step 5: Commit** — `git add src/sea/surface-material.ts src/sea/surface-material.test.ts && git commit -m "feat(sea): sun glitter, tinted fresnel, distance tint, analytic reflection"`.

### Task 6: Integration — world, far-field tow, boot label, frozen literals — **DONE, one decision reversed**

**Shipped as:** LOD plan Task 6 (`f0e44f3`, review fixes `7d0c2c0`).

**Held:** `initWorld` awaits the sea and throws on failure (and, after the review, builds *all*
bands before mounting *any*, so a partial build cannot leave stray meshes behind a "sky only"
log); `setQuality(false)` reaches the sea; the boot label reads `sky + sea + puffs`;
`HORIZON.HAZE_FAR` moved 520 → 900 and `horizon.test.ts`'s frozen 600 m literal became
`hypot(2048, ALT_MAX + CAM_HEIGHT)`.

**Reversed:** *far-field does not tow the sea.* Each band snap-tows itself toward the camera on
its own cell quantum, and `far-field.test.ts` now asserts the sea is **absent** from `followed`.
The "no snap, the field is world-anchored so sliding moves no wave" argument was right about the
field and wrong about the geometry: a single unsnapped mesh slides its vertex lattice through
world space and the displacement visibly swims. Snapping per band is what makes the lattice
stable, and it is why the LOD plan needed the nested-quantum seam ruling at all.

**Dropped:** `?sea-debug=shape`. The band surface is inspected with flat-green captures
(what R6 used); a debug branch that never shipped is not owed to anyone.

### Task 7: Palette grading + frozen capture + visual gates — **PARTLY DONE**

**Shipped:** a re-graded `SEA_PALETTE` (chroma up, L* down), the band ramp lifted out of the
builder into exported `SEA_RAMP`, a structural fix to the haze range, and 7 new tests (suite
322 → 329). **Not shipped:** the look is not there yet — see the residual below.

**Execution note (2026-11-05).** Measured on the same frozen pose (`?alt=8&qa=frozen&post=0`,
40 steps), water region, mean over the centre third of the frame:

| frame | L | saturation | warm (r−b) |
|---|---|---|---|
| pre-Task 5 | 109.0 | 0.460 | +8.6 |
| post-Task 5 | 119.7 | 0.409 | +12.6 |
| **post-Task 7** | **119.0** | **0.513** | **+48.9** |
| ref-01 (target, water patches) | 89–100 | 0.37–0.47 | +16…+56 |

So the grade bought back the saturation the light terms cost (+25%) and put the water in the
reference's warm family, at unchanged brightness — but it is still ~20 L too bright against
ref-01, and at neither the skim pose nor `?alt=60` does the water read as water: no visible
crest lines, and the sun road no longer reaches the 200 threshold.

**Three findings that outlived the tuning, worth more than the numbers:**

1. **The haze range was the real flattener, not the palette.** `DISTANCE_TINT` started at
   150 m, which at an 8 m camera means most of the visible water was already one flat orange.
   It now runs 600 → 2000 m, matching `camera.far`; the horizon contract is unaffected because
   the sea is fully hazed by 2000 m either way. This was worth ~16 L on its own.
2. **The plan's screen-occupancy gate cannot be measured at the skim pose.** k-means
   classification of `?alt=8` gives one cluster 0.88–0.91 of the sea region *on all three
   frames* — pre-Task-5 included — because a single 180 m swell face fills the view. The metric
   only says something at `?alt=60`, where the fixed-palette classification reads
   29.2 / 39.3 / 13.9 / 17.6 (deep/mid/lit/crest, all > 5%). Gate passes there; it says nothing
   at 8 m.
3. **Analytic ramp coverage is a necessary condition, not the gate.** A balanced 13.6 / 35.4 /
   38.2 / 12.9 on the *unshaded* ramp did not survive into a balanced frame, because fresnel and
   the distance tint sit on top. `surface-material.test.ts` keeps it as a cheap structural
   guard (each band ≥ 5%, none > 40%, crest ≥ 7%) and the frame numbers above are the real gate.

**What is left, in order:** the water needs its crest structure back — that is Task 4's foam and
harder band edges, not more palette work; then the R1/R2 device pass. Do not re-grade the
palette again before those land; the stops are already at the field's resolution limit
(±0.86 m of height carrying four bands).

**Files:**
- Modify: `src/palettes.ts` (`SEA_PALETTE` mid/lit/crest re-grade only), `src/palettes.test.ts` (L* ordering), `src/sea/surface-material.ts` + `src/sea/foam.ts` (eye-tuned stops/edges)

**Interfaces:**
- Consumes: everything above; the preimage workflow for authoring screen targets —
  `artifacts/ghibli-audit/solve-ramp.py` (inverts NeutralToneMapping for a rendered colour)
  and `artifacts/ghibli-audit/measure-bands2.py` (screen colour for a material colour).
  Note: an earlier draft of this line named `artifacts/cloud-audit/tonemap_unfold.py`; that
  file never existed — `solve-ramp.py` is the real tool, it just lives under `ghibli-audit`.
  Also the frozen QA rig (`?qa=frozen`, `?pos=`).

**Decisions locked here:** keys, `haze`, and `SUN_POSITION` do not move (Global Constraints); only values change. Crest tint moves cyan → warm (sunset-anime, spec M3). Stops/edges tuned until: bands read as flat graphic layers (no muddy mid), crest line present but unbroken, glitter dense on the road and gone off-road, foam graphic not noisy.

- [ ] **Step 1: Write the failing test** — `palettes.test.ts`: L* ordering `deep < mid < lit < crest` with gaps `≥ 4`; `mid` warmer than the old `0x6c536b` (assert `r > b`); frozen-capture band occupancy re-cut for the new look (deep/mid/lit/crest bands each `> 5%` of sea pixels — the old FBM failure was crest 0.1%, never again); bloom margin on captures `≥ 0.063` (R5).
- [ ] **Step 2: Run it to verify it fails** — Run: `npx vitest run src/palettes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Re-grade + tune** — preimage screen targets through the tone-map unfold, update palette + stops + foam edges, capture frozen states, iterate to the gates. The occupancy gate is measured with
  `python artifacts/sea-audit/band_continuity.py <shot.png> --mpp <m> --wind-screen dx dy`
  (png mode only — its `--recompute` half died with the FFT sea, see `artifacts/sea-audit/README.md`).
  **Re-grade the palette first, then re-copy `PALETTE` into that script**: it hardcodes the four
  band colours, and a stale copy reports `validFraction ≈ 0` instead of failing loudly.
- [ ] **Step 4: Run the test to verify it passes** — Run target file, `tsc`, full suite. Expected: PASS, exit 0, green. Human visual gate: reviewer confirms the look (R1 device run + R2 far glitter judged here).
- [ ] **Step 5: Commit** — `git add src/palettes.ts src/palettes.test.ts src/sea/ && git commit -m "feat(sea): sunset-anime palette grade and tuned stops"`.

## Self-Review

1. Spec coverage: G1 → Tasks 1+3 (chop in `gerstnerField`, M1). G2 → Tasks 3+4+5 (ramp, crest-before-foam, hard glitter). G3 → Task 5 (sun-road reuse). G4 → Tasks 1 (tier rule) + 6 (switch) + R1 human gate. G5 → Task 2. Non-goals respected: no caustics/underwater/refraction task exists. Anti-goals: sliding slabs → world-anchored test (Task 3); sparkle convergence → R2 gate + distance tint (Task 5/7); self-feedback → impossible by construction + determinism test; PBR creep → no PBR task. C4 Lagrangian → Task 3 displacement rule + test.
2. Step scan: each code step names the file, signature, and spec-pinned values; bodies appear only where the signature underdetermines the algorithm (Task 1 Gerstner accumulation). No TBDs.
3. Type consistency: `gerstnerField(x, z, t, trainCount)` used identically in Tasks 1/3/4; `initStylizedSea(scene, opts?)` handle shape (`object/update/setQuality/dispose`) identical in Tasks 3/6; `depthTerms(depth01)` in Tasks 2/4; `followed: { sky, sea }` in Task 6 matches existing `followed: { sky }` extension.
4. Review Focus: R1 → Task 6 + human gate in Task 7; R2 → Task 7 gates; R3 → Task 2 interface test (documented limit); R4 → Task 6 default-off test; R5 → Task 7 margin test. None empty.
5. Proportion: spec ~150 lines, plan ~200 — the bulk is decisions (values, names, gates), not bodies. Foam and light stay separate tasks because each is independently rejectable in review.
