export type Backend = 'webgpu' | 'webgl2';

export async function createRenderer(canvas: HTMLCanvasElement): Promise<{ renderer: any; backend: Backend }> {
  try {
    const mod = await import('three/webgpu');
    const renderer = new (mod as any).WebGPURenderer({ canvas, antialias: true });
    await renderer.init();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    return { renderer, backend: 'webgpu' };
  } catch {
    const THREE = await import('three');
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    return { renderer, backend: 'webgl2' };
  }
}
