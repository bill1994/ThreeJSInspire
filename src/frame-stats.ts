/**
 * src/frame-stats.ts — 帧时间环形缓冲（纯函数，node 下可测）。
 *
 * 实时循环传入原始动画帧间隔（毫秒），保留超过模拟时间步上限的尖峰。
 * 冻结模式传入 QA 指定的模拟步长。GPU 耗时由独立探针查询。
 *
 * 百分位用「最近秩（取低）」约定：`p50` 取第 `ceil(0.5·n) − 1` 个样本。对
 * `1..100` 这组能精确给出 50 与 95，不引入插值噪声。
 *
 * 2026-11-09 首版。门 6 见 `docs/superpowers/specs/` 下的体积穹顶设计文档 §7。
 */

/** 一个定长帧时间窗口。 */
export interface FrameStats {
  /** 推进一个样本（毫秒）。非有限或负数被忽略。 */
  push(ms: number): void;
  /** 当前窗口里的样本数。 */
  readonly count: number;
  /** 均值（毫秒）；空窗口返回 0。 */
  readonly mean: number;
  /** 百分位（毫秒），`p` 取 0–100。 */
  percentile(p: number): number;
  countAbove(ms: number): number;
}

export function createFrameStats(capacity: number): FrameStats {
  const size =
    Number.isFinite(capacity) && capacity >= 1 ? Math.max(1, Math.floor(capacity)) : 1;
  const ring = new Float64Array(size);
  let head = 0;
  let length = 0;
  let sum = 0;

  return {
    push(ms: number): void {
      if (!Number.isFinite(ms) || ms < 0) return;
      if (length === size) {
        sum -= ring[head];
      } else {
        length += 1;
      }
      ring[head] = ms;
      sum += ms;
      head = (head + 1) % size;
    },

    get count(): number {
      return length;
    },

    get mean(): number {
      return length === 0 ? 0 : sum / length;
    },

    countAbove(ms: number): number {
      let count = 0;
      for (let i = 0; i < length; i++) if (ring[i] > ms) count++;
      return count;
    },

    percentile(p: number): number {
      if (length === 0) return 0;
      const sorted = Array.from(ring.slice(0, length)).sort((a, b) => a - b);
      const clamped = Number.isFinite(p) ? Math.min(100, Math.max(0, p)) : 0;
      const rank = Math.max(1, Math.ceil((clamped / 100) * length));
      return sorted[Math.min(length, rank) - 1];
    },
  };
}
