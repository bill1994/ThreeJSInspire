import { ACESFilmicToneMapping, NeutralToneMapping } from 'three';

/**
 * Tonal range for the whole pipeline.
 *
 * Before this existed the renderer ran `NoToneMapping`, so every value the scene
 * produced above 1.0 was clipped outright. The sunset sky's own haze term adds
 * 0.42 to a horizon red that is already at 1.0, which put the red channel over
 * 1.0 for ~50 degrees around the sun — i.e. the whole portrait frame — and
 * measured 51.6% of the mid band at 250+. Nothing tuned on top of that baseline
 * could be trusted.
 *
 * `neutral` is the safer hue-preserving choice for a flat toon palette; `aces`
 * rolls highlights off more and desaturates warm tones. Flip `mode` to compare.
 */
export const TONE_MAPPING = {
  mode: 'neutral' as 'aces' | 'neutral',
  exposure: 1.0,
} as const;

/**
 * Write the tonal range onto a renderer.
 *
 * Deliberately defensive: a stubbed backend may not expose these fields, and a
 * missing cosmetic setting must never take the boot down. Returns nothing and
 * throws on nothing.
 */
export function applyToneMapping(renderer: unknown): void {
  if (!renderer || typeof renderer !== 'object') return;
  const target = renderer as { toneMapping?: unknown; toneMappingExposure?: unknown };
  target.toneMapping = TONE_MAPPING.mode === 'aces' ? ACESFilmicToneMapping : NeutralToneMapping;
  target.toneMappingExposure = TONE_MAPPING.exposure;
}

/**
 * WebGPU only: the renderer is built on `WebGPURenderer` and refuses to boot on
 * anything else. A device without WebGPU fails loudly here instead of degrading
 * onto a second code path the stylized sea and post pipeline would have to keep
 * alive. Dynamic `import('three/webgpu')` keeps it out of the static module graph.
 */
export async function createRenderer(canvas: HTMLCanvasElement): Promise<{ renderer: any }> {
  const mod = await import('three/webgpu');
  const renderer = new (mod as any).WebGPURenderer({ canvas, antialias: true });
  await renderer.init();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  applyToneMapping(renderer);

  const isGPUBackend =
    (renderer.backend as { isWebGPUBackend?: boolean } | undefined)?.isWebGPUBackend === true;
  if (!isGPUBackend) throw new Error('WebGPU backend unavailable');
  return { renderer };
}
