import { describe, expect, it } from 'vitest';

import {
  BG_BAKE_SIZE_DEFAULT,
  BG_HAZE_METRES,
  FACES_BAKED,
  MAX_STRIPS_PER_FRAME,
  STEPS,
  STRIPS_PER_FACE,
  TOTAL_STRIPS,
  bakeBudget,
  bakeFaceDirection,
  initBgCumulus,
  type LightState,
  singleCloudLayout,
} from './bg-cumulus';

const st = (azDeg: number, elDeg: number, paletteVersion = 0): LightState => ({ azDeg, elDeg, paletteVersion });

describe('bg-cumulus bakeBudget（限速条带调度，计划 §裁定 6）', () => {
  it('全静止 → 0 条带（停烘）', () => {
    const bb = bakeBudget(st(10, 20, 3), st(10, 20, 3), 0);
    expect(bb.strips).toBe(0);
    expect(bb.staleStrips).toBe(0);
  });

  it('0.033°/帧 慢转 → 1 条带', () => {
    const bb = bakeBudget(st(0, 20, 0), st(0.033, 20, 0), 0);
    expect(bb.strips).toBe(1);
  });

  it('4° 跳变 → 8 条带（硬顶）', () => {
    const bb = bakeBudget(st(0, 20, 0), st(4, 20, 0), 0);
    expect(bb.strips).toBe(8);
  });

  it('90° 跳变也是 8（单帧硬顶不可破）', () => {
    const bb = bakeBudget(st(0, 20, 0), st(90, 20, 0), 0);
    expect(bb.strips).toBe(8);
    expect(bb.strips).toBeLessThanOrEqual(MAX_STRIPS_PER_FRAME);
  });

  it('跳变后靠 stale 追平：40 条带 ≤ 8 帧收敛', () => {
    let prev = st(0, 20, 0);
    const next = st(12, 20, 0);
    let stale = 0;
    let frames = 0;
    let baked = 0;
    for (; frames < 16; frames += 1) {
      const bb = bakeBudget(prev, next, stale);
      baked += bb.strips;
      stale = bb.staleStrips;
      prev = next;
      if (stale === 0) break;
    }
    expect(baked).toBeGreaterThanOrEqual(TOTAL_STRIPS);
    expect(frames).toBeLessThanOrEqual(8);
  });

  it('paletteVersion 变化单独触发 ≥ 1 条带', () => {
    const bb = bakeBudget(st(10, 20, 3), st(10, 20, 4), 0);
    expect(bb.strips).toBeGreaterThanOrEqual(1);
  });

  it('stale 追平期间太阳静止也继续烘到 0', () => {
    const bb1 = bakeBudget(st(0, 20, 0), st(10, 20, 0), 0); // 跳变帧
    expect(bb1.staleStrips).toBe(TOTAL_STRIPS - 8);
    const bb2 = bakeBudget(st(10, 20, 0), st(10, 20, 0), bb1.staleStrips); // 静止但未追平
    expect(bb2.strips).toBe(8);
    const bb3 = bakeBudget(st(10, 20, 0), st(10, 20, 0), 0); // 静止且已追平
    expect(bb3.strips).toBe(0);
  });
});

