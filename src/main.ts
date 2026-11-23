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
import { parseBgLook, parseBgShape } from './bg-cumulus-paint';
import { parseSeaLook, parseSeaDiagnostic } from './sea/look';
import { parseHeadlightMode, type HeadlightMode } from './headlight';
import { createRenderer } from './renderer';
import { initSunsetLights } from './lights';
import { applySkyTrack, initSunsetSkyTSL, setToon, sunsetGradientTexture } from './sky-webgpu';
import { REFERENCE_ELEVATION_DEG, applyToonLook, applyTrackPatch, skyTrackAt, type DebugTrackPatch, type Vec3 } from './sky-track';
import { seaHazeEndpoints } from './sky-color-js';
import { initStars } from './stars';
import { setVeilTintEndpoints } from './in-cloud';
import { sunDirectionFromAzEl } from './horizon';
import { SUN_DIRECTION } from './palettes';
import { dayNightLightDirection } from './daylight';
import { atmosphere } from './archipelago-light';
import { applySceneGrade } from './scene-grade';
import {
  formatColorRepro,
  parseBloomThreshold,
  parseCamRaw,
  parseDebugColor,
  parseDofEnabled,
  parseFov,
  parseHazeLock,
  parseLinearVec3,
  parsePaletteName,
  parsePos,
  parsePostFxName,
  parsePuffVisible,
  parsePuffLook,
  parseSeaDebug,
  parseSeaNoChop,
  parseSeaVisible,
  parseSunOff,
  parseSunSpin,
  parseToon,
  parseTod,
  parseTodSpeed,
  parseTrackPatch,
  parseBakeQuality,
  parseBgForce,
  resolveBgVisible,
  visualQuery,
} from './qa';
import { moonDirectionFor, resolveStaticTodSun, solarAzimuthFor, solarElevationFor, TOD_DEFAULT_H } from './time-of-day';
// 标定台夹具（bg-cumulus Task 2）：?bgforce=single 时构造已知云喂给 initWorld。
// 模块本体 import-side-effect-free（three/webgpu|tsl 都在 initBgCumulus 函数体内
// 动态 import），静态拉进主图不破坏 module-graph 守卫。
import { singleCloudLayout } from './bg-cumulus';
import { bootLabelFor, initWorld, type WorldHandles } from './world';
import { initGame, type GameHandles } from './game';
import { comfortFromQuery } from './comfort';
import { initFarField } from './far-field';
import { createSunState } from './sun-state';
import { perPixelRadians } from './view-budget';
import { createFrameStats } from './frame-stats';
import { sunColorFor } from './sun-color';
import { initPost, usePost, type PostHandle } from './post';
import { portraitAspect } from './portrait';
import { camPreset, palettePreset, paletteToTrackPatch, postPreset } from './visual-presets';

const PORTRAIT = 9 / 16;

/** stepFrame 派生视图方向用的模块级临时向量（零分配——热路径禁 new）。 */
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
const loadingScreen = document.getElementById('flight-loading');
const loadingStage = document.getElementById('loading-stage');
const loadingProgress = document.querySelector<HTMLProgressElement>('#loading-progress');
const loadingRetry = document.getElementById('loading-retry');
loadingRetry?.addEventListener('click', () => location.reload());

function setLoadingStage(completed: number, message: string): void {
  if (loadingProgress) loadingProgress.value = completed;
  if (loadingStage) loadingStage.textContent = message;
}

const scene = new THREE.Scene();
// Background colour doubles as the safety net: if the sky dome material cannot render on
// the active backend, the horizon is still sunset-warm instead of black.
scene.background = new THREE.Color('#a86a86');
scene.fog = new THREE.Fog('#c96a7a', 60, 700);

