/**
 * src/dome-cloud.ts — 穹顶云的装配：纹理、材质、盒 mesh 与每帧句柄。
 *
 * 几何契约在 `dome-cloud-field.ts`（纯函数、可测），密度在 `dome-cloud-noise.ts`，
 * 光照在 `dome-cloud-light.ts`。本文件只负责把它们焊成一个能画的物体。
 *
 * 关键取舍（2026-11-09，P1）：
 *
 * - **步长曲线与 JS 镜像同源**：shader 里用 `t_i = span · ((i+1)/count)^2.2`，
 *   这正是 `stepSizes()` 那个权重曲线的累积形式。改一边必须改另一边。
 * - **light march 分档**：low 档保留 P1 的单探针（朝太阳 120 m 采一次密度当遮挡）；
 *   P1.5 起 high 档在密度门内做 3 采样 march（Δ = 40 m）。28 步 × 每步 4 采样以上
 *   的光行进在手机上仍不现实，密度门让 march 只花在云体上。
 * - **垂直 profile 调制（P1.5 分层）**：密度在 body 上乘
 *   `ceiling·(0.72 + 0.28·sin(yn·3+φ))`——整层 3 个周期的水平分层。τ 随之同变
 *   （light march 采样同一 densityAt，光照与几何一致才自然，拍板 R10）。
 *   量纲红线：sin 只吃归一化高度 yn，ceiling 只吃米制世界高度。
 * - **盒子自己跟随相机**：不挂 `far-field.ts` 的名字白名单。盒壁处 `fadeEnd`
 *   已经让云全透明，所以看不见盒子边。
 *
 * 设计见 `docs/superpowers/specs/2026-11-09-dome-cloud-volumetric-design.md`。
 */

import * as THREE from 'three';

import { DOME_SLAB, driftOffset } from './dome-cloud-field';
import { generateDetailVolume, generateShapeVolume, generateWeatherMap } from './dome-cloud-noise';
import type { Vec3 } from './sky-track';
import type { WorldView } from './world';

/** 骨架体积边长（两档共用，`setQuality` 绝不重烘）。 */
const SHAPE_SIZE = 96;
/** 侵蚀细节边长。 */
const DETAIL_SIZE = 32;
/** 天气图边长（2D）。 */
const WEATHER_SIZE = 512;
/** detail 纹理在世界里铺开的边长（米）。 */
const DETAIL_TILE_METRES = 400;
/** 天气图在世界里铺开的边长（米）。 */
const WEATHER_TILE_METRES = 8000;
/** 云层厚度（米）。 */
const SLAB_HEIGHT = DOME_SLAB.top - DOME_SLAB.base;
/** 密度换算到消光系数的比例。 */
const DENSITY_SCALE = 0.038;
/** low 档单探针的朝太阳采样距离（米）——P1.5 起只由 low 档使用（成本开关，风险 §10.3）。 */
const LIGHT_PROBE_METRES = 120;
/** P1.5 high 档三采样 light march 的步长（米）。 */
const LIGHT_MARCH_DELTA_METRES = 40;
/**
 * P1.5 垂直 profile 调制的基线（sin 波形直流分量）：profile ∈ [0.72−0.28, 0.72]。
 * 标定窗口（设计）：频率 2–4、幅度 0.20–0.32；移动任一项需在提交信息注明原因。
 */
const PROFILE_BASE = 0.72;
/** P1.5 垂直 profile 调制的幅度。 */
const PROFILE_AMPLITUDE = 0.28;
/**
 * P1.5 垂直 profile 调制的相位 φ。puff cloud 的散布 seed 是 7（`src/puff-cloud.ts`
 * 的 `seed = 7`），这里取 dome 噪声 seed 0x5eed 低 10 位的归一化（749/1024），
 * 与 puff 不同源，避免与 puff 云的同相位条纹。
 */
const PROFILE_PHASE = 0.7314;
/** 步长曲线的指数，与 `stepSizes()` 的 `p` 必须一致。 */
export const STEP_CURVE_POWER = 2.2;

