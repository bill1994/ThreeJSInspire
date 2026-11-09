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
const SHAPE_SIZE = 128;
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
const DENSITY_SCALE = 0.0045;
/** 朝太阳方向做一次近似遮挡采样时的距离（米）。 */
const LIGHT_PROBE_METRES = 120;
/** 步长曲线的指数，与 `stepSizes()` 的 `p` 必须一致。 */
export const STEP_CURVE_POWER = 2.2;

/** 一个质量档的采样预算。 */
export interface DomeCloudQuality {
  steps: number;
  lightSteps: number;
  octaves: number;
}

/**
 * 两档的采样预算。
 *
 * **只改采样成本，不改纹理分辨率**——`setQuality` 在机器已经卡的时候被调用，
 * 那里绝不能重烘 128³（约 1 秒）。
 */
export function qualityParams(high: boolean): DomeCloudQuality {
  return high
    ? { steps: 28, lightSteps: 4, octaves: 2 }
    : { steps: 16, lightSteps: 2, octaves: 1 };
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
  const uDetailDrift = uniform(new THREE.Vector2(0, 0));
  const uWeatherDrift = uniform(new THREE.Vector2(0, 0));

  const halfExtent = DOME_SLAB.halfExtent;

  /**
   * 世界坐标 → 体积 UV（盒子本地 0..1）。
   *
   * 盒子中心在相机 x/z、垂直居中于 slab，所以横向 UV 用相对相机的偏移，
   * 纵向 UV 用相对云底的绝对高度。
   */
  const toBoxUV = Fn(([p]: [any]) => {
    const x = p.x.sub(cameraPosition.x).div(halfExtent * 2).add(0.5);
    const y = p.y.sub(DOME_SLAB.base).div(SLAB_HEIGHT);
    const z = p.z.sub(cameraPosition.z).div(halfExtent * 2).add(0.5);
    return vec3(x, y, z);
  });

  /** 某一点的三层密度（0..1）。 */
  const densityAt = Fn(([p]: [any]) => {
    const uvw = toBoxUV(p);

    const shape = texture3D(shapeTex).sample(
      vec3(uvw.x.mul(2.0), uvw.y, uvw.z.mul(2.0)),
    ).r;

    const weather = texture(weatherTex).sample(
      vec2(
        p.x.div(WEATHER_TILE_METRES).add(uWeatherDrift.x),
        p.z.div(WEATHER_TILE_METRES).add(uWeatherDrift.y),
      ),
    ).r;

    const detail = texture3D(detailTex).sample(
      vec3(
        p.x.div(DETAIL_TILE_METRES).add(uDetailDrift.x),
        p.y.div(DETAIL_TILE_METRES),
        p.z.div(DETAIL_TILE_METRES).add(uDetailDrift.y),
      ),
    ).r;

    const coverage = smoothstep(0.28, 0.72, weather);
    const body = clamp(shape.sub(float(1.0).sub(coverage)).div(max(coverage, 0.18)), 0, 1);
    const eroded = body.sub(float(1.0).sub(detail).mul(0.55));
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
      const probe = densityAt(p.add(uSunDir.mul(LIGHT_PROBE_METRES)));
      const trans = exp(probe.mul(-2.4));

      const cosTheta = dot(rayDir, uSunDir);
      const phase = phaseAt(cosTheta);
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
      const sampleA = float(1).sub(exp(den.mul(DENSITY_SCALE).mul(stepWidth).mul(-1)));

      acc.assign(acc.add(sampleColor.mul(sampleA).mul(float(1).sub(accA))));
      accA.assign(accA.add(sampleA.mul(float(1).sub(accA))));

      If(accA.greaterThan(0.985), () => {
        Break();
      });
    });

    return vec4(acc, accA);
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
