# Puff distant scatter — 2026-11-18

The active far-field loop still used the old encounter-gate experiment: every 10 seconds it could relocate a trailing cloud into a slot only 200–400 m ahead. The destination was not fully obscured, and its fade uniform was evaluated before relocation. This produced visible arrivals unrelated to natural flight through the random field.

Removed encounter-gate scheduling from the flight loop. Clouds now start in a 950–1250 m horizontal ring around the actual initial camera, with at least 850 m clearance to their horizontal bounding footprint after jitter. Width and depth participate in placement clearance without changing the existing in-cloud interaction bounds.

The recycling window is 2800 m wide. Clouds fade radially from full opacity at 1000 m to zero at 1400 m; recycling occurs at the distant window boundary. Radial fade is consistent when turning or flying diagonally. Already placed clouds remain world-anchored until they reach the boundary, so approaching and flying through them still works. Large camera discontinuities re-establish the distant ring instead of wrapping a cloud onto the camera.

This is not the future scene fog. Existing cloud colour haze remains unchanged. The 1000–1400 m fade band provides a place to overlap that fog later. The wider field and removal of forced encounters intentionally make the immediate surroundings more open; cloud encounters are no longer guaranteed every 10 seconds.

Validation:

- 805 tests across 72 files, production build and smoke check passed. Existing bundle-size warning remains.
- Regression tests cover jittered full-footprint clearance across 50 seeds, cardinal/diagonal recycling, turning, old gate intervals, non-origin starts and camera teleports.
- Actual WebGPU volume scene placed 20 clouds; initial cloud centres were 981–1232 m away and minimum footprint clearance was 942 m.
- A 6.5 km simulated camera path through the live scene objects produced 68 recycling moves. Nearest landing was 1399.92 m; maximum fade on either side of a move was 0.000000122. Existing clouds could be approached to within 0.04 m without being pushed away.
- Rendered approach captures at 1200, 1000, 800, 300 and 0 m; no browser errors. Local ignored evidence: `artifacts/puff-scatter-final-2026-11-18T08-15-12-572Z`.
