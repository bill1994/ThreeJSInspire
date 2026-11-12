/**
 * src/subtitles.ts — the story subtitles: one line per gameplay cue, each shown at
 * most once per sortie, with a 0.4 s fade in and a 0.6 s fade out.
 *
 * The cue→line mapping is a pure set (createCues) so it is unit-testable; the DOM
 * part (initSubtitles) only ever writes text and opacity, and reads nothing back.
 */

export type SubCue = 'takeoff' | 'stall' | 'stall_warn' | 'cloud' | 'low' | 'dive' | 'swallow' | 'breathe';

export interface SubLine {
  id: string;
  zh: string;
  en?: string;
  /** Seconds the line stays up, fades included. */
  dur: number;
  cue: SubCue;
}

export const SUB_LINES: readonly SubLine[] = [
  { id: 'takeoff', zh: '黄昏的海面，引擎声刚刚好。', en: 'Evening sea, engine humming just right.', dur: 4, cue: 'takeoff' },
  { id: 'cloud', zh: '钻进云里，世界只剩下白色。', en: 'Inside the clouds — nothing left but white.', dur: 3.5, cue: 'cloud' },
  { id: 'stall', zh: '机头太仰了，放平杆让速度回来。', en: 'Nose too high — ease off and let the speed return.', dur: 4, cue: 'stall' },
  { id: 'stall_warn', zh: '速度在掉——放平杆，让机头下来。', en: 'Speed bleeding — ease the stick forward.', dur: 3, cue: 'stall_warn' },
  { id: 'low', zh: '贴着浪尖飞，小心浮筒。', en: 'Skim the swells — mind the floats.', dur: 3.5, cue: 'low' },
  { id: 'dive', zh: '俯冲，让速度烧起来。', en: 'Dive — let the speed burn.', dur: 3, cue: 'dive' },
  {
    id: 'swallow',
    zh: '螺旋俯冲——像燕子收翅。',
    en: 'SWALLOW SPIRAL DIVE',
    dur: 3.5,
    cue: 'swallow',
  },
  { id: 'breathe', zh: '就这样，呼吸。', en: 'just breathe.', dur: 4, cue: 'breathe' },
];

/** Each cue fires its line once; unknown cues and spent lines return null. */
export function createCues(): { nextLine(cue: string): string | null; reset(): void } {
  const fired = new Set<string>();
  return {
    nextLine(cue: string): string | null {
      const line = SUB_LINES.find((l) => l.cue === cue && !fired.has(l.id));
      if (!line) return null;
      fired.add(line.id);
      return line.id;
    },
    reset(): void {
      fired.clear();
    },
  };
}

/** 0.4 s fade in, hold, 0.6 s fade out; anything non-finite reads as invisible. */
export function fadeAlpha(tSinceShow: number, dur: number): number {
  if (!Number.isFinite(tSinceShow) || !Number.isFinite(dur) || dur <= 0 || tSinceShow < 0) return 0;
  const fadeIn = Math.min(tSinceShow / 0.4, 1);
  const fadeOut = Math.min(Math.max((dur - tSinceShow) / 0.6, 0), 1);
  return Math.min(fadeIn, fadeOut);
}

const STYLE_ID = 'porco-sub-style';
const CSS = `
.porco-sub{position:absolute;left:0;right:0;bottom:78px;margin:0 auto;max-width:86%;text-align:center;
  font-size:14px;line-height:1.5;letter-spacing:.04em;color:#fff7ea;text-shadow:0 1px 3px rgba(30,10,25,.8);
  opacity:0;pointer-events:none;font-family:ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif}
.porco-sub__en{display:block;margin-top:2px;font-size:10px;opacity:.75;letter-spacing:.02em}
`;

export function initSubtitles(el: HTMLElement): { show(id: string): void; update(dt: number): void; dispose(): void } {
  const doc = el.ownerDocument;
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    doc.head.append(style);
  }
  const box = doc.createElement('div');
  box.className = 'porco-sub';
  el.append(box);

  let current: SubLine | null = null;
  let t = 0;

  return {
    show(id: string): void {
      const line = SUB_LINES.find((l) => l.id === id);
      if (!line) return;
      current = line;
      t = 0;
      box.textContent = line.zh;
      if (line.en) {
        const en = doc.createElement('span');
        en.className = 'porco-sub__en';
        en.textContent = line.en;
        box.append(en);
      }
    },
    update(dt: number): void {
      if (!current) return;
      t += Number.isFinite(dt) && dt > 0 ? dt : 0;
      box.style.opacity = String(fadeAlpha(t, current.dur));
      if (t >= current.dur) {
        box.style.opacity = '0';
        current = null;
      }
    },
    dispose(): void {
      box.remove();
      current = null;
      const style = doc.getElementById(STYLE_ID);
      if (style) style.remove();
    },
  };
}
