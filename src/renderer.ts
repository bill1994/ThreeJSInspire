export type Backend = 'webgpu' | 'webgl2';

/**
 * QA escape hatch: `?backend=webgl2` forces the WebGL2 backend, `?backend=webgpu` forbids
 * the automatic fallback so a real WebGPU failure surfaces instead of being papered over.
 * Anything else keeps the probe-then-fallback flow.
 */
function forcedBackend(): Backend | null {
  if (typeof window === 'undefined') return null;
  const q = new URLSearchParams(window.location.search).get('backend');
  return q === 'webgl2' || q === 'webgpu' ? q : null;
}

export interface CreatedRenderer {
  renderer: any;
  backend: Backend;
  /** False only on the classic-WebGLRenderer last resort, which cannot host a TSL pipeline. */
  postSupported: boolean;
}

/**
 * Both backends now come from `WebGPURenderer`: `forceWebGL: true` selects its WebGL2
 * backend, so the sea, the clouds, the sky and the post pipeline keep one TSL code path
 * instead of two parallel shader implementations.
 */
export async function createRenderer(canvas: HTMLCanvasElement): Promise<CreatedRenderer> {
  const forced = forcedBackend();
  const wantGPU = forced !== 'webgl2';
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

  try {
    const mod = await import('three/webgpu');
    const renderer = new (mod as any).WebGPURenderer({
      canvas,
      antialias: true,
      forceWebGL: !wantGPU,
    });
    await renderer.init();
    renderer.setPixelRatio(pixelRatio);

    const isGPUBackend =
      (renderer.backend as { isWebGPUBackend?: boolean } | undefined)?.isWebGPUBackend === true;
    if (forced === 'webgpu' && !isGPUBackend) {
      throw new Error('?backend=webgpu was requested but the renderer fell back to WebGL2');
    }

    return { renderer, backend: isGPUBackend ? 'webgpu' : 'webgl2', postSupported: true };
  } catch (err) {
    // `?backend=webgpu` is a QA switch: a silent fallback would hide the failure it asks to see.
    if (forced === 'webgpu') throw err;
  }

  // Last resort: `three/webgpu` itself failed to load. Classic WebGLRenderer cannot host a
  // TSL pipeline, so post-processing reports off instead of degrading silently.
  const THREE = await import('three');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(pixelRatio);
  return { renderer, backend: 'webgl2', postSupported: false };
}
