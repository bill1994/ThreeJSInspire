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
 * The boot is WebGPU-only (see renderer.ts): a device without WebGPU fails loudly instead of
 * degrading onto a second code path. The boot label reports what actually mounted
 * (`sky + puffs`, or `sky only` if the puff field failed to build), so a missing feature is
 * visible on screen rather than inferred.
 */
import * as THREE from 'three';
import { createRenderer } from './renderer';
import { initSunsetLights } from './lights';
import { applySkyTrack, initSunsetSkyTSL, sunsetGradientTexture } from './sky-webgpu';
import { REFERENCE_ELEVATION_DEG, applyTrackPatch, skyTrackAt, type DebugTrackPatch, type Vec3 } from './sky-track';
import { seaHazeEndpoints } from './sky-color-js';
import { initStars } from './stars';
import { setVeilTintEndpoints } from './in-cloud';
import { sunDirectionFromAzEl } from './horizon';
import { SUN_DIRECTION } from './palettes';
import {
  formatColorRepro,
  parseCloudLook,
  parseDebugColor,
  parseDomeVisible,
  parseHazeLock,
  parseLinearVec3,
  parsePos,
  parsePuffVisible,
  parseSeaDebug,
  parseSeaNoChop,
  parseSeaVisible,
  parseSunOff,
  parseSunSpin,
  parseTrackPatch,
} from './qa';
import { initWorld, type WorldHandles } from './world';
import { initGame, type GameHandles } from './game';
import { comfortFromQuery } from './comfort';
import { initFarField } from './far-field';
import { createSunState } from './sun-state';
import { perPixelRadians } from './view-budget';
import { createFrameStats } from './frame-stats';
import { sunColorFor } from './dome-cloud-light';
import { initPost, usePost, type PostHandle } from './post';
import { portraitAspect } from './portrait';

const PORTRAIT = 9 / 16;

