/**
 * src/bg-cumulus.ts — 背景积云：cubemap 烘焙 raymarch（bg-cumulus Task 3）。
 *
 * 架构（计划 §裁定 1/4/6）：每朵云是球堆 SDF（puff 球 + billow 3D 噪声推面），
 * TSL 光线步进把全部云烘进 CubeRenderTarget——每帧限速 1–8 条带（shader 侧
 * Discard 掩码 + autoClear=false，Task 0 证伪 scissor/viewport 后的既定机制），
 * 太阳静止且调色板不变时停烘。天空侧一次 cubeTexture 采样（Task 4）。
 * 颜色单源 cloudBands/cloudHaze → 五色 uniform（§裁定 5）；月亮 = −sunDir
 * 内部派生（§裁定 8）。
 * 参考 clouds.js:218-364 逐式移植；差异点全在计划 §裁定：尺度带布局派生
 * （uSlabStartY/tEnd 禁抄 520/14500/56000）、64 步预算、霾长 12000、
 * Discard 条带（参考的 8 条带/面分帧语义保留）、premultiplied 输出。
 */

import * as THREE from 'three';

import {
  billowField,
  layoutClouds,
  layoutWindow,
  type CloudLayout,
} from './bg-cumulus-layout';
import {
  PAINT_CONSTANTS,
  lightBlend,
  mapPalette,
} from './bg-cumulus-paint';
import type { Vec3 } from './sky-track';

/** march 步数（§裁定 4：布局派生尺度的重推预算，spike 验证余量）。 */
export const STEPS = 64;
/** 霾长（米，§裁定 4：7 km 处 ≈44% 混入，远景沉进天色）。 */
export const BG_HAZE_METRES = 12000;
/** 每面条带数 / 烘焙面数 / 总条带（§裁定 6：40 帧一圈）。 */
export const STRIPS_PER_FACE = 8;
export const FACES_BAKED = 5;
export const TOTAL_STRIPS = STRIPS_PER_FACE * FACES_BAKED;
/** 单帧烘带硬顶（§裁定 6）。 */
export const MAX_STRIPS_PER_FRAME = 8;
/**
 * 烘焙面清单（终审 C1，2026-11-14）：GPU 立方面序 0=+X、1=−X、2=+Y、3=−Y（底面）、
 * 4=+Z、5=−Z。底面（3）永不烘（rd.y 门会全弃，白烧 8 条带），−Z（5）是游戏正前
 * 方向（azimuth 0）必烘——按清单映射，禁止 cursor 直除。
 */
export const BAKE_FACES = [0, 1, 2, 4, 5] as const;
/** 默认烘焙分辨率（?bgq 可调，clamp 512..2048）。 */
export const BG_BAKE_SIZE_DEFAULT = 1024;
/**
 * 编译预算（2026-11-14 AMD RX 5700 驱动实测，Task 6 前诊断）：
 * 全量图（14 云 × 44 puff 循环 + fine 探针 11 次 bgMap）让驱动着色器编译器挂起
 * (>25 s 无返回)；砍到 9 云 × 16 puff 后全量首烘 3.2 s。这两个常量是编译规模
 * 上限——云数据超限时超出的云/球不参与烘焙（layout 层 puff 产能已对齐 16）。
 */
export const BG_CLOUD_LOOP_MAX = 9;
export const BG_PUFF_LOOP_MAX = 16;

/**
 * 相机锚定重烘阈值（米）。立方图必须从相机位置烘焙：云带在 3–7 km，相机飞 5 km
 * 后同一张图的云方向会整体偏掉十几度。位移超过这个值就搬原点 + 全量重烘
 * （40 条带 / 8 条带每帧 = 5 帧收敛，160 km/h 下约每 5.6 s 一次）。
 */
export const REBAKE_METRES = 250;

/** 光照状态（重烘调度的输入）：太阳方位/仰角 + 调色板版本。 */
export interface LightState {
  azDeg: number;
  elDeg: number;
  paletteVersion: number;
}

