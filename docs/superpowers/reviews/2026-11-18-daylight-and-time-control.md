# Daylight, night shading and time control — 2026-11-18

## Behaviour

The existing `+ UI` panel now contains a 00:00–24:00 slider with one-minute steps and four shortcuts: 07:00, 12:00, 17.59 h and 00:00. Slider input changes the live time-of-day state immediately. It clears fixed palette/debug overrides and releases the sea-haze lock so the authored full-day palette is visible. Interaction stays within the HUD and does not steer the aircraft. Normal flight and frozen QA pages both support the control; frozen previews render a bounded, coalesced sequence of real frames to refresh frame-scoped uniforms.

This change does not enable automatic time progression. `todspeed` remains reserved; selecting a time holds that time.

## Appearance

- Noon sky: pale blue-green horizon, clear blue upper sky (`#c2dcd9`, `#91c4d5`, `#629bc0`, `#4b83af`). Clouds use cool blue-grey shadows and warm ivory highlights. Intermediate daytime keys interpolate from the unchanged evening reference.
- Above the reference sunset elevation, the sky gradually stops multiplying the palette by the per-channel sunset-normalised scattering ratio. By 20 degrees the authored palette dominates, removing the green horizon/dark-blue noon artefact. JS haze calculations and GPU sky/reflection calculations use the same transition.
- Night: cloud bands, ambient/key lighting and in-cloud veil use a coherent cool family. The aircraft and puff key light move continuously toward the sky's antipodal moon, with a nonzero overhead direction through dusk.
- Sea: water and foam have separate night illumination factors; the warm sun road switches off below the horizon. A restrained cool reflection follows the moon direction. Haze still converges to the live sky colour. Both legacy and painted sea materials consume the same lighting transition.
- The accepted sunset palette and sea illumination remain at their reference values. No wave geometry or scattering layout changes are part of this iteration.

## Cloud update responsiveness

A large time change now increases the strip budget of an already-running slow background-cloud bake. The current complete snapshot still finishes before the pending one, preserving atomic publication and avoiding starvation during continuous edits. Slow ordinary light movement retains its low budget.

Frozen previews must yield real frames between steps: batching all preview steps in one input handler left frame-scoped cloud uniforms at old values despite the new sky colour. The time control now schedules and coalesces 12 preview frames.

## Validation

808 tests across 73 files passed, including reference sunset identity, bloom budgets, noon hue/luminance, finite day-to-moon light directions and a slow cloud cycle interrupted by a time jump. Build and smoke checks passed; existing bundle-size warnings remain.

Real WebGPU controls were exercised with mouse drag, shortcut clicks, Home/End/ArrowLeft keys, fixed-palette override removal and low quality. The panel fits a 360×640 viewport. Noon and night screenshots were visually checked after cloud updates completed; browser logs reported no errors.

Local ignored evidence: `artifacts/daylight-ui-final-2026-11-18T08-37-20-317Z`. Earlier `08-34`/`08-35` captures documented the frozen-preview bug and are superseded.
