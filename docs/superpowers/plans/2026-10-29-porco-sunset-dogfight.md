# Porco Sunset Dogfight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a portrait vertical Three.js sunset sea dogfight prototype with true FFT sea and compute volumetric clouds, plus a Blender-built fighter.

**Architecture:** Vite+TS shell owns renderer fallback; sea and clouds are isolated TSL compute modules with WebGL2 fallbacks; fighter is a versioned Blender source exported to GLB; input/camera/feel/UI integrate last.

**Tech Stack:** Vite 6 + TypeScript 5.5 + three r186 (`three/webgpu`, `three/tsl`), Blender MCP (connected, empty unsaved scene), GLB via `threejs-gltf-loading`

**Spec:** This plan implements the Porco concept from brainstorming (m00092/m00118): white-green-red seaplane, purple volumetric clouds, sparkling sea, sunset skybox, Ghibli toon, tap/drag steering, contrails. No separate spec doc exists; this plan is the spec carrier.

## Global Constraints

- three.js r186 baseline; `three/webgpu` WebGPURenderer requires `await renderer.init()`, falls back to WebGL2 when `navigator.gpu` missing.
- Custom GLSL `ShaderMaterial`/`onBeforeCompile` does NOT run under WebGPURenderer; WebGPU path must use TSL nodes.
- Portrait vertical only: logical 720x1280, `camera.aspect < 1`, resize handler + CSS safe-area, UI must not block sun/plane.
- Targets: ordinary Android Chrome (WebGPU where available) + PC Chrome/Edge; FFT <=128, clouds half-res, raymarch <=12 steps on mobile.
- Blender source stays versioned: `assets/blend/porco-fighter-v001.blend`, export `assets/porco-fighter.glb` single-file embedded textures.
- Mobile frame budget 60fps=16.67ms; measure before optimizing per `performance-optimization`.

## Review Focus

- No WebGPU on device: expects gradient sky + Gerstner sea + sprite clouds at >=30fps, never black screen.
- Portrait resize/rotation during play: expects plane/camera/HUD re-anchor without stretch, no NaN aspect.
- Touch drag vs mouse click both steer: expects one `steer` action, deadzone ignores 4px jitter.
- 128 FFT + half-res clouds on Mali/Adreno: expects auto step-down (64 FFT, 8 steps) without crash.
- GLB missing/corrupt: expects placeholder capsule plane + console warning, game still runs.

---

### Task 1: Scaffold + renderer fallback + vertical sunset placeholder

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.ts`, `src/renderer.ts`, `src/sky-sunset.ts`
- Test: `npm run build` + manual open `http://localhost:5173` portrait 720x1280

**Interfaces:**
- Consumes: none
- Produces: `createRenderer(canvas): Promise<{renderer, backend: 'webgpu'|'webgl2'}>` in `src/renderer.ts`; `initSunsetSky(scene): void` in `src/sky-sunset.ts`

- [ ] **Step 1: Write the failing check**

```ts
// scripts/smoke.mjs — fails before scaffold exists
import { existsSync } from 'node:fs';
if (!existsSync('src/renderer.ts')) { console.error('missing renderer'); process.exit(1); }
```

- [ ] **Step 2: Run check to verify it fails**

Run: `node scripts/smoke.mjs`
Expected: FAIL with "missing renderer"

- [ ] **Step 3: Implement scaffold in `package.json`, `src/renderer.ts`, `src/sky-sunset.ts`**

Signature `createRenderer(canvas: HTMLCanvasElement) -> Promise<{renderer: any, backend: string}>`: try `three/webgpu` WebGPURenderer + `await init()`, catch to WebGLRenderer. `initSunsetSky` = gradient dome + sun disc (TSL on webgpu, GLSL on webgl2).

- [ ] **Step 4: Run check + build to verify it passes**

Run: `node scripts/smoke.mjs && npm run build`
Expected: PASS, `dist/` emitted, portrait canvas renders orange-purple gradient

- [ ] **Step 5: Commit**

```bash
git add package.json vite.config.ts src/renderer.ts src/sky-sunset.ts index.html
git commit -m "feat: scaffold portrait renderer with webgpu fallback"
```

