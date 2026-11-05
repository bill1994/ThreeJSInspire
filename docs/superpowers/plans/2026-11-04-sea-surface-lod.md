# Sea Surface LOD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the deleted FFT sea with a banded, distance-driven Gerstner surface that is invisible at every LOD boundary and holds ~23k triangles on a mid-range Android.

**Architecture:** Pure-TS band and angular-budget tables (`src/sea/lod.ts`) size the geometry once; a per-frame `radPerPixel` uniform drives the per-train displacement fades so the LOD tracks fov and drawing-buffer size. Geometry is six square annuli on a shared 2.25 m lattice, whose seams are made safe by nested snap quanta plus one inset at b4/b5 (no skirt, no discard, no dither), towed per band with a snap quantum equal to that band's cell.

**Tech Stack:** three 0.186 TSL (dynamic import only), vitest 2, tsc strict. TSL idioms reference: `git show 5db7458:src/sea-fft.ts`.

**Spec:** `docs/superpowers/specs/2026-11-04-infinite-ocean-lod-design.md` (rev 3). The shading look is specified by `2026-11-04-stylized-sea-design.md`. Executors read all three.

## Status — resumed here (2026-11-05)

**The sea is built but not yet visible: nothing mounts the bands, and no material exists.**
`initSeaBands` is called only from `bands.test.ts`; `world.ts` and `main.ts` import no sea
module. Running the game still shows sky + puffs.

| Task | State | Commit |
| --- | --- | --- |
| 1 — band table + per-frame angular budget | done | `e4eebf5` |
| 2 — six band meshes + per-band snap tow | done | `e4a8e52` |
| 3 — visibility mask + 10 m hysteresis | done | `8af9e60` |
| 4a — square annuli + closable inner hole | done | `2fe2537` (+ 3 fix rounds) |
| 4b — band table retuned so `inner` is a whole number of cells | done | `cb9489f` |
| 4c — hole inset at b4/b5 + overlap proof (no skirt) | done | `c53e5a0` |
| **5 — displacement, base ramp, crest tint** | **done** | `3faa054` (review: no Critical/Important, 5 deferred Minors) |
| **6 — world wiring, boot label, haze 900** | **not started** | — |

Gates after Task 5: `tsc --noEmit` exit 0 · `vitest run` 32 files / 305 tests green ·
`smoke ok` · tree clean.

### Rulings that bind the remaining work

- **The seam is safe because the quanta nest, not because anything is stitched** (design M5,
  rewritten a second time after the review below). With `floor` snapping, the coarse origin is
  a multiple of the fine cell and `≤ v`, so when the coarse cell is a multiple of the fine one
  the coarse hole edge lands *at or inside* the fine outer edge — overlap `∈ [0, c_c − c_f]`
  at every camera position, and no gap is possible. Four seams are in this case.
- **Exactly one seam can lose water: b4/b5**, because 96 is not a multiple of 36. Measured
  residual `[−84, +24] m` per axis, so the hole edge there moves from 576 m to **480 m**
  (`inner − cell`). Nothing else gets an inset.
- **There is no skirt.** Overlap buries the coarse band's inner edge, so there is no exposed
  boundary to stitch; where a height step survives (b0/b1 only) a wall would be a 2.2 px
  crease — that one is a **fade** fix (Task 5), not geometry.
- **Do not claim the seam is gap-free in world space, and do not claim the overlap is free.**
  It is bounded absolute overlap per seam (2.25 / 4.5 / 9 / 18 m, 72–180 m at b4/b5), and the
  double cover is only sub-pixel where the dropped train is: b4/b5 0.98 px, b3/b4 1.01,
  b2/b3 0.99, b1/b2 0.97 — but **b0/b1 is 2.2 px** and needs R6's frozen frame.

### Next actions, in order

1. ~~Adversarial review of the M5 overlap ruling before building 4c.~~ **Done 2026-11-05**
   (this revision). It found the ruling right in direction, wrong in two facts: the residual's
   *sign* is fixed by `floor` + nesting, so four of five seams cannot open; and a skirt is the
   wrong remedy, so 4c is an inset plus a proof, not a mesh.
2. ~~**4c** — derive the inset, push b4/b5's hole edge to 480 m, assert overlap ≥ 0.~~ **Done
   `c53e5a0`.** `holeEdgeFor(band, prevCell)` derives the cut from the table
   (`cell % prevCell !== 0`), b5 cuts at 480 m, four new tests pin it — 31 files / 293 tests.
