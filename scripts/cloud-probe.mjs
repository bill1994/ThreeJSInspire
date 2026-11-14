/**
 * scripts/cloud-probe.mjs — bg-cumulus 确定性抓帧探针（CDP，Node 内置 fetch + WebSocket，零依赖）。
 *
 * 抓帧协议（docs/superpowers/plans/2026-11-14-bg-cumulus-visibility-and-variants.md Task 1）。
 * 三条已知陷阱先读——每一条都是真实踩过的坑，改动前别绕过：
 *
 * 1. **HUD 必须藏**：`.porco-hud` 盖住云的主体，不藏的差分是无效的——2026-11-14 实测
 *    bg=0/1 差分被遮成 0.184%，真实覆盖 ≈15%。本探针导航后立刻对所有
 *    `#frame .porco-hud` 设 `visibility='hidden'`（不改布局、canvas 尺寸不动，
 *    也不参与命中测试）。
 * 2. **视口必须先钉再导航**：`Emulation.setDeviceMetricsOverride { width:448,
 *    height:797, deviceScaleFactor:1, mobile:false }` 必须发生在 `Page.navigate`
 *    之前。448×797 是 `#frame` 的 CSS（min(100vw,56.25vh) + 9/16）在当前窗口的
 *    运行时值，**不是常量**——不钉死，角换算与所有覆盖率门槛随窗口漂移，
 *    与"确定性抓帧"直接矛盾。
 * 3. **贴边云按被裁切处理**：bbox 触到画布边缘的云不参与角宽计分
 *    （metrics.json 里 `angularWidthDeg/angularWidthRatio` 为 null，`bboxClipped`
 *    为 true）。被左边缘裁掉的大云会把可见残条误报成"压缩的小球"——2026-11-14
 *    实测 150px 圆球其实是一朵横跨左半边的大云。
 *
 * 流程：钉视口 → 导航 `?qa=frozen&puff=0`（puff=0 保证近场云不进差分）→ 藏 HUD →
 * `qa.step(300, 1/60)` 定步（≥300：相机 rig 的平滑在 ~180 帧后仍有亚像素暂态，
 * 实测 182 帧起天空区逐帧差降到 1–2 px）→ 差分对：bg on 截一张 → `setBgVisible(false)`
 * → **`qa.step(2, 1/60)` 真步进重渲染** → 再截一张。
 *
 * ⚠️ 第四条陷阱（2026-11-15 实测）：**冻结页里绝不能用 `qa.stepFrame(0)` /
 * `post.render()` 这类 dt=0 重渲染**——这类渲染产出整帧平色的坏帧（页面内
 * drawImage 与截图都会拿到它），而且坏一次之后所有 dt=0 渲染持续坏。`dt>0`
 * 的真步进渲染永远健康，代价是差分对之间隔 2 帧（约 33 ms）的海面动画——
 * **天空区（y < yHorizon）不受影响**（实测逐帧差 1–2 px），所有验收指标都在
 * 天空区；整幅字段（coverageAll / rowProfile 下半幅）含海面动画噪声，读数时
 * 注意。另：Chrome 窗口被遮挡时页面 visibility=hidden、rAF 停摆，探针启动时
 * 先 `Page.bringToFront`；若仍 hidden 直接报错退出（抓帧协议要求可见页面）。
 *
 * 解码与差分在页面内做（浏览器原生解 PNG 零依赖），度量函数用
 * `await import('/src/cloud-metrics.ts')` 取（dev server 会编译 TS；若将来指向
 * 打包产物，退化为把函数体内联进注入字符串）。
 * 另有 24 朝向罗盘扫描（headingMatrix）与一次非冻结的帧时间采样窗
 * （frameP50Ms / frameP95Ms——冻结步进的 dt 是常数，测不了真实帧节奏，
 * 所以单独导航 `?puff=0` 跑满 600 帧环形窗后读 `qa.frameStats()`）。
 *
 * 标定模式（bg-cumulus Task 2）：页面 URL 带 `?bgforce=single` 时烘焙层被强制成
 * 一朵已知云（main.ts 构造 singleCloudLayout(90, 10, 5000, 2000, 600)），布局匹配
 * 侧跟着换成同一夹具（否则 seed 环排布里根本没有这朵云，角宽比全是垃圾读数），
 * metrics.json 的 `layoutSource` 记为 `bgforce-single` 以便对账；缺省仍是
 * `seed-<SEED>` 生产布局。
 * Task 3 起：`node scripts/cloud-probe.mjs --bgforce single` 直接跑标定（两个 URL 都带
 * `&bgforce=single`），metrics.json 多一个 `calibration` 块——heading 90（夹具云居中的
 * 朝向）的质心方位/角宽/角宽比与 Step 6 两道闸（|az−90|≤2、ratio∈[0.8,1.2]）的判定；
 * headingMatrix 每项也带上 centroidAzDeg/angularWidthDeg/angularWidthRatio。
 *
 * 运行：
 *   1) npx vite --port 5173
 *   2) Chrome 带 --remote-debugging-port=9222（窗口保持前台/可见，rAF 才走；
 *      建议加 --disable-backgrounding-occluded-windows）
 *   3) node scripts/cloud-probe.mjs
 * 产物：artifacts/cloud-probe/<ISO 时间戳>/metrics.json + bg-on.png + bg-off.png
 * （产物不入库。）
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CDP_HTTP = 'http://127.0.0.1:9222';
// CLI：--bgforce single（bg-cumulus Task 3 标定台）。给两个 URL 追加 &bgforce=<mode>，
// 页面跑强制单云布局；罗盘扫到 heading = CALIB_HEADING_DEG 时夹具云居中，那一对的
// 质心方位就是渲染云的实测方位（metrics.json 的 calibration 块，Step 6 闸的读数）。
const argv = process.argv.slice(2);
const bgforceIdx = argv.indexOf('--bgforce');
const bgforceArg = bgforceIdx >= 0 ? argv[bgforceIdx + 1] : null;
const FORCE_Q = bgforceArg ? `&bgforce=${encodeURIComponent(bgforceArg)}` : '';
// --pos=x,y,z（bg-cumulus Task 3.5 recentre 真机验证）：透传 ?pos=（qa.ts parsePos
// 语义，直接摆飞机）。相机出生即距布局原点 (0,70,0) > REBAKE_METRES(250) → update
// 首帧触发 recentre + 全量重烘——验证纹理化后 recentre 链路（云场随烘焙原点跟随、
// 纹理偏移不变、无 NaN 污染）的专用杠杆；缺省不传 = 原出生点，行为逐位不变。
const posIdx = argv.indexOf('--pos');
const posArg = posIdx >= 0 ? argv[posIdx + 1] : null;
const POS_Q = posArg ? `&pos=${encodeURIComponent(posArg)}` : '';
const APP_URL_FROZEN = `http://localhost:5173/?qa=frozen&puff=0${FORCE_Q}${POS_Q}`;
const APP_URL_LIVE = `http://localhost:5173/?puff=0${FORCE_Q}${POS_Q}`;
// 全局约束：视口是钉死的协议，不是常量推荐值——见文件头陷阱 2。
const VIEWPORT = { width: 448, height: 797, deviceScaleFactor: 1, mobile: false };
const THRESHOLD = 24; // 三通道最大绝对差 > 24 计命中（Task 1 冒烟口径）
const SEED = 7; // world.ts:222 钉死的生产种子，布局匹配用
// 标定夹具字面量（bg-cumulus Task 2/3）：main.ts 构造侧用同一组 (90, 10, 5000, 2000, 600)，
// 改一处必须同步另一处。azDeg 兼作标定期望方位与标定朝向（云居中的罗盘朝向）。
const CALIB_FIXTURE = [90, 10, 5000, 2000, 600];
const CALIB_HEADING_DEG = 90;
const CALIB_AZ_TOL_DEG = 2; // Step 6 闸：|azMeasured − 90| ≤ 2
const CALIB_RATIO_BAND = [0.8, 1.2]; // Step 6 闸：angularWidthRatio ∈ [0.8, 1.2]
const SETTLE_STEPS = 300; // 定步窗：≥300 帧——相机 rig 平滑的亚像素暂态在 ~182 帧后消失
const STEP_DT = 1 / 60;
const TURN_SETTLE_STEPS = 60; // 转向伺服收敛后的稳帧窗
const HEADING_COUNT = 24; // 罗盘 24 朝向 × 15°
const HEADING_TOL_DEG = 1.0; // 转向伺服收敛容差
// input.ts 的径向死区镜像（CDP 合成拖拽要算出对应的像素位移）
const DEADZONE_PX = 4;
const STEER_RADIUS_PX = 120;
const ART_ROOT = 'artifacts/cloud-probe';

const die = (msg) => {
  console.error(`[cloud-probe] FAIL: ${msg}`);
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wrap180 = (d) => (((d + 180) % 360) + 360) % 360 - 180;

// ---------------------------------------------------------------------------
// CDP over Node 内置 WebSocket：id 配对的极薄封装
// ---------------------------------------------------------------------------
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
        else p.resolve(msg.result);
      }
      // 事件本探针用不到（轮询而非订阅），忽略
    });
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('CDP socket closed'));
      this.pending.clear();
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`WS connect failed: ${wsUrl}`)), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

/** Runtime.evaluate（awaitPromise + returnByValue），异常细节原样抛出。 */
async function evaluate(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    const text = d.exception?.description ?? d.exception?.value ?? d.text ?? 'unknown';
    throw new Error(`page evaluate failed: ${text}`);
  }
  return res.result?.value;
}

