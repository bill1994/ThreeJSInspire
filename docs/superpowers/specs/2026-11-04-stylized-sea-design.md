# Stylized Sea Rebuild — Design

Date: 2026-11-04. Branch: `reconstruct` (sky + puffs live baseline, FFT sea and
dome clouds deleted). Author: 小澄. Status: user opted out of brainstorming
questions — every open point below is **my call**, marked as such. Correct me
and I will re-cut.

## 1. Intent and why

The FFT spectral sea failed visually, not numerically: Y-only displacement made
it "有面无形" (soft sliding slabs), the 96-exponent glitter binarized into
碎钻 sparkle, and the hue had to be rescued by a post-hoc preimage. The user
wants: **visible waves, anime-style shading, sun glitter on the water**.
Reference: `MatrixRex/Uber-Stylized-Water` (MIT, cloned to
`G:\DSHProject\_refs\Uber-Stylized-Water`) — a Shader Graph layer stack with 8
style presets. Its Anime preset (vertex waves OFF, flat bands + graphic foam +
hard glitter) is the closest loved prior art; the deleted FFT sea is the
anti-reference.

## 2. Goals / non-goals / anti-goals

Goals:

- G1 Visible wave forms: swell trains with chop (leaning crests), not flat plane.
- G2 Anime shading: flat deep/shallow bands, crest tint BEFORE foam, graphic
  hard-edge foam, hard glitter, tinted fresnel.
- G3 Sunset sun-road: warm gold road + flowing sparkle, dyed by the sunset sky.
- G4 60 fps on high tier, honest low tier on mobile (fewer trains, no foam
  distortion scroll).
- G5 Depth hooks from day one: shore fade + shoreline + intersection foam stay
  dormant on an "all deep" fallback until procedural terrain plugs a depth
  texture in. Sea first, terrain later, handshake via depth.

Non-goals (explicitly out, no hooks): caustics, underwater layer, refraction.

Anti-goals (failure even if it renders): sliding-slab motion with no per-wave
travel; circular sparkle convergence in the far field; any sampling that reads
post-displacement coordinates (the old self-feedback bug); PBR realism creep.

## 3. Constraints (inherited, non-negotiable)

- C1 Mobile low tier must run: every new cost has a low-tier cutoff.
- C2 Post contract: bloom threshold 0.82, K4 margin 0.063 untouched.
- C3 Palette single-source (`palettes.ts`); dual-backend TSL via dynamic import
  only; no static `three/webgpu` in the boot graph (`module-graph.test.ts`).
- C4 Lagrangian rule (old plan §0.4): displacement and sampling both use
  pre-displacement coordinates.

## 4. Decided (user + prior conversation)

- D1 Uber layer subset, adapted: depth-color ramp (driven by wave height now,
  scene depth later), crest tint, surface foam + distortion scroll, 2-way normal
  detail, Phong-ish toon bands, specular with spread/hardness/size, tinted
  fresnel, analytic sky reflection (NOT planar — no mirror pass), distance tint
  for the far field, Gerstner trains with sharpness.
- D2 Anime preset numbers are the starting point, re-graded to sunset:
  crest tint cyan→warm, specular HDR white→gold, fresnel tint purple→sunset
  mauve, foam edge 0.277 / smooth 0.098.
- D3 Sky, puffs, plane, post, HUD untouched.

## 5. My calls (user authorized, challenge freely)

- M1 **Parametric Gerstner, not FFT.** 4–6 GPU-evaluated trains with analytic
  normals + Jacobian. Why: art-directable (sharpness, direction, crest tint),
  no CPU upload, Lagrangian by construction (displacement is a pure function of
  base coords — self-feedback is structurally impossible). Cost if wrong: swell
  looks less "oceanic" than spectral sum; fix by adding trains, not by going
  back to textures.
- M2 **Motion design.** Long trains travel along wind dir (phase advection);
  detail normals + foam masks scroll at 2–3 different speeds/directions (Uber
  UVPannerDistorted pattern); crest foam grows/shrinks with Jacobian collapse
  plus a slow dissolve scroll; glitter flows with the normal field. No physical
  dispersion claim — it is drawn motion, judged by eye. Cost if wrong: looks
  "sliding" again; fix with scroll-speed ratios, which are uniforms.
- M3 **Sunset-anime variant, not a preset copy.** No tropical cyan water; the
  palette stays in the ref-01 warm-mauve family.
- M4 **Far field = distance tint + analytic normal fade**, not mipmapped FFT
  textures. The old circular-sparkle failure mode disappears with the textures
  that caused it; if sparkle still converges, the fix is glitter footprint
  scaling, a uniform.
- M5 New module is `src/sea/` (fresh directory: `waves.ts`, `shading.ts`,
  `foam.ts`, `depth-hooks.ts`) — the old filenames stay deleted so no stale
  import can resurrect.

## 6. Left to the plan/builder

- Exact train count per tier, scroll ratios, foam edge numbers (eye-tuned
  against frozen captures, same QA rig: `?qa=frozen`, `?pos=`, band-occupancy
  gates re-cut for the new look).
- Depth-hook interface shape (texture slot + fallback constant) — must not
  block terrain work later.
- Test contract: unit tests for wave math (Gerstner closed-form, Jacobian
  sign), graph guard unchanged, frozen-frame occupancy gates for bands/glitter.
- Removal of the frozen-number literals in `horizon.test.ts` / `in-cloud.test.ts`
  when real constants land.

## 7. Builder check (self-review, no subagent tool in this env)

Read as the builder: the doc answers what/why/limits; every number a builder
needs is either here (§4-D2) or explicitly eye-tuned later (§6). No "theirs"
pile — user waived questions; all open points are M-calls above. One risk
flagged for the plan: Gerstner normals at 4–6 trains on the low tier need a
measured ALU budget, not a guess.
