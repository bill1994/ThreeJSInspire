import { describe, expect, it } from 'vitest';

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
    // 有限半径球壳（§裁定 1：R=4500）
    expect(src).toMatch(/BG_CLOUD_SHELL_R/);
    // 底面保护：dirNode.y < 0 不采云（§裁定 11）
    expect(src).toMatch(/step\(0\.0,\s*dirNode\.y\)/);
  });

  it('sea 调用路径不含云节点（结构性隔离，§裁定 10）', async () => {
    const sea = (await import('./sea/material.ts?raw')).default as string;
    expect(sea).toMatch(/skyColorTsl\(tsl,\s*reflected,\s*sunU,\s*false\)/);
    const sky = (await import('./sky-webgpu?raw')).default as string;
    // 默认参数 null：不传就没有云节点（sea 图与今天逐字节一致的前提）
    expect(sky).toMatch(/cloudTexNode: any = null/);
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
});
