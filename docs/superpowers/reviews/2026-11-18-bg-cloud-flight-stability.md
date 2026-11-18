# Background cloud flight stability — 2026-11-18

## Cause and change

The previous 250 m rebake moved both the cloud layout and its observer, preserving their relative geometry, but sampled billow noise, underside variation and radial lighting in translated world coordinates. Flying therefore changed the rendered cloud rather than providing consistent parallax. Rebuilding strips directly in the displayed cube also exposed incomplete lighting updates.

The distant cloud layout now bakes in its canonical camera-relative frame at `(0, 70, 0)`. Translation no longer invalidates it. This retains the existing distant-background design; it does not add world-anchored cloud parallax. View rotation still changes which part of the sky is visible.

Lighting, palette and diagnostic inputs are frozen per bake cycle. A private staging cube is copied into the stable public texture only after all 40 strips finish. Changes arriving during a cycle wait for the following snapshot. Slow daylight motion retains a one-strip-per-frame budget; large light changes use up to eight. Both cube targets are disposed. This costs one additional cube render target while removing translation-triggered rebakes.

## Verification

- Real WebGPU fixture: camera positions `(0,70,0)`, `(249,70,0)`, `(251,70,0)`, `(1000,70,-1000)`, `(2000,400,-3000)` and `(20000,70,-20000)`, fixed viewing direction and light. No translation-triggered publication; clouds visually stable.
- Image comparison excluding the fading HUD: before-fix mean RGB differences at positions beyond the threshold were about 0.46–0.62 on a 0–255 scale; after-fix differences were below 0.0002 (minor far-coordinate raster precision).
- Real GPU lighting/palette change queued mid-cycle: the first snapshot publishes on frame 5, the pending snapshot on frame 10; frames between publications remain identical. No browser errors.
- Integration regression covers translation, complete publication, queued inputs, continuous lighting, two slow-light cycles, visibility pause/resume, viewport restoration and disposal.
- Full suite: 803 tests across 72 files passed. Production build, smoke check and whitespace check passed. Existing bundle-size warning remains.
- Flight playback and sea lab passed without browser errors. Previous sea appearance changes remain intact.

Local evidence (ignored artifacts): `artifacts/bg-stability-before-2026-11-18T07-08-12-387Z`, `artifacts/bg-stability-after-2026-11-18T07-10-32-561Z`, `artifacts/bg-stability-queued-2026-11-18T07-19-36-465Z`, `artifacts/sea-live-2026-11-18T07-14-45-083Z`, `artifacts/sea-lab-2026-11-18T07-15-27-002Z`.

Whole-image publication is not a crossfade: actual light or palette changes can still change the cloud shading. The fix addresses unintended flight-driven morphing and partially updated images.