3. **R6 is still open and 4c cannot be called finished by unit tests alone** — one frozen
   frame at skim altitude across the b0/b1 rim (40 px strip, M5's numbers); if the 2.2 px rim
   is visible, bias the coarse band's depth in the overlap. The Task 5 material exists
   (`3faa054`) but nothing mounts the bands yet, so the frame waits on Task 6's mount or a
   spike harness — whichever comes first.
4. ~~**Task 5** — `src/sea/surface-material.ts`, per-pixel exact field.~~ **Done `3faa054`,
   reviewed: no Critical/Important, 5 deferred Minors (fadeEnd-by-band, dead `uTrains`
   uniform, token-scan test strength, flat-band identity assertion, one stale dispose
   comment).** The fragment-bound spike (~5 M transcendentals/frame at skim) still belongs
   **before** the shading follow-ups are planned in detail. M4's exception shipped in the
   material: train 5 reaches weight 0 at 45 m in b0.
5. **Task 6** — mount in `world.ts`, boot label `sky + sea + puffs`, `HORIZON.HAZE_FAR`
   520 → 900, and migrate `horizon.test.ts`'s frozen 600 m literal to the new worst edge
   `hypot(1536, ALT_MAX + CAM_HEIGHT)`.
6. Then the untouched `2026-11-04-stylized-sea.md` **Tasks 4 / 5 / 7** (foam, light terms,
   grading) run on top.

## Global Constraints

- `npx tsc --noEmit` exits 0 after every task.
- No static `three/webgpu` in the boot graph — sea modules load it via dynamic `import()` only; `module-graph.test.ts` stays green.
- Palette single source: `SEA_PALETTE.haze === SKY_PALETTE.horizon`, `SUN_POSITION === [60, 35, -280]` (pinned in `palettes.test.ts`).
- Post contract untouched: bloom threshold 0.82, K4 margin 0.063.
- Lagrangian rule: displacement and sampling both evaluate at **base** coordinates.
- The sea material has `fog: false`; its own haze owns distance colour.
- `SKIM.DECK_Y = 7`, `CAM_HEIGHT = 6.8`, `camera.far = 2000`, altitude envelope 6–240 m: do not move.
- Every task ends with `npx vitest run` fully green and a commit.
- `scripts/smoke.mjs` module list gains each new module as it lands.

## Review Focus

- **Camera fov changes mid-flight** (`camera-rig.ts` animates 60→69°): a frozen `radPerPixel` would flatten the water as the plane accelerates. Task 1 pins the derivation, Task 5 pins that the uniform is recomputed every frame.
- **Diving through a band's skip threshold** at up to `FALL_MAX_SINK`: a naive on/off switch flickers during the most-watched pose. Task 3 pins 20 m hysteresis and asserts both crossing directions.
- **A band gap when the innermost band is skipped**: skipping B0 leaves B1 with no inner neighbour, so its hole must close. Task 3 pins the hole radius to 0 for the innermost drawn band.
- **Coarse-band inner row against fine-band outer row**: half the vertices, T-junction cracks. Task 4 keeps the coarse hole edge at or inside the fine outer edge instead of stitching it, and pins the one seam that could still open (b4/b5) plus the b0/b1 rim it inherits.
- **Drawing-buffer height differs with and without post** (`min(dpr,2)` vs `min(dpr,1.5)`): Task 6 pins that the uniform is derived from the live drawing buffer, not a constant.

---

### Task 1: Band table and per-frame angular budget

**Files:**
- Create: `src/sea/lod.ts`
- Test: `src/sea/lod.test.ts`

**Interfaces:**
- Consumes: nothing (pure math).
- Produces:
  - `perPixelRadians(fovDeg: number, bufferHeight: number): number`
  - `interface Band { name: string; inner: number; outer: number; cell: number; segments: number; trains: number }`
  - `BANDS: readonly Band[]` (6 entries, exact values below)
  - `trainDistance(amplitude: number, radPerPixel: number): number`
  - `bandVisible(band: Band, radPerPixel: number, altitude: number): boolean`
  - `SEGMENT_LOW_SCALE = 0.5`, `LOW_TIER_TRAINS = 3`

**Pinned values (from spec §6 M2):**

| name | inner | outer | cell | segments | trains |
| --- | --- | --- | --- | --- | --- |
| `sea-b0` | 0 | 45 | 2.25 | 40 | 5 |
| `sea-b1` | 45 | 171 | 4.5 | 76 | 4 |
| `sea-b2` | 171 | 261 | 9 | 58 | 3 |
| `sea-b3` | 261 | 414 | 18 | 46 | 2 |
| `sea-b4` | 414 | 576 | 36 | 32 | 1 |
| `sea-b5` | 576 | 2048 | 128 | 32 | 0 |

Every displaced extent is on the 2.25 m lattice, so `2*outer / segments === cell` holds
exactly for B0–B4. **B5 is flat and exempt** — its 128 m cell is not a lattice multiple and
it carries no displacement, so the lattice assertion runs over `BANDS.slice(0, 5)`.

- [ ] **Step 1: Write the failing test** — `src/sea/lod.test.ts`:

```ts
it('uses the rectilinear projection, not the linear approximation', () => {
  // 2*tan(30 deg)/1920 = 1.154700/1920
  expect(perPixelRadians(60, 1920)).toBeCloseTo(6.014e-4, 6);
  expect(perPixelRadians(69, 1920)).toBeGreaterThan(perPixelRadians(60, 1920));
  expect(perPixelRadians(60, 996)).toBeCloseTo(1.1594e-3, 6);
});

it('every band cell satisfies the direction-aware rule for its finest train', () => {
  // 0.205 * lambda, wave travels along WIND (0.82, -0.57)
  const LAMBDA = [180, 90, 45, 22, 11];
  for (const b of BANDS) {
    if (b.trains === 0) continue;
    const finest = LAMBDA[b.trains - 1];
    expect(b.cell).toBeLessThanOrEqual(0.205 * finest + 1e-9);
  }
});

it('bands tile without gaps or overlaps', () => {
  expect(BANDS[0].inner).toBe(0);
  for (let i = 1; i < BANDS.length; i++) expect(BANDS[i].inner).toBe(BANDS[i - 1].outer);
});

it('band cells are multiples of the innermost cell (shared lattice)', () => {
  // B5 is flat and exempt: it carries no displacement, so only its hole edge matters (Task 4).
  for (const b of BANDS.slice(0, 5)) {
    expect(b.cell / BANDS[0].cell).toBeCloseTo(Math.round(b.cell / BANDS[0].cell), 9);
  }
});

it('divides each side exactly into its cell', () => {
  for (const b of BANDS) {
    expect((2 * b.outer) / b.segments).toBeCloseTo(b.cell, 9);
  }
});

it('trainDistance scales inversely with the pixel angle', () => {
  expect(trainDistance(0.34, 5.797e-4)).toBeCloseTo(586.5, 1);
  expect(trainDistance(0.06, 5.797e-4)).toBeCloseTo(103.5, 1);
});

it('a band is invisible when its finest train is sub-pixel everywhere in it', () => {
  const rp = 5.797e-4;
  // B0's finest train (11 m, 0.06) is sub-pixel beyond 103.5 m, so at 240 m altitude B0 is skippable
  expect(bandVisible(BANDS[0], rp, 240)).toBe(false);
  expect(bandVisible(BANDS[0], rp, 7)).toBe(true);
  expect(bandVisible(BANDS[5], rp, 240)).toBe(true); // the flat band is always drawn
});
```

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run src/sea/lod.test.ts` → FAIL, module not found.
- [ ] **Step 3: Implement in `src/sea/lod.ts`** — `perPixelRadians` is `2*Math.tan(fovDeg*Math.PI/360)/bufferHeight`; guard non-finite/≤0 by returning the canonical `6.014e-4`. `bandVisible` returns `true` when `trains === 0`, otherwise `altitude < trainDistance(AMPS[trains-1], radPerPixel)`.
- [ ] **Step 4: Run tests + tsc** — `npx vitest run src/sea/lod.test.ts && npx tsc --noEmit` → PASS, exit 0.
- [ ] **Step 5: Commit** — `git add src/sea/lod.ts src/sea/lod.test.ts && git commit -m "feat(sea): band table and per-frame angular budget"`.

### Task 2: Band geometry and snap tow

**Files:**
- Create: `src/sea/bands.ts`
- Test: `src/sea/bands.test.ts`
- Modify: `scripts/smoke.mjs` (append both new module paths)

**Interfaces:**
- Consumes: `BANDS`, `Band` from `./lod`.
- Produces: `initSeaBands(scene: THREE.Scene, opts?: { debug?: boolean }): Promise<{ meshes: THREE.Mesh[]; update(camera: THREE.Vector3, radPerPixel: number, t: number, high: boolean): void; dispose(): void }>`; mesh names `sea-b0` … `sea-b5`; `snapOrigin(v: number, cell: number): number`.

- [ ] **Step 1: Write the failing test** — `src/sea/bands.test.ts`:

```ts
it('snaps an origin down to its own cell grid', () => {
  expect(snapOrigin(7.3, 4.5)).toBeCloseTo(4.5, 9);
  expect(snapOrigin(-7.3, 4.5)).toBeCloseTo(-9, 9);
  expect(snapOrigin(0, 2.25)).toBe(0);
});

it('adds one mesh per band with stable names', async () => {
  const scene = new THREE.Scene();
  const h = await initSeaBands(scene);
  expect(h.meshes.map((m) => m.name)).toEqual(['sea-b0','sea-b1','sea-b2','sea-b3','sea-b4','sea-b5']);
});

it('tows every band to the camera, each on its own quantum', async () => {
  const h = await initSeaBands(new THREE.Scene());
  h.update(new THREE.Vector3(101, 7, -37), 5.797e-4, 0, true);
  const byName = new Map(h.meshes.map((m) => [m.name, m]));
  expect(byName.get('sea-b1')!.position.x % 4.5).toBeCloseTo(0, 9);
  expect(byName.get('sea-b0')!.position.x % 2.25).toBeCloseTo(0, 9);
});
```

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run src/sea/bands.test.ts` → FAIL.
- [ ] **Step 3: Implement `src/sea/bands.ts`** — one `PlaneGeometry(2*outer, 2*outer, segments, segments)` per band rotated flat; `update` writes `mesh.position.x/z` to `snapOrigin(camera.x, cell)`. No material yet (Task 5 assigns them).
- [ ] **Step 4: Run tests + tsc + smoke** — PASS, exit 0, `smoke ok`.
- [ ] **Step 5: Commit** — `git commit -m "feat(sea): six band meshes with per-band snap tow"`.

### Task 3: Visibility mask with hysteresis

**Files:**
- Modify: `src/sea/lod.ts` (add `nextVisibilityMask`), `src/sea/bands.ts` (apply it)
- Test: `src/sea/lod.test.ts`, `src/sea/bands.test.ts`

**Interfaces:**
- Produces: `SEA_HYSTERESIS_M = 10`; `nextVisibilityMask(prev: boolean[], radPerPixel: number, altitude: number): boolean[]` — same length as `BANDS`.
- `bands.update(...)` additionally closes the innermost drawn band's hole (sets `holes[i] = 0` for the first `true`).

- [ ] **Step 1: Write the failing test:**

```ts
it('applies 10 m of hysteresis so a dive cannot flicker a band', () => {
  const rp = 5.797e-4;              // B0's finest train (11 m, 0.06) is sub-pixel past 103.5 m
  const all = [true, true, true, true, true, true];
  // still on: 100 < 103.5 + 10
  expect(nextVisibilityMask(all, rp, 100)[0]).toBe(true);
  // turns off above 103.5 + 10 = 113.5
  const off = nextVisibilityMask(all, rp, 120);
  expect(off[0]).toBe(false);
  // stays off coming back down until below 103.5 - 10 = 93.5
  expect(nextVisibilityMask(off, rp, 100)[0]).toBe(false);
  expect(nextVisibilityMask(off, rp, 90)[0]).toBe(true);
});

it('keeps the flat band always drawn', () => {
  expect(nextVisibilityMask(BANDS.map(() => true), 5.797e-4, 240)[5]).toBe(true);
});
```

- [ ] **Step 2: Run it and watch it fail** — FAIL, `nextVisibilityMask` not exported.
- [ ] **Step 3: Implement** — compare against `trainDistance(...) ± SEA_HYSTERESIS_M` using `prev[i]` to pick which side of the dead band applies.
- [ ] **Step 4: Run tests + tsc** — PASS, exit 0.
- [ ] **Step 5: Commit** — `git commit -m "feat(sea): band visibility mask with 10 m hysteresis"`.

### Task 4: Hole inset at b4/b5 and the overlap proof (no skirt)

The review that M5 went through killed the skirt: with `floor` snapping on nested quanta the
coarse hole edge already lands inside the fine outer edge, so four seams cannot open and have
nothing to stitch. The fifth can open, and the fix is one inset. Full reasoning and the pixel
sizes are in design M5 / R6; this task is only the code.

**Files:**
- Modify: `src/sea/bands.ts`
- Test: `src/sea/bands.test.ts`

**Interfaces:**
- Produces: `holeEdgeFor(band: Band, prevCell: number | null): number` — the annulus's inner
  cut in the band's own frame: `band.inner - band.cell` when
  `prevCell !== null && band.cell % prevCell !== 0`, otherwise
  `Math.floor(band.inner / band.cell) * band.cell`. Derive it from the table rather than
  adding a flag, so a future retune cannot forget it.
- `buildBandGeometry(band, prevCell)` calls it. The comment at `src/sea/bands.ts:173-180`
  documents the abutment ruling this task reverses and must be rewritten, not left standing.
- `initSeaBands` gains **no** new field: there is no `skirts` array, and no new mesh.

- [ ] **Step 1: Write the failing tests:**

```ts
it('insets only the band whose cell is not a multiple of the one inside it', () => {
  const edges = BANDS.map((b, i) => holeEdgeFor(b, i === 0 ? null : BANDS[i - 1].cell));
  expect(edges).toEqual([0, 45, 171, 252, 396, 480]);
});

it('never lets a coarse hole edge fall outward of the fine outer edge', () => {
  for (let i = 1; i < BANDS.length; i++) {
    const fine = BANDS[i - 1];
    const coarse = BANDS[i];
    const hole = holeEdgeFor(coarse, fine.cell);
    for (let v = -3 * coarse.cell; v <= 3 * coarse.cell; v += 0.25) {
      const coarseEdge = snapOrigin(v, coarse.cell) + hole;
      const fineEdge = snapOrigin(v, fine.cell) + fine.outer;
      expect(coarseEdge).toBeLessThanOrEqual(fineEdge + 1e-9);
    }
  }
});

it('keeps the measured residual ranges from the design record', () => {
  const ranges = BANDS.slice(1).map((coarse, i) => {
    const fine = BANDS[i];
    let lo = Infinity;
    let hi = -Infinity;
    for (let v = 0; v <= 3 * coarse.cell; v += 0.25) {
      const d = snapOrigin(v, coarse.cell) - snapOrigin(v, fine.cell);
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
    return [lo, hi];
  });
  expect(ranges).toEqual([
    [-2.25, 0], [-4.5, 0], [-9, 0], [-18, 0], [-84, 24],
  ]);
});
```

The third test is the one that matters: it is the *sign* of that residual, not its magnitude,
that decides whether a seam can open. If a retune ever makes 96 a multiple of 36 the inset
disappears on its own, and if it makes some other quanta non-nested the second test fails
before the render does.

- [ ] **Step 2: Run them and watch them fail** — FAIL (first test returns `576`, second fails
  at b4/b5 for `v` near 96).
- [ ] **Step 3: Implement** — `holeEdgeFor`, thread `prevCell` through `buildBandGeometry`
  from `initSeaBands`'s band loop, rewrite the comment. Integer arithmetic stays: 480 is
  5 · 96 and every other row is unchanged.
- [ ] **Step 4: Run tests + `tsc --noEmit`** — PASS, exit 0; `npm run smoke` still `smoke ok`.
- [ ] **Step 5: Commit** — `git commit -m "feat(sea): inset b4/b5 so the seam overlap is provably non-negative"`.

**Manual gate before this counts as done** — R6: one frozen frame at skim altitude, 40 px
strip across the b0/b1 boundary, b0/b1's rim compared against the 95th percentile 20 px
inward. If the 2.2 px rim is visible, the fallback is a small negative depth bias on the
coarse band inside the overlap; if it is not, record the frame and the number and leave the
geometry alone.

### Task 5: Displacement, base ramp, crest tint

**Files:**
- Create: `src/sea/surface-material.ts`
- Test: `src/sea/surface-material.test.ts`

**Interfaces:**
- Consumes: `BANDS`, `perPixelRadians`; `gerstnerField` from `./waves`; `SEA_PALETTE`, `SUN_DIRECTION` from `../palettes`.
- Produces: `buildSurfaceMaterial(THREE, opts: { trains: number; radPerPixel: number }): unknown`; `materialUniforms(opts: { trains: number; radPerPixel: number }): Map<string, { value: number }>`; `trainWeight(amplitude: number, distance: number, radPerPixel: number): number`; uniform names `uRadPerPixel`, `uTime`, `uTrains`.

- [ ] **Step 1: Write the failing test** — node-build test, pattern from `git show 5db7458:src/sea.test.ts`:

```ts
it('displaces at base coordinates, never at the displaced position', async () => {
  const map = await materialUniforms({ trains: 5, radPerPixel: 5.797e-4 });
  expect(map.uRadPerPixel.value).toBeCloseTo(5.797e-4, 9);
});

it('fades a train out exactly at its visibility distance', async () => {
  // 11 m train, A = 0.06 -> 103.5 m at rp = 5.797e-4
  expect(trainWeight(0.06, 103.5, 5.797e-4)).toBeCloseTo(0, 6);
  expect(trainWeight(0.06, 40, 5.797e-4)).toBeGreaterThan(0.5);
});
```

- [ ] **Step 2: Run it and watch it fail** — FAIL.
- [ ] **Step 3: Implement** — dynamic `three/webgpu` import inside the builder; displacement evaluates `gerstnerField` at `modelWorldMatrix * positionGeometry`; per-train weight is `1 - smoothstep(d0, d1, dist)` with `d1 = A/radPerPixel` and `d0 = d1 - 48` (one band width, spec M4). Base ramp and crest tint are per-fragment from the exact field.
- [ ] **Step 4: Run tests + tsc + full suite** — PASS, exit 0.
- [ ] **Step 5: Commit** — `git commit -m "feat(sea): Lagrangian displacement with per-train distance fade"`.

### Task 6: Integration — world, boot label, haze 900

**Files:**
- Modify: `src/world.ts`, `src/main.ts`, `src/horizon.ts`, `src/horizon.test.ts`, `src/world.test.ts`, `src/far-field.ts`, `src/far-field.test.ts`

**Interfaces:**
- Consumes: `initSeaBands`, `buildSurfaceMaterial`, `perPixelRadians`.
- Produces: `WorldHandles.sea` (non-null); boot label `sky + sea + puffs`.

- [ ] **Step 1: Write the failing test** — `world.test.ts`: world exposes a non-null sea and `setQuality(false)` reaches it. `horizon.test.ts`: replace the frozen 600 m literal with `hypot(2048, FLIGHT.ALT_MAX + CAM_HEIGHT)` and assert `horizonHaze(worstEdge) === 1` under `HAZE_FAR = 900`. `far-field.test.ts`: the sea is no longer in `followed`.
- [ ] **Step 2: Run it and watch it fail** — `npx vitest run src/world.test.ts src/horizon.test.ts src/far-field.test.ts` → FAIL.
- [ ] **Step 3: Implement** — `initWorld` awaits the bands and throws on failure; each frame computes `perPixelRadians(camera.fov, renderer.getSize().height)` from the **live** drawing buffer and passes it down; `main.ts` label; `HORIZON.HAZE_FAR` 520 → 900.
- [ ] **Step 4: Run tests + tsc + smoke** — PASS, exit 0, `smoke ok`.
- [ ] **Step 5: Commit** — `git commit -m "feat(sea): wire the banded surface into world and boot"`.

## Self-Review

1. **Spec coverage:** §5.1 → Task 1 (`perPixelRadians`) + Task 6 (live buffer). §5.2 → Task 1's direction-aware assertion. §5.3 → Task 1 `trainDistance`. M2 band table → Task 1. M3 annuli → Task 2. M4 fade → Task 5. M5 seam ruling → Task 4 (inset + overlap proof, no skirt). M6 snapping → Task 2. M7 hysteresis → Task 3. M9 low tier → Task 2 (`SEGMENT_LOW_SCALE`). M11 `fog:false` → Task 5. M12 HAZE 900 → Task 6. M13 justification is a document note, not a task.
2. **Step scan:** each code step names file, signature and pinned values; no step says "handle edge cases".
3. **Type consistency:** `perPixelRadians`, `bandVisible`, `nextVisibilityMask`, `snapOrigin`, `holeEdgeFor`, `buildSurfaceMaterial`, `initSeaBands` are used with the same signatures in every task that references them.
4. **Review Focus:** fov change → Task 1 + Task 6; dive hysteresis → Task 3; skipped innermost hole → Task 3; T-junction → Task 4; dpr spread → Task 6.
5. **Proportion:** spec 281 lines, plan ~200 — the bulk is decisions and pinned values, not bodies.
