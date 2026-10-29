export type Backend = 'webgpu' | 'webgl2';

/**
 * QA escape hatch: `?backend=webgl2` skips the WebGPU probe so the fallback path
 * (gradient sky + Gerstner sea + sprite clouds) can be exercised on a machine that
 * does have navigator.gpu. Anything else keeps the normal probe-then-fallback flow.
 */
function forcedBackend(): Backend | null {
  if (typeof window === 'undefined') return null;
  const q = new URLSearchParams(window.location.search).get('backend');
  return q === 'webgl2' || q === 'webgpu' ? q : null;
}

export async function createRenderer(canvas: HTMLCanvasElement): Promise<{ renderer: any; backend: Backend }> {
  const forced = forcedBackend();
  if (forced !== 'webgl2') {
    try {
      const mod = await import('three/webgpu');
      const renderer = new (mod as any).WebGPURenderer({ canvas, antialias: true });
      await renderer.init();
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      return { renderer, backend: 'webgpu' };
    } catch (err) {
      if (forced === 'webgpu') throw err;
    }
  }
  const THREE = await import('three');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  return { renderer, backend: 'webgl2' };
}