/** stepFrame 每帧派生 `headingRad` 用的模块级临时向量（零分配——热路径禁 new）。 */
const _viewDir = new THREE.Vector3();

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

  resize();
  window.addEventListener('resize', resize);

  // 活太阳：唯一的一份方向，sky / lights / sea 全部绑到同一个 Vector3 对象。
  // 对象永不替换，只原地改；`uniform()` 保留引用，所以三者不可能漂。
  // `?sun=az,el`（度）在启动时覆盖默认方向；仰角不钳制——昼夜轨道接管全仰角
  // （夜档 -8° 是合法采集态），灯的仰角在 syncSun 里单独钳 ≥ +2°。
  const sun = createSunState();
  const sunQa = new URLSearchParams(location.search).get('sun');
  if (sunQa) {
    const [azRaw, elRaw] = sunQa.split(',').map(Number);
    if (Number.isFinite(azRaw) && Number.isFinite(elRaw)) sun.setAzEl(azRaw, elRaw);
  }

  // 参考档 Preetham 参数（能量比率的分母）：轨道的恒等锚点，恒为参考太阳。
  const refP = skyTrackAt(REFERENCE_ELEVATION_DEG).preetham;

  // 星点层：opacity 由轨道 starOpacity 驱动（syncSun），far-field 按名单拖动。
  // 必须在 initFarField 之前挂进场景，否则 towed 名单里没有它。
  const stars = initStars(scene);

  // One TSL sky: node materials compile on the WebGPU backend only, and the
  // lighting rig stays shared with every other feature.
  const lights = initSunsetLights(scene);
  const skyTsl = await initSunsetSkyTSL(THREE, scene, sun.direction);

  try {
    world = await initWorld(scene, lights.sun, r, sun.direction);
  } catch (err) {
    console.warn('[porco] world unavailable, sky only', err);
    world = null;
  }

  // 抓帧钩子：?puff=0 整场藏云做 paired on/off，?pos=x,y,z 直接摆位，
  // ?sea=0 藏海，?sea=debug 进假色覆盖率模式，?sunspin=deg/s 让太阳匀速转
  // （默认 0），用来肉眼/抓帧验证「天空与海面太阳映射同步」；
  // ?sunoff=1 把云的太阳色项彻底归零（证伪开关，A/B 差分用）。
  const qaParams = new URLSearchParams(location.search);

  const puffVisible = parsePuffVisible(qaParams.get('puff'));
  const domeVisible = parseDomeVisible(qaParams.get('dome'));
  const qaPos = parsePos(qaParams.get('pos'));
  const sunSpinDegPerSec = parseSunSpin(qaParams.get('sunspin'));
  // ?sunoff=1（门 4 证伪开关，spec §11.2）：先把云的太阳色拍成全黑；syncSun
  // 里同一开关再挡掉逐帧 setSunColor，否则首帧就被轨道色盖回去。sunOff 是
  // syncSun 闭包外的 const——单光源原则不动，只归零 setSunColor 这一个消费端。
  const sunOff = parseSunOff(qaParams.get('sunoff'));
  // ?cloudlook=flat（P2 门 5，Task 6）：平顶四档看法；soft 是默认、画面与 P1.5
  // 一致。启动灌一次即可——uLook 是材质输出档位，syncSun 只动颜色不碰它。
  const cloudLook = parseCloudLook(qaParams.get('cloudlook'));
  if (!puffVisible) world?.setPuffVisible(false);
  if (!domeVisible) world?.setDomeVisible(false);
  if (!parseSeaVisible(qaParams.get('sea'))) world?.setSeaVisible(false);
  if (parseSeaDebug(qaParams.get('sea'))) world?.sea?.setDebug(true);
  if (parseSeaNoChop(qaParams.get('sea'))) world?.sea?.setChopGate(false);
  if (sunOff) world?.setSunColor([0, 0, 0]);
  world?.setCloudLook(cloudLook);

  // 启动条只报真正挂上去的东西：天穹永远在，海和云可能没建起来。
  const labelParts = ['sky'];
  if (world?.sea) labelParts.push('sea');
  if (world?.clouds) labelParts.push('puffs');
  if (world?.dome) labelParts.push('dome');
  const worldLabel = labelParts.join(' + ');

  try {
    game = await initGame({
      scene,
      camera,
      canvas,
      startY: spawnAltitude(location.search),
      // P1-3: comfort switches (?shake=reduced / ?flash=reduced) ride in on
      // the opts; game fans the shake scale out to feel and caps whiteout.
      comfort: comfortFromQuery(location.search),
      // 白纱着色读的是启动快照（云侧逻辑，本次范围外）；进云度回传给兜底瓣。
      sunDir: { x: sun.direction.x, y: sun.direction.y, z: sun.direction.z },
      onInCloud: (v, cam) => world?.setInterior?.(v, cam),
    });
    // FLT-02：移动端启动即 low——首帧前按 world 档对齐一次 feel 裁剪（world 可能 null，守住）。
    if (world) game.setQuality(world.quality === 'high');
    // 摆位必须等 game 存在之后；放在 initGame 之前那行会静默失效。
    if (qaPos) game.setPose(qaPos.x, qaPos.y, qaPos.z);
  } catch (err) {
    console.warn('[porco] game unavailable, free-look scene only', err);
    game = null;
  }

  if (usePost(location.search)) {
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

  setStatus(worldLabel, 6000);
  console.info(
    `[porco] quality=${world?.quality ?? 'n/a'} post=${post ? 'on' : 'off'}`,
  );

  // QA hook: lets an automated browser check read the live scene without a console.
  (window as unknown as Record<string, unknown>).__porco = {
    scene,
    camera,
    renderer: r,
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

  // 门 6 的帧时间基线；600 帧约等于 10-20 秒的窗口。
  const frameMs = createFrameStats(600);
  let last = performance.now();
  let elapsed = 0;
  const farField = initFarField(scene);
  let lastQuality: 'high' | 'low' = world?.quality ?? 'high';
  // -1 forces one sync on the first frame even for a frozen capture, so sky,
  // light rig and sea all start from the same direction.
  let lastSunVersion = -1;
  // Debug color panel（计划 2026-11-09 Task 1）：轨道补丁与海霾锁，只由下面 qa
  // 杠杆写入，syncSun 在三条件版本门后消费。默认路径（patch null + 未锁）与
  // 原单条件门控行为逐位一致：applyTrackPatch(state, null) 原样返回 state。
  let trackPatch: DebugTrackPatch | null = null;
  let hazeLocked = false;
  // 最后一次推送的海霾端点缓存：exportColorState 读这里（S5——不是重算，
  // 锁定后改过端点时重算值会对不上）。锁定时停止推送但缓存保留最后推送值。
  let hazeNow: Vec3 | null = null;
  let awayEdgeNow: Vec3 | null = null;
  let patchVersion = -1;
  let lastPatchVersion = -1;
  let hazeLockVersion = -1;
  let lastHazeLockVersion = -1;

  /**
   * Push the live sun into every consumer that needs an explicit update. The
   * sky and sea uniforms are ALSO bound to `sun.direction` by reference, so
   * this is a second, verifiable linkage path rather than a hidden alias.
   * Version-gated: a static sun costs nothing per frame.
   */
  const syncSun = (): void => {
    // 三条件版本门（debug color panel Task 1）：太阳、补丁、霾锁任一变化都触发
    // 一次全量推送；三者皆未变才跳过（原 sun.version 逻辑不变，两个新计数器并行）。
    if (
      sun.version === lastSunVersion &&
      patchVersion === lastPatchVersion &&
      hazeLockVersion === lastHazeLockVersion
    )
      return;
    lastSunVersion = sun.version;
    lastPatchVersion = patchVersion;
    lastHazeLockVersion = hazeLockVersion;
    // 昼夜轨道（day-night Task 7）：仰角 → 轨道状态 → 穹顶与海面共享的 uniform
    // 组（applySkyTrack）+ 灯光 + 海霾端点 + 星点 + 云调色，一次太阳版本变更全动。
    const liveY = Math.min(Math.max(sun.direction.y, -1), 1);
    const el = (Math.asin(liveY) * 180) / Math.PI;
    const state = applyTrackPatch(skyTrackAt(el), trackPatch);
    applySkyTrack(state);
    // 灯的仰角单独钳 ≥ +2°：?sun 不再钳制后 -8° 会把灯压到地平线下约 40 m、
    // 方向光从下往上打；颜色与强度交给轨道的 sunLight 字段。
    const lightEl = Math.max(el, 2);
    if (lightEl !== el) {
      const az = (Math.atan2(sun.direction.x, -sun.direction.z) * 180) / Math.PI;
      const [lx, ly, lz] = sunDirectionFromAzEl(az, lightEl);
      lights.setSunDirection(new THREE.Vector3(lx, ly, lz));
    } else {
      lights.setSunDirection(sun.direction);
    }
    lights.setSunLook(state.sunLightColorCss, state.sunLightIntensity);
    lights.setAmbience(state.hemiSkyCss, state.hemiGroundCss, state.hemiIntensity);
    skyTsl?.setSunDirection(sun.direction);
    world?.setSunDirection(sun.direction);
    // 海霾端点（S5/S4）：未锁定时每帧按轨道重算并推送，同时刷新闭包缓存；
    // 锁定（qa.lockHaze）后跳过推送——缓存保留最后一次推送值，exportColorState
    // 导出的就是画面上真实生效的端点，而不是「若未锁定本该推送的值」。
    if (!hazeLocked) {
      const { haze, awayEdge } = seaHazeEndpoints(
        state,
        [sun.direction.x, sun.direction.y, sun.direction.z],
        SUN_DIRECTION,
        refP,
      );
      hazeNow = haze;
      awayEdgeNow = awayEdge;
      world?.setHazeTargets(haze, awayEdge);
    }
    stars.setOpacity(state.starOpacity);
    world?.setCloudPalette(state.cloudBands, state.cloudHaze);
    // 云的太阳色随仰角走（复审 I1）：夜档不能拿一块黄昏暖色。
    // ?sunoff=1 时跳过——启动那次 [0,0,0] 才不会被逐帧轨道色盖回去。
    if (!sunOff) world?.setSunColor(sunColorFor(el));
    // 白纱纱色端点也随太阳轨道同步（原来只在启动时注入一次，运行时
    // 太阳转会过期——Minor 5 修此）。setVeilTintEndpoints 内部做线性→byte
    // 回转，veilTintCss 在 byte 空间 floor 插值，线性直灌会截成全黑。
    setVeilTintEndpoints(state.veilCool, state.veilWarm);
  };

  /**
   * One frame of the world. Factored out of the animation loop so a QA capture can advance the
   * world by an exact number of fixed steps instead of inheriting whatever wall-clock drift the
   * loop accumulated — measured frame metrics swing 2-4x with camera heading alone, so an
   * unfrozen capture cannot tell a shader change from a lucky camera angle.
   */
  const stepFrame = (dt: number): void => {
    const stepDt = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0;
    elapsed += stepDt;
    frameMs.push(stepDt * 1000);

    // QA lever: rotate the sun at a fixed rate so the sky disc and the sea's
    // sun road can be watched moving together. Deterministic under qa.step().
    if (sunSpinDegPerSec !== 0) sun.rotateAzimuth(sunSpinDegPerSec * stepDt);

    // The sky disc/glow, the DirectionalLight and all four sea rings follow one
    // sun state. Called every frame but only does work when the sun changed.
    syncSun();

    // The view budget is derived per frame from the live camera fov and the
    // drawing-buffer height, so a FOV kick or DPR change re-derives it for free.
    const radPerPixel = perPixelRadians(camera.fov, canvas.height);
    // 航向 yaw：0 = −Z、右转为负（与 game.ts 同约定）；地平线 patch 的朝向滑窗读它。
    camera.getWorldDirection(_viewDir);
    const headingRad = Math.atan2(-_viewDir.x, -_viewDir.z);
    world?.update(elapsed, stepDt, {
      camera: camera.position,
      radPerPixel,
      headingRad,
      // P2-3：game 的速度（上一帧的值——15% 高光浮动看不见 1 帧滞后）。
      speed01: game?.pose?.().speed01 ?? 0,
    });
    // 近景云的位置每帧被环面回收改写，所以白雾要读当帧的包围体，不能缓存。
    game?.setClouds(world?.blobs ?? []);
    game?.update(elapsed, stepDt);

    // The aircraft flies an unbounded line; the finite sky shell has to be towed
    // along with the camera or the camera simply leaves the world behind.
    const plane = game?.pose();
    const planeX = plane?.x ?? camera.position.x;
    const planeY = plane?.y ?? camera.position.y;
    const planeZ = plane?.z ?? camera.position.z;
    // Full 3D tow: the dome shades with normalize(positionWorld - cameraPosition),
    // so its centre must sit exactly on the eye or the painted sky and the sea's
    // reflected sky differ by a fixed vertical parallax.
    farField.update(camera.position.x, camera.position.z, camera.position.y, _viewDir.x, _viewDir.z, elapsed);

    if (post) {
      // DOF's circle of confusion is symmetric, so focus has to ride the aircraft: left on
      // the horizon, it would blur the nose the moment the camera pulls back.
      post.focusTo(camera.position, { x: planeX, y: planeY, z: planeZ });
      if (world && world.quality !== lastQuality) {
        lastQuality = world.quality;
        post.setQuality(lastQuality === 'high');
        // FLT-02：governor/移动端降档走 world.applyQuality，此处是唯一自动路径——同步扇出到 feel 裁剪（game 可能为 null，用可选链）。
        game?.setQuality(lastQuality === 'high');
      }
      post.render(); // RenderPipeline takes no arguments; never call r.render() as well
    } else {
      r.render(scene, camera);
    }
  };

  // `?qa=frozen` suppresses the animation loop so captures are exactly reproducible.
  const qaFrozen = new URLSearchParams(location.search).get('qa') === 'frozen';
  const version = (THREE as { REVISION?: string }).REVISION ?? 'unknown';
  const qa = {
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
    /** 门 6：帧时间分位数（毫秒）。 */
    frameStats(): { count: number; mean: number; p50: number; p95: number } {
      return {
        count: frameMs.count,
        mean: frameMs.mean,
        p50: frameMs.percentile(50),
        p95: frameMs.percentile(95),
      };
    },
    farField,
    // QA capture hook (plan Task 5): the governor path is unreachable in a
    // frozen capture, so low-quality frames need a direct lever. P1-1: feel
    // (spray + mist) belongs to game, not world — the tier fans out to both.
    setQuality(high: boolean): void {
      world?.setQuality?.(high);
      game?.setQuality(high);
    },
    // Live sun levers (2026-11-08 linkage review): rotate the sun at runtime
    // and watch the sky disc, glow and the sea's sun road move together.
    setSun(azDeg: number, elDeg: number): void {
      sun.setAzEl(azDeg, elDeg);
      syncSun();
    },
    rotateSun(deg: number): void {
      sun.rotateAzimuth(deg);
      syncSun();
    },
    getSun(): ReturnType<typeof sun.snapshot> {
      return sun.snapshot();
    },
    // ---- debug color panel levers（计划 2026-11-09 Task 1；表现层只经这组
    // 杠杆，不直碰 uniform / world 句柄——R13）----
    // 轨道补丁：整字段替换语义；写闭包并递增 patchVersion，下一个 syncSun 生效。
    setTrackPatch(p: DebugTrackPatch | null): void {
      trackPatch = p;
      patchVersion += 1;
    },
    // 海霾锁（S4）：锁定后 syncSun 跳过端点推送；warn 只在状态翻转时打一次
    // （逐帧 warn 禁止）。消息按方向分支：ON = 端点停在最后推送值，OFF = 端点
    // 恢复随 syncSun 逐帧重算。
    lockHaze(on: boolean): void {
      if (on !== hazeLocked) {
        console.warn(
          on
            ? '[qa] haze lock ON — sea haze endpoints stay at the last pushed values'
            : '[qa] haze lock OFF — sea haze endpoints resume following syncSun recomputation',
        );
      }
      hazeLocked = on;
      hazeLockVersion += 1;
    },
    // 调试端点（R13/S5）：透传 world.setHazeTargets，同时写闭包缓存——
    // exportColorState 导出的就是这里写下的值。
    setHazeEndpoints(haze: Vec3, awayEdge: Vec3): void {
      hazeNow = haze;
      awayEdgeNow = awayEdge;
      world?.setHazeTargets(haze, awayEdge);
    },
    // 复现闭环（R14）：haze/awayEdge 读闭包缓存而非重算（S5——锁定后改过端点
    // 时，重算只代表「若未锁定本该推送的值」，对不上画面）。
    exportColorState(): {
      sun: { az: number; el: number };
      patch: DebugTrackPatch | null;
      hazeLocked: boolean;
      haze: Vec3 | null;
      awayEdge: Vec3 | null;
      repro: string;
    } {
      const snap = sun.snapshot();
      return {
        sun: { az: snap.azimuthDeg, el: snap.elevationDeg },
        patch: trackPatch,
        hazeLocked,
        haze: hazeNow,
        awayEdge: awayEdgeNow,
        repro: formatColorRepro(snap.azimuthDeg, snap.elevationDeg, trackPatch, hazeLocked, hazeNow, awayEdgeNow),
      };
    },
    // ?sea=nochop 的运行时写入口（R13）；nochop 必须可恢复（小项 i）。
    setChopGate(on: boolean): void {
      world?.sea?.setChopGate(on);
    },
    clearChopGate(): void {
      world?.sea?.clearChopGate();
    },
    // Task 4's GPU IFFT self-check, callable from a real browser: the t=0
    // height field must match the CPU oracle and the sea must move by t=5.
    async selfCheck(): Promise<number> {
      const mod = await import('./sea/fft-gpu');
      return mod.selfCheck(r, 16);
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
        post: Boolean(post),
        quality: world?.quality ?? 'n/a',
        elapsed: Number(elapsed.toFixed(4)),
        sun: {
          azimuthDeg: Number(sun.azimuthDeg.toFixed(3)),
          elevationDeg: Number(sun.elevationDeg.toFixed(3)),
          direction: sun.direction.toArray().map((v) => Number(v.toFixed(5))),
          version: sun.version,
          spinDegPerSec: sunSpinDegPerSec,
        },
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
  };
  Object.assign((window as unknown as Record<string, Record<string, unknown>>).__porco, { qa });

  // ?debug=color 的 URL 通道（R14/S4/S13）：必须在 qa 对象创建之后——上面的
  // qaParams 块（启动早期）时 qa 还没定义（S13/TDZ）。顺序固定先端点后锁：
  // 先锁会把首帧 syncSun 的端点推送挡掉，海面拿的是模块默认端点（S4）。
  // 解析失败一律 null + console.warn，绝不抛错中断启动。
  const urlPatch = parseTrackPatch(qaParams.get('trackpatch'));
  if (urlPatch) {
    qa.setTrackPatch(urlPatch);
  } else if (qaParams.get('trackpatch') !== null) {
    // 旧版 repro 对 null patch 拼过 trackpatch=null 占位段（formatColorRepro 已
    // 改为整段省略）：'null'/空串等价于无补丁（fresh 加载即默认轨道），静默跳过。
    const rawTrackpatch = qaParams.get('trackpatch') ?? '';
    if (rawTrackpatch !== '' && rawTrackpatch.trim() !== 'null') {
      console.warn('[porco] ?trackpatch unparseable — ignored');
    }
  }
  const urlHaze = parseLinearVec3(qaParams.get('haze'));
  const urlAway = parseLinearVec3(qaParams.get('away'));
  if (urlHaze && urlAway) {
    qa.setHazeEndpoints(urlHaze, urlAway);
  } else if (qaParams.get('haze') !== null || qaParams.get('away') !== null) {
    console.warn('[porco] ?haze/?away incomplete or unparseable — ignored');
  }
  if (parseHazeLock(qaParams.get('hazelock'))) qa.lockHaze(true);

  // ?debug=color 面板（计划 2026-11-09 Task 2）：动态 import——模块本身与挂载
  // 失败都不得影响游戏本体（约束①：catch + console.error，游戏继续）。同样必须
  // 在 qa 对象创建之后（S13/TDZ——qaParams 块时 qa 还没定义）。
  if (parseDebugColor(qaParams.get('debug'))) {
    try {
      const { mountColorPanel } = await import('./debug/color-panel');
      mountColorPanel(qa);
    } catch (err) {
      console.error('[porco] ?debug=color panel failed to mount — game continues', err);
    }
  }

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
