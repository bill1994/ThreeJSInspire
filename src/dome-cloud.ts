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
 * - **light march 只取一次近似**：朝太阳方向 120 m 处采一次密度当遮挡，而不是
 *   每步再打 4 步。28 步 × 4 步的光行进在手机上不现实；P1 先要「有明暗」。
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
/** 朝太阳方向做一次近似遮挡采样时的距离（米）。 */
const LIGHT_PROBE_METRES = 120;
/** 步长曲线的指数，与 `stepSizes()` 的 `p` 必须一致。 */
export const STEP_CURVE_POWER = 2.2;

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
  setQuality(high: boolean): void;
  setVisible(visible: boolean): void;
  dispose(): void;
  readonly ready: boolean;
}

/** V3 uniform 的初值；真正的颜色由 `setCloudPalette` 每帧灌。 */
const FALLBACK_BANDS: readonly Vec3[] = [
  [0.14, 0.16, 0.27],
  [0.17, 0.19, 0.33],
  [0.23, 0.19, 0.31],
  [0.27, 0.23, 0.29],
];
const FALLBACK_HAZE: Vec3 = [0.15, 0.19, 0.31];

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
    smoothstep,
    mix,
    exp,
    dot,
    normalize,
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

    const coverage = smoothstep(0.30, 0.46, weather);
    const body = clamp(shape.sub(float(1.0).sub(coverage)).div(max(coverage, 0.28)), 0, 1);
    const eroded = body.sub(float(1.0).sub(detail).mul(0.32));
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

      // 单次朝太阳的近似遮挡（P1：不做逐层 light march）。
      // probe 是**密度**，必须先乘光程与消光系数变成光学厚度，否则 exp 项恒接近 1，
      // 太阳项只剩百分之几（复审 I2）。
      const probe = densityAt(p.add(uSunDir.mul(LIGHT_PROBE_METRES)));
      const trans = exp(probe.mul(-(LIGHT_PROBE_METRES * DENSITY_SCALE)));

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
      const sampleColor = ambient.add(lit);

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
