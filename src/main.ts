/**
 * src/main.ts — composition root. Owns the scene, the camera and the frame loop;
 * everything else is mounted through src/world.ts (puff clouds), src/game.ts
 * (plane + input + camera rig + feel + HUD + audio).
 *
 * Boot is defensive on purpose: a failed WebGPU probe, a failed puff field, a missing GLB
 * or a blocked AudioContext each degrade one feature, never the whole page — the plan's
 * review gate is "no-WebGPU device still shows sky + clouds, never a black screen".
 * The post pipeline is guarded the same way: it is the module most likely to trip an odd
 * driver, so a failure there costs the effect, not the page.
 *
 * Both backends run the same TSL code now (WebGPURenderer with `forceWebGL` for WebGL2), so
 * there is one sky and one cloud implementation instead of two parallel ones. The boot label
 * reports what actually mounted (`sky + puffs`, or `sky only` if the puff field failed to
 * build), so a missing feature is visible on screen rather than inferred.
 *
 * The sea was deleted on 2026-11-06 (`rebuild/sea-dome-reset`) together with the dome cloud;
 * nothing in this file tows or budgets a water surface any more.
 */
import * as THREE from 'three';
import { createRenderer, type Backend } from './renderer';
import { initSunsetLights } from './lights';
import { initSunsetSkyTSL, sunsetGradientTexture } from './sky-webgpu';
import { parsePos, parsePuffVisible } from './qa';
import { initWorld, type WorldHandles } from './world';
import { initGame, type GameHandles } from './game';
import { initFarField } from './far-field';
import { initPost, usePost, type PostHandle } from './post';
import { portraitAspect } from './portrait';

const PORTRAIT = 9 / 16;

/**
 * QA spawn altitude from `?alt=<metres>`.
 *
 * The cloud slab sits at 95..265 m and the aircraft can only reach it at the top of a climb
 * cycle, so a visual pass on the cloud shader otherwise costs a full climb every time. Absent
 * or unparseable reads as `undefined`, which keeps the normal `FLIGHT.START_Y` spawn.
 */
