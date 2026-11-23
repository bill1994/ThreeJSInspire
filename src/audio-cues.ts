import type { TrackAudioSource } from './audio';

export type FlightCue = 'ui' | 'hit' | 'sting' | 'whoosh' | 'warning' | 'dive' | 'cloud' | 'splash';

// Crossing a threshold twice while its sound is still attacking is one gesture.
const RETRIGGER_SECONDS: Record<FlightCue, number> = {
  ui: 0.08, hit: 0.12, sting: 0.32, whoosh: 0.48,
  warning: 0.30, dive: 0.65, cloud: 0.65, splash: 0.22,
};

export function createFlightCues(
  ctx: BaseAudioContext,
  noise: AudioBuffer,
  sfx: AudioNode,
  ui: AudioNode,
  track: TrackAudioSource,
) {
  const lastPlayed: Partial<Record<FlightCue, number>> = {};

  // Fresh noise offset on each gesture. The shoulder after the attack keeps
  // the air moving while its colour sweeps, before the tail dies away.
  const gust = (at: number, attack: number, length: number, fromHz: number, toHz: number, peak: number): void => {
    const source = ctx.createBufferSource();
    source.buffer = noise;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 0.78;
    band.frequency.setValueAtTime(fromHz, at);
    band.frequency.exponentialRampToValueAtTime(toHz, at + length);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(peak, at + attack);
    env.gain.exponentialRampToValueAtTime(peak * 0.42, at + attack + (length - attack) * 0.35);
    env.gain.exponentialRampToValueAtTime(0.0001, at + length);
    source.connect(band).connect(env).connect(sfx);
    track(source, band, env);
    source.start(at, Math.random() * (noise.duration - length - 0.02));
    source.stop(at + length + 0.01);
  };

  const knock = (
    bus: AudioNode, at: number, length: number, fromHz: number, toHz: number,
    peak: number, wave: 'sine' | 'triangle' = 'sine',
  ): void => {
    const osc = ctx.createOscillator();
    osc.type = wave;
    osc.frequency.setValueAtTime(fromHz, at);
    osc.frequency.exponentialRampToValueAtTime(toHz, at + length * 0.8);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(peak, at + 0.008);
    env.gain.exponentialRampToValueAtTime(peak * 0.32, at + length * 0.4);
    env.gain.exponentialRampToValueAtTime(0.0001, at + length);
    osc.connect(env).connect(bus);
    track(osc, env);
    osc.start(at);
    osc.stop(at + length + 0.01);
  };

  return (cue: FlightCue, strength: number): boolean => {
    const at = ctx.currentTime + 0.005;
    if (at - (lastPlayed[cue] ?? -Infinity) < RETRIGGER_SECONDS[cue] || strength <= 0) return false;
    lastPlayed[cue] = at;
    const pitch = 2 ** ((Math.random() * 1.5 - 0.75) / 12);
    switch (cue) {
      case 'splash': {
        // Hull contact first, then the brighter fan of spray and its softer return.
        const body = 0.12 + 0.38 * strength;
        knock(sfx, at, 0.14 + 0.10 * strength, (175 + 50 * strength) * pitch, 76 * pitch, body);
        gust(at + 0.014, 0.024, 0.24 + 0.32 * strength, (2100 + 1700 * strength) * pitch, 1070, 0.18 + 0.58 * strength);
        gust(at + 0.090, 0.045, 0.19 + 0.21 * strength, 1450 * pitch, 610, 0.11 + 0.28 * strength);
        break;
      }
      case 'whoosh':
        gust(at, 0.12, 0.44, 1700 * pitch, 470 * pitch, 0.52);
        break;
      case 'dive':
        gust(at, 0.28, 0.78, 440 * pitch, 2150 * pitch, 0.64);
        break;
      case 'cloud':
        gust(at, 0.20, 0.67, 1050 * pitch, 350, 0.44);
        break;
      case 'warning':
        gust(at, 0.017, 0.13, 780 * pitch, 350, 0.4);
        gust(at + 0.115, 0.014, 0.15, 690 * pitch, 285, 0.37);
        knock(sfx, at + 0.115, 0.16, 387 * pitch, 310 * pitch, 0.14, 'triangle');
        break;
      case 'sting':
        knock(sfx, at, 0.26, 345 * pitch, 255 * pitch, 0.31, 'triangle');
        knock(sfx, at + 0.15, 0.34, 265 * pitch, 160 * pitch, 0.36, 'triangle');
        gust(at + 0.03, 0.035, 0.32, 620, 240, 0.38);
        break;
      case 'hit':
        knock(sfx, at, 0.17, 145 * pitch, 66 * pitch, 0.34);
        gust(at, 0.008, 0.12, 1100 * pitch, 450, 0.31);
        break;
      case 'ui':
        knock(ui, at, 0.075, 940 * pitch, 670 * pitch, 0.095);
        break;
    }
    return true;
  };
}