function wrap180(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/**
 * 限速条带预算（§裁定 6）：跳变当帧 strips = clamp(ceil(Δangle/0.05°), 1, 8)
 * 并把全部 40 条带标记 stale；此后静止也按 8/帧追平到 0。慢转每帧 dirty
 * 恒 1 条带（全圈 40 帧自刷新）。paletteVersion 变化视同 dirty。
 */
export function bakeBudget(
  prev: LightState,
  next: LightState,
  staleStrips: number,
): { strips: number; staleStrips: number } {
  const dAz = wrap180(next.azDeg - prev.azDeg);
  const dEl = next.elDeg - prev.elDeg;
  const delta = Math.hypot(dAz, dEl);
  const dirty = next.paletteVersion !== prev.paletteVersion || delta > 1e-9;
  let stale = dirty ? TOTAL_STRIPS : staleStrips;
  let strips = 0;
  if (dirty) {
    strips = Math.min(MAX_STRIPS_PER_FRAME, Math.max(1, Math.ceil(delta / 0.05)));
  } else if (stale > 0) {
    strips = Math.min(MAX_STRIPS_PER_FRAME, stale);
  }
  stale = Math.max(0, stale - strips);
  return { strips, staleStrips: stale };
}

/** 对外句柄（Task 4/5 消费）。 */
export interface BgCumulusHandles {
  /**
   * 每帧泵：算 bakeBudget、烘 N 条带、推 uLightDir；`cameraPos` 给了就做
   * 「相机锚定重烘」（位移超 REBAKE_METRES 时把烘焙原点搬到相机并全量重烘）。
   */
  update(t: number, sunDir: THREE.Vector3, cameraPos?: THREE.Vector3): void;
  /** 调色板推送（cloudBands/cloudHaze → 五色 uniform，paletteVersion 递增）。 */
  setLight(p: { bands: readonly Vec3[]; haze: Vec3 }): void;
  /** 全量重烘：仅 init/loading 路径（运行时禁用——§裁定 6）。 */
  drawAll(): void;
  /** 开关：关时停止烘焙（天空侧 uCloudOn 由 world 回调链处理）。 */
  setVisible(visible: boolean): void;
  /** 假色调试（0 关 1 方向场 2 覆盖率）。 */
  debugMode(n: number): void;
  dispose(): void;
  readonly count: number;
  readonly texture: THREE.Texture;
}

/**
 * 挂载。renderer 由 world 转发（main.ts initWorld 已持有）；opts.quality 来自
 * ?bgq=（Task 5 qa.ts 解析，clamp 512..2048 并受 device 上限约束）。
 */
export async function initBgCumulus(
  renderer: unknown,
  opts: { seed: number; sunDir?: THREE.Vector3; quality?: number; bands?: readonly [number, number, number][]; haze?: [number, number, number] },
): Promise<BgCumulusHandles> {
  const r = renderer as {
    setRenderTarget: (t: unknown, face?: number) => void;
    render: (s: THREE.Scene, c: THREE.Camera) => void;
    autoClear: boolean;
    setClearColor: (c: number, a: number) => void;
    setViewport: (x: number, y: number, w: number, h: number) => void;
    getViewport?: (t: THREE.Vector4) => THREE.Vector4;
    compileAsync: (s: THREE.Scene, c: THREE.Camera) => Promise<unknown>;
    backend?: { device?: { limits?: { maxTextureDimension2D?: number } } };
  };

  const webgpu = (await import('three/webgpu')) as any;
  const tsl = (await import('three/tsl')) as any;
  const { Fn, If, Loop, Discard, uniform, uniformArray, texture3D, uv, vec2, vec3, vec4, float, int } = tsl;
  const { abs, max, min, mix, normalize, dot, exp, sin, smoothstep, clamp, length } = tsl;

  // ---- 布局与 billow 场（纯函数层） ----
  const layouts: CloudLayout[] = layoutClouds(opts.seed);
  const win = layoutWindow(layouts);
  const billowData = billowField(32);
  const tex3d = new THREE.Data3DTexture(billowData, 32, 32, 32);
  tex3d.format = THREE.RGBAFormat;
  tex3d.type = THREE.HalfFloatType;
  tex3d.minFilter = THREE.LinearFilter;
  tex3d.magFilter = THREE.LinearFilter;
  tex3d.wrapS = THREE.RepeatWrapping;
  tex3d.wrapT = THREE.RepeatWrapping;
  tex3d.wrapR = THREE.RepeatWrapping;
  tex3d.unpackAlignment = 1;
  tex3d.needsUpdate = true;

  // ---- 烘焙分辨率（?bgq → quality；clamp 512..2048 且受 device 上限） ----
  const deviceLimit = r.backend?.device?.limits?.maxTextureDimension2D;
  const size = Math.min(
    Math.max(opts.quality ?? BG_BAKE_SIZE_DEFAULT, 512),
    2048,
    Number.isFinite(deviceLimit) ? (deviceLimit as number) : 2048,
  );

  // ---- 烘焙目标 ----
  const crt = new webgpu.CubeRenderTarget(size, { format: THREE.RGBAFormat, type: THREE.HalfFloatType });

  // ---- uniforms：云场数据（参考 createClouds 的打包，容量同 MAX_PUFFS 240 / MAX_CLOUDS 14） ----
  const MAX_PUFFS = 240;
  const MAX_CLOUDS = 14;
  const puffVals: THREE.Vector4[] = [];
  const boundVals: THREE.Vector4[] = [];
  const infoVals: THREE.Vector4[] = [];
  layouts.forEach((c) => {
    const first = puffVals.length;
    c.puffs.forEach(([px, py, pz, pr]) => puffVals.push(new THREE.Vector4(px, py, pz, pr)));
    boundVals.push(new THREE.Vector4(c.bounds.cx, c.bounds.cy, c.bounds.cz, c.bounds.r));
    infoVals.push(new THREE.Vector4(first, c.puffs.length, c.base, c.scale));
  });
  while (puffVals.length < MAX_PUFFS) puffVals.push(new THREE.Vector4(0, 0, 0, 0));
  while (boundVals.length < MAX_CLOUDS) boundVals.push(new THREE.Vector4(0, 0, 0, 0));
  while (infoVals.length < MAX_CLOUDS) infoVals.push(new THREE.Vector4(0, 0, 0, 0));

  // ---- 云场跟着相机走 ----
  // 布局是「绕世界原点一圈 3–7 km 的远云」。相机航线能到 20 km 外，云若钉死不重排，
  // 飞过云环之后天空就是空的（2026-11-14 实测：z=−18.8 km 处一朵都没有）。这里保留
  // 布局的**相对**几何，每次搬原点把云整体平移到相机周围，于是永远是 3–7 km 外的背景。
  const puffBase = puffVals.map((v) => v.clone());
  const boundBase = boundVals.map((v) => v.clone());
  const baseYs = layouts.map((c) => c.base);
  /** 布局坐标系的原点（生成云场时用的视点高度）。 */
  const LAYOUT_ORIGIN = new THREE.Vector3(0, 70, 0);
  const recentre = (dx: number, dy: number, dz: number): void => {
    for (let i = 0; i < puffBase.length; i += 1) {
      const b = puffBase[i];
      puffVals[i].set(b.x + dx, b.y + dy, b.z + dz, b.w);
    }
    for (let i = 0; i < boundBase.length; i += 1) {
      const b = boundBase[i];
      boundVals[i].set(b.x + dx, b.y + dy, b.z + dz, b.w);
    }
    for (let i = 0; i < baseYs.length; i += 1) infoVals[i].y = baseYs[i] + dy;
  };

  const uPuffs = uniformArray(puffVals, 'vec4');
  const uClouds = uniformArray(boundVals, 'vec4');
  const uCloudInfo = uniformArray(infoVals, 'vec4');
  const uCount = uniform(layouts.length);
  const uFace = uniform(0);
  const uStripIndex = uniform(0);
  const uTexel = uniform(3 / size);
  // 烘焙原点：**相机位置**。立方图是一张从某个点看出去的天空，相机在这个 app 里
  // 飞 3–11 km，若固定在 (0,70,0) 烘焙，云的方向会随相机位移整体打歪（2026-11-14
  // 取证：相机 (0,66.8,−6053) 时视野内只剩一张静态穹顶的画面）。update() 收到
  // 相机位移超阈值时把原点搬过去并全量重烘。
  const uOrigin = uniform(new THREE.Vector3(0, 70, 0));
  const uDebug = uniform(0); // 假色调试通道：1=方向场 2=覆盖率（0 正常出图）
  // march 窗口（§裁定 4）：全部由布局派生，禁抄参考字面量
  // minBase 可能低于相机高度（塔的 billow 下推）→ t 起点必须为正，钳到 90 m
  const uSlabStartY = uniform(Math.max(win.minBase - 200, 90));
  const uTend = uniform(win.maxDistance + 1000);
  // 光照与调色（§裁定 5/8）
  const uLightDir = uniform(new THREE.Vector3(0, 0.2, -1));
  const initial = mapPalette(opts.bands ?? [[0.14, 0.16, 0.27], [0.17, 0.19, 0.33], [0.23, 0.19, 0.31], [0.27, 0.23, 0.29]], opts.haze ?? [0.15, 0.19, 0.31]);
  const uLit = uniform(new THREE.Vector3(...initial.lit));
  const uMid = uniform(new THREE.Vector3(...initial.mid));
  const uShade = uniform(new THREE.Vector3(...initial.shade));
  const uUnder = uniform(new THREE.Vector3(...initial.under));
  const uHaze = uniform(new THREE.Vector3(...initial.haze));

  // ---- TSL：billow 采样 / smin / bgMap（out 参数重组为 vec3 返回，§裁定 2） ----
  const billow = (q: any): any => texture3D(tex3d, q);
  const sminTsl = (a: any, b: any, k: any): any => {
    const h = max(k.sub(abs(a.sub(b))), 0).div(k);
    return min(a, b).sub(h.mul(h).mul(k).mul(0.25));
  };

  const bgMap = Fn(([pImp, fineImp]: [any, any]) => {
    const p = pImp as any;
    const fine = fineImp as any;
    const d = float(1e9).toVar();
    const outBase = float(1200).toVar();
    const outScale = float(300).toVar();
    // 固定圈数 + 守卫（零填充云 bounds.r=0 → db=|p|>0 恒走 early-out，无害）
    Loop(BG_CLOUD_LOOP_MAX, ({ i }: { i: number }) => {
      const cl = uClouds.element(int(i));
      const db = length(p.sub(cl.xyz)).sub(cl.w);
      If(float(i).lessThan(uCount), () => {
        If(db.greaterThan(0), () => {
          d.assign(min(d, db.add(150)));
        }).Else(() => {
        const info = uCloudInfo.element(int(i));
        const nP = info.y;
        const cloudIdx = float(i); // 外层云号先捕获——内层 Loop 回调的 i 会遮蔽它
        const dc = float(1e9).toVar();
        Loop(BG_PUFF_LOOP_MAX, ({ i }: { i: number }) => {
          If(float(i).lessThan(nP), () => {
            const s = uPuffs.element(int(info.x).add(int(i))); // first + puff（≤ BG_PUFF_LOOP_MAX）
            dc.assign(sminTsl(dc, length(p.sub(s.xyz)).sub(s.w), s.w.mul(0.55)));
          });
        });
        const sc = info.w;
        const q = p.div(sc.mul(7.5)).add(vec3(cloudIdx.mul(0.37)));
        const n1 = billow(q);
        const lump = float(0.55).sub(n1.r).mul(2.4);
        If(fine.greaterThan(0), () => {
          lump.addAssign(float(0.55).sub(billow(q.mul(2.7).add(0.3)).r));
          lump.addAssign(float(0.55).sub(billow(q.mul(7.3).add(0.7)).r).mul(0.36));
        });
        const dcB = dc.add(sc.mul(lump));
        const under = info.z.sub(p.y).add(
          sc.mul(
            float(0.55)
              .mul(sin(p.x.div(sc.mul(2.3)).add(float(i))))
              .mul(sin(p.z.div(sc.mul(1.9)).add(1.7)))
              .add(float(0.3).mul(sin(p.x.div(sc.mul(0.9)).add(p.z.div(sc.mul(1.2)))))),
          ),
        );
        const kk = sc.mul(1.3);
        const hh = max(kk.sub(abs(dcB.sub(under))), 0).div(kk);
        const dcC = max(dcB, under).add(hh.mul(hh).mul(kk).mul(0.25));
        If(dcC.lessThan(d), () => {
          d.assign(dcC);
          outBase.assign(info.z);
          outScale.assign(sc);
        });
        });
      });
    });
    return vec3(d, outBase, outScale);
  });

  // ---- TSL：paint（参考 clouds.js:279-310；结构常数来自 PAINT_CONSTANTS） ----
  const k1c = vec3(1, -1, -1);
  const k2c = vec3(-1, -1, 1);
  const k3c = vec3(-1, 1, -1);
  const k4c = vec3(1, 1, 1);
  const paintTsl = Fn(([pImp, baseImp, scaleImp]: [any, any, any]) => {
    const p = pImp as any;
    const base = baseImp as any;
    const scale = scaleImp as any;
    const eN = scale.mul(1.2);
    const dN1 = bgMap(p.add(k1c.mul(eN)), float(0)).x;
    const dN2 = bgMap(p.add(k2c.mul(eN)), float(0)).x;
    const dN3 = bgMap(p.add(k3c.mul(eN)), float(0)).x;
    const dN4 = bgMap(p.add(k4c.mul(eN)), float(0)).x;
    const Ns = normalize(k1c.mul(dN1).add(k2c.mul(dN2)).add(k3c.mul(dN3)).add(k4c.mul(dN4)));
    const eF = scale.mul(0.65);
    const dF1 = bgMap(p.add(k1c.mul(eF)), float(1)).x;
    const dF2 = bgMap(p.add(k2c.mul(eF)), float(1)).x;
    const dF3 = bgMap(p.add(k3c.mul(eF)), float(1)).x;
    const dF4 = bgMap(p.add(k4c.mul(eF)), float(1)).x;
    const Nf = normalize(k1c.mul(dF1).add(k2c.mul(dF2)).add(k3c.mul(dF3)).add(k4c.mul(dF4)));
    const N = normalize(Ns.mul(0.8).add(Nf));
    // L = normalize(lightDir + (0, liftY, 0) − radial·pull)（参考 clouds.js:293 + §裁定 8 的兜底语义）
    const L = normalize(
      uLightDir.add(vec3(0, PAINT_CONSTANTS.liftY, 0)).sub(
        normalize(vec3(p.x, 0, p.z)).mul(PAINT_CONSTANTS.radialPull),
      ),
    );
    const shNear = clamp(
      bgMap(p.add(L.mul(scale.mul(PAINT_CONSTANTS.shadowNear))), float(0)).x
        .negate().div(scale.mul(0.8)),
      0,
      1,
    ).mul(PAINT_CONSTANTS.shadowNearW);
    const shFar = clamp(
      bgMap(p.add(L.mul(scale.mul(PAINT_CONSTANTS.shadowFar))), float(0)).x
        .negate().div(scale.mul(1.4)),
      0,
      1,
    ).mul(PAINT_CONSTANTS.shadowFarW);
    const shadow = shNear.add(shFar);
    const open = clamp(
      bgMap(p.add(Nf.mul(scale.mul(1.2))), float(1)).x.div(scale.mul(1.2)),
      0,
      1,
    );
    const up = smoothstep(0, scale.mul(7), p.y.sub(base));
    const light = dot(N, L).mul(0.5).add(0.5).mul(exp(shadow.negate().mul(PAINT_CONSTANTS.lightExpo)))
      .add(up.mul(PAINT_CONSTANTS.litUp))
      .add(open.sub(0.5).mul(PAINT_CONSTANTS.litOpen))
      .add(N.y.mul(PAINT_CONSTANTS.litNy));
    const broad = dot(Ns, L).mul(0.5).add(0.5).mul(exp(shadow.negate()))
      .add(up.mul(PAINT_CONSTANTS.broadUp))
      .add(Ns.y.mul(PAINT_CONSTANTS.broadNy))
      .add(billow(p.div(scale.mul(16)).add(0.3)).b.sub(0.5).mul(PAINT_CONSTANTS.broadBillow));
    // inShade *= 1 − 0.07·(1 − smoothstep(0.1, 0.18, open))（fold 加深，参考 clouds.js:307）
    const deepen = float(1).sub(smoothstep(PAINT_CONSTANTS.foldRange[0], PAINT_CONSTANTS.foldRange[1], open))
      .mul(PAINT_CONSTANTS.foldDeepen);
    const inShade = mix(uShade, uMid, smoothstep(PAINT_CONSTANTS.shadeMix[0], PAINT_CONSTANTS.shadeMix[1], broad))
      .mul(float(1).sub(deepen));
    const col = mix(inShade, uLit, smoothstep(PAINT_CONSTANTS.hardEdge[0], PAINT_CONSTANTS.hardEdge[1], light));
    const hgt = p.y.sub(base).div(scale.mul(PAINT_CONSTANTS.underScale));
    return mix(uUnder, col, smoothstep(PAINT_CONSTANTS.underMix[0], PAINT_CONSTANTS.underMix[1], hgt.add(light)));
  });

  // ---- TSL：烘焙 fragment（march + 描边 + 霾 + premultiplied；Discard 条带掩码） ----
  const bakeFrag = Fn(() => {
    const st = vec2(uv().x.mul(2).sub(1), uv().y.mul(2).sub(1));
    const rd = vec3(0, 0, 1).toVar();
    const outC = vec4(0, 0, 0, 0).toVar();
    // 面 → 方向（2026-11-14 取证改写：原 If/ElseIf×5 + Else 链在 uFace=4/5 时全链不赋值，
    // rd 停回 (0,0,1) → rd.y=0 被地平线门整面弃掉，±Z 两面永远烘不进去。改成无分支掩码。）
    const fIdx = uFace.toFloat();
    const mOf = (k: number) => float(1).sub(abs(fIdx.sub(k)).min(1));
    const m0 = mOf(0);
    const m1 = mOf(1);
    const m2 = mOf(2);
    const m3 = mOf(3);
    const m4 = mOf(4);
    const m5 = mOf(5);
    let rdX = mix(st.x, float(1), m0);
    rdX = mix(rdX, float(-1), m1);
    rdX = mix(rdX, st.x.negate(), m5);
    // 2026-11-14 取证：立方面在 RT 里的行序与 cubemap 采样约定相反（不改这里的话，
    // 烘出来的云在地平线以下、天空侧永远 gate 成 0）。t 轴（侧面 = y，顶面 = z）取反。
    let rdY = mix(st.y, float(1), m2);
    rdY = mix(rdY, float(-1), m3);
    let rdZ = mix(st.x.negate(), st.x, m1);
    rdZ = mix(rdZ, st.y.negate(), m2);
    rdZ = mix(rdZ, st.y, m3);
    rdZ = mix(rdZ, float(1), m4);
    rdZ = mix(rdZ, float(-1), m5);
    rd.assign(vec3(rdX, rdY, rdZ));
    // 条带掩码（Task 0：Discard + autoClear=false）+ 水平线以下门（§裁定 4 的 0.002 防除零）。
    // 注意：Discard 必须用链式 .discard() 形式——If(cond, () => { Discard(); }) 会把
    // 整个片元输出吞掉（2026-11-14 输出级二分 P2/P4 实证，probe4 的链式形式则正常）。
    const v = uv().y;
    v.lessThan(uStripIndex.div(STRIPS_PER_FACE)).discard();
    v.greaterThanEqual(uStripIndex.add(1).div(STRIPS_PER_FACE)).discard();
    rd.y.lessThan(0.002).discard();
    const ro = uOrigin;
    const rdNpre = normalize(rd).toVar();
    // 假色 1：方向场（验证面/掩码/uv 指向）—— TSL 无提前 return，全部走 out 赋值
    If(uDebug.equal(1), () => {
      outC.assign(vec4(rdNpre.y.mul(0.5).add(0.5), rdNpre.x.mul(0.5).add(0.5), rdNpre.z.mul(0.5).add(0.5), 1));
    });
    // ---- march（假色模式下也照跑：调试路径不做性能优化，省得两套分支各自过期） ----
    // 起点钳到 [0, 2000]：参考的「从 slab 底面起飞」在这里是 t = (uSlabStartY − ro.y)/rd.y
    // （滑动太阳下约 20/rd.y），掠射视线（rd.y 只被门钳到 0.002）会算出 10 km —— 直接越过
    // 3–7 km 云带，那片像素永远采不到云。钳住上限后交给 SDF 自己推进。
    const t = clamp(uSlabStartY.sub(ro.y).div(rd.y), 0, 2000).toVar();
    const tEnd = uTend.toVar();
    const near = float(1e9).toVar();
    const tNear = t.toVar();
    const hit = float(0).toVar();
    const before = t.toVar();
    const rdN = normalize(rd).toVar();
    Loop(STEPS, () => {
      If(t.lessThan(tEnd).and(hit.equal(0)), () => {
        const d = bgMap(ro.add(rdN.mul(t)), float(1)).x;
        If(d.lessThanEqual(0), () => {
          hit.assign(1);
        }).Else(() => {
          If(d.lessThan(near.mul(t)), () => {
            near.assign(d.div(t));
            tNear.assign(t);
          });
          before.assign(t);
          t.addAssign(max(d.mul(0.5), 30));
        });
      });
    });
    const alpha = float(0).toVar();
    const tHit = t.toVar();
    If(hit.equal(1), () => {
      const lo = before.toVar();
      const hi = t.toVar();
      Loop(9, () => {
        const mid = lo.add(hi).mul(0.5);
        If(bgMap(ro.add(rdN.mul(mid)), float(1)).x.greaterThan(0), () => {
          lo.assign(mid);
        }).Else(() => {
          hi.assign(mid);
        });
      });
      tHit.assign(hi);
      alpha.assign(1);
    }).Else(() => {
      If(near.lessThan(uTexel), () => {
        tHit.assign(tNear);
        alpha.assign(float(1).sub(near.div(uTexel)));
      });
    });
    // 假色 2：覆盖率（alpha 直出）
    If(uDebug.equal(2), () => {
      outC.assign(vec4(alpha, alpha, alpha, 1));
    });
    If(uDebug.equal(0), () => {
      // 空像素显式 alpha=0，且必须整面都写：材质是 transparent + premultipliedAlpha
      // （不透明材质在 WebGPU 管线里会把片元 alpha 强制成 1，空 texel 就是「满覆盖」，
      // 天空合成 rgb + sky·(1−a) 被压成纯黑——2026-11-14 取证）。
      outC.assign(vec4(0, 0, 0, 0));
      If(alpha.greaterThan(0), () => {
        const p = ro.add(rdN.mul(tHit));
        const info = bgMap(p, float(1));
        const col = paintTsl(p, info.y, info.z);
        // 霾（§裁定 4：BG_HAZE_METRES=12000；参考 clouds.js:362 的形状）
        const haze = float(1).sub(exp(tHit.negate().div(BG_HAZE_METRES)))
          .mul(mix(1, 0.45, smoothstep(0.03, 0.35, rdN.y)));
        outC.assign(vec4(mix(col, uHaze, haze).mul(alpha), alpha));
      });
    });
    return outC;
  });

  // ---- 烘焙场景（全屏正交四边形；与主场景无关） ----
  // 烘焙材质必须能写 alpha：不透明材质在 WebGPU 管线里把片元 alpha 强制成 1
  // （2026-11-14 取证：assign 0 读回仍为 1，导致空 texel 也是"满覆盖"，天空被压成
  // 纯黑）。这里开 transparent + premultipliedAlpha：输出 rgb 已预乘 alpha，混合
  // 因子 One / OneMinusSrcAlpha 恰好把覆盖度累加到 alpha，空 texel 保留 clear 的 0。
  const bakeMat = new webgpu.MeshBasicNodeMaterial();
  bakeMat.transparent = true;
  bakeMat.premultipliedAlpha = true;
  bakeMat.colorNode = bakeFrag();
  const bakeGeo = new THREE.PlaneGeometry(2, 2);
  const bakeScene = new THREE.Scene();
  bakeScene.add(new THREE.Mesh(bakeGeo, bakeMat));
  const bakeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const emptyScene = new THREE.Scene();
  // 空像素靠 clear 写 alpha=0：烘焙材质自己 assign 0 会被不透明管线强制成 1，
  // 只有 clear 路径真正保留 alpha（2026-11-14 取证）。材质已开 transparent +
  // premultipliedAlpha，写入的覆盖度会正确累加到 alpha 上。
  const clearFace = (f: number): void => {
    r.setRenderTarget(crt, f);
    // 视口必须是面尺寸：渲染器当前视口属于游戏主循环（竖屏列坐标），在
    // 立方面上完全出界 → 零片元（2026-11-14 数值取证定位的真凶）。
    r.setViewport(0, 0, size, size);
    r.autoClear = true;
    r.setClearColor(0x000000, 0);
    r.render(emptyScene, bakeCam);
  };

  // ---- 条带调度状态 ----
  let disposed = false;
  let visible = true;
  let cursor = 0; // 0..39，循环推进
  let stale = 0;
  let paletteVersion = 0;
  let lastPaletteFp = Number.NaN;
  const prevLight: LightState = { azDeg: 0, elDeg: 0, paletteVersion: 0 };
  let haveLight = false;

  const bakeStrip = (face: number, strip: number): void => {
    uFace.value = face;
    uStripIndex.value = strip;
    r.setRenderTarget(crt, face);
    // 视口 = 面尺寸（同 clearFace 注释——不设则继承游戏竖屏视口，全出界）
    r.setViewport(0, 0, size, size);
    r.autoClear = false; // 带外内容保留（Task 0 机制）
    r.render(bakeScene, bakeCam);
  };

  const bakeAll = (): void => {
    if (disposed) return;
    // 先存下渲染器当前视口（主循环的竖屏列），烘完原样还回去——写死 1280×720 只是
    // 「大多数时候对了」，画布一变就把主画面挤出屏幕。
    const saved = new THREE.Vector4(0, 0, 1280, 720);
    if (r.getViewport) r.getViewport(saved);
    for (let f = 0; f < 6; f += 1) clearFace(f);
    for (let i = 0; i < TOTAL_STRIPS; i += 1) {
      bakeStrip(BAKE_FACES[Math.floor(cursor / STRIPS_PER_FACE)], cursor % STRIPS_PER_FACE);
      cursor = (cursor + 1) % TOTAL_STRIPS;
    }
    r.setRenderTarget(null);
    r.setViewport(saved.x, saved.y, saved.z, saved.w);
    r.autoClear = true;
  };

  // ---- 初始化：光照先行（终审 C4：首烘必须用真实太阳方向，不能用默认光向） ----
  const sunDirLive = new THREE.Vector3(0, 0.2, -1);
  if (opts.sunDir) sunDirLive.copy(opts.sunDir);
  const el0 = (Math.asin(Math.max(-1, Math.min(1, sunDirLive.y))) * 180) / Math.PI;
  const blend0 = lightBlend([sunDirLive.x, sunDirLive.y, sunDirLive.z], el0);
  uLightDir.value.set(blend0.dir[0], blend0.dir[1], blend0.dir[2]);

  // ---- 全量首烘（首帧即有云，抓帧契约） ----
  bakeAll();
  r.setRenderTarget(null);
  r.setClearColor(0x000000, 1); // 恢复中性 clear（主循环由 post 管线管理目标）

  // 编译预热（init 期一次，运行时零编译）
  try {
    await r.compileAsync(bakeScene, bakeCam);
  } catch {
    // compileAsync 失败不阻断（首 render 仍会编译）
  }

  const handles: BgCumulusHandles = {
    get count(): number {
      return layouts.length;
    },
    get texture(): THREE.Texture {
      return crt.texture;
    },

    update(_t: number, sunDir: THREE.Vector3, cameraPos?: THREE.Vector3): void {
      if (disposed) return;
      if (sunDir && Number.isFinite(sunDir.x) && sunDir.lengthSq() > 1e-9) sunDirLive.copy(sunDir);
      // uLightDir：未归一混合向量（§裁定 8；shader 加 lift 后归一）
      const el = (Math.asin(Math.max(-1, Math.min(1, sunDirLive.y))) * 180) / Math.PI;
      const blend = lightBlend([sunDirLive.x, sunDirLive.y, sunDirLive.z], el);
      uLightDir.value.set(blend.dir[0], blend.dir[1], blend.dir[2]);
      if (!visible) return; // 关云时停烘
      // 相机锚定：立方图是「从某点看出去的天空」，相机飞远后不重烘就是一张贴错位置的
      // 静态穹顶（§裁定 1 的有限半径视差）。位移超 REBAKE_METRES 时搬原点并全量重烘。
      if (cameraPos && Number.isFinite(cameraPos.x)) {
        const moved = (uOrigin.value as THREE.Vector3).distanceTo(cameraPos);
        if (moved > REBAKE_METRES) {
          const o = uOrigin.value as THREE.Vector3;
          // 用「相对布局原点的绝对位移」重算，不用增量：增量式重定心在第二次搬原点时
          // 会把之前的位移丢掉，云会一点点爬回世界原点（2026-11-14 实测）。
          recentre(cameraPos.x - LAYOUT_ORIGIN.x, cameraPos.y - LAYOUT_ORIGIN.y, cameraPos.z - LAYOUT_ORIGIN.z);
          o.copy(cameraPos);
          stale = TOTAL_STRIPS;
        }
      }
      const az = wrap180((Math.atan2(-sunDirLive.x, -sunDirLive.z) * 180) / Math.PI);
      const next: LightState = { azDeg: az, elDeg: el, paletteVersion };
      if (!haveLight) {
        prevLight.azDeg = az;
        prevLight.elDeg = el;
        prevLight.paletteVersion = paletteVersion;
        haveLight = true;
        // 首帧登记按 dirty 处理（终审 C4）：init 烘焙用 fallback 色板，正式轨道色
        // 由首帧 syncSun 灌入后需全量追平——标记 stale 让后续帧 8 条带/帧收敛。
        stale = TOTAL_STRIPS;
        return;
      }
      const bb = bakeBudget(prevLight, next, stale);
      stale = bb.staleStrips;
      prevLight.azDeg = next.azDeg;
      prevLight.elDeg = next.elDeg;
      prevLight.paletteVersion = next.paletteVersion;
      if (bb.strips > 0) {
        const saved = new THREE.Vector4(0, 0, 1280, 720);
        if (r.getViewport) r.getViewport(saved);
        for (let i = 0; i < bb.strips; i += 1) {
          bakeStrip(BAKE_FACES[Math.floor(cursor / STRIPS_PER_FACE)], cursor % STRIPS_PER_FACE);
          cursor = (cursor + 1) % TOTAL_STRIPS;
        }
        r.setRenderTarget(null);
        r.setViewport(saved.x, saved.y, saved.z, saved.w); // 还原主循环视口
        r.autoClear = true;
      }
    },

    setLight(p: { bands: readonly Vec3[]; haze: Vec3 }): void {
      if (disposed) return;
      const c = mapPalette(p.bands, p.haze);
      // 色值指纹：syncSun 逐帧灌同值时不递增 paletteVersion（否则 idle-stop 永远
      // 不生效——每帧 1 条带 1024² 重烘 = 1 fps 的根因，2026-11-14 取证）。
      const fp = [c.lit, c.mid, c.shade, c.under, c.haze].flat().reduce((a, v) => a + v, 0);
      if (Math.abs(fp - lastPaletteFp) < 1e-4) return;
      lastPaletteFp = fp;
      (uLit.value as THREE.Vector3).set(c.lit[0], c.lit[1], c.lit[2]);
      (uMid.value as THREE.Vector3).set(c.mid[0], c.mid[1], c.mid[2]);
      (uShade.value as THREE.Vector3).set(c.shade[0], c.shade[1], c.shade[2]);
      (uUnder.value as THREE.Vector3).set(c.under[0], c.under[1], c.under[2]);
      (uHaze.value as THREE.Vector3).set(c.haze[0], c.haze[1], c.haze[2]);
      paletteVersion += 1;
    },

    drawAll(): void {
      bakeAll();
    },

    setVisible(v: boolean): void {
      if (disposed) return;
      visible = v;
    },

    /** 假色调试（Task 3 冒烟 / Task 6 目检）：0 关、1 方向场、2 覆盖率。 */
    debugMode(n: number): void {
      uDebug.value = n;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      bakeGeo.dispose();
      bakeMat.dispose();
      crt.dispose();
      tex3d.dispose();
    },
  };
  return handles;
}
