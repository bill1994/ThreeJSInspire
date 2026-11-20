import { describe, expect, it } from 'vitest';
import { antiSolarCool } from './horizon';

it('bounds the GPU anti-solar weight before fractional power at the solar meridian', async () => {
  const src = (await import('./sky-webgpu?raw')).default as string;
  expect(src).toMatch(/const away = clamp\(float\(1\.0\)\.sub\(cosAz\)\.mul\(0\.5\), 0\.0, 1\.0\)/);
  // Real float32 normalization can overshoot, even for a vector dotted with
  // itself. JS double-precision direction sweeps alone did not catch this.
  const f=Math.fround;
  let overshoots=0;
  for(let angle=0;angle<Math.PI*2;angle+=.003){
    const x=f(Math.sin(angle)),z=f(Math.cos(angle));
    const length=f(Math.sqrt(f(f(x*x)+f(z*z))));
    const nx=f(x/length),nz=f(z/length),cos=f(f(nx*nx)+f(nz*nz));
    if(cos>1){
      overshoots++;
      expect(Number.isNaN(Math.pow((1-cos)*.5,1.2))).toBe(true);
      expect(antiSolarCool(cos,0)).toBe(0);
      expect(antiSolarCool(cos,.8)).toBe(0); // NaN * 0 would still be NaN on GPU
    }
  }
  expect(overshoots).toBeGreaterThan(0);
});

/** bg-cumulus Task 4：sky 消费烘焙立方图的源码钉。 */
describe('sky-webgpu 云采样接线（bg-cumulus Task 4）', () => {
  it('skyColorTsl：云合成插在月盘 tint 之后、toonQuantizeTsl 之前（premultiplied）', async () => {
    const src = (await import('./sky-webgpu?raw')).default as string;
    const cloudComposite = src.indexOf('cubeTexture(cloudTex');
    const moonTint = src.indexOf('moonTint.mul(moonGated)');
    const quantize = src.indexOf('toonQuantizeTsl(tsl,');
    expect(cloudComposite).toBeGreaterThan(-1);
    expect(moonTint).toBeGreaterThan(-1);
    expect(quantize).toBeGreaterThan(moonTint);
    expect(cloudComposite).toBeGreaterThan(moonTint);
    expect(cloudComposite).toBeLessThan(quantize);
  });

  it('premultiplied 合成式 + 有限半径重投影 + 底面保护三件套都在', async () => {
    const src = (await import('./sky-webgpu?raw')).default as string;
    // rgb = cloud.rgb × gate + sky.rgb × (1 − a)（§裁定 9 + 终审 C3：gate 同乘源 RGB）
    expect(src).toMatch(/cloudS\.rgb\.mul\(gate\)/);
    // 2026-11-14：球壳重投影的旧写法 (cameraPosition + dir·R).normalize() 把世界原点当
    // 球心，相机离原点 6.9 km 时整张天空被扭掉几十度 → 采样方向退回视线本身，
    // cubeTexture 也必须吃裸 Texture（套 uniform 恒采黑）。
    expect(src).toMatch(/const sampleDir = dirNode;/);
    expect(src).not.toMatch(/cubeTexture\(uniform\(/);
    // 底面保护：dirNode.y < 0 不采云（§裁定 11）
    expect(src).toMatch(/step\(0\.0,\s*dirNode\.y\)/);
  });

  it('sea 调用路径不含云节点（结构性隔离，§裁定 10）', async () => {
    const sea = (await import('./sea/material.ts?raw')).default as string;
    expect(sea).toMatch(/skyColorTsl\(tsl,\s*reflected,\s*sunU,\s*false\)/);
    const sky = (await import('./sky-webgpu?raw')).default as string;
    // 默认参数 null：不传就没有云节点（sea 图与今天逐字节一致的前提）
    expect(sky).toMatch(/cloudTex: any = null/);
  });

  it('句柄：setCloudTexture(null) 关云（黑 cube + cloudOn 0）、setCloudOn 运行时翻转', async () => {
    const src = (await import('./sky-webgpu?raw')).default as string;
    expect(src).toMatch(/setCloudTexture/);
    expect(src).toMatch(/setCloudOn/);
    expect(src).toMatch(/CubeRenderTarget\(1,/); // 1×1 黑立方占位
    expect(src).toMatch(/cloudOn\.value = visible \? 1 : 0/);
  });

  it('C2: setCloudTexture 只换纹理不碰可见性（可见性唯一归口 setCloudOn）', async () => {
    const src = (await import('./sky-webgpu?raw')).default as string;
    const m = src.match(/setCloudTexture\(texture: import\('three'\)\.Texture \| null\): void \{([\s\S]*?)\},/);
    expect(m).toBeTruthy();
    expect(m![1]).not.toMatch(/cloudOn\.value = 1/);
  });

  it('C3: premultiplied 合成的云 RGB 也受 cloudOn 门（a=0 时云色不得漏进天空）', async () => {
    const src = (await import('./sky-webgpu?raw')).default as string;
    expect(src).toMatch(/const gate = cloudOnNode\.mul\(step/);
    expect(src).toMatch(/cloudS\.rgb\.mul\(gate\)/);
    expect(src).toMatch(/const a = cloudS\.a\.mul\(gate\)/);
  });

  it('initSunsetSkyTSL 接受 cloudVisible 初值（?bg= 解析前移的落点）', async () => {
    const src = (await import('./sky-webgpu?raw')).default as string;
    expect(src).toMatch(/cloudVisible\?: boolean/);
  });

  // ---- bg-cumulus 计划 Task 3 Step 3：门护栏（源码断言，跟 sky-moon.test.ts 同风格）----

  it('云合成门同时乘住 alpha 与 premultiplied 的源 RGB（关云后不得残留云色）', async () => {
    const src = (await import('./sky-webgpu?raw')).default as string;
    const gateDecl = src.indexOf('const gate = cloudOnNode.mul(step(0.0, dirNode.y))');
    expect(gateDecl).toBeGreaterThan(-1);
    const body = src.slice(gateDecl, gateDecl + 400);
    expect(body).toContain('cloudS.rgb.mul(gate)');
    expect(body).toContain('skyC.mul(a.oneMinus())');
  });

  it('地平线以下整片不采云（俯冲时不得把镜像倒影画到海面以上）', async () => {
    const src = (await import('./sky-webgpu?raw')).default as string;
    expect(src).toContain('cloudOnNode.mul(step(0.0, dirNode.y))');
  });
});