async function capturePngBase64(cdp) {
  const res = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  return res.data;
}

// ---------------------------------------------------------------------------
// 页面内注入的函数（真实 JS 函数体 toString 后注入，避免字符串转义地狱）。
// 依赖页面已加载 __porco 与 dev server 可编译的 /src/cloud-metrics.ts。
// ---------------------------------------------------------------------------

/** 读相机方位（度，[0,360)，约定 az = atan2(dir.x, −dir.z)，与 main.ts 一致）。 */
function cameraAzFn() {
  const c = window.__porco.camera;
  const e = c.matrixWorld.elements;
  // three.js 列主序：Z 列 = (e[8],e[9],e[10])，前向 = −Z 列
  const fwdX = -e[8];
  const fwdZ = -e[10];
  const az = (Math.atan2(fwdX, -fwdZ) * 180) / Math.PI;
  return ((az % 360) + 360) % 360;
}

/**
 * 两张 base64 PNG 的差分与全部画面度量（页面内解码，浏览器原生解 PNG）。
 * 返回值进 metrics.json 的画面字段；frame 时间与 headingMatrix 由 Node 侧组装。
 */
async function probeMetricsFn(args) {
  const { on, off, threshold, seed, fixture } = args;
  const P = window.__porco;
  if (!P || !P.world || !P.camera) throw new Error('__porco incomplete (world/camera missing)');
  const { diffMask, bbox, angularWidthDeg, coverageFraction } = await import('/src/cloud-metrics.ts');

  const cam = P.camera;
  const cnv = (P.renderer && P.renderer.domElement) || document.querySelector('#frame canvas');
  const W = cnv.width;
  const H = cnv.height;
  const fovDeg = cam.fov;

  const loadRgba = async (base64) => {
    const img = new Image();
    img.src = base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`;
    await img.decode();
    if (img.naturalWidth !== W || img.naturalHeight !== H) {
      throw new Error(
        `screenshot ${img.naturalWidth}x${img.naturalHeight} != drawing buffer ${W}x${H} — viewport not pinned or capture flags wrong`,
      );
    }
    const oc = new OffscreenCanvas(W, H);
    const ctx = oc.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return { data: ctx.getImageData(0, 0, W, H).data, width: W, height: H };
  };

  const A = await loadRgba(on);
  const B = await loadRgba(off);
  const mask = diffMask(A, B, threshold);
  const nPx = W * H;

  // 幅值平面（三通道最大绝对差）——rowProfile 用它区分云与全天空泛白
  const mag = new Float32Array(nPx);
  for (let i = 0; i < nPx; i += 1) {
    const o = i * 4;
    const dr = Math.abs(A.data[o] - B.data[o]);
    const dg = Math.abs(A.data[o + 1] - B.data[o + 1]);
    const db = Math.abs(A.data[o + 2] - B.data[o + 2]);
    mag[i] = dr > dg ? (dr > db ? dr : db) : dg > db ? dg : db;
  }

  // 相机光线几何：列主序 matrixWorld，相机空间方向 → 世界方向
  const e = cam.matrixWorld.elements;
  const tanV = Math.tan((fovDeg * Math.PI) / 360);
  const tanH = (tanV * W) / H;
  const rayWorld = (px, py) => {
    const xN = (2 * px) / W - 1;
    const yN = 1 - (2 * py) / H;
    const dx = xN * tanH;
    const dy = yN * tanV;
    const dz = -1;
    return {
      x: dx * e[0] + dy * e[4] + dz * e[8],
      y: dx * e[1] + dy * e[5] + dz * e[9],
      z: dx * e[2] + dy * e[6] + dz * e[10],
    };
  };
  const azOf = (v) => (((Math.atan2(v.x, -v.z) * 180) / Math.PI) + 360) % 360;
  const cameraAzDeg = azOf(rayWorld(W / 2, H / 2));

  // 海天线所在行（画面中心列，精确解 wy=0；仰角/滚转都吃进矩阵里，不猜）
  let yHorizon = null;
  if (Math.abs(e[5]) > 1e-6) {
    const yN = e[9] / (tanV * e[5]); // wy = dy·e[5] − e[9] = 0（中心列 dx=0）
    const row = (H / 2) * (1 - yN);
    if (Number.isFinite(row)) yHorizon = Math.round(Math.min(H, Math.max(0, row)));
  }
  const skyRect = yHorizon !== null ? { x0: 0, y0: 0, x1: W, y1: yHorizon } : { x0: 0, y0: 0, x1: W, y1: H };
  // coverageRegion 的矩形：探针默认整幅画布（显式矩形留给后续任务的调用）
  const region = { x0: 0, y0: 0, x1: W, y1: H };

  // 质心（等权像素均值，天空区内）→ 世界方位
  let sx = 0;
  let sy = 0;
  let cnt = 0;
  const yTop = skyRect.y1;
  for (let y = 0; y < yTop; y += 1) {
    const row = y * W;
    for (let x = 0; x < W; x += 1) {
      if (mask[row + x]) {
        sx += x;
        sy += y;
        cnt += 1;
      }
    }
  }
  const centroid = cnt > 0 ? { x: sx / cnt, y: sy / cnt } : null;
  const centroidAzDeg = centroid ? azOf(rayWorld(centroid.x, centroid.y)) : null;

  // bbox / 质心 / 角宽只在天空区算：bg 层的差分在海面以下也命中（海面反射了
  // 天空侧的云合成），整幅 bbox 会被反射差分污染——云的包围盒语义就是"云"。
  const cl = bbox(mask, W, H, skyRect);
  // 陷阱 3：贴边云不参与角宽计分（触画布边缘，或被天空区下界裁掉都算被裁切）
  const clipped =
    cl !== null && (cl.x0 === 0 || cl.y0 === 0 || cl.x1 === W || cl.y1 === H || cl.y1 === skyRect.y1);
  const angW = cl !== null && !clipped ? angularWidthDeg(cl.x1 - cl.x0, W, H, fovDeg) : null;

  // 布局匹配（渲染质心落在哪朵云的角跨度内 → 布局角宽 → 比值）
  let match = null;
  // ?bgforce=single（标定台，bg-cumulus Task 2）：页面跑的是强制单云布局，seed 环
  // 排布里根本没有这朵云——匹配对象必须换成夹具本体。字面量从 Node 侧经 args 传入
  // （CALIB_FIXTURE），与 main.ts 的构造侧同一组，改一处必须同步另一处。
  const forcedSingle = new URLSearchParams(location.search).get('bgforce') === 'single';
  const clouds = forcedSingle
    ? (await import('/src/bg-cumulus.ts')).singleCloudLayout(fixture[0], fixture[1], fixture[2], fixture[3], fixture[4])
    : (await import('/src/bg-cumulus-layout.ts')).layoutClouds(seed);
  if (centroidAzDeg !== null) {
    const hits = clouds
      .map((c) => ({
        c,
        d: ((centroidAzDeg - c.azimuthDeg + 540) % 360) - 180,
        hw: (Math.atan(c.widthMetres / 2 / c.distanceMetres) * 180) / Math.PI,
      }))
      .filter((o) => Math.abs(o.d) <= o.hw);
    hits.sort((a, b) => Math.abs(a.d) - Math.abs(b.d));
    match = hits.length > 0 ? hits[0].c : null;
  }
  const layoutAngW = match ? (2 * Math.atan(match.widthMetres / 2 / match.distanceMetres) * 180) / Math.PI : null;
  const angularWidthRatio = angW !== null && layoutAngW !== null ? angW / layoutAngW : null;

  // rowProfile：每 20 行的幅值均值（全行均值——泛白是整行均匀的，云是局部的）
  const bandRows = 20;
  const means = [];
  for (let y0 = 0; y0 < H; y0 += bandRows) {
    const yEnd = Math.min(H, y0 + bandRows);
    let s = 0;
    for (let y = y0; y < yEnd; y += 1) {
      const row = y * W;
      for (let x = 0; x < W; x += 1) s += mag[row + x];
    }
    means.push(s / ((yEnd - y0) * W));
  }

  // hfEnergy：掩码内 4 邻域绝对差均值（右/下各一次即覆盖全部 4 邻接对；
  // 两端都在掩码内才算——云内部纹理，不含轮廓对天空的对比；天空区内，
  // 海面反射差分不掺进来）
  let hfSum = 0;
  let hfPairs = 0;
  const chMaxDiff = (i, j) => {
    const oa = i * 4;
    const ob = j * 4;
    const dr = Math.abs(A.data[oa] - A.data[ob]);
    const dg = Math.abs(A.data[oa + 1] - A.data[ob + 1]);
    const db = Math.abs(A.data[oa + 2] - A.data[ob + 2]);
    return dr > dg ? (dr > db ? dr : db) : dg > db ? dg : db;
  };
  for (let y = 0; y < yTop; y += 1) {
    const row = y * W;
    for (let x = 0; x < W; x += 1) {
      const i = row + x;
      if (!mask[i]) continue;
      if (x + 1 < W && mask[i + 1]) {
        hfPairs += 1;
        hfSum += chMaxDiff(i, i + 1);
      }
      if (y + 1 < yTop && mask[i + W]) {
        hfPairs += 1;
        hfSum += chMaxDiff(i, i + W);
      }
    }
  }

  return {
    canvasW: W,
    canvasH: H,
    dpr: Number((window.devicePixelRatio ?? 1).toFixed(3)),
    fovDeg,
    cameraAzDeg,
    yHorizon,
    skyRect,
    region,
    coverageSky: coverageFraction(mask, W, skyRect),
    coverageAll: coverageFraction(mask, W, region),
    coverageRegion: coverageFraction(mask, W, region),
    bbox: cl,
    bboxClipped: clipped,
    centroidAzDeg,
    angularWidthDeg: angW,
    angularWidthRatio,
    layoutMatch: match
      ? { azimuthDeg: match.azimuthDeg, angularWidthDeg: layoutAngW, kind: match.kind }
      : null,
    layoutSource: forcedSingle ? 'bgforce-single' : `seed-${seed}`,
    rowProfile: { bandRows, means },
    hfEnergy: hfPairs > 0 ? hfSum / hfPairs : 0,
    maskCount: cnt,
    maskRegionNote: 'bbox/centroid/angularWidth/hfEnergy 是天空区（y<yHorizon）量；coverage* 是整幅掩码占比',
  };
}

const injectProbeHelpers = (cdp) =>
  evaluate(cdp, `window.__cameraAz = (${cameraAzFn.toString()});
window.__probeMetrics = (${probeMetricsFn.toString()}); 'ok';`);

// ---------------------------------------------------------------------------
// 抓帧与转向程序
// ---------------------------------------------------------------------------

async function setBgVisible(cdp, visible) {
  await evaluate(cdp, `window.__porco.world.setBgVisible(${visible ? 'true' : 'false'}); 'ok';`);
}

async function qaStep(cdp, count) {
  await evaluate(cdp, `window.__porco.qa.step(${count}, ${STEP_DT}); 'ok';`);
}

async function hideHud(cdp) {
  const hidden = await evaluate(
    cdp,
    `(() => {
      const els = document.querySelectorAll('#frame .porco-hud');
      if (els.length === 0) return 0;
      for (const el of els) el.style.visibility = 'hidden';
      return els.length;
    })()`,
  );
  if (!hidden) die('.porco-hud not found under #frame — HUD markup changed, capture protocol broken');
  console.log(`[cloud-probe] HUD hidden (${hidden} element(s))`);
}

/**
 * 一对差分截图（bg on → off），返回页面内度量结果。
 * 两次截图之间的重渲染必须走 dt>0 的真步进（见文件头第四条陷阱）；
 * 对间隔 2 帧 = 约 33 ms 的世界动画，天空区实测逐帧差 1–2 px，验收指标全在天空区。
 */
async function capturePair(cdp, label) {
  await setBgVisible(cdp, true);
  const on = await capturePngBase64(cdp);
  await setBgVisible(cdp, false);
  await qaStep(cdp, 2);
  const off = await capturePngBase64(cdp);
  // 恢复 bg 可见并重渲染，供下一轮转向/抓帧
  await setBgVisible(cdp, true);
  await qaStep(cdp, 2);
  const ret = await evaluate(cdp, `window.__probeMetrics(${JSON.stringify({ on, off, threshold: THRESHOLD, seed: SEED, fixture: CALIB_FIXTURE })})`);
  console.log(
    `[cloud-probe] ${label}: az=${ret.cameraAzDeg.toFixed(2)}° coverageSky=${(ret.coverageSky * 100).toFixed(2)}% ` +
      `bbox=${ret.bbox ? `${ret.bbox.x0},${ret.bbox.y0}->${ret.bbox.x1},${ret.bbox.y1} (${ret.bbox.count}px)` : 'null'} ` +
      `clipped=${ret.bboxClipped} yHorizon=${ret.yHorizon}`,
  );
  return { base64: { on, off }, metrics: ret };
}

async function canvasCenter(cdp) {
  const rect = await evaluate(
    cdp,
    `(() => { const r = document.querySelector('#frame canvas').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`,
  );
  return { cx: rect.x + rect.w / 2, cy: rect.y + rect.h / 2 };
}

/** 注入一个转向脉冲 s ∈ [-1,1]（input.ts 径向死区的镜像换算），按下并拖到位。 */
async function steer(cdp, center, s) {
  const mag = Math.min(1, Math.abs(s));
  const px = mag <= 0 ? 0 : DEADZONE_PX + mag * (STEER_RADIUS_PX - DEADZONE_PX);
  const dx = s < 0 ? -px : px;
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: center.cx, y: center.cy, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse',
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: center.cx + dx, y: center.cy, button: 'left', buttons: 1, pointerType: 'mouse',
  });
}

async function releaseSteer(cdp, center) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: center.cx, y: center.cy, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse',
  });
}

/**
 * 转向程序（Task 4 的"停在 az≈197"就靠它）：脉冲舵。
 * 实测（2026-11-15，CDP 拖拽）：满杆 30 帧 ≈ +14.7°，松杆后坡度衰减还有
 * ~8.6°/10 帧的滑航——长按必过冲。所以用"压 1 帧 → 松杆 → 滑 5 帧"的脉冲，
 * 强度随误差比例收缩，收敛判据在滑航沉降之后复核。
 * 右拖 → 右压坡度 → yaw 减 → az 增（az = −yaw），err>0 时向右修。
 */
async function turnToAz(cdp, center, targetDeg) {
  const maxIter = 300;
  for (let i = 0; i < maxIter; i += 1) {
    const az = await evaluate(cdp, 'window.__cameraAz()');
    const err = wrap180(targetDeg - az);
    if (Math.abs(err) <= HEADING_TOL_DEG) {
      await qaStep(cdp, TURN_SETTLE_STEPS); // 滑航沉降干净后复核
      const az2 = await evaluate(cdp, 'window.__cameraAz()');
      if (Math.abs(wrap180(targetDeg - az2)) <= HEADING_TOL_DEG) return az2;
      continue;
    }
    const strength = Math.min(1, Math.max(0.15, Math.abs(err) / 8));
    await steer(cdp, center, err > 0 ? strength : -strength);
    await qaStep(cdp, 1);
    await releaseSteer(cdp, center);
    await qaStep(cdp, 5);
  }
  die(`turnToAz(${targetDeg}): servo did not converge in ${maxIter} pulses`);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function waitForReady(cdp, what, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const ok = await evaluate(
      cdp,
      `Boolean(window.__porco && window.__porco.qa && window.__porco.world && window.__porco.camera)`,
    );
    if (ok) {
      console.log(`[cloud-probe] ${what} ready after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return;
    }
    if (Date.now() - t0 > timeoutMs) die(`${what} not ready within ${timeoutMs / 1000}s (world/camera null — bg layer failed to init?)`);
    await sleep(250);
  }
}

async function main() {
  const targets = await (await fetch(`${CDP_HTTP}/json/list`)).json();
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const page =
    pages.find((t) => t.title.includes('Porco')) ??
    pages.find((t) => t.url.includes('localhost:5173')) ??
    pages[0];
  if (!page) die(`no page target at ${CDP_HTTP}/json/list — is Chrome running with --remote-debugging-port=9222?`);
  console.log(`[cloud-probe] target: "${page.title}" ${page.url}`);

  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);

  // 陷阱 2：先钉视口，再导航
  await cdp.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.bringToFront');

  // --- 阶段 1：冻结抓帧（出生视角 + 罗盘扫描） ---
  await cdp.send('Page.navigate', { url: APP_URL_FROZEN });
  await waitForReady(cdp, 'frozen page', 90_000);
  await injectProbeHelpers(cdp);
  await hideHud(cdp);
  const vis = await evaluate(cdp, `document.visibilityState`);
  if (vis !== 'visible') die(`page visibilityState=${vis} — rAF/合成器不推进，抓帧协议要求可见页面`);
  const elapsed = await evaluate(cdp, `window.__porco.qa.step(${SETTLE_STEPS}, ${STEP_DT})`);
  console.log(`[cloud-probe] settled ${SETTLE_STEPS} frames -> elapsed=${Number(elapsed).toFixed(3)}s`);

  const center = await canvasCenter(cdp);
  const headingMatrix = [];
  let spawn = null;
  for (let i = 0; i < HEADING_COUNT; i += 1) {
    const target = i * 15;
    if (i > 0) await turnToAz(cdp, center, target);
    const pair = await capturePair(cdp, `heading ${target}°`);
    if (i === 0) spawn = pair; // 出生视角 = 朝向 0 的那一对（同一定步窗，零额外状态）
    headingMatrix.push({
      headingDeg: target,
      azDeg: Number(pair.metrics.cameraAzDeg.toFixed(2)),
      coverage: pair.metrics.coverageSky,
      visible: pair.metrics.bbox !== null,
      // Task 3 标定读数：每个朝向的渲染质心方位 / 角宽 / 角宽比（贴边裁切时为 null）
      centroidAzDeg: pair.metrics.centroidAzDeg === null ? null : Number(pair.metrics.centroidAzDeg.toFixed(2)),
      angularWidthDeg: pair.metrics.angularWidthDeg === null ? null : Number(pair.metrics.angularWidthDeg.toFixed(2)),
      angularWidthRatio:
        pair.metrics.angularWidthRatio === null ? null : Number(pair.metrics.angularWidthRatio.toFixed(4)),
      bboxClipped: pair.metrics.bboxClipped,
    });
  }
  const visibleHeadings = headingMatrix.filter((h) => h.visible).length;
  console.log(`[cloud-probe] heading matrix done: ${visibleHeadings}/${HEADING_COUNT} headings show the layer`);

  // --- 阶段 2：非冻结帧时间窗（冻结步进的 dt 是常数，测不出真实帧节奏） ---
  await cdp.send('Emulation.setDeviceMetricsOverride', VIEWPORT); // 导航后重申一次，幂等
  await cdp.send('Page.navigate', { url: APP_URL_LIVE });
  await waitForReady(cdp, 'live page', 90_000);
  let frame = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 45_000) {
    const s = await evaluate(cdp, `JSON.stringify(window.__porco.qa.frameStats())`);
    const stats = JSON.parse(s);
    if (stats.count >= 600) {
      frame = stats;
      break;
    }
    await sleep(500);
  }
  if (!frame) die('frame timing window did not fill to 600 samples in 45s (is the window visible/focused?)');
  console.log(
    `[cloud-probe] frame timing (600-sample live window): p50=${frame.p50.toFixed(2)}ms p95=${frame.p95.toFixed(2)}ms`,
  );

  await cdp.send('Emulation.clearDeviceMetricsOverride');

  // --- 产物 ---
  const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
  const dir = join(ART_ROOT, stamp);
  mkdirSync(dir, { recursive: true });
  // 标定读数（bg-cumulus Task 3 Step 6）：--bgforce 模式下，heading = CALIB_HEADING_DEG
  // 那一对的质心方位就是渲染云的实测方位（探针 azOf = atan2(x, −z) 约定，与 main.ts 一致），
  // 角宽比对照夹具布局。只报告不 die——数字闸由读 metrics.json 的人裁决。
  let calibration = null;
  if (bgforceArg) {
    const at = headingMatrix.find((h) => h.headingDeg === CALIB_HEADING_DEG) ?? null;
    const az = at ? at.centroidAzDeg : null;
    const azErr = az === null ? null : (((az - CALIB_FIXTURE[0] + 540) % 360) - 180);
    const ratio = at ? at.angularWidthRatio : null;
    calibration = {
      mode: bgforceArg,
      fixture: CALIB_FIXTURE,
      headingDeg: CALIB_HEADING_DEG,
      expectedAzDeg: CALIB_FIXTURE[0],
      measuredAzDeg: az,
      azErrorDeg: azErr === null ? null : Number(azErr.toFixed(2)),
      angularWidthDeg: at ? at.angularWidthDeg : null,
      angularWidthRatio: ratio,
      bboxClipped: at ? at.bboxClipped : null,
      azGatePass: azErr !== null && Math.abs(azErr) <= CALIB_AZ_TOL_DEG,
      ratioGatePass: ratio !== null && ratio >= CALIB_RATIO_BAND[0] && ratio <= CALIB_RATIO_BAND[1],
    };
    console.log(
      `[cloud-probe] calibration @heading ${CALIB_HEADING_DEG}: az=${az} err=${calibration.azErrorDeg}° ` +
        `angW=${calibration.angularWidthDeg} ratio=${ratio} clipped=${calibration.bboxClipped} ` +
        `azGate=${calibration.azGatePass} ratioGate=${calibration.ratioGatePass}`,
    );
  }
  const metrics = {
    capturedAt: new Date().toISOString(),
    appUrlFrozen: APP_URL_FROZEN,
    appUrlLive: APP_URL_LIVE,
    posOverride: posArg,
    threshold: THRESHOLD,
    seed: SEED,
    viewport: {
      pinned: VIEWPORT,
      canvas: [spawn.metrics.canvasW, spawn.metrics.canvasH],
      dpr: spawn.metrics.dpr,
    },
    camera: { fovDeg: spawn.metrics.fovDeg, azDeg: Number(spawn.metrics.cameraAzDeg.toFixed(2)) },
    yHorizon: spawn.metrics.yHorizon,
    skyRect: spawn.metrics.skyRect,
    region: spawn.metrics.region,
    coverageSky: spawn.metrics.coverageSky,
    coverageAll: spawn.metrics.coverageAll,
    coverageRegion: spawn.metrics.coverageRegion,
    bbox: spawn.metrics.bbox,
    bboxClipped: spawn.metrics.bboxClipped,
    centroidAzDeg: spawn.metrics.centroidAzDeg,
    angularWidthDeg: spawn.metrics.angularWidthDeg,
    angularWidthRatio: spawn.metrics.angularWidthRatio,
    layoutMatch: spawn.metrics.layoutMatch,
    layoutSource: spawn.metrics.layoutSource,
    rowProfile: spawn.metrics.rowProfile,
    hfEnergy: spawn.metrics.hfEnergy,
    calibration,
    headingMatrix,
    frameP50Ms: Number(frame.p50.toFixed(3)),
    frameP95Ms: Number(frame.p95.toFixed(3)),
    frameTiming: { mode: 'live-loop', url: APP_URL_LIVE, samples: frame.count, mean: Number(frame.mean.toFixed(3)) },
  };
  for (const key of ['coverageSky', 'coverageAll', 'coverageRegion', 'hfEnergy', 'frameP50Ms', 'frameP95Ms']) {
    if (!Number.isFinite(metrics[key])) die(`metrics.${key} is not a finite number — ruler integrity failed`);
  }
  writeFileSync(join(dir, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
  writeFileSync(join(dir, 'bg-on.png'), Buffer.from(spawn.base64.on, 'base64'));
  writeFileSync(join(dir, 'bg-off.png'), Buffer.from(spawn.base64.off, 'base64'));
  console.log(`[cloud-probe] artifacts -> ${dir}/ (metrics.json, bg-on.png, bg-off.png)`);

  if (metrics.coverageSky < 0.01 || metrics.coverageSky > 0.25) {
    console.warn(
      `[cloud-probe] WARN: coverageSky ${(metrics.coverageSky * 100).toFixed(2)}% outside the 1-25% smoke band`,
    );
  }
}

main().catch((err) => die(err?.stack ?? String(err)));