const camera = new THREE.PerspectiveCamera(
  parseFov(new URLSearchParams(location.search).get('fov')) ?? 60,
  PORTRAIT,
  0.1,
  2000,
);
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
  backend?: { device?: { queue: { onSubmittedWorkDone(): Promise<void> } } };
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  compileAsync?(object: THREE.Object3D, camera: THREE.Camera, scene: THREE.Scene): Promise<unknown>;
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
  setLoadingStage(0, '正在初始化 WebGPU');
  const created = await createRenderer(canvas);
  const r = created.renderer as Renderer;
  renderer = r;

  resize();
  window.addEventListener('resize', resize);
  setLoadingStage(1, '正在生成航线场景');

  // 活太阳：唯一的一份方向，sky / lights / sea 全部绑到同一个 Vector3 对象。
  // 对象永不替换，只原地改；`uniform()` 保留引用，所以三者不可能漂。
  // `?sun=az,el`（度）在启动时覆盖默认方向；仰角不钳制——昼夜轨道接管全仰角
  // （夜档 -8° 是合法采集态），灯的仰角在 syncSun 里单独钳 ≥ +2°。
  const sun = createSunState();
  // `?tod=<0..24>` 静态接线（day-night planB Phase 1 Task 3，B2）：与 ?sun= 共用
  // 同一条启动路径（setAzEl 版本递增 → 首帧 syncSun 扇出轨道/霾/灯/云）。裁决在
  // resolveStaticTodSun：?sun= 真应用时 ?tod= 让位（优先级 ?sun= 胜 ?tod=，与参数
  // 在 URL 里的先后顺序无关——URLSearchParams 按名取值）；?tod= 缺省/非法时返回
  // null，太阳方向留在 SUN_POSITION 默认（「无参数 = 无消费」，t0 逐位不变）。
  // 必须在 initSunsetSkyTSL/initWorld/initGame 之前：initGame 的白纱 sunDir
  // 启动快照要看到 tod 方向。
  const urlParams = new URLSearchParams(location.search);
  const islandExperiment = {
    requested: urlParams.get('land') === 'single',
    seed: urlParams.has('seed') && Number.isSafeInteger(Number(urlParams.get('seed'))) ? Number(urlParams.get('seed')) : 20261120,
  };
  atmosphere.enabled=urlParams.get('atmosphere')!=='0' && urlParams.get('land')==='archipelago';
  atmosphere.phase=(islandExperiment.seed%241)*.17;
  let cloudProximity = 0;
  const routeName = urlParams.get('pass');
  const pass = islandExperiment.requested && (routeName === 'grass' || routeName === 'canopy' || routeName === 'sand')
    ? routeName : null;
  const route = pass ? (await import('./land/airflow')).PASSES[pass] : null;
  const look = urlParams.get('grasslook') ?? 'paint';
  const meadow = look !== 'previous';
  const fieldSun = meadow && look !== 'meadow' ? sun.direction : undefined;
  const island = islandExperiment.requested
    ? await (await import('./land/island')).mountIsland(scene,islandExperiment.seed,!!route || urlParams.get('flora') === 'on',meadow,fieldSun) : null;
  const landMode = urlParams.get('land');
  const aerialPass = landMode === 'archipelago' && routeName === 'aerial';
  const treeParam = urlParams.get('treelook');
  const treeLook = treeParam === 'baked' || treeParam === 'coastal' ? treeParam : 'original';
  const fadeTreeLod = urlParams.get('treelod') !== 'hard';
  const meadowPass = landMode === 'archipelago' && (routeName === 'meadow' || aerialPass);
  const start = parsePos(urlParams.get('pos')) ?? (aerialPass ? {x:72,y:110,z:275} : meadowPass ? {x:-45,y:16,z:50} : route);
  const archipelago = landMode === 'archipelago' || landMode === 'cluster'
    ? await (await import('./land/archipelago')).mountArchipelago(scene,islandExperiment.seed,landMode === 'cluster',start ?? undefined,meadow,fieldSun,treeLook,fadeTreeLod) : null;
  let cpuSubmitMs = 0;
  const sunQa = urlParams.get('sun');
  let sunApplied = false;
  if (sunQa) {
    const [azRaw, elRaw] = sunQa.split(',').map(Number);
    if (Number.isFinite(azRaw) && Number.isFinite(elRaw)) {
      sun.setAzEl(azRaw, elRaw);
      sunApplied = true;
    }
  }
  const todQa = parseTod(urlParams.get('tod'));
  const todBoot = resolveStaticTodSun(todQa, sunApplied);
  if (todBoot) sun.setAzEl(todBoot.az, todBoot.el);

  // 参考档 Preetham 参数（能量比率的分母）：轨道的恒等锚点，恒为参考太阳。
  const refP = skyTrackAt(REFERENCE_ELEVATION_DEG).preetham;

  // 星点层：opacity 由轨道 starOpacity 驱动（syncSun），far-field 按名单拖动。
  // 必须在 initFarField 之前挂进场景，否则 towed 名单里没有它。
  const stars = initStars(scene);

  // One TSL sky: node materials compile on the WebGPU backend only, and the
  // lighting rig stays shared with every other feature.
  const lights = initSunsetLights(scene);
  // ?bg=（?dome= 别名）/?bgq= 解析前移（bg-cumulus Task 5，§裁定 7）：sky 的
  // cloudOn 初值与 world 的烘焙分辨率都要在挂载前知道。
  const qaParamsEarly = visualQuery(location.search);
  const bgVisible = resolveBgVisible(qaParamsEarly.get('bg'), qaParamsEarly.get('dome'));
  const bgQuality = parseBakeQuality(qaParamsEarly.get('bgq'));
  // ?bgforce=single（标定台，bg-cumulus Task 2）：一朵已知 az/el/dist/尺寸的云
  // 整个换掉 seed 环排布，探针在它上面标定方位与角宽。字面量与探针匹配侧
  // （scripts/cloud-probe.mjs 的 probeMetricsFn）同一组——改一处必须同步另一处。
  const bgForce = parseBgForce(qaParamsEarly.get('bgforce'));
  const bgAzRaw = qaParamsEarly.get('bgaz');
  const bgAz = bgAzRaw !== null && bgAzRaw.trim() !== '' && Number.isFinite(Number(bgAzRaw))
    ? Number(bgAzRaw) : 90;
  const skyTsl = await initSunsetSkyTSL(THREE, scene, sun.direction, 800, { cloudVisible: bgVisible });

  try {
    // ⚠️ opts 是 initWorld 的第 5 位形参：挪位不会报错，bgForceLayout 会静默丢失
    // （tsc 全绿但探针永远量不到标定云）——改调用形态前先数参数。
    world = await initWorld(scene, lights.sun, r, sun.direction, {
      coast: archipelago?.coast ?? island?.coast,
      bgVisible,
      relaxedScatter: qaParamsEarly.get('scatterstage') !== 'previous',
      bgQuality,
      bgSpatial: qaParamsEarly.get('bgmotion') !== 'fixed' && bgForce !== 'single',
      cloudComposition: qaParamsEarly.get('cloudlayout') !== 'legacy',
      bgLook: parseBgLook(qaParamsEarly.get('bglook')),
      puffLook: parsePuffLook(qaParamsEarly.get('pufflook')),
      bgShape: parseBgShape(qaParamsEarly.get('bgshape')),
      bgReplaceStrips: qaParamsEarly.get('bgwrite') === 'replace',
      bgForceLayout: bgForce === 'single' ? singleCloudLayout(bgAz, 10, 5000, 2000, 600) : undefined,
      onBgVisibilityChange: (v) => skyTsl?.setCloudOn(v),
    });
    // 云立方换装：uniform 换值零重编译（§裁定 7）；挂载失败 → null = 黑立方占位。
    skyTsl?.setCloudTexture(world.cloudTexture);
    if (archipelago) world.sea?.attachLandReflection(archipelago.reflections);
  } catch (err) {
    console.warn('[porco] world unavailable, sky only', err);
    world = null;
    skyTsl?.setCloudTexture(null);
  }

  // 抓帧钩子：?puff=0 整场藏云做 paired on/off，?pos=x,y,z 直接摆位，
  // ?sea=0 藏海，?sea=debug 进假色覆盖率模式，?sunspin=deg/s 让太阳匀速转
  // （默认 0），用来肉眼/抓帧验证「天空与海面太阳映射同步」；
  // ?sunoff=1 是云太阳色项的证伪开关——对背景云已随 bg-cloud 层退场空转
  // （bg-cumulus Task 5），等效杠杆待 Task 6 重立。
  const qaParams = qaParamsEarly;

  const puffVisible = parsePuffVisible(qaParams.get('puff'));
  const qaPos = parsePos(qaParams.get('pos')) ?? start;
  const sunSpinDegPerSec = parseSunSpin(qaParams.get('sunspin'));
  // ?sunoff=1（门 4 证伪开关）：world.setSunColor 自 bg-cumulus Task 5 起为
  // no-op（旧层太阳色项已随层退场），本通道保留、对新层空转；等效杠杆待
  // Task 6 重立。sunOff 是 syncSun 闭包外的 const。
  const sunOff = parseSunOff(qaParams.get('sunoff'));
  if (!puffVisible) world?.setPuffVisible(false);
  if (!bgVisible) world?.setBgVisible(false);
  // ?bgdbg=3/4（Marble取证：3原P着色对照、4=A粗march，0/缺省正常出图）
  const bgdbgRaw = qaParams.get('bgdbg');
  const bgdbg = bgdbgRaw === null ? 0 : Math.trunc(Number(bgdbgRaw));
  if (Number.isFinite(bgdbg) && bgdbg !== 0) world?.setBgDebug?.(bgdbg);
  if (!parseSeaVisible(qaParams.get('sea'))) world?.setSeaVisible(false);
  if (parseSeaDebug(qaParams.get('sea'))) world?.sea?.setDebug(true);
  if (parseSeaNoChop(qaParams.get('sea'))) world?.sea?.setChopGate(false);
  world?.sea?.setLook(parseSeaLook(qaParams.get('sealook')), parseSeaDiagnostic(qaParams.get('seadiag')), qaParams.get('seastage') !== 'previous');
  world?.sea?.setCloudReflection(qaParams.get('reflectionstage') !== 'previous' && parseSeaLook(qaParams.get('sealook')) === 'painted');
  world?.sea?.setNightCloudReflection(qaParams.get('nightreflection') !== 'previous');
  world?.sea?.setObjectReflection(qaParams.get('objectreflection') !== 'off');
  world?.sea?.setPuffReflectionSoft(qaParams.get('puffreflection') !== 'previous');
  if (sunOff) world?.setSunColor([0, 0, 0]);
  // ?toon=（toon-look Phase 1 Task 1）：uToon 总闸 0..1，启动期一次注入共享
  // uniform 组（原 dome 链经 getSharedToonUniform 直读；体积层删除后天穹直读）。
  // Task 0 基准帧 A/B 回归证明「注入无副作用」；Task 4 起 syncSun 同时消费
  // toonAmount 作轨道底色层（applyToonLook，只动 cloudBands/cloudHaze）——
  // 总闸数值只在启动与 qa.setToon 两处写。
  let toonAmount = parseToon(qaParams.get('toon'));
  setToon(toonAmount);
  // ?tod / ?todspeed（day-night planB Phase 1 Task 1 解析、Task 3 接线）：?tod 的
  // 启动消费已在上方 sun 块裁决过（resolveStaticTodSun，?sun= 胜）；这里的闭包
  // 状态是运行时杠杆与期 2 推进的基点——tod 非法/缺省回退反解默认 TOD_DEFAULT_H，
  // ?todspeed 保持只写（B2 纪律：写了不推进，期 2 才消费）。
  let tod = todQa ?? TOD_DEFAULT_H;
  let todSpeed = parseTodSpeed(qaParams.get('todspeed'));
  let selectTimeFromUi = (_h: number): void => {};
  let selectHeadlightFromUi = (_mode: HeadlightMode): void => {};
  world?.headlight?.setMode(parseHeadlightMode(qaParams.get('headlight')));

  // 启动条只报真正挂上去的东西（bootLabelFor 在 world.ts，可单测）：
  // 天穹永远在，海和云可能没建起来。
  const worldLabel = bootLabelFor({ sky: true, sea: !!world?.sea, puffs: !!world?.clouds });

  setLoadingStage(2, '正在载入飞机');
  try {
    game = await initGame({
      groundHeight: archipelago?.heightAt ?? island?.terrain.heightAt,
      motionRefined:qaParams.get('motionstage') !== 'previous',
      headlight: { get: () => world?.headlight?.mode ?? 'off', set: (mode) => selectHeadlightFromUi(mode) },
      timeOfDay: {
        get: () => tod,
        set: (h) => selectTimeFromUi(h),
      },
      scene,
      camera,
      canvas,
      startY: spawnAltitude(location.search) ?? (island || archipelago ? 70 : undefined),
      // Free-play chase framing (`?cam=<preset|dist,height>`): distance/height
      // only — fovKick/bankFollow stay director-driven per frame.
      camTuning: camPreset(parseCamRaw(qaParams.get('cam'))) ?? undefined,
      // P1-3: comfort switches (?shake=reduced / ?flash=reduced) ride in on
      // the opts; game fans the shake scale out to feel and caps whiteout.
      comfort: comfortFromQuery(location.search),
      volumeClouds: parsePuffLook(qaParams.get('pufflook')) === 'volume',
      // 白纱着色读的是启动快照（云侧逻辑，本次范围外）；进云度回传给兜底瓣。
      sunDir: sun.direction,
      onInCloud: (v, cam) => {
        cloudProximity = v;
        world?.setInterior?.(v, cam);
      },
    });
    // FLT-02：移动端启动即 low——首帧前按 world 档对齐一次 feel 裁剪（world 可能 null，守住）。
    if (world) game.setQuality(world.quality === 'high');
    // 摆位必须等 game 存在之后；放在 initGame 之前那行会静默失效。
    if (qaPos) game.setPose(qaPos.x, qaPos.y, qaPos.z);
  } catch (err) {
    console.warn('[porco] game unavailable, free-look scene only', err);
    game = null;
  }

  setLoadingStage(3, '正在准备画面效果');
  if (usePost(location.search)) {
    try {
      // Size first, build second: the pipeline sizes its own render targets from the drawing
      // buffer it sees when it builds, so a buffer that changes afterwards leaves them stale.
      // Portrait HalfFloat target at dpr 2 reaches 2880x5120 and bloom alone costs ~15 ms there.
      r.setPixelRatio?.(Math.min(window.devicePixelRatio || 1, 1.5));
      resize();
      post = await initPost(r, scene, camera);
      post.setQuality((world?.quality ?? 'high') === 'high');
      // Free-play post (`?postfx=<sunset|glowSoft|crisp|noDof>`, `?bloom=<0..1>`,
      // `?dof=0|1`): preset first, single-knob overrides on top. Unknown preset
      // names fall back to sunset — the shipped frame is always recoverable.
      {
        const presetName = parsePostFxName(qaParams.get('postfx'));
        if (presetName) post.setFx({ ...postPreset(presetName) });
        const bloomOverride = parseBloomThreshold(qaParams.get('bloom'));
        const dofOverride = parseDofEnabled(qaParams.get('dof'));
        if (bloomOverride !== null || dofOverride !== null) {
          post.setFx({
            ...(bloomOverride !== null ? { bloomThreshold: bloomOverride } : {}),
            ...(dofOverride !== null
              ? { dof: dofOverride, bokehScale: dofOverride ? 1.1 : 0.6 }
              : {}),
          });
        }
      }
      // `initWorld` may already have stepped a phone down before the pipeline existed. Starting
      // the pipeline on the tier the world is really on is what makes the first transition —
      // and every later one — reachable; the loop only reacts to changes.
    } catch (err) {
      console.warn('[porco] post unavailable, rendering direct', err);
      post = null;
    }
  }

  console.info(
    `[porco] quality=${world?.quality ?? 'n/a'} post=${post ? 'on' : 'off'}`,
  );

  if (archipelago) await r.compileAsync?.(archipelago.treePreview,camera,scene);

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
    island, archipelago,
  };

  // 门 6 的帧时间基线；600 帧约等于 10-20 秒的窗口。
  const frameMs = createFrameStats(600);
  let last = NaN;
  let elapsed = 0;
  const farField = initFarField(scene, new URLSearchParams(location.search).get('scatterstage') !== 'previous', archipelago?.heightAt ?? island?.terrain.heightAt);
  let lastQuality: 'high' | 'low' = world?.quality ?? 'high';
  // -1 forces one sync on the first frame even for a frozen capture, so sky,
  // light rig and sea all start from the same direction.
  let lastSunVersion = -1;
  // Debug color panel（计划 2026-11-09 Task 1）：轨道补丁与海霾锁，只由下面 qa
  // 杠杆写入，syncSun 在三条件版本门后消费。默认路径（patch null + 未锁）与
  // 原单条件门控行为逐位一致：applyTrackPatch(state, null) 原样返回 state。
  let trackPatch: DebugTrackPatch | null = null;
  let colorGrade = qaParams.get('colorstage') !== 'previous';
  let hazeLocked = false;
  // 最后一次推送的海霾端点缓存：exportColorState 读这里（S5——不是重算，
  // 锁定后改过端点时重算值会对不上）。锁定时停止推送但缓存保留最后推送值。
  let hazeNow: Vec3 | null = null;
  let awayEdgeNow: Vec3 | null = null;
  let patchVersion = -1;
  let lastPatchVersion = -1;
  let hazeLockVersion = -1;
  let lastHazeLockVersion = -1;
  // toon-look Phase 1 Task 4：toon 总闸的版本计数（qa.setToon 递增）——轨道底色层
  // 的 cloudBands/cloudHaze 扇出在 syncSun 里，总闸变了必须触发一次全量推送。
  let toonVersion = 0;
  let lastToonVersion = -1;

  /**
   * Push the live sun into every consumer that needs an explicit update. The
   * sky and sea uniforms are ALSO bound to `sun.direction` by reference, so
   * this is a second, verifiable linkage path rather than a hidden alias.
   * Version-gated: a static sun costs nothing per frame.
   */
  const syncSun = (): void => {
    // 四条件版本门（debug color panel Task 1 + toon-look Task 4）：太阳、补丁、霾锁、
    // toon 总闸任一变化都触发一次全量推送；四者皆未变才跳过（原 sun.version 逻辑
    // 不变，计数器并行累加）。
    if (
      sun.version === lastSunVersion &&
      patchVersion === lastPatchVersion &&
      hazeLockVersion === lastHazeLockVersion &&
      toonVersion === lastToonVersion
    )
      return;
    lastSunVersion = sun.version;
    lastPatchVersion = patchVersion;
    lastHazeLockVersion = hazeLockVersion;
    lastToonVersion = toonVersion;
    // 昼夜轨道（day-night Task 7）+ toon 底色层（toon-look Phase 1 Task 4，D1）：
    // 仰角 → 轨道状态 → applyToonLook 调色硬化（纯函数，只动 cloudBands/cloudHaze；
    // toon 在下、用户补丁在上）→ 穹顶与海面共享的 uniform 组（applySkyTrack）+ 灯光
    // + 海霾端点 + 星点 + 云调色，一次版本变更全动。
    const liveY = Math.min(Math.max(sun.direction.y, -1), 1);
    const el = (Math.asin(liveY) * 180) / Math.PI;
    const graded = applySceneGrade(skyTrackAt(el), el, colorGrade);
    const state = applyTrackPatch(applyToonLook(graded, toonAmount), trackPatch);
    applySkyTrack(state);
    // Blend the aircraft's key light toward the same antipodal moon as the clouds.
    const lightEl = Math.max(el, 2);
    if (lightEl !== el) {
      const [lx, ly, lz] = dayNightLightDirection([sun.direction.x, sun.direction.y, sun.direction.z]);
      lights.setSunDirection(new THREE.Vector3(lx, ly, lz));
    } else {
      lights.setSunDirection(sun.direction);
    }
    lights.setSunLook(state.sunLightColorCss, state.sunLightIntensity);
    lights.setAmbience(state.hemiSkyCss, state.hemiGroundCss, state.hemiIntensity);
    skyTsl?.setSunDirection(sun.direction);
    // R6 static moon (planB Phase 1 Task 5): the moon is the sun's antipode
    // (Task 1 `moonDirectionFor`, el→−el / az→az+180), so it rides the same
    // version gate — a pure function of the sun needs no counter of its own.
    // Null-safe like the sun push: pre-init `skyTsl` simply skips.
    const moonAz = (Math.atan2(sun.direction.x, -sun.direction.z) * 180) / Math.PI;
    const moon = moonDirectionFor(el, moonAz);
    const [mx, my, mz] = sunDirectionFromAzEl(moon.az, moon.el);
    skyTsl?.setMoonDirection(new THREE.Vector3(mx, my, mz));
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
    if (awayEdgeNow) archipelago?.setLight(el,awayEdgeNow);
    if (awayEdgeNow) island?.setLight(el,awayEdgeNow);
    world?.setCloudPalette(state.cloudBands, state.cloudHaze);
    // 云的太阳色随仰角走（复审 I1）：夜档不能拿一块黄昏暖色。
    // ?sunoff=1 时跳过——启动那次 [0,0,0] 才不会被逐帧轨道色盖回去。
    if (!sunOff) world?.setSunColor(sunColorFor(el));
    // 白纱纱色端点也随太阳轨道同步（原来只在启动时注入一次，运行时
    // 太阳转会过期——Minor 5 修此）。setVeilTintEndpoints 内部做线性→byte
    // 回转，veilTintCss 在 byte 空间 floor 插值，线性直灌会截成全黑。
    setVeilTintEndpoints(state.veilCool, state.veilWarm);
  };

  const renderFlightView = (plane: ReturnType<GameHandles['pose']> | undefined, forceReflection = false): void => {
    world?.sea?.updateObjectReflection(scene,camera,elapsed,forceReflection);
    if (post) {
      // Focus follows the aircraft as the chase camera pulls back.
      post.focusTo(camera.position, plane ?? camera.position);
      if (world && world.quality !== lastQuality) {
        lastQuality = world.quality;
        post.setQuality(lastQuality === 'high');
        game?.setQuality(lastQuality === 'high');
      }
      post.setDive?.(plane?.dive ?? 0);
      post.render();
    } else {
      r.render(scene, camera);
    }
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
    if (dt > 0) frameMs.push(dt * 1000);

    // QA lever: rotate the sun at a fixed rate so the sky disc and the sea's
    // sun road can be watched moving together. Deterministic under qa.step().
    if (sunSpinDegPerSec !== 0) sun.rotateAzimuth(sunSpinDegPerSec * stepDt);

    // The sky disc/glow, the DirectionalLight and all four sea rings follow one
    // sun state. Called every frame but only does work when the sun changed.
    syncSun();

    // The view budget is derived per frame from the live camera fov and the
    // drawing-buffer height, so a FOV kick or DPR change re-derives it for free.
    const radPerPixel = perPixelRadians(camera.fov, canvas.height);
    world?.update(elapsed, stepDt, {
      camera: camera.position,
      radPerPixel,
      // P2-3：game 的速度（上一帧的值——15% 高光浮动看不见 1 帧滞后）。
      speed01: game?.pose?.().speed01 ?? 0,
    });
    // 近景云的位置每帧被环面回收改写，所以白雾要读当帧的包围体，不能缓存。
    game?.setClouds(world?.blobs ?? []);
    game?.update(elapsed, stepDt);
    world?.updateBgView?.(elapsed,camera.position,camera);

    // The aircraft flies an unbounded line; the finite sky shell has to be towed
    // along with the camera or the camera simply leaves the world behind.
    const plane = game?.pose();
    if (plane) world?.sea?.updateSkim?.(stepDt,plane,archipelago?.heightAt ?? island?.terrain.heightAt);
    if (plane) archipelago?.update(elapsed,plane,camera.position,world?.quality === 'high');
    if (plane) island?.flora?.update(elapsed,plane,camera.position,world?.quality === 'high');
    // Full 3D tow: the dome shades with normalize(positionWorld - cameraPosition),
    // so its centre must sit exactly on the eye or the painted sky and the sea's
    // reflected sky differ by a fixed vertical parallax.
    farField.update(camera.position.x, camera.position.z, camera.position.y, _viewDir.x, _viewDir.z, elapsed, camera);
    renderFlightView(plane);
  };

  // `?qa=frozen` suppresses the animation loop so captures are exactly reproducible.
  const qaFrozen = new URLSearchParams(location.search).get('qa') === 'frozen';
  const version = (THREE as { REVISION?: string }).REVISION ?? 'unknown';
  const qa = {
    setHeadlight(mode: HeadlightMode): void {
      world?.headlight?.setMode(mode);
      world?.headlight?.update(sun.direction.y);
    },
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
    get cloudProximity() { return cloudProximity; },
    get cpuSubmitMs() { return cpuSubmitMs; },
    /** 门 6：帧时间分位数（毫秒）。 */
    frameStats() {
      return {
        count: frameMs.count,
        mean: frameMs.mean,
        p50: frameMs.percentile(50),
        p95: frameMs.percentile(95),
        p99: frameMs.percentile(99),
        over50ms: frameMs.countAbove(50),
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
    // uToon 总闸运行时杠杆（toon-look Phase 1 Task 1；Task 4 接轨道底色层）：clamp
    // 0..1 后直推共享 uniform 组（出口 posterize 即时生效），同时写 toonAmount 并
    // 递增 toonVersion——下一帧 syncSun 把 toon 化的 cloudBands/cloudHaze 扇出给
    // 云的两层消费端（puff / bg-cumulus 烘焙背景层）。
    setToon(x: number): void {
      toonAmount = Math.min(Math.max(x, 0), 1);
      setToon(toonAmount);
      toonVersion += 1;
    },
    // ---- day-night planB Phase 1 Task 1 解析 / Task 3 接线：tod 状态杠杆 ----
    // B2「设了就生效」：clamp 存储 + 立即从 R1 弧推太阳方向——setAzEl 递增版本，
    // syncSun 一次全量扇出（轨道/霾/灯/云，与 ?sun=、qa.setSun 同一条路）。这是
    // 显式运行时写入，不经过 resolveStaticTodSun 的 ?sun= 优先级裁决（那是启动期
    // URL 冲突的仲裁；运行时最后一次写入获胜）。?todspeed 仍只写：不推进是 B2
    // 纪律，期 2 才消费。
    setTod(h: number): void {
      if (!Number.isFinite(h)) return;
      tod = Math.min(Math.max(h, 0), 24);
      sun.setAzEl(solarAzimuthFor(tod), solarElevationFor(tod));
      syncSun();
    },
    setTodSpeed(x: number): void {
      todSpeed = Math.max(x, 0);
    },
    // ---- free-play runtime levers (2026-11-13 loosening) ----
    // Palette / post / cam presets at runtime — same paths as the URL knobs.
    // `setPalette(null)` clears back to the shipped sunset (patch null).
    setPalette(name: string | null): void {
      const key = palettePreset(name);
      trackPatch = key && key !== 'sunset' ? paletteToTrackPatch(key) : null;
      patchVersion += 1;
    },
    setPostFx(name: string | null): void {
      post?.setFx({ ...postPreset(name) });
    },
    // ---- debug color panel levers（计划 2026-11-09 Task 1；表现层只经这组
    // 杠杆，不直碰 uniform / world 句柄——R13）----
    // 轨道补丁：整字段替换语义；写闭包并递增 patchVersion，下一个 syncSun 生效。
    setTrackPatch(p: DebugTrackPatch | null): void {
      trackPatch = p;
      patchVersion += 1;
    },
    setColorGrade(enabled: boolean): void {
      colorGrade = enabled;
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
      toon: number;
      repro: string;
    } {
      const snap = sun.snapshot();
      return {
        sun: { az: snap.azimuthDeg, el: snap.elevationDeg },
        patch: trackPatch,
        hazeLocked,
        haze: hazeNow,
        awayEdge: awayEdgeNow,
        toon: toonAmount,
        repro: formatColorRepro(snap.azimuthDeg, snap.elevationDeg, trackPatch, hazeLocked, hazeNow, awayEdgeNow, toonAmount)
          .replace('\n', `&colorstage=${colorGrade ? 'refined' : 'previous'}\nqa.setColorGrade(${colorGrade}); `),
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
        islandExperiment,
        archipelago: archipelago?.stats ?? null,
        land: island?.counts ?? null,
        vegetation: island?.flora?.stats ?? null,
        backend: 'WebGPU', // createRenderer verifies the initialized backend.
        cssSize: [canvas.clientWidth, canvas.clientHeight],
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
          drawCalls: render.drawCalls ?? null,
          triangles: render.triangles ?? null,
          points: render.points ?? null,
          lines: render.lines ?? null,
          geometries: memory.geometries ?? null,
          textures: memory.textures ?? null,
        },
      };
    },
  };
  // Scrubbing previews the authored day track rather than a fixed URL/debug tint.
  let previewFrame: number | null = null;
  let previewFrames = 0;
  const renderTimePreview = (): void => {
    previewFrame = null;
    if (previewFrames-- <= 0) return;
    qa.step(1, 1 / 60);
    previewFrame = requestAnimationFrame(renderTimePreview);
  };
  selectHeadlightFromUi = (mode) => {
    qa.setHeadlight(mode);
    if (qaFrozen) { previewFrames = 1; if (previewFrame === null) previewFrame = requestAnimationFrame(renderTimePreview); }
  };
  selectTimeFromUi = (h) => {
    qa.setPalette(null);
    qa.lockHaze(false);
    qa.setTod(h);
    // Frozen labs have no animation loop. Yield real frames so Three's frame-
    // scoped uniforms refresh between staged cloud strips; coalesce fast input.
    if (qaFrozen) {
      // Up to nine spatial cards, eight strips each: finish both an in-flight
      // snapshot and the latest scrubbed time before the frozen preview stops.
      previewFrames = 24;
      if (previewFrame === null) previewFrame = requestAnimationFrame(renderTimePreview);
    }
  };

  // ?debug=color 的 URL 通道（R14/S4/S13）：必须在 qa 对象创建之后——上面的
  // qaParams 块（启动早期）时 qa 还没定义（S13/TDZ）。顺序固定先端点后锁：
  // 先锁会把首帧 syncSun 的端点推送挡掉，海面拿的是模块默认端点（S4）。
  // 解析失败一律 null + console.warn，绝不抛错中断启动。
  // ?palette=<sunset|roseDawn|tealNoon|violetDusk> free-play entry (2026-11-13):
  // preset patch underneath, explicit ?trackpatch on top (user patch wins).
  // `sunset` (or unknown) = no patch = shipped frame, bit-for-bit.
  const paletteName = palettePreset(parsePaletteName(qaParams.get('palette')));
  const palettePatch = paletteName && paletteName !== 'sunset' ? paletteToTrackPatch(paletteName) : null;
  const urlPatch = parseTrackPatch(qaParams.get('trackpatch'));
  const combinedPatch = palettePatch || urlPatch
    ? { ...(palettePatch ?? {}), ...(urlPatch ?? {}) }
    : null;
  if (combinedPatch) {
    qa.setTrackPatch(combinedPatch);
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
    let recordFlightFrame: ((now: number, z: number) => void) | undefined;
    if (meadowPass && canvas.parentElement) {
      const controls = await import('./land/pass-controls');
      if (urlParams.get('frameprobe') === '1') recordFlightFrame = controls.mountFlightFrameProbe(canvas.parentElement);
      controls.mountMeadowControls(canvas.parentElement,look);
      if (aerialPass) controls.mountTreeControls(canvas.parentElement,treeLook);
      if (treeLook === 'baked') controls.mountTreeLodControls(canvas.parentElement,fadeTreeLod,aerialPass);
    }
    if (pass && canvas.parentElement) {
      (await import('./land/pass-controls')).mountPassControls(canvas.parentElement, pass);
    }
    setLoadingStage(4, '正在预热飞行画面');
    const queue = r.backend?.device?.queue;
    const puffField = scene.getObjectByName('puff-field');
    const clouds = puffField?.visible ? puffField.children.filter(mesh => mesh.visible && mesh.frustumCulled) : [];
    const headlight = world?.headlight;
    if (clouds.length || archipelago || headlight) {
      // Warm the live render passes while the loading screen covers the view.
      const restoreGrass = archipelago?.stageGrassWarmup();
      const restoreBeam = headlight?.stageBeamWarmup();
      for (const cloud of clouds) cloud.frustumCulled = false;
      try {
        stepFrame(0);
        await queue?.onSubmittedWorkDone();
      } finally {
        for (const cloud of clouds) cloud.frustumCulled = true;
        restoreGrass?.();
        restoreBeam?.();
      }
      // Show the flight's starting view with normal visibility.
      renderFlightView(game?.pose(), true);
    } else {
      stepFrame(0);
    }
    await queue?.onSubmittedWorkDone();
    const measure = urlParams.get('bench') === '1';
    renderer.setAnimationLoop((now: number) => {
      const dtRaw = Number.isFinite(last) ? (now - last) / 1000 : 0;
      last = now;
      const start = measure ? performance.now() : 0;
      stepFrame(dtRaw);
      if (measure) cpuSubmitMs = performance.now() - start;
      recordFlightFrame?.(now,game?.pose().z ?? camera.position.z);
    });
  }
  Object.assign((window as unknown as Record<string, Record<string, unknown>>).__porco, { qa });
  setStatus(worldLabel, 6000);
  if (loadingScreen) loadingScreen.hidden = true;
  if (canvas.parentElement) canvas.parentElement.inert = false;
}

boot().catch((err) => {
  console.error('[porco] boot failed', err);
  setStatus('renderer unavailable — check the console');
  statusEl.style.opacity = '1';
  if (loadingStage) loadingStage.textContent = '飞行场景启动失败，请检查浏览器的 WebGPU 支持后重试。';
  if (loadingProgress) loadingProgress.hidden = true;
  if (loadingRetry) loadingRetry.hidden = false;
});
