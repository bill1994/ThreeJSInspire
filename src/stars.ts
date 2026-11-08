/**
 * src/stars.ts — the night-key star dome (day-night plan Task 6).
 *
 * ~900 points on the upper hemisphere at radius 780 (inside the 800 m dome, above
 * y = 0.03·r so nothing pokes through the horizon haze). Opacity is track-driven:
 * the sky track's `starOpacity` ramps 0 → 1 between the 0° and −8° keys and main
 * pushes it every frame; the layer itself knows nothing about the sun.
 *
 * Deliberate choices pinned by tests:
 * - **`fog: false` in writing** — r186 linear fog is a smoothstep and at 780 m the
 *   fog factor is full: leaving fog on would dye the whole layer the dusk fog
 *   colour. Every other background material in the repo disables fog; the stars
 *   are the one that would have been missed.
 * - **`#b9c6ff`, not the originally drafted `#dfe6ff`** — the draft colour's linear
 *   Rec709 luminance is 0.795, only 3.2% under the 0.82 bloom threshold; under
 *   AdditiveBlending overlapping stars plus the night sky floor would cross it and
 *   bloom the whole night sky. The darker blue keeps luminance ≈ 0.578 with margin;
 *   size goes 1.8 px to pay the perceived brightness back.
 * - **seeded positions** — the frozen-capture protocol must reproduce the exact
 *   same sky twice, so the scatter is mulberry32-seeded, not Math.random.
 *
 * **Towed by far-field**: the aircraft flies an unbounded line and the dome only
 * survives because `far-field.ts` re-centres it every frame — a star layer of the
 * same radius (780 vs 800) that is not towed is left behind within ten seconds.
 * far-field tows EVERY named sky object (list, not first-hit), so both move.
 */
import * as THREE from 'three';

const STAR_COUNT = 900;
const STAR_RADIUS = 780;
const MIN_Y = 0.03;
/** Fixed seed — reproducibility is a capture-protocol contract, not a style choice. */
const STAR_SEED = 20261108;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function initStars(scene: THREE.Scene): { setOpacity(o: number): void; dispose(): void } {
  const rand = mulberry32(STAR_SEED);
  const positions = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i += 1) {
    // Uniform over the upper cap: uniform y in (0.03, 1] is area-preserving on the
    // sphere, azimuth uniform; then scale to the shell radius.
    let y = 0;
    while (y <= MIN_Y) y = rand();
    const azimuth = rand() * Math.PI * 2;
    const s = Math.sqrt(1 - y * y);
    positions[i * 3] = Math.cos(azimuth) * s * STAR_RADIUS;
    positions[i * 3 + 1] = y * STAR_RADIUS;
    positions[i * 3 + 2] = Math.sin(azimuth) * s * STAR_RADIUS;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    size: 1.8,
    sizeAttenuation: false,
    color: '#b9c6ff',
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const points = new THREE.Points(geometry, material);
  points.name = 'sky_stars';
  // Dome is -1000; stars sit right above it and behind everything else (clouds included).
  points.renderOrder = -999;
  points.frustumCulled = false;
  scene.add(points);

  return {
    setOpacity(o: number): void {
      material.opacity = Math.min(Math.max(Number.isFinite(o) ? o : 0, 0), 1);
    },
    dispose(): void {
      scene.remove(points);
      geometry.dispose();
      material.dispose();
    },
  };
}