/**
 * P2 flat 档的四档阈值（Task 6）：把**光照权重**（light march 透射率 trans，0..1）
 * 硬切成 `cloudBands[0..3]` 四档代表色的切点。与 `puff-cloud.ts` 的
 * `PUFF_BAND_THRESHOLDS` 思路同构（量化光照权重、不量化输出亮度，设计 §11.1
 * 定案），但数值**独立标定**——体积云的 trans 分布和 mesh 平涂的 wrap 不是一回事。
 *
 * 标定方法与出处（Task 6，抓帧定数）：以 soft 帧云掩码亮度四分位为目标档位占比
 * （各 ~25%），用 flat 帧实测的 trans 经验 CDF 反解切点。`?qa=frozen&pos=0,240,-300`
 * 机位（太阳仰角 6.97°）三轮实测（加权占比，`analyze_p15_look.py`）：
 *   [0.20, 0.40, 0.68]（puff 占位）→ 21.6 / 17.2 / 23.6 / 37.7%
 *   [0.24, 0.53, 0.79]           → 22.4 / 19.6 / 26.1 / 32.0%
 *   [0.28, 0.61, 0.84]（定数）    → 22.4 / 18.6 / 27.4 / 31.6%
 * 迭代在定数处停：阈值每挪 0.04–0.08 屏幕占比只动 ≤1.5pp（屏幕色是整条射线多样本
 * 的加权平均，不跟随单样本 CDF；trans 在 1 附近有大质量团，精确四分位不可达），
 * 且再往上 band3 宽度就跌破 puff 标定的「每档 ≥0.15」下限（定数处 0.16）。
 * 四档全部在场上（18.6–31.6%），无档位空转。帧证据：`p15-look-flat-*-r2/r3.png`。
 * 改动任一数值必须同步 src/dome-cloud.test.ts 的钉死用例并在提交信息注明原因。
 */
export const FLAT_BAND_THRESHOLDS = [0.28, 0.61, 0.84] as const;

/** 一个质量档的采样预算。 */
export interface DomeCloudQuality {
  steps: number;
  octaves: number;
}

/**
 * 两档的采样预算。
 *
 * **只改采样成本，不改纹理分辨率**——`setQuality` 在机器已经卡的时候被调用，
 * 那里绝不能重烘 128³（约 1 秒）。
 */
export function qualityParams(high: boolean): DomeCloudQuality {
  return high ? { steps: 28, octaves: 2 } : { steps: 16, octaves: 1 };
}

/**
 * 云盒的尺寸（米）。**无参数**：盒子的尺寸只能来自 `DOME_SLAB`，
 * 不得从窗口尺寸或 fov 推导，否则窄窗口下会溢出或铺不满。
 */
export function boxScale(): { x: number; y: number; z: number } {
  return {
    x: DOME_SLAB.halfExtent * 2,
    y: SLAB_HEIGHT,
    z: DOME_SLAB.halfExtent * 2,
  };
}

/** 穹顶云对外句柄。 */
export interface DomeCloudHandles {
  update(t: number, sunDir: THREE.Vector3, view?: WorldView): void;
  setCloudPalette(bands: readonly Vec3[], haze: Vec3): void;
  setSunColor(color: Vec3): void;
  /** P2 两套看法：soft（连续光照，默认）/ flat（四档平涂，只动输出色）。 */
  setCloudLook(look: 'soft' | 'flat'): void;
  setQuality(high: boolean): void;
  setVisible(visible: boolean): void;
  dispose(): void;
  readonly ready: boolean;
}

/** V3 uniform 的初值；真正的颜色由 `setCloudPalette` 每帧灌。
 *  导出给 `dome-horizon.ts`（Task 7）作首帧色——两层同值，正式色同走 syncSun 单源。 */
export const FALLBACK_BANDS: readonly Vec3[] = [
  [0.14, 0.16, 0.27],
  [0.17, 0.19, 0.33],
  [0.23, 0.19, 0.31],
  [0.27, 0.23, 0.29],
];
export const FALLBACK_HAZE: Vec3 = [0.15, 0.19, 0.31];