describe('bg-cumulus 模块钉（计划 Global Constraints + §裁定 4/6）', () => {
  it('常量钉：64 步 / 霾长 12000 / 条带 8×5=40 / 默认烘焙 1024', () => {
    expect(STEPS).toBe(64);
    expect(BG_HAZE_METRES).toBe(12000);
    expect(STRIPS_PER_FACE).toBe(8);
    expect(FACES_BAKED).toBe(5);
    expect(TOTAL_STRIPS).toBe(40);
    expect(MAX_STRIPS_PER_FRAME).toBe(8);
    expect(BG_BAKE_SIZE_DEFAULT).toBe(1024);
  });

  it('module-graph：src 根文件禁止静态 import three/webgpu|three/tsl', async () => {
    const src = await import('./bg-cumulus?raw');
    expect(src.default).not.toMatch(/^\s*import\s+(?!type\b)[^;]*from\s+['"]three\/(webgpu|tsl)['"]/m);
    expect(src.default).toMatch(/await import\(['"]three\/webgpu['"]\)/);
    expect(src.default).toMatch(/await import\(['"]three\/tsl['"]\)/);
  });

  it('参考尺度字面量禁入（520/14500/56000/46000 是参考仓云场的遗产）', async () => {
    const raw = (await import('./bg-cumulus?raw')).default as string;
    // 剥注释后匹配——钉的是代码里的字面量，不是文档提及
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/\b520\b/);
    expect(code).not.toMatch(/\b14500\b/);
    expect(code).not.toMatch(/\b56000\b/);
    expect(code).not.toMatch(/\b46000\b/);
    // slab 起点必须由 layoutWindow 派生
    expect(code).toMatch(/minBase/);
  });

  it('initBgCumulus 存在且为异步工厂（动态导入在函数体内）', () => {
    expect(typeof initBgCumulus).toBe('function');
    expect(initBgCumulus.constructor.name).toBe('AsyncFunction');
  });
});

describe('bg-cumulus 终审修复钉（C1/C4/I1，2026-11-14）', () => {
  it('C1: 烘焙面清单是 [0,1,2,4,5]——面 3 是 −Y 底面（白烧），面 5 是 −Z 正前（必烘）', async () => {
    const { BAKE_FACES } = await import('./bg-cumulus');
    expect(BAKE_FACES).toEqual([0, 1, 2, 4, 5]);
    const src = (await import('./bg-cumulus?raw')).default as string;
    // 条带→面映射必须走清单，禁止 bakeStrip 的首参直除 cursor/8（那会烘到面 3）
    expect(src).not.toMatch(/bakeStrip\(Math\.floor\(cursor/);
    expect(src).toMatch(/BAKE_FACES\[Math\.floor\(cursor \/ STRIPS_PER_FACE\)\]/);
  });

  it('C4: sunDir 进 uLightDir 先于首烘 drawAll；首帧光照登记按 dirty 处理（40 条带追平）', async () => {
    const src = (await import('./bg-cumulus?raw')).default as string;
    const lightCopy = src.indexOf('sunDirLive.copy(opts.sunDir)');
    const lightPush = src.indexOf('uLightDir.value.set');
    const initBake = src.indexOf('bakeAll();');
    expect(lightCopy).toBeGreaterThan(-1);
    expect(lightPush).toBeGreaterThan(lightCopy);
    expect(initBake).toBeGreaterThan(lightPush);
    // 首帧登记不得静默 return——必须标记 stale 让后续帧追平
    expect(src).toMatch(/stale = TOTAL_STRIPS/);
  });

  it('I1: billow 细节两档符号与参考一致（0.55−r，不是 r−0.55）', async () => {
    const src = (await import('./bg-cumulus?raw')).default as string;
    expect(src.match(/float\(0\.55\)\.sub\(/g)?.length).toBe(3); // 基项改写后共 3 处
    expect(src).not.toMatch(/\.r\.sub\(0\.55\)/);
  });
});

// ---- bg-cumulus 计划 Task 2：单云标定台（?bgforce=single 的强制布局）-----------------------

describe('singleCloudLayout（?bgforce=single 的标定夹具）', () => {
  const rig = singleCloudLayout(90, 10, 5000, 2000, 600);

  it('恰好一朵云，puff 数不超编译预算（BG_PUFF_LOOP_MAX=16）', () => {
    expect(rig).toHaveLength(1);
    expect(rig[0].puffs.length).toBeGreaterThan(0);
    expect(rig[0].puffs.length).toBeLessThanOrEqual(16);
  });

  it('确定性：同参数两次构造逐位相等（夹具无随机流）', () => {
    expect(singleCloudLayout(90, 10, 5000, 2000, 600)).toEqual(rig);
  });

  it('方位落在测量系（az = atan2(x, −z)，探针/游戏航向同一约定）：az 90 → +X，az 0 → −Z', () => {
    // 标定基准必须落在测量系里：layoutClouds 的环排布用 (−sin, −cos)（与航向镜像），
    // 夹具若照抄会把 az 90 的云放到探针读数 270°——标定就废了。
    expect(rig[0].bounds.cx).toBeGreaterThan(0);
    expect(Math.abs(rig[0].bounds.cz)).toBeLessThan(1e-6);
    const az0 = singleCloudLayout(0, 10, 5000, 2000, 600)[0];
    expect(Math.abs(az0.bounds.cx)).toBeLessThan(1e-6);
    expect(az0.bounds.cz).toBeLessThan(0);
  });

  it('仰角语义：云体中心高度 = 布局原点 70 m + d·sin(el)，云底 = 中心 − 高/2', () => {
    const expectedY = 70 + 5000 * Math.sin((10 * Math.PI) / 180);
    expect(rig[0].bounds.cy).toBeCloseTo(expectedY, 0);
    expect(rig[0].base).toBeCloseTo(expectedY - 300, 0);
  });

  it('puff 并集跨度贴住请求的宽×高；scale 减半以钳制 billow 侵蚀上限', () => {
    const c = rig[0];
    // 宽度必须贴在**切向**（垂直于视线）：夹具 az 90 时切向 = 世界 Z。
    // Task 3 探针取证：宽度轴沿世界 X（径向）摆会让云被端着看——渲染角宽 ≈ 深度
    // （9.9°）而非布局角宽（23°），角宽比闸 [0.8, 1.2] 永远进不去。
    const az = (90 * Math.PI) / 180;
    const tx = Math.cos(az);
    const tz = Math.sin(az);
    const tang = c.puffs.map(([px, , pz, r]) => px * tx + pz * tz);
    const minT = Math.min(...tang.map((s, i) => s - c.puffs[i][3]));
    const maxT = Math.max(...tang.map((s, i) => s + c.puffs[i][3]));
    const minY = Math.min(...c.puffs.map(([, y, , r]) => y - r));
    const maxY = Math.max(...c.puffs.map(([, y, , r]) => y + r));
    // 横向刻意留在 ~0.83w：渲染时 billow 外推（≤ scale×1.32/侧）补齐余量，
    // 渲染总宽 ≈ w——Task 3 的角宽比闸 [0.8, 1.2] 量的是渲染值。
    const width = maxT - minT;
    expect(width).toBeGreaterThan(2000 * 0.7);
    expect(width).toBeLessThan(2000 * 1.1);
    expect(maxY - minY).toBeCloseTo(600, 0); // 竖向贴住 h（±0.5 m）
    // scale 走 width·0.035（Task 3 取证：billow 侵蚀上限 2.068·scale 必须 < puff
    // 半径 171 m，0.07 的 290 m 侵蚀会让噪声实现逐个抹掉 puff——见夹具 scale 注释）
    expect(c.scale).toBeCloseTo(2000 * 0.035, 6);
    expect(c.distanceMetres).toBeCloseTo(5000 * Math.cos((10 * Math.PI) / 180), 0);
  });
});

// ---- bg-cumulus 计划 Task 3：面→方向与立方图采样约定一致（投影一致性）---------

describe('face → direction 与立方图采样约定一致', () => {
  it('+Z 面中心指向 (0,0,1)，+X 面中心指向 (1,0,0)', () => {
    expect(bakeFaceDirection(4, { x: 0, y: 0 })).toEqual({ x: 0, y: 0, z: 1 });
    expect(bakeFaceDirection(0, { x: 0, y: 0 })).toEqual({ x: 1, y: 0, z: 0 });
  });

  it('侧面竖直轴净符号为正：+Z 面上方样本 y>0', () => {
    // 符号链：GL 规范 +Z 面 tc = −y（tc 正方向朝下）；而 WebGPU 附件行 0 在顶，
    // 渲染时的 uv.y 与采样 t 反号。两次取反相消，净结果就是 rd.y 与 st.y 同号。
    // 这条是 6dc9dab 已取证修复的链路（bg-cumulus.ts「t 轴取反」），
    // 本测试只负责钉住"别再翻回去"。
    expect(bakeFaceDirection(4, { x: 0, y: 0.5 }).y).toBeGreaterThan(0);
  });

  it('六个面中心方向互异且为单位向量', () => {
    const centers = [0, 1, 2, 3, 4, 5].map((f) => bakeFaceDirection(f, { x: 0, y: 0 }));
    for (const d of centers) expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 6);
    const keys = centers.map((d) => `${d.x},${d.y},${d.z}`);
    expect(new Set(keys).size).toBe(6);
  });

  it('烘焙射线对 three.js WebGPU cubeTexture 的采样侧 x 取反做预补偿（CubeTextureNode.setupUV）', async () => {
    // three.webgpu.js CubeTextureNode.setupUV：coordinateSystem === WebGPU 时
    // uvNode.x.negate()（无视 isRenderTargetTexture）。烘焙侧按 GL 约定写内容的
    // 话，az 90 的云会被显示在 az 270（Task 3 探针实测）。烘焙射线必须预补偿：
    // rd.x = −bakeFaceDirection.x。竖直轴符号不动（6dc9dab 取证链路）。
    const src = (await import('./bg-cumulus?raw')).default as string;
    expect(src).toMatch(/MIRROR_X_COMPENSATION/);
    // x 分量链必须取反（补偿）；y/z 链的组成值不得动
    expect(src).toMatch(/comps\[0\]\.negate\(\)/);
  });
});

it('烘焙侧同样在地平线以下 discard，且用链式 .discard()（If 包裹会吞掉整片输出）', async () => {
  const src = (await import('./bg-cumulus?raw')).default as string;
  expect(src).toMatch(/rd\.y\.lessThan\(0\.002\)\.discard\(\)/);
  expect(src).not.toMatch(/If\(\s*rd\.y\.lessThan/);
});