function spawnAltitude(search: string): number | undefined {
  const raw = new URLSearchParams(search).get('alt');
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

const canvasEl = document.getElementById('game');
if (!(canvasEl instanceof HTMLCanvasElement)) throw new Error('missing #game canvas');
const canvas = canvasEl;

const scene = new THREE.Scene();
// Background colour doubles as the safety net: if the sky dome material cannot render on
// the active backend, the horizon is still sunset-warm instead of black.
scene.background = new THREE.Color('#a86a86');
scene.fog = new THREE.Fog('#c96a7a', 60, 700);

const camera = new THREE.PerspectiveCamera(60, PORTRAIT, 0.1, 2000);
camera.position.set(0, 3.2, 9);
camera.lookAt(0, 1.2, -20);

// Safety net for both backends: a warm canvas gradient behind everything, so even if a
// sky dome fails to build the horizon is never black. A working dome simply covers it.
const gradient = sunsetGradientTexture(THREE);
if (gradient) scene.background = gradient;

/** Visible boot diagnostics: a blank page must never be the only symptom. */
const statusEl = document.createElement('div');
statusEl.id = 'boot-status';
statusEl.setAttribute('role', 'status');
statusEl.style.cssText = [
  'position:fixed',
  'left:0',
  'right:0',
  'bottom:calc(env(safe-area-inset-bottom, 0px) + 8px)',
  'margin:0 auto',
  'max-width:min(92vw, 420px)',
  'font:500 11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace',
  'color:#ffe9d6',
  'text-align:center',
  'text-shadow:0 1px 3px rgba(40,10,30,.85)',
  'pointer-events:none',
  'opacity:.9',
  'transition:opacity .6s ease',
].join(';');
document.body.appendChild(statusEl);

function setStatus(text: string, fadeAfterMs = 0): void {
  statusEl.textContent = text;
  statusEl.style.opacity = '0.9';
  if (fadeAfterMs > 0) {
    window.setTimeout(() => {
      statusEl.style.opacity = '0';
    }, fadeAfterMs);
  }
}

let world: WorldHandles | null = null;
let game: GameHandles | null = null;
let post: PostHandle | null = null;

interface Renderer {
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  setSize(w: number, h: number, updateStyle?: boolean): void;
  setAnimationLoop(fn: ((t: number) => void) | null): void;
  setPixelRatio?(ratio: number): void;
}

let renderer: Renderer | null = null;
let backend: Backend = 'webgl2';
/** False only on the classic-WebGLRenderer last resort, which cannot host a TSL pipeline. */
let postSupported = false;

function resize(): void {
  if (!renderer) return;
  const h = canvas.clientHeight || window.innerHeight;
  const w = canvas.clientWidth || Math.round(h * PORTRAIT);
  if (w <= 0 || h <= 0) return;
  renderer.setSize(w, h, false);
  // Same contract as game.ts's syncAspect: the #frame box keeps the buffer within
  // 9:16, portraitAspect is the degenerate-frustum safety net.
  const aspect = portraitAspect(w, h);
  if (Number.isFinite(aspect) && Math.abs(aspect - camera.aspect) > 1e-4) {
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  }
}

async function boot(): Promise<void> {
  const created = await createRenderer(canvas);
  const r = created.renderer as Renderer;
  renderer = r;
  backend = created.backend;
  postSupported = created.postSupported;

  resize();
  window.addEventListener('resize', resize);

  // One TSL sky on both backends now: the WebGL2 backend is WebGPURenderer with
  // `forceWebGL`, so node materials and TSL compile to GLSL instead of needing a parallel
  // ShaderMaterial dome. The lighting rig is backend-agnostic and stays shared.
  const sunLight = initSunsetLights(scene);
  await initSunsetSkyTSL(THREE, scene);

  try {
    world = await initWorld(scene, sunLight);
  } catch (err) {
    console.warn('[porco] world unavailable, sky only', err);
    world = null;
  }

  // 抓帧钩子：?puff=0 整场藏云做 paired on/off，?pos=x,y,z 直接摆位。
  const qaParams = new URLSearchParams(location.search);
  const puffVisible = parsePuffVisible(qaParams.get('puff'));
  const qaPos = parsePos(qaParams.get('pos'));
  if (!puffVisible) world?.setPuffVisible(false);

  // 启动条只报真正挂上去的东西：天穹永远在，云可能没建起来。
  const worldLabel = world?.clouds ? 'sky + puffs' : 'sky only';

  try {
    game = await initGame({ scene, camera, canvas, backend, startY: spawnAltitude(location.search) });
    // 摆位必须等 game 存在之后；放在 initGame 之前那行会静默失效。
    if (qaPos) game.setPose(qaPos.x, qaPos.y, qaPos.z);
  } catch (err) {
    console.warn('[porco] game unavailable, free-look scene only', err);
    game = null;
  }

  if (usePost(location.search) && postSupported) {
    try {
      // Size first, build second: the pipeline sizes its own render targets from the drawing
      // buffer it sees when it builds, so a buffer that changes afterwards leaves them stale.
      // Portrait HalfFloat target at dpr 2 reaches 2880x5120 and bloom alone costs ~15 ms there.
      r.setPixelRatio?.(Math.min(window.devicePixelRatio || 1, 1.5));
      resize();
      post = await initPost(r, scene, camera);
      // `initWorld` may already have stepped a phone down before the pipeline existed. Starting
      // the pipeline on the tier the world is really on is what makes the first transition —
      // and every later one — reachable; the loop only reacts to changes.
      post.setQuality((world?.quality ?? 'high') === 'high');
    } catch (err) {
      console.warn('[porco] post unavailable, rendering direct', err);
      post = null;
    }
  }

  setStatus(`${backend} · ${worldLabel}`, 6000);
  console.info(
    `[porco] backend=${backend} quality=${world?.quality ?? 'n/a'} post=${post ? 'on' : 'off'}`,
  );

  // QA hook: lets an automated browser check read the live scene without a console.
  (window as unknown as Record<string, unknown>).__porco = {
    backend,
    scene,
    camera,
    renderer: r,
    postSupported,
    get post() {
      return post;
    },
    get world() {
      return world;
    },
    get game() {
      return game;
    },
  };

  let last = performance.now();
  let elapsed = 0;
  const farField = initFarField(scene);
  let lastQuality: 'high' | 'low' = world?.quality ?? 'high';

  /**
   * One frame of the world. Factored out of the animation loop so a QA capture can advance the
   * world by an exact number of fixed steps instead of inheriting whatever wall-clock drift the
   * loop accumulated — measured frame metrics swing 2-4x with camera heading alone, so an
   * unfrozen capture cannot tell a shader change from a lucky camera angle.
   */
  const stepFrame = (dt: number): void => {
    const stepDt = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0;
    elapsed += stepDt;

    // The clouds are the only thing the world still drives; there is no sea tow and no
    // angular budget to feed any more (both died with `src/sea/` on 2026-11-06).
    world?.update(elapsed, stepDt);
    // 近景云的位置每帧被环面回收改写，所以白雾要读当帧的包围体，不能缓存。
    game?.setClouds(world?.blobs ?? []);
    game?.update(elapsed, stepDt);

    // The aircraft flies an unbounded line; the finite sky shell has to be towed
    // along with the camera or the camera simply leaves the world behind.
    const plane = game?.pose();
    const planeX = plane?.x ?? camera.position.x;
    const planeY = plane?.y ?? camera.position.y;
    const planeZ = plane?.z ?? camera.position.z;
    farField.update(camera.position.x, camera.position.z);

    if (post) {
      // DOF's circle of confusion is symmetric, so focus has to ride the aircraft: left on
      // the horizon, it would blur the nose the moment the camera pulls back.
      post.focusTo(camera.position, { x: planeX, y: planeY, z: planeZ });
      if (world && world.quality !== lastQuality) {
        lastQuality = world.quality;
        post.setQuality(lastQuality === 'high');
      }
      post.render(); // RenderPipeline takes no arguments; never call r.render() as well
    } else {
      r.render(scene, camera);
    }
  };

  // `?qa=frozen` suppresses the animation loop so captures are exactly reproducible.
  const qaFrozen = new URLSearchParams(location.search).get('qa') === 'frozen';
  const version = (THREE as { REVISION?: string }).REVISION ?? 'unknown';
  Object.assign((window as unknown as Record<string, Record<string, unknown>>).__porco, {
    qa: {
      frozen: qaFrozen,
      revision: version,
      get elapsed(): number {
        return elapsed;
      },
      step(count: number, dt: number = 1 / 60): number {
        for (let i = 0; i < count; i += 1) stepFrame(dt);
        return elapsed;
      },
      stepFrame,
      farField,
      // QA capture hook (plan Task 5): the governor path is unreachable in a
      // frozen capture, so low-quality frames need a direct lever.
      setQuality(high: boolean): void {
        world?.setQuality?.(high);
      },
      /** Everything a capture needs to be reproducible from its sidecar alone. */
      describe(): Record<string, unknown> {
        const p = game?.pose() ?? { x: 0, y: 0, z: 0 };
        // SC2: render diagnostics. The scorecard's "no render diagnostics" failure item asked
        // for an `inspect:canvas` equivalent; this repo has no browser-automation dependency,
        // so the probe rides on the QA hook that already exists. Read AFTER a render, or
        // `renderer.info` is still zeroed from the previous frame.
        const info = (renderer as unknown as {
          info?: { render?: Record<string, unknown>; memory?: Record<string, unknown> };
        }).info;
        const render = info?.render ?? {};
        const memory = info?.memory ?? {};
        return {
          revision: version,
          backend,
          post: Boolean(post),
          quality: world?.quality ?? 'n/a',
          elapsed: Number(elapsed.toFixed(4)),
          plane: [Number(p.x.toFixed(3)), Number(p.y.toFixed(3)), Number(p.z.toFixed(3))],
          camera: {
            pos: camera.position.toArray().map((v) => Number(v.toFixed(3))),
            fov: camera.fov,
            aspect: Number(camera.aspect.toFixed(4)),
          },
          canvas: [canvas.width, canvas.height],
          dpr: Number((window.devicePixelRatio ?? 1).toFixed(3)),
          ticker: {
            master: document.querySelectorAll('.porco-hud').length,
          },
          render: {
            available: Boolean(info),
            calls: render.calls ?? null,
            triangles: render.triangles ?? null,
            points: render.points ?? null,
            lines: render.lines ?? null,
            geometries: memory.geometries ?? null,
            textures: memory.textures ?? null,
          },
        };
      },
    },
  });

  if (!qaFrozen) {
    renderer.setAnimationLoop((now: number) => {
      const dtRaw = (now - last) / 1000;
      last = now;
      stepFrame(dtRaw);
    });
  }
}

boot().catch((err) => {
  console.error('[porco] boot failed', err);
  setStatus('renderer unavailable — check the console');
  statusEl.style.opacity = '1';
});