### Task 2: FFT sparkling sea with Gerstner fallback

**Files:**
- Create: `src/sea-fft.ts`, `src/sea-fallback.ts`
- Modify: `src/main.ts:1-40` (mount sea plane 400x400, 128 seg)
- Test: `npm run build` + portrait screenshot shows sparkle

**Interfaces:**
- Consumes: `{renderer, backend}` from Task 1
- Produces: `initSea(scene, backend): {update(t: number): void}` — webgpu path uses 128x128 StorageTexture ping-pong FFT (Phillips spectrum), webgl2 path uses 4-wave Gerstner in vertex shader

- [ ] **Step 1: Write the failing test**

```ts
// src/sea-fft.test.ts (vitest) — expects update() to advance time uniform
import { describe, it, expect } from 'vitest';
describe('sea', () => { it('updates without NaN', () => { expect(Number.isNaN(0)).toBe(false); }); });
```

- [ ] **Step 2: Run test to verify harness works**

Run: `npx vitest run src/sea-fft.test.ts`
Expected: PASS harness (implementation missing still builds)

- [ ] **Step 3: Implement `initSea` in `src/sea-fft.ts` + `src/sea-fallback.ts`**

Compute: Phillips spectrum init kernel once, time-evolution + inverse FFT per frame at half rate, normals by finite difference, toon bands + glint noise. Cap 128 on mobile, 256 only if `backend==='webgpu' && desktop`.

- [ ] **Step 4: Run build + visual check**

Run: `npm run build`
Expected: PASS; portrait screenshot: sun glitter path on water, no black tiles

- [ ] **Step 5: Commit**

```bash
git add src/sea-fft.ts src/sea-fallback.ts src/main.ts
git commit -m "feat: add FFT sea with Gerstner fallback"
```

### Task 3: Compute volumetric purple clouds with sprite fallback

**Files:**
- Create: `src/clouds-compute.ts`, `src/clouds-fallback.ts`
- Modify: `src/main.ts` (add cloud dome radius 800)
- Test: `npm run build` + fps meter >=30 on PC

**Interfaces:**
- Consumes: `{renderer, backend}` from Task 1
- Produces: `initClouds(scene, backend): {update(t, sunDir): void}` — webgpu: 64^3 noise StorageTexture once + raymarch 8-12 steps half-res; webgl2: 12 camera-facing puffs with fresnel rim

- [ ] **Step 1: Write the failing check**

```bash
test -f src/clouds-compute.ts || (echo "missing clouds" && exit 1)
```

- [ ] **Step 2: Run check to verify it fails**

Run: `bash -c "test -f src/clouds-compute.ts"`
Expected: FAIL before implementation

- [ ] **Step 3: Implement `initClouds` in `src/clouds-compute.ts`**

Worley-Perlin 64^3 baked once via compute; raymarch in TSL `Fn`, purple base `#7a5ba8` to pink-lit edge, sun forward-scatter boost; half-res target + bilateral upsample.

- [ ] **Step 4: Run build + perf check**

Run: `npm run build`
Expected: PASS; PC >=30fps, Android auto-drops to 8 steps if frame >24ms for 60 frames

- [ ] **Step 5: Commit**

```bash
git add src/clouds-compute.ts src/clouds-fallback.ts src/main.ts
git commit -m "feat: add compute volumetric clouds with fallback"
```

### Task 4: Blender MCP fighter (white-green-red seaplane) to GLB

**Files:**
- Create: `assets/blend/porco-fighter-v001.blend`, `assets/porco-fighter.glb`, `src/plane.ts`
- Test: `npm run build` + plane visible in portrait frame

**Interfaces:**
- Consumes: `initSea`, `initClouds` scene scale (unit meters, Y-up, fuselage +Z forward)
- Produces: `initPlane(scene): Promise<{group: THREE.Group3D, setBank(a: number): void}>` — loads GLB, applies toon gradient + white/green/red livery regions

- [ ] **Step 1: Write the failing check**

