/**
 * src/main.ts — composition root. Owns the scene, the camera and the frame loop;
 * everything else is mounted through src/world.ts (sea + clouds), src/game.ts
 * (plane + input + camera rig + feel + HUD + audio).
 *
 * Boot is defensive on purpose: a failed WebGPU probe, a failed FFT sea, a missing GLB
 * or a blocked AudioContext each degrade one feature, never the whole page — the plan's
 * review gate is "no-WebGPU device still shows sky + sea + clouds, never a black screen".
 *
 * Both backends run the same TSL code now (WebGPURenderer with `forceWebGL` for WebGL2), so
 * there is one sky, one sea and one cloud implementation instead of two parallel ones.
 */
import * as THREE from 'three';
import { createRenderer, type Backend } from './renderer';
import { initSunsetLights } from './lights';
import { initSunsetSkyTSL, sunsetGradientTexture } from './sky-webgpu';
import { initWorld, type WorldHandles } from './world';
import { initGame, type GameHandles } from './game';
import { initFarField } from './far-field';
import { initPost, usePost } from './post';

const PORTRAIT = 9 / 16;

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
  const aspect = w / h;
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
  initSunsetLights(scene);
  await initSunsetSkyTSL(THREE, scene);

  try {
    world = await initWorld(scene);
  } catch (err) {
    console.warn('[porco] world unavailable, sky only', err);
    world = null;
  }

  const worldLabel = world ? `${world.seaKind} sea · ${world.cloudKind} clouds` : 'sky only';

  try {
    game = await initGame({ scene, camera, canvas, backend });
  } catch (err) {
    console.warn('[porco] game unavailable, free-look scene only', err);
    game = null;
  }

  setStatus(`${backend} · ${worldLabel}`, 6000);
  console.info(`[porco] backend=${backend} sea=${world?.seaKind ?? 'none'} clouds=${world?.cloudKind ?? 'none'} quality=${world?.quality ?? 'n/a'} post=${postSupported ? 'on' : 'off'}`);

  // QA hook: lets an automated browser check read the live scene without a console.
  (window as unknown as Record<string, unknown>).__porco = {
    backend,
    scene,
    camera,
    renderer: r,
    postSupported,
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

  // The post pipeline needs the TSL pipeline, which only the WebGPURenderer paths provide.
  const post = usePost(location.search) && postSupported ? initPost(r, scene, camera) : null;
  if (post) {
    // Portrait HalfFloat target at dpr 2 reaches 2880x5120 and bloom alone costs ~15 ms there.
    r.setPixelRatio?.(Math.min(window.devicePixelRatio || 1, 1.5));
  }
  let lastQuality: 'high' | 'low' = world?.quality ?? 'high';

  renderer.setAnimationLoop((now: number) => {
    const dtRaw = (now - last) / 1000;
    last = now;
    const dt = Number.isFinite(dtRaw) && dtRaw > 0 ? Math.min(dtRaw, 0.1) : 0;
    elapsed += dt;

    world?.update(elapsed, dt);
    game?.update(elapsed, dt);

    // The aircraft flies an unbounded line; the finite ocean patch, cloud shell and sky shell
    // have to be towed along with it or the camera simply leaves the world behind.
    const plane = game?.pose();
    const planeX = plane?.x ?? camera.position.x;
    const planeY = plane?.y ?? camera.position.y;
    const planeZ = plane?.z ?? camera.position.z;
    farField.update(camera.position.x, camera.position.z, planeX, planeZ);

    if (post) {
      // DOF's circle of confusion is symmetric, so focus has to ride the aircraft: left on the
      // sea, it would blur the nose the moment the camera pulls back.
      post.focusTo(camera.position, { x: planeX, y: planeY, z: planeZ });
      if (world && world.quality !== lastQuality) {
        lastQuality = world.quality;
        post.setQuality(lastQuality === 'high');
      }
      post.render(); // RenderPipeline takes no arguments; never call r.render() as well
    } else {
      r.render(scene, camera);
    }
  });
}

boot().catch((err) => {
  console.error('[porco] boot failed', err);
  setStatus('renderer unavailable — check the console');
  statusEl.style.opacity = '1';
});
