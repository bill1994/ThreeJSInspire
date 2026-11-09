/**
 * src/frame-stats.ts — 帧时间环形缓冲（纯函数，node 下可测）。
 *
 * 仓库此前**没有任何 GPU 帧计时基线**（旧云技术说明原话），所以门 6「手机 low 档
 * ≥ 30 fps / 桌面 high 档 < 24 ms」原本无法判定。这个模块提供那个基线：
 * `main.ts` 每帧把 `dt*1000` 推进来，`__porco.qa.frameStats()` 读 p50/p95。
 *
 * 用 `dt` 而不是 `performance.now()`：冻结抓帧（`?qa=frozen`）里墙上时钟停走，
 * 只有累加的 dt 才有意义。
 *
 * 百分位用「最近秩（取低）」约定：`p50` 取第 `ceil(0.5·n) − 1` 个样本。对
 * `1..100` 这组能精确给出 50 与 95，不引入插值噪声。
 *
 * 2026-11-09 首版。门 6 见
 * `docs/superpowers/specs/2026-11-09-dome-cloud-volumetric-design.md` §7。
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

    percentile(p: number): number {
      if (length === 0) return 0;
      const sorted = Array.from(ring.slice(0, length)).sort((a, b) => a - b);
      const clamped = Number.isFinite(p) ? Math.min(100, Math.max(0, p)) : 0;
      const rank = Math.max(1, Math.ceil((clamped / 100) * length));
      return sorted[Math.min(length, rank) - 1];
    },
  };
}