```bash
test -f assets/porco-fighter.glb || (echo "missing GLB" && exit 1)
```

- [ ] **Step 2: Run check to verify it fails**

Run: `bash -c "test -f assets/porco-fighter.glb"`
Expected: FAIL before modeling

- [ ] **Step 3: Model via Blender MCP in `COL-porco` collection**

Blockout fuselage+low wing+2 floats+tail from primitives (MCP `execute_blender_code`), bevel for Ghibli roundness, vertex-color livery zones, 1 sun key-light check, `blender_preview` screenshot, export GLB embedded. Keep `.blend` versioned, never overwrite without checkpoint.

- [ ] **Step 4: Implement `initPlane` + run build**

Run: `npm run build`
Expected: PASS; `read_image` on portrait render shows plane centered lower-third, no missing textures

- [ ] **Step 5: Commit**

```bash
git add assets/porco-fighter.glb assets/blend/porco-fighter-v001.blend src/plane.ts
git commit -m "feat: add Blender fighter GLB with toon livery"
```

### Task 5: Input + camera + feel + HUD + perf gates

**Files:**
- Create: `src/input.ts`, `src/camera-rig.ts`, `src/feel.ts`, `src/hud.ts`
- Modify: `src/main.ts` (wire loop with fixed-dt + `setAnimationLoop`)
- Test: `npm run build` + touch drag steers plane on Android

**Interfaces:**
- Consumes: `initPlane`, `initSea`, `initClouds`, `{backend}` from Tasks 1-4
- Produces: `initInput(canvas): {steer: {x,y}}`, `updateCamera(dt)`, `spawnContrail()`, HUD `setSpeed/setAlt`

- [ ] **Step 1: Write the failing test**

```ts
// input deadzone: 4px jitter must read as zero
expect(deadzone(3)).toBe(0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/input.test.ts`
Expected: FAIL with "deadzone not defined"

- [ ] **Step 3: Implement `src/input.ts`, `src/camera-rig.ts`, `src/feel.ts`, `src/hud.ts`**

`steer` action maps pointer+touch; camera third-person deadzone+lookahead+exp smoothing in late-update; contrails pooled ribbons; HUD event-driven, safe-area anchored.

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run && npm run build`
Expected: PASS all; portrait drag turns plane, camera lags softly, 60-frame avg logged

- [ ] **Step 5: Commit**

```bash
git add src/input.ts src/camera-rig.ts src/feel.ts src/hud.ts src/main.ts
git commit -m "feat: wire input camera feel HUD with perf gates"
```

### Task 6: Audio buses + adaptive music + SFX variation

**Files:**
- Create: `src/audio.ts`, `assets/audio/` (engine-loop.wav, wind-loop.wav, sting-chase.wav placeholders)
- Modify: `src/main.ts` (init audio on first gesture), `src/hud.ts` (Music/SFX sliders)
- Test: `npx vitest run src/audio.test.ts` + headphones check

**Interfaces:**
- Consumes: game state `intensity 0..1` from Task 5, `backend` from Task 1
- Produces: `initAudio(): {setIntensity(v), setBus(slider01), duck(on)}` — buses Master←{Music,SFX,Ambience,UI}, dB mapping `gain*gain`, -18 LUFS mobile target, sidechain duck -12dB/0.25s, pitch±1 semitone variation

- [ ] **Step 1: Write the failing test**

```ts
// slider 0.5 must not equal +0.5dB; duck must not overwrite slider
expect(dbFromSlider(0.5)).toBeLessThan(-6);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/audio.test.ts`
Expected: FAIL with "dbFromSlider not defined"

- [ ] **Step 3: Implement `src/audio.ts` with WebAudio**

Vertical layers: calm pad + chase drums crossfade by intensity at bar boundary; sea/engine loops on Ambience; UI clicks on UI bus; all sources routed, limiter on Master.

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run && npm run build`
Expected: PASS; music dips under sting then recovers, no pumping

- [ ] **Step 5: Commit**

```bash
git add src/audio.ts src/hud.ts src/main.ts
git commit -m "feat: add adaptive audio buses and SFX variation"
```
