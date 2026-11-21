import { Vector4 } from 'three';

export interface Point { x: number; y: number; z: number }
export const PASSES = {
  grass: { x: 44, y: 13, z: -302 },
  canopy: { x: 133, y: 57, z: -256 },
  sand: { x: 202, y: 10, z: -277 },
};

// Keep one live endpoint and eight earlier samples. The latest segment always
// ends at the aircraft, even between commits or at a low rendering cadence.
export class FlightTrail {
  readonly points = Array.from({ length: 9 }, () => new Vector4(0, 0, 0, -100));
  private lastCommit = -Infinity;

  advance(p: Point, time: number) {
    const head = this.points[0];
    const distance = Math.hypot(p.x - head.x, p.z - head.z);
    const gap = time - head.w;
    if (gap > 0.4 || gap < 0 || distance > 100 * gap + 2 || Math.abs(p.y - head.y) > 30) {
      for (const point of this.points) point.set(p.x, p.y, p.z, time);
      this.lastCommit = time;
      return 0;
    }
    if (time - this.lastCommit >= 0.16) {
      for (let i = this.points.length - 1; i > 0; i--) this.points[i].copy(this.points[i - 1]);
      this.lastCommit = time;
    }
    head.set(p.x, p.y, p.z, time);
    return distance;
  }
}

export class DistanceEmitter {
  private remainder = 0;

  step(distance: number, spacing: number, limit: number, emit: (fraction: number) => void) {
    if (distance <= 0) { this.remainder = 0; return; }
    this.remainder %= spacing;
    const first = spacing - this.remainder;
    const due = Math.floor((distance + this.remainder) / spacing);
    for (let i = 0; i < Math.min(due, limit); i++) emit((first + i * spacing) / distance);
    this.remainder = (distance + this.remainder) % spacing;
  }
}
