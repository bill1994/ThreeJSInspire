# Sea Surface LOD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the deleted FFT sea with a banded, distance-driven Gerstner surface that is invisible at every LOD boundary and holds ~23k triangles on a mid-range Android.

**Architecture:** Pure-TS band and angular-budget tables (`src/sea/lod.ts`) size the geometry once; a per-frame `radPerPixel` uniform drives the per-train displacement fades so the LOD tracks fov and drawing-buffer size. Geometry is six square annuli on a shared 2.25 m lattice, stitched by exact skirts (no discard, no dither), towed per band with a snap quantum equal to that band's cell.

**Tech Stack:** three 0.186 TSL (dynamic import only), vitest 2, tsc strict. TSL idioms reference: `git show 5db7458:src/sea-fft.ts`.

**Spec:** `docs/superpowers/specs/2026-11-04-infinite-ocean-lod-design.md` (rev 3). The shading look is specified by `2026-11-04-stylized-sea-design.md`. Executors read all three.

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
- **Coarse-band inner row against fine-band outer row**: half the vertices, T-junction cracks. Task 4 pins that every stitch vertex lies exactly on the finer band's vertex lattice.
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
| `sea-b0` | 0 | 48 | 2.25 | 43 | 5 |
| `sea-b1` | 48 | 173 | 4.5 | 77 | 4 |
| `sea-b2` | 173 | 259 | 9 | 58 | 3 |
| `sea-b3` | 259 | 414 | 18 | 46 | 2 |
| `sea-b4` | 414 | 587 | 36 | 33 | 1 |
| `sea-b5` | 587 | 2048 | 128 | 32 | 0 |

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
  for (const b of BANDS) expect(b.cell / BANDS[0].cell).toBeCloseTo(Math.round(b.cell / BANDS[0].cell), 9);
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
  const rp = 5.797e-4;
  const on  = nextVisibilityMask([true,true,true,true,true,true], rp, 200); // below 103.5+10
  const off = nextVisibilityMask([true,true,true,true,true,true], rp, 220); // above 103.5+10 -> B0 off
  expect(on[0]).toBe(true);
  expect(off[0]).toBe(false);
  // coming back down must not re-enable until 103.5-10 = 93.5
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

### Task 4: Skirt stitching

**Files:**
- Modify: `src/sea/bands.ts`
- Test: `src/sea/bands.test.ts`

**Interfaces:**
- Produces: `stitchVertices(fineCell: number, coarseCell: number, halfExtent: number): Float32Array` — ring of `(2*halfExtent/coarseCell)*4` positions at `y = 0` on the boundary square, every vertex exactly on the finer lattice.
- `initSeaBands` returns additionally `skirts: THREE.Mesh[]` named `sea-s0` … `sea-s4`.

- [ ] **Step 1: Write the failing test:**

```ts
it('places every stitch vertex on the fine band lattice', () => {
  const pts = stitchVertices(2.25, 4.5, 48);
  for (const v of pts) {
    const onFine = (n: number) => Math.abs(n / 2.25 - Math.round(n / 2.25)) < 1e-9;
    expect(onFine(v)).toBe(true);
  }
});

it('emits one skirt per band boundary, not around the outermost band', () => {
  const h = await initSeaBands(new THREE.Scene());
  expect(h.skirts.map((m) => m.name)).toEqual(['sea-s0','sea-s1','sea-s2','sea-s3','sea-s4']);
});
```

- [ ] **Step 2: Run it and watch it fail** — FAIL.
- [ ] **Step 3: Implement** — build each skirt as a triangle strip between the fine band's outer ring and the coarse band's inner ring; no `discard`, no alpha.
- [ ] **Step 4: Run tests + tsc** — PASS, exit 0.
- [ ] **Step 5: Commit** — `git commit -m "feat(sea): exact skirt stitching between bands"`.

### Task 5: Displacement, base ramp, crest tint

**Files:**
- Create: `src/sea/surface-material.ts`
- Test: `src/sea/surface-material.test.ts`

**Interfaces:**
- Consumes: `BANDS`, `perPixelRadians`; `gerstnerField` from `./waves`; `SEA_PALETTE`, `SUN_DIRECTION` from `../palettes`.
- Produces: `buildSurfaceMaterial(THREE, opts: { trains: number; radPerPixel: number }): unknown`; uniform names `uRadPerPixel`, `uTime`, `uTrains`.

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

1. **Spec coverage:** §5.1 → Task 1 (`perPixelRadians`) + Task 6 (live buffer). §5.2 → Task 1's direction-aware assertion. §5.3 → Task 1 `trainDistance`. M2 band table → Task 1. M3 annuli → Task 2. M4 fade → Task 5. M5 stitching → Task 4. M6 snapping → Task 2. M7 hysteresis → Task 3. M9 low tier → Task 2 (`SEGMENT_LOW_SCALE`). M11 `fog:false` → Task 5. M12 HAZE 900 → Task 6. M13 justification is a document note, not a task.
2. **Step scan:** each code step names file, signature and pinned values; no step says "handle edge cases".
3. **Type consistency:** `perPixelRadians`, `bandVisible`, `nextVisibilityMask`, `snapOrigin`, `stitchVertices`, `buildSurfaceMaterial`, `initSeaBands` are used with the same signatures in every task that references them.
4. **Review Focus:** fov change → Task 1 + Task 6; dive hysteresis → Task 3; skipped innermost hole → Task 3; T-junction → Task 4; dpr spread → Task 6.
5. **Proportion:** spec 281 lines, plan ~200 — the bulk is decisions and pinned values, not bodies.