export async function initDomeCloud(
  scene: THREE.Scene,
  renderer: unknown,
  sunDir: THREE.Vector3,
): Promise<DomeCloudHandles> {
  // 没有 renderer 就没有 GPU 管线可挂——直接抛，交给 world 的 try/catch。
  // 这条也顺带避免了在纯 node 测试里白生成 128³（约 1 秒/次）。
  if (!renderer) throw new Error('dome cloud needs a renderer');

  const threeMod = (await import('three/webgpu')) as unknown as typeof import('three/webgpu');
  const tsl = (await import('three/tsl')) as unknown as Record<string, any>;

  const {
    Data3DTexture,
    DataTexture,
    RedFormat,
    LinearFilter,
    RepeatWrapping,
    BoxGeometry,
    Mesh,
    NodeMaterial,
    BackSide,
    Vector3,
    UnsignedByteType,
  } = threeMod as any;

  const {
    Fn,
    float,
    vec2,
    vec3,
    vec4,
    texture,
    texture3D,
    cameraPosition,
    positionWorld,
    uniform,
    screenCoordinate,
    interleavedGradientNoise,
    max,
    min,
    pow,
    sin,
    smoothstep,
    mix,
    exp,
    dot,
    normalize,
    step,
    Loop,
    If,
    Break,
    clamp,
  } = tsl;

  // ---- 纹理：128³ / 32³ 用 Data3DTexture，512² 用 DataTexture -----------------
  const shapeData = generateShapeVolume(SHAPE_SIZE, 0x5eed);
  const detailData = generateDetailVolume(DETAIL_SIZE, 0x5eed);
  const weatherData = generateWeatherMap(WEATHER_SIZE, 0x5eed);

  const shapeTex = new Data3DTexture(shapeData, SHAPE_SIZE, SHAPE_SIZE, SHAPE_SIZE);
  shapeTex.format = RedFormat;
  shapeTex.type = UnsignedByteType;
  shapeTex.minFilter = LinearFilter;
  shapeTex.magFilter = LinearFilter;
  shapeTex.wrapS = RepeatWrapping;
  shapeTex.wrapT = RepeatWrapping;
  shapeTex.wrapR = RepeatWrapping;
  shapeTex.unpackAlignment = 1;
  shapeTex.needsUpdate = true;

  const detailTex = new Data3DTexture(detailData, DETAIL_SIZE, DETAIL_SIZE, DETAIL_SIZE);
  detailTex.format = RedFormat;
  detailTex.type = UnsignedByteType;
  detailTex.minFilter = LinearFilter;
  detailTex.magFilter = LinearFilter;
  detailTex.wrapS = RepeatWrapping;
  detailTex.wrapT = RepeatWrapping;
  detailTex.wrapR = RepeatWrapping;
  detailTex.unpackAlignment = 1;
  detailTex.needsUpdate = true;

  const weatherTex = new DataTexture(weatherData, WEATHER_SIZE, WEATHER_SIZE);
  weatherTex.format = RedFormat;
  weatherTex.type = UnsignedByteType;
  weatherTex.minFilter = LinearFilter;
  weatherTex.magFilter = LinearFilter;
  weatherTex.wrapS = RepeatWrapping;
  weatherTex.wrapT = RepeatWrapping;
  weatherTex.unpackAlignment = 1;
  weatherTex.needsUpdate = true;

  // ---- uniform（太阳按引用共享，与 sea 的做法一致）--------------------------
  const uSunDir = uniform(sunDir);
  const uSunColor = uniform(new Vector3(1.0, 0.78, 0.62));
  const uHaze = uniform(new Vector3(...FALLBACK_HAZE));
  const uBand0 = uniform(new Vector3(...FALLBACK_BANDS[0]));
  const uBand1 = uniform(new Vector3(...FALLBACK_BANDS[1]));
  const uBand2 = uniform(new Vector3(...FALLBACK_BANDS[2]));
  const uBand3 = uniform(new Vector3(...FALLBACK_BANDS[3]));
  const uSteps = uniform(qualityParams(true).steps);
  const uOctaves = uniform(qualityParams(true).octaves);
  const uDetailDrift = uniform(new THREE.Vector2(0, 0));
  const uWeatherDrift = uniform(new THREE.Vector2(0, 0));
  // P2 两套看法（Task 6）：0 = soft（默认，画面与 P1.5 一致），1 = flat（四档平涂）。
  const uLook = uniform(0);

  const halfExtent = DOME_SLAB.halfExtent;
  /** 骨架层的世界平铺边长（米）：横向用世界坐标采样，才有视差。 */
  const SHAPE_TILE_METRES = DOME_SLAB.halfExtent * 2;

  /**
   * 世界坐标 → 体积 UV。
   *
   * **横向必须用世界坐标**：骨架层如果减掉相机位置，纹理就贴在镜头上——
   * 平移零视差、偏航时图案跟着镜头转，等于一张贴图。纵向用相对云底的绝对高度。
   * 平铺由 `RepeatWrapping` 负责，所以 UV 可以超出 0..1。
   */
  const toBoxUV = Fn(([p]: [any]) => {
    const x = p.x.div(SHAPE_TILE_METRES);
    const y = p.y.sub(DOME_SLAB.base).div(SLAB_HEIGHT);
    const z = p.z.div(SHAPE_TILE_METRES);
    return vec3(x, y, z);
  });

  /** 某一点的三层密度（0..1）。 */
  const densityAt = Fn(([p]: [any]) => {
    const uvw = toBoxUV(p);

    const shape = texture3D(shapeTex).sample(vec3(uvw.x, uvw.y, uvw.z)).r;

    const weather = texture(weatherTex).sample(
      vec2(
        p.x.div(WEATHER_TILE_METRES).add(uWeatherDrift.x),
        p.z.div(WEATHER_TILE_METRES).add(uWeatherDrift.y),
      ),
    ).r;

    const baseUv = vec3(
      p.x.div(DETAIL_TILE_METRES).add(uDetailDrift.x),
      p.y.div(DETAIL_TILE_METRES),
      p.z.div(DETAIL_TILE_METRES).add(uDetailDrift.y),
    );
    const detailBase = texture3D(detailTex).sample(baseUv).r;
    // 第二个 octave 只在 high 档取：乘 2.7 让毛边尺度错开，避免自相似。
    const detailFine = texture3D(detailTex).sample(baseUv.mul(2.7).add(vec3(0.31, 0.17, 0.53))).r;
    const blended = detailBase.mul(0.65).add(detailFine.mul(0.35));
    // uOctaves 是 1 或 2，减 1 就得到 0/1 的混合权重——不用条件节点。
    const detail = mix(detailBase, blended, uOctaves.sub(1));

    // P1.5 形状标定：收窄 coverage（云更成块）、下调侵蚀权重（瓣更大更清晰）。
    // 数值由 Task 3 冻结帧抓帧标定锁死，测试 src/dome-cloud.test.ts 钉死同值。
    const coverage = smoothstep(0.32, 0.40, weather);
    const body = clamp(shape.sub(float(1.0).sub(coverage)).div(max(coverage, 0.28)), 0, 1);

    // P1.5 分层（设计 §11.3 第一轮：先调制，拆 deck 不在本计划）：垂直 profile
    // 乘在 body 上、erosion 之前。**量纲写死（复审 S3）**：sin 吃归一化高度 yn
    // （0..1，整层 3 个周期）；ceiling 吃米制世界高度，只在云底 20–100 m 平滑淡入。
    // 两处混用都致命：y（米）进 sin → 波长 1/3 m；yn 进 ceiling → ceiling 恒 0、
    // 整层云消失。τ 随之同变（拍板 R10，有意为之）：light march 采样同一 densityAt，
    // 光照与几何一致才自然。
    const y = p.y;
    const yn = y.sub(DOME_SLAB.base).div(SLAB_HEIGHT);
    const ceiling = smoothstep(DOME_SLAB.base + 20, DOME_SLAB.base + 100, y);
    const profile = ceiling.mul(
      float(PROFILE_BASE).add(
        float(PROFILE_AMPLITUDE).mul(sin(yn.mul(3).add(PROFILE_PHASE).mul(2 * Math.PI))),
      ),
    );
    const modulated = body.mul(profile);
    const eroded = modulated.sub(float(1.0).sub(detail).mul(0.18));
    return clamp(eroded, 0, 1);
  });

  /** 两瓣 HG 相函数（与 `dome-cloud-light.ts` 的常量对齐）。 */
  const phaseAt = Fn(([cosTheta]: [any]) => {
    const fwdDen = max(float(1).add(0.36).sub(cosTheta.mul(1.2)), 1e-4);
    const bwdDen = max(float(1).add(0.09).add(cosTheta.mul(0.6)), 1e-4);
    const fwd = float(0.64).div(float(4 * Math.PI).mul(pow(fwdDen, 1.5)));
    const bwd = float(0.91).div(float(4 * Math.PI).mul(pow(bwdDen, 1.5)));
    return fwd.mul(0.7).add(bwd.mul(0.3));
  });

  const colorNode = Fn(() => {
    const rayDir = normalize(positionWorld.sub(cameraPosition));
    const dy = rayDir.y;

    // 相机永远在云下：只有向上的射线才可能进 slab。
    const denom = max(dy, 1e-4);
    const tEnter = float(DOME_SLAB.base).sub(cameraPosition.y).div(denom);
    const tTop = float(DOME_SLAB.top).sub(cameraPosition.y).div(denom);
    const tExitBox = positionWorld.sub(cameraPosition).length();

    const t0 = max(tEnter, 0);
    const t1 = min(min(tTop, tExitBox), DOME_SLAB.fadeEnd);
    const span = max(t1.sub(t0), 0).mul(smoothstep(1e-4, 4e-3, dy));

    const jitter = interleavedGradientNoise(screenCoordinate.xy, 0);

    const acc = vec3(0).toVar();
    const accA = float(0).toVar();

    Loop(uSteps, ({ i }: any) => {
      const u = pow(float(i).add(jitter).add(1).div(uSteps), STEP_CURVE_POWER);
      const t = t0.add(span.mul(u));
      const p = cameraPosition.add(rayDir.mul(t));

      const den = densityAt(p);

      // P1.5 光照分支：判据复用 uOctaves（1 = low，2 = high），不新增 uniform。
      // low 档保留 P1 的单次探针；high 档在密度门内做 3 采样 light march。
      const trans = float(1).toVar();
      If(uOctaves.lessThan(1.5), () => {
        // 单次朝太阳的近似遮挡（P1：不做逐层 light march）。
        // probe 是**密度**，必须先乘光程与消光系数变成光学厚度，否则 exp 项恒接近 1，
        // 太阳项只剩百分之几（复审 I2）。
        const probe = densityAt(p.add(uSunDir.mul(LIGHT_PROBE_METRES)));
        trans.assign(exp(probe.mul(-(LIGHT_PROBE_METRES * DENSITY_SCALE))));
      }).Else(() => {
        // 密度门：稀薄处不必 march，透过率保持初值 1。
        If(den.greaterThan(0.12), () => {
          // 三采样 light march——与 dome-cloud-light.ts 的 marchTransmittance 同式：
          // τ = Σ density·Δ·σ，T = exp(−τ)。
          const tap1 = densityAt(p.add(uSunDir.mul(LIGHT_MARCH_DELTA_METRES)));
          const tap2 = densityAt(p.add(uSunDir.mul(LIGHT_MARCH_DELTA_METRES * 2)));
          const tap3 = densityAt(p.add(uSunDir.mul(LIGHT_MARCH_DELTA_METRES * 3)));
          const tau = tap1.add(tap2).add(tap3).mul(LIGHT_MARCH_DELTA_METRES * DENSITY_SCALE);
          trans.assign(exp(tau.mul(-1)));
        });
      });

      const cosTheta = dot(rayDir, uSunDir);
      // HG 的量纲是 1/sr；乘 4π 把各向同性归一到 1，才能当无量纲增益用（复审 I2）。
      const phase = phaseAt(cosTheta).mul(float(4 * Math.PI));
      const powder = float(1).sub(exp(den.mul(-2.0)));

      const heightMix = smoothstep(0.0, 1.0, toBoxUV(p).y);
      const ambient = uHaze
        .mul(float(1).sub(heightMix))
        .add(uBand0.mul(heightMix.mul(0.25)))
        .add(uBand1.mul(heightMix.mul(0.25)))
        .add(uBand2.mul(heightMix.mul(0.25)))
        .add(uBand3.mul(heightMix.mul(0.25)));

      const lit = uSunColor.mul(trans).mul(phase).mul(powder);

      // P2 flat 路径（设计 §11.1 定案）：量化**光照权重** trans（light march 透射率，
      // 0..1——太阳到这点的可见度，与 puff 的 wrap 光照系数思路同构），按
      // FLAT_BAND_THRESHOLDS 硬切到 cloudBands[0..3] 四档代表色。step 的 0/1 输出
      // 套三层 mix 就是硬切：权重越高档位越亮（band0 背光芯 → band3 受光边）。
      // **只动颜色输出**：uLook 是 0/1 uniform，mix 在两端是精确选择；alpha 累积
      // （accA / sampleA）一行不碰——柔边与「切换不变形」靠这条守住
      // （反目标：四档糊 / 切换变形 / 边缘梳齿，测试 src/dome-cloud.test.ts 钉死）。
      const flatW = clamp(trans, 0, 1);
      const flatCol = mix(
        mix(
          mix(uBand0, uBand1, step(FLAT_BAND_THRESHOLDS[0], flatW)),
          uBand2,
          step(FLAT_BAND_THRESHOLDS[1], flatW),
        ),
        uBand3,
        step(FLAT_BAND_THRESHOLDS[2], flatW),
      );
      const sampleColor = mix(ambient.add(lit), flatCol, uLook);

      const stepWidth = span.mul(
        pow(float(i).add(1).div(uSteps), STEP_CURVE_POWER).sub(
          pow(float(i).div(uSteps), STEP_CURVE_POWER),
        ),
      );
      // 距离淡出必须真正参与合成，否则「盒壁处已全透明」这条不变式没人守（复审 I3）。
      const fade = float(1).sub(smoothstep(DOME_SLAB.fadeStart, DOME_SLAB.fadeEnd, t));
      const sampleA = float(1)
        .sub(exp(den.mul(DENSITY_SCALE).mul(stepWidth).mul(-1)))
        .mul(fade);

      acc.assign(acc.add(sampleColor.mul(sampleA).mul(float(1).sub(accA))));
      accA.assign(accA.add(sampleA.mul(float(1).sub(accA))));

      If(accA.greaterThan(0.985), () => {
        Break();
      });
    });

    // acc 已经是预乘色；不除回去会被非预乘混合再乘一次 alpha（复审 C2）。
    return vec4(acc.div(max(accA, 1e-4)), accA);
  });

  const material = new NodeMaterial();
  material.fog = false; // 否则 scene.fog('#c96a7a', 60, 700) 会把 700m 外的云全糊成雾色
  material.colorNode = colorNode();
  material.transparent = true;
  material.side = BackSide;
  material.depthWrite = false;
  material.depthTest = true;

  const scale = boxScale();
  const geometry = new BoxGeometry(1, 1, 1);
  const mesh = new Mesh(geometry, material);
  mesh.scale.set(scale.x, scale.y, scale.z);
  mesh.position.y = (DOME_SLAB.base + DOME_SLAB.top) / 2;
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  scene.add(mesh);

  let steps = qualityParams(true).steps;
  const elapsed = { value: 0 };

  const setQuality = (high: boolean): void => {
    const q = qualityParams(high);
    steps = q.steps;
    uSteps.value = q.steps;
    uOctaves.value = q.octaves;
  };

  return {
    ready: true,

    update(t: number, liveSun: THREE.Vector3, view?: WorldView): void {
      elapsed.value = Number.isFinite(t) ? t : 0;

      if (view?.camera) {
        mesh.position.x = view.camera.x;
        mesh.position.z = view.camera.z;
      }

      if (liveSun) uSunDir.value.copy(liveSun);

      const detail = driftOffset(elapsed.value, 'detail');
      uDetailDrift.value.set(detail.x / DETAIL_TILE_METRES, detail.z / DETAIL_TILE_METRES);

      const weather = driftOffset(elapsed.value, 'weather');
      uWeatherDrift.value.set(weather.x / WEATHER_TILE_METRES, weather.z / WEATHER_TILE_METRES);

      // 步数由质量档决定；这里只是为了不让 `steps` 成为未使用变量。
      void steps;
      void renderer;
    },

    setCloudPalette(bands: readonly Vec3[], haze: Vec3): void {
      if (bands?.length >= 4) {
        uBand0.value.set(bands[0][0], bands[0][1], bands[0][2]);
        uBand1.value.set(bands[1][0], bands[1][1], bands[1][2]);
        uBand2.value.set(bands[2][0], bands[2][1], bands[2][2]);
        uBand3.value.set(bands[3][0], bands[3][1], bands[3][2]);
      }
      if (haze) uHaze.value.set(haze[0], haze[1], haze[2]);
    },

    /** 太阳颜色随仰角变化，由 `main.ts` 的 `syncSun` 灌（复审 I1）。 */
    setSunColor(color: Vec3): void {
      if (color) uSunColor.value.set(color[0], color[1], color[2]);
    },

    /** P2 两套看法（Task 6）：`?cloudlook` 启动灌一次，syncSun 不碰这个档位。 */
    setCloudLook(look: 'soft' | 'flat'): void {
      uLook.value = look === 'flat' ? 1 : 0;
    },

    setQuality,

    setVisible(visible: boolean): void {
      mesh.visible = visible;
    },

    dispose(): void {
      scene.remove(mesh);
      geometry.dispose();
      material.dispose();
      shapeTex.dispose();
      detailTex.dispose();
      weatherTex.dispose();
    },
  };
}
