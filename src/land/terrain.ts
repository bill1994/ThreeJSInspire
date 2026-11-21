// The renderer and CPU queries share this triangulation, including its diagonal.
export const GRID = { cells: 64, step: 8, x: -224, z: -656 } as const;
const stride = GRID.cells + 1;
export const smooth = (a: number, b: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function seededRandom(seed: number) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

export function createTerrain(seed: number) {
  const random = seededRandom(seed);
  const phase = random() * Math.PI * 2;
  // Fold the near side into a sheltered bay between two unequal headlands.
  const coast = Array.from({ length: 112 }, (_, i) => {
    const t = 2 * Math.PI * i / 112;
    const r = 1 + 0.065 * Math.sin(3 * t + phase) + 0.035 * Math.cos(5 * t - phase);
    const x = 196 * r * Math.cos(t);
    const z = 150 * r * Math.sin(t) - 84 * Math.exp(-(((x + 12) / 73) ** 2)) * Math.max(0, Math.sin(t)) + x * 0.19;
    return { x: x + 32, z: z - 400 };
  });
  function shoreDistance(x: number, z: number) {
    let nearest = Infinity, inside = false;
    for (let i = 0; i < coast.length; i++) {
      const a = coast[i], b = coast[(i + 1) % coast.length];
      const dx = b.x - a.x, dz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
      nearest = Math.min(nearest, (x - a.x - t * dx) ** 2 + (z - a.z - t * dz) ** 2);
      if ((a.z > z) !== (b.z > z) && x < a.x + (z - a.z) * dx / dz) inside = !inside;
    }
    return Math.sqrt(nearest) * (inside ? 1 : -1);
  }
  const shore = new Float32Array(stride * stride), heights = new Float32Array(shore.length);
  for (let j = 0; j < stride; j++) for (let i = 0; i < stride; i++) {
    const x = GRID.x + i * GRID.step, z = GRID.z + j * GRID.step, k = j * stride + i;
    const d = shore[k] = shoreDistance(x, z);
    const hill = (cx: number, cz: number, w: number, h: number) => Math.exp(-(((x - cx) / w) ** 2 + ((z - cz) / h) ** 2));
    const relief = 48 * hill(-46, -441, 84, 69) + 31 * hill(133, -389, 69, 72) + 9 * hill(-115, -372, 44, 38);
    heights[k] = Math.max(-14, Math.min(d, 36) * 0.19) + smooth(10, 64, d) * relief;
  }
  function interpolate(field: Float32Array, x: number, z: number, outside: number) {
    const u = (x - GRID.x) / GRID.step, v = (z - GRID.z) / GRID.step;
    if (u < 0 || v < 0 || u > GRID.cells || v > GRID.cells) return outside;
    const i = Math.min(GRID.cells - 1, Math.floor(u)), j = Math.min(GRID.cells - 1, Math.floor(v)), k = j * stride + i;
    const a = u - i, b = v - j;
    if (a + b <= 1) return field[k] * (1 - a - b) + field[k + 1] * a + field[k + stride] * b;
    return field[k + stride + 1] * (a + b - 1) + field[k + 1] * (1 - b) + field[k + stride] * (1 - a);
  }
  const heightAt = (x: number, z: number) => interpolate(heights, x, z, -14);
  function sample(x: number, z: number) {
    const gridded = interpolate(shore, x, z, NaN);
    const distance = Number.isFinite(gridded) ? gridded : shoreDistance(x, z);
    const grass = smooth(19 + 6 * Math.sin(x / 53), 36 + 7 * Math.cos(z / 47), distance);
    const wet = (1 - smooth(2, 14, distance)) * (1 - grass);
    const grove = (cx: number, cz: number, r: number) => 1 - smooth(0.3, 1, Math.hypot(x - cx, z - cz) / r);
    const woods = grass * Math.max(grove(-72, -427, 62), grove(132, -386, 63), grove(71, -482, 41));
    const nx = (heightAt(x - 2, z) - heightAt(x + 2, z)) / 4, nz = (heightAt(x, z - 2) - heightAt(x, z + 2)) / 4;
    const len = Math.hypot(nx, 1, nz);
    return {
      height: heightAt(x, z), distance, normal: [nx / len, 1 / len, nz / len],
      wet, sand: 1 - wet - grass, grass: grass - woods, woods
    };
  }
  return { heightAt, sample, shore };
}
